/**
 * [A2] SQLite cache (02 §7, 03 §4) on `node:sqlite` (`DatabaseSync`), WAL mode, short
 * transactions so many server instances share `.local/cache.sqlite` safely (03 §2, 03 §12 WAL
 * stress test). Schema is documented in docs/dev/architecture.md ("SQLite schema"); it is
 * regenerable from YAML + logs and versioned via `meta.schema_version` (recreate on mismatch).
 *
 * Tables: `meta`, `screens`, `elements`, `recipes`, `registry` (ids.yaml + manifest rows),
 * `runs`, `run_steps`, `observations`, `sessions`, `counters`, `dirty`. Durable entities are stored as JSON blobs (`json` column) plus
 * the columns needed for queries; `dirty` marks what `export` must write (03 §4 write path).
 *
 * Layer: store (imports types/config/paths/errors + yaml/load for `LoadedMap`).
 */
import { existsSync, mkdirSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { AppMapConfig, Platform } from '../config.ts';
import type {
  BuildNumber, ElementDef, ElementId, IdsRegistry, LoadedMap, Manifest, Observation, RecipeFile, RecipeId, RecipeStatus, RunId,
  RunRecord, RunStepRecord, ScreenFile, ScreenId, SessionId, SessionMode, Timestamp,
} from '../types.ts';
import { assertScrubbed, now, stepElement } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { cacheFile, localDir } from '../paths.ts';

/** bump when the SQL schema changes; a mismatch drops and recreates the cache */
export const DB_SCHEMA_VERSION = 2;

/** architecture §5: writers wait up to 2 s for a WAL lock held by another instance (03 §2) */
export const DB_BUSY_TIMEOUT_MS = 2000;

export type CounterKind = 'element' | 'recipe' | 'screen';
/** per-element `hits|misses|heals`; per-recipe `runs|replay_success|fallbacks|guided_runs|headless_runs`; per-screen `seen` (02 §7) */
export type CounterName = 'hits' | 'misses' | 'heals' | 'runs' | 'replay_success' | 'fallbacks' | 'guided_runs' | 'headless_runs' | 'seen';

/** `ids` = ids.yaml (import-router registers new screens, 06 R7); `manifest` = build refresh */
export type DirtyKind = 'screen' | 'recipe' | 'ids' | 'manifest';
export interface DirtyRow {
  kind: DirtyKind;
  key: string;
  reason: string;
  ts: Timestamp;
  /** 02 §8 purge: the entity was deleted from the cache and its YAML file must be unlinked by `export` */
  deleted?: boolean;
  /**
   * Only on a `deleted` row: the blob sha the deleted entity was last loaded/written at. The
   * entity row that normally carries it is gone, so `export` reads it from here for the 03 §4
   * conflict check before unlinking.
   */
  blob_sha?: string;
}

/**
 * The `DirtyRow.reason` prefix that a recipe BODY rebuilt by `recipes/lifecycle.recompileFrom`
 * is written under (04 §8, issue #13). Deliberately distinct from the `lifecycle:<reason>` a
 * status-only transition uses, so `export` can tell "a machine rewrote this file's steps" apart
 * from "this file's status changed" and label the write for the reviewer.
 *
 * It lives here, next to `DirtyRow`, because it is a contract between a producer
 * (`recipes/lifecycle.ts`) and a consumer (`store/export.ts`) that must not drift; never inline
 * the literal anywhere else.
 */
export const RECOMPILE_DIRTY_PREFIX = 'recompile:';

/** Pure: does this `DirtyRow.reason` mean the row's content came from an automated recompile? */
export function isMachineRecompile(reason: string): boolean {
  return typeof reason === 'string' && reason.startsWith(RECOMPILE_DIRTY_PREFIX);
}

export interface SessionRow {
  session: SessionId;
  task?: string;
  /** seq at which the task was declared (observations before it are not compilable, 04 §2) */
  task_seq?: number;
  /** seq at which `finishTask` closed the task (compile slice end, 04 §3.1); absent while open */
  task_end_seq?: number;
  mode: SessionMode;
  started_at: Timestamp;
  last_seq: number;
  driver_calls: number;
  perception_bytes: number;
  screenshots: number;
}

/** Aggregates the lifecycle rules need (04 §8, 08 §5). */
export interface RecipeStats {
  recipe: RecipeId;
  runs: number;
  successes: number;
  fallbacks: number;
  /** distinct sessions with a successful replay */
  success_sessions: number;
  /** distinct builds with ≥1 run, and the per-build success rate */
  builds: Array<{ build: BuildNumber; runs: number; successes: number }>;
  /** outcomes of the last N runs, newest first */
  last_runs: boolean[];
  /** elements touched by this recipe currently `healed_pending_review` */
  heals_pending: number;
  /** runs on the current build with ≥1 fallback ÷ runs on the current build */
  fallback_rate_current_build: number;
}

export interface OpenDbOptions {
  /** override `paths.cacheFile(config)`; `':memory:'` for tests */
  path?: string;
  /** open without creating (CLI `report`); throws `storage` when absent */
  readOnly?: boolean;
}

/** the tables `DDL` creates, in drop order (children first) — used on a schema_version mismatch */
const TABLES = ['dirty', 'counters', 'sessions', 'registry', 'observations', 'run_steps', 'runs', 'recipes', 'elements', 'screens', 'meta'] as const;

type Row = Record<string, unknown>;

/** rows come back typed `unknown`; the store only ever reads its own columns */
function str(row: Row, col: string): string {
  return String(row[col]);
}
function num(row: Row, col: string): number {
  return Number(row[col]);
}
function optStr(row: Row, col: string): string | undefined {
  const v = row[col];
  return v === null || v === undefined ? undefined : String(v);
}
function optNum(row: Row, col: string): number | undefined {
  const v = row[col];
  return v === null || v === undefined ? undefined : Number(v);
}
function parseJson<T>(row: Row, col = 'json'): T {
  return JSON.parse(str(row, col)) as T;
}
/** RunRecord.state → the `ok` column (`NULL` while active) */
function runOk(state: RunRecord['state']): number | null {
  if (state === 'active') return null;
  return state === 'done' ? 1 : 0;
}

/**
 * Handle over the cache. Every method is synchronous (node:sqlite is sync) and wraps its writes
 * in a transaction. Throws `AppMapError(storage)` on SQLite errors.
 */
export class AppMapDb {
  readonly path: string;
  private readonly db: DatabaseSync;
  private readonly platform: Platform;
  private readonly readOnly: boolean;
  private readonly statements = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  private constructor(path: string, db: DatabaseSync, platform: Platform, readOnly: boolean) {
    this.path = path;
    this.db = db;
    this.platform = platform;
    this.readOnly = readOnly;
  }

  /** Open (creating schema / WAL as needed) — the only constructor. */
  static open(config: AppMapConfig, opts: OpenDbOptions = {}): AppMapDb {
    const path = opts.path ?? cacheFile(config);
    const readOnly = opts.readOnly === true;
    const inMemory = path === ':memory:';
    if (readOnly && !inMemory && !existsSync(path)) {
      throw new AppMapError(ERROR_CODES.STORAGE, `${path} does not exist`, 'start the server or run any writing CLI command once to create the cache (03 §4)');
    }
    let raw: DatabaseSync;
    try {
      if (!inMemory) mkdirSync(localDir(config), { recursive: true });
      raw = new DatabaseSync(path, readOnly ? { readOnly: true } : {});
      // 03 §2: many instances share the cache — WAL + busy timeout + short transactions
      if (!readOnly) raw.exec('PRAGMA journal_mode = WAL');
      raw.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`);
      raw.exec('PRAGMA synchronous = NORMAL');
    } catch (e) {
      throw new AppMapError(ERROR_CODES.STORAGE, `cannot open ${path}: ${(e as Error).message}`, 'check that app-map/.local is writable', { cause: e });
    }
    const db = new AppMapDb(path, raw, config.platform, readOnly);
    db.ensureSchema();
    return db;
  }

  /** create the tables; drop and recreate when `meta.schema_version` differs (the cache is regenerable, 02 §7) */
  private ensureSchema(): void {
    this.guard(() => {
      if (this.readOnly) {
        const version = this.tableExists('meta') ? this.getMeta('schema_version') : undefined;
        if (version !== String(DB_SCHEMA_VERSION)) {
          throw new AppMapError(ERROR_CODES.STORAGE, `${this.path} has schema_version ${version ?? 'none'}, expected ${DB_SCHEMA_VERSION}`, 'open the cache read-write once (server start or any writing CLI command) to recreate it');
        }
        return;
      }
      this.transaction(() => {
        this.db.exec(DDL);
        const version = this.getMeta('schema_version');
        if (version !== undefined && version !== String(DB_SCHEMA_VERSION)) {
          for (const t of TABLES) this.db.exec(`DROP TABLE IF EXISTS ${t}`);
          this.db.exec(DDL);
        }
        if (version !== String(DB_SCHEMA_VERSION)) this.setMeta('schema_version', String(DB_SCHEMA_VERSION));
      });
    });
  }

  private tableExists(name: string): boolean {
    return this.db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  /** every SQLite failure becomes `AppMapError(storage)`; our own errors pass through */
  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (AppMapError.is(e)) throw e;
      throw new AppMapError(ERROR_CODES.STORAGE, `sqlite: ${(e as Error).message}`, `the cache at ${this.path} failed; delete app-map/.local/cache.sqlite to regenerate it (02 §7)`, { cause: e });
    }
  }

  private stmt(sql: string): StatementSync {
    let s = this.statements.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.statements.set(sql, s);
    }
    return s;
  }

  private assertWritable(): void {
    if (this.readOnly) throw new AppMapError(ERROR_CODES.STORAGE, `${this.path} is open read-only`, 'open the cache without readOnly to write');
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    try {
      this.db.close();
    } catch {
      // already closed by the runtime
    }
  }

  /** run `fn` inside BEGIN IMMEDIATE … COMMIT (rollback on throw); nested calls join the outer transaction */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      this.txDepth += 1;
      try {
        return fn();
      } finally {
        this.txDepth -= 1;
      }
    }
    // BEGIN IMMEDIATE takes the write lock up front so two instances never deadlock on upgrade (03 §2)
    this.guard(() => this.db.exec(this.readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE'));
    this.txDepth = 1;
    try {
      const out = fn();
      this.guard(() => this.db.exec('COMMIT'));
      return out;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // the transaction may already be gone (e.g. the COMMIT itself failed)
      }
      throw e;
    } finally {
      this.txDepth = 0;
    }
  }

  // ---- meta -----------------------------------------------------------------------------------
  /** keys used: `schema_version`, `tree_hash`, `loaded_at`, `platform`, `build`, `last_retention_run` */
  getMeta(key: string): string | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT value FROM meta WHERE key = ?').get(key) as Row | undefined;
      return row ? str(row, 'value') : undefined;
    });
  }
  setMeta(key: string, value: string): void {
    this.assertWritable();
    this.guard(() => {
      this.stmt('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    });
  }
  private deleteMeta(key: string): void {
    this.stmt('DELETE FROM meta WHERE key = ?').run(key);
  }

  // ---- map (durable entities) -----------------------------------------------------------------
  /**
   * Replace screens/elements/recipes (+ the `registry` row for ids.yaml and manifest) with the
   * loaded map, preserving rows that are `dirty` (session edits not yet exported) and every
   * counter. Copies `map.files[*].blob_sha` into `screens.blob_sha` / `recipes.blob_sha` /
   * `registry.blob_sha` (export conflict check, 03 §4). Records `tree_hash`/`loaded_at` in meta.
   */
  upsertMap(map: LoadedMap): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      const dirty = new Set(this.listDirty().map((d) => `${d.kind}\0${d.key}`));
      const isDirty = (kind: DirtyKind, key: string): boolean => dirty.has(`${kind}\0${key}`);
      const shaOf = (rel: string): string | null => map.files.get(rel)?.blob_sha ?? null;

      // screens + gates: replace every non-dirty row; a dirty row keeps the session's edits AND the
      // blob sha it was edited on top of, so export still detects a concurrent change (03 §4)
      const keepScreens = new Set<string>();
      for (const screen of [...map.screens.values(), ...map.gates.values()]) {
        keepScreens.add(screen.id);
        if (isDirty('screen', screen.id)) continue;
        this.writeScreenRow(screen, map.platform, false, shaOf(`${map.platform}/screens/${screen.id}.yaml`));
      }
      for (const row of this.stmt('SELECT id FROM screens').all() as Row[]) {
        const id = str(row, 'id');
        if (!keepScreens.has(id) && !isDirty('screen', id)) this.deleteScreenRows(id);
      }

      const keepRecipes = new Set<string>();
      for (const recipe of map.recipes.values()) {
        keepRecipes.add(recipe.id);
        if (isDirty('recipe', recipe.id)) continue;
        this.writeRecipeRow(recipe, false, shaOf(`${map.platform}/recipes/${recipe.id}.yaml`));
      }
      for (const row of this.stmt('SELECT id FROM recipes').all() as Row[]) {
        const id = str(row, 'id');
        if (!keepRecipes.has(id) && !isDirty('recipe', id)) this.stmt('DELETE FROM recipes WHERE id = ?').run(id);
      }

      if (!isDirty('ids', 'ids')) this.writeRegistryRow('ids', map.ids, false, shaOf('ids.yaml'));
      if (!isDirty('manifest', 'manifest')) this.writeRegistryRow('manifest', map.manifest, false, shaOf(`${map.platform}/manifest.yaml`));

      if (map.treeHash !== undefined) this.setMeta('tree_hash', map.treeHash);
      else this.deleteMeta('tree_hash');
      this.setMeta('loaded_at', map.loadedAt);
      this.setMeta('platform', map.platform);
    }));
  }

  /** upsert a screen row + its elements; `blobSha === undefined` keeps the recorded sha, `null` clears it */
  private writeScreenRow(screen: ScreenFile, platform: Platform, dirty: boolean, blobSha?: string | null): void {
    const json = JSON.stringify(screen);
    this.stmt(`INSERT INTO screens (id, platform, kind, status, last_verified_build, blob_sha, json, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, kind = excluded.kind, status = excluded.status,
        last_verified_build = excluded.last_verified_build, json = excluded.json,
        dirty = max(screens.dirty, excluded.dirty),
        blob_sha = CASE WHEN ? THEN excluded.blob_sha ELSE screens.blob_sha END`)
      .run(screen.id, platform, screen.kind, screen.meta.status, screen.meta.last_verified_build ?? null, blobSha ?? null, json, dirty ? 1 : 0, blobSha === undefined ? 0 : 1);
    this.stmt('DELETE FROM elements WHERE screen_id = ?').run(screen.id);
    const ins = this.stmt('INSERT INTO elements (screen_id, id, role, status, intent_critical, json, dirty) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const el of screen.elements) {
      ins.run(screen.id, el.id, el.role, el.status, el.intent_critical ? 1 : 0, JSON.stringify(el), dirty ? 1 : 0);
    }
  }

  private writeRecipeRow(recipe: RecipeFile, dirty: boolean, blobSha?: string | null): void {
    this.stmt(`INSERT INTO recipes (id, platform, version, status, blob_sha, json, dirty) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET platform = excluded.platform, version = excluded.version, status = excluded.status,
        json = excluded.json, dirty = max(recipes.dirty, excluded.dirty),
        blob_sha = CASE WHEN ? THEN excluded.blob_sha ELSE recipes.blob_sha END`)
      .run(recipe.id, recipe.platform, recipe.version, recipe.status, blobSha ?? null, JSON.stringify(recipe), dirty ? 1 : 0, blobSha === undefined ? 0 : 1);
  }

  private writeRegistryRow(kind: 'ids' | 'manifest', doc: unknown, dirty: boolean, blobSha?: string | null): void {
    this.stmt(`INSERT INTO registry (kind, blob_sha, json, dirty) VALUES (?, ?, ?, ?)
      ON CONFLICT(kind) DO UPDATE SET json = excluded.json, dirty = max(registry.dirty, excluded.dirty),
        blob_sha = CASE WHEN ? THEN excluded.blob_sha ELSE registry.blob_sha END`)
      .run(kind, blobSha ?? null, JSON.stringify(doc), dirty ? 1 : 0, blobSha === undefined ? 0 : 1);
  }

  private markDirty(kind: DirtyKind, key: string, reason: string, deleted = false, blobSha?: string): void {
    this.stmt(`INSERT INTO dirty (kind, key, reason, ts, deleted, blob_sha) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, key) DO UPDATE SET reason = excluded.reason, ts = excluded.ts,
        deleted = excluded.deleted, blob_sha = excluded.blob_sha`)
      .run(kind, key, reason, now(), deleted ? 1 : 0, blobSha ?? null);
  }

  private deleteScreenRows(id: ScreenId): void {
    this.stmt('DELETE FROM elements WHERE screen_id = ?').run(id);
    this.stmt('DELETE FROM screens WHERE id = ?').run(id);
    this.stmt("DELETE FROM dirty WHERE kind = 'screen' AND key = ?").run(id);
  }

  getScreen(id: ScreenId): ScreenFile | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT json FROM screens WHERE id = ?').get(id) as Row | undefined;
      return row ? parseJson<ScreenFile>(row) : undefined;
    });
  }
  listScreens(): ScreenFile[] {
    return this.guard(() => (this.stmt('SELECT json FROM screens ORDER BY id').all() as Row[]).map((r) => parseJson<ScreenFile>(r)));
  }
  /** insert or replace; `dirty` marks it for export with `reason` (e.g. `name_screen`, `heal`, `import_router`) */
  putScreen(screen: ScreenFile, opts: { dirty: boolean; reason?: string }): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      this.writeScreenRow(screen, this.platform, opts.dirty);
      if (opts.dirty) this.markDirty('screen', screen.id, opts.reason ?? 'put_screen');
    }));
  }
  /** replace one element inside a screen (heal path, 04 §7.2); marks the screen dirty */
  putElement(screenId: ScreenId, element: ElementDef, opts: { reason: string }): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      const screen = this.getScreen(screenId);
      if (!screen) throw new AppMapError(ERROR_CODES.NOT_FOUND, `screen ${screenId} is not in the cache`, 'name the screen first (03 §8 name_screen) or reload the map');
      const idx = screen.elements.findIndex((e) => e.id === element.id);
      if (idx >= 0) screen.elements[idx] = element;
      else screen.elements.push(element);
      this.writeScreenRow(screen, this.platform, true);
      this.markDirty('screen', screenId, opts.reason);
    }));
  }
  getRecipe(id: RecipeId): RecipeFile | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT json FROM recipes WHERE id = ?').get(id) as Row | undefined;
      return row ? parseJson<RecipeFile>(row) : undefined;
    });
  }
  listRecipes(opts: { statuses?: RecipeStatus[] } = {}): RecipeFile[] {
    return this.guard(() => {
      const rows = this.stmt('SELECT json, status FROM recipes ORDER BY id').all() as Row[];
      const statuses = opts.statuses ? new Set<string>(opts.statuses) : undefined;
      return rows.filter((r) => !statuses || statuses.has(str(r, 'status'))).map((r) => parseJson<RecipeFile>(r));
    });
  }
  putRecipe(recipe: RecipeFile, opts: { dirty: boolean; reason?: string }): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      this.writeRecipeRow(recipe, opts.dirty);
      if (opts.dirty) this.markDirty('recipe', recipe.id, opts.reason ?? 'put_recipe');
    }));
  }
  setScreenLastSeen(id: ScreenId, ts: Timestamp): void {
    this.assertWritable();
    this.guard(() => {
      this.stmt('UPDATE screens SET last_seen = ? WHERE id = ?').run(ts, id);
    });
  }
  /** `screens.last_seen` as recorded by `setScreenLastSeen` (volatile; never exported) */
  getScreenLastSeen(id: ScreenId): Timestamp | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT last_seen FROM screens WHERE id = ?').get(id) as Row | undefined;
      return row ? optStr(row, 'last_seen') : undefined;
    });
  }
  /** blob sha recorded at load for a screen/recipe/ids/manifest row (export conflict check) */
  getBlobSha(kind: DirtyKind, key: string): string | undefined {
    return this.guard(() => {
      const sql = kind === 'screen' ? 'SELECT blob_sha FROM screens WHERE id = ?'
        : kind === 'recipe' ? 'SELECT blob_sha FROM recipes WHERE id = ?'
          : 'SELECT blob_sha FROM registry WHERE kind = ?';
      const row = this.stmt(sql).get(kind === 'ids' || kind === 'manifest' ? kind : key) as Row | undefined;
      return row ? optStr(row, 'blob_sha') : undefined;
    });
  }
  /** record the blob sha of the file `export` just wrote, so the next export compares against it (03 §4) */
  setBlobSha(kind: DirtyKind, key: string, sha: string | undefined): void {
    this.assertWritable();
    this.guard(() => {
      const sql = kind === 'screen' ? 'UPDATE screens SET blob_sha = ? WHERE id = ?'
        : kind === 'recipe' ? 'UPDATE recipes SET blob_sha = ? WHERE id = ?'
          : 'UPDATE registry SET blob_sha = ? WHERE kind = ?';
      this.stmt(sql).run(sha ?? null, kind === 'ids' || kind === 'manifest' ? kind : key);
    });
  }
  /** ids.yaml as cached (import-router may append screens, 06 R7) */
  getIds(): IdsRegistry | undefined {
    return this.guard(() => {
      const row = this.stmt("SELECT json FROM registry WHERE kind = 'ids'").get() as Row | undefined;
      return row ? parseJson<IdsRegistry>(row) : undefined;
    });
  }
  putIds(ids: IdsRegistry, opts: { dirty: boolean; reason?: string }): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      this.writeRegistryRow('ids', ids, opts.dirty);
      if (opts.dirty) this.markDirty('ids', 'ids', opts.reason ?? 'put_ids');
    }));
  }
  getManifest(): Manifest | undefined {
    return this.guard(() => {
      const row = this.stmt("SELECT json FROM registry WHERE kind = 'manifest'").get() as Row | undefined;
      return row ? parseJson<Manifest>(row) : undefined;
    });
  }
  putManifest(manifest: Manifest, opts: { dirty: boolean; reason?: string }): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      this.writeRegistryRow('manifest', manifest, opts.dirty);
      if (opts.dirty) this.markDirty('manifest', 'manifest', opts.reason ?? 'put_manifest');
    }));
  }
  /**
   * Delete a recipe row — only `import-router --purge-retired` (02 §8), for a recipe already
   * `retired` because the purged screen was retired. `opts.dirty` records the DELETE intent so
   * `export` unlinks the YAML file.
   */
  deleteRecipe(id: RecipeId, opts: { dirty?: boolean; reason?: string } = {}): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      const sha = opts.dirty ? this.getBlobSha('recipe', id) : undefined;
      this.stmt('DELETE FROM recipes WHERE id = ?').run(id);
      this.stmt("DELETE FROM dirty WHERE kind = 'recipe' AND key = ?").run(id);
      if (opts.dirty) this.markDirty('recipe', id, opts.reason ?? 'delete_recipe', true, sha);
    }));
  }

  /**
   * Delete a screen row (+ its elements) — only `import-router --purge-retired` (02 §8).
   * `opts.dirty` records a DELETE intent in the dirty table so `export` unlinks the YAML file
   * (02 §8 "retired … for one release, then deleted"); without it the cache row is simply dropped.
   */
  deleteScreen(id: ScreenId, opts: { dirty?: boolean; reason?: string } = {}): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      const sha = opts.dirty ? this.getBlobSha('screen', id) : undefined;
      this.deleteScreenRows(id);
      if (opts.dirty) this.markDirty('screen', id, opts.reason ?? 'delete_screen', true, sha);
    }));
  }

  // ---- dirty tracking (03 §4) -----------------------------------------------------------------
  listDirty(): DirtyRow[] {
    return this.guard(() => (this.stmt('SELECT kind, key, reason, ts, deleted, blob_sha FROM dirty ORDER BY ts, kind, key').all() as Row[])
      .map((r) => ({
        kind: str(r, 'kind') as DirtyKind, key: str(r, 'key'), reason: str(r, 'reason'), ts: str(r, 'ts'),
        ...(Number(r['deleted'] ?? 0) === 1 ? { deleted: true } : {}),
        ...(optStr(r, 'blob_sha') !== undefined ? { blob_sha: optStr(r, 'blob_sha') as string } : {}),
      })));
  }
  clearDirty(kind: DirtyKind, key: string): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      this.stmt('DELETE FROM dirty WHERE kind = ? AND key = ?').run(kind, key);
      switch (kind) {
        case 'screen':
          this.stmt('UPDATE screens SET dirty = 0 WHERE id = ?').run(key);
          this.stmt('UPDATE elements SET dirty = 0 WHERE screen_id = ?').run(key);
          break;
        case 'recipe':
          this.stmt('UPDATE recipes SET dirty = 0 WHERE id = ?').run(key);
          break;
        default:
          this.stmt('UPDATE registry SET dirty = 0 WHERE kind = ?').run(kind);
      }
    }));
  }

  // ---- counters (volatile, never exported) ----------------------------------------------------
  bumpCounter(kind: CounterKind, key: string, name: CounterName, delta = 1): void {
    this.assertWritable();
    this.guard(() => {
      this.stmt('INSERT INTO counters (kind, key, name, value) VALUES (?, ?, ?, ?) ON CONFLICT(kind, key, name) DO UPDATE SET value = value + excluded.value')
        .run(kind, key, name, delta);
    });
  }
  getCounters(kind: CounterKind, key: string): Partial<Record<CounterName, number>> {
    return this.guard(() => {
      const out: Partial<Record<CounterName, number>> = {};
      for (const r of this.stmt('SELECT name, value FROM counters WHERE kind = ? AND key = ?').all(kind, key) as Row[]) {
        out[str(r, 'name') as CounterName] = num(r, 'value');
      }
      return out;
    });
  }

  // ---- sessions & observations (02 §7, 04 §2) --------------------------------------------------
  private sessionFromRow(r: Row): SessionRow {
    const row: SessionRow = {
      session: str(r, 'session'),
      mode: str(r, 'mode') as SessionMode,
      started_at: str(r, 'started_at'),
      last_seq: num(r, 'last_seq'),
      driver_calls: num(r, 'driver_calls'),
      perception_bytes: num(r, 'perception_bytes'),
      screenshots: num(r, 'screenshots'),
    };
    const task = optStr(r, 'task');
    if (task !== undefined) row.task = task;
    const taskSeq = optNum(r, 'task_seq');
    if (taskSeq !== undefined) row.task_seq = taskSeq;
    const taskEnd = optNum(r, 'task_end_seq');
    if (taskEnd !== undefined) row.task_end_seq = taskEnd;
    return row;
  }
  getSession(session: SessionId): SessionRow | undefined {
    return this.guard(() => {
      const r = this.stmt('SELECT * FROM sessions WHERE session = ?').get(session) as Row | undefined;
      return r ? this.sessionFromRow(r) : undefined;
    });
  }
  /** create if missing; merge provided fields */
  upsertSession(row: Pick<SessionRow, 'session'> & Partial<SessionRow>): SessionRow {
    this.assertWritable();
    if (typeof row.session !== 'string' || row.session.length === 0) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'session id must be a non-empty string', 'pass the harness session_id (05 §3)');
    }
    return this.guard(() => this.transaction(() => {
      this.stmt('INSERT OR IGNORE INTO sessions (session, mode, started_at) VALUES (?, ?, ?)').run(row.session, row.mode ?? 'explore', row.started_at ?? now());
      const sets: string[] = [];
      const args: Array<string | number | null> = [];
      const fields: Array<[keyof SessionRow, unknown]> = [
        ['task', row.task], ['task_seq', row.task_seq], ['task_end_seq', row.task_end_seq], ['mode', row.mode], ['started_at', row.started_at],
        ['last_seq', row.last_seq], ['driver_calls', row.driver_calls], ['perception_bytes', row.perception_bytes], ['screenshots', row.screenshots],
      ];
      for (const [k, v] of fields) {
        if (v === undefined) continue;
        sets.push(`${k} = ?`);
        args.push(v === null ? null : (v as string | number));
      }
      if (sets.length) this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE session = ?`).run(...args, row.session);
      return this.getSession(row.session) as SessionRow;
    }));
  }
  /** allocate the next `seq` for a session atomically (1-based) */
  nextSeq(session: SessionId): number {
    this.assertWritable();
    return this.guard(() => this.transaction(() => {
      this.stmt('INSERT OR IGNORE INTO sessions (session, mode, started_at) VALUES (?, ?, ?)').run(session, 'explore', now());
      const r = this.stmt('UPDATE sessions SET last_seq = last_seq + 1 WHERE session = ? RETURNING last_seq').get(session) as Row;
      return num(r, 'last_seq');
    }));
  }
  /** store the observation including its scrubbed snapshot JSON — PRECONDITION `assertScrubbed(obs.snapshot)` (03 §7, 07 §8); throws `bad_input` otherwise */
  insertObservation(obs: Observation): void {
    this.assertWritable();
    if (typeof obs !== 'object' || obs === null || typeof obs.session !== 'string' || obs.session.length === 0 || !Number.isInteger(obs.seq) || obs.seq < 1) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'observation needs a session id and a positive integer seq', 'allocate seq with db.nextSeq(session) (04 §2)');
    }
    if (obs.snapshot !== null && obs.snapshot !== undefined) assertScrubbed(obs.snapshot, 'db.insertObservation'); // 07 §8: raw trees never touch disk
    const json = JSON.stringify(obs);
    const snapshotBytes = obs.snapshot ? Buffer.byteLength(JSON.stringify(obs.snapshot), 'utf8') : 0;
    this.guard(() => this.transaction(() => {
      this.stmt('INSERT OR IGNORE INTO sessions (session, mode, started_at) VALUES (?, ?, ?)').run(obs.session, 'explore', obs.ts ?? now());
      this.stmt(`INSERT OR REPLACE INTO observations (session, seq, ts, task, tool, element, screen_before, screen_after, ok, latency_ms, snapshot_bytes, json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(obs.session, obs.seq, obs.ts ?? now(), obs.task ?? null, String(obs.tool), obs.element ?? null, String(obs.screen_before), String(obs.screen_after),
          obs.ok ? 1 : 0, Number.isFinite(obs.latency_ms) ? Math.round(obs.latency_ms) : 0, snapshotBytes, json);
      // keep `nextSeq` monotonic even when the caller supplied seq (tests, `record --stdin` replays)
      this.stmt('UPDATE sessions SET last_seq = max(last_seq, ?) WHERE session = ?').run(obs.seq, obs.session);
    }));
  }
  /** newest observation for `session`, or across all sessions when omitted (single-window convenience; runs must pass a session) */
  lastObservation(session?: SessionId): Observation | undefined {
    return this.guard(() => {
      const row = session === undefined
        ? this.stmt('SELECT json FROM observations ORDER BY ts DESC, rowid DESC LIMIT 1').get() as Row | undefined
        : this.stmt('SELECT json FROM observations WHERE session = ? ORDER BY seq DESC LIMIT 1').get(session) as Row | undefined;
      return row ? parseJson<Observation>(row) : undefined;
    });
  }
  /** observations of a session in seq order, optionally from `fromSeq` (inclusive) */
  listObservations(session: SessionId, opts: { fromSeq?: number; toSeq?: number } = {}): Observation[] {
    return this.guard(() => {
      const rows = this.stmt('SELECT json FROM observations WHERE session = ? AND seq >= ? AND seq <= ? ORDER BY seq')
        .all(session, opts.fromSeq ?? 0, opts.toSeq ?? Number.MAX_SAFE_INTEGER) as Row[];
      return rows.map((r) => parseJson<Observation>(r));
    });
  }

  // ---- guided runs (04 §5) ----------------------------------------------------------------------
  private writeRun(run: RunRecord, replace: boolean): void {
    this.stmt(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO runs (run_id, recipe_id, version, mode, session, state, current_step, step_index, ok, heals, fallbacks, build, started_at, finished_at, json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(run.run_id, run.recipe, run.version, run.mode, run.session, run.state, run.current_step, run.step_index, runOk(run.state),
        run.heals.length, run.fallbacks, run.build, run.started_at, run.finished_at ?? null, JSON.stringify(run));
  }
  insertRun(run: RunRecord): void {
    this.assertWritable();
    if (typeof run.session !== 'string' || run.session.length === 0) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `run ${run.run_id} has no session`, 'a run is always pinned to the session whose observations verify it (04 §5)');
    }
    this.guard(() => this.transaction(() => {
      if (this.getRun(run.run_id)) throw new AppMapError(ERROR_CODES.BAD_INPUT, `run ${run.run_id} already exists`, 'use updateRun to change an existing run');
      this.writeRun(run, false);
    }));
  }
  getRun(runId: RunId): RunRecord | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT json FROM runs WHERE run_id = ?').get(runId) as Row | undefined;
      return row ? parseJson<RunRecord>(row) : undefined;
    });
  }
  updateRun(run: RunRecord): void {
    this.assertWritable();
    this.guard(() => this.transaction(() => {
      if (!this.getRun(run.run_id)) throw new AppMapError(ERROR_CODES.RUN_NOT_ACTIVE, `run ${run.run_id} is unknown`, 'start it with run_recipe first (03 §8)');
      this.writeRun(run, true);
    }));
  }
  insertRunStep(rec: RunStepRecord): void {
    this.assertWritable();
    this.guard(() => {
      this.stmt(`INSERT OR REPLACE INTO run_steps (run_id, step_id, attempt, gate_dismissals, heals, ok, ts, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rec.run_id, rec.step_id, rec.attempt, rec.gate_dismissals, rec.heals, rec.ok === undefined ? null : (rec.ok ? 1 : 0), rec.ts, JSON.stringify(rec));
    });
  }
  listRunSteps(runId: RunId): RunStepRecord[] {
    return this.guard(() => (this.stmt('SELECT json FROM run_steps WHERE run_id = ? ORDER BY ts, attempt, step_id').all(runId) as Row[]).map((r) => parseJson<RunStepRecord>(r)));
  }
  /** newest attempt row for a step (attempt count = gate dismissals/heals bookkeeping) */
  getRunStep(runId: RunId, stepId: string): RunStepRecord | undefined {
    return this.guard(() => {
      const row = this.stmt('SELECT json FROM run_steps WHERE run_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1').get(runId, stepId) as Row | undefined;
      return row ? parseJson<RunStepRecord>(row) : undefined;
    });
  }
  listRuns(opts: { recipe?: RecipeId; since?: Timestamp; limit?: number } = {}): RunRecord[] {
    return this.guard(() => {
      const where: string[] = [];
      const args: Array<string | number> = [];
      if (opts.recipe !== undefined) {
        where.push('recipe_id = ?');
        args.push(opts.recipe);
      }
      if (opts.since !== undefined) {
        where.push('started_at >= ?');
        args.push(opts.since);
      }
      const limit = opts.limit !== undefined && Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : -1;
      const sql = `SELECT json FROM runs${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC, rowid DESC LIMIT ?`;
      return (this.stmt(sql).all(...args, limit) as Row[]).map((r) => parseJson<RunRecord>(r));
    });
  }
  /** aggregates from `runs` + `elements.status` for lifecycle decisions */
  recipeStats(recipe: RecipeId, opts: { currentBuild: BuildNumber; lastN?: number }): RecipeStats {
    return this.guard(() => {
      // only finished runs count as outcomes; an active run is neither a success nor a failure
      const rows = this.stmt("SELECT session, state, fallbacks, build, started_at FROM runs WHERE recipe_id = ? AND state != 'active' ORDER BY started_at DESC, rowid DESC").all(recipe) as Row[];
      const lastN = opts.lastN ?? 10;
      const stats: RecipeStats = { recipe, runs: rows.length, successes: 0, fallbacks: 0, success_sessions: 0, builds: [], last_runs: [], heals_pending: 0, fallback_rate_current_build: 0 };
      const sessions = new Set<string>();
      const builds = new Map<string, { build: BuildNumber; runs: number; successes: number }>();
      let currentRuns = 0;
      let currentFallbackRuns = 0;
      for (const r of rows) {
        const ok = str(r, 'state') === 'done';
        const fallbacks = num(r, 'fallbacks');
        const build = str(r, 'build');
        if (ok) {
          stats.successes += 1;
          sessions.add(str(r, 'session'));
        }
        stats.fallbacks += fallbacks;
        const b = builds.get(build) ?? { build, runs: 0, successes: 0 };
        b.runs += 1;
        if (ok) b.successes += 1;
        builds.set(build, b);
        if (stats.last_runs.length < lastN) stats.last_runs.push(ok);
        if (build === opts.currentBuild) {
          currentRuns += 1;
          if (fallbacks > 0) currentFallbackRuns += 1;
        }
      }
      stats.success_sessions = sessions.size;
      stats.builds = [...builds.values()].sort((a, b) => (a.build < b.build ? -1 : a.build > b.build ? 1 : 0));
      stats.fallback_rate_current_build = currentRuns === 0 ? 0 : currentFallbackRuns / currentRuns;
      // elements the recipe's steps touch that are awaiting review (04 §7.2)
      const rec = this.getRecipe(recipe);
      if (rec) {
        const touched = new Set<string>();
        for (const step of rec.steps) {
          const el = stepElement(step);
          if (el !== undefined) touched.add(el);
        }
        if (touched.size) {
          const placeholders = [...touched].map(() => '?').join(', ');
          const row = this.db.prepare(`SELECT count(*) AS n FROM elements WHERE status = 'healed_pending_review' AND id IN (${placeholders})`).get(...touched) as Row;
          stats.heals_pending = num(row, 'n');
        }
      }
      return stats;
    });
  }

  /** runs of a session in a given state (Stop-hook outcome inference, observe.inferTaskOutcome) */
  listRunsForSession(session: SessionId, opts: { states?: RunRecord['state'][] } = {}): RunRecord[] {
    return this.guard(() => {
      const rows = this.stmt('SELECT json, state FROM runs WHERE session = ? ORDER BY started_at DESC, rowid DESC').all(session) as Row[];
      const states = opts.states ? new Set<string>(opts.states) : undefined;
      return rows.filter((r) => !states || states.has(str(r, 'state'))).map((r) => parseJson<RunRecord>(r));
    });
  }

  /** delete observations/runs older than `before` (retention, 07 §2.4) */
  pruneBefore(before: Timestamp): { observations: number; runs: number } {
    this.assertWritable();
    return this.guard(() => this.transaction(() => {
      const obs = this.stmt('DELETE FROM observations WHERE ts < ?').run(before).changes;
      this.stmt('DELETE FROM run_steps WHERE run_id IN (SELECT run_id FROM runs WHERE started_at < ?)').run(before);
      const runs = this.stmt('DELETE FROM runs WHERE started_at < ?').run(before).changes;
      // a session whose observations are all gone carries nothing worth keeping
      this.stmt('DELETE FROM sessions WHERE started_at < ? AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session = sessions.session)').run(before);
      return { observations: Number(obs), runs: Number(runs) };
    }));
  }

  /** elements with `status: healed_pending_review` across the map (08 §4 pending-review count) */
  listPendingHeals(): Array<{ screen: ScreenId; element: ElementId }> {
    return this.guard(() => (this.stmt("SELECT screen_id, id FROM elements WHERE status = 'healed_pending_review' ORDER BY screen_id, id").all() as Row[])
      .map((r) => ({ screen: str(r, 'screen_id'), element: str(r, 'id') })));
  }
}

/** `AppMapDb.open(config, opts)` as a function, for call sites that prefer it. */
export function openDb(config: AppMapConfig, opts: OpenDbOptions = {}): AppMapDb {
  return AppMapDb.open(config, opts);
}

/** The DDL, exported so tests and docs can assert it (see architecture.md). */
export const DDL: string = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  last_verified_build TEXT, blob_sha TEXT, json TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, last_seen TEXT);
CREATE TABLE IF NOT EXISTS elements (
  screen_id TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
  intent_critical INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (screen_id, id));
CREATE INDEX IF NOT EXISTS elements_by_id ON elements (id);
CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY, platform TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL,
  blob_sha TEXT, json TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY, recipe_id TEXT NOT NULL, version INTEGER NOT NULL, mode TEXT NOT NULL,
  session TEXT NOT NULL, state TEXT NOT NULL, current_step TEXT NOT NULL, step_index INTEGER NOT NULL,
  ok INTEGER, heals INTEGER NOT NULL DEFAULT 0, fallbacks INTEGER NOT NULL DEFAULT 0,
  build TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_by_recipe ON runs (recipe_id, started_at);
CREATE TABLE IF NOT EXISTS run_steps (
  run_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt INTEGER NOT NULL,
  gate_dismissals INTEGER NOT NULL DEFAULT 0, heals INTEGER NOT NULL DEFAULT 0, ok INTEGER,
  ts TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (run_id, step_id, attempt));
CREATE TABLE IF NOT EXISTS observations (
  session TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, task TEXT, tool TEXT NOT NULL,
  element TEXT, screen_before TEXT NOT NULL, screen_after TEXT NOT NULL, ok INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL, snapshot_bytes INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL,
  PRIMARY KEY (session, seq));
CREATE INDEX IF NOT EXISTS observations_by_ts ON observations (ts);
CREATE TABLE IF NOT EXISTS registry (
  kind TEXT PRIMARY KEY, blob_sha TEXT, json TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY, task TEXT, task_seq INTEGER, task_end_seq INTEGER, mode TEXT NOT NULL DEFAULT 'explore',
  started_at TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, driver_calls INTEGER NOT NULL DEFAULT 0,
  perception_bytes INTEGER NOT NULL DEFAULT 0, screenshots INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS counters (
  kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key, name));
CREATE TABLE IF NOT EXISTS dirty (
  kind TEXT NOT NULL, key TEXT NOT NULL, reason TEXT NOT NULL, ts TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0, blob_sha TEXT, PRIMARY KEY (kind, key));
`;
