/**
 * [C1] observe.ts — observation ingest (02 §7, 03 §7, 04 §2, 05 §3), task association and
 * `name_screen` (03 §8). Every temp dir lives under os.tmpdir(); the repo's app-map/.local is
 * never touched (07 §2.4).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { HookPayload, Observation, ScrubbedTree } from '../types.ts';
import { REDACTED, UNKNOWN_SCREEN, isScrubbed, now } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { readEvents } from '../events.ts';
import { idsFile, trajectoryFile } from '../paths.ts';
import { buildScrubPolicy, scrub } from '../scrub.ts';
import { observedSignature } from '../signature.ts';
import { normalizeTree } from '../tree.ts';
import {
  declareTask, finishTask, hookPayloadToObservation, inferTaskOutcome, ingestObservation, isDriverTool, lastObservation,
  nameScreen, readTrajectory, recordHookPayload, recordObservation,
} from '../observe.ts';
import { loadFixtureTree, loadHookFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SESSION = 'sess_2026-09-10_0007';
const isCode = (code: string) => (e: unknown): boolean => AppMapError.is(e) && e.code === code;

let t: TempAppMapDir;
let ctx: AppMapContext;
// a fresh temp app-map per test: `.local/trajectories/*.jsonl` and `events.jsonl` are files, so
// an in-memory cache alone would not isolate them
beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
});
afterEach(() => { ctx.close(); t.cleanup(); });

/** a scrubbed snapshot of a committed fixture tree, as ingest would have produced it */
function scrubbedFixture(name: string): ScrubbedTree {
  return scrub(normalizeTree(loadFixtureTree(name), { platform: 'ios' }), buildScrubPolicy(ctx.map.ids, ctx.map.staticLabels));
}
function observation(over: Partial<Observation> & { seq: number }): Observation {
  const snapshot = over.snapshot === undefined ? scrubbedFixture('invoice_new') : over.snapshot;
  return {
    ts: now(), session: SESSION, tool: 'mcp__argent__tap', input: {}, screen_before: UNKNOWN_SCREEN,
    screen_after: 'invoice_new', signature_after: observedSignature(snapshot ?? scrubbedFixture('invoice_new')),
    gates_present: [], snapshot, ok: true, latency_ms: 0, ...over,
  };
}
function tapPayload(over: Partial<HookPayload> = {}): HookPayload {
  return { ...loadHookFixture('post-tool-use.tap'), ...over };
}

describe('isDriverTool — 05 §3 matcher', () => {
  it('matches `mcp__<driver>__*` only', () => {
    assert.equal(isDriverTool(t.config, 'mcp__argent__tap'), true);
    assert.equal(isDriverTool(t.config, 'mcp__argent__open_url'), true);
    assert.equal(isDriverTool(t.config, 'mcp__app-map__get_screen'), false);
    assert.equal(isDriverTool(t.config, 'Bash'), false);
    assert.equal(isDriverTool(t.config, undefined), false);
    assert.equal(isDriverTool({ driver: 'maestro' }, 'mcp__argent__tap'), false);
    assert.equal(isDriverTool({ driver: 'maestro' }, 'mcp__maestro__tap'), true);
  });
});

describe('recordHookPayload — fixtures/hooks/post-tool-use.tap.json (architecture §2.1)', () => {
  it('identifies the screen, resolves the element and returns the record result', () => {
    const result = recordHookPayload(ctx, tapPayload());
    assert.deepEqual(result, { screen_before: UNKNOWN_SCREEN, screen_after: 'invoice_new', seq: 1, gates_present: [], scrub_hits: 0 });
    const obs = ctx.db.lastObservation(SESSION)!;
    assert.equal(obs.element, 'invoice.add.button', 'input.id is a registered element (04 §2)');
    assert.equal(obs.tool, 'mcp__argent__tap');
    assert.equal(obs.confidence, 1, 'marker signal (03 §5.2)');
    assert.equal(obs.signature_after.marker, 'screen.invoice_new');
    assert.equal(obs.latency_ms, 420, 'structuredContent.latency_ms');
    assert.equal(obs.ok, true);
  });

  it('screen_before is the previous observation of this session (decision 15)', () => {
    recordHookPayload(ctx, tapPayload());
    const second = recordHookPayload(ctx, tapPayload({ tool_name: 'mcp__argent__tap', tool_input: { id: 'invoice.save.button' } }))!;
    assert.equal(second.screen_before, 'invoice_new');
    assert.equal(second.seq, 2);
    // another session's observations never leak into this one
    const other = recordHookPayload(ctx, tapPayload({ session_id: 'sess_other' }))!;
    assert.equal(other.screen_before, UNKNOWN_SCREEN);
    assert.equal(other.seq, 1);
  });

  it('writes ONE trajectory line per call, with a scrubbed snapshot and no raw text (03 §7, 07 §2)', () => {
    recordHookPayload(ctx, tapPayload());
    const file = trajectoryFile(t.config, SESSION);
    assert.ok(file.startsWith(t.dir), 'the trajectory lives in the temp app-map, never in the repo');
    const text = readFileSync(file, 'utf8');
    assert.equal(text.split('\n').filter((l) => l !== '').length, 1);
    const line = JSON.parse(text.trim()) as Observation;
    assert.equal(line.snapshot?.scrubbed, true);
    assert.ok(isScrubbed(line.snapshot!));
    // the raw fixture's status-bar clock is not static copy: the scrubber dropped it
    assert.ok(JSON.stringify(loadHookFixture('post-tool-use.tap').tool_response).includes('9:41'));
    assert.ok(!text.includes('9:41'), 'no raw label survives to disk');
    assert.ok(!/"value"\s*:/.test(text), 'field values never reach disk (07 §2.3.1)');
  });

  it('the trajectory line carries exactly the 02 §7 shape', () => {
    declareTask(ctx, SESSION, 'create an invoice');
    recordHookPayload(ctx, tapPayload());
    const line = JSON.parse(readFileSync(trajectoryFile(t.config, SESSION), 'utf8').trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(line).sort(), [
      'confidence', 'element', 'gates_present', 'input', 'latency_ms', 'ok', 'screen_after', 'screen_before',
      'scrub_hits', 'seq', 'session', 'signature_after', 'snapshot', 'task', 'tool', 'ts',
    ]);
    assert.match(String(line['ts']), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.deepEqual(Object.keys(line['signature_after'] as object).sort(), ['marker', 'required_present', 'structural_hash']);
  });

  it('refuses to persist an unscrubbed tree (03 §7, 07 §8)', () => {
    const obs = hookPayloadToObservation(ctx, tapPayload(), { seq: 1 });
    const raw = { ...(obs.snapshot as object), scrubbed: false } as unknown as ScrubbedTree;
    assert.throws(() => ingestObservation(ctx, { ...obs, snapshot: raw }), isCode(ERROR_CODES.BAD_INPUT));
    assert.equal(existsSync(trajectoryFile(t.config, SESSION)), false, 'nothing reached disk');
  });

  it('bumps the element hits counter, the screen seen counter and the session counters (08 §2)', () => {
    recordHookPayload(ctx, tapPayload());
    assert.equal(ctx.db.getCounters('element', 'invoice.add.button').hits, 1);
    assert.equal(ctx.db.getCounters('screen', 'invoice_new').seen, 1);
    const row = ctx.db.getSession(SESSION)!;
    assert.equal(row.driver_calls, 1);
    assert.ok(row.perception_bytes > 1000, 'perception_bytes counts the scrubbed tree');
    assert.equal(row.screenshots, 0);
    assert.ok(ctx.db.getScreenLastSeen('invoice_new') !== undefined);
  });

  it('counts a screenshot call as a screenshot (08 §2)', () => {
    recordHookPayload(ctx, tapPayload({ tool_name: 'mcp__argent__screenshot', tool_input: {} }));
    assert.equal(ctx.db.getSession(SESSION)!.screenshots, 1);
  });

  it('appends one identify event naming the winning signal (08 §2)', () => {
    recordHookPayload(ctx, tapPayload());
    const events = readEvents(t.config).events.filter((e) => e.kind === 'identify');
    assert.equal(events.length, 1);
    const e = events[0]!;
    assert.equal(e.kind, 'identify');
    if (e.kind !== 'identify') return;
    assert.deepEqual({ screen: e.screen, signal: e.signal, confidence: e.confidence, build: e.build }, { screen: 'invoice_new', signal: 'marker', confidence: 1, build: '4412' });
  });

  it('a failure payload is recorded with ok:false, the error text and a misses bump', () => {
    const result = recordHookPayload(ctx, loadHookFixture('post-tool-use-failure.tap'));
    assert.ok(result);
    assert.equal(result!.screen_after, UNKNOWN_SCREEN, 'no tool_response → no snapshot → unknown');
    const obs = ctx.db.lastObservation(SESSION)!;
    assert.equal(obs.ok, false);
    assert.equal(obs.error, 'element not found: invoice.send.button');
    assert.equal(obs.snapshot, null);
    assert.deepEqual(obs.signature_after, { marker: 'none', structural_hash: 'none', required_present: 0 });
    assert.equal(ctx.db.getCounters('element', 'invoice.send.button').misses, 1);
  });

  it('a driver response that reports ok:false is recorded as a failure too', () => {
    const payload = tapPayload();
    (payload.tool_response as { structuredContent: Record<string, unknown> }).structuredContent.ok = false;
    recordHookPayload(ctx, payload);
    assert.equal(ctx.db.lastObservation(SESSION)!.ok, false);
  });

  it('a non-driver tool records nothing and returns null (05 §3: never block the agent)', () => {
    assert.equal(recordHookPayload(ctx, tapPayload({ tool_name: 'Bash', tool_input: { command: 'ls' } })), null);
    assert.equal(recordHookPayload(ctx, { session_id: SESSION, hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__app-map__run_recipe', error: 'boom' }), null);
    assert.equal(recordHookPayload(ctx, loadHookFixture('session-start')), null);
    assert.equal(ctx.db.lastObservation(SESSION), undefined);
    assert.equal(existsSync(trajectoryFile(t.config, SESSION)), false);
  });

  it('a payload without session_id or tool_name is bad_input, not a crash (03 §11)', () => {
    assert.throws(() => recordHookPayload(ctx, { hook_event_name: 'PostToolUse', tool_name: 'mcp__argent__tap' } as unknown as HookPayload), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => hookPayloadToObservation(ctx, { session_id: SESSION, hook_event_name: 'PostToolUse' }), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('a tool_response with a broken tree is recorded without a snapshot rather than throwing', () => {
    const obs = hookPayloadToObservation(ctx, tapPayload({ tool_response: { structuredContent: { snapshot: { root: 42 } } } }), { seq: 1 });
    assert.equal(obs.snapshot, null);
    assert.equal(obs.screen_after, UNKNOWN_SCREEN);
  });
});

describe('element resolution — 04 §2 step 4', () => {
  it('an unregistered input.id does not become the element', () => {
    recordHookPayload(ctx, tapPayload({ tool_input: { id: 'not.a.registered.id' } }));
    assert.equal(ctx.db.lastObservation(SESSION)!.element, undefined);
  });

  it('a tap by TEXT resolves against the previous snapshot (best effort)', () => {
    // first land on invoice_list, then tap its "New Invoice" button by label
    recordObservation(ctx, { session: SESSION, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_list' }, snapshot: loadFixtureTree('invoice_list'), ok: true });
    recordHookPayload(ctx, tapPayload({ tool_input: { text: 'New Invoice' } }));
    assert.equal(ctx.db.lastObservation(SESSION)!.element, 'invoice.add.button');
  });

  it('a tap by POINT resolves against the previous snapshot', () => {
    recordObservation(ctx, { session: SESSION, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_list' }, snapshot: loadFixtureTree('invoice_list'), ok: true });
    const add = ctx.map.screens.get('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    const geo = add.locators.find((l) => l.strategy === 'geometry')!;
    const { x, y } = geo.value as { x: number; y: number };
    recordHookPayload(ctx, tapPayload({ tool_input: { x: Math.round(x * 390), y: Math.round(y * 844) } }));
    assert.equal(ctx.db.lastObservation(SESSION)!.element, 'invoice.add.button');
  });

  it('a tap by text on a data row is attributed to the screen\'s single dynamic cell (04 §3.3)', () => {
    recordObservation(ctx, { session: SESSION, tool: 'mcp__argent__open_url', input: { url: 'appmap://client_picker' }, snapshot: loadFixtureTree('client_picker'), ok: true });
    // the scrubber dropped the row text, so no node carries "Acme Corp" (07 §2.3)
    recordHookPayload(ctx, tapPayload({ tool_input: { text: 'Acme Corp' } }));
    assert.equal(ctx.db.lastObservation(SESSION)!.element, 'client.picker.cell');
  });
});

describe('build auto-detection — 03 §3', () => {
  it('a driver-reported build_number becomes the effective build when APP_MAP_BUILD=auto', () => {
    const payload = tapPayload();
    // the Argent wrapper carries `build_number` next to `root` (tree.ts fromArgentSnapshot)
    ((payload.tool_response as { structuredContent: { snapshot: Record<string, unknown> } }).structuredContent.snapshot)['build_number'] = '4500';
    assert.equal(ctx.config.build, 'auto');
    recordHookPayload(ctx, payload);
    assert.equal(ctx.build, '4500');
    assert.equal(ctx.db.getMeta('build'), '4500');
  });

  it('an explicit APP_MAP_BUILD is never overridden by the driver', () => {
    const fixed = makeTempAppMapDir({ env: { APP_MAP_BUILD: '4412' } });
    const c = openContext(fixed.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      const payload = tapPayload();
      ((payload.tool_response as { structuredContent: { snapshot: Record<string, unknown> } }).structuredContent.snapshot)['build_number'] = '4500';
      recordHookPayload(c, payload);
      assert.equal(c.build, '4412');
    } finally {
      c.close();
      fixed.cleanup();
    }
  });
});

describe('PII sweep on the two strings that survive (architecture §7 decision 13)', () => {
  it('a typed card number is stored as [redacted] in the trajectory, the cache and the task event', () => {
    declareTask(ctx, SESSION, 'pay with card 4111 1111 1111 1111');
    recordHookPayload(ctx, tapPayload({ tool_name: 'mcp__argent__type_text', tool_input: { text: '4111 1111 1111 1111' } }));
    const obs = ctx.db.lastObservation(SESSION)!;
    assert.equal(obs.input.text, REDACTED);
    assert.equal(obs.task, REDACTED);
    assert.ok(!readFileSync(trajectoryFile(t.config, SESSION), 'utf8').includes('4111'));
    finishTask(ctx, SESSION, { ok: true, mode_end: 'explore' });
    const task = readEvents(t.config).events.find((e) => e.kind === 'task')!;
    assert.equal(task.kind === 'task' && task.task, REDACTED);
  });

  it('an ordinary typed value is kept so the compiler can match it against a param (04 §3.4)', () => {
    recordHookPayload(ctx, tapPayload({ tool_name: 'mcp__argent__type_text', tool_input: { text: '50' } }));
    assert.equal(ctx.db.lastObservation(SESSION)!.input.text, '50');
  });

  it('the deny list is the 07 §2.3.4 one: a currency amount in the task redacts the whole string', () => {
    // `compile_recipe` reads the task from its own input, so the compiler is unaffected (04 §3.4)
    declareTask(ctx, SESSION, 'create an invoice for $50 for Acme Corp');
    assert.equal(ctx.db.getSession(SESSION)!.task, REDACTED);
  });
});

describe('lazy re-verify — 02 §8 / 08 §5 row 5 (step 8)', () => {
  it('marker + all required ids + matching hash stamps the new build on the screen', () => {
    const t2 = makeTempAppMapDir({ env: { APP_MAP_BUILD: '4413' } });
    const c2 = openContext(t2.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(c2.map.screens.get('invoice_new')!.meta.last_verified_build, '4412');
      recordHookPayload(c2, tapPayload());
      assert.equal(c2.db.getScreen('invoice_new')!.meta.last_verified_build, '4413');
      assert.ok(c2.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'invoice_new' && d.reason === 'verify'));
    } finally {
      c2.close();
      t2.cleanup();
    }
  });

  it('does not re-verify when a required id is missing (required_present < 1)', () => {
    const t2 = makeTempAppMapDir({ env: { APP_MAP_BUILD: '4413' } });
    const c2 = openContext(t2.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      const screen = structuredClone(c2.map.screens.get('invoice_new')!);
      screen.signature.required_ids = [...(screen.signature.required_ids ?? []), 'invoice.filter.button'];
      c2.db.putScreen(screen, { dirty: false });
      recordHookPayload(c2, tapPayload());
      assert.equal(c2.db.getScreen('invoice_new')!.meta.last_verified_build, '4412');
    } finally {
      c2.close();
      t2.cleanup();
    }
  });

  it('does not re-verify when the structural hash no longer matches', () => {
    const t2 = makeTempAppMapDir({ env: { APP_MAP_BUILD: '4413' } });
    const c2 = openContext(t2.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      const screen = structuredClone(c2.map.screens.get('invoice_new')!);
      screen.signature.structural_hash = 'sha1:0000000000000000000000000000000000000000';
      screen.variants = [];
      c2.db.putScreen(screen, { dirty: false });
      recordHookPayload(c2, tapPayload());
      assert.equal(c2.db.getScreen('invoice_new')!.meta.last_verified_build, '4412');
    } finally {
      c2.close();
      t2.cleanup();
    }
  });
});

describe('record_observation tool (03 §8)', () => {
  it('takes the snapshot explicitly and defaults the session to `tool`', () => {
    const r = recordObservation(ctx, { tool: 'mcp__argent__tap', input: { id: 'invoice.add.button' }, snapshot: loadFixtureTree('invoice_new'), ok: true, latency_ms: 12 });
    assert.equal(r.screen_after, 'invoice_new');
    const obs = ctx.db.lastObservation('tool')!;
    assert.equal(obs.session, 'tool');
    assert.equal(obs.latency_ms, 12);
    assert.equal(lastObservation(ctx, 'tool')?.seq, 1);
    assert.equal(lastObservation(ctx)?.session, 'tool', 'the unscoped form is the newest across sessions');
  });

  it('ok:false is recorded as a failure', () => {
    recordObservation(ctx, { session: SESSION, tool: 'mcp__argent__tap', input: { id: 'invoice.add.button' }, snapshot: loadFixtureTree('invoice_new'), ok: false, error: 'nope' });
    assert.equal(ctx.db.lastObservation(SESSION)!.ok, false);
  });

  it('a missing tool name is bad_input', () => {
    assert.throws(() => recordObservation(ctx, { tool: '', input: {}, snapshot: null, ok: true }), isCode(ERROR_CODES.BAD_INPUT));
  });
});

describe('task association — declareTask / finishTask / Stop (04 §2, 08 §2, decision 31)', () => {
  it('declareTask records the task, task_seq and mode', () => {
    declareTask(ctx, SESSION, 'create an invoice for Acme Corp');
    const row = ctx.db.getSession(SESSION)!;
    assert.equal(row.task, 'create an invoice for Acme Corp');
    assert.equal(row.task_seq, 1, 'the first observation of the task');
    assert.equal(row.mode, 'explore');
    assert.equal(row.task_end_seq, undefined);
  });

  it('re-declaring the same task is a no-op; a different one closes the open task with ok:false', () => {
    declareTask(ctx, SESSION, 'first task');
    recordHookPayload(ctx, tapPayload());
    declareTask(ctx, SESSION, 'first task');
    assert.equal(ctx.db.getSession(SESSION)!.task_seq, 1, 'task_seq is not moved by a repeat');
    assert.equal(readEvents(t.config).events.filter((e) => e.kind === 'task').length, 0);

    declareTask(ctx, SESSION, 'second task');
    const closed = readEvents(t.config).events.filter((e) => e.kind === 'task');
    assert.equal(closed.length, 1);
    const first = closed[0]!;
    assert.equal(first.kind === 'task' && first.ok, false);
    const row = ctx.db.getSession(SESSION)!;
    assert.equal(row.task, 'second task');
    assert.equal(row.task_seq, 2);
    assert.equal(row.task_end_seq, undefined, 'the new task is open again');
  });

  it('the Stop hook closes the task, emits the counters and stores task_end_seq', () => {
    declareTask(ctx, SESSION, 'create an invoice', 'explore');
    recordHookPayload(ctx, tapPayload());
    recordHookPayload(ctx, tapPayload({ tool_name: 'mcp__argent__screenshot', tool_input: {} }));
    assert.equal(recordHookPayload(ctx, loadHookFixture('stop')), null);

    const task = readEvents(t.config).events.find((e) => e.kind === 'task')!;
    assert.equal(task.kind, 'task');
    if (task.kind !== 'task') return;
    assert.equal(task.session, SESSION);
    assert.equal(task.task, 'create an invoice');
    assert.equal(task.ok, true);
    assert.equal(task.mode_start, 'explore');
    assert.equal(task.mode_end, 'explore');
    assert.equal(task.driver_calls, 2);
    assert.equal(task.screenshots, 1);
    assert.ok(task.perception_bytes > 0);
    assert.equal(task.build, '4412');

    const row = ctx.db.getSession(SESSION)!;
    assert.equal(row.task_end_seq, 2, 'the compiler default slice end (04 §3.1)');
    assert.deepEqual({ d: row.driver_calls, p: row.perception_bytes, s: row.screenshots }, { d: 0, p: 0, s: 0 }, 'counters reset');
  });

  it('a second Stop, or a Stop without a task, changes nothing', () => {
    assert.equal(recordHookPayload(ctx, loadHookFixture('stop')), null);
    assert.equal(readEvents(t.config).events.filter((e) => e.kind === 'task').length, 0);
    declareTask(ctx, SESSION, 'a task');
    recordHookPayload(ctx, loadHookFixture('stop'));
    recordHookPayload(ctx, loadHookFixture('stop'));
    assert.equal(readEvents(t.config).events.filter((e) => e.kind === 'task').length, 1);
  });

  it('inferTaskOutcome: ok when the last observation was ok and no run of the session fell back', () => {
    assert.deepEqual(inferTaskOutcome(ctx, SESSION), { ok: false, mode_end: 'explore' }, 'no observation at all is not a success');
    recordHookPayload(ctx, tapPayload());
    assert.deepEqual(inferTaskOutcome(ctx, SESSION), { ok: true, mode_end: 'explore' });

    ctx.db.insertRun({
      run_id: 'run_1', recipe: 'create_invoice', version: 3, mode: 'guided', session: SESSION, params: {},
      state: 'fallback', current_step: 's3', step_index: 2, heals: [], fallbacks: 1, started_at: now(),
      build: ctx.build, start_seq: 0, last_seq: 1,
    });
    assert.deepEqual(inferTaskOutcome(ctx, SESSION), { ok: false, mode_end: 'guided' }, 'a guided fallback is not a success');
  });

  it('declareTask rejects an empty session or task (03 §11)', () => {
    assert.throws(() => declareTask(ctx, '', 'x'), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => declareTask(ctx, SESSION, '   '), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('finishTask on a session with no task is a no-op', () => {
    finishTask(ctx, 'never_seen', { ok: true, mode_end: 'guided' });
    assert.equal(readEvents(t.config).events.filter((e) => e.kind === 'task').length, 0);
  });
});

describe('name_screen (03 §8) — explore mode only', () => {
  /** the pilot map plus an extra registered-but-unnamed screen, so `created: true` has a case */
  function withExtraScreen(): { temp: TempAppMapDir; ctx: AppMapContext } {
    const temp = makeTempAppMapDir();
    const ids = readFileSync(idsFile(temp.config), 'utf8').replace(
      '  - id: invoice_detail\n',
      '  - id: invoice_archive\n    title: Archive\n    deep_link: appmap://invoice_archive\n  - id: invoice_detail\n',
    );
    writeFileSync(idsFile(temp.config), ids);
    return { temp, ctx: openContext(temp.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' }) };
  }

  it('builds a candidate screen from the last unknown observation with registered elements only', () => {
    const { temp, ctx: c } = withExtraScreen();
    try {
      const snapshot = scrub(normalizeTree(loadFixtureTree('invoice_list'), { platform: 'ios' }), buildScrubPolicy(c.map.ids, c.map.staticLabels));
      c.db.insertObservation({
        ts: now(), session: SESSION, seq: 1, tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_archive' },
        screen_before: UNKNOWN_SCREEN, screen_after: UNKNOWN_SCREEN, signature_after: observedSignature(snapshot),
        gates_present: [], snapshot, ok: true, latency_ms: 0,
      });
      const r = nameScreen(c, { screen_id: 'invoice_archive', session: SESSION });
      assert.equal(r.created, true);
      assert.equal(r.from_seq, 1);
      assert.equal(r.screen.kind, 'screen');
      assert.equal(r.screen.title, 'Archive');
      assert.equal(r.screen.deep_link, 'appmap://invoice_archive', 'from ids.yaml');
      assert.equal(r.screen.meta.status, 'candidate');
      assert.deepEqual(r.screen.meta.sources, ['exploration']);
      assert.equal(r.screen.meta.last_verified_build, undefined, '02 §8: set at verification only');
      assert.deepEqual(r.screen.edges, []);
      assert.equal(r.screen.signature.marker, 'none', 'the app carries no screen.invoice_archive marker yet');
      assert.equal(r.screen.signature.route, 'appmap://invoice_archive');
      assert.ok(String(r.screen.signature.structural_hash).startsWith('sha1:'));

      // only registered ids become elements; markers never do (01 R3)
      assert.ok(r.elements.length > 0);
      assert.ok(r.elements.every((id) => c.map.elementRegistry.has(id)));
      assert.ok(!r.elements.some((id) => id.startsWith('screen.')));
      assert.deepEqual(r.elements, [...r.elements].sort());

      const add = r.screen.elements.find((e) => e.id === 'invoice.add.button')!;
      assert.equal(add.status, 'candidate');
      assert.equal(add.role, 'button');
      assert.equal(add.label, 'New Invoice');
      assert.deepEqual(add.locators.map((l) => l.strategy), ['a11y_id', 'role_label', 'path', 'geometry']);
      assert.deepEqual(add.locators.map((l) => l.weight), [1, 0.6, 0.25, 0.1]);
      assert.equal(add.fingerprint?.label_norm, 'new invoice');
      // dynamic elements keep no label and land in dynamic_regions / never in required_ids
      const cell = r.screen.elements.find((e) => e.id === 'invoice.list.cell')!;
      assert.equal(cell.dynamic, true);
      assert.equal(cell.label, undefined);
      assert.ok(r.screen.dynamic_regions?.includes('invoice.list.cell'));
      assert.ok(!r.screen.signature.required_ids?.includes('invoice.list.cell'));
      assert.ok(r.screen.signature.required_ids?.includes('invoice.add.button'));

      assert.ok(c.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'invoice_archive' && d.reason === 'name_screen'));
    } finally {
      c.close();
      temp.cleanup();
    }
  });

  it('naming the same candidate again merges elements (created: false)', () => {
    const { temp, ctx: c } = withExtraScreen();
    try {
      const first = scrub(normalizeTree(loadFixtureTree('invoice_list'), { platform: 'ios' }), buildScrubPolicy(c.map.ids, c.map.staticLabels));
      c.db.insertObservation({ ts: now(), session: SESSION, seq: 1, tool: 'mcp__argent__tap', input: {}, screen_before: UNKNOWN_SCREEN, screen_after: UNKNOWN_SCREEN, signature_after: observedSignature(first), gates_present: [], snapshot: first, ok: true, latency_ms: 0 });
      const a = nameScreen(c, { screen_id: 'invoice_archive', session: SESSION });

      const second = scrub(normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' }), buildScrubPolicy(c.map.ids, c.map.staticLabels));
      c.db.insertObservation({ ts: now(), session: SESSION, seq: 2, tool: 'mcp__argent__tap', input: {}, screen_before: UNKNOWN_SCREEN, screen_after: UNKNOWN_SCREEN, signature_after: observedSignature(second), gates_present: [], snapshot: second, ok: true, latency_ms: 0 });
      const b = nameScreen(c, { screen_id: 'invoice_archive', session: SESSION });
      assert.equal(b.created, false);
      assert.ok(b.screen.elements.some((e) => e.id === 'invoice.add.button'), 'the first naming survives');
      assert.ok(b.screen.elements.some((e) => e.id === 'invoice.amount.field'), 'the second adds to it');
      assert.ok(b.screen.elements.length > a.screen.elements.length);
    } finally {
      c.close();
      temp.cleanup();
    }
  });

  it('refuses an unregistered screen id (invalid_map) and a verified screen (bad_input)', () => {
    const snapshot = scrubbedFixture('invoice_new');
    ctx.db.insertObservation(observation({ seq: 1, screen_after: UNKNOWN_SCREEN, snapshot }));
    assert.throws(() => nameScreen(ctx, { screen_id: 'not_registered', session: SESSION }), isCode(ERROR_CODES.INVALID_MAP));
    assert.throws(() => nameScreen(ctx, { screen_id: 'invoice_new', session: SESSION }), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('refuses to rename a screen the map already identifies, and needs an observation with a snapshot', () => {
    assert.throws(() => nameScreen(ctx, { screen_id: 'invoice_new', session: SESSION }), isCode(ERROR_CODES.NO_OBSERVATION));
    ctx.db.insertObservation(observation({ seq: 1, screen_after: 'invoice_new' }));
    assert.throws(() => nameScreen(ctx, { screen_id: 'login', session: SESSION }), isCode(ERROR_CODES.BAD_INPUT));
    ctx.db.insertObservation(observation({ seq: 2, screen_after: UNKNOWN_SCREEN, snapshot: null }));
    assert.throws(() => nameScreen(ctx, { screen_id: 'login', session: SESSION }), isCode(ERROR_CODES.NO_OBSERVATION));
  });

  it('refuses a deep_link that disagrees with ids.yaml, and is explore mode only', () => {
    ctx.db.insertObservation(observation({ seq: 1, screen_after: UNKNOWN_SCREEN }));
    assert.throws(() => nameScreen(ctx, { screen_id: 'login', deep_link: 'appmap://elsewhere', session: SESSION }), isCode(ERROR_CODES.BAD_INPUT));
    ctx.db.upsertSession({ session: SESSION, mode: 'guided' });
    assert.throws(() => nameScreen(ctx, { screen_id: 'login', session: SESSION }), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('a missing screen_id is bad_input', () => {
    assert.throws(() => nameScreen(ctx, { screen_id: '' }), isCode(ERROR_CODES.BAD_INPUT));
  });
});

describe('readTrajectory — compile input (02 §7)', () => {
  it('reads back what ingest wrote, in seq order', () => {
    recordHookPayload(ctx, tapPayload());
    recordHookPayload(ctx, tapPayload({ tool_input: { id: 'invoice.save.button' } }));
    const back = readTrajectory(t.config, SESSION);
    assert.deepEqual(back.map((o) => o.seq), [1, 2]);
    assert.equal(back[0]!.element, 'invoice.add.button');
    assert.equal(back[1]!.element, 'invoice.save.button');
  });

  it('tolerates a truncated last line and an absent file', () => {
    recordHookPayload(ctx, tapPayload());
    const file = trajectoryFile(t.config, SESSION);
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"ts":"2026-09-10T17:0`);
    assert.equal(readTrajectory(t.config, SESSION).length, 1);
    assert.deepEqual(readTrajectory(t.config, 'no_such_session'), []);
    assert.throws(() => readTrajectory(t.config, ''), isCode(ERROR_CODES.BAD_INPUT));
  });
});
