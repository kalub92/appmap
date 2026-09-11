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
import type { AppMapConfig } from './config.ts';
import type { Event, EventInput, EventKind, Timestamp } from './types.ts';
import { NotImplementedError } from './errors.ts';

/** Append one event; returns the stamped event. Never throws for I/O problems (logs and drops) — metrics must not break sessions. */
export function appendEvent(config: Pick<AppMapConfig, 'dir' | 'platform'>, event: EventInput): Event {
  void config; void event;
  throw new NotImplementedError('events.appendEvent');
}

export interface ReadEventsOptions {
  since?: Timestamp;
  until?: Timestamp;
  kinds?: EventKind[];
  /** default: `config.platform`; `'all'` for every platform */
  platform?: AppMapConfig['platform'] | 'all';
}

export function readEvents(config: Pick<AppMapConfig, 'dir' | 'platform'>, opts: ReadEventsOptions = {}): { events: Event[]; skipped: number } {
  void config; void opts;
  throw new NotImplementedError('events.readEvents');
}

/** Parse one line; `undefined` for malformed JSON or missing `kind`/`ts`. Pure. */
export function parseEventLine(line: string): Event | undefined {
  void line;
  throw new NotImplementedError('events.parseEventLine');
}

export interface PruneResult {
  trajectories_deleted: string[];
  events_dropped: number;
  other_deleted: string[];
}

/** Retention sweep (14 days by default); `now` injectable for tests. */
export function pruneLocal(config: Pick<AppMapConfig, 'dir' | 'retentionDays'>, opts: { now?: Date } = {}): PruneResult {
  void config; void opts;
  throw new NotImplementedError('events.pruneLocal');
}

/** Sink handed to modules that emit events (context.events); `append` = `appendEvent(config, …)`. */
export interface EventSink {
  append(event: EventInput): Event;
}
