/**
 * [C1] recipes/compile.ts — the 04 §3 compiler. The headline case is 04 §9's first acceptance
 * criterion: one exploration session of "create an invoice" compiles to the committed
 * `create_invoice.yaml` (modulo the prose the LLM adds, `status`, `version` and `provenance`).
 */
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse } from 'yaml';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { CompileRecipeInput, Expect, Observation, RecipeFile, RecipeParam, RecipeStep, ScreenFile, ScrubbedTree } from '../types.ts';
import { UNKNOWN_SCREEN, now } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { readEvents } from '../events.ts';
import { schemaDir, screenFile, trajectoriesDir, trajectoryFile } from '../paths.ts';
import { buildScrubPolicy, scrub } from '../scrub.ts';
import { observedSignature } from '../signature.ts';
import { normalizeTree } from '../tree.ts';
import { canonicalYaml, isCanonical } from '../yaml/canonical.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { forbiddenContentIssues } from '../validate.ts';
import {
  collapseBacktracking, compileRecipe, focusedElement, inferPostconditions, markIntentCritical,
  optimizeEntry, parameterize, sliceTrajectory, translateSteps,
} from '../recipes/compile.ts';
import type { TranslatedStep } from '../recipes/compile.ts';
import { loadFixtureTree, loadTrajectoryFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SESSION = 'sess_2026-09-10_0007';
const TASK = 'create an invoice for $50 for Acme Corp';
const PARAMS: RecipeParam[] = [
  { name: 'amount', type: 'money', required: true },
  { name: 'client', type: 'string', required: true },
];
const isCode = (code: string) => (e: unknown): boolean => AppMapError.is(e) && e.code === code;

let t: TempAppMapDir;
let ctx: AppMapContext;
beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
});
afterEach(() => { ctx.close(); t.cleanup(); });

/** fixtures/trajectories/create_invoice.session.jsonl, as ingest would have left it */
function trajectory(): Observation[] {
  return loadTrajectoryFixture('create_invoice.session');
}
function insert(observations: readonly Observation[]): void {
  for (const o of observations) ctx.db.insertObservation(o);
}
function compile(over: Partial<CompileRecipeInput> = {}): ReturnType<typeof compileRecipe> {
  return compileRecipe(ctx, { session: SESSION, task: TASK, recipe_id: 'create_invoice', params: PARAMS, ...over });
}
function scrubbed(name: string): ScrubbedTree {
  return scrub(normalizeTree(loadFixtureTree(name), { platform: 'ios' }), buildScrubPolicy(ctx.map.ids, ctx.map.staticLabels));
}
function obs(over: Partial<Observation> & { seq: number; screen_before: string; screen_after: string }): Observation {
  const snapshot = over.snapshot === undefined ? scrubbed('invoice_new') : over.snapshot;
  return {
    ts: now(), session: SESSION, task: TASK, tool: 'mcp__argent__tap', input: {},
    signature_after: snapshot === null ? { marker: 'none', structural_hash: 'none', required_present: 0 } : observedSignature(snapshot),
    gates_present: [], snapshot, ok: true, latency_ms: 0, ...over,
  };
}
/** the committed pilot recipe */
function committed(): RecipeFile {
  return ctx.map.recipes.get('create_invoice')!;
}

// ---------------------------------------------------------------------------------------------
// 04 §9 acceptance criterion
// ---------------------------------------------------------------------------------------------

describe('compileRecipe — 04 §9: the pilot session compiles to create_invoice.yaml', () => {
  it('produces exactly the committed steps, with explicit values', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps, committed().steps);
  });

  it('produces the same steps when the values are inferred from the task text alone (04 §3.4)', () => {
    insert(trajectory());
    const r = compile();
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps, committed().steps);
  });

  it('fills entry, preconditions, params, verify, status, version and provenance', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (!r.ok) return;
    const { recipe } = r;
    assert.equal(recipe.id, 'create_invoice');
    assert.equal(recipe.platform, 'ios');
    assert.equal(recipe.version, 1);
    assert.equal(recipe.status, 'candidate', '04 §3.8: a draft, never verified');
    assert.equal(recipe.entry.deep_link, 'appmap://invoice_new?fixture=logged_in', committed().entry.deep_link);
    assert.deepEqual(recipe.preconditions, [{ auth: 'logged_in' }]);
    assert.deepEqual(recipe.params, PARAMS);
    assert.deepEqual(recipe.verify, { screen: 'invoice_detail' });
    assert.deepEqual(recipe.provenance, { compiled_from: SESSION, compiled_by: 'app-map-mcp@0.1.0' });
    assert.equal(recipe.last_verified_build, undefined);
    // the LLM still owns the prose (04 §3.8). The draft's placeholders come from the recipe ID,
    // never the task text, so the draft itself satisfies 02 §10.8 / validate rule 8.
    assert.equal(recipe.description, 'Create invoice');
    assert.deepEqual(recipe.matches, ['create invoice']);
    assert.equal(recipe.description.includes('$50'), false);
    assert.equal(recipe.matches[0]!.includes('Acme'), false);
    assert.ok(recipe.matches[0]!.length <= 200, '07 §4: ≤200 chars');
    assert.deepEqual(forbiddenContentIssues('draft.yaml', recipe), [], 'the compiler\'s own draft passes rule 8');
    assert.ok(r.warnings.some((w) => w.includes('mark(candidate)')));
  });

  it('a task full of data still yields a data-free draft that validates (02 §10.8, 07 §2)', () => {
    insert(trajectory());
    const long = `create an invoice ${'for $50 for Acme Corp (rush) '.repeat(20)}`;
    const r = compile({ task: long, values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.ok(r.recipe.matches[0]!.length <= 200);
    assert.doesNotThrow(() => new RegExp(r.recipe.matches[0]!, 'i'));
    assert.deepEqual(forbiddenContentIssues('draft.yaml', r.recipe), []);
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'recipe', r.recipe), []);
  });

  it('the draft validates against recipe.schema.json and its YAML is canonical', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'recipe', r.recipe), []);
    assert.equal(isCanonical('recipe', r.yaml), true);
    assert.equal(r.yaml.endsWith('\n'), true);
  });

  it('writes nothing — only `mark(candidate)` does (04 §3.8)', () => {
    insert(trajectory());
    const before = ctx.db.getRecipe('create_invoice');
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    assert.deepEqual(ctx.db.getRecipe('create_invoice'), before);
    assert.deepEqual(ctx.db.listDirty().filter((d) => d.kind === 'recipe'), []);
  });

  it('emits one `compile` event (08 §2)', () => {
    insert(trajectory());
    compile({ values: { amount: 50, client: 'Acme Corp' } });
    const events = readEvents(t.config).events.filter((e) => e.kind === 'compile');
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.kind, 'compile');
    if (e.kind !== 'compile') return;
    assert.deepEqual({ recipe: e.recipe, version: e.version, from_session: e.from_session, steps: e.steps, params: e.params, ok: e.ok }, {
      recipe: 'create_invoice', version: 1, from_session: SESSION, steps: 5, params: ['amount', 'client'], ok: true,
    });
  });

  it('compiles from the trajectory FILE when the cache is empty (`app-map compile` after a restart)', () => {
    mkdirSync(trajectoriesDir(t.config), { recursive: true });
    for (const o of trajectory()) appendFileSync(trajectoryFile(t.config, SESSION), `${JSON.stringify(o)}\n`);
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.recipe.steps, committed().steps);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 2 — collapse backtracking (04 §3.2)
// ---------------------------------------------------------------------------------------------

describe('collapseBacktracking — 04 §3.2', () => {
  it('drops the A → B → A excursion at seq 2–3 and keeps the one that selected a client', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.collapsed_observations, 2);
    assert.ok(r.warnings.some((w) => w.includes('seq 2, 3')));
    // seq 6 → client_picker → seq 7 back to invoice_new is the SAME shape, but a value was
    // selected in B, so it survives as s3/s4
    assert.equal(r.recipe.steps[2]!.action, 'tap');
    assert.equal(r.recipe.steps[3]!.action, 'select');
  });

  it('is pure and reports the removed seqs', () => {
    const out = collapseBacktracking(trajectory(), ctx.config.driver);
    assert.deepEqual(out.removed, [2, 3]);
    assert.deepEqual(out.observations.map((o) => o.seq), [1, 4, 5, 6, 7, 8]);
  });

  it('collapses repeated identical consecutive taps', () => {
    const tap = { tool: 'mcp__argent__tap', input: { id: 'invoice.add.button' }, element: 'invoice.add.button' };
    const out = collapseBacktracking([
      obs({ seq: 1, screen_before: 'invoice_new', screen_after: 'invoice_new', ...tap }),
      obs({ seq: 2, screen_before: 'invoice_new', screen_after: 'invoice_new', ...tap }),
      obs({ seq: 3, screen_before: 'invoice_new', screen_after: 'invoice_new', ...tap }),
    ], ctx.config.driver);
    assert.deepEqual(out.removed, [2, 3]);
    assert.deepEqual(out.observations.map((o) => o.seq), [1]);
  });

  it('leaves a straight-line trajectory alone', () => {
    const straight = trajectory().filter((o) => o.seq !== 2 && o.seq !== 3);
    assert.deepEqual(collapseBacktracking(straight, ctx.config.driver).removed, []);
  });

  it('a repeated tap is collapsed end to end and the steps stay contiguous s1…sN', () => {
    const doubled = trajectory().flatMap((o) => (o.seq === 6 ? [o, { ...o, seq: 6.5 }] : [o]))
      .map((o, i) => ({ ...o, seq: i + 1 }));
    insert(doubled);
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5']);
    assert.deepEqual(r.recipe.steps, committed().steps);
  });

  it('a trajectory that never converges compiles to `loops_never_converge`', () => {
    insert([
      obs({ seq: 1, screen_before: 'invoice_new', screen_after: 'client_picker', input: { id: 'invoice.client.picker' }, element: 'invoice.client.picker' }),
      obs({ seq: 2, screen_before: 'client_picker', screen_after: 'invoice_new', input: { id: 'client.picker.cancel.button' }, element: 'client.picker.cancel.button' }),
      obs({ seq: 3, screen_before: 'invoice_new', screen_after: 'client_picker', input: { id: 'invoice.client.picker' }, element: 'invoice.client.picker' }),
      obs({ seq: 4, screen_before: 'client_picker', screen_after: 'invoice_new', input: { id: 'client.picker.cancel.button' }, element: 'client.picker.cancel.button' }),
    ]);
    const r = compile();
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'loops_never_converge');
  });
});

// ---------------------------------------------------------------------------------------------
// Step 3 — translate (04 §3.3)
// ---------------------------------------------------------------------------------------------

describe('translateSteps — 04 §3.3', () => {
  it('maps open_url, tap, type, dynamic-cell select and swipe', () => {
    const steps = translateSteps(ctx.map, collapseBacktracking(trajectory(), ctx.config.driver).observations, ctx.config.driver).steps;
    assert.deepEqual(steps.map((s) => s.step.action), ['open_link', 'tap', 'type', 'tap', 'select', 'tap']);
    assert.deepEqual(steps.map((s) => s.screen), [UNKNOWN_SCREEN, 'invoice_new', 'invoice_new', 'invoice_new', 'client_picker', 'invoice_new']);
    assert.deepEqual(steps.map((s) => s.from_seq), [1, 4, 5, 6, 7, 8]);
    const select = steps[4]!.step;
    assert.equal(select.action === 'select' && 'list' in select && select.list, 'client.picker.list', 'the enclosing dynamic list, not the cell');
    assert.equal(select.action === 'select' && select.match.text, 'Acme Corp');
  });

  it('`type` lands on the focused element of the previous snapshot', () => {
    const observations = collapseBacktracking(trajectory(), ctx.config.driver).observations;
    assert.equal(focusedElement(ctx.map, observations[1]!), 'invoice.amount.field', 'seq 4 focused the field');
    assert.equal(focusedElement(ctx.map, observations[0]!), undefined, 'seq 1 focused nothing');
    const typeStep = translateSteps(ctx.map, observations, ctx.config.driver).steps[2]!.step;
    assert.equal(typeStep.action === 'type' && typeStep.element, 'invoice.amount.field');
  });

  it('a tap that dismissed a gate becomes dismiss_gate (04 §3.3)', () => {
    const { steps } = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', gates_present: ['gate.push_permission'], input: { id: 'invoice.add.button' }, element: 'invoice.add.button' }),
      obs({ seq: 2, screen_before: 'invoice_list', screen_after: 'invoice_list', gates_present: [], input: { id: 'gate.push_permission.deny' }, element: 'gate.push_permission.deny' }),
    ], ctx.config.driver);
    assert.equal(steps[1]!.step.action, 'dismiss_gate');
    assert.equal(steps[1]!.step.action === 'dismiss_gate' && steps[1]!.step.gate, 'gate.push_permission');
  });

  it('a swipe carries its direction, and perception-only calls are never steps', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__swipe', input: { direction: 'up' } }),
      obs({ seq: 2, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__screenshot', input: {} }),
      obs({ seq: 3, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__describe_ui', input: {} }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps.map((s) => s.step.action), ['swipe']);
    assert.equal(r.steps[0]!.step.action === 'swipe' && r.steps[0]!.step.direction, 'up');
    assert.deepEqual(r.warnings, [], 'a perception call is a KNOWN non-step: expected, so never a warning');
  });

  it('Argent 0.25.0 verbs compile: keyboard → type, open-url → open_link, paste → type, gesture-tap → tap, gesture-swipe → swipe (issue #9)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: UNKNOWN_SCREEN, screen_after: 'invoice_new', tool: 'mcp__argent__open-url', input: { url: 'appmap://invoice_new' } }),
      obs({ seq: 2, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__gesture-tap', input: { id: 'invoice.amount.field' }, element: 'invoice.amount.field' }),
      obs({ seq: 3, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__keyboard', input: { text: '50' } }),
      obs({ seq: 4, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__paste', input: { text: 'Acme Corp' } }),
      obs({ seq: 5, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__gesture-swipe', input: { direction: 'down' } }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps.map((s) => s.step.action), ['open_link', 'tap', 'type', 'type', 'swipe']);
    assert.deepEqual(r.warnings, []);
    const typed = r.steps[2]!.step;
    assert.equal(typed.action === 'type' && typed.element, 'invoice.amount.field', 'the field tapped by `gesture-tap` is the target');
    assert.equal(typed.action === 'type' && typed.text, '50');
  });

  it('an unrecognised driver verb is dropped WITH a warning naming the seq and the tool (issue #9)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__telemetry_flush', input: {} }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /seq 1/);
    assert.match(r.warnings[0]!, /mcp__argent__telemetry_flush/);
  });

  it('`run-sequence` is rejected explicitly: one observation cannot be split into N steps (04 §3.3)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_new', screen_after: 'invoice_detail', tool: 'mcp__argent__run-sequence', input: {} }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /mcp__argent__run-sequence/);
    assert.match(r.warnings[0]!, /re-drive/);
  });

  it('perception, wait and lifecycle calls are not steps and raise no warning (03 §8, 04 §5)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__screenshot', input: {} }),
      obs({ seq: 2, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__native-describe-screen', input: {} }),
      obs({ seq: 3, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__await-screen-idle', input: {} }),
      obs({ seq: 4, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__launch-app', input: {} }),
      obs({ seq: 5, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__report_step', input: {} }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps, []);
    assert.deepEqual(r.warnings, []);
  });

  it('`keyboard --key return` is a key press, not a `type` step (02 §6: recipe.schema.json requires text)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__gesture-tap', input: { id: 'invoice.amount.field' }, element: 'invoice.amount.field' }),
      obs({ seq: 2, screen_before: 'invoice_new', screen_after: 'invoice_new', tool: 'mcp__argent__keyboard', input: { key: 'return' } }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps.map((s) => s.step.action), ['tap']);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /key: return/);
  });

  it('a hardware `button` press is warned about, not silently dropped (02 §6)', () => {
    const r = translateSteps(ctx.map, [
      obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', tool: 'mcp__argent__button', input: { id: 'home' } }),
    ], ctx.config.driver);
    assert.deepEqual(r.steps, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /no recipe step can express/);
  });

  it('a tap whose element could not be resolved is not a step, and says so (issue #9)', () => {
    const r = translateSteps(ctx.map, [obs({ seq: 1, screen_before: 'invoice_list', screen_after: 'invoice_list', input: { x: 10, y: 10 } })], ctx.config.driver);
    assert.deepEqual(r.steps, []);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /seq 1/);
    assert.match(r.warnings[0]!, /no registered element/);
  });
});

// ---------------------------------------------------------------------------------------------
// The issue #9 regression: an Argent 0.25.0 search flow
// ---------------------------------------------------------------------------------------------

describe('compileRecipe — the Argent 0.25.0 search flow (issue #9)', () => {
  /** tap the search field → type into it with `keyboard` → pick the matching row */
  function searchFlow(typeTool = 'mcp__argent__keyboard'): Observation[] {
    const snapshot = scrubbed('client_picker');
    return [
      obs({ seq: 1, snapshot, tool: 'mcp__argent__gesture-tap', input: { id: 'client.picker.search.field' }, element: 'client.picker.search.field', screen_before: 'client_picker', screen_after: 'client_picker' }),
      obs({ seq: 2, snapshot, tool: typeTool, input: { text: 'Acme Corp' }, screen_before: 'client_picker', screen_after: 'client_picker' }),
      obs({ seq: 3, snapshot, tool: 'mcp__argent__gesture-tap', input: { text: 'Acme Corp' }, element: 'client.picker.cell', screen_before: 'client_picker', screen_after: 'invoice_new' }),
    ];
  }
  const CLIENT: RecipeParam[] = [{ name: 'client', type: 'string', required: true }];
  function compileSearch(): ReturnType<typeof compileRecipe> {
    return compileRecipe(ctx, { session: SESSION, task: 'find the client Acme Corp', recipe_id: 'search_client', params: CLIENT, values: { client: 'Acme Corp' } });
  }

  it('keeps the `type` step when the driver typed with `mcp__argent__keyboard` — the false-PASS repro', () => {
    insert(searchFlow());
    const r = compileSearch();
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    // before the fix `keyboard` matched no verb regex, so this was ['tap', 'select']: the recipe
    // passed while searching for one client and opening whichever row happened to be first
    assert.deepEqual(r.recipe.steps.map((s) => s.action), ['tap', 'type', 'select']);
    assert.deepEqual(r.recipe.steps, [
      { id: 's1', action: 'tap', element: 'client.picker.search.field' },
      { id: 's2', action: 'type', element: 'client.picker.search.field', text: '{client}' },
      { id: 's3', action: 'select', list: 'client.picker.list', match: { text: '{client}' }, expect: { screen: 'invoice_new' } },
    ]);
    assert.equal(r.warnings.some((w) => w.includes('keyboard')), false, 'a translated call is never reported as dropped');
  });

  it('an unknown verb in the same flow still compiles, but the dropped call is in `warnings` (issue #9)', () => {
    insert(searchFlow('mcp__argent__whatever'));
    const r = compileSearch();
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps.map((s) => s.action), ['tap', 'select'], 'the call is still not compilable');
    assert.ok(r.warnings.some((w) => w.includes('mcp__argent__whatever') && w.includes('seq 2')), r.warnings.join(' | '));
  });
});

// ---------------------------------------------------------------------------------------------
// `select {cell, match}`: a list whose container is not an accessibility element (issue #19)
// ---------------------------------------------------------------------------------------------

describe('translateSteps / compileRecipe — select by cell (04 §3.3, issue #19)', () => {
  /**
   * client_picker as SwiftUI actually reports it: the rows are there, the `List` container is
   * not an accessibility element and so was never captured (01 R4), and no list id is declared.
   */
  function withoutTheListContainer(): void {
    const path = screenFile(t.config, 'client_picker');
    const doc = parse(readFileSync(path, 'utf8')) as ScreenFile;
    doc.elements = doc.elements.filter((e) => e.id !== 'client.picker.list');
    doc.dynamic_regions = (doc.dynamic_regions ?? []).filter((id) => id !== 'client.picker.list');
    doc.signature.required_ids = (doc.signature.required_ids ?? []).filter((id) => id !== 'client.picker.list');
    writeFileSync(path, canonicalYaml('screen', doc));
    ctx.reload();
  }
  /** tap the search field → type into it → tap the row that says "Acme Corp" */
  function searchFlow(over: Partial<Observation> = {}): Observation[] {
    const snapshot = scrubbed('client_picker');
    return [
      obs({ seq: 1, snapshot, tool: 'mcp__argent__gesture-tap', input: { id: 'client.picker.search.field' }, element: 'client.picker.search.field', screen_before: 'client_picker', screen_after: 'client_picker' }),
      obs({ seq: 2, snapshot, tool: 'mcp__argent__keyboard', input: { text: 'Acme Corp' }, screen_before: 'client_picker', screen_after: 'client_picker' }),
      obs({ seq: 3, snapshot, tool: 'mcp__argent__gesture-tap', input: { text: 'Acme Corp' }, element: 'client.picker.cell', screen_before: 'client_picker', screen_after: 'invoice_new', ...over }),
    ];
  }
  const CLIENT: RecipeParam[] = [{ name: 'client', type: 'string', required: true }];
  function compileSearch(over: Partial<CompileRecipeInput> = {}): ReturnType<typeof compileRecipe> {
    return compileRecipe(ctx, { session: SESSION, task: 'find the client Acme Corp', recipe_id: 'search_client', params: CLIENT, ...over });
  }

  it('a tap on a dynamic cell with no enclosing dynamic list compiles to `select {cell, match}`', () => {
    withoutTheListContainer();
    const steps = translateSteps(ctx.map, searchFlow(), ctx.config.driver).steps;
    // before the fix this degraded to `tap client.picker.cell`: the row that says X was
    // inexpressible, so the recipe opened whichever row happened to be first
    assert.deepEqual(steps.map((x) => x.step.action), ['tap', 'type', 'select']);
    assert.deepEqual(steps[2]!.step, { id: 's3', action: 'select', cell: 'client.picker.cell', match: { text: 'Acme Corp' } });
  });

  it('the enclosing dynamic list still wins when the screen declares one — the cell form is additive', () => {
    const steps = translateSteps(ctx.map, searchFlow(), ctx.config.driver).steps;
    assert.deepEqual(steps[2]!.step, { id: 's3', action: 'select', list: 'client.picker.list', match: { text: 'Acme Corp' } });
  });

  it('a dynamic-cell tap that carried no text or index stays a `tap` (02 §6: match.text is required)', () => {
    withoutTheListContainer();
    const steps = translateSteps(ctx.map, searchFlow({ input: {} }), ctx.config.driver).steps;
    assert.deepEqual(steps[2]!.step, { id: 's3', action: 'tap', element: 'client.picker.cell' });
  });

  it('the cell form is parameterized, validates against recipe.schema.json and serializes canonically (04 §3.4)', () => {
    withoutTheListContainer();
    insert(searchFlow());
    const r = compileSearch({ values: { client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps, [
      { id: 's1', action: 'tap', element: 'client.picker.search.field' },
      { id: 's2', action: 'type', element: 'client.picker.search.field', text: '{client}' },
      { id: 's3', action: 'select', cell: 'client.picker.cell', match: { text: '{client}' }, expect: { screen: 'invoice_new' } },
    ]);
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'recipe', r.recipe), []);
    assert.equal(isCanonical('recipe', r.yaml), true);
  });

  it('the cell form carries the selected value, so an undeclared one is `unparameterized_value` (04 §3.4)', () => {
    withoutTheListContainer();
    // only the row tap, so the select's match text is the one literal in the trajectory
    insert([searchFlow()[2]!]);
    const r = compileSearch({ task: 'open a client', params: [] });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'unparameterized_value');
    assert.deepEqual(r.offending_values, ['Acme Corp']);
  });

  it('a step carrying both `list` and `cell` matches no branch of the schema oneOf (02 §6)', () => {
    const bad = { ...ctx.map.recipes.get('create_invoice')!, steps: [{ id: 's1', action: 'select', list: 'client.picker.list', cell: 'client.picker.cell', match: { text: 'Acme Corp' } }] };
    assert.notDeepEqual(validateAgainstSchema(schemaDir(t.config), 'recipe', bad), [], 'the two forms are disjoint');
  });
});

// ---------------------------------------------------------------------------------------------
// Step 4 — parameterize (04 §3.4)
// ---------------------------------------------------------------------------------------------

describe('parameterize — 04 §3.4', () => {
  const step = (action: 'type' | 'select', value: string): TranslatedStep => ({
    step: action === 'type'
      ? { id: 's1', action: 'type', element: 'invoice.amount.field', text: value }
      : { id: 's1', action: 'select', list: 'client.picker.list', match: { text: value } },
    screen: 'invoice_new',
    from_seq: 1,
  });
  const textOf = (s: TranslatedStep): string => (s.step.action === 'type' ? s.step.text : s.step.action === 'select' ? s.step.match.text : '');

  it('money compares numerically and strings case-insensitively after trimming', () => {
    const a = parameterize([step('type', '$50.00')], PARAMS, { amount: 50 }, new Set());
    assert.equal(textOf(a.steps[0]!), '{amount}');
    const b = parameterize([step('select', '  acme corp ')], PARAMS, { client: 'Acme Corp' }, new Set());
    assert.equal(textOf(b.steps[0]!), '{client}');
    assert.deepEqual([...a.offending, ...b.offending], []);
  });

  it('static copy stays literal', () => {
    const r = parameterize([step('select', 'All clients')], PARAMS, {}, new Set(['All clients']));
    assert.equal(textOf(r.steps[0]!), 'All clients');
    assert.deepEqual(r.offending, []);
  });

  it('an already-substituted slot is left alone', () => {
    const r = parameterize([step('type', '{amount}')], PARAMS, {}, new Set());
    assert.equal(textOf(r.steps[0]!), '{amount}');
    assert.deepEqual(r.offending, []);
  });

  it('anything else is reported once, in order', () => {
    const r = parameterize([step('type', 'Foo'), step('select', 'Bar'), step('type', 'Foo')], PARAMS, {}, new Set());
    assert.deepEqual(r.offending, ['Foo', 'Bar']);
  });

  it('partial `values` are completed from the task text', () => {
    insert(trajectory());
    // only `client` is given explicitly; `amount` comes from "$50" in the task (04 §3.4)
    const r = compile({ values: { client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (r.ok) assert.deepEqual(r.recipe.steps, committed().steps);
  });

  it('an unparameterized literal fails the compile with offending_values (07 §2.3.5)', () => {
    insert(trajectory());
    // only `amount` is declared, so the typed client name matches nothing and is not static copy
    const r = compile({ params: [PARAMS[0]!], values: { amount: 50 } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'unparameterized_value');
    assert.deepEqual(r.offending_values, ['Acme Corp']);
    assert.ok(r.message.includes('Acme Corp'));
    const e = readEvents(t.config).events.filter((x) => x.kind === 'compile').at(-1)!;
    assert.equal(e.kind === 'compile' && e.ok, false);
    assert.equal(e.kind === 'compile' && e.reason, 'unparameterized_value');
  });

  it('explicit values win over the ones inferred from the task text', () => {
    insert(trajectory());
    // the task says "Acme Corp" but the session actually typed it — declaring a different value
    // for `client` leaves the typed literal unmatched
    const r = compile({ values: { amount: 50, client: 'Globex' } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.offending_values, ['Acme Corp']);
  });
});

// ---------------------------------------------------------------------------------------------
// Step 5 — entry optimization (04 §3.5)
// ---------------------------------------------------------------------------------------------

describe('optimizeEntry — 04 §3.5', () => {
  /** the pilot session reached through invoice_list instead of straight into invoice_new */
  function viaInvoiceList(): Observation[] {
    const rest = trajectory().filter((o) => o.seq >= 4).map((o, i) => ({ ...o, seq: i + 3 }));
    return [
      obs({ seq: 1, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_list?fixture=logged_in' }, screen_before: UNKNOWN_SCREEN, screen_after: 'invoice_list', snapshot: scrubbed('invoice_list') }),
      obs({ seq: 2, input: { id: 'invoice.add.button' }, element: 'invoice.add.button', screen_before: 'invoice_list', screen_after: 'invoice_new' }),
      ...rest,
    ];
  }

  it('replaces the leading navigation with the deep link and keeps it as fallback_path', () => {
    insert(viaInvoiceList());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.entry, { deep_link: 'appmap://invoice_new?fixture=logged_in', fallback_path: ['invoice_list', 'invoice_new'] });
    assert.deepEqual(r.recipe.entry, committed().entry);
    assert.deepEqual(r.recipe.steps, committed().steps, 'the navigation steps are gone; s1 is the first real step');
  });

  it('keeps the navigation steps when the entry screen has no deep link (01 R5)', () => {
    const steps: TranslatedStep[] = [
      { step: { id: 's1', action: 'open_link', url: 'appmap://invoice_new' }, screen: UNKNOWN_SCREEN, from_seq: 1 },
      { step: { id: 's2', action: 'tap', element: 'invoice.client.picker' }, screen: 'invoice_new', from_seq: 2 },
      { step: { id: 's3', action: 'tap', element: 'client.picker.search.field' }, screen: 'client_picker', from_seq: 3 },
      { step: { id: 's4', action: 'tap', element: 'client.picker.cancel.button' }, screen: 'client_picker', from_seq: 4 },
    ];
    const r = optimizeEntry(ctx.map, steps, true);
    assert.deepEqual(r.entry, { fallback_path: ['invoice_new', 'client_picker'] }, 'client_picker has deep_link: none (decision 9)');
    assert.equal(r.steps.length, 4, 'nothing is dropped without a deep link to replace it');
    assert.deepEqual(r.steps.map((x) => x.step.id), ['s1', 's2', 's3', 's4']);
  });

  it('`?fixture=logged_in` is appended only for a logged_in recipe, and never twice', () => {
    const steps: TranslatedStep[] = [
      { step: { id: 's1', action: 'tap', element: 'invoice.amount.field' }, screen: 'invoice_new', from_seq: 1 },
      { step: { id: 's2', action: 'type', element: 'invoice.amount.field', text: '{amount}' }, screen: 'invoice_new', from_seq: 2 },
    ];
    assert.equal(optimizeEntry(ctx.map, steps, false).entry.deep_link, 'appmap://invoice_new');
    assert.equal(optimizeEntry(ctx.map, steps, true).entry.deep_link, 'appmap://invoice_new?fixture=logged_in');
    // invoice_detail's screen file already picks its own fixture (01 R5 / decision 34): that one
    // wins, and `?fixture=logged_in` is never appended a second time
    const onDetail = steps.map((s) => ({ ...s, screen: 'invoice_detail' }));
    assert.equal(optimizeEntry(ctx.map, onDetail, true).entry.deep_link, 'appmap://invoice_detail?fixture=one_draft_invoice');
  });

  it('an empty step list yields an empty entry', () => {
    assert.deepEqual(optimizeEntry(ctx.map, [], true), { entry: {}, steps: [] });
  });
});

// ---------------------------------------------------------------------------------------------
// Steps 1, 6, 7 — slice, postconditions, intent_critical
// ---------------------------------------------------------------------------------------------

describe('sliceTrajectory — 04 §3.1', () => {
  it('`to_seq` wins over `verify` and is inclusive', () => {
    const all = trajectory();
    const verify: Expect = { screen: 'invoice_detail' };
    assert.deepEqual(sliceTrajectory(all, { fromSeq: 1, toSeq: 5, verify }).map((o) => o.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(sliceTrajectory(all, { fromSeq: 4 }).map((o) => o.seq), [4, 5, 6, 7, 8]);
  });

  it('without `to_seq` the slice ends at the first `verify`-satisfying observation', () => {
    const all = trajectory();
    assert.deepEqual(sliceTrajectory(all, { fromSeq: 1, verify: { screen: 'client_picker' } }).map((o) => o.seq), [1, 2]);
    assert.deepEqual(sliceTrajectory(all, { fromSeq: 1, verify: { screen: 'invoice_detail', visible: ['invoice.detail.amount.text'] } }).map((o) => o.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(sliceTrajectory(all, { fromSeq: 1, verify: { screen: 'never_reached' } }).map((o) => o.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('`to_seq: 5` compiles the pilot session down to s1–s2', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' }, to_seq: 5 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual(r.recipe.steps, committed().steps.slice(0, 2));
  });

  it('`from_seq` starts the slice later (a guided_fallback revision)', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' }, from_seq: 6 });
    assert.ok(r.ok, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    // the tap that opens the picker cannot be replaced by a deep link (client_picker has none),
    // so it stays and the entry is a pure fallback_path
    assert.deepEqual(r.recipe.steps.map((s) => s.action), ['tap', 'select', 'tap']);
    assert.deepEqual(r.recipe.entry, { fallback_path: ['invoice_new', 'client_picker'] });
  });

  it('the session\'s `task_end_seq` is the default slice end (04 §3.1, decision 31)', () => {
    insert(trajectory());
    ctx.db.upsertSession({ session: SESSION, task: TASK, task_seq: 1, task_end_seq: 5 });
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.recipe.steps, committed().steps.slice(0, 2));
  });
});

describe('inferPostconditions and markIntentCritical — 04 §3.6, 04 §3.7', () => {
  it('screen change → expect.screen; new focus → expect.focused; neither → no expect (02 §6)', () => {
    const observations = collapseBacktracking(trajectory(), ctx.config.driver).observations;
    const steps = translateSteps(ctx.map, observations, ctx.config.driver).steps.slice(1);
    const { steps: withExpect, missing } = inferPostconditions(ctx.map, steps, observations);
    assert.deepEqual(missing, []);
    assert.deepEqual(withExpect.map((s) => s.expect), [
      { focused: 'invoice.amount.field' },
      undefined,
      { screen: 'client_picker' },
      { screen: 'invoice_new' },
      { screen: 'invoice_detail' },
    ]);
  });

  it('marks only steps touching an intent_critical element (02 §10.6: absent means false)', () => {
    const marked = markIntentCritical(ctx.map, [
      { id: 's1', action: 'tap', element: 'invoice.save.button' },
      { id: 's2', action: 'tap', element: 'invoice.cancel.button' },
      { id: 's3', action: 'open_link', url: 'appmap://invoice_new' },
    ] as RecipeStep[]);
    assert.deepEqual(marked.map((s) => s.intent_critical), [true, undefined, undefined]);
  });

  it('a step whose screen afterwards is unknown cannot be expressed → missing_postcondition', () => {
    insert([
      obs({ seq: 1, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_new' }, screen_before: UNKNOWN_SCREEN, screen_after: 'invoice_new' }),
      obs({ seq: 2, input: { id: 'invoice.amount.field' }, element: 'invoice.amount.field', screen_before: 'invoice_new', screen_after: 'invoice_new' }),
      obs({ seq: 3, input: { id: 'invoice.save.button' }, element: 'invoice.save.button', screen_before: 'invoice_new', screen_after: UNKNOWN_SCREEN, snapshot: null }),
    ]);
    const r = compile();
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'missing_postcondition');
      assert.ok(r.message.includes('s2'));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Failure modes and revisions
// ---------------------------------------------------------------------------------------------

describe('compileRecipe — failure modes (04 §3)', () => {
  it('a session with no observations is `no_observations`', () => {
    const r = compile();
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_observations');
  });

  it('observations recorded before any task was declared are not compilable (04 §2)', () => {
    insert(trajectory().map((o) => {
      const copy = { ...o };
      delete copy.task;
      return copy;
    }));
    const r = compile();
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no_task');
  });

  it('an unidentifiable final screen is `unknown_screen`', () => {
    insert([
      obs({ seq: 1, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_new' }, screen_before: UNKNOWN_SCREEN, screen_after: 'invoice_new' }),
      obs({ seq: 2, input: { id: 'invoice.amount.field' }, element: 'invoice.amount.field', screen_before: 'invoice_new', screen_after: 'invoice_new' }),
      obs({ seq: 3, tool: 'mcp__argent__screenshot', input: {}, screen_before: 'invoice_new', screen_after: UNKNOWN_SCREEN, snapshot: null }),
    ]);
    const r = compile();
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'unknown_screen');
  });

  it('failed driver calls are dropped from the slice and reported as a warning', () => {
    const withFailure = trajectory();
    insert([...withFailure, obs({ seq: 9, screen_before: 'invoice_detail', screen_after: UNKNOWN_SCREEN, ok: false, snapshot: null, input: { id: 'invoice.detail.send.button' } })]);
    const r = compile({ values: { amount: 50, client: 'Acme Corp' } });
    assert.equal(r.ok, true, r.ok ? '' : `${r.reason}: ${r.message}`);
    if (!r.ok) return;
    assert.ok(r.warnings.some((w) => w.includes('failed driver call')));
    assert.deepEqual(r.recipe.steps, committed().steps);
  });

  it('malformed input is bad_input, never a crash (03 §11)', () => {
    assert.throws(() => compileRecipe(ctx, { session: '', task: TASK, recipe_id: 'x', params: [] }), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => compileRecipe(ctx, { session: SESSION, task: '', recipe_id: 'x', params: [] }), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => compileRecipe(ctx, { session: SESSION, task: TASK, recipe_id: '', params: [] }), isCode(ERROR_CODES.BAD_INPUT));
  });
});

describe('compileRecipe — revisions (04 §8)', () => {
  it('`revision_of` bumps the version, records it and reuses the reviewed verify/matches', () => {
    insert(trajectory());
    const r = compile({ values: { amount: 50, client: 'Acme Corp' }, revision_of: 3 });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.recipe.version, 4);
    assert.equal(r.recipe.provenance.revision_of, 3);
    assert.deepEqual(r.recipe.verify, committed().verify, 'the reviewed verify survives a recompile');
    assert.deepEqual(r.recipe.matches, committed().matches);
    assert.equal(r.recipe.description, committed().description);
    assert.equal(r.recipe.status, 'candidate', 'a revision goes back through review');
  });
});
