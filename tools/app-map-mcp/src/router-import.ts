/**
 * [C3] `app-map import-router <json>` (01 R6, 02 §8, 06 R7): seed or refresh screens from the
 * app's router export.
 *
 * For each exported screen (validated against `router-export.schema.json`):
 *  - new id → create a `ScreenFile` with `signature {marker: screen.<id>, route, nav_class:
 *    view_type}`, `deep_link: route`, `title`, `elements: []`, `edges` from the export
 *    (`status: candidate`), `meta {sources: [router_export], status: candidate}`;
 *  - existing → merge: refresh `route`/`nav_class`/`deep_link`/`title`, add edges that are not
 *    present (keyed by `(action, to)`), never remove elements, locators or verified edges,
 *    add `router_export` to `meta.sources`;
 *  - screens in the map (`sources` includes `router_export`) but absent from the export →
 *    `meta.status: retired` (not deleted; 02 §8) when `opts.retire` (default true), and
 *    dependent recipes are retired (lifecycle.retireRecipesForScreen);
 *  - a screen id absent from `ids.yaml` is appended to `screens[]` (`{id, title?, deep_link}`)
 *    via `db.putIds(..., {dirty: true, reason: 'import_router'})` and reported in
 *    `unregistered` so the 06 R7 PR carries the registry change and the new screen file
 *    together (01 R6 "seeds or refreshes"); with `opts.strict` it is `invalid_map` naming the
 *    ids instead (interactive use). Gates in the export must already be registered (their
 *    dismiss control is app code — `invalid_map` listing them);
 *  - `opts.purgeRetired`: a screen already `retired` whose `meta.last_verified_build` (or the
 *    build it was retired on, tracked in `meta` via `last_verified_build` staying as-is) is
 *    older than the export's build is deleted (`db.deleteScreen`, file removed by `export`) —
 *    02 §8 "retired for one release, then deleted"; reported in `purged`;
 *  - the manifest `build` is refreshed from the export's `build` when newer
 *    (`db.putManifest`, `build_updated: true`).
 * Writes go to the cache as dirty; `export` produces the diff (06 R7 PR).
 *
 * Layer: session (imports context, types, yaml/schemas, lifecycle).
 */
import type { AppMapContext } from './context.ts';
import type { BuildInfo, ImportRouterResult, RouterExport, RouterExportScreen, ScreenFile } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface ImportRouterOptions {
  /** retire screens missing from the export (default true) */
  retire?: boolean;
  /** error (`invalid_map`) on exported screens not in ids.yaml instead of registering them (default false; `--strict`) */
  strict?: boolean;
  /** delete screens retired on an earlier build (default false; `--purge-retired`) */
  purgeRetired?: boolean;
  dryRun?: boolean;
}

export function importRouter(ctx: AppMapContext, doc: RouterExport, opts: ImportRouterOptions = {}): ImportRouterResult {
  void ctx; void doc; void opts;
  throw new NotImplementedError('router-import.importRouter');
}

/** Pure: a fresh candidate screen from one export entry. */
export function routerScreenToScreenFile(rs: RouterExportScreen, build: BuildInfo): ScreenFile {
  void rs; void build;
  throw new NotImplementedError('router-import.routerScreenToScreenFile');
}

/** Pure: merge an export entry into an existing screen; `changed` false when nothing differs. */
export function mergeRouterScreen(existing: ScreenFile, rs: RouterExportScreen): { screen: ScreenFile; changed: boolean; edges_added: number } {
  void existing; void rs;
  throw new NotImplementedError('router-import.mergeRouterScreen');
}
