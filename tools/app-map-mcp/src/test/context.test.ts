/**
 * [A2] context.ts — `openContext` (03 §3 build resolution, 03 §4 reload on tree-hash change,
 * 03 §11 invalid map keeps the server up, 07 §2.4 retention on start).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { openContext } from '../context.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { cacheFile, eventsFile, idsFile, screenFile, serverLog, trajectoriesDir, trajectoryFile } from '../paths.ts';
import { AppMapDb } from '../store/db.ts';
import { readEvents } from '../events.ts';
import type { BuildProbeResult, Observation } from '../types.ts';
import { makeTempAppMapDir } from './helpers.ts';

describe('openContext', () => {
  it('loads the pilot, fills the cache, resolves the build from the manifest, and closes idempotently', () => {
    const t = makeTempAppMapDir();
    try {
      const ctx = openContext(t.config, { skipRetention: true, logSink: 'none' });
      assert.equal(ctx.loadError, null);
      assert.equal(ctx.config, t.config);
      assert.equal(ctx.map.platform, 'ios');
      assert.ok(ctx.map.screens.size >= 5);
      assert.equal(ctx.db.listScreens().length, ctx.map.screens.size + ctx.map.gates.size);
      assert.equal(ctx.db.getMeta('platform'), 'ios');
      assert.equal(ctx.db.getMeta('loaded_at'), ctx.map.loadedAt);
      assert.equal(ctx.build, '4412'); // APP_MAP_BUILD=auto → manifest
      assert.equal(ctx.map.build, '4412');
      assert.equal(ctx.probe, null);
      const probe: BuildProbeResult = { schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app', version: '1', build_number: '4412', git_sha: 'a', auth: 'logged_in' };
      ctx.setProbe(probe);
      assert.deepEqual(ctx.probe as BuildProbeResult | null, probe);
      ctx.setProbe(null);
      assert.equal(ctx.probe, null);
      // the event sink writes events.jsonl with the platform stamped
      const ev = ctx.events.append({ kind: 'identify', screen: 'login', confidence: 1, signal: 'marker', build: ctx.build });
      assert.equal(ev.platform, 'ios');
      assert.deepEqual(readEvents(t.config).events, [ev]);
      assert.ok(existsSync(cacheFile(t.config)));
      assert.ok(!existsSync(serverLog(t.config)), 'logSink none writes no file');
      ctx.close();
      ctx.close();
      assert.throws(() => ctx.db.getMeta('platform'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
    } finally {
      t.cleanup();
    }
  });

  it('APP_MAP_BUILD wins over the driver build, which wins over the manifest; setBuild persists in meta', () => {
    const t = makeTempAppMapDir();
    try {
      const ctx = openContext(t.config, { skipRetention: true, logSink: 'none' });
      ctx.setBuild('4413');
      assert.equal(ctx.build, '4413');
      assert.equal(ctx.map.build, '4413');
      assert.equal(ctx.db.getMeta('build'), '4413');
      assert.throws(() => ctx.setBuild(''), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
      ctx.close();
      const again = openContext(t.config, { skipRetention: true, logSink: 'none' });
      assert.equal(again.build, '4413'); // driver-reported build survives restarts (03 §3)
      again.close();
      const pinned = openContext({ ...t.config, build: '5000' }, { skipRetention: true, logSink: 'none' });
      assert.equal(pinned.build, '5000');
      assert.equal(pinned.map.build, '5000');
      pinned.close();
    } finally {
      t.cleanup();
    }
  });

  it('reloads the cache when a screen file changes (tree hash differs, 03 §4)', () => {
    const t = makeTempAppMapDir();
    try {
      // a git repo so `gitTreeHash` is defined and the reload decision is hash-driven
      execFileSync('git', ['init', '-q'], { cwd: t.dir });
      const ctx = openContext(t.config, { skipRetention: true, logSink: 'none' });
      const hash1 = ctx.map.treeHash;
      assert.ok(hash1, 'inside a git repo the tree hash is known');
      assert.equal(ctx.db.getMeta('tree_hash'), hash1);
      const file = screenFile(t.config, 'login');
      const text = readFileSync(file, 'utf8');
      const edited = text.replace('nav_class: LoginView', 'nav_class: LoginViewV2');
      assert.notEqual(edited, text, 'fixture title changed?');
      writeFileSync(file, edited);
      const map = ctx.reload();
      assert.equal(map, ctx.map);
      assert.notEqual(map.treeHash, hash1);
      assert.equal(ctx.db.getMeta('tree_hash'), map.treeHash);
      assert.equal(ctx.map.screens.get('login')?.signature.nav_class, 'LoginViewV2');
      assert.equal(ctx.db.getScreen('login')?.signature.nav_class, 'LoginViewV2');
      assert.equal(ctx.loadError, null);
      ctx.close();
      // a fresh process with an unchanged tree does not re-upsert (loaded_at stays)
      const again = openContext(t.config, { skipRetention: true, logSink: 'none' });
      const loadedAt = again.db.getMeta('loaded_at');
      again.close();
      const third = openContext(t.config, { skipRetention: true, logSink: 'none' });
      assert.equal(third.db.getMeta('loaded_at'), loadedAt);
      assert.equal(third.db.getScreen('login')?.signature.nav_class, 'LoginViewV2');
      third.close();
    } finally {
      t.cleanup();
    }
  });

  it('keeps the context open with loadError when the YAML is invalid, until reload() succeeds (03 §11)', () => {
    const t = makeTempAppMapDir();
    try {
      const good = readFileSync(idsFile(t.config), 'utf8');
      writeFileSync(idsFile(t.config), 'schema_version: 1\nscreens: [\n');
      const ctx = openContext(t.config, { skipRetention: true, logSink: 'none' });
      assert.ok(ctx.loadError);
      assert.equal(ctx.loadError?.code, ERROR_CODES.INVALID_MAP);
      assert.equal(ctx.map.screens.size, 0);
      assert.equal(ctx.map.recipes.size, 0);
      assert.equal(ctx.map.platform, 'ios');
      assert.equal(ctx.db.listScreens().length, 0, 'nothing upserted from a broken map');
      assert.equal(ctx.build, '0');
      assert.throws(() => ctx.reload(), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP);
      writeFileSync(idsFile(t.config), good);
      const map = ctx.reload();
      assert.equal(ctx.loadError, null);
      assert.ok(map.screens.size >= 5);
      assert.equal(ctx.db.listScreens().length, map.screens.size + map.gates.size);
      assert.equal(ctx.build, '4412');
      ctx.close();
    } finally {
      t.cleanup();
    }
  });

  it('runs retention on open: old trajectories and cache rows go, recent ones stay (07 §2.4)', () => {
    const t = makeTempAppMapDir();
    try {
      const DAY = 24 * 60 * 60 * 1000;
      const old = new Date(Date.now() - 15 * DAY);
      const recent = new Date(Date.now() - 2 * DAY);
      mkdirSync(trajectoriesDir(t.config), { recursive: true });
      const oldTraj = trajectoryFile(t.config, 'old');
      const newTraj = trajectoryFile(t.config, 'new');
      writeFileSync(oldTraj, '{}\n');
      writeFileSync(newTraj, '{}\n');
      utimesSync(oldTraj, old, old);
      utimesSync(newTraj, recent, recent);
      const iso = (d: Date): string => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
      writeFileSync(eventsFile(t.config), `${JSON.stringify({ ts: iso(old), kind: 'identify', screen: 'login', confidence: 1, signal: 'marker', build: '1' })}\n${JSON.stringify({ ts: iso(recent), kind: 'identify', screen: 'login', confidence: 1, signal: 'marker', build: '1' })}\n`);
      const seed = AppMapDb.open(t.config);
      const obs = (session: string, ts: string): Observation => ({
        ts, session, seq: 1, tool: 'mcp__argent__tap', input: {}, screen_before: 'unknown', screen_after: 'login',
        signature_after: { marker: 'screen.login', structural_hash: `sha1:${'0'.repeat(40)}`, required_present: 1 }, snapshot: null, ok: true, latency_ms: 1,
      });
      seed.insertObservation(obs('old', iso(old)));
      seed.insertObservation(obs('new', iso(recent)));
      seed.close();

      const ctx = openContext(t.config, { logSink: 'none' });
      assert.ok(!existsSync(oldTraj));
      assert.ok(existsSync(newTraj));
      assert.equal(readEvents(t.config, { platform: 'all' }).events.length, 1);
      assert.equal(ctx.db.listObservations('old').length, 0);
      assert.equal(ctx.db.listObservations('new').length, 1);
      assert.match(ctx.db.getMeta('last_retention_run') ?? '', /^\d{4}-/);
      ctx.close();
      // skipRetention leaves everything alone
      writeFileSync(oldTraj, '{}\n');
      utimesSync(oldTraj, old, old);
      const skip = openContext(t.config, { skipRetention: true, logSink: 'none' });
      assert.ok(existsSync(oldTraj));
      skip.close();
    } finally {
      t.cleanup();
    }
  });

  it('readOnly opens an existing cache without writing and refuses a missing one', () => {
    const t = makeTempAppMapDir();
    try {
      assert.throws(() => openContext(t.config, { readOnly: true, logSink: 'none' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
      const rw = openContext(t.config, { skipRetention: true, logSink: 'none' });
      rw.setBuild('4413');
      rw.close();
      const ro = openContext(t.config, { readOnly: true, logSink: 'none' });
      assert.equal(ro.build, '4413');
      assert.equal(ro.db.listScreens().length, ro.map.screens.size + ro.map.gates.size);
      ro.setBuild('4414'); // in-memory only
      assert.equal(ro.build, '4414');
      assert.equal(ro.db.getMeta('build'), '4413');
      ro.close();
    } finally {
      t.cleanup();
    }
  });

  it('writes the server log by default (file sink) and cleans up when the cache cannot open', () => {
    const t = makeTempAppMapDir();
    try {
      const ctx = openContext(t.config, { skipRetention: true });
      ctx.log.error('visible');
      ctx.close();
      assert.match(readFileSync(serverLog(t.config), 'utf8'), /"msg":"visible"/);
      // a directory where the cache file should be → storage error, logger closed, no throw leak
      const bad = join(t.dir, '.local', 'blocked.sqlite');
      mkdirSync(bad, { recursive: true });
      assert.throws(() => openContext(t.config, { skipRetention: true, logSink: 'none', dbPath: bad }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.STORAGE);
    } finally {
      t.cleanup();
    }
  });
});
