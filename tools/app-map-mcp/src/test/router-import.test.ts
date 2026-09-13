/** [C3] router-import.ts — seed/refresh screens from the app's router export (01 R6, 02 §8, 06 R7). */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { parse } from 'yaml';
import type { IdsRegistry, RouterExport, ScreenFile } from '../types.ts';
import { isUnlearnedEdgeElement } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { openContext } from '../context.ts';
import type { AppMapContext } from '../context.ts';
import { schemaDir } from '../paths.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { importRouter, mergeRouterScreen, routerScreenToScreenFile } from '../router-import.ts';
import { markVerified } from '../recipes/lifecycle.ts';
import { recordHookPayload } from '../observe.ts';
import { exportMap } from '../store/export.ts';
import { formatIssues, validateMap } from '../validate.ts';
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

  it('and the carve-out SURVIVES the first successful replay — the seed is not verified by passing through it (issue #12)', () => {
    // The half of #12 the first fix missed: `markVerified` flipped `candidate → verified` without
    // consulting `elements[]`, and every ok guided step, every headless success and `observe`'s
    // lazy re-verify call it. One replay through the seed therefore removed the very condition the
    // carve-out is keyed on, rule 2 errored, `loadMap` threw `invalid_map`, and the map stopped
    // loading with NO human edit in between — worse than the bug that was reported.
    doc.screens.find((s) => s.id === 'settings')!.edges = [{ action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list' }];
    importRouter(ctx, doc, spy);

    markVerified(ctx, {
      screens: ['settings'],
      edges: [{ screen: 'settings', action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list' }],
    }, '4412');

    const after = screenOf('settings');
    assert.equal(after.meta.status, 'candidate', '02 §8: a screen with no elements has never had a clean observation');
    assert.equal(after.meta.last_verified_build, undefined);
    assert.equal(after.edges[0]!.status, 'candidate', 'nor is an edge whose element the screen does not declare');

    exportMap(ctx);
    ctx.close();
    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], formatIssues(r.issues));
    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, 'the map must still load after a replay passed through the seed');
      assert.equal(reopened.map.validationWarnings.filter(isUnlearnedEdgeElement).length, 1);
    } finally {
      reopened.close();
    }
  });

  it('the empty-screen guard is broad ON PURPOSE: a seed with no element-bearing edge today would deadlock on build 2 (issue #12)', () => {
    // Why `markVerified` refuses an EMPTY screen rather than “empty AND carrying an undeclared edge
    // element”. This seed's only edge is an `open_link`, which names no element, so rule 2 has
    // nothing to relax on it and the narrower guard would happily verify it on the first replay.
    // `import-router` then appends build 2's edge — and the element it names is one `invoice_list`
    // already declares, so `observed` is true and the ELEMENT half of the carve-out cannot cover it
    // either. A screen promoted back on build 1 is `verified` by then, so rule 2 errors, `loadMap`
    // throws `invalid_map`, and `ctx.loadError` short-circuits every tool but `export` — nobody can
    // even `mark` it back to `candidate`. The narrow guard defers the deadlock; the broad one is
    // what makes build 2 loadable. 02 §8.
    const settings = doc.screens.find((s) => s.id === 'settings')!;
    settings.edges = [{ action: { type: 'open_link', url: 'appmap://invoice_list' }, to: 'invoice_list' }];
    importRouter(ctx, doc, spy);
    markVerified(ctx, { screens: ['settings'] }, '4412');
    assert.equal(screenOf('settings').meta.status, 'candidate', 'empty is empty, whatever the edges look like today');
    assert.equal(screenOf('settings').meta.last_verified_build, undefined);

    // build 2 gives the seed an edge whose element an already-explored screen declares
    doc.build.build_number = '4413';
    settings.edges = [...settings.edges, { action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list' }];
    assert.ok(importRouter(ctx, doc, spy).updated.includes('settings'));
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], formatIssues(r.issues));
    const warned = r.issues.filter((i) => i.file === 'ios/screens/settings.yaml' && isUnlearnedEdgeElement(i));
    assert.equal(warned.length, 1, formatIssues(r.issues));
    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, 'a replay that passed through the seed on build 1 must not make build 2 unloadable');
    } finally {
      reopened.close();
    }
  });

  it('build 2: a NEW edge merged onto an ALREADY-EXPLORED screen warns, and the map still loads (issue #12)', () => {
    // `mergeRouterScreen` adds the new build's edges and never touches `elements[]` or
    // `meta.status`, so on build N+1 a newly registered element lands on a `verified`, non-empty
    // screen — neither half of the screen-shaped carve-out applies. Rule 2 hard-errored there, so
    // EVERY app's second build stopped loading. 01 R1/R8: `gen-ids` registers the element,
    // `import-router` registers screens only, so the id is in ids.yaml and on no screen at all.
    const idsPath = join(t.dir, 'ids.yaml');
    const ids = parse(readFileSync(idsPath, 'utf8')) as IdsRegistry;
    ids.elements.push({ id: 'invoice.export.button', kind: 'button' });
    ids.elements.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    writeFileSync(idsPath, canonicalYaml('ids', ids));
    ctx.close();
    ctx = openContext(t.config, { logSink: 'none', skipRetention: true });

    const before = screenOf('invoice_list');
    assert.equal(before.meta.status, 'verified', 'the fixture screen is explored — that is the point');
    assert.ok(before.elements.length > 0);

    doc.build.build_number = '4413';
    const exported = doc.screens.find((s) => s.id === 'invoice_list')!;
    exported.edges = [...(exported.edges ?? []), { action: { type: 'tap', element: 'invoice.export.button' }, to: 'invoice_detail' }];
    const result = importRouter(ctx, doc, spy);
    assert.ok(result.updated.includes('invoice_list'));

    const merged = screenOf('invoice_list');
    assert.equal(merged.meta.status, 'verified', 'the merge leaves the status alone…');
    assert.equal(merged.elements.length, before.elements.length, '…and never adds an element');
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], formatIssues(r.issues));
    const warned = r.issues.filter((i) => i.file === 'ios/screens/invoice_list.yaml' && isUnlearnedEdgeElement(i));
    assert.equal(warned.length, 1, formatIssues(r.issues));
    assert.match(warned[0]!.message, /invoice\.export\.button/, warned[0]!.message);

    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, "build 2 must not stop the app's map from loading (issue #12)");
    } finally {
      reopened.close();
    }
  });

  it('build 2: a NEW edge for SHARED CHROME merged onto an ALREADY-EXPLORED screen warns too (issue #12 hole c)', () => {
    // The half of the build N+1 refresh the element subject cannot reach, and the one that still
    // deadlocked after the first repair round. `nav.settings.tab` is a tab bar the pilot's
    // `invoice_list` already declares, so `observedElementIds` contains it and "no capture has
    // produced this id" is FALSE — while `invoice_detail`, where the export now puts the edge, is
    // `verified` and non-empty so the screen subject cannot apply either. Rule 2 hard-errored,
    // `loadMap` threw `invalid_map`, and `ctx.loadError` short-circuits every tool but `export`
    // (tools.ts), so recovery meant hand-editing the YAML: #12's cycle with a different element
    // class. What makes it a gap and not a contradiction is the BUILD — `invoice_detail`'s
    // `elements[]` was captured on 4412 and the merge recaptures nothing, so a 4413 edge names an
    // id that capture could not have contained.
    const before = screenOf('invoice_detail');
    assert.equal(before.meta.status, 'verified');
    assert.equal(before.meta.last_verified_build, '4412', 'the capture is of build 4412 — that is the point');
    assert.ok(ctx.map.screens.get('invoice_list')!.elements.some((e) => e.id === 'nav.settings.tab'), 'another screen HAS captured this id');

    doc.build.build_number = '4413';
    const exported = doc.screens.find((s) => s.id === 'invoice_detail')!;
    exported.edges = [...(exported.edges ?? []), { action: { type: 'tap', element: 'nav.settings.tab' }, to: 'invoice_list' }];
    assert.ok(importRouter(ctx, doc, spy).updated.includes('invoice_detail'));

    const merged = screenOf('invoice_detail');
    assert.equal(merged.meta.status, 'verified', 'the merge leaves the status alone…');
    assert.equal(merged.meta.last_verified_build, '4412', '…and does not recapture the screen');
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], formatIssues(r.issues));
    const warned = r.issues.filter((i) => i.file === 'ios/screens/invoice_detail.yaml' && isUnlearnedEdgeElement(i));
    assert.equal(warned.length, 1, formatIssues(r.issues));
    assert.match(warned[0]!.message, /nav\.settings\.tab/, warned[0]!.message);

    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, "build 2 must not stop the app's map from loading (issue #12)");
    } finally {
      reopened.close();
    }
  });

  it('…and the same edge IS an error once the screen has been recaptured on that build (the warning self-heals)', () => {
    // The stale-capture subject is not a permanent amnesty: `name_screen` stamps `last_verified_build`,
    // and once the capture is of the build the manifest names, an id it did not contain is a real
    // contradiction again. Simulated here by moving the screen's capture forward to 4413.
    doc.build.build_number = '4413';
    const exported = doc.screens.find((s) => s.id === 'invoice_detail')!;
    exported.edges = [...(exported.edges ?? []), { action: { type: 'tap', element: 'nav.settings.tab' }, to: 'invoice_list' }];
    importRouter(ctx, doc, spy);
    const recaptured = structuredClone(screenOf('invoice_detail'));
    recaptured.meta.last_verified_build = '4413';
    ctx.db.putScreen(recaptured, { dirty: true, reason: 'verify' });
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    const errs = r.issues.filter((i) => i.severity === 'error');
    assert.equal(errs.length, 1, formatIssues(r.issues));
    assert.match(errs[0]!.message, /nav\.settings\.tab is not declared on this screen$/, errs[0]!.message);
  });

  it('build 2 with a NON-INTEGER build_number warns too — the deadlock must not survive the way an app numbers builds', () => {
    // Same hole (c) sequence, for an app whose `build_number` is `2026.9.12` / `1.2.3` / `4413-rc1`
    // — every shape both schemas allow. `isNewerBuild` compares numerically only (decision 18), so
    // for these the comparison is always false; keying the carve-out on it directly took decision
    // 18's conservative branch, which HERE is the hard error, and left #12's cycle fully intact for
    // every such app: measured on a pilot copy, validate FAILED and `openContext` returned
    // `loadError = invalid_map`. Stale is "not this build, and not demonstrably newer than it".
    // It takes BOTH hunks: the manifest must actually move to `2026.9.13` (`importRouter` refused,
    // so the map claimed `4412` — the very build `invoice_detail` was captured on, which reads as a
    // CURRENT capture and errors), and rule 2 must then read "differs" as stale.
    doc.build.build_number = '2026.9.13';
    const exported = doc.screens.find((s) => s.id === 'invoice_detail')!;
    exported.edges = [...(exported.edges ?? []), { action: { type: 'tap', element: 'nav.settings.tab' }, to: 'invoice_list' }];
    const result = importRouter(ctx, doc, spy);
    assert.ok(result.updated.includes('invoice_detail'));
    assert.equal(result.build_updated, true, 'the manifest has to record the build these edges came from');
    assert.equal(ctx.db.getManifest()?.build.build_number, '2026.9.13');
    assert.equal(screenOf('invoice_detail').meta.last_verified_build, '4412', 'the merge recaptures nothing');
    exportMap(ctx);
    ctx.close();

    const r = validateMap(t.config, { platforms: ['ios'] });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], formatIssues(r.issues));
    const warned = r.issues.filter((i) => i.file === 'ios/screens/invoice_detail.yaml' && isUnlearnedEdgeElement(i));
    assert.equal(warned.length, 1, formatIssues(r.issues));
    assert.match(warned[0]!.message, /nav\.settings\.tab/, warned[0]!.message);

    const reopened = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
    try {
      assert.equal(reopened.loadError, null, 'an app that versions builds 2026.9.13 must load on build 2 like any other (issue #12)');
    } finally {
      reopened.close();
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
    const older: RouterExport = { ...doc, build: { ...doc.build, build_number: '4412' } };
    assert.equal(importRouter(ctx, older, spy).build_updated, false, 'an older export must not walk the manifest back');
    assert.equal(ctx.db.getManifest()?.build.build_number, '4413');
  });

  it('…and when the export merely DIFFERS, for a build_number that does not compare numerically (issue #12)', () => {
    // `isNewerBuild` is numeric-only (architecture decision 18) while both schemas allow any
    // `^[0-9A-Za-z][0-9A-Za-z.\-]*$`, so an app numbering builds `1.2.3` / `4413-rc1` never bumped:
    // the merge appended every later build's edges and the manifest went on claiming the first
    // build for ever. 02 §10 rule 2's stale-capture subject compares THAT build with each screen's
    // `meta.last_verified_build`, so a frozen manifest can never look stale and issue #12's
    // build N+1 deadlock came straight back for those apps.
    for (const build of ['2026.9.13', '4413-rc1', '1.2.3']) {
      const other: RouterExport = { ...doc, build: { ...doc.build, build_number: build } };
      assert.equal(importRouter(ctx, other, spy).build_updated, true, build);
      assert.equal(ctx.db.getManifest()?.build.build_number, build);
    }
    // and still not backwards, once the manifest is on a number again
    const back: RouterExport = { ...doc, build: { ...doc.build, build_number: '4412' } };
    assert.equal(importRouter(ctx, back, spy).build_updated, true, 'nothing orders 1.2.3 against 4412, so the export wins');
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
