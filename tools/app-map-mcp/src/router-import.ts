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
 *    older than the export's build is deleted (`db.deleteScreen(id, {dirty:true})`, whose YAML
 *    file `export` then unlinks) — 02 §8 "retired for one release, then deleted"; reported in
 *    `purged`. A purge must leave the map referentially whole (02 §10 rule 3), so it also
 *    (a) drops the screen from `ids.yaml` (`screens[]`, dirty), (b) strips every surviving
 *    screen's edges whose `to` is the purged screen (and their postconditions naming it), and
 *    (c) deletes the recipes that were retired with it (`purged_recipes`) — they reference a
 *    screen file that no longer exists;
 *  - the manifest `build` is refreshed from the export's `build` unless that build is demonstrably
 *    OLDER — so a `build_number` that does not compare numerically (`1.2.3`, `4413-rc1`) still
 *    advances, instead of the manifest claiming build 1 for ever while the merge appends every
 *    later build's edges (02 §10 rule 2's stale-capture subject reads that build; issue #12)
 *    (`db.putManifest`, `build_updated: true`).
 * Writes go to the cache as dirty; `export` produces the diff (06 R7 PR).
 *
 * Layer: session (imports context, types, yaml/schemas, lifecycle).
 */
import type { AppMapContext } from './context.ts';
import type { BuildInfo, Edge, IdsRegistry, ImportRouterResult, Manifest, RecipeFile, RecipeId, RouterExport, RouterExportScreen, ScreenFile, ScreenId, ScreenSource } from './types.ts';
import { canonicalDeepLink, isNewerBuild } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { schemaDir, screenFile } from './paths.ts';
import { PLATFORMS } from './config.ts';
import { existsSync } from 'node:fs';
import { assertValid } from './yaml/schemas.ts';
import { retireRecipesForScreen, screensReferenced } from './recipes/lifecycle.ts';

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

/** `retired` recipes that reference a purged screen — deleted with it (02 §8, decision 40) */
function recipesToPurge(ctx: AppMapContext, purges: readonly ScreenId[]): RecipeId[] {
  if (purges.length === 0) return [];
  const purged = new Set<ScreenId>(purges);
  const known = new Map<RecipeId, RecipeFile>();
  for (const r of ctx.map.recipes.values()) known.set(r.id, r);
  for (const r of ctx.db.listRecipes()) known.set(r.id, r);
  const out: RecipeId[] = [];
  for (const recipe of [...known.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    if (recipe.status !== 'retired') continue;
    if (screensReferenced(recipe).some((id) => purged.has(id))) out.push(recipe.id);
  }
  return out;
}

/**
 * A copy of `screen` with every edge to a purged screen removed (and, on the surviving edges,
 * every pre/postcondition naming one), or `undefined` when nothing pointed at a purged screen.
 */
function stripPurgedTargets(screen: ScreenFile, purged: ReadonlySet<ScreenId>): ScreenFile | undefined {
  const edges = screen.edges ?? [];
  const kept = edges.filter((e) => !purged.has(e.to));
  const rewritten = kept.map((e) => {
    const pre = (e.preconditions ?? []).filter((c) => c.screen === undefined || !purged.has(c.screen));
    const post = (e.postconditions ?? []).filter((c) => c.screen === undefined || !purged.has(c.screen));
    if (pre.length === (e.preconditions ?? []).length && post.length === (e.postconditions ?? []).length) return e;
    return {
      ...e,
      ...(e.preconditions !== undefined ? { preconditions: pre } : {}),
      ...(e.postconditions !== undefined ? { postconditions: post } : {}),
    };
  });
  const changed = kept.length !== edges.length || rewritten.some((e, i) => e !== kept[i]);
  return changed ? { ...screen, edges: rewritten } : undefined;
}

function withSource(sources: readonly ScreenSource[] | undefined, source: ScreenSource): { sources: ScreenSource[]; changed: boolean } {
  const list = [...(sources ?? [])];
  if (list.includes(source)) return { sources: list, changed: false };
  list.push(source);
  list.sort();
  return { sources: list, changed: true };
}

/**
 * The export is app-produced, so its routes carry the scheme the APP registers (issue #25); the
 * map stores every link in the canonical `appmap://` form. Rewrite on the way in so a per-app
 * scheme never reaches the committed YAML — otherwise the same app-map, pointed at a rebuilt app
 * with a different scheme, would rewrite every screen file.
 */
function canonicalizeRoutes(screens: readonly RouterExportScreen[], scheme: string | undefined): RouterExportScreen[] {
  return screens.map((rs) => {
    const route = typeof rs.route === 'string' ? canonicalDeepLink(rs.route, scheme) : rs.route;
    const edges = (rs.edges ?? []).map((e) => (
      e.action.type === 'open_link' ? { ...e, action: { ...e.action, url: canonicalDeepLink(e.action.url, scheme) } } : e
    ));
    return { ...rs, ...(route !== undefined ? { route } : {}), ...(rs.edges !== undefined ? { edges } : {}) };
  });
}

/** Pure: a fresh candidate screen from one export entry. *//** Pure: a fresh candidate screen from one export entry. */
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

  const result: ImportRouterResult = { created: [], updated: [], retired: [], unchanged: [], edges_added: 0, unregistered: [], purged: [], purged_recipes: [], build_updated: false };
  const exported = new Map<ScreenId, RouterExportScreen>();
  for (const rs of canonicalizeRoutes(doc.screens, ctx.map.manifest?.deep_link_scheme)) exported.set(rs.id, rs);

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
  // The export is the authority on which build these edges came from, so the manifest records it
  // unless the export is demonstrably OLDER (a re-run of a previous build's artifact, which must
  // not walk the map backwards). Not `isNewerBuild(export, manifest)` alone: that compares
  // numerically only (architecture decision 18) and `build_number` may be any
  // `^[0-9A-Za-z][0-9A-Za-z.\-]*$` string — for an app numbering builds `1.2.3` or `4413-rc1` it is
  // always false, so the merge appended every later build's edges while the manifest went on
  // claiming the first build for ever. 02 §10 rule 2's stale-capture subject compares that build
  // with each screen's `meta.last_verified_build` to tell a refresh outrunning exploration from a
  // contradiction, so a frozen manifest re-opened issue #12's deadlock in full for those apps:
  // measured, `import-router` at `2026.9.13` appending a `nav.settings.tab` edge to the pilot's
  // `invoice_detail` left the manifest on `4412`, validate errored and `openContext` returned
  // `loadError = invalid_map`. Same shape as rule 2's own test: "different, and not older".
  const bumpBuild = manifest !== undefined
    && doc.build.build_number !== manifest.build?.build_number
    && !isNewerBuild(manifest.build?.build_number, doc.build.build_number);

  if (dryRun) {
    result.retired = retirements.map((s) => s.id);
    result.purged = purges;
    result.purged_recipes = recipesToPurge(ctx, purges);
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
  let idsChanged = result.unregistered.length > 0;
  if (purges.length > 0) {
    const purged = new Set<ScreenId>(purges);
    for (const id of purges) {
      ctx.db.deleteScreen(id, { dirty: true, reason: 'import_router_purge' });
      result.purged.push(id);
    }
    // (a) the registry must not name a screen with no file (02 §10 rule 1/3) — but `ids.yaml` is
    // shared by every platform (01 R1), and a purge only deletes the served platform's file. An id
    // another platform still has a screen file for stays registered, or that file is orphaned and
    // validate rule 2 fails; it is unregistered when that platform's own export drops it too.
    const stillOnAnotherPlatform = new Set<ScreenId>(
      [...purged].filter((id) => PLATFORMS.some((p) => p !== ctx.config.platform && existsSync(screenFile(ctx.config, id, p)))),
    );
    for (const id of stillOnAnotherPlatform) {
      ctx.log.info('import-router: keeping the id registered — another platform still has this screen', { screen: id });
    }
    const keptScreens = ids.screens.filter((s) => !purged.has(s.id) || stillOnAnotherPlatform.has(s.id));
    if (keptScreens.length !== ids.screens.length) {
      ids.screens = keptScreens;
      idsChanged = true;
    }
    // (b) no surviving screen may still point at it
    for (const screen of ctx.db.listScreens()) {
      const stripped = stripPurgedTargets(screen, purged);
      if (stripped !== undefined) ctx.db.putScreen(stripped, { dirty: true, reason: 'import_router_purge' });
    }
    // (c) the recipes retired with it go too
    for (const id of recipesToPurge(ctx, purges)) {
      ctx.db.deleteRecipe(id, { dirty: true, reason: 'import_router_purge' });
      result.purged_recipes.push(id);
    }
  }
  if (idsChanged) ctx.db.putIds(ids, { dirty: true, reason: 'import_router' });
  if (bumpBuild && manifest) {
    ctx.db.putManifest({ ...manifest, build: doc.build }, { dirty: true, reason: 'import_router' });
    result.build_updated = true;
  }
  return result;
}
