/**
 * [C1] recipes/lifecycle.ts — 04 §8 status lifecycle with the 08 §5 thresholds as code.
 * Every threshold is exercised at its boundary (the number below it and the number at it).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { RecipeStats } from '../store/db.ts';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { ElementDef, RecipeFile, RecipeStatus, RunRecord, ScreenFile, ScreenStatus } from '../types.ts';
import { now } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { loadConfig } from '../config.ts';
import { readEvents } from '../events.ts';
import { schemaDir, serverLog } from '../paths.ts';
import { validateAgainstSchema, validateEventLine } from '../yaml/schemas.ts';
import {
  THRESHOLDS, conditionKey, decideTransition, deepLinkCovers, eligibleForCiGate, markRecipe,
  markScreen, markVerified, recompileCovers, recompileCoversEntry, recordRunOutcome,
  retireRecipesForScreen, screensReferenced, shouldRecompile, stepIdentity,
} from '../recipes/lifecycle.ts';
import { isCollapseWarning, isFocusFallbackWarning } from '../recipes/compile.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { loadTrajectoryFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

// ---------------------------------------------------------------------------------------------
// Pure half: thresholds and transitions
// ---------------------------------------------------------------------------------------------

function stats(over: Partial<RecipeStats> = {}): RecipeStats {
  return {
    recipe: 'create_invoice', runs: 0, successes: 0, fallbacks: 0, success_sessions: 0,
    builds: [], last_runs: [], heals_pending: 0, fallback_rate_current_build: 0, ...over,
  };
}
function recipe(status: RecipeStatus, over: Partial<RecipeFile> = {}): RecipeFile {
  return {
    id: 'create_invoice', version: 1, platform: 'ios', description: 'd', matches: ['x'], params: [],
    entry: { deep_link: 'appmap://invoice_new' }, steps: [], verify: { screen: 'invoice_detail' },
    status, provenance: { compiled_from: 's', compiled_by: 'app-map-mcp@0.1.0' }, ...over,
  };
}
/** `n` outcomes, `failures` of which are false (newest first, as `RecipeStats.last_runs` is) */
const runsWith = (n: number, failures: number): boolean[] => Array.from({ length: n }, (_, i) => i >= failures);

describe('THRESHOLDS are the 08 §5 numbers', () => {
  it('matches the spec table exactly', () => {
    assert.deepEqual({ ...THRESHOLDS }, {
      verified_min_successes: 3,
      verified_min_sessions: 2,
      ci_gate_min_success_rate: 0.95,
      ci_gate_min_builds: 3,
      recompile_fallback_rate: 0.2,
      recompile_failure_rate: 0.5,
      recompile_window_runs: 10,
      recompile_min_runs: 3,
      recompile_pending_heals: 2,
      alert_fallback_rate: 0.2,
      alert_pending_heals: 5,
      alert_unknown_rate: 0.1,
      alert_unknown_window_days: 7,
      target_brittleness_index: 0.15,
    });
  });
});

describe('decideTransition — candidate → verified (04 §8 row 2)', () => {
  it('3 successes across 2 sessions with no pending heals promotes', () => {
    const d = decideTransition(recipe('candidate'), stats({ runs: 3, successes: 3, success_sessions: 2 }));
    assert.deepEqual(d, { recipe: 'create_invoice', from: 'candidate', to: 'verified', reason: 'verified' });
  });

  it('2 successes is not enough, 3 is (boundary)', () => {
    assert.equal(decideTransition(recipe('candidate'), stats({ runs: 2, successes: 2, success_sessions: 2 })), null);
    assert.equal(decideTransition(recipe('candidate'), stats({ runs: 3, successes: 3, success_sessions: 2 }))?.to, 'verified');
  });

  it('1 session is not enough, 2 is (boundary)', () => {
    assert.equal(decideTransition(recipe('candidate'), stats({ runs: 3, successes: 3, success_sessions: 1 })), null);
    assert.equal(decideTransition(recipe('candidate'), stats({ runs: 3, successes: 3, success_sessions: 2 }))?.to, 'verified');
  });

  it('one unresolved heal blocks the promotion ("no unresolved heals")', () => {
    assert.equal(decideTransition(recipe('candidate'), stats({ runs: 3, successes: 3, success_sessions: 2, heals_pending: 1 })), null);
  });

  it('only a candidate is promoted — a verified recipe stays put and ci_gate is never automatic', () => {
    const good = stats({ runs: 10, successes: 10, success_sessions: 5, last_runs: runsWith(10, 0), builds: [{ build: '1', runs: 4, successes: 4 }, { build: '2', runs: 3, successes: 3 }, { build: '3', runs: 3, successes: 3 }] });
    assert.equal(decideTransition(recipe('verified'), good), null);
    assert.equal(decideTransition(recipe('ci_gate'), good), null);
    assert.equal(eligibleForCiGate(good), true, 'eligibility is reported, promotion is not automatic (07 §7)');
  });

  it('a retired recipe is never revived automatically (02 §8)', () => {
    assert.equal(decideTransition(recipe('retired'), stats({ runs: 9, successes: 9, success_sessions: 3 })), null);
    assert.equal(decideTransition(recipe('retired'), stats({ last_runs: runsWith(10, 9) })), null);
  });
});

describe('decideTransition / shouldRecompile — any → candidate (04 §8 row 4, 08 §5 rows 2-3)', () => {
  it('6 of the last 10 runs failed → recompile; 5 of 10 does not (boundary, 04 §9)', () => {
    const six = stats({ runs: 10, last_runs: runsWith(10, 6) });
    const five = stats({ runs: 10, last_runs: runsWith(10, 5) });
    assert.equal(shouldRecompile(six), true);
    assert.equal(shouldRecompile(five), false);
    assert.deepEqual(decideTransition(recipe('verified'), six), { recipe: 'create_invoice', from: 'verified', to: 'candidate', reason: 'recompile_failures' });
    assert.equal(decideTransition(recipe('verified'), five), null);
  });

  it('2 heals pending review → recompile; 1 does not (boundary)', () => {
    assert.equal(shouldRecompile(stats({ heals_pending: 1 })), false);
    assert.equal(shouldRecompile(stats({ heals_pending: 2 })), true);
    assert.equal(decideTransition(recipe('verified'), stats({ heals_pending: 2 }))?.reason, 'recompile_heals');
  });

  it('fallback rate above 20% on the current build → recompile; exactly 20% does not (boundary)', () => {
    assert.equal(shouldRecompile(stats({ fallback_rate_current_build: 0.2 })), false);
    assert.equal(shouldRecompile(stats({ fallback_rate_current_build: 0.21 })), true);
    assert.equal(decideTransition(recipe('ci_gate'), stats({ fallback_rate_current_build: 0.25 }))?.reason, 'recompile_fallbacks');
  });

  it('a recompile beats a promotion: a failing candidate is never promoted', () => {
    const d = decideTransition(recipe('candidate'), stats({ runs: 10, successes: 4, success_sessions: 3, last_runs: runsWith(10, 6) }));
    assert.equal(d?.to, 'candidate');
    assert.equal(d?.reason, 'recompile_failures');
  });

  it('no runs at all means no decision', () => {
    assert.equal(shouldRecompile(stats()), false);
    assert.equal(decideTransition(recipe('verified'), stats()), null);
  });

  // 08 §5 row 3 is "> 50 % of the LAST 10 RUNS": a 1-of-1 or 2-of-2 window is not that sample,
  // and without the floor a single bad run demoted a freshly verified recipe.
  it('a window below recompile_min_runs never triggers, however bad it looks', () => {
    for (const n of [1, 2]) {
      const all = stats({ runs: n, last_runs: runsWith(n, n) });
      assert.equal(shouldRecompile(all), false, `${n}/${n} failures is too small a sample`);
      assert.equal(decideTransition(recipe('verified'), all), null);
    }
    // at the floor the rule applies again
    const three = stats({ runs: 3, last_runs: runsWith(3, 2) });
    assert.equal(shouldRecompile(three), true);
    assert.equal(decideTransition(recipe('verified'), three)?.reason, 'recompile_failures');
  });
});

describe('eligibleForCiGate — 08 §5 row 1', () => {
  const builds = (spec: Array<[number, number]>): RecipeStats['builds'] => spec.map(([runs, successes], i) => ({ build: String(4400 + i), runs, successes }));

  it('94.9% across 3 builds is not eligible, 95.0% is (boundary)', () => {
    assert.equal(eligibleForCiGate(stats({ builds: builds([[400, 379], [400, 380], [200, 190]]) })), false, '949/1000 = 94.9%');
    assert.equal(eligibleForCiGate(stats({ builds: builds([[400, 380], [400, 380], [200, 190]]) })), true, '950/1000 = 95.0%');
  });

  it('2 builds is not enough, 3 is (boundary)', () => {
    assert.equal(eligibleForCiGate(stats({ builds: builds([[10, 10], [10, 10]]) })), false);
    assert.equal(eligibleForCiGate(stats({ builds: builds([[10, 10], [10, 10], [10, 10]]) })), true);
  });

  it('builds with no runs are not eligible', () => {
    assert.equal(eligibleForCiGate(stats({ builds: builds([[0, 0], [0, 0], [0, 0]]) })), false);
    assert.equal(eligibleForCiGate(stats()), false);
  });
});

describe('screensReferenced — 02 §8 / 04 §8', () => {
  it('collects entry, fallback_path, step expects, open_link urls, preconditions and verify', () => {
    const r = recipe('verified', {
      entry: { deep_link: 'appmap://invoice_new?fixture=logged_in', fallback_path: ['invoice_list', 'invoice_new'] },
      preconditions: [{ screen: 'login' }],
      steps: [
        { id: 's1', action: 'tap', element: 'invoice.client.picker', expect: { screen: 'client_picker' } },
        { id: 's2', action: 'open_link', url: 'appmap://invoice_detail' },
      ],
      verify: { screen: 'invoice_detail' },
    });
    assert.deepEqual(screensReferenced(r), ['client_picker', 'invoice_detail', 'invoice_list', 'invoice_new', 'login']);
  });
});

describe('recompileCovers / stepIdentity — the 04 §8 coverage rule (issue #13)', () => {
  /** a recipe whose only interesting part is its step list */
  const withSteps = (steps: RecipeFile['steps']): RecipeFile => recipe('verified', { steps });
  const tap = (id: string, element: string, over: Partial<RecipeFile['steps'][number]> = {}): RecipeFile['steps'][number] =>
    ({ id, action: 'tap', element, ...over } as RecipeFile['steps'][number]);

  it('identity is the action plus the one thing the step acts on, never the data it carries', () => {
    assert.equal(stepIdentity({ id: 's1', action: 'tap', element: 'invoice.save.button' }), 'tap:invoice.save.button');
    assert.equal(stepIdentity({ id: 's1', action: 'select', list: 'client.picker.list', match: { text: 'Acme' } }), 'select:client.picker.list');
    // both `select` forms identify by the element they address, so a step that moves from the
    // container to the row is a DIFFERENT step and 04 §8's guard sees the change (issue #19)
    assert.equal(stepIdentity({ id: 's1', action: 'select', cell: 'client.picker.cell', match: { text: 'Acme' } }), 'select:client.picker.cell');
    assert.equal(stepIdentity({ id: 's1', action: 'dismiss_gate', gate: 'push_permission' }), 'dismiss_gate:push_permission');
    assert.equal(stepIdentity({ id: 's1', action: 'open_link', url: 'appmap://invoice_new' }), 'open_link:appmap://invoice_new');
    assert.equal(stepIdentity({ id: 's1', action: 'swipe', direction: 'up' }), 'swipe:up:-');
    assert.equal(stepIdentity({ id: 's1', action: 'wait_for', expect: { screen: 'invoice_detail' } }), 'wait_for:invoice_detail');
  });

  it('a {param} slot and the literal it was compiled from are the same step (04 §3.4)', () => {
    // which of the two a rebuild produces depends only on the `values` the replayed run carried,
    // so comparing them would report a removal that did not happen
    const reviewed = withSteps([{ id: 's1', action: 'type', element: 'invoice.amount.field', text: '{amount}' }]);
    const rebuilt = withSteps([{ id: 's1', action: 'type', element: 'invoice.amount.field', text: '50' }]);
    assert.deepEqual(recompileCovers(reviewed, rebuilt), { ok: true, missing: [], weakened: [] });
    assert.deepEqual(recompileCovers(rebuilt, reviewed), { ok: true, missing: [], weakened: [] });
    // and the same for a select's match text
    const selReviewed = withSteps([{ id: 's1', action: 'select', list: 'client.picker.list', match: { text: '{client}' } }]);
    const selRebuilt = withSteps([{ id: 's1', action: 'select', list: 'client.picker.list', match: { text: 'Acme Corp' } }]);
    assert.equal(recompileCovers(selReviewed, selRebuilt).ok, true);
  });

  it('an extra step between two reviewed ones still covers; a dropped step does not', () => {
    const reviewed = withSteps([tap('s1', 'a.b.one'), tap('s2', 'a.b.two')]);
    const grown = withSteps([tap('s1', 'a.b.one'), tap('s2', 'a.b.extra'), tap('s3', 'a.b.two')]);
    assert.deepEqual(recompileCovers(reviewed, grown), { ok: true, missing: [], weakened: [] }, 'a superset is allowed to grow');
    // the reported case (#13): the middle step vanished
    const shrunk = withSteps([tap('s1', 'a.b.one')]);
    assert.deepEqual(recompileCovers(reviewed, shrunk), { ok: false, missing: ['s2'], weakened: [] });
  });

  it('every dropped step is named, not just the first', () => {
    const reviewed = withSteps([tap('s1', 'a.b.one'), tap('s2', 'a.b.two'), tap('s3', 'a.b.three')]);
    assert.deepEqual(recompileCovers(reviewed, withSteps([tap('s1', 'a.b.two')])).missing, ['s1', 's3']);
  });

  it('covering steps in the WRONG ORDER is not coverage', () => {
    const reviewed = withSteps([tap('s1', 'a.b.one'), tap('s2', 'a.b.two')]);
    const reversed = withSteps([tap('s1', 'a.b.two'), tap('s2', 'a.b.one')]);
    // both identities are present, but a recipe is a sequence: taking them in the other order is
    // a different flow, so the reviewed s2 has nothing left after the match at index 1
    assert.deepEqual(recompileCovers(reviewed, reversed), { ok: false, missing: ['s2'], weakened: [] });
  });

  it('a matched step that lost its expect.screen is weakened; a stronger expect is not', () => {
    const reviewed = withSteps([tap('s1', 'invoice.save.button', { expect: { screen: 'invoice_detail' } })]);
    assert.deepEqual(
      recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button')])),
      { ok: false, missing: [], weakened: ['s1'] },
      'kept the tap, dropped the assertion — this is the recipe that PASSes while testing nothing',
    );
    const stronger = withSteps([tap('s1', 'invoice.save.button', { expect: { screen: 'invoice_detail', visible: ['invoice.detail.amount.text'] } })]);
    assert.equal(recompileCovers(reviewed, stronger).ok, true, 'a rebuild may strengthen a postcondition');
    const wrongScreen = withSteps([tap('s1', 'invoice.save.button', { expect: { screen: 'invoice_list' } })]);
    assert.deepEqual(recompileCovers(reviewed, wrongScreen).weakened, ['s1']);
  });

  it('a dropped entry from expect.visible / not_visible is a weakening', () => {
    const reviewed = withSteps([tap('s1', 'invoice.save.button', { expect: { visible: ['a.b.one', 'a.b.two'], not_visible: ['a.b.err'] } })]);
    assert.deepEqual(recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button', { expect: { visible: ['a.b.one'], not_visible: ['a.b.err'] } })])).weakened, ['s1']);
    assert.deepEqual(recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button', { expect: { visible: ['a.b.one', 'a.b.two'] } })])).weakened, ['s1']);
  });

  it('a reviewed intent_critical step that comes back unmarked is weakened (04 §3.7)', () => {
    const reviewed = withSteps([tap('s1', 'invoice.save.button', { intent_critical: true })]);
    assert.deepEqual(recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button')])), { ok: false, missing: [], weakened: ['s1'] });
    // the other direction is a strengthening, and 02 §10.6 reads an absent mark as false
    assert.equal(recompileCovers(withSteps([tap('s1', 'invoice.save.button')]), reviewed).ok, true);
  });

  it('a reviewed step with no expect is covered by a rebuilt step with any expect (02 §6)', () => {
    const reviewed = withSteps([tap('s1', 'invoice.save.button')]);
    assert.equal(recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button', { expect: { screen: 'invoice_detail' } })])).ok, true);
    assert.equal(recompileCovers(reviewed, withSteps([tap('s1', 'invoice.save.button')])).ok, true);
  });

  it('an empty reviewed step list is covered by anything', () => {
    assert.deepEqual(recompileCovers(withSteps([]), withSteps([tap('s1', 'a.b.one')])), { ok: true, missing: [], weakened: [] });
  });
});

describe('recompileCoversEntry / deepLinkCovers — preconditions and entry (04 §8, issue #13)', () => {
  /** a recipe whose only interesting parts are `preconditions` and `entry` */
  const withEntry = (over: Partial<RecipeFile>): RecipeFile => recipe('verified', over);

  it('conditionKey renders a condition on one log-safe line in 02 §4.1 key order', () => {
    assert.equal(conditionKey({ auth: 'logged_in' }), 'auth=logged_in');
    assert.equal(conditionKey({ value: true, flag: 'beta' }), 'flag=beta,value=true');
    assert.equal(conditionKey({}), '');
  });

  it('a deep link covers another when the screen matches and every query param survives', () => {
    assert.equal(deepLinkCovers('appmap://invoice_new', 'appmap://invoice_new'), true);
    assert.equal(deepLinkCovers('appmap://invoice_new', 'appmap://invoice_new?fixture=logged_in'), true, 'adding ?fixture is a strengthening');
    assert.equal(deepLinkCovers('appmap://invoice_new?fixture=logged_in', 'appmap://invoice_new'), false, 'dropping it is preconditions loss in URL form');
    assert.equal(deepLinkCovers('appmap://invoice_new?fixture=logged_in', 'appmap://invoice_new?fixture=logged_out'), false);
    assert.equal(deepLinkCovers('appmap://invoice_new', 'appmap://invoice_list'), false, 'a different screen is a different entry');
    assert.equal(deepLinkCovers('appmap://invoice_new', undefined), false, 'no deep link at all is the worst case');
  });

  it('a rebuild that drops a reviewed precondition does not cover it; an extra one is a narrowing, not a loss', () => {
    const reviewed = withEntry({ preconditions: [{ auth: 'logged_in' }] });
    assert.deepEqual(
      recompileCoversEntry(reviewed, withEntry({})),
      { ok: false, missing_preconditions: ['auth=logged_in'], entry_loss: [] },
      'this is what the pilot recompile from a slice that starts after the entry actually does',
    );
    assert.equal(recompileCoversEntry(reviewed, withEntry({ preconditions: [{ flag: 'beta', value: true }, { auth: 'logged_in' }] })).ok, true, 'order-free, and extra conditions are fine');
    assert.equal(recompileCoversEntry(withEntry({}), withEntry({ preconditions: [{ auth: 'logged_in' }] })).ok, true);
  });

  it('a rebuilt entry that loses the reviewed deep link (or its fixture) is a weakening', () => {
    const reviewed = withEntry({ entry: { deep_link: 'appmap://invoice_new?fixture=logged_in', fallback_path: ['invoice_list', 'invoice_new'] } });
    assert.deepEqual(
      recompileCoversEntry(reviewed, withEntry({ entry: { deep_link: 'appmap://invoice_new', fallback_path: ['invoice_new'] } })).entry_loss,
      ['deep_link appmap://invoice_new?fixture=logged_in → appmap://invoice_new'],
    );
    assert.deepEqual(
      recompileCoversEntry(reviewed, withEntry({ entry: { fallback_path: ['invoice_new'] } })).entry_loss,
      ['deep_link appmap://invoice_new?fixture=logged_in → (none)'],
    );
  });

  it('a shorter fallback_path is NOT a loss while the deep link stands — it says the run entered by deep link', () => {
    // `optimizeEntry` (04 §3.5) derives fallback_path from whatever leading navigation the slice
    // held, so refusing on it would refuse nearly every healthy recompile for no information
    const reviewed = withEntry({ entry: { deep_link: 'appmap://invoice_new', fallback_path: ['invoice_list', 'invoice_new'] } });
    assert.equal(recompileCoversEntry(reviewed, withEntry({ entry: { deep_link: 'appmap://invoice_new', fallback_path: ['invoice_new'] } })).ok, true);
  });

  it('with NO deep link the fallback_path IS the entry, so it may not shrink or reorder', () => {
    const reviewed = withEntry({ entry: { fallback_path: ['invoice_list', 'invoice_new'] } });
    assert.equal(recompileCoversEntry(reviewed, withEntry({ entry: { fallback_path: ['invoice_list', 'client_picker', 'invoice_new'] } })).ok, true, 'a longer route still walks the same screens in order');
    assert.deepEqual(recompileCoversEntry(reviewed, withEntry({ entry: { fallback_path: ['invoice_new'] } })).entry_loss, ['fallback_path dropped invoice_list']);
    assert.deepEqual(recompileCoversEntry(reviewed, withEntry({ entry: { fallback_path: ['invoice_new', 'invoice_list'] } })).entry_loss, ['fallback_path dropped invoice_new']);
  });
});

// ---------------------------------------------------------------------------------------------
// Effectful half: markRecipe, markVerified, retireRecipesForScreen, recordRunOutcome
// ---------------------------------------------------------------------------------------------

let t: TempAppMapDir;
let ctx: AppMapContext;
before(() => { t = makeTempAppMapDir(); });
after(() => t.cleanup());
beforeEach(() => { ctx = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' }); });
afterEach(() => ctx.close());

const isCode = (code: string) => (e: unknown): boolean => AppMapError.is(e) && e.code === code;
const draft = (over: Partial<RecipeFile> = {}): RecipeFile => ({
  id: 'file_invoices', version: 1, platform: 'ios', description: 'Filter the invoice list',
  matches: ['filter invoices'], params: [],
  entry: { deep_link: 'appmap://invoice_list', fallback_path: ['invoice_list'] },
  steps: [{ id: 's1', action: 'tap', element: 'invoice.filter.button', expect: { screen: 'invoice_list' } }],
  verify: { screen: 'invoice_list' }, status: 'candidate',
  provenance: { compiled_from: 'sess_x', compiled_by: 'app-map-mcp@0.1.0' }, ...over,
});
function finishedRun(over: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: `run_${Math.random().toString(36).slice(2, 10)}`, recipe: 'create_invoice', version: 3, mode: 'guided',
    session: 'sess_a', params: {}, state: 'done', current_step: 's5', step_index: 4, heals: [], fallbacks: 0,
    started_at: now(), build: ctx.build, start_seq: 0, last_seq: 5, ...over,
  };
}

// --- the issue #13 recompile fixtures --------------------------------------------------------
/** the session the committed trajectory fixture was recorded under */
const TRAJECTORY_SESSION = 'sess_2026-09-10_0007';
/** the values the successful replay carried, so `compileRecipe` can re-parameterize (04 §3.4) */
const REPLAY_PARAMS = { amount: 50, client: 'Acme Corp' };

/**
 * The reporter's shape (#13): a REVIEWED 3-step recipe over pilot ids whose middle step is the
 * one a degraded rebuild drops. Steps s1/s3 are what seqs 4 and 8 of the fixture compile to —
 * so s1's `expect` tracks the ios pilot's, which asserts `visible` rather than the unsatisfiable
 * `focused` (issue #18). Were it left as `focused`, every rebuild would look like a WEAKENING
 * (`stepKeeps`, correctly) and the write guard would refuse before the gate under test was reached.
 */
const reviewedThreeStep = (over: Partial<RecipeFile> = {}): RecipeFile => ({
  id: 'create_invoice', version: 3, platform: 'ios',
  description: 'Create an invoice for a client with an amount and save it',
  matches: ['(create|new|make)( an?)? invoice'],
  params: [{ name: 'amount', type: 'money', required: true }, { name: 'client', type: 'string', required: true }],
  entry: { deep_link: 'appmap://invoice_new', fallback_path: ['invoice_new'] },
  steps: [
    { id: 's1', action: 'tap', element: 'invoice.amount.field', expect: { visible: ['invoice.amount.field'] } },
    { id: 's2', action: 'type', element: 'invoice.amount.field', text: '{amount}' },
    { id: 's3', action: 'tap', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true },
  ],
  verify: { screen: 'invoice_detail' }, status: 'verified',
  provenance: { compiled_from: 'traj_old', compiled_by: 'app-map-mcp@0.1.0', reviewed_by: 'caleb' },
  ...over,
});

/** insert only the named seqs of the committed trajectory, so the rebuild's shape is controlled */
function seedSeqs(seqs: number[], c: AppMapContext = ctx): void {
  for (const o of loadTrajectoryFixture('create_invoice.session')) if (seqs.includes(o.seq)) c.db.insertObservation(o);
}

/**
 * 4 successful runs then 6 failed ones (6/10 > 50 %, 08 §5 row 3) with only the LAST one recorded,
 * so exactly one recompile is attempted and the assertions below are unambiguous.
 */
function forceRecompile(c: AppMapContext = ctx): ReturnType<typeof recordRunOutcome> {
  for (let i = 0; i < 4; i++) c.db.insertRun({ ...finishedRun({ session: TRAJECTORY_SESSION, start_seq: 0, params: REPLAY_PARAMS }), build: c.build });
  for (let i = 0; i < 5; i++) c.db.insertRun({ ...finishedRun({ session: `sess_bad_${i}`, state: 'failed' }), build: c.build });
  const run = { ...finishedRun({ session: 'sess_bad_last', state: 'failed' }), build: c.build };
  c.db.insertRun(run);
  return recordRunOutcome(c, run, { ok: false, steps: 3, steps_done: 1, ms: 500 });
}

/** the dirty rows `recompileFrom` writes the recipe BODY under (never the status-only transition) */
const recompileDirtyRows = (c: AppMapContext = ctx): ReturnType<AppMapContext['db']['listDirty']> =>
  c.db.listDirty().filter((d) => d.reason.startsWith('recompile:'));

describe('markRecipe — 04 §3.8 / 07 §7', () => {
  it('candidate on an unknown recipe without a draft is bad_input', () => {
    assert.throws(() => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate' }), isCode(ERROR_CODES.BAD_INPUT));
    assert.equal(ctx.db.getRecipe('file_invoices'), undefined, 'nothing is written without the draft');
  });

  it('candidate with the compiled draft writes it dirty', () => {
    const r = markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft() });
    assert.deepEqual(r, { recipe_id: 'file_invoices', from: null, to: 'candidate', written: true });
    assert.equal(ctx.db.getRecipe('file_invoices')?.status, 'candidate');
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'recipe' && d.key === 'file_invoices'));
  });

  it('a draft may also be handed over as canonical YAML text', () => {
    const yaml = [
      'id: file_invoices', 'version: 1', 'platform: ios', 'description: Filter the invoice list',
      'matches:', '  - filter invoices', 'params: []',
      'entry:', '  deep_link: appmap://invoice_list', '  fallback_path:', '    - invoice_list',
      'steps:', '  - id: s1', '    action: tap', '    element: invoice.filter.button', '    expect:', '      screen: invoice_list',
      'verify:', '  screen: invoice_list', 'status: candidate',
      'provenance:', '  compiled_from: sess_x', '  compiled_by: app-map-mcp@0.1.0', '',
    ].join('\n');
    assert.equal(markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: yaml }).written, true);
    assert.equal(ctx.db.getRecipe('file_invoices')?.steps[0]?.id, 's1');
  });

  it('a draft that fails the schema or references an unknown id is refused (07 §4)', () => {
    assert.throws(() => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft({ version: 0 }) }), isCode(ERROR_CODES.INVALID_MAP));
    assert.throws(
      () => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft({ steps: [{ id: 's1', action: 'tap', element: 'nope.not.registered' }] }) }),
      isCode(ERROR_CODES.INVALID_MAP),
    );
    assert.throws(() => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft({ id: 'other' }) }), isCode(ERROR_CODES.BAD_INPUT));
    assert.equal(ctx.db.getRecipe('file_invoices'), undefined);
  });

  it('a YAML draft whose string field parsed as a number is refused with the quoting hint (02 §10 rule 1, issue #20)', () => {
    const yaml = [
      'id: file_invoices', 'version: 1', 'platform: ios', 'description: 1.0',
      'matches:', '  - filter invoices', 'params: []',
      'entry:', '  deep_link: appmap://invoice_list', '  fallback_path:', '    - invoice_list',
      'steps:', '  - id: s1', '    action: tap', '    element: invoice.filter.button', '    expect:', '      screen: invoice_list',
      'verify:', '  screen: invoice_list', 'status: candidate',
      'provenance:', '  compiled_from: sess_x', '  compiled_by: app-map-mcp@0.1.0', '',
    ].join('\n');
    assert.throws(
      () => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: yaml }),
      // the spelling the author typed, not String(1.0) === "1" — `mark` reads the draft with its
      // YAML kind so it teaches the same fix the load path does
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP
        && e.message === 'mark: draft fails recipe.schema.json: /description must be string — quote it in YAML ("1.0"), or 1.0 parses as a number',
    );
    assert.equal(ctx.db.getRecipe('file_invoices'), undefined, 'nothing is written');
  });

  it('a draft handed over as an object keeps the plain wording — JSON has no YAML spelling to quote (issue #20)', () => {
    assert.throws(
      () => markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft({ description: 1 as unknown as string }) }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP
        && e.message === 'mark: draft fails recipe.schema.json: /description must be string {"type":"string"}',
    );
  });

  it('an unknown status is bad_input', () => {
    assert.throws(() => markRecipe(ctx, { recipe_id: 'create_invoice', status: 'blessed' as RecipeStatus }), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('ci_gate without a reviewer is bad_input (07 §7)', () => {
    assert.throws(() => markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate' }), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('ci_gate with a reviewer but without the 95%/3-build record is refused; --force overrides and records the reviewer', () => {
    assert.throws(() => markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'dana' }), isCode(ERROR_CODES.BAD_INPUT));
    const r = markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'dana', force: true });
    assert.deepEqual({ from: r.from, to: r.to }, { from: 'verified', to: 'ci_gate' });
    assert.equal(ctx.db.getRecipe('create_invoice')?.provenance.reviewed_by, 'dana');
  });

  // 07 §7 "a reviewer who is not the author": the CLI can only check the identities it holds; the
  // real control is branch protection. Rejecting the obvious self-sign keeps `reviewed_by` honest.
  it('the recipe author cannot sign their own ci_gate promotion (07 §7)', () => {
    const authored = { ...ctx.map.recipes.get('create_invoice')!, provenance: { compiled_from: 't', compiled_by: 'caleb' } };
    ctx.db.putRecipe(authored, { dirty: false });
    assert.throws(
      () => markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'caleb', force: true }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /cannot also review/.test(e.message),
    );
    assert.equal(ctx.db.getRecipe('create_invoice')?.status, 'verified', 'nothing was written');
    // a different reviewer is fine
    assert.equal(markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'dana', force: true }).to, 'ci_gate');
  });

  it('ci_gate is allowed once the run record clears 08 §5 row 1', () => {
    for (const build of ['4410', '4411', '4412']) {
      ctx.db.insertRun(finishedRun({ build, session: `sess_${build}` }));
    }
    const r = markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'dana' });
    assert.equal(r.to, 'ci_gate');
  });

  it('demoting an existing recipe needs no draft and keeps its content', () => {
    const before = ctx.map.recipes.get('create_invoice')!;
    const r = markRecipe(ctx, { recipe_id: 'create_invoice', status: 'candidate' });
    assert.deepEqual({ from: r.from, to: r.to, written: r.written }, { from: 'verified', to: 'candidate', written: true });
    const after = ctx.db.getRecipe('create_invoice')!;
    assert.deepEqual(after.steps, before.steps);
    assert.equal(after.version, before.version, 'a demotion is not a structural change (04 §8)');
  });

  it('a structural change to an existing recipe bumps the version; a prose-only change does not (04 §8)', () => {
    markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft() });
    const structural = draft({ steps: [{ id: 's1', action: 'tap', element: 'invoice.add.button', expect: { screen: 'invoice_new' } }] });
    assert.equal(markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: structural }).written, true);
    assert.equal(ctx.db.getRecipe('file_invoices')?.version, 2);
    const prose = draft({ ...structural, version: 2, description: 'Filter the invoices list' });
    markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: prose });
    assert.equal(ctx.db.getRecipe('file_invoices')?.version, 2, 'no structural change → no version bump');
  });
});

describe('markScreen — 02 §8 / issue #16 (the way back out of verified)', () => {
  it('demotes a verified screen, records the reviewer and withdraws the verification', () => {
    assert.equal(ctx.map.screens.get('invoice_list')!.meta.status, 'verified', 'the fixture starts verified');
    const r = markScreen(ctx, { screen_id: 'invoice_list', status: 'candidate', reviewer: 'dana' });
    assert.deepEqual(r, { screen_id: 'invoice_list', from: 'verified', to: 'candidate', written: true, retired_recipes: [] });

    const meta = ctx.db.getScreen('invoice_list')!.meta;
    assert.equal(meta.status, 'candidate');
    assert.equal(meta.reviewed_by, 'dana', '07 §7: the human who took the verification back is recorded');
    assert.equal(meta.last_verified_build, undefined, '02 §8: the build stamp goes with the verification');
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'invoice_list' && d.reason === 'mark_screen:candidate'));
  });

  it('an unknown status, an empty id and an unknown screen are refused (02 §8 enum)', () => {
    assert.throws(
      () => markScreen(ctx, { screen_id: 'invoice_list', status: 'blessed' as ScreenStatus }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /candidate\|verified\|retired/.test(e.message),
    );
    assert.throws(() => markScreen(ctx, { screen_id: '', status: 'candidate' }), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => markScreen(ctx, { screen_id: 'nope', status: 'candidate' }), isCode(ERROR_CODES.NOT_FOUND));
    assert.equal(ctx.db.getScreen('invoice_list')!.meta.status, 'verified', 'nothing was written');
  });

  it('verified cannot be hand-signed without force, and forcing it needs a reviewer (07 §7)', () => {
    assert.throws(
      () => markScreen(ctx, { screen_id: 'invoice_list', status: 'verified' }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /clean observation/.test(e.hint),
    );
    assert.throws(
      () => markScreen(ctx, { screen_id: 'invoice_list', status: 'verified', force: true }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /reviewer/.test(e.message),
    );
    const r = markScreen(ctx, { screen_id: 'invoice_list', status: 'verified', force: true, reviewer: 'dana' });
    assert.equal(r.to, 'verified');
    assert.equal(ctx.db.getScreen('invoice_list')!.meta.last_verified_build, ctx.build);
    assert.equal(ctx.db.getScreen('invoice_list')!.meta.reviewed_by, 'dana');
  });

  it('retiring a screen by hand cascades to its recipes and KEEPS last_verified_build (02 §8)', () => {
    const r = markScreen(ctx, { screen_id: 'client_picker', status: 'retired' });
    assert.deepEqual(r.retired_recipes, ['create_invoice']);
    assert.equal(ctx.db.getRecipe('create_invoice')!.status, 'retired');
    // `import-router --purge-retired` deletes a retired screen only once a NEWER build arrives;
    // `isNewerBuild(b, undefined)` is true, so clearing the stamp here would delete it at once
    assert.equal(ctx.db.getScreen('client_picker')!.meta.last_verified_build, '4412');
  });

  it('gates are markable too — they are screens with kind: gate (02 §4.2)', () => {
    const r = markScreen(ctx, { screen_id: 'gate.push_permission', status: 'candidate' });
    assert.deepEqual({ from: r.from, to: r.to, written: r.written }, { from: 'verified', to: 'candidate', written: true });
    const gate = ctx.db.getScreen('gate.push_permission')!;
    assert.equal(gate.kind, 'gate', 'the gate is loaded from ctx.map.gates, not ctx.map.screens');
    assert.equal(gate.meta.status, 'candidate');
  });

  it('a reviewer signature clears the forced-re-learn marker (the issue #13 precedent)', () => {
    const screen: ScreenFile = structuredClone(ctx.map.screens.get('invoice_list')!);
    screen.meta = { ...screen.meta, status: 'candidate', relearned_from: 'verified' };
    ctx.db.putScreen(screen, { dirty: false });
    markScreen(ctx, { screen_id: 'invoice_list', status: 'candidate', reviewer: 'dana' });
    const meta = ctx.db.getScreen('invoice_list')!.meta;
    assert.equal(meta.relearned_from, undefined, 'the human has now signed this data');
    assert.equal(meta.reviewed_by, 'dana');
  });
});

describe('markVerified — 02 §8 / 08 §5 row 5 (architecture §7 decision 32)', () => {
  const elementOf = (screen: string, id: string): ElementDef => ctx.db.getScreen(screen)!.elements.find((e) => e.id === id)!;

  it('stamps last_verified_build on screens, elements and edges and dirties only what changed', () => {
    ctx.setBuild('4413');
    const before = ctx.db.listDirty().length;
    const out = markVerified(ctx, {
      screens: ['invoice_new'],
      elements: [{ screen: 'invoice_new', element: 'invoice.save.button' }],
      edges: [{ screen: 'invoice_new', action: { type: 'tap', element: 'invoice.save.button' }, to: 'invoice_detail' }],
    });
    assert.deepEqual(out.screens, ['invoice_new']);
    assert.deepEqual(out.elements, ['invoice.save.button']);
    assert.equal(out.edges, 1);
    assert.equal(ctx.db.getScreen('invoice_new')!.meta.last_verified_build, '4413');
    assert.equal(elementOf('invoice_new', 'invoice.save.button').last_verified_build, '4413');
    assert.equal(ctx.db.getScreen('invoice_new')!.edges.find((e) => e.to === 'invoice_detail')!.last_verified_build, '4413');
    assert.equal(ctx.db.listDirty().length, before + 1, 'one screen row, written once');

    // idempotent: the same build again changes nothing and dirties nothing new
    const again = markVerified(ctx, { screens: ['invoice_new'], elements: [{ screen: 'invoice_new', element: 'invoice.save.button' }] });
    assert.deepEqual(again, { screens: [], elements: [], edges: 0 });
  });

  it('promotes candidate → verified and leaves healed_pending_review alone (04 §7.2)', () => {
    const screen: ScreenFile = structuredClone(ctx.db.getScreen('invoice_new')!);
    screen.meta = { sources: ['exploration'], status: 'candidate' };
    screen.elements.find((e) => e.id === 'invoice.amount.field')!.status = 'candidate';
    screen.elements.find((e) => e.id === 'invoice.save.button')!.status = 'healed_pending_review';
    ctx.db.putScreen(screen, { dirty: false });

    markVerified(ctx, {
      screens: ['invoice_new'],
      elements: [{ screen: 'invoice_new', element: 'invoice.amount.field' }, { screen: 'invoice_new', element: 'invoice.save.button' }],
    }, '4420');
    assert.equal(ctx.db.getScreen('invoice_new')!.meta.status, 'verified');
    assert.equal(elementOf('invoice_new', 'invoice.amount.field').status, 'verified');
    assert.equal(elementOf('invoice_new', 'invoice.save.button').status, 'healed_pending_review', 'only a human review clears it');
    assert.equal(elementOf('invoice_new', 'invoice.save.button').last_verified_build, '4412', 'and its build is not restamped');
  });

  it('stamps a recipe build but never promotes its status (04 §8 owns that)', () => {
    markRecipe(ctx, { recipe_id: 'file_invoices', status: 'candidate', recipe: draft() });
    const out = markVerified(ctx, { recipe: 'file_invoices' }, '4413');
    assert.equal(out.recipe, 'file_invoices');
    assert.equal(ctx.db.getRecipe('file_invoices')!.last_verified_build, '4413');
    assert.equal(ctx.db.getRecipe('file_invoices')!.status, 'candidate');
  });

  it('unknown screens, elements and edges are ignored, not thrown', () => {
    assert.deepEqual(markVerified(ctx, { screens: ['nope'], elements: [{ screen: 'nope', element: 'a.b.c' }], edges: [{ screen: 'invoice_new', action: { type: 'tap', element: 'a.b.c' }, to: 'nope' }], recipe: 'nope' }), { screens: [], elements: [], edges: 0 });
    assert.deepEqual(markVerified(ctx, {}), { screens: [], elements: [], edges: 0 });
  });
});

describe('retireRecipesForScreen — 02 §8 / 04 §8 row 5', () => {
  it('retires every recipe that references the screen and marks it dirty', () => {
    assert.deepEqual(retireRecipesForScreen(ctx, 'client_picker'), ['create_invoice']);
    assert.equal(ctx.db.getRecipe('create_invoice')?.status, 'retired');
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'recipe' && d.key === 'create_invoice' && d.reason === 'retired_screen'));
  });

  it('a screen no recipe references retires nothing, and a retired recipe is not retired twice', () => {
    assert.deepEqual(retireRecipesForScreen(ctx, 'login'), []);
    assert.deepEqual(retireRecipesForScreen(ctx, 'invoice_detail'), ['create_invoice']);
    assert.deepEqual(retireRecipesForScreen(ctx, 'invoice_detail'), []);
  });

  it('an empty screen id is bad_input', () => {
    assert.throws(() => retireRecipesForScreen(ctx, ''), isCode(ERROR_CODES.BAD_INPUT));
  });
});

describe('recordRunOutcome — counters, the recipe_run event (08 §2) and the decision', () => {
  it('bumps counters and appends one recipe_run event', () => {
    const run = finishedRun();
    ctx.db.insertRun(run);
    recordRunOutcome(ctx, run, { ok: true, steps: 5, steps_done: 5, ms: 6100 });
    const counters = ctx.db.getCounters('recipe', 'create_invoice');
    assert.deepEqual({ runs: counters.runs, replay_success: counters.replay_success, guided_runs: counters.guided_runs }, { runs: 1, replay_success: 1, guided_runs: 1 });
    const events = readEvents(t.config).events.filter((e) => e.kind === 'recipe_run');
    assert.equal(events.length, 1);
    assert.deepEqual(
      { recipe: events[0]!.recipe, mode: events[0]!.mode, ok: events[0]!.ok, steps: events[0]!.steps, ms: events[0]!.ms, run_id: events[0]!.run_id },
      { recipe: 'create_invoice', mode: 'guided', ok: true, steps: 5, ms: 6100, run_id: run.run_id },
    );
  });

  it('a fallback run is a recipe_run with ok:false, fallbacks ≥ 1 and fallback_step (architecture §6)', () => {
    const run = finishedRun({ state: 'fallback', fallbacks: 1, current_step: 's4' });
    ctx.db.insertRun(run);
    recordRunOutcome(ctx, run, { ok: false, steps: 5, steps_done: 3, ms: 900 });
    const e = readEvents(t.config).events.filter((x) => x.kind === 'recipe_run').at(-1)!;
    assert.equal(e.kind === 'recipe_run' && e.ok, false);
    assert.equal(e.kind === 'recipe_run' && e.fallbacks, 1);
    assert.equal(e.kind === 'recipe_run' && e.fallback_step, 's4');
    assert.equal(ctx.db.getCounters('recipe', 'create_invoice').fallbacks, 1);
  });

  it('promotes a candidate once 3 successes across 2 sessions are on record', () => {
    ctx.db.putRecipe({ ...ctx.map.recipes.get('create_invoice')!, status: 'candidate' }, { dirty: false });
    const sessions = ['sess_a', 'sess_b', 'sess_a'];
    let decision = null as ReturnType<typeof recordRunOutcome>;
    for (const session of sessions) {
      const run = finishedRun({ session });
      ctx.db.insertRun(run);
      decision = recordRunOutcome(ctx, run, { ok: true, steps: 5, steps_done: 5, ms: 100 });
    }
    assert.deepEqual(decision, { recipe: 'create_invoice', from: 'candidate', to: 'verified', reason: 'verified' });
    assert.equal(ctx.db.getRecipe('create_invoice')?.status, 'verified');
  });

  it('6 failed runs out of 10 demote to candidate and name the trajectory to recompile from (04 §9)', () => {
    // 4 successes first so a successful trajectory exists to recompile from, then 6 failures
    for (let i = 0; i < 4; i++) ctx.db.insertRun(finishedRun({ session: `sess_ok_${i}`, start_seq: 7 }));
    for (let i = 0; i < 6; i++) ctx.db.insertRun(finishedRun({ session: `sess_bad_${i}`, state: 'failed' }));
    const run = finishedRun({ state: 'failed', run_id: 'run_last' });
    ctx.db.insertRun(run);
    const decision = recordRunOutcome(ctx, run, { ok: false, steps: 5, steps_done: 2, ms: 500 });
    assert.equal(decision?.to, 'candidate');
    assert.equal(decision?.reason, 'recompile_failures');
    assert.equal(decision?.recompile_from?.seq, 8, 'start_seq + 1 of the latest successful run');
    assert.ok(decision?.recompile_from?.session.startsWith('sess_ok_'));
    assert.equal(ctx.db.getRecipe('create_invoice')?.status, 'candidate');
  });

  // 04 §8: "version increments on every structural change". A recompile that reproduces the same
  // steps/params/entry is not a structural change, so repeated failures must not walk the version.
  it('repeated recompiles from the same trajectory do not bump the version (04 §8)', () => {
    // the WHOLE fixture, so the rebuild reaches the version invariant this test exists for: a
    // slice starting at seq 4 rebuilds neither `preconditions: [{auth: logged_in}]` nor the
    // `?fixture=logged_in` on the deep link the pilot recipe carries, and the issue #13 guard
    // refuses it (see the dedicated test below). The 04 §3.2 collapse note the excursion at seqs
    // 2-3 raises does NOT block — it is a normalisation note, not incompleteness. The successful
    // runs carry the values the replay used, without which the recompile fails on
    // `unparameterized_value` and this test proves nothing at all.
    seedSeqs([1, 2, 3, 4, 5, 6, 7, 8]);
    for (let i = 0; i < 4; i++) ctx.db.insertRun(finishedRun({ session: TRAJECTORY_SESSION, start_seq: 0, params: REPLAY_PARAMS }));
    const fail = (): void => {
      const run = finishedRun({ session: `sess_bad_${Math.random().toString(36).slice(2, 8)}`, state: 'failed' });
      ctx.db.insertRun(run);
      recordRunOutcome(ctx, run, { ok: false, steps: 5, steps_done: 2, ms: 500 });
    };
    for (let i = 0; i < 6; i++) fail();
    const afterFirst = ctx.db.getRecipe('create_invoice')!;
    assert.equal(afterFirst.status, 'candidate');
    assert.ok(
      recompileDirtyRows().some((d) => d.kind === 'recipe' && d.key === 'create_invoice' && d.reason === 'recompile:recompile_failures'),
      'the recompile actually WROTE (only recompileFrom sets this reason, never the status transition)',
    );
    const steps = JSON.stringify(afterFirst.steps);
    for (let i = 0; i < 5; i++) fail();
    const afterMore = ctx.db.getRecipe('create_invoice')!;
    assert.equal(JSON.stringify(afterMore.steps), steps, 'the recompiled structure is unchanged');
    assert.equal(afterMore.version, afterFirst.version, 'an unchanged structure keeps the version');
  });

  it('a run for a recipe the map does not know still logs the event and decides nothing', () => {
    const run = finishedRun({ recipe: 'ghost_recipe' });
    ctx.db.insertRun(run);
    assert.equal(recordRunOutcome(ctx, run, { ok: true, steps: 1, steps_done: 1, ms: 1 }), null);
    assert.ok(readEvents(t.config).events.some((e) => e.kind === 'recipe_run' && e.recipe === 'ghost_recipe'));
  });

  it('a malformed run record is bad_input', () => {
    assert.throws(() => recordRunOutcome(ctx, undefined as unknown as RunRecord, { ok: true, steps: 0, steps_done: 0, ms: 0 }), isCode(ERROR_CODES.BAD_INPUT));
  });
});

describe('recompileFrom — the 04 §8 recompile write guard (issue #13)', () => {
  it('a rebuild that drops a reviewed step does not replace it: steps, version and provenance.reviewed_by all survive (criteria 1 and 3)', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    // seqs 4 and 8 only: the tap and the save. The `type` in between never happened, which is
    // exactly the trajectory the reporter's degraded 2-step recipe was compiled from.
    seedSeqs([4, 8]);
    const decision = forceRecompile();

    assert.equal(decision?.reason, 'recompile_failures');
    assert.equal(decision?.recompile?.written, false, 'the reviewed recipe was NOT replaced');
    assert.deepEqual(decision?.recompile?.refusals, ['missing_steps'], 'this trajectory compiles warning-free, so the superset gate is what refused');
    assert.deepEqual(decision?.recompile?.missing_steps, ['s2']);
    assert.deepEqual(decision?.recompile?.weakened_steps, []);
    assert.equal(decision?.recompile?.was_reviewed, true);
    assert.match(decision?.recompile?.diff ?? '', /^-\s+action: type$/m, 'the refusal hands a human the diff that shows the dropped step');

    const kept = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.equal(kept.steps.length, 3, 'all three reviewed steps are still there');
    assert.equal(kept.steps[1]?.action, 'type');
    assert.equal(kept.version, 3, 'the version did not silently move');
    assert.equal(kept.provenance.reviewed_by, 'caleb', 'the reviewer survived (criterion 3)');
    assert.equal(kept.provenance.compiled_from, 'traj_old', 'and the body was never rewritten');
    assert.deepEqual(recompileDirtyRows(), [], 'no machine-recompile write reached export');

    // the demotion is real even though the rewrite is not — that is the 08 §5 signal
    assert.equal(kept.status, 'candidate');
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'recipe' && d.key === 'create_invoice' && d.reason === 'lifecycle:recompile_failures'));
  });

  it('the refusal is a compile event with ok:false and a recompile_refused_ reason that validates against events.schema.json (08 §2)', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    seedSeqs([4, 8]);
    forceRecompile();
    const compiles = readEvents(t.config).events.filter((e) => e.kind === 'compile');
    const refusal = compiles.at(-1);
    assert.equal(refusal?.kind === 'compile' && refusal.ok, false);
    assert.equal(refusal?.kind === 'compile' && refusal.reason, 'recompile_refused_missing_steps');
    assert.equal(refusal?.kind === 'compile' && refusal.recipe, 'create_invoice');
    // the compile itself succeeded; only the write was refused, so both lines are on record
    assert.equal(compiles.at(-2)?.kind === 'compile' && compiles.at(-2)?.ok, true);
    for (const event of readEvents(t.config).events) {
      assert.deepEqual(validateEventLine(schemaDir(t.config), JSON.stringify(event)), [], `${event.kind}: no new event kind was needed`);
    }
  });

  it('a rebuild that covers every reviewed step is written, keeps reviewed_by, and lands dirty under the recompile: reason (criterion 4)', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    // seqs 4-8: the same three steps plus the client picker tap and select — a STRICT superset
    seedSeqs([4, 5, 6, 7, 8]);
    const decision = forceRecompile();

    assert.equal(decision?.recompile?.written, true);
    assert.deepEqual(decision?.recompile?.refusals, []);
    const next = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.deepEqual(next.steps.map((x) => x.action), ['tap', 'type', 'tap', 'select', 'tap'], 'the rebuilt superset keeps all three reviewed steps and adds two');
    assert.equal(next.provenance.reviewed_by, 'caleb', 'an accepted revision carries the reviewer forward');
    assert.equal(next.provenance.compiled_from, TRAJECTORY_SESSION);
    assert.equal(next.provenance.revision_of, 3);
    assert.equal(next.version, 4, 'a structural change is a new revision (04 §8)');
    assert.equal(next.status, 'candidate', 'and it still needs a human before it can gate CI');
    assert.deepEqual(
      recompileDirtyRows().map((d) => ({ kind: d.kind, key: d.key, reason: d.reason })),
      [{ kind: 'recipe', key: 'create_invoice', reason: 'recompile:recompile_failures' }],
      'the body write is labelled distinctly from the status transition',
    );
  });

  it('an INCOMPLETENESS warning blocks the write even when the steps cover the reviewed ones (criterion 2)', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    // seqs 1 and 4-8 (the excursion at 2-3 left out, so the collapse note is not in play), plus a
    // driver call at seq 2 that FAILED. 04 §3.1 drops failed calls from the slice and says so:
    // whatever the run did there is missing from the rebuild, and the coverage rule below cannot
    // see it because the reviewed recipe never had that step. That is the gap this gate covers.
    seedSeqs([1, 4, 5, 6, 7, 8]);
    const source = loadTrajectoryFixture('create_invoice.session').find((o) => o.seq === 4)!;
    ctx.db.insertObservation({ ...source, seq: 2, ok: false });
    const decision = forceRecompile();

    assert.deepEqual(decision?.recompile?.refusals, ['warnings']);
    assert.equal(decision?.recompile?.written, false);
    assert.deepEqual(decision?.recompile?.missing_steps, [], 'the steps DID cover — the warning alone refused');
    assert.ok(decision?.recompile?.warnings.some((w) => w.includes('failed driver call')), decision?.recompile?.warnings.join('; '));
    const kept = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.equal(kept.steps.length, 3);
    assert.equal(kept.version, 3);
    assert.deepEqual(recompileDirtyRows(), []);
  });

  // deliberately NOT a refusal: see the module header. The 04 §3.2 collapse is what the compiler
  // does to every trajectory by design — including the one the reviewer approved — so treating
  // its note as a defect report refused the pilot's own trajectory and left 04 §9's automatic
  // recompile true only on paper.
  it('the 04 §3.2 backtracking-collapse note is normalisation, not incompleteness, so it does not block', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    // the WHOLE fixture: covering steps plus the A→B→A excursion at seqs 2-3 that is collapsed away
    seedSeqs([1, 2, 3, 4, 5, 6, 7, 8]);
    const decision = forceRecompile();

    assert.deepEqual(decision?.recompile?.refusals, []);
    assert.equal(decision?.recompile?.written, true);
    assert.ok(
      decision?.recompile?.warnings.some((w) => w.includes('backtracking')),
      'the note is still reported on the outcome, it just does not veto the write',
    );
    assert.equal(isCollapseWarning(decision!.recompile!.warnings[0]!), true, 'and it is the note the compiler produces, matched by the shared predicate');
    const next = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.equal(next.steps.length, 5);
    assert.equal(next.provenance.reviewed_by, 'caleb');
  });

  // the same classification question for the OTHER normalisation note, and the one that decides
  // whether 04 §9's automatic recompile works on a real device at all: Argent's iOS snapshot has
  // no focus flag (issue #18), so 04 §3.3's primary `type`-attach rule never fires and EVERY iOS
  // rebuild of a recipe containing a `type` carries the secondary-attach note. Blocking on it
  // would refuse every one of them.
  it('the 04 §3.3 secondary-attach note is normalisation too, so a trajectory with no focus flag still recompiles (issue #18)', () => {
    // s1 asserts nothing, because with no focus reported there is no focus to infer (04 §3.6);
    // the reviewed `expect.screen` on s3 still has to come back, and does
    ctx.db.putRecipe(reviewedThreeStep({
      steps: [
        { id: 's1', action: 'tap', element: 'invoice.amount.field' },
        { id: 's2', action: 'type', element: 'invoice.amount.field', text: '{amount}' },
        { id: 's3', action: 'tap', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true },
      ],
    }), { dirty: false });
    // the covering seqs 4-8, re-recorded as REAL Argent would: no `focused` anywhere in the tree
    for (const o of loadTrajectoryFixture('create_invoice.session')) {
      if (![4, 5, 6, 7, 8].includes(o.seq)) continue;
      const snapshot = o.snapshot === null ? null : JSON.parse(JSON.stringify(o.snapshot, (k, v) => (k === 'focused' ? undefined : v))) as typeof o.snapshot;
      ctx.db.insertObservation({ ...o, snapshot });
    }
    const decision = forceRecompile();

    const note = decision?.recompile?.warnings.find(isFocusFallbackWarning);
    assert.ok(note, `the note is reported: ${decision?.recompile?.warnings.join(' | ')}`);
    assert.deepEqual(decision?.recompile?.refusals, [], 'and it does not veto the write');
    assert.equal(decision?.recompile?.written, true);
    const next = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.deepEqual(next.steps.map((x) => x.action), ['tap', 'type', 'tap', 'select', 'tap']);
    assert.equal(next.steps[1]?.action === 'type' && next.steps[1].element, 'invoice.amount.field', 'the secondary rule still found the right field');
    assert.equal(next.provenance.reviewed_by, 'caleb');
  });

  // the second erosion route, and the one the pilot's own map demonstrates: the steps all come
  // back, but `preconditions: [{auth: logged_in}]` and the `?fixture=logged_in` on the deep link
  // do not, so the surviving taps would run against a logged-OUT app
  it('a rebuild that keeps every step but loses the reviewed preconditions and deep-link fixture is refused', () => {
    const reviewed = ctx.map.recipes.get('create_invoice') as RecipeFile;
    assert.deepEqual(reviewed.preconditions, [{ auth: 'logged_in' }], 'the committed pilot recipe is the fixture here');
    assert.equal(reviewed.entry.deep_link, 'appmap://invoice_new?fixture=logged_in');
    // seqs 4-8: every step of the recipe, but the slice starts AFTER the entry open_url, so
    // `compile` sees no evidence of a logged-in session and rebuilds neither (04 §3.5)
    seedSeqs([4, 5, 6, 7, 8]);
    const decision = forceRecompile();

    assert.equal(decision?.recompile?.written, false);
    assert.deepEqual(decision?.recompile?.refusals, ['missing_preconditions', 'weakened_entry']);
    assert.deepEqual(decision?.recompile?.missing_steps, [], 'every step DID come back — this is not the step rule');
    assert.deepEqual(decision?.recompile?.missing_preconditions, ['auth=logged_in']);
    assert.deepEqual(decision?.recompile?.entry_loss, ['deep_link appmap://invoice_new?fixture=logged_in → appmap://invoice_new']);
    assert.match(decision?.recompile?.diff ?? '', /^-\s+- auth: logged_in$/m, 'and the human gets the diff that shows the drop');

    const kept = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.deepEqual(kept.preconditions, [{ auth: 'logged_in' }]);
    assert.equal(kept.entry.deep_link, 'appmap://invoice_new?fixture=logged_in');
    assert.equal(kept.version, 3, 'the version did not silently move');
    assert.deepEqual(recompileDirtyRows(), []);
  });

  it('an accepted rebuild stamps provenance.machine_recompile: true, and a human signing it clears the stamp (criterion 4)', () => {
    ctx.db.putRecipe(reviewedThreeStep(), { dirty: false });
    seedSeqs([4, 5, 6, 7, 8]);
    assert.equal(forceRecompile()?.recompile?.written, true);

    const written = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.equal(written.provenance.machine_recompile, true);
    assert.deepEqual(
      validateAgainstSchema(schemaDir(t.config), 'recipe', written), [],
      'a stamped recipe is still a legal recipe.schema.json document — export writes it unchanged',
    );
    // the in-file half of criterion 4: the marker sits directly above the carried-over reviewer,
    // so a PR diff reads "machine-built steps, historical signature" without the reviewer having
    // to know what a changed `compiled_from` implies
    assert.match(
      canonicalYaml('recipe', written),
      /^ {2}machine_recompile: true\n {2}reviewed_by: caleb$/m,
    );

    // 07 §7: once a human has read these steps the marker is spent
    for (let i = 0; i < 3; i++) ctx.db.insertRun({ ...finishedRun({ session: `sess_ok_${i}` }), build: ctx.build });
    markRecipe(ctx, { recipe_id: 'create_invoice', status: 'ci_gate', reviewer: 'dana', force: true });
    const signed = ctx.db.getRecipe('create_invoice') as RecipeFile;
    assert.equal(signed.provenance.machine_recompile, undefined, 'the key leaves the YAML entirely, it does not become false');
    assert.equal(signed.provenance.reviewed_by, 'dana');
    assert.doesNotMatch(canonicalYaml('recipe', signed), /machine_recompile/);
  });

  it('the refusal reaches the log at error level, not only the returned outcome', () => {
    // every other test in this file opens the context with `logSink: 'none'`, so the loudness
    // half of "a refusal never fails the run but must be discoverable" needs its own context
    // `makeTempAppMapDir` defaults to APP_MAP_LOG_LEVEL=error; the diff rides at `warn`
    const logged = makeTempAppMapDir({ env: { APP_MAP_LOG_LEVEL: 'warn' } });
    const logCtx = openContext(logged.config, { logSink: 'file', skipRetention: true, dbPath: ':memory:' });
    try {
      logCtx.db.putRecipe(reviewedThreeStep(), { dirty: false });
      seedSeqs([4, 8], logCtx);
      assert.equal(forceRecompile(logCtx)?.recompile?.written, false);
      logCtx.close(); // flush the rotating file sink before reading it

      const lines = readFileSync(serverLog(logged.config), 'utf8').split('\n').filter((l) => l !== '')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const refusal = lines.find((l) => l.level === 'error' && String(l.msg).startsWith('recompile refused'));
      assert.ok(refusal, `no error line; saw ${lines.map((l) => `${String(l.level)}:${String(l.msg)}`).join(' | ')}`);
      assert.equal(refusal.recipe, 'create_invoice');
      assert.deepEqual(refusal.refusals, ['missing_steps']);
      assert.deepEqual(refusal.missing_steps, ['s2']);
      assert.equal(refusal.reviewed_by, 'caleb', 'the reviewer whose signature is at stake is named');
      // the diff rides on a `warn` line's MESSAGE (log.sanitizeFields drops `text`-ish fields)
      assert.ok(lines.some((l) => l.level === 'warn' && String(l.msg).includes('rejected draft for create_invoice')));
    } finally {
      logCtx.close();
      logged.cleanup();
    }
  });

  it('APP_MAP_RECOMPILE=off makes replay read-only against the map: the demotion happens, the steps are never rebuilt', () => {
    const off = makeTempAppMapDir({ env: { APP_MAP_RECOMPILE: 'off' } });
    const offCtx = openContext(off.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(offCtx.config.recompile, 'off');
      offCtx.db.putRecipe(reviewedThreeStep(), { dirty: false });
      seedSeqs([4, 8], offCtx);
      const decision = forceRecompile(offCtx);

      assert.deepEqual(decision?.recompile?.refusals, ['disabled']);
      assert.equal(decision?.recompile?.written, false);
      assert.equal(offCtx.db.getRecipe('create_invoice')?.status, 'candidate', 'the 08 §5 demotion still happens');
      assert.equal(offCtx.db.getRecipe('create_invoice')?.steps.length, 3);
      assert.deepEqual(recompileDirtyRows(offCtx), []);
      assert.deepEqual(readEvents(off.config).events.filter((e) => e.kind === 'compile'), [], 'nothing was even compiled from the trajectory');
    } finally {
      offCtx.close();
      off.cleanup();
    }
  });

  it('a bad APP_MAP_RECOMPILE value is bad_input (03 §3)', () => {
    assert.throws(() => loadConfig({ APP_MAP_RECOMPILE: 'yes' }), isCode(ERROR_CODES.BAD_INPUT));
    assert.equal(loadConfig({}).recompile, 'guarded', 'the default is the guarded write, not the old unguarded one');
    assert.equal(loadConfig({ APP_MAP_RECOMPILE: 'off' }).recompile, 'off');
  });
});
