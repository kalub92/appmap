/** [C3] router-import.ts — seed/refresh screens from the app's router export (01 R6, 02 §8, 06 R7). */
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { RouterExport, ScreenFile } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { openContext } from '../context.ts';
import type { AppMapContext } from '../context.ts';
import { schemaDir } from '../paths.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { importRouter, mergeRouterScreen, routerScreenToScreenFile } from '../router-import.ts';
import { recordHookPayload } from '../observe.ts';
import { exportMap } from '../store/export.ts';
import { validateMap } from '../validate.ts';
import { loadHookFixture, loadRouterExportFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let ctx: AppMapContext;
let doc: RouterExport;
/** recipes retired by the import (lifecycle.retireRecipesForScreen is C1's write) */
let retiredFor: string[];

beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
  doc = loadRouterExportFixture();
  retiredFor = [];
});
afterEach(() => {
  ctx.close();
  t.cleanup();
});

const spy = { retireRecipes: (_c: AppMapContext, screen: string): string[] => { retiredFor.push(screen); return ['create_invoice']; } };

function screenOf(id: string): ScreenFile {
  const s = ctx.db.getScreen(id);
  assert.ok(s, `screen ${id} is not in the cache`);
  return s;
}

describe('importRouter — seeding (01 R6, decision 40)', () => {
  it('creates the screen the export knows and the map does not, as a candidate from router_export', () => {
    const result = importRouter(ctx, doc, spy);
    assert.deepEqual(result.created, ['settings']);
    const settings = screenOf('settings');
    assert.equal(settings.kind, 'screen');
    assert.equal(settings.deep_link, 'appmap://settings');
    assert.equal(settings.signature.marker, 'screen.settings');
    assert.equal(settings.signature.route, 'appmap://settings');
    assert.equal(settings.signature.nav_class, 'SettingsView');
    assert.deepEqual(settings.elements, []);
    assert.deepEqual(settings.meta, { sources: ['router_export'], status: 'candidate' });
    assert.equal(settings.meta.last_verified_build, undefined, 'a seeded screen was never verified (02 §8)');
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'screen', settings), []);
    // the cache row is dirty so `export` writes the file (06 R7 PR)
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'settings'));
  });

  it('a freshly imported router map validates, loads and can ingest an observation (issue #12 criterion 1)', () => {
    // The reporter's deadlock: the seed carries the app's edges with `elements: []`, 02 §10 rule 2
    // errored on every one, the server refused the map (`invalid_map`), and `record` — the only way
    // elements are ever learned — could not run. The fixture's `settings` has no edges, so give it
    // the one the bug needs; `invoice.add.button` IS in ids.yaml, so the only gap is "not declared
    // on this screen", which is the case the carve-out relaxes (issue #12).
    doc.screens.find((s) => s.id === 'settings')!.edges = [{ action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list' }];
    importRouter(ctx, doc, spy);
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], 'a fresh seed must not fail validate');
    assert.ok(r.issues.some((i) => i.rule === 2 && i.severity === 'warning' && i.file === 'ios/screens/settings.yaml'), 'but the gap is still reported');

    // reopening is the server path: it must load the map rather than fall back to `emptyMap`
    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, 'the map the import just wrote must load (03 §11)');
      assert.ok(reopened.map.screens.has('settings'));
      assert.equal(reopened.map.validationWarnings.length, 1);
      // …and the cycle is broken: an observation can now be ingested, which is what fills elements[]
      assert.equal(recordHookPayload(reopened, loadHookFixture('post-tool-use.tap'))?.seq, 1);
    } finally {
      reopened.close(); // `afterEach` closes `ctx` again — `close()` is idempotent
    }
  });

  it('appends the unregistered screen to ids.yaml and reports it (06 R7 carries both changes)', () => {
    const result = importRouter(ctx, doc, spy);
    assert.deepEqual(result.unregistered, ['settings']);
    const ids = ctx.db.getIds();
    assert.ok(ids);
    const entry = ids.screens.find((s) => s.id === 'settings');
    assert.deepEqual(entry, { id: 'settings', deep_link: 'appmap://settings' });
    assert.deepEqual(ids.screens.map((s) => s.id), ['client_picker', 'invoice_detail', 'invoice_list', 'invoice_new', 'login', 'settings']);
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'ids' && d.reason === 'import_router'));
  });

  it('--strict refuses instead of registering', () => {
    assert.throws(
      () => importRouter(ctx, doc, { ...spy, strict: true }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && e.message.includes('settings'),
    );
    assert.equal(ctx.db.getScreen('settings'), undefined, 'nothing was written');
  });

  it('refuses an export whose gates are not registered (01 R7: the dismiss control is app code)', () => {
    doc.gates = [...(doc.gates ?? []), { id: 'gate.paywall', dismiss: 'gate.paywall.close' }];
    assert.throws(
      () => importRouter(ctx, doc, spy),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && e.message.includes('gate.paywall'),
    );
  });

  it('refuses an export that does not validate against router-export.schema.json', () => {
    const bad = { ...doc, screens: [{ id: 'Not Snake Case', route: 'appmap://x', view_type: 'X' }] } as unknown as RouterExport;
    assert.throws(() => importRouter(ctx, bad, spy), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP);
    const missingBuild = { ...doc, build: undefined } as unknown as RouterExport;
    assert.throws(() => importRouter(ctx, missingBuild, spy), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP);
  });

  it('refuses an export for the other platform', () => {
    assert.throws(
      () => importRouter(ctx, { ...doc, platform: 'android' }, spy),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT,
    );
  });
});

describe('importRouter — refreshing (01 R6 "seeds or refreshes")', () => {
  it('never loses elements, locators or edges on an existing screen', () => {
    const before = structuredClone(ctx.map.screens.get('invoice_list') as ScreenFile);
    importRouter(ctx, doc, spy);
    const after_ = screenOf('invoice_list');
    assert.deepEqual(after_.elements, before.elements);
    assert.equal(after_.title, 'Invoices');
    assert.equal(after_.signature.structural_hash, before.signature.structural_hash);
    assert.deepEqual(after_.signature.required_ids, before.signature.required_ids);
    assert.ok(after_.edges.length >= before.edges.length);
    for (const e of before.edges) {
      assert.ok(after_.edges.some((x) => JSON.stringify(x) === JSON.stringify(e)), `edge lost: ${JSON.stringify(e.action)}`);
    }
  });

  it('adds edges the export knows and the map does not, as candidates', () => {
    const list = ctx.map.screens.get('invoice_list') as ScreenFile;
    const trimmed: ScreenFile = { ...structuredClone(list), edges: list.edges.slice(0, 1) };
    ctx.db.putScreen(trimmed, { dirty: false });
    const result = importRouter(ctx, doc, spy);
    assert.ok(result.updated.includes('invoice_list'));
    assert.equal(result.edges_added >= 1, true);
    const after_ = screenOf('invoice_list');
    const added = after_.edges.find((e) => e.to === 'invoice_detail');
    assert.ok(added);
    assert.equal(added.status, 'candidate');
  });

  it('reports a screen the export does not change as unchanged', () => {
    const result = importRouter(ctx, doc, spy);
    assert.ok(result.unchanged.includes('invoice_list'), JSON.stringify(result));
    assert.ok(!result.updated.includes('invoice_list'));
  });

  it('bumps the manifest build when the export is newer (decision 40)', () => {
    assert.equal(importRouter(ctx, doc, spy).build_updated, false, 'same build number');
    const newer: RouterExport = { ...doc, build: { ...doc.build, build_number: '4413' } };
    assert.equal(importRouter(ctx, newer, spy).build_updated, true);
    assert.equal(ctx.db.getManifest()?.build.build_number, '4413');
  });

  it('dryRun writes nothing', () => {
    const result = importRouter(ctx, doc, { ...spy, dryRun: true });
    assert.deepEqual(result.created, ['settings']);
    assert.equal(ctx.db.getScreen('settings'), undefined);
    assert.deepEqual(ctx.db.listDirty(), []);
  });
});

describe('importRouter — retirement and purge (02 §8)', () => {
  function withoutLogin(build = '4412'): RouterExport {
    return { ...doc, build: { ...doc.build, build_number: build }, screens: doc.screens.filter((s) => s.id !== 'login') };
  }

  it('retires a router_export screen the export no longer mentions and its recipes', () => {
    const result = importRouter(ctx, withoutLogin(), spy);
    assert.deepEqual(result.retired, ['login']);
    assert.equal(screenOf('login').meta.status, 'retired');
    assert.equal(screenOf('login').meta.last_verified_build, '4412', 'the build it was last verified on stays (02 §8 decay)');
    assert.deepEqual(retiredFor, ['login']);
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'login'));
  });

  it('retire: false leaves it alone', () => {
    const result = importRouter(ctx, withoutLogin(), { ...spy, retire: false });
    assert.deepEqual(result.retired, []);
    assert.equal(screenOf('login').meta.status, 'verified');
  });

  it('purgeRetired deletes a screen retired on an earlier build (02 §8 "one release, then deleted")', () => {
    importRouter(ctx, withoutLogin(), spy);
    assert.equal(screenOf('login').meta.status, 'retired');
    // same build: the release has not turned over yet
    assert.deepEqual(importRouter(ctx, withoutLogin(), { ...spy, purgeRetired: true }).purged, []);
    // a later build: now it goes
    const result = importRouter(ctx, withoutLogin('4413'), { ...spy, purgeRetired: true });
    assert.deepEqual(result.purged, ['login']);
    assert.equal(ctx.db.getScreen('login'), undefined);
  });

  // 02 §8 second half: the purge must leave a map that still loads and validates — the file is
  // unlinked by `export`, the registry entry goes, inbound edges are stripped and the recipes
  // that were retired with it are deleted.
  it('purgeRetired cascades: ids.yaml, inbound edges and the retired recipes, and export unlinks the file', () => {
    const withoutDetail = (build: string): RouterExport => ({
      ...doc, build: { ...doc.build, build_number: build }, screens: doc.screens.filter((s) => s.id !== 'invoice_detail'),
    });
    importRouter(ctx, withoutDetail('4412'), {});
    assert.equal(screenOf('invoice_detail').meta.status, 'retired');
    assert.equal(ctx.db.getRecipe('create_invoice')?.status, 'retired');
    exportMap(ctx);

    const result = importRouter(ctx, withoutDetail('4413'), { purgeRetired: true });
    assert.deepEqual(result.purged, ['invoice_detail']);
    assert.deepEqual(result.purged_recipes, ['create_invoice']);
    // `ids.yaml` is shared by both platforms (01 R1) and this purge only deleted the ios file, so
    // the id stays registered while android/screens/invoice_detail.yaml exists — unregistering it
    // here would orphan that file and fail validate rule 2.
    assert.ok(existsSync(join(t.dir, 'android/screens/invoice_detail.yaml')), 'android still has the screen');
    assert.equal(ctx.db.getIds()?.screens.some((sc) => sc.id === 'invoice_detail'), true, 'still registered for android');
    assert.equal(screenOf('invoice_list').edges.some((e) => e.to === 'invoice_detail'), false, 'inbound edge stripped');
    assert.equal(screenOf('invoice_new').edges.some((e) => e.to === 'invoice_detail'), false, 'inbound edge stripped');

    const exported = exportMap(ctx);
    assert.ok(exported.deleted.includes('ios/screens/invoice_detail.yaml'));
    assert.ok(exported.deleted.includes('ios/recipes/create_invoice.yaml'));
    assert.equal(existsSync(join(t.dir, 'ios/screens/invoice_detail.yaml')), false);
    assert.equal(existsSync(join(t.dir, 'ios/recipes/create_invoice.yaml')), false);
    // 02 §10: the map still loads and cross-references cleanly, and the screen stays gone
    ctx.reload();
    assert.equal(ctx.map.screens.has('invoice_detail'), false);
    assert.equal(ctx.db.getScreen('invoice_detail'), undefined);
  });

  // The other half of the shared-registry rule: when no other platform holds the screen, the
  // purge must unregister the id, or the registry names a screen no platform has.
  it('purging the last platform holding a screen unregisters the id', () => {
    const withoutDetail = (build: string): RouterExport => ({
      ...doc, build: { ...doc.build, build_number: build }, screens: doc.screens.filter((s) => s.id !== 'invoice_detail'),
    });
    rmSync(join(t.dir, 'android/screens/invoice_detail.yaml'));   // android already dropped it
    importRouter(ctx, withoutDetail('4412'), {});
    exportMap(ctx);
    const result = importRouter(ctx, withoutDetail('4413'), { purgeRetired: true });
    assert.deepEqual(result.purged, ['invoice_detail']);
    assert.equal(ctx.db.getIds()?.screens.some((sc) => sc.id === 'invoice_detail'), false, 'no platform has it now');
  });

  it('a screen that comes back into the export stops being retired', () => {
    importRouter(ctx, withoutLogin(), spy);
    assert.equal(screenOf('login').meta.status, 'retired');
    const result = importRouter(ctx, doc, spy);
    assert.ok(result.updated.includes('login'));
    assert.equal(screenOf('login').meta.status, 'candidate');
  });
});

describe('routerScreenToScreenFile / mergeRouterScreen (pure)', () => {
  it('builds a candidate screen with the export edges', () => {
    const rs = doc.screens.find((s) => s.id === 'invoice_list');
    assert.ok(rs);
    const screen = routerScreenToScreenFile(rs, doc.build);
    assert.equal(screen.signature.marker, 'screen.invoice_list');
    assert.equal(screen.edges.length, 2);
    assert.equal(screen.edges[0]?.status, 'candidate');
    assert.deepEqual(screen.meta.sources, ['router_export']);
  });

  it('omits `route` for a screen without a deep link (decision 9)', () => {
    const rs = doc.screens.find((s) => s.id === 'client_picker');
    assert.ok(rs);
    const screen = routerScreenToScreenFile(rs, doc.build);
    assert.equal(screen.deep_link, 'none');
    assert.equal(screen.signature.route, undefined);
  });

  it('merge is idempotent and adds router_export to sources', () => {
    const existing = ctx.map.screens.get('invoice_new') as ScreenFile;
    const rs = doc.screens.find((s) => s.id === 'invoice_new');
    assert.ok(rs);
    const once = mergeRouterScreen(existing, rs);
    const twice = mergeRouterScreen(once.screen, rs);
    assert.equal(twice.changed, false);
    assert.equal(twice.edges_added, 0);
    assert.ok(once.screen.meta.sources.includes('router_export'));
  });

  it('keeps the screen file\'s richer deep link when only the query differs (01 R5, decision 34)', () => {
    const existing = ctx.map.screens.get('invoice_detail') as ScreenFile;
    assert.equal(existing.deep_link, 'appmap://invoice_detail?fixture=one_draft_invoice');
    const rs = doc.screens.find((s) => s.id === 'invoice_detail');
    assert.ok(rs);
    const merged = mergeRouterScreen(existing, rs);
    assert.equal(merged.screen.deep_link, 'appmap://invoice_detail?fixture=one_draft_invoice');
  });
});
