/**
 * [A2] store/db.ts — SQLite cache (02 §7, 03 §4, 03 §2 WAL + short transactions, 03 §12 WAL
 * stress acceptance criterion, 07 §8 scrubbed-only writes).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { cacheFile } from '../paths.ts';
import { AppMapDb, DB_BUSY_TIMEOUT_MS, DB_SCHEMA_VERSION, DDL, openDb } from '../store/db.ts';
import type { ElementDef, Observation, RunRecord, RunStepRecord, ScreenFile } from '../types.ts';
import { now, stepElement } from '../types.ts';
import { loadMap } from '../yaml/load.ts';
import { PACKAGE_ROOT, loadTrajectoryFixture, makeTempAppMapDir } from './helpers.ts';

function obs(session: string, seq: number, extra: Partial<Observation> = {}): Observation {
  return {
    ts: now(),
    session,
    seq,
    tool: 'mcp__argent__tap',
    input: { id: 'invoice.add.button' },
    element: 'invoice.add.button',
    screen_before: 'invoice_list',
    screen_after: 'invoice_new',
    signature_after: { marker: 'screen.invoice_new', structural_hash: `sha1:${'0'.repeat(40)}`, required_present: 1 },
    snapshot: null,
    ok: true,
    latency_ms: 12,
    ...extra,
  };
}

function run(runId: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    run_id: runId,
    recipe: 'create_invoice',
    version: 1,
    mode: 'guided',
    session: 'sess_a',
    params: { amount: 50, client: 'Acme Corp' },
    state: 'active',
    current_step: 's0',
    step_index: -1,
    heals: [],
    fallbacks: 0,
    started_at: now(),
    build: '4412',
    start_seq: 0,
    last_seq: 0,
    ...extra,
  };
}

describe('AppMapDb.open (03 §2, architecture §5)', () => {
  it('creates .local/cache.sqlite in WAL mode with every table of the DDL', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config);
      assert.equal(db.path, cacheFile(t.config));
      assert.ok(existsSync(db.path));
      assert.equal(db.getMeta('schema_version'), String(DB_SCHEMA_VERSION));
      db.setMeta('build', '4412');
      // a second raw connection sees WAL mode and the tables (WAL is persistent in the file header)
      const raw = new DatabaseSync(db.path);
      const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
      assert.equal(mode.journal_mode, 'wal');
      assert.equal(DB_BUSY_TIMEOUT_MS, 2000); // architecture §5: writers wait 2 s for a lock held by another instance
      const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
      for (const name of ['meta', 'screens', 'elements', 'recipes', 'registry', 'runs', 'run_steps', 'observations', 'sessions', 'counters', 'dirty']) {
        assert.ok(tables.includes(name), `table ${name} missing`);
        assert.match(DDL, new RegExp(`CREATE TABLE IF NOT EXISTS ${name} `));
      }
      raw.close();
      db.close();
      db.close(); // idempotent
    } finally {
      t.cleanup();
    }
  });

  it('opens :memory: and openDb() is the same constructor', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = openDb(t.config, { path: ':memory:' });
      db.setMeta('x', '1');
      assert.equal(db.getMeta('x'), '1');
      assert.equal(db.getMeta('missing'), undefined);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('readOnly refuses a missing cache with `storage` and otherwise refuses writes', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      assert.throws(() => AppMapDb.open(t.config, { readOnly: true }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
      const rw = AppMapDb.open(t.config);
      rw.setMeta('build', '4412');
      rw.close();
      const ro = AppMapDb.open(t.config, { readOnly: true });
      assert.equal(ro.getMeta('build'), '4412');
      assert.throws(() => ro.setMeta('build', '1'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
      ro.close();
    } finally {
      t.cleanup();
    }
  });

  it('drops and recreates the cache when meta.schema_version differs (02 §7 regenerable)', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config);
      db.bumpCounter('screen', 'login', 'seen');
      db.close();
      const raw = new DatabaseSync(cacheFile(t.config));
      raw.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
      raw.close();
      const again = AppMapDb.open(t.config);
      assert.equal(again.getMeta('schema_version'), String(DB_SCHEMA_VERSION));
      assert.deepEqual(again.getCounters('screen', 'login'), {}); // wiped
      again.close();
    } finally {
      t.cleanup();
    }
  });

  it('wraps SQLite failures as AppMapError(storage) and rolls back a failed transaction', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config, { path: ':memory:' });
      assert.throws(() => db.transaction(() => {
        db.setMeta('a', '1');
        db.transaction(() => db.setMeta('b', '2')); // nested joins the outer transaction
        throw new Error('boom');
      }), /boom/);
      assert.equal(db.getMeta('a'), undefined);
      assert.equal(db.getMeta('b'), undefined);
      assert.equal(db.transaction(() => { db.setMeta('c', '3'); return 42; }), 42);
      assert.equal(db.getMeta('c'), '3');
      db.close();
      assert.throws(() => db.getMeta('c'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
    } finally {
      t.cleanup();
    }
  });
});

describe('AppMapDb map rows (03 §4 load / write path)', () => {
  it('upsertMap populates screens, gates, elements, recipes, registry and blob shas from map.files', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const db = AppMapDb.open(t.config);
      db.upsertMap(map);
      const screens = db.listScreens();
      assert.equal(screens.length, map.screens.size + map.gates.size);
      assert.deepEqual(db.getScreen('invoice_list'), map.screens.get('invoice_list'));
      assert.deepEqual(db.getScreen('gate.push_permission'), map.gates.get('gate.push_permission'));
      assert.equal(db.getScreen('nope'), undefined);
      assert.deepEqual(db.getRecipe('create_invoice'), map.recipes.get('create_invoice'));
      assert.deepEqual(db.listRecipes().map((r) => r.id), [...map.recipes.keys()].sort());
      assert.deepEqual(db.listRecipes({ statuses: ['retired'] }), []);
      assert.deepEqual(db.getIds(), map.ids);
      assert.deepEqual(db.getManifest(), map.manifest);
      assert.equal(db.getBlobSha('screen', 'invoice_list'), map.files.get('ios/screens/invoice_list.yaml')?.blob_sha);
      assert.equal(db.getBlobSha('recipe', 'create_invoice'), map.files.get('ios/recipes/create_invoice.yaml')?.blob_sha);
      assert.equal(db.getBlobSha('ids', 'ids'), map.files.get('ids.yaml')?.blob_sha);
      assert.equal(db.getBlobSha('manifest', 'manifest'), map.files.get('ios/manifest.yaml')?.blob_sha);
      assert.ok(db.getBlobSha('screen', 'invoice_list'));
      assert.equal(db.getMeta('loaded_at'), map.loadedAt);
      assert.equal(db.getMeta('platform'), 'ios');
      assert.deepEqual(db.listDirty(), []);
      assert.deepEqual(db.listPendingHeals(), []);
      // elements are denormalized per screen
      const raw = new DatabaseSync(db.path);
      const n = raw.prepare("SELECT count(*) AS n FROM elements WHERE screen_id = 'invoice_list'").get() as { n: number };
      assert.equal(n.n, map.screens.get('invoice_list')?.elements.length);
      raw.close();
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('reopen persists rows and meta', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const db = AppMapDb.open(t.config);
      db.upsertMap(map);
      db.setMeta('build', '4413');
      db.close();
      const again = AppMapDb.open(t.config);
      assert.equal(again.listScreens().length, map.screens.size + map.gates.size);
      assert.equal(again.getMeta('build'), '4413');
      again.close();
    } finally {
      t.cleanup();
    }
  });

  it('putElement marks the screen dirty with a reason; upsertMap preserves dirty rows and counters', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const db = AppMapDb.open(t.config);
      db.upsertMap(map);
      const screen = db.getScreen('invoice_list') as ScreenFile;
      const el = screen.elements.find((e) => e.id === 'invoice.add.button') as ElementDef;
      const healed: ElementDef = { ...el, status: 'healed_pending_review', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'Create Invoice' }, weight: 0.6 }] };
      db.putElement('invoice_list', healed, { reason: 'heal' });
      db.bumpCounter('element', 'invoice.add.button', 'heals');
      db.bumpCounter('element', 'invoice.add.button', 'hits', 3);
      db.bumpCounter('element', 'invoice.add.button', 'hits');
      assert.deepEqual(db.getCounters('element', 'invoice.add.button'), { heals: 1, hits: 4 });

      const dirty = db.listDirty();
      assert.equal(dirty.length, 1);
      assert.equal(dirty[0]?.kind, 'screen');
      assert.equal(dirty[0]?.key, 'invoice_list');
      assert.equal(dirty[0]?.reason, 'heal');
      assert.match(dirty[0]?.ts ?? '', /^\d{4}-\d{2}-\d{2}T/);
      assert.deepEqual(db.listPendingHeals(), [{ screen: 'invoice_list', element: 'invoice.add.button' }]);
      assert.equal(db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'healed_pending_review');
      // the sha it was edited on top of stays (export must still detect a concurrent change, 03 §4)
      const shaBefore = db.getBlobSha('screen', 'invoice_list');

      db.upsertMap(loadMap(t.config)); // a reload must not clobber the session's edit
      assert.equal(db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'healed_pending_review');
      assert.equal(db.listDirty().length, 1);
      assert.deepEqual(db.getCounters('element', 'invoice.add.button'), { heals: 1, hits: 4 });
      assert.equal(db.getBlobSha('screen', 'invoice_list'), shaBefore);
      // but non-dirty rows are replaced from disk
      assert.deepEqual(db.getScreen('login'), map.screens.get('login'));

      db.clearDirty('screen', 'invoice_list');
      assert.deepEqual(db.listDirty(), []);
      db.upsertMap(loadMap(t.config)); // now the reload wins
      assert.equal(db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'verified');
      assert.throws(() => db.putElement('nope', healed, { reason: 'heal' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('putScreen (new screen) / putRecipe / putIds / putManifest mark dirty; deleteScreen removes rows; upsertMap drops screens gone from disk', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const db = AppMapDb.open(t.config);
      db.upsertMap(map);
      const login = map.screens.get('login') as ScreenFile;
      const fresh: ScreenFile = { ...login, id: 'settings', title: 'Settings', deep_link: 'appmap://settings', signature: { ...login.signature, marker: 'screen.settings' }, elements: [], edges: [], meta: { sources: ['exploration'], status: 'candidate' } };
      db.putScreen(fresh, { dirty: true, reason: 'name_screen' });
      assert.equal(db.getBlobSha('screen', 'settings'), undefined); // never loaded from disk
      const recipe = map.recipes.get('create_invoice')!;
      db.putRecipe({ ...recipe, status: 'verified' }, { dirty: true, reason: 'mark_recipe' });
      db.putIds({ ...map.ids, screens: [...map.ids.screens, { id: 'settings', title: 'Settings', deep_link: 'appmap://settings' }] }, { dirty: true, reason: 'import_router' });
      db.putManifest({ ...map.manifest, build: { ...map.manifest.build, build_number: '4413' } }, { dirty: true, reason: 'import_router' });
      assert.deepEqual(db.listDirty().map((d) => `${d.kind}:${d.key}:${d.reason}`).sort(), [
        'ids:ids:import_router', 'manifest:manifest:import_router', 'recipe:create_invoice:mark_recipe', 'screen:settings:name_screen',
      ]);
      assert.equal(db.getRecipe('create_invoice')?.status, 'verified');
      assert.equal(db.getIds()?.screens.some((s) => s.id === 'settings'), true);
      assert.equal(db.getManifest()?.build.build_number, '4413');
      // a dirty put with dirty:false does not clear the flag (the flag is cleared by export only)
      db.putRecipe({ ...recipe, status: 'ci_gate' }, { dirty: false });
      assert.equal(db.listDirty().some((d) => d.kind === 'recipe'), true);
      // reload keeps every dirty entity (incl. the unregistered new screen)
      db.upsertMap(loadMap(t.config));
      assert.ok(db.getScreen('settings'));
      assert.equal(db.getRecipe('create_invoice')?.status, 'ci_gate');
      assert.equal(db.getManifest()?.build.build_number, '4413');
      db.clearDirty('screen', 'settings');
      db.upsertMap(loadMap(t.config)); // no longer dirty and not on disk → dropped
      assert.equal(db.getScreen('settings'), undefined);
      db.deleteScreen('login');
      assert.equal(db.getScreen('login'), undefined);
      const raw = new DatabaseSync(db.path);
      assert.equal((raw.prepare("SELECT count(*) AS n FROM elements WHERE screen_id = 'login'").get() as { n: number }).n, 0);
      raw.close();
      db.setScreenLastSeen('invoice_list', '2026-09-11T00:00:00Z');
      assert.equal(db.getScreenLastSeen('invoice_list'), '2026-09-11T00:00:00Z');
      db.setBlobSha('recipe', 'create_invoice', 'abc');
      assert.equal(db.getBlobSha('recipe', 'create_invoice'), 'abc');
      db.close();
    } finally {
      t.cleanup();
    }
  });
});

describe('AppMapDb sessions & observations (02 §7, 04 §2, 07 §8)', () => {
  it('rejects an unscrubbed snapshot with bad_input and stores the fixture trajectory', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config, { path: ':memory:' });
      const raw = obs('s1', 1, { snapshot: { schema_version: 1, platform: 'ios', source: 'argent', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [] } } as unknown as Observation['snapshot'] });
      assert.throws(() => db.insertObservation(raw), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      assert.throws(() => db.insertObservation({ ...obs('s1', 0) }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      assert.throws(() => db.insertObservation({ ...obs('', 1) }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      assert.equal(db.lastObservation(), undefined);

      const trajectory = loadTrajectoryFixture('create_invoice.session');
      for (const o of trajectory) db.insertObservation(o);
      const session = trajectory[0]!.session;
      const listed = db.listObservations(session);
      assert.deepEqual(listed, trajectory);
      assert.deepEqual(db.listObservations(session, { fromSeq: 3, toSeq: 4 }).map((o) => o.seq), [3, 4]);
      assert.deepEqual(db.lastObservation(session), trajectory[trajectory.length - 1]);
      assert.deepEqual(db.lastObservation(), trajectory[trajectory.length - 1]);
      assert.equal(db.getSession(session)?.last_seq, trajectory.length);
      assert.equal(db.nextSeq(session), trajectory.length + 1); // monotonic after explicit seqs
      assert.equal(db.nextSeq(session), trajectory.length + 2);
      assert.equal(db.nextSeq('brand_new'), 1);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('upsertSession creates then merges fields', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config, { path: ':memory:' });
      const created = db.upsertSession({ session: 's1' });
      assert.equal(created.mode, 'explore');
      assert.equal(created.last_seq, 0);
      assert.equal(created.task, undefined);
      const merged = db.upsertSession({ session: 's1', task: 'create invoice', task_seq: 2, mode: 'guided', driver_calls: 5, perception_bytes: 1000, screenshots: 1 });
      assert.equal(merged.task, 'create invoice');
      assert.equal(merged.task_seq, 2);
      assert.equal(merged.mode, 'guided');
      assert.equal(merged.driver_calls, 5);
      assert.equal(merged.started_at, created.started_at);
      db.upsertSession({ session: 's1', task_end_seq: 9 });
      assert.equal(db.getSession('s1')?.task_end_seq, 9);
      assert.equal(db.getSession('s1')?.task, 'create invoice');
      assert.throws(() => db.upsertSession({ session: '' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      db.close();
    } finally {
      t.cleanup();
    }
  });
});

describe('AppMapDb runs (04 §5) and recipeStats (04 §8)', () => {
  it('insert/get/update/list runs and steps; stats aggregate finished runs only', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const db = AppMapDb.open(t.config, { path: ':memory:' });
      db.upsertMap(map);
      db.insertRun(run('r1', { session: 'sess_a', started_at: '2026-09-01T00:00:00Z' }));
      assert.throws(() => db.insertRun(run('r1')), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      assert.throws(() => db.updateRun(run('r9')), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.RUN_NOT_ACTIVE);
      db.updateRun(run('r1', { session: 'sess_a', state: 'done', finished_at: '2026-09-01T00:01:00Z', started_at: '2026-09-01T00:00:00Z', last_seq: 5 }));
      assert.equal(db.getRun('r1')?.state, 'done');
      assert.equal(db.getRun('r1')?.last_seq, 5);
      db.insertRun(run('r2', { session: 'sess_a', state: 'fallback', fallbacks: 1, started_at: '2026-09-02T00:00:00Z', build: '4413' }));
      db.insertRun(run('r3', { session: 'sess_b', state: 'done', started_at: '2026-09-03T00:00:00Z', build: '4413' }));
      db.insertRun(run('r4', { session: 'sess_b', state: 'active', started_at: '2026-09-04T00:00:00Z', build: '4413' }));
      db.insertRun(run('r5', { session: 'sess_c', recipe: 'other', state: 'done', started_at: '2026-09-05T00:00:00Z' }));

      assert.deepEqual(db.listRuns().map((r) => r.run_id), ['r5', 'r4', 'r3', 'r2', 'r1']);
      assert.deepEqual(db.listRuns({ recipe: 'create_invoice', limit: 2 }).map((r) => r.run_id), ['r4', 'r3']);
      assert.deepEqual(db.listRuns({ since: '2026-09-03T00:00:00Z' }).map((r) => r.run_id), ['r5', 'r4', 'r3']);
      assert.deepEqual(db.listRunsForSession('sess_b').map((r) => r.run_id), ['r4', 'r3']);
      assert.deepEqual(db.listRunsForSession('sess_b', { states: ['active'] }).map((r) => r.run_id), ['r4']);

      const step: RunStepRecord = { run_id: 'r4', step_id: 's1', attempt: 1, gate_dismissals: 0, heals: 0, ts: '2026-09-04T00:00:01Z' };
      db.insertRunStep(step);
      db.insertRunStep({ ...step, attempt: 2, gate_dismissals: 1, ok: true, ts: '2026-09-04T00:00:02Z' });
      db.insertRunStep({ ...step, step_id: 's2', ts: '2026-09-04T00:00:03Z' });
      assert.equal(db.listRunSteps('r4').length, 3);
      assert.equal(db.getRunStep('r4', 's1')?.attempt, 2);
      assert.equal(db.getRunStep('r4', 's1')?.gate_dismissals, 1);
      assert.equal(db.getRunStep('r4', 'nope'), undefined);

      // a pending heal on an element the recipe touches (and one on an element it does not)
      const recipe = db.getRecipe('create_invoice')!;
      const touchedId = recipe.steps.map(stepElement).find((id) => id !== undefined)!;
      const ref = map.elements.get(touchedId)![0]!;
      db.putElement(ref.screen, { ...ref.element, status: 'healed_pending_review' }, { reason: 'heal' });
      const untouched = db.getScreen('invoice_list') as ScreenFile;
      const tab = untouched.elements.find((e) => e.id === 'nav.settings.tab') as ElementDef;
      assert.ok(!recipe.steps.some((s) => stepElement(s) === tab.id));
      db.putElement('invoice_list', { ...tab, status: 'healed_pending_review' }, { reason: 'heal' });
      assert.equal(db.listPendingHeals().length, 2);

      const stats = db.recipeStats('create_invoice', { currentBuild: '4413', lastN: 2 });
      assert.equal(stats.runs, 3); // r1, r2, r3 (r4 active excluded)
      assert.equal(stats.successes, 2);
      assert.equal(stats.fallbacks, 1);
      assert.equal(stats.success_sessions, 2);
      assert.deepEqual(stats.builds, [{ build: '4412', runs: 1, successes: 1 }, { build: '4413', runs: 2, successes: 1 }]);
      assert.deepEqual(stats.last_runs, [true, false]); // newest first, capped at lastN
      assert.equal(stats.fallback_rate_current_build, 0.5);
      assert.equal(stats.heals_pending, 1);
      const none = db.recipeStats('unknown_recipe', { currentBuild: '4413' });
      assert.equal(none.runs, 0);
      assert.equal(none.fallback_rate_current_build, 0);
      assert.equal(none.heals_pending, 0);
      db.close();
    } finally {
      t.cleanup();
    }
  });

  it('pruneBefore deletes old observations, runs (+steps) and empty sessions only', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const db = AppMapDb.open(t.config, { path: ':memory:' });
      db.insertObservation(obs('old', 1, { ts: '2026-08-01T00:00:00Z' }));
      db.insertObservation(obs('new', 1, { ts: '2026-09-10T00:00:00Z' }));
      db.insertRun(run('old_run', { started_at: '2026-08-01T00:00:00Z' }));
      db.insertRunStep({ run_id: 'old_run', step_id: 's1', attempt: 1, gate_dismissals: 0, heals: 0, ts: '2026-08-01T00:00:01Z' });
      db.insertRun(run('new_run', { started_at: '2026-09-10T00:00:00Z' }));
      assert.deepEqual(db.pruneBefore('2026-08-28T00:00:00Z'), { observations: 1, runs: 1 });
      assert.equal(db.getRun('old_run'), undefined);
      assert.deepEqual(db.listRunSteps('old_run'), []);
      assert.ok(db.getRun('new_run'));
      assert.equal(db.getSession('old'), undefined);
      assert.ok(db.getSession('new'));
      assert.deepEqual(db.pruneBefore('2026-08-28T00:00:00Z'), { observations: 0, runs: 0 });
      db.close();
    } finally {
      t.cleanup();
    }
  });
});

describe('WAL stress (03 §12 acceptance criterion, 03 §2)', () => {
  const N = 500;

  it('two connections in one process interleave 500 inserts each in short transactions without corruption', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const a = AppMapDb.open(t.config);
      const b = AppMapDb.open(t.config);
      for (let i = 1; i <= N; i += 1) {
        a.transaction(() => a.insertObservation(obs('conn_a', i)));
        b.transaction(() => b.insertObservation(obs('conn_b', i)));
      }
      assert.equal(a.listObservations('conn_b').length, N); // each sees the other's commits
      assert.equal(b.listObservations('conn_a').length, N);
      a.close();
      b.close();
      const raw = new DatabaseSync(cacheFile(t.config));
      assert.equal((raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      assert.equal((raw.prepare('SELECT count(*) AS n FROM observations').get() as { n: number }).n, 2 * N);
      raw.close();
    } finally {
      t.cleanup();
    }
  });

  it('a concurrent child process shares the cache through WAL (many instances, 03 §2)', async () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const parent = AppMapDb.open(t.config); // creates the schema before the child starts
      const dbUrl = pathToFileURL(join(PACKAGE_ROOT, 'src', 'store', 'db.ts')).href;
      const configUrl = pathToFileURL(join(PACKAGE_ROOT, 'src', 'config.ts')).href;
      const script = `
        import { AppMapDb } from ${JSON.stringify(dbUrl)};
        import { loadConfig } from ${JSON.stringify(configUrl)};
        const config = loadConfig(process.env);
        const n = Number(process.env.STRESS_N);
        const x = AppMapDb.open(config);
        const y = AppMapDb.open(config);
        const obs = (session, seq) => ({ ts: new Date().toISOString(), session, seq, tool: 'mcp__argent__tap', input: {}, screen_before: 'unknown',
          screen_after: 'login', signature_after: { marker: 'screen.login', structural_hash: 'sha1:' + '0'.repeat(40), required_present: 1 }, snapshot: null, ok: true, latency_ms: 1 });
        for (let i = 1; i <= n; i += 1) {
          x.transaction(() => x.insertObservation(obs('child_x', i)));
          y.transaction(() => y.insertObservation(obs('child_y', i)));
        }
        x.close(); y.close();
        process.stdout.write('done');
      `;
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], {
        env: { ...process.env, APP_MAP_DIR: t.config.dir, APP_MAP_PLATFORM: t.config.platform, STRESS_N: String(N) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
      // the parent hammers the same file while the child runs
      const second = AppMapDb.open(t.config);
      for (let i = 1; i <= N; i += 1) {
        parent.transaction(() => parent.insertObservation(obs('parent_a', i)));
        second.transaction(() => second.insertObservation(obs('parent_b', i)));
        if (i % 50 === 0) await new Promise((r) => setTimeout(r, 1)); // let the child get scheduled
      }
      const code = await exited;
      assert.equal(code, 0, `child failed: ${err}`);
      assert.equal(out, 'done');
      parent.close();
      second.close();
      const raw = new DatabaseSync(cacheFile(t.config));
      assert.equal((raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
      const counts = (raw.prepare('SELECT session, count(*) AS n FROM observations GROUP BY session ORDER BY session').all() as Array<{ session: string; n: number }>)
        .map((r) => ({ session: r.session, n: r.n })); // node:sqlite rows have a null prototype
      assert.deepEqual(counts, [
        { session: 'child_x', n: N }, { session: 'child_y', n: N }, { session: 'parent_a', n: N }, { session: 'parent_b', n: N },
      ]);
      raw.close();
      // WAL artefacts live next to the cache, all under .local
      assert.ok(readdirSync(join(t.config.dir, '.local')).every((f) => f.startsWith('cache.sqlite')));
    } finally {
      t.cleanup();
    }
  });
});
