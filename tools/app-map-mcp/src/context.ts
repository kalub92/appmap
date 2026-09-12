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
import { mkdirSync } from 'node:fs';
import { relative, sep } from 'node:path';
import type { AppMapConfig } from './config.ts';
import type { EventSink } from './events.ts';
import { appendEvent, pruneLocal } from './events.ts';
import type { Logger } from './log.ts';
import { createLogger } from './log.ts';
import type { AppMapDb } from './store/db.ts';
import { openDb } from './store/db.ts';
import type { BuildNumber, BuildProbeResult, IdsRegistry, LoadedMap, Manifest } from './types.ts';
import { now } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { localDir, stringsFile } from './paths.ts';
import { indexMap, loadMap } from './yaml/load.ts';

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

/** `LoadedMap` with no screens/recipes — what tools see while the YAML is invalid (03 §11) */
export function emptyMap(config: Pick<AppMapConfig, 'platform' | 'build'>): LoadedMap {
  const manifest: Manifest = {
    schema_version: 1,
    app_id: '',
    platform: config.platform,
    deep_link_scheme: 'appmap',
    build: { version: '', build_number: config.build !== 'auto' && config.build !== '' ? config.build : '0', git_sha: '' },
    generated_at: now(),
    generator: 'app-map-mcp (empty map)',
  };
  const ids: IdsRegistry = { schema_version: 1, screens: [], gates: [], elements: [] };
  return indexMap({ platform: config.platform, manifest, ids, screens: [], recipes: [] });
}

/** 03 §3: `APP_MAP_BUILD` when set, else the driver-reported build cached in meta, else the manifest */
function resolveBuild(config: AppMapConfig, db: AppMapDb, map: LoadedMap): BuildNumber {
  if (config.build !== 'auto' && config.build !== '') return config.build;
  const fromDriver = db.getMeta('build');
  if (fromDriver !== undefined && fromDriver !== '') return fromDriver;
  return map.manifest.build.build_number;
}

export function openContext(config: AppMapConfig, opts: OpenContextOptions = {}): AppMapContext {
  const readOnly = opts.readOnly === true;
  // 1. `.local/` (git-ignored, 07 §2.4) — a read-only opener still needs the log directory
  mkdirSync(localDir(config), { recursive: true });
  // 2. logger — never stdout (docs/dev/toolchain.md)
  const log = createLogger(config, { sink: opts.logSink ?? 'file' });
  let db: AppMapDb | undefined;
  try {
    // 3. file retention (07 §2.4); the db half runs right after the cache opens
    if (!opts.skipRetention && !readOnly) {
      const pruned = pruneLocal(config);
      if (pruned.trajectories_deleted.length || pruned.events_dropped || pruned.other_deleted.length) {
        log.info('retention: pruned .local', { retention_days: config.retentionDays, trajectories: pruned.trajectories_deleted.length, events: pruned.events_dropped, other: pruned.other_deleted.length });
      }
    }

    // 4. the map (a validation failure keeps the context usable, 03 §11)
    let map: LoadedMap = emptyMap(config);
    let loadError: AppMapError | null = null;
    const load = (): void => {
      try {
        map = loadMap(config);
        loadError = null;
      } catch (e) {
        if (!AppMapError.is(e)) throw e;
        map = emptyMap(config);
        loadError = e;
        log.error('map failed to load', { code: e.code, error: e.message });
      }
    };
    load();

    // 5. the cache
    const dbOpts = { ...(opts.dbPath !== undefined ? { path: opts.dbPath } : {}), ...(readOnly ? { readOnly: true } : {}) };
    db = openDb(config, dbOpts);
    const cache = db;
    if (!opts.skipRetention && !readOnly) {
      const before = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
      const pruned = cache.pruneBefore(before);
      cache.setMeta('last_retention_run', now());
      if (pruned.observations || pruned.runs) log.info('retention: pruned cache rows', { before, ...pruned });
    }
    const syncCache = (): void => {
      if (readOnly || loadError !== null) return;
      // 03 §4: reload the cache when the YAML changed since the recorded tree hash (or when
      // the hash is unknown — outside git we cannot tell, so always upsert)
      const recorded = cache.getMeta('tree_hash');
      const platformChanged = cache.getMeta('platform') !== map.platform;
      if (map.treeHash === undefined || recorded !== map.treeHash || platformChanged) {
        cache.upsertMap(map);
        log.info('map loaded into cache', { tree_hash: map.treeHash, screens: map.screens.size, gates: map.gates.size, recipes: map.recipes.size });
      }
      if (!map.stringTablePresent) {
        // 03 §5 step 1 needs the OS dialog copy the scrubber only keeps for REGISTERED static
        // labels; without the table gate detection and label-based resolution simply stop working,
        // which is indistinguishable from a clean load unless it is said out loud (07 §2.3.3).
        log.warn('static string table is missing; gate detection and label-based resolution are degraded', {
          file: relative(config.dir, stringsFile(config)).split(sep).join('/'),
          fix: 'run scripts/app-map/strings-export.sh',
        });
      }
    };
    syncCache();

    // 6. the effective build
    let build = resolveBuild(config, cache, map);
    map.build = build;

    let probe: BuildProbeResult | null = null;
    let closed = false;
    const events: EventSink = { append: (event) => appendEvent(config, event) };
    const ctx: AppMapContext = {
      config,
      get map() { return map; },
      db: cache,
      events,
      log,
      get build() { return build; },
      get probe() { return probe; },
      get loadError() { return loadError; },
      reload() {
        load();
        syncCache();
        build = resolveBuild(config, cache, map);
        map.build = build;
        if (loadError !== null) throw loadError;
        return map;
      },
      setBuild(next) {
        if (typeof next !== 'string' || next.length === 0) {
          throw new AppMapError(ERROR_CODES.BAD_INPUT, 'build must be a non-empty build number string', 'e.g. "4412" (02 §8)');
        }
        build = next;
        map.build = next;
        if (!readOnly) cache.setMeta('build', next);
      },
      setProbe(next) {
        probe = next;
      },
      close() {
        if (closed) return;
        closed = true;
        cache.close();
        log.close();
      },
    };
    return ctx;
  } catch (e) {
    db?.close();
    log.close();
    throw e;
  }
}
