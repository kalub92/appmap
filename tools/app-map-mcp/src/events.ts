/**
 * [A2] Metrics feed `.local/events.jsonl` (02 §7, 08 §2) and `.local` retention (02 §7, 07 §2.4).
 *
 * Contract:
 * - One `Event` per line, `JSON.stringify` (no pretty-print), LF, appended with a single
 *   `appendFileSync` call so concurrent server instances interleave whole lines (each line
 *   < 64 KiB — never embed trees). `ts` is stamped by `appendEvent` when absent (`types.now()`).
 * - `platform` defaults to `config.platform`.
 * - Readers tolerate a truncated last line (skip it) and unknown kinds (skip, count in `skipped`).
 * - Retention: on server start (context.ts) `pruneLocal` deletes trajectory files whose mtime
 *   is older than `config.retentionDays` and rewrites events.jsonl keeping only lines with
 *   `ts` within the window. `.local/maestro/*` and `server.log.1` older than the window are also
 *   removed. Never touches `cache.sqlite` (db.pruneBefore handles rows).
 *
 * Layer: store (imports types/config/paths/errors).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppMapConfig } from './config.ts';
import type { Event, EventInput, EventKind, Timestamp } from './types.ts';
import { now } from './types.ts';
import { eventsFile, localDir, maestroOutDir, serverLog, trajectoriesDir } from './paths.ts';

/** every `Event['kind']` (08 §2 table); a line with any other kind is skipped by readers */
export const EVENT_KINDS: readonly EventKind[] = ['task', 'recipe_run', 'heal', 'identify', 'drift', 'compile'];

/** a line must stay well under the pipe-atomic write size so concurrent appends never interleave (08 §2, 03 §2) */
export const MAX_EVENT_LINE_BYTES = 64 * 1024;

/** stderr is the only place a metrics failure may be reported (stdout is the MCP transport) */
function reportToStderr(msg: string, detail: Record<string, unknown>): void {
  try {
    process.stderr.write(`${JSON.stringify({ ts: now(), level: 'warn', msg, ...detail })}\n`);
  } catch {
    // nothing left to do
  }
}

/** true when `file` is absent, empty, or its last byte is LF (so the next append starts a new line) */
function endsWithNewline(file: string): boolean {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size === 0) return true;
    fd = openSync(file, 'r');
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Append one event; returns the stamped event. Never throws for I/O problems (logs and drops) — metrics must not break sessions. */
export function appendEvent(config: Pick<AppMapConfig, 'dir' | 'platform'>, event: EventInput): Event {
  // `ts` and `platform` first so every line reads the same way (fixtures/events/sample.events.jsonl)
  const { ts, platform, ...rest } = event as EventInput & { platform?: AppMapConfig['platform'] };
  const stamped = { ts: ts ?? now(), platform: platform ?? config.platform, ...rest } as Event;
  try {
    const line = `${JSON.stringify(stamped)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
      // never embed trees: an oversized event is dropped rather than risk a torn line
      reportToStderr('events: dropping oversized event', { kind: stamped.kind, bytes: Buffer.byteLength(line, 'utf8') });
      return stamped;
    }
    mkdirSync(localDir(config), { recursive: true });
    const file = eventsFile(config);
    // a writer that died mid-line leaves a torn tail; start on a fresh line so only that tail is lost
    const prefix = endsWithNewline(file) ? '' : '\n';
    appendFileSync(file, `${prefix}${line}`, 'utf8'); // one call → whole-line interleaving across instances
  } catch (e) {
    reportToStderr('events: append failed', { kind: stamped.kind, error: (e as Error).message });
  }
  return stamped;
}

export interface ReadEventsOptions {
  since?: Timestamp;
  until?: Timestamp;
  kinds?: EventKind[];
  /** default: `config.platform`; `'all'` for every platform */
  platform?: AppMapConfig['platform'] | 'all';
}

/** RFC 3339 → epoch ms, or `undefined` when unparseable */
function epoch(ts: string): number | undefined {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? undefined : n;
}

/**
 * Read events in file order. `since` is inclusive and `until` exclusive (half-open window, so
 * consecutive report windows never double count). `skipped` counts malformed/truncated lines and
 * unknown kinds — never lines that merely fail the filters.
 */
export function readEvents(config: Pick<AppMapConfig, 'dir' | 'platform'>, opts: ReadEventsOptions = {}): { events: Event[]; skipped: number } {
  const file = eventsFile(config);
  const events: Event[] = [];
  let skipped = 0;
  if (!existsSync(file)) return { events, skipped };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    reportToStderr('events: read failed', { error: (e as Error).message });
    return { events, skipped };
  }
  const since = opts.since !== undefined ? epoch(opts.since) : undefined;
  const until = opts.until !== undefined ? epoch(opts.until) : undefined;
  const kinds = opts.kinds ? new Set<string>(opts.kinds) : undefined;
  const platform = opts.platform ?? config.platform;
  for (const raw of text.split('\n')) {
    if (raw.trim().length === 0) continue;
    const ev = parseEventLine(raw);
    if (!ev) {
      skipped += 1;
      continue;
    }
    if (kinds && !kinds.has(ev.kind)) continue;
    // a line without `platform` predates the stamping and is taken as the configured platform
    if (platform !== 'all' && ev.platform !== undefined && ev.platform !== platform) continue;
    if (since !== undefined || until !== undefined) {
      const t = epoch(ev.ts);
      if (t === undefined) {
        skipped += 1;
        continue;
      }
      if (since !== undefined && t < since) continue;
      if (until !== undefined && t >= until) continue;
    }
    events.push(ev);
  }
  return { events, skipped };
}

/** Parse one line; `undefined` for malformed JSON or missing `kind`/`ts`. Pure. */
export function parseEventLine(line: string): Event | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    return undefined; // truncated last line, garbage
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
  const rec = doc as Record<string, unknown>;
  if (typeof rec.ts !== 'string' || typeof rec.kind !== 'string') return undefined;
  if (!(EVENT_KINDS as readonly string[]).includes(rec.kind)) return undefined; // unknown kind → skipped
  return rec as unknown as Event;
}

export interface PruneResult {
  trajectories_deleted: string[];
  events_dropped: number;
  other_deleted: string[];
}

/** Retention sweep (14 days by default); `now` injectable for tests. */
export function pruneLocal(config: Pick<AppMapConfig, 'dir' | 'retentionDays'>, opts: { now?: Date } = {}): PruneResult {
  const result: PruneResult = { trajectories_deleted: [], events_dropped: 0, other_deleted: [] };
  const local = localDir(config);
  if (!existsSync(local)) return result;
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoff = nowMs - config.retentionDays * 24 * 60 * 60 * 1000; // 07 §2.4: 14 days by default
  const olderThanWindow = (path: string): boolean => {
    try {
      return statSync(path).mtimeMs < cutoff;
    } catch {
      return false;
    }
  };
  const deleteOld = (dir: string, out: string[], prefix: string): void => {
    if (!existsSync(dir)) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names.sort()) {
      const p = join(dir, name);
      try {
        if (!statSync(p).isFile() || !olderThanWindow(p)) continue;
        unlinkSync(p);
        out.push(prefix ? `${prefix}/${name}` : name);
      } catch (e) {
        reportToStderr('retention: delete failed', { path: p, error: (e as Error).message });
      }
    }
  };

  // 1. trajectories older than the window (mtime = last observation appended)
  deleteOld(trajectoriesDir(config), result.trajectories_deleted, '');

  // 2. events.jsonl: keep only lines whose `ts` is inside the window; unparseable lines go too
  const events = eventsFile(config);
  if (existsSync(events)) {
    try {
      const lines = readFileSync(events, 'utf8').split('\n');
      const kept: string[] = [];
      let dropped = 0;
      for (const raw of lines) {
        if (raw.length === 0) continue;
        const ev = parseEventLine(raw);
        const t = ev ? epoch(ev.ts) : undefined;
        if (t === undefined || t < cutoff) dropped += 1;
        else kept.push(raw);
      }
      if (dropped > 0) {
        // write-then-rename so a concurrent appender never sees a half-written file (03 §2)
        const tmp = `${events}.${process.pid}.tmp`;
        writeFileSync(tmp, kept.length ? `${kept.join('\n')}\n` : '', 'utf8');
        renameSync(tmp, events);
        result.events_dropped = dropped;
      }
    } catch (e) {
      reportToStderr('retention: events rewrite failed', { error: (e as Error).message });
    }
  }

  // 3. generated Maestro flows and the rotated log generation
  deleteOld(maestroOutDir(config), result.other_deleted, 'maestro');
  const rotated = `${serverLog(config)}.1`;
  if (existsSync(rotated) && olderThanWindow(rotated)) {
    try {
      unlinkSync(rotated);
      result.other_deleted.push('server.log.1');
    } catch (e) {
      reportToStderr('retention: delete failed', { path: rotated, error: (e as Error).message });
    }
  }
  // cache.sqlite is never touched here: db.pruneBefore prunes rows (07 §2.4)
  return result;
}

/** Sink handed to modules that emit events (context.events); `append` = `appendEvent(config, …)`. */
export interface EventSink {
  append(event: EventInput): Event;
}
