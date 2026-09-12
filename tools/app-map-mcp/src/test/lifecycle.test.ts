/**
 * [C1] recipes/lifecycle.ts — 04 §8 status lifecycle with the 08 §5 thresholds as code.
 * Every threshold is exercised at its boundary (the number below it and the number at it).
 */
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import type { RecipeStats } from '../store/db.ts';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { ElementDef, RecipeFile, RecipeStatus, RunRecord, ScreenFile } from '../types.ts';
import { now } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { readEvents } from '../events.ts';
import {
  THRESHOLDS, decideTransition, eligibleForCiGate, markRecipe, markVerified, recordRunOutcome,
  retireRecipesForScreen, screensReferenced, shouldRecompile,
} from '../recipes/lifecycle.ts';
import { makeTempAppMapDir } from './helpers.ts';
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
