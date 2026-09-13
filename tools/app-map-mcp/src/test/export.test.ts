/**
 * [A2] store/export.ts — `app-map export` (02 §2.2–2.3, 02 §11 idempotency, 03 §4 write path +
 * conflict safety, 06 R1 `--check`).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import { exportMap, relPathFor, renderEntities, unifiedDiff } from '../store/export.ts';
import type { ElementDef, RecipeFile, ScreenFile } from '../types.ts';
import { isCanonical } from '../yaml/canonical.ts';
import { PILOT_APP_MAP_DIR, makeTempAppMapDir } from './helpers.ts';

/** sha of every YAML under the map (not .local) so a test can prove "nothing else changed" */
function snapshotYaml(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      if (name === '.local') continue;
      const p = join(d, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(p).isDirectory()) walk(p, r);
      else if (name.endsWith('.yaml')) out.set(r, createHash('sha1').update(readFileSync(p)).digest('hex'));
    }
  };
  walk(dir, '');
  return out;
}

function withCtx(fn: (ctx: AppMapContext, dir: string) => void, opts: { platform?: 'ios' | 'android' } = {}): void {
  const t = makeTempAppMapDir(opts);
  const ctx = openContext(t.config, { skipRetention: true, logSink: 'none' });
  try {
    fn(ctx, t.dir);
  } finally {
    ctx.close();
    t.cleanup();
  }
}

function healButton(ctx: AppMapContext): ElementDef {
  const screen = ctx.db.getScreen('invoice_list') as ScreenFile;
  const el = screen.elements.find((e) => e.id === 'invoice.add.button') as ElementDef;
  // the a11y_id locator stays (02 §10.4); the healed role_label follows the relabelled button
  const healed: ElementDef = {
    ...el,
    status: 'healed_pending_review',
    locators: el.locators.map((l) => (l.strategy === 'role_label' ? { ...l, value: { role: 'button', label: 'Create Invoice' } } : l)),
  };
  ctx.db.putElement('invoice_list', healed, { reason: 'heal' });
  return healed;
}

describe('exportMap (03 §4 write path)', () => {
  it('writes nothing when nothing is dirty', () => {
    withCtx((ctx, dir) => {
      const before = snapshotYaml(dir);
      const res = exportMap(ctx);
      assert.deepEqual(res, { written: [], written_from: [], deleted: [], unchanged: [], conflicts: [], non_canonical: [] });
      assert.deepEqual(snapshotYaml(dir), before);
    });
  });

  it('written_from labels a machine recompile distinctly from a heal or a canonicalisation (04 §8, issue #13)', () => {
    withCtx((ctx, dir) => {
      healButton(ctx); // reason `heal`: a locator changed, the steps did not
      const recipe = ctx.map.recipes.get('create_invoice') as RecipeFile;
      // what `lifecycle.recompileFrom` writes once its 04 §8 guard passes: the STEPS were rebuilt,
      // so the recipe carries both the dirty reason and the in-file marker
      ctx.db.putRecipe(
        { ...recipe, status: 'candidate', provenance: { ...recipe.provenance, machine_recompile: true } },
        { dirty: true, reason: 'recompile:recompile_failures' },
      );
      const res = exportMap(ctx);

      assert.deepEqual(res.written_from.map((w) => w.path), res.written, 'one entry per written path, same order');
      const byPath = new Map(res.written_from.map((w) => [w.path, w]));
      assert.deepEqual(byPath.get('ios/recipes/create_invoice.yaml'), {
        path: 'ios/recipes/create_invoice.yaml', reason: 'recompile:recompile_failures', machine_recompile: true,
      });
      assert.deepEqual(byPath.get('ios/screens/invoice_list.yaml'), {
        path: 'ios/screens/invoice_list.yaml', reason: 'heal', machine_recompile: false,
      }, 'a heal is not a machine recompile: it changes a locator, never the steps');
      // criterion 4's other half: the PR diff carries the same signal without the reviewer having
      // to read `written_from`, and it lands right above the reviewer it qualifies
      const text = readFileSync(join(dir, 'ios/recipes/create_invoice.yaml'), 'utf8');
      assert.match(text, /^ {2}machine_recompile: true\n {2}reviewed_by: caleb$/m);
      assert.ok(isCanonical('recipe', text), 'and the marker does not break canonical form (02 §11)');
    });
  });

  it('the status-only lifecycle reason is NOT labelled a machine recompile (issue #13)', () => {
    withCtx((ctx) => {
      const recipe = ctx.map.recipes.get('create_invoice') as RecipeFile;
      // `recordRunOutcome` writes the 04 §8 demotion under `lifecycle:<reason>`; only the BODY
      // rewrite uses `recompile:<reason>`. Confusing the two would cry wolf on every demotion.
      ctx.db.putRecipe({ ...recipe, status: 'candidate' }, { dirty: true, reason: 'lifecycle:recompile_failures' });
      const res = exportMap(ctx);
      assert.deepEqual(res.written_from, [{ path: 'ios/recipes/create_invoice.yaml', reason: 'lifecycle:recompile_failures', machine_recompile: false }]);
    });
  });

  it('a healed locator marked dirty exports only that screen file, canonically, then is idempotent (02 §11)', () => {
    withCtx((ctx, dir) => {
      const before = snapshotYaml(dir);
      const healed = healButton(ctx);
      const res = exportMap(ctx);
      assert.deepEqual(res.written, ['ios/screens/invoice_list.yaml']);
      assert.deepEqual(res.conflicts, []);
      const after = snapshotYaml(dir);
      for (const [rel, sha] of before) {
        if (rel === 'ios/screens/invoice_list.yaml') assert.notEqual(after.get(rel), sha);
        else assert.equal(after.get(rel), sha, `${rel} must be untouched`);
      }
      const text = readFileSync(join(dir, 'ios/screens/invoice_list.yaml'), 'utf8');
      assert.ok(isCanonical('screen', text));
      const doc = parse(text) as ScreenFile;
      const el = doc.elements.find((e) => e.id === 'invoice.add.button');
      assert.equal(el?.status, 'healed_pending_review');
      assert.deepEqual(el?.locators, healed.locators);
      assert.equal(ctx.db.listDirty().length, 0);
      // volatile counters never leave SQLite: no `hits`/`heals`/`last_seen` keys in the file
      assert.doesNotMatch(text, /\b(hits|misses|heals|last_seen|seen):/);
      // second export writes nothing and reload agrees with disk
      assert.deepEqual(exportMap(ctx).written, []);
      ctx.reload();
      assert.equal(ctx.map.screens.get('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'healed_pending_review');
      assert.deepEqual(exportMap(ctx).written, []);
    });
  });

  it('refuses with a unified diff when the file changed on disk since load; --force overwrites', () => {
    withCtx((ctx, dir) => {
      healButton(ctx);
      const file = join(dir, 'ios/screens/invoice_list.yaml');
      const original = readFileSync(file, 'utf8');
      const edited = original.replace('title: Invoices', 'title: All Invoices');
      assert.notEqual(edited, original);
      writeFileSync(file, edited);
      const res = exportMap(ctx);
      assert.deepEqual(res.written, []);
      assert.equal(res.conflicts.length, 1);
      assert.equal(res.conflicts[0]?.path, 'ios/screens/invoice_list.yaml');
      assert.match(res.conflicts[0]?.diff ?? '', /changed on disk since it was loaded/);
      assert.match(res.conflicts[0]?.diff ?? '', /^--- a\/ios\/screens\/invoice_list\.yaml$/m);
      assert.match(res.conflicts[0]?.diff ?? '', /^\+\+\+ b\/ios\/screens\/invoice_list\.yaml$/m);
      assert.match(res.conflicts[0]?.diff ?? '', /^-title: All Invoices$/m);
      assert.match(res.conflicts[0]?.diff ?? '', /^\+title: Invoices$/m);
      assert.equal(readFileSync(file, 'utf8'), edited); // untouched
      assert.equal(ctx.db.listDirty().length, 1); // still dirty

      const forced = exportMap(ctx, { force: true });
      assert.deepEqual(forced.written, ['ios/screens/invoice_list.yaml']);
      assert.deepEqual(forced.conflicts, []);
      const text = readFileSync(file, 'utf8');
      assert.match(text, /^title: Invoices$/m);
      assert.match(text, /status: healed_pending_review/);
      assert.equal(ctx.db.listDirty().length, 0);
      // the sha recorded after writing equals the file → a later re-dirty does not conflict
      healButton(ctx);
      assert.deepEqual(exportMap(ctx).conflicts, []);
    });
  });

  it('a file deleted on disk since load is a conflict; dryRun computes without writing', () => {
    withCtx((ctx, dir) => {
      healButton(ctx);
      const dry = exportMap(ctx, { dryRun: true });
      assert.deepEqual(dry.written, ['ios/screens/invoice_list.yaml']);
      assert.equal(ctx.db.listDirty().length, 1);
      const before = snapshotYaml(dir);
      assert.deepEqual(snapshotYaml(dir), before);
      const file = join(dir, 'ios/screens/invoice_list.yaml');
      writeFileSync(`${file}.bak`, readFileSync(file));
      rmSync(file);
      const res = exportMap(ctx);
      assert.equal(res.conflicts.length, 1);
      assert.match(res.conflicts[0]?.diff ?? '', /deleted on disk/);
      assert.ok(!existsSync(file));
      assert.deepEqual(exportMap(ctx, { force: true }).written, ['ios/screens/invoice_list.yaml']);
      assert.ok(existsSync(file));
    });
  });

  it('a new screen (never loaded) is written when absent on disk and a conflict when present', () => {
    withCtx((ctx, dir) => {
      const login = ctx.db.getScreen('login') as ScreenFile;
      const fresh: ScreenFile = {
        ...login, id: 'settings', title: 'Settings', deep_link: 'appmap://settings',
        signature: { marker: 'screen.settings', route: 'appmap://settings' }, elements: [], edges: [], meta: { sources: ['exploration'], status: 'candidate' },
      };
      ctx.db.putScreen(fresh, { dirty: true, reason: 'name_screen' });
      const res = exportMap(ctx);
      assert.deepEqual(res.written, ['ios/screens/settings.yaml']);
      const file = join(dir, 'ios/screens/settings.yaml');
      assert.ok(isCanonical('screen', readFileSync(file, 'utf8')));
      assert.equal((parse(readFileSync(file, 'utf8')) as ScreenFile).id, 'settings');

      // another window wrote a different `profile.yaml` first → conflict, never clobbered
      const other = join(dir, 'ios/screens/profile.yaml');
      writeFileSync(other, 'id: profile\nkind: screen\n');
      ctx.db.putScreen({ ...fresh, id: 'profile', title: 'Profile', deep_link: 'appmap://profile', signature: { marker: 'screen.profile' } }, { dirty: true, reason: 'name_screen' });
      const res2 = exportMap(ctx);
      assert.equal(res2.conflicts.length, 1);
      assert.equal(res2.conflicts[0]?.path, 'ios/screens/profile.yaml');
      assert.match(res2.conflicts[0]?.diff ?? '', /never loaded/);
      assert.equal(readFileSync(other, 'utf8'), 'id: profile\nkind: screen\n');
    });
  });

  it('dirty ids writes ids.yaml and dirty manifest refreshes generated_at (02 §2.3) — and a dirty row equal to disk is `unchanged`', () => {
    withCtx((ctx, dir) => {
      const ids = ctx.db.getIds()!;
      ctx.db.putIds({ ...ids, screens: [...ids.screens, { id: 'settings', title: 'Settings', deep_link: 'appmap://settings' }] }, { dirty: true, reason: 'import_router' });
      const manifest = ctx.db.getManifest()!;
      ctx.db.putManifest({ ...manifest, build: { ...manifest.build, build_number: '4413' }, generated_at: '2000-01-01T00:00:00Z' }, { dirty: true, reason: 'import_router' });
      // a recipe re-put unchanged is dirty but equal to disk
      ctx.db.putRecipe(ctx.db.getRecipe('create_invoice')!, { dirty: true, reason: 'mark_recipe' });
      const res = exportMap(ctx);
      assert.deepEqual(res.written.sort(), ['ids.yaml', 'ios/manifest.yaml']);
      assert.deepEqual(res.unchanged, ['ios/recipes/create_invoice.yaml']);
      assert.deepEqual(ctx.db.listDirty(), []);
      const idsText = readFileSync(join(dir, 'ids.yaml'), 'utf8');
      assert.ok(isCanonical('ids', idsText));
      assert.match(idsText, /^  - id: settings$/m);
      const manText = readFileSync(join(dir, 'ios/manifest.yaml'), 'utf8');
      assert.ok(isCanonical('manifest', manText));
      const man = parse(manText) as { build: { build_number: string }; generated_at: string };
      assert.equal(man.build.build_number, '4413');
      assert.notEqual(man.generated_at, '2000-01-01T00:00:00Z');
      assert.ok(Date.now() - Date.parse(man.generated_at) < 60_000);
      assert.equal(ctx.db.getManifest()?.generated_at, man.generated_at); // cache follows disk
      assert.deepEqual(exportMap(ctx).written, []);
      // the map reloads cleanly with the new screen registered (ids only; no screen file needed)
      ctx.reload();
      assert.equal(ctx.map.ids.screens.some((s) => s.id === 'settings'), true);
    });
  });

  // 02 §8: a screen retired for one release is then DELETED — the dirty row carries the intent
  // and export unlinks the file, so a reload no longer sees the screen.
  it('a dirty DELETE row unlinks the YAML file and the screen is gone after a reload (02 §8)', () => {
    withCtx((ctx, dir) => {
      const file = join(dir, 'ios/screens/settings.yaml');
      assert.equal(existsSync(join(dir, 'ios/screens/invoice_detail.yaml')), true);
      ctx.db.deleteScreen('invoice_detail', { dirty: true, reason: 'import_router_purge' });
      const dirty = ctx.db.listDirty();
      assert.equal(dirty.length, 1);
      assert.equal(dirty[0]!.kind, 'screen');
      assert.equal(dirty[0]!.key, 'invoice_detail');
      assert.equal(dirty[0]!.deleted, true);
      const res = exportMap(ctx);
      assert.deepEqual(res.deleted, ['ios/screens/invoice_detail.yaml']);
      assert.deepEqual(res.written, []);
      assert.equal(existsSync(join(dir, 'ios/screens/invoice_detail.yaml')), false);
      assert.deepEqual(ctx.db.listDirty(), []);
      assert.equal(ctx.db.getScreen('invoice_detail'), undefined);
      // idempotent: a second export has nothing left to delete
      assert.deepEqual(exportMap(ctx).deleted, []);
      assert.equal(existsSync(file), false, 'nothing else was touched');
      // the full cascade that keeps the map loadable after a purge is covered in router-import.test.ts
    });
  });

  it('a DELETE refuses when the file changed on disk since load, unless --force (03 §4)', () => {
    withCtx((ctx, dir) => {
      const file = join(dir, 'ios/screens/invoice_detail.yaml');
      ctx.db.deleteScreen('invoice_detail', { dirty: true, reason: 'import_router_purge' });
      writeFileSync(file, `${readFileSync(file, 'utf8')}# edited underneath us\n`);
      const res = exportMap(ctx);
      assert.deepEqual(res.deleted, []);
      assert.equal(res.conflicts.length, 1);
      assert.match(res.conflicts[0]!.diff, /refusing to delete it/);
      assert.equal(existsSync(file), true);
      const forced = exportMap(ctx, { force: true });
      assert.deepEqual(forced.deleted, ['ios/screens/invoice_detail.yaml']);
      assert.equal(existsSync(file), false);
    });
  });

  it('--check reports non-canonical files and writes nothing (06 R1)', () => {
    withCtx((ctx, dir) => {
      assert.deepEqual(exportMap(ctx, { check: true }).non_canonical, []);
      const file = join(dir, 'ios/screens/login.yaml');
      const text = readFileSync(file, 'utf8');
      // move `kind` above `id`: same document, non-canonical key order
      const reordered = text.replace(/^id: login\nkind: screen\n/, 'kind: screen\nid: login\n');
      assert.notEqual(reordered, text);
      writeFileSync(file, reordered);
      healButton(ctx);
      const before = snapshotYaml(dir);
      const res = exportMap(ctx, { check: true });
      assert.deepEqual(res.non_canonical, ['ios/screens/login.yaml']);
      assert.deepEqual(res.written, []);
      assert.deepEqual(snapshotYaml(dir), before);
      assert.equal(ctx.db.listDirty().length, 1); // check does not consume dirty rows
    });
  });

  it('uses the configured platform for paths', () => {
    withCtx((ctx) => {
      healButton(ctx);
      assert.deepEqual(exportMap(ctx).written, ['android/screens/invoice_list.yaml']);
    }, { platform: 'android' });
  });
});

describe('renderEntities / unifiedDiff (pure)', () => {
  it('renderEntities reproduces the committed pilot files byte-for-byte', () => {
    withCtx((ctx) => {
      const out = renderEntities('ios', {
        screens: [...ctx.map.screens.values(), ...ctx.map.gates.values()],
        recipes: [...ctx.map.recipes.values()],
        manifest: ctx.map.manifest,
        ids: ctx.map.ids,
      });
      assert.equal(out.size, ctx.map.files.size);
      for (const [rel, text] of out) {
        assert.ok(ctx.map.files.has(rel), `unexpected path ${rel}`);
        assert.equal(text, readFileSync(join(PILOT_APP_MAP_DIR, rel), 'utf8'), rel);
      }
      assert.equal(relPathFor('android', 'screen', 'login'), 'android/screens/login.yaml');
      assert.equal(relPathFor('ios', 'recipe', 'x'), 'ios/recipes/x.yaml');
      assert.equal(relPathFor('ios', 'manifest', 'manifest'), 'ios/manifest.yaml');
      assert.equal(relPathFor('ios', 'ids', 'ids'), 'ids.yaml');
    });
  });

  it('unifiedDiff: empty for equal texts, hunks with headers and 3 lines of context otherwise', () => {
    assert.equal(unifiedDiff('a\nb\n', 'a\nb\n', 'x'), '');
    const a = Array.from({ length: 12 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const b = a.replace('l6\n', 'L6\n');
    const d = unifiedDiff(a, b, 'f.yaml');
    assert.equal(d, ['--- a/f.yaml', '+++ b/f.yaml', '@@ -3,7 +3,7 @@', ' l3', ' l4', ' l5', '-l6', '+L6', ' l7', ' l8', ' l9', ''].join('\n'));
    // insertion into an empty file and deletion to an empty file
    assert.equal(unifiedDiff('', 'x\n', 'n'), '--- a/n\n+++ b/n\n@@ -1,0 +1,1 @@\n+x\n');
    assert.equal(unifiedDiff('x\n', '', 'n'), '--- a/n\n+++ b/n\n@@ -1,1 +1,0 @@\n-x\n');
    // two distant changes → two hunks
    const c = a.replace('l1\n', 'L1\n').replace('l12\n', 'L12\n');
    const d2 = unifiedDiff(a, c, 'f');
    assert.equal((d2.match(/^@@ /gm) ?? []).length, 2);
  });
});
