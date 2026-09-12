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
import type { BuildInfo, Edge, IdsRegistry, ImportRouterResult, Manifest, RecipeId, RouterExport, RouterExportScreen, ScreenFile, ScreenId, ScreenSource } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { schemaDir } from './paths.ts';
import { assertValid } from './yaml/schemas.ts';
import { retireRecipesForScreen } from './recipes/lifecycle.ts';

export interface ImportRouterOptions {
  /** retire screens missing from the export (default true) */
  retire?: boolean;
  /** error (`invalid_map`) on exported screens not in ids.yaml instead of registering them (default false; `--strict`) */
  strict?: boolean;
  /** delete screens retired on an earlier build (default false; `--purge-retired`) */
  purgeRetired?: boolean;
  dryRun?: boolean;
  /** `lifecycle.retireRecipesForScreen` (02 §8 "recipes depending on it become retired"); injected in tests */
  retireRecipes?: (ctx: AppMapContext, screen: ScreenId) => RecipeId[];
}

/** stable identity of an edge: its action shape plus its target (02 §4.2) */
function edgeKey(edge: Pick<Edge, 'action' | 'to'>): string {
  const a = edge.action;
  const target = 'element' in a && a.element !== undefined ? a.element : 'url' in a ? a.url : 'gate' in a ? a.gate : '';
  const direction = 'direction' in a && a.direction !== undefined ? a.direction : '';
  return `${a.type}|${target}|${direction}|${edge.to}`;
}

/** build numbers compare numerically only when both parse as integers (architecture decision 18) */
function isNewerBuild(candidate: string | undefined, current: string | undefined): boolean {
  if (candidate === undefined) return false;
  if (current === undefined) return true;
  const a = Number(candidate);
  const b = Number(current);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  return a > b;
}

function withSource(sources: readonly ScreenSource[] | undefined, source: ScreenSource): { sources: ScreenSource[]; changed: boolean } {
  const list = [...(sources ?? [])];
  if (list.includes(source)) return { sources: list, changed: false };
  list.push(source);
  list.sort();
  return { sources: list, changed: true };
}

/** Pure: a fresh candidate screen from one export entry. */
export function routerScreenToScreenFile(rs: RouterExportScreen, build: BuildInfo): ScreenFile {
  // `build` is deliberately not stamped anywhere: a screen seeded from the router export has
  // never been verified against a hierarchy, so it carries no `last_verified_build` (02 §8).
  void build;
  const screen: ScreenFile = {
    id: rs.id,
    kind: 'screen',
    deep_link: rs.route,
    signature: {
      marker: `screen.${rs.id}`,
      ...(rs.route && rs.route !== 'none' ? { route: rs.route } : {}),
      ...(rs.view_type ? { nav_class: rs.view_type } : {}),
    },
    elements: [],
    edges: (rs.edges ?? []).map((e) => ({ action: e.action, to: e.to, status: 'candidate' as const })),
    meta: { sources: ['router_export'], status: 'candidate' },
  };
  if (rs.title !== undefined) screen.title = rs.title;
  return screen;
}

/** Pure: merge an export entry into an existing screen; `changed` false when nothing differs. */
export function mergeRouterScreen(existing: ScreenFile, rs: RouterExportScreen): { screen: ScreenFile; changed: boolean; edges_added: number } {
  const screen: ScreenFile = structuredClone(existing);
  let changed = false;
  if (rs.title !== undefined && screen.title !== rs.title) {
    screen.title = rs.title;
    changed = true;
  }
  if (rs.route !== undefined && screen.deep_link !== rs.route) {
    // 01 R5: the screen file may carry a richer link (`?fixture=…`); only refresh the route key
    const routeKey = (s: string | undefined): string | undefined => s?.split('?')[0];
    if (routeKey(screen.deep_link) !== routeKey(rs.route)) {
      screen.deep_link = rs.route;
      changed = true;
    }
  }
  const sig = screen.signature ?? { marker: `screen.${screen.id}` };
  const route = rs.route && rs.route !== 'none' ? rs.route : undefined;
  if (route !== undefined && sig.route?.split('?')[0] !== route.split('?')[0]) {
    sig.route = route;
    changed = true;
  }
  if (rs.view_type && sig.nav_class !== rs.view_type) {
    sig.nav_class = rs.view_type;
    changed = true;
  }
  screen.signature = sig;

  // edges: add what is new, never remove (a verified edge the export forgot stays, 02 §8)
  const present = new Set((screen.edges ?? []).map(edgeKey));
  let edges_added = 0;
  for (const e of rs.edges ?? []) {
    const key = edgeKey(e);
    if (present.has(key)) continue;
    present.add(key);
    screen.edges = [...(screen.edges ?? []), { action: e.action, to: e.to, status: 'candidate' }];
    edges_added++;
    changed = true;
  }

  const sources = withSource(screen.meta?.sources, 'router_export');
  if (sources.changed) {
    screen.meta = { ...(screen.meta ?? { status: 'candidate', sources: [] }), sources: sources.sources };
    changed = true;
  }
  // a screen that came back into the export is no longer retired (02 §8)
  if (screen.meta?.status === 'retired') {
    screen.meta = { ...screen.meta, status: 'candidate' };
    changed = true;
  }
  return { screen, changed, edges_added };
}

export function importRouter(ctx: AppMapContext, doc: RouterExport, opts: ImportRouterOptions = {}): ImportRouterResult {
  // 01 R6: the export is app-produced input — validate before anything touches the cache.
  assertValid<RouterExport>(schemaDir(ctx.config), 'router-export', doc, 'router-export.json');
  if (doc.platform !== ctx.config.platform) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `router export is for ${doc.platform}, this server serves ${ctx.config.platform}`, 'set APP_MAP_PLATFORM or pass the matching export');
  }
  const retire = opts.retire ?? true;
  const dryRun = opts.dryRun === true;
  const retireRecipes = opts.retireRecipes ?? retireRecipesForScreen;

  const ids: IdsRegistry = structuredClone(ctx.db.getIds() ?? ctx.map.ids);
  const registered = new Set(ids.screens.map((s) => s.id));
  const registeredGates = new Set(ids.gates.map((g) => g.id));

  // gates: their dismiss control is app code (01 R7) — the registry must already know them
  const unknownGates = (doc.gates ?? []).map((g) => g.id).filter((id) => !registeredGates.has(id));
  if (unknownGates.length > 0) {
    throw new AppMapError(
      ERROR_CODES.INVALID_MAP,
      `router export references unregistered gates: ${unknownGates.join(', ')}`,
      'register the gate and its dismiss control in app-map/ids.yaml first (01 R7)',
    );
  }

  const result: ImportRouterResult = { created: [], updated: [], retired: [], unchanged: [], edges_added: 0, unregistered: [], purged: [], build_updated: false };
  const exported = new Map<ScreenId, RouterExportScreen>();
  for (const rs of doc.screens) exported.set(rs.id, rs);

  const unregistered: RouterExportScreen[] = [];
  const writes: Array<{ screen: ScreenFile; reason: string }> = [];

  for (const rs of [...exported.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (!registered.has(rs.id)) unregistered.push(rs);
    const existing = ctx.db.getScreen(rs.id) ?? ctx.map.screens.get(rs.id);
    if (!existing) {
      writes.push({ screen: routerScreenToScreenFile(rs, doc.build), reason: 'import_router' });
      result.created.push(rs.id);
      result.edges_added += (rs.edges ?? []).length;
      continue;
    }
    const merged = mergeRouterScreen(existing, rs);
    result.edges_added += merged.edges_added;
    if (merged.changed) {
      writes.push({ screen: merged.screen, reason: 'import_router' });
      result.updated.push(rs.id);
    } else {
      result.unchanged.push(rs.id);
    }
  }

  // 06 R7 / decision 40: an unknown screen is registered so the PR carries ids.yaml and the
  // screen file together; `--strict` refuses instead (interactive use).
  if (unregistered.length > 0) {
    if (opts.strict) {
      throw new AppMapError(
        ERROR_CODES.INVALID_MAP,
        `router export contains screens missing from ids.yaml: ${unregistered.map((s) => s.id).join(', ')}`,
        'run `app-map import-router` without --strict to register them, or add them to app-map/ids.yaml (01 R1)',
      );
    }
    for (const rs of unregistered) {
      ids.screens.push({ id: rs.id, ...(rs.title !== undefined ? { title: rs.title } : {}), ...(rs.route ? { deep_link: rs.route } : {}) });
      result.unregistered.push(rs.id);
    }
    ids.screens.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // screens the export no longer mentions (02 §8: retire for one release, then delete)
  const known: ScreenFile[] = ctx.db.listScreens().length > 0 ? ctx.db.listScreens() : Array.from(ctx.map.screens.values());
  const retirements: ScreenFile[] = [];
  const purges: ScreenId[] = [];
  for (const screen of known) {
    if (screen.kind !== 'screen' || exported.has(screen.id)) continue;
    const fromRouter = (screen.meta?.sources ?? []).includes('router_export');
    if (!fromRouter) continue;
    if (screen.meta?.status === 'retired') {
      if (opts.purgeRetired && isNewerBuild(doc.build.build_number, screen.meta.last_verified_build)) purges.push(screen.id);
      continue;
    }
    if (!retire) continue;
    retirements.push({ ...screen, meta: { ...screen.meta, status: 'retired' } });
  }

  const manifest: Manifest | undefined = ctx.db.getManifest() ?? ctx.map.manifest;
  const bumpBuild = manifest !== undefined && isNewerBuild(doc.build.build_number, manifest.build?.build_number);

  if (dryRun) {
    result.retired = retirements.map((s) => s.id);
    result.purged = purges;
    result.build_updated = bumpBuild;
    return result;
  }

  for (const w of writes) ctx.db.putScreen(w.screen, { dirty: true, reason: w.reason });
  for (const screen of retirements) {
    ctx.db.putScreen(screen, { dirty: true, reason: 'import_router_retire' });
    result.retired.push(screen.id);
    const recipes = retireRecipes(ctx, screen.id);
    if (recipes.length > 0) ctx.log.info('import-router: retired recipes for a retired screen', { screen: screen.id, recipes });
  }
  for (const id of purges) {
    ctx.db.deleteScreen(id);
    result.purged.push(id);
  }
  if (result.unregistered.length > 0) ctx.db.putIds(ids, { dirty: true, reason: 'import_router' });
  if (bumpBuild && manifest) {
    ctx.db.putManifest({ ...manifest, build: doc.build }, { dirty: true, reason: 'import_router' });
    result.build_updated = true;
  }
  return result;
}
