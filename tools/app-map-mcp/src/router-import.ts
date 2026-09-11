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
 *  - gates in the export are checked against `ids.yaml` (missing → error listing them; ids.yaml
 *    is hand-maintained, 01 R1);
 *  - the manifest `build` is refreshed from the export's `build` when newer.
 * Screen ids must exist in `ids.yaml` (otherwise `invalid_map` naming them — the registry is
 * the source of truth). Writes go to the cache as dirty; `export` produces the diff (06 R7 PR).
 *
 * Layer: session (imports context, types, yaml/schemas, lifecycle).
 */
import type { AppMapContext } from './context.ts';
import type { BuildInfo, ImportRouterResult, RouterExport, RouterExportScreen, ScreenFile } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface ImportRouterOptions {
  /** retire screens missing from the export (default true) */
  retire?: boolean;
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
