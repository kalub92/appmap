/**
 * [A2] `AppMapContext` — everything a side-effecting module needs, opened once per process
 * (server start, each CLI command). Pure modules (identify, resolve, scrub, signature, plan,
 * format, match, canonical) never receive it; they take `LoadedMap`/`Tree`/data.
 *
 * `openContext(config)`:
 *  1. ensures `.local/` exists (git-ignored, 07 §2.4);
 *  2. creates the logger (log.ts);
 *  3. runs retention (events.pruneLocal + db.pruneBefore) unless `skipRetention`;
 *  4. loads the map (yaml/load.loadMap). On `invalid_map` the context still opens: `map` is an
 *     empty `LoadedMap` for the platform (`indexMap` with no screens/recipes), `loadError`
 *     holds the error, and every tool returns it as `{error, hint}` (03 §11) until `reload()`
 *     succeeds. The CLI, by contrast, exits 1 with the issues listed;
 *  5. opens the cache (store/db.ts); if `db.getMeta('tree_hash') !== map.treeHash` the map is
 *     upserted (03 §4 "reload when YAML changed since the cache's recorded git tree hash");
 *  6. resolves the effective build: `config.build` when not `auto`, else `db.getMeta('build')`
 *     (the last driver-reported build, set by `setBuild`), else `manifest.build.build_number`
 *     (03 §3).
 *
 * The Maestro version check (03 §13, 07 §5.3) is NOT part of `openContext` (CLI commands must
 * stay fast); `server.startServer` runs `headless.checkMaestroVersion` once after open,
 * non-fatal, logging a `warn` — headless runs re-check and fail with `maestro_unavailable`.
 *
 * `reload()` re-runs 4–6 (used by the `export` tool after writing and by tests).
 * `close()` closes db and logger; idempotent.
 *
 * Layer: store (imports everything below it: config, paths, log, yaml/load, store/db, events).
 */
import type { AppMapConfig } from './config.ts';
import type { EventSink } from './events.ts';
import type { Logger } from './log.ts';
import type { AppMapDb } from './store/db.ts';
import type { BuildNumber, BuildProbeResult, LoadedMap } from './types.ts';
import { AppMapError, NotImplementedError } from './errors.ts';

export interface AppMapContext {
  readonly config: AppMapConfig;
  /** current in-memory map; replaced by `reload()` (do not cache across calls) */
  readonly map: LoadedMap;
  readonly db: AppMapDb;
  readonly events: EventSink;
  readonly log: Logger;
  /** effective build number (03 §3 `APP_MAP_BUILD` auto-detection) */
  readonly build: BuildNumber;
  /**
   * last successful 07 §3 probe of this process (guided/headless runs set it; `null` until
   * then). The only source of 02 §4.3 variant facts — pass `probeConditions(ctx.probe)` into
   * `identify` (observe.ts, guided.ts, headless.ts, drift.ts).
   */
  readonly probe: BuildProbeResult | null;
  /** set when the last load failed validation; tools surface it (03 §11) */
  readonly loadError: AppMapError | null;
  /** re-read YAML, re-validate, upsert the cache; returns the new map or throws `invalid_map` */
  reload(): LoadedMap;
  /** override the effective build (driver reported it, 03 §13); also `db.setMeta('build', …)` */
  setBuild(build: BuildNumber): void;
  /** cache a probe result (guided.startGuidedRun / headless.runHeadless after a successful probe) */
  setProbe(probe: BuildProbeResult | null): void;
  close(): void;
}

export interface OpenContextOptions {
  /** skip 14-day retention (tests, hot paths like `record --stdin`) */
  skipRetention?: boolean;
  /** open the db read-only (CLI `report`, `summary`) */
  readOnly?: boolean;
  /** `'stderr'` for the CLI, `'file'` for the server (default), `'none'` for tests */
  logSink?: 'file' | 'stderr' | 'both' | 'none';
  /** override the cache path (tests: `':memory:'`) */
  dbPath?: string;
}

export function openContext(config: AppMapConfig, opts: OpenContextOptions = {}): AppMapContext {
  void config; void opts;
  throw new NotImplementedError('context.openContext');
}
