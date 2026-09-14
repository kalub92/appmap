/**
 * [C1] `expect.value` — recipes asserting on their own parameters (02 §6, issue #23).
 *
 * The failure the feature exists for: a recipe is handed `{amount}`, the `type` step no-ops, the
 * app saves whatever was already in the field, and `verify` — which could only say "an amount is
 * on screen" — reports PASS. These tests drive the real pilot recipe through the real guided
 * protocol and prove both directions: the right value verifies, the wrong value falls back.
 *
 * The load-bearing structural claim is covered too: the comparison happens at INGEST, against the
 * raw tree, and only a boolean is persisted — because the stored snapshot is scrubbed and the
 * element a value assertion targets is `dynamic`, so its label is gone by the time
 * `guided.checkExpect` runs.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { RecipeFile, ReportStepResult, Tree, TreeNode } from '../types.ts';
import { EXPECT_KEYS } from '../types.ts';
import { normalizeTree, walk } from '../tree.ts';
import { declareTask, recordObservation } from '../observe.ts';
import type { BuildInfoProbe } from '../recipes/guided.ts';
import { checkExpect, reportStep, startGuidedRun } from '../recipes/guided.ts';
import { assertionKey, compareValue, observedParams, valueChecksOfRecipe } from '../values.ts';
import { forbiddenContentIssues, validateMap } from '../validate.ts';
import { loadFixtureTree, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SESSION = 'sess_2026-09-13_0023';
const PARAMS = { amount: 50, client: 'Acme Corp' };

let t: TempAppMapDir;
let ctx: AppMapContext;
beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
afterEach(() => { ctx.close(); t.cleanup(); });

const debugProbe: BuildInfoProbe = async (_config, appId) => ({
  schema_version: 1, build_type: 'debug', sandbox: true, app_id: appId, version: '1.4.0',
  build_number: '4412', git_sha: 'deadbee', auth: 'logged_in',
});

function drive(name: string, opts: { mutate?: (tree: Tree) => void; url?: string } = {}): number {
  const tree = normalizeTree(loadFixtureTree(name), { platform: 'ios' });
  opts.mutate?.(tree);
  return recordObservation(ctx, {
    session: SESSION,
    tool: opts.url !== undefined ? 'mcp__argent__open_url' : 'mcp__argent__tap',
    input: opts.url !== undefined ? { url: opts.url } : {},
    snapshot: tree, ok: true,
  }).seq;
}

/** relabel one node of the fixture — "the app displayed something else" */
const relabel = (id: string, label: string) => (tree: Tree): void => {
  walk(tree, (n: TreeNode) => { if (n.a11y_id === id) n.label = label; return undefined; });
};

const HAPPY_PATH: ReadonlyArray<[string, string]> = [
  ['s0', 'invoice_new'],
  ['s1', 'invoice_new.amount_focused'],
  ['s2', 'invoice_new.amount_focused'],
  ['s3', 'client_picker'],
  ['s4', 'invoice_new'],
  ['s5', 'invoice_detail'],
];

/** run the pilot recipe end to end; `mutateLast` doctors the final invoice_detail capture */
async function replay(mutateLast?: (tree: Tree) => void): Promise<ReportStepResult> {
  declareTask(ctx, SESSION, 'create an invoice for Acme Corp');
  drive('invoice_list');
  const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: debugProbe });
  let last!: ReportStepResult;
  for (const [stepId, tree] of HAPPY_PATH) {
    drive(tree, {
      ...(stepId === 's0' ? { url: 'appmap://invoice_new?fixture=logged_in' } : {}),
      ...(stepId === 's5' && mutateLast !== undefined ? { mutate: mutateLast } : {}),
    });
    last = await reportStep(ctx, { run_id: started.run_id, step_id: stepId, ok: true });
  }
  return last;
}

describe('expect.value — the recipe asserts on its own parameter (02 §6, issue #23)', () => {
  it('verifies when the screen shows the value the run asked for', async () => {
    // the pilot's `verify` carries `value: [{element: invoice.detail.amount.text, equals: "{amount}"}]`
    // and the fixture renders `$50.00` for `amount: 50` — money is compared numerically, exactly as
    // `compile.parameterize` decided the literal was a parameter in the first place
    const last = await replay();
    assert.equal(last.status, 'done');
    assert.equal(last.status === 'done' && last.verified, true);
  });

  it('FALLS BACK when the screen shows a different value — the false pass issue #23 is about', async () => {
    // everything else about the run is identical and every other assertion still holds: the screen
    // is invoice_detail and invoice.detail.amount.text IS visible. Only the VALUE is wrong, which
    // before this feature was the one thing a recipe could not notice.
    const last = await replay(relabel('invoice.detail.amount.text', '$7.00'));
    assert.equal(last.status, 'done');
    assert.equal(last.status === 'done' && last.verified, false, 'a recipe whose parameter never reached the app must not report verified');
  });

  it('fails closed when the element carries no value at all (a `type` step that no-opped)', async () => {
    const last = await replay(relabel('invoice.detail.amount.text', ''));
    assert.equal(last.status === 'done' && last.verified, false);
  });

  it('names the element, never the value, when it fails (07 §2.2: no data in logs)', async () => {
    const map = ctx.map;
    const verdict = checkExpect(map, {
      value: [{ element: 'invoice.detail.amount.text', equals: '{amount}' }],
    }, normalizeTree(loadFixtureTree('invoice_detail'), { platform: 'ios' }), 'invoice_detail');
    assert.deepEqual(verdict.failed, ['value:invoice.detail.amount.text']);
    assert.ok(!verdict.failed.join(' ').includes('50'), 'the observed or expected value must never appear in a failure line');
  });
});

describe('the verdict is decided at ingest, and only a boolean is persisted (07 §2.3, issue #23)', () => {
  it('stores one boolean per declared assertion, keyed by the declaration', async () => {
    declareTask(ctx, SESSION, 'create an invoice for Acme Corp');
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: debugProbe });
    assert.ok(started.run_id);
    const seq = drive('invoice_detail');
    const obs = ctx.db.listObservations(SESSION, { fromSeq: seq, toSeq: seq })[0]!;
    const key = assertionKey('invoice.detail.amount.text', 'equals', '{amount}');
    assert.deepEqual(obs.value_checks, { [key]: true });
    // the string itself is nowhere in the stored observation
    assert.ok(!JSON.stringify(obs).includes('$50.00'), 'the observed value must not survive ingest');
  });

  it('the scrubbed snapshot the replayer sees carries no value — which is WHY it is decided at ingest', () => {
    const seq = drive('invoice_detail');
    const obs = ctx.db.listObservations(SESSION, { fromSeq: seq, toSeq: seq })[0]!;
    let labelled = false;
    walk(obs.snapshot!, (n) => {
      if (n.a11y_id === 'invoice.detail.amount.text' && typeof n.label === 'string' && n.label !== '') labelled = true;
      return undefined;
    });
    assert.equal(labelled, false, 'invoice.detail.amount.text is dynamic, so the scrubber drops its label (07 §2.3)');
  });

  it('records nothing when no run is active — exploration pays nothing for the feature', () => {
    const seq = drive('invoice_detail');
    assert.equal(ctx.db.listObservations(SESSION, { fromSeq: seq, toSeq: seq })[0]!.value_checks, undefined);
  });
});

describe('the comparison matches the compiler, so a recipe verifies the run it was compiled from', () => {
  it('money and number compare numerically: `50` matches `$50.00`', () => {
    assert.equal(compareValue('$50.00', '50', 'equals', 'money'), true);
    assert.equal(compareValue('$50.00', '51', 'equals', 'money'), false);
    assert.equal(compareValue('1,250', '1250', 'equals', 'number'), true);
  });
  it('everything else is trimmed and case-insensitive', () => {
    assert.equal(compareValue('  Acme Corp ', 'acme corp', 'equals', 'string'), true);
    assert.equal(compareValue('Acme Corporation', 'Acme', 'contains', 'string'), true);
    assert.equal(compareValue('Acme', 'Acme Corporation', 'contains', 'string'), false);
  });
  it('a money value that is not numeric on either side still compares as text', () => {
    assert.equal(compareValue('free', 'FREE', 'equals', 'money'), true);
  });
  it('`contains` never matches an empty expectation', () => {
    assert.equal(compareValue('anything', '', 'contains', 'string'), false);
  });
});

describe('validate — the assertion language keeps data out of the map (rules 8 and 9, issue #23)', () => {
  const recipeOf = (): RecipeFile => structuredClone(ctx.map.recipes.get('create_invoice')!);

  it('rule 8 rejects a literal in `equals` — stronger than the PII sweep, which "Acme Corp" passes', () => {
    const recipe = recipeOf();
    recipe.verify = { ...recipe.verify, value: [{ element: 'invoice.detail.amount.text', equals: 'Acme Corp' }] };
    const hits = forbiddenContentIssues('ios/recipes/create_invoice.yaml', recipe).filter((i) => i.rule === 8);
    assert.equal(hits.length, 1, JSON.stringify(hits));
    assert.match(hits[0]!.message, /only compare against a \{param\} slot/);
  });

  it('rule 8 accepts a slot', () => {
    const recipe = recipeOf();
    recipe.verify = { ...recipe.verify, value: [{ element: 'invoice.detail.amount.text', equals: '{amount}' }] };
    assert.deepEqual(forbiddenContentIssues('ios/recipes/create_invoice.yaml', recipe).filter((i) => i.rule === 8), []);
  });

  it('the committed pilot passes every rule, rule 9 included', () => {
    const result = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(result.issues.filter((i) => i.severity === 'error'), []);
    assert.deepEqual(result.issues.filter((i) => i.rule === 9), []);
  });
});

describe('observedParams — what counts as testing a parameter (validate rule 9, issue #23)', () => {
  const pilot = (): RecipeFile => structuredClone(ctx.map.recipes.get('create_invoice')!);

  it('the pilot observes both its params: `amount` by value, `client` by the select it matches on', () => {
    assert.deepEqual([...observedParams(pilot())].sort(), ['amount', 'client']);
  });

  it('a `type` step does NOT observe its parameter — typing is not observing, which is the whole issue', () => {
    const recipe = pilot();
    recipe.verify = { screen: 'invoice_detail', visible: ['invoice.detail.amount.text'] };
    assert.equal(observedParams(recipe).has('amount'), false);
    assert.equal(observedParams(recipe).has('client'), true, 'the select still observes `client`');
  });

  it('collects every assertion the recipe declares, steps and verify alike, de-duplicated', () => {
    const recipe = pilot();
    recipe.steps = recipe.steps.map((s) => (s.id === 's5'
      ? { ...s, expect: { screen: 'invoice_detail', value: [{ element: 'invoice.detail.amount.text', equals: '{amount}' }] } }
      : s));
    // the same assertion appears on s5 and on verify: one key, not two
    assert.equal(valueChecksOfRecipe(recipe).length, 1);
  });
});

describe('the expect vocabulary stays in one order everywhere (EXPECT_KEYS is an emit-order contract)', () => {
  it('`value` is last, so the Maestro export emits it after every presence assertion', () => {
    assert.deepEqual([...EXPECT_KEYS], ['screen', 'focused', 'visible', 'not_visible', 'text_present', 'value']);
  });
});
