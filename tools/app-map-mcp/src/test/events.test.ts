/**
 * [A2] events.ts — events.jsonl append/read (08 §2, 02 §7) and `.local` retention (07 §2.4).
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EVENT_KINDS, MAX_EVENT_LINE_BYTES, appendEvent, parseEventLine, pruneLocal, readEvents } from '../events.ts';
import { cacheFile, eventsFile, localDir, maestroOutDir, serverLog, trajectoriesDir, trajectoryFile } from '../paths.ts';
import type { EventInput } from '../types.ts';
import { FIXTURES_DIR, loadEventsFixture, makeTempAppMapDir } from './helpers.ts';

const identify = (over: Partial<Extract<EventInput, { kind: 'identify' }>> = {}): EventInput => ({ kind: 'identify', screen: 'login', confidence: 1, signal: 'marker', build: '4412', ...over });

describe('appendEvent / readEvents (08 §2)', () => {
  it('stamps ts + platform, appends one JSON line, and reads it back', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      assert.ok(!existsSync(localDir(t.config)));
      const ev = appendEvent(t.config, identify());
      assert.equal(ev.kind, 'identify');
      assert.equal(ev.platform, 'ios');
      assert.match(ev.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      const text = readFileSync(eventsFile(t.config), 'utf8');
      assert.equal(text, `${JSON.stringify(ev)}\n`);
      assert.ok(text.startsWith('{"ts":"'), 'ts first, then platform');
      assert.match(text, /^\{"ts":"[^"]+","platform":"ios","kind":"identify"/);
      // explicit ts/platform are honoured
      const ev2 = appendEvent(t.config, identify({ ts: '2026-01-01T00:00:00Z', platform: 'android' }));
      assert.equal(ev2.ts, '2026-01-01T00:00:00Z');
      assert.equal(ev2.platform, 'android');
      const read = readEvents(t.config);
      assert.deepEqual(read, { events: [ev], skipped: 0 }); // platform defaults to ios
      assert.deepEqual(readEvents(t.config, { platform: 'android' }).events, [ev2]);
      assert.equal(readEvents(t.config, { platform: 'all' }).events.length, 2);
    } finally {
      t.cleanup();
    }
  });

  it('reads the validated sample fixture and filters by kind / since / until', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      mkdirSync(localDir(t.config), { recursive: true });
      writeFileSync(eventsFile(t.config), readFileSync(join(FIXTURES_DIR, 'events', 'sample.events.jsonl')));
      const fixture = loadEventsFixture();
      const all = readEvents(t.config, { platform: 'all' });
      assert.equal(all.skipped, 0);
      assert.deepEqual(all.events, fixture);
      for (const kind of EVENT_KINDS) {
        const only = readEvents(t.config, { kinds: [kind], platform: 'all' }).events;
        assert.equal(only.length, fixture.filter((e) => e.kind === kind).length, kind);
        assert.ok(only.every((e) => e.kind === kind));
      }
      const window = readEvents(t.config, { since: '2026-09-02T00:00:00Z', until: '2026-09-03T00:00:00Z', platform: 'all' }).events;
      assert.ok(window.length > 0);
      assert.ok(window.every((e) => e.ts >= '2026-09-02T00:00:00Z' && e.ts < '2026-09-03T00:00:00Z'));
      assert.deepEqual(window, fixture.filter((e) => e.ts >= '2026-09-02T00:00:00Z' && e.ts < '2026-09-03T00:00:00Z'));
      // since inclusive, until exclusive
      const first = fixture[0]!;
      assert.equal(readEvents(t.config, { since: first.ts, until: first.ts, platform: 'all' }).events.length, 0);
      assert.equal(readEvents(t.config, { since: first.ts, platform: 'all' }).events[0]?.ts, first.ts);
      assert.deepEqual(readEvents(t.config, { kinds: ['heal', 'drift'], platform: 'all' }).events.map((e) => e.kind).sort(), fixture.filter((e) => e.kind === 'heal' || e.kind === 'drift').map((e) => e.kind).sort());
    } finally {
      t.cleanup();
    }
  });

  it('tolerates a truncated last line, blank lines, garbage and unknown kinds (counted in skipped)', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const ok = appendEvent(t.config, identify());
      appendFileSync(eventsFile(t.config), '\n{"ts":"2026-09-01T00:00:00Z","kind":"martian","x":1}\nnot json\n{"kind":"identify"}\n{"ts":"2026-09-01T00:00:00Z","kind":"identify","screen":"lo');
      const read = readEvents(t.config, { platform: 'all' });
      assert.deepEqual(read.events, [ok]);
      assert.equal(read.skipped, 4); // unknown kind, garbage, missing ts, truncated
      // the file is still appendable afterwards and the next line is whole
      const next = appendEvent(t.config, identify({ screen: 'invoice_list' }));
      assert.equal(readEvents(t.config, { platform: 'all' }).events.length, 2);
      assert.ok(readFileSync(eventsFile(t.config), 'utf8').endsWith(`${JSON.stringify(next)}\n`));
      assert.deepEqual(readEvents({ dir: join(t.dir, 'nowhere'), platform: 'ios' }), { events: [], skipped: 0 });
    } finally {
      t.cleanup();
    }
  });

  it('parseEventLine is pure and strict about ts/kind', () => {
    assert.equal(parseEventLine(''), undefined);
    assert.equal(parseEventLine('   '), undefined);
    assert.equal(parseEventLine('{'), undefined);
    assert.equal(parseEventLine('[1]'), undefined);
    assert.equal(parseEventLine('"x"'), undefined);
    assert.equal(parseEventLine('{"kind":"identify"}'), undefined);
    assert.equal(parseEventLine('{"ts":"2026-09-01T00:00:00Z"}'), undefined);
    assert.equal(parseEventLine('{"ts":"2026-09-01T00:00:00Z","kind":"nope"}'), undefined);
    assert.equal(parseEventLine('{"ts":1,"kind":"identify"}'), undefined);
    const ev = parseEventLine('  {"ts":"2026-09-01T00:00:00Z","kind":"identify","screen":"login","confidence":1,"signal":"marker","build":"4412"}\n');
    assert.equal(ev?.kind, 'identify');
    assert.equal(ev?.ts, '2026-09-01T00:00:00Z');
    assert.deepEqual(EVENT_KINDS, ['task', 'recipe_run', 'heal', 'identify', 'drift', 'compile']);
  });

  it('never throws on I/O failure and drops lines over 64 KiB', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      // `.local` is a regular file → mkdir/append fail; the call still returns the stamped event
      mkdirSync(t.config.dir, { recursive: true });
      writeFileSync(localDir(t.config), 'not a directory');
      const stderr = process.stderr.write;
      let captured = '';
      process.stderr.write = ((chunk: string | Uint8Array) => { captured += chunk.toString(); return true; }) as typeof process.stderr.write;
      try {
        const ev = appendEvent(t.config, identify());
        assert.equal(ev.kind, 'identify');
        assert.match(captured, /append failed/);
      } finally {
        process.stderr.write = stderr;
      }
    } finally {
      t.cleanup();
    }
    const t2 = makeTempAppMapDir({ copyPilot: false });
    try {
      const huge: EventInput = { kind: 'compile', recipe: 'r', version: 1, from_session: 's', steps: 1, params: ['x'.repeat(MAX_EVENT_LINE_BYTES)] };
      const stderr = process.stderr.write;
      let captured = '';
      process.stderr.write = ((chunk: string | Uint8Array) => { captured += chunk.toString(); return true; }) as typeof process.stderr.write;
      try {
        appendEvent(t2.config, huge);
        assert.match(captured, /oversized/);
      } finally {
        process.stderr.write = stderr;
      }
      assert.ok(!existsSync(eventsFile(t2.config)));
      assert.equal(MAX_EVENT_LINE_BYTES, 64 * 1024);
    } finally {
      t2.cleanup();
    }
  });
});

describe('pruneLocal (07 §2.4 retention, 14 days)', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('deletes 15-day-old trajectories/maestro flows/server.log.1, keeps 13-day-old ones, rewrites events.jsonl, never touches cache.sqlite', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      assert.equal(t.config.retentionDays, 14);
      const nowDate = new Date('2026-09-15T12:00:00Z');
      const age = (path: string, days: number): void => {
        const when = new Date(nowDate.getTime() - days * DAY);
        utimesSync(path, when, when);
      };
      mkdirSync(trajectoriesDir(t.config), { recursive: true });
      mkdirSync(maestroOutDir(t.config), { recursive: true });
      const oldTraj = trajectoryFile(t.config, 'old_session');
      const newTraj = trajectoryFile(t.config, 'new_session');
      writeFileSync(oldTraj, '{}\n');
      writeFileSync(newTraj, '{}\n');
      age(oldTraj, 15);
      age(newTraj, 13);
      const oldFlow = join(maestroOutDir(t.config), 'old.yaml');
      const newFlow = join(maestroOutDir(t.config), 'new.yaml');
      writeFileSync(oldFlow, 'x');
      writeFileSync(newFlow, 'x');
      age(oldFlow, 20);
      age(newFlow, 1);
      const rotated = `${serverLog(t.config)}.1`;
      writeFileSync(rotated, 'x');
      age(rotated, 15);
      writeFileSync(serverLog(t.config), 'x');
      age(serverLog(t.config), 15); // the live log is never deleted
      writeFileSync(cacheFile(t.config), 'pretend sqlite');
      age(cacheFile(t.config), 40);
      const keep = { ts: new Date(nowDate.getTime() - 13 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z'), kind: 'identify', screen: 'login', confidence: 1, signal: 'marker', build: '1' };
      const drop = { ...keep, ts: new Date(nowDate.getTime() - 15 * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z') };
      writeFileSync(eventsFile(t.config), `${JSON.stringify(drop)}\n${JSON.stringify(keep)}\ngarbage\n${JSON.stringify(drop)}\n`);

      const res = pruneLocal(t.config, { now: nowDate });
      assert.deepEqual(res, { trajectories_deleted: ['old_session.jsonl'], events_dropped: 3, other_deleted: ['maestro/old.yaml', 'server.log.1'] });
      assert.ok(!existsSync(oldTraj));
      assert.ok(existsSync(newTraj));
      assert.ok(!existsSync(oldFlow));
      assert.ok(existsSync(newFlow));
      assert.ok(!existsSync(rotated));
      assert.ok(existsSync(serverLog(t.config)));
      assert.equal(readFileSync(cacheFile(t.config), 'utf8'), 'pretend sqlite');
      assert.equal(readFileSync(eventsFile(t.config), 'utf8'), `${JSON.stringify(keep)}\n`);
      // idempotent: a second sweep changes nothing
      assert.deepEqual(pruneLocal(t.config, { now: nowDate }), { trajectories_deleted: [], events_dropped: 0, other_deleted: [] });
      // a shorter window (APP_MAP_RETENTION_DAYS, architecture §7 decision 21) drops the 13-day-old data
      const res2 = pruneLocal({ dir: t.config.dir, retentionDays: 7 }, { now: nowDate });
      assert.deepEqual(res2.trajectories_deleted, ['new_session.jsonl']);
      assert.equal(res2.events_dropped, 1);
      assert.equal(readFileSync(eventsFile(t.config), 'utf8'), '');
    } finally {
      t.cleanup();
    }
  });

  it('is a no-op without a .local directory', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      assert.deepEqual(pruneLocal(t.config), { trajectories_deleted: [], events_dropped: 0, other_deleted: [] });
      assert.ok(!existsSync(localDir(t.config)));
    } finally {
      t.cleanup();
    }
  });
});
