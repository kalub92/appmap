/**
 * [A2] SQLite cache (02 §7, 03 §4) on `node:sqlite` (`DatabaseSync`), WAL mode, short
 * transactions so many server instances share `.local/cache.sqlite` safely (03 §2, 03 §12 WAL
 * stress test). Schema is documented in docs/dev/architecture.md ("SQLite schema"); it is
 * regenerable from YAML + logs and versioned via `meta.schema_version` (recreate on mismatch).
 *
 * Tables: `meta`, `screens`, `elements`, `recipes`, `runs`, `run_steps`, `observations`,
 * `sessions`, `counters`, `dirty`. Durable entities are stored as JSON blobs (`json` column) plus
 * the columns needed for queries; `dirty` marks what `export` must write (03 §4 write path).
 *
 * Layer: store (imports types/config/paths/errors + yaml/load for `LoadedMap`).
 */
import type { AppMapConfig } from '../config.ts';
import type {
  BuildNumber, ElementDef, ElementId, LoadedMap, Observation, RecipeFile, RecipeId, RecipeStatus, RunId, RunRecord,
  RunStepRecord, ScreenFile, ScreenId, SessionId, SessionMode, Timestamp,
} from '../types.ts';
import { NotImplementedError } from '../errors.ts';

/** bump when the SQL schema changes; a mismatch drops and recreates the cache */
export const DB_SCHEMA_VERSION = 1;

export type CounterKind = 'element' | 'recipe' | 'screen';
/** per-element `hits|misses|heals`; per-recipe `runs|replay_success|fallbacks|guided_runs|headless_runs`; per-screen `seen` (02 §7) */
export type CounterName = 'hits' | 'misses' | 'heals' | 'runs' | 'replay_success' | 'fallbacks' | 'guided_runs' | 'headless_runs' | 'seen';

export type DirtyKind = 'screen' | 'recipe';
export interface DirtyRow { kind: DirtyKind; key: string; reason: string; ts: Timestamp }

export interface SessionRow {
  session: SessionId;
  task?: string;
  /** seq at which the task was declared (observations before it are not compilable, 04 §2) */
  task_seq?: number;
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

/**
 * Handle over the cache. Every method is synchronous (node:sqlite is sync) and wraps its writes
 * in a transaction. Throws `AppMapError(storage)` on SQLite errors.
 */
export class AppMapDb {
  readonly path: string;

  private constructor(path: string) {
    this.path = path;
  }

  /** Open (creating schema / WAL as needed) — the only constructor. */
  static open(config: AppMapConfig, opts: OpenDbOptions = {}): AppMapDb {
    void config; void opts;
    throw new NotImplementedError('store/db.AppMapDb.open');
  }

  close(): void {
    throw new NotImplementedError('store/db.AppMapDb.close');
  }

  /** run `fn` inside BEGIN IMMEDIATE … COMMIT (rollback on throw); nested calls join the outer transaction */
  transaction<T>(fn: () => T): T {
    void fn;
    throw new NotImplementedError('store/db.AppMapDb.transaction');
  }

  // ---- meta -----------------------------------------------------------------------------------
  /** keys used: `schema_version`, `tree_hash`, `loaded_at`, `platform`, `build`, `last_retention_run` */
  getMeta(key: string): string | undefined {
    void key;
    throw new NotImplementedError('store/db.AppMapDb.getMeta');
  }
  setMeta(key: string, value: string): void {
    void key; void value;
    throw new NotImplementedError('store/db.AppMapDb.setMeta');
  }

  // ---- map (durable entities) -----------------------------------------------------------------
  /**
   * Replace screens/elements/recipes with the loaded map, preserving rows that are `dirty`
   * (session edits not yet exported) and every counter. Records `tree_hash`/`loaded_at` in meta.
   */
  upsertMap(map: LoadedMap): void {
    void map;
    throw new NotImplementedError('store/db.AppMapDb.upsertMap');
  }
  getScreen(id: ScreenId): ScreenFile | undefined {
    void id;
    throw new NotImplementedError('store/db.AppMapDb.getScreen');
  }
  listScreens(): ScreenFile[] {
    throw new NotImplementedError('store/db.AppMapDb.listScreens');
  }
  /** insert or replace; `dirty` marks it for export with `reason` (e.g. `name_screen`, `heal`, `import_router`) */
  putScreen(screen: ScreenFile, opts: { dirty: boolean; reason?: string }): void {
    void screen; void opts;
    throw new NotImplementedError('store/db.AppMapDb.putScreen');
  }
  /** replace one element inside a screen (heal path, 04 §7.2); marks the screen dirty */
  putElement(screenId: ScreenId, element: ElementDef, opts: { reason: string }): void {
    void screenId; void element; void opts;
    throw new NotImplementedError('store/db.AppMapDb.putElement');
  }
  getRecipe(id: RecipeId): RecipeFile | undefined {
    void id;
    throw new NotImplementedError('store/db.AppMapDb.getRecipe');
  }
  listRecipes(opts: { statuses?: RecipeStatus[] } = {}): RecipeFile[] {
    void opts;
    throw new NotImplementedError('store/db.AppMapDb.listRecipes');
  }
  putRecipe(recipe: RecipeFile, opts: { dirty: boolean; reason?: string }): void {
    void recipe; void opts;
    throw new NotImplementedError('store/db.AppMapDb.putRecipe');
  }
  setScreenLastSeen(id: ScreenId, ts: Timestamp): void {
    void id; void ts;
    throw new NotImplementedError('store/db.AppMapDb.setScreenLastSeen');
  }

  // ---- dirty tracking (03 §4) -----------------------------------------------------------------
  listDirty(): DirtyRow[] {
    throw new NotImplementedError('store/db.AppMapDb.listDirty');
  }
  clearDirty(kind: DirtyKind, key: string): void {
    void kind; void key;
    throw new NotImplementedError('store/db.AppMapDb.clearDirty');
  }

  // ---- counters (volatile, never exported) ----------------------------------------------------
  bumpCounter(kind: CounterKind, key: string, name: CounterName, delta = 1): void {
    void kind; void key; void name; void delta;
    throw new NotImplementedError('store/db.AppMapDb.bumpCounter');
  }
  getCounters(kind: CounterKind, key: string): Partial<Record<CounterName, number>> {
    void kind; void key;
    throw new NotImplementedError('store/db.AppMapDb.getCounters');
  }

  // ---- sessions & observations (02 §7, 04 §2) --------------------------------------------------
  getSession(session: SessionId): SessionRow | undefined {
    void session;
    throw new NotImplementedError('store/db.AppMapDb.getSession');
  }
  /** create if missing; merge provided fields */
  upsertSession(row: Pick<SessionRow, 'session'> & Partial<SessionRow>): SessionRow {
    void row;
    throw new NotImplementedError('store/db.AppMapDb.upsertSession');
  }
  /** allocate the next `seq` for a session atomically (1-based) */
  nextSeq(session: SessionId): number {
    void session;
    throw new NotImplementedError('store/db.AppMapDb.nextSeq');
  }
  /** store the observation including its scrubbed snapshot JSON (raw trees never reach here) */
  insertObservation(obs: Observation): void {
    void obs;
    throw new NotImplementedError('store/db.AppMapDb.insertObservation');
  }
  /** newest observation for `session`, or across all sessions when omitted */
  lastObservation(session?: SessionId): Observation | undefined {
    void session;
    throw new NotImplementedError('store/db.AppMapDb.lastObservation');
  }
  /** observations of a session in seq order, optionally from `fromSeq` (inclusive) */
  listObservations(session: SessionId, opts: { fromSeq?: number; toSeq?: number } = {}): Observation[] {
    void session; void opts;
    throw new NotImplementedError('store/db.AppMapDb.listObservations');
  }

  // ---- guided runs (04 §5) ----------------------------------------------------------------------
  insertRun(run: RunRecord): void {
    void run;
    throw new NotImplementedError('store/db.AppMapDb.insertRun');
  }
  getRun(runId: RunId): RunRecord | undefined {
    void runId;
    throw new NotImplementedError('store/db.AppMapDb.getRun');
  }
  updateRun(run: RunRecord): void {
    void run;
    throw new NotImplementedError('store/db.AppMapDb.updateRun');
  }
  insertRunStep(rec: RunStepRecord): void {
    void rec;
    throw new NotImplementedError('store/db.AppMapDb.insertRunStep');
  }
  listRunSteps(runId: RunId): RunStepRecord[] {
    void runId;
    throw new NotImplementedError('store/db.AppMapDb.listRunSteps');
  }
  /** newest attempt row for a step (attempt count = gate dismissals/heals bookkeeping) */
  getRunStep(runId: RunId, stepId: string): RunStepRecord | undefined {
    void runId; void stepId;
    throw new NotImplementedError('store/db.AppMapDb.getRunStep');
  }
  listRuns(opts: { recipe?: RecipeId; since?: Timestamp; limit?: number } = {}): RunRecord[] {
    void opts;
    throw new NotImplementedError('store/db.AppMapDb.listRuns');
  }
  /** aggregates from `runs` + `elements.status` for lifecycle decisions */
  recipeStats(recipe: RecipeId, opts: { currentBuild: BuildNumber; lastN?: number }): RecipeStats {
    void recipe; void opts;
    throw new NotImplementedError('store/db.AppMapDb.recipeStats');
  }

  /** delete observations/runs older than `before` (retention, 07 §2.4) */
  pruneBefore(before: Timestamp): { observations: number; runs: number } {
    void before;
    throw new NotImplementedError('store/db.AppMapDb.pruneBefore');
  }

  /** elements with `status: healed_pending_review` across the map (08 §4 pending-review count) */
  listPendingHeals(): Array<{ screen: ScreenId; element: ElementId }> {
    throw new NotImplementedError('store/db.AppMapDb.listPendingHeals');
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
  session TEXT, state TEXT NOT NULL, current_step TEXT NOT NULL, step_index INTEGER NOT NULL,
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
CREATE TABLE IF NOT EXISTS sessions (
  session TEXT PRIMARY KEY, task TEXT, task_seq INTEGER, mode TEXT NOT NULL DEFAULT 'explore',
  started_at TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, driver_calls INTEGER NOT NULL DEFAULT 0,
  perception_bytes INTEGER NOT NULL DEFAULT 0, screenshots INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS counters (
  kind TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, value INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (kind, key, name));
CREATE TABLE IF NOT EXISTS dirty (
  kind TEXT NOT NULL, key TEXT NOT NULL, reason TEXT NOT NULL, ts TEXT NOT NULL, PRIMARY KEY (kind, key));
`;
