/**
 * [A1] `app-map migrate-id` (02 §8): element, screen and gate renames across ids.yaml, every
 * platform's screens and recipes, in a temp copy of the pilot; canonical output; refusals.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { migrateId, rewriteIdReferences } from '../migrate-id.ts';
import type { RecipeFile, ScreenFile } from '../types.ts';
import { formatIssues, nonCanonicalFiles, validateMap } from '../validate.ts';
import { loadMap } from '../yaml/load.ts';
import { makeTempAppMapDir } from './helpers.ts';

function* walkYaml(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.local') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkYaml(p);
    else if (name.endsWith('.yaml')) yield p;
  }
}
/** lines mentioning `id` as a whole word (so `screen.<id>` markers and `appmap://<id>` count) across every YAML under `dir` */
function referenceLines(dir: string, id: string): number {
  const re = new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`);
  let n = 0;
  for (const f of walkYaml(dir)) for (const line of readFileSync(f, 'utf8').split('\n')) if (re.test(line)) n++;
  return n;
}
function mentions(dir: string, id: string): string[] {
  const re = new RegExp(`\\b${id.replace(/\./g, '\\.')}\\b`);
  return [...walkYaml(dir)].filter((f) => re.test(readFileSync(f, 'utf8')));
}

describe('migrateId', () => {
  it('renames an element id across ids.yaml, both platforms\' screens and the recipe, canonically', () => {
    const t = makeTempAppMapDir();
    try {
      const before = referenceLines(t.dir, 'invoice.add.button');
      assert.ok(before >= 9, `pilot references: ${before}`);
      const r = migrateId(t.config, 'invoice.add.button', 'invoice.create.button');
      assert.equal(r.old_id, 'invoice.add.button');
      assert.equal(r.new_id, 'invoice.create.button');
      assert.equal(r.references, before, 'every reference line rewritten, nothing else');
      assert.deepEqual([...r.files_changed].sort(), ['android/screens/invoice_list.yaml', 'ids.yaml', 'ios/screens/invoice_list.yaml']);
      assert.deepEqual(mentions(t.dir, 'invoice.add.button'), [], 'zero dangling references');
      assert.equal(referenceLines(t.dir, 'invoice.create.button'), before);
      const v = validateMap(t.config);
      assert.ok(v.ok, formatIssues(v.issues));
      assert.deepEqual(nonCanonicalFiles(t.config), []);
      const map = loadMap(t.config);
      assert.ok(map.elementRegistry.has('invoice.create.button') && !map.elementRegistry.has('invoice.add.button'));
      assert.equal(readFileSync(join(t.dir, '.local/strings.ios.txt'), 'utf8').length > 0, true, '.local is never touched');
      const el = map.screens.get('invoice_list')!.elements.find((e) => e.id === 'invoice.create.button')!;
      assert.equal(el.label, 'New Invoice', 'labels are never rewritten');
      assert.equal(el.locators[0]!.value, 'invoice.create.button', 'a11y_id locator value follows the id');
      assert.deepEqual(map.screens.get('invoice_list')!.signature.required_ids, ['invoice.create.button', 'invoice.list.table'], 're-sorted canonically');
    } finally {
      t.cleanup();
    }
  });

  it('renames a screen id: file, marker, deep links, edges, recipe fallback_path/expect and ids.yaml', () => {
    const t = makeTempAppMapDir();
    try {
      const before = referenceLines(t.dir, 'client_picker');
      const r = migrateId(t.config, 'client_picker', 'client_chooser');
      assert.equal(r.references, before);
      assert.ok(r.files_changed.includes('ios/screens/client_chooser.yaml') && r.files_changed.includes('android/screens/client_chooser.yaml'));
      assert.ok(!existsSync(join(t.dir, 'ios/screens/client_picker.yaml')) && existsSync(join(t.dir, 'ios/screens/client_chooser.yaml')));
      assert.deepEqual(mentions(t.dir, 'client_picker'), []);
      const v = validateMap(t.config);
      assert.ok(v.ok, formatIssues(v.issues));
      const map = loadMap(t.config);
      const s = map.screens.get('client_chooser')!;
      assert.equal(s.signature.marker, 'screen.client_chooser');
      assert.equal(s.title, 'Choose Client', 'title untouched');
      assert.equal(map.markers.get('screen.client_chooser'), 'client_chooser');
      const recipe = map.recipes.get('create_invoice')!;
      assert.equal((recipe.steps[2] as { expect: { screen: string } }).expect.screen, 'client_chooser');
      assert.ok(map.screens.get('invoice_new')!.edges.some((e) => e.to === 'client_chooser'));
      assert.ok(map.ids.screens.some((x) => x.id === 'client_chooser') && !map.ids.screens.some((x) => x.id === 'client_picker'));
      // a screen with a deep link: the route segment moves too (01 R5)
      const r2 = migrateId(t.config, 'invoice_detail', 'invoice_view');
      assert.ok(r2.references > 0);
      const m2 = loadMap(t.config);
      assert.equal(m2.screens.get('invoice_view')!.deep_link, 'appmap://invoice_view?fixture=one_draft_invoice');
      assert.equal(m2.screens.get('invoice_view')!.signature.route, 'appmap://invoice_view?fixture=one_draft_invoice');
      assert.equal(m2.ids.screens.find((x) => x.id === 'invoice_view')!.deep_link, 'appmap://invoice_view');
      assert.equal(m2.routes.get('appmap://invoice_view'), 'invoice_view');
      assert.ok(validateMap(t.config).ok);
    } finally {
      t.cleanup();
    }
  });

  it('renames a gate id together with its dismiss control and file', () => {
    const t = makeTempAppMapDir();
    try {
      const r = migrateId(t.config, 'gate.push_permission', 'gate.notification_permission');
      assert.ok(r.references >= 10, `references ${r.references}`);
      assert.deepEqual(mentions(t.dir, 'gate.push_permission'), []);
      assert.ok(existsSync(join(t.dir, 'ios/screens/gate.notification_permission.yaml')));
      const v = validateMap(t.config);
      assert.ok(v.ok, formatIssues(v.issues));
      const map = loadMap(t.config);
      assert.ok(map.gates.has('gate.notification_permission'));
      assert.equal(map.ids.gates.find((g) => g.id === 'gate.notification_permission')!.dismiss, 'gate.notification_permission.deny');
      assert.ok(map.elementRegistry.has('gate.notification_permission.deny'));
      assert.deepEqual(map.screens.get('invoice_list')!.gates, ['gate.notification_permission']);
      // renaming just the dismiss verb keeps the gate prefix
      const r2 = migrateId(t.config, 'gate.notification_permission.deny', 'gate.notification_permission.dismiss');
      assert.ok(r2.references >= 4);
      assert.ok(validateMap(t.config).ok);
    } finally {
      t.cleanup();
    }
  });

  it('refuses unknown, malformed, existing and cross-gate ids; dry runs write nothing', () => {
    const t = makeTempAppMapDir();
    try {
      const bad = (fn: () => unknown, re: RegExp): void => assert.throws(fn, (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && re.test(e.message));
      bad(() => migrateId(t.config, 'invoice.ghost.button', 'invoice.x.button'), /not registered/);
      bad(() => migrateId(t.config, 'invoice.add.button', 'Invoice.Add.Button'), /01 R2/);
      bad(() => migrateId(t.config, 'invoice.add.button', 'add.button'), /01 R2/);
      bad(() => migrateId(t.config, 'invoice.add.button', 'gate.add.button'), /01 R2/);
      bad(() => migrateId(t.config, 'invoice.add.button', 'invoice.save.button'), /already exists/);
      bad(() => migrateId(t.config, 'invoice.add.button', 'invoice.add.button'), /equals/);
      bad(() => migrateId(t.config, 'login', 'invoice.list'), /01 R2/);
      bad(() => migrateId(t.config, 'login', 'invoice_list'), /already exists/);
      bad(() => migrateId(t.config, 'gate.push_permission', 'push_permission'), /01 R2/);
      bad(() => migrateId(t.config, 'gate.push_permission.deny', 'gate.biometric_prompt.deny'), /dismiss control of gate\.push_permission/);
      const before = new Map([...walkYaml(t.dir)].map((f) => [f, readFileSync(f, 'utf8')]));
      const dry = migrateId(t.config, 'invoice.add.button', 'invoice.create.button', { dryRun: true });
      assert.equal(dry.files_changed.length, 3);
      assert.ok(dry.references > 0);
      for (const [f, text] of before) assert.equal(readFileSync(f, 'utf8'), text, f);
    } finally {
      t.cleanup();
    }
  });
});

describe('rewriteIdReferences (pure)', () => {
  it('rewrites only whole-string matches on id-bearing keys, never labels or text', () => {
    const screen: ScreenFile = {
      id: 'x', kind: 'screen', title: 'a.b.c', deep_link: 'appmap://x',
      signature: { marker: 'screen.x', route: 'appmap://x?fixture=y', required_ids: ['a.b.c'] },
      dynamic_regions: ['a.b.c'],
      elements: [{ id: 'a.b.c', role: 'button', label: 'a.b.c', locators: [{ strategy: 'a11y_id', value: 'a.b.c', weight: 1 }, { strategy: 'text', value: 'a.b.c', weight: 0.3 }], status: 'candidate' }],
      edges: [{ action: { type: 'tap', element: 'a.b.c' }, to: 'x', status: 'candidate' }],
      meta: { sources: ['manual'], status: 'candidate' },
    };
    const { doc, count } = rewriteIdReferences(screen, 'a.b.c', 'a.b.d');
    assert.equal(count, 5, 'element id, a11y_id value, required_ids, dynamic_regions, edge element');
    assert.equal(doc.title, 'a.b.c');
    assert.equal(doc.elements[0]!.label, 'a.b.c');
    assert.equal(doc.elements[0]!.locators[1]!.value, 'a.b.c', 'text locator untouched');
    assert.equal(doc.elements[0]!.locators[0]!.value, 'a.b.d');
    assert.deepEqual(doc.signature.required_ids, ['a.b.d']);
    assert.deepEqual(doc.dynamic_regions, ['a.b.d']);
    assert.equal((doc.edges[0]!.action as { element: string }).element, 'a.b.d');
    assert.equal(screen.elements[0]!.id, 'a.b.c', 'input untouched');
    // screen rename: marker, deep links and `to`
    const s = rewriteIdReferences(screen, 'x', 'y');
    assert.equal(s.count, 5);
    assert.equal(s.doc.id, 'y');
    assert.equal(s.doc.signature.marker, 'screen.y');
    assert.equal(s.doc.deep_link, 'appmap://y');
    assert.equal(s.doc.signature.route, 'appmap://y?fixture=y');
    assert.equal(s.doc.edges[0]!.to, 'y');
    // recipe: type text equal to an id is copy, not a reference
    const recipe = { id: 'r', steps: [{ id: 's1', action: 'type', element: 'a.b.c', text: 'a.b.c' }, { id: 's2', action: 'select', list: 'a.b.c', match: { text: 'a.b.c' }, expect: { focused: 'a.b.c', visible: ['a.b.c'], not_visible: ['q.q.q'] } }], entry: { fallback_path: ['x'] } } as unknown as RecipeFile;
    const rr = rewriteIdReferences(recipe, 'a.b.c', 'a.b.d');
    assert.equal(rr.count, 4);
    assert.equal((rr.doc.steps[0] as { text: string }).text, 'a.b.c');
    assert.equal((rr.doc.steps[1] as { match: { text: string } }).match.text, 'a.b.c');
    assert.equal(rewriteIdReferences(recipe, 'x', 'z').doc.entry.fallback_path![0], 'z');
    // gate rename carries the dismiss prefix
    const g = rewriteIdReferences({ gates: [{ id: 'gate.a', dismiss: 'gate.a.deny' }], elements: [{ id: 'gate.a.deny' }] }, 'gate.a', 'gate.b');
    assert.equal(g.count, 3);
    assert.deepEqual(g.doc, { gates: [{ id: 'gate.b', dismiss: 'gate.b.deny' }], elements: [{ id: 'gate.b.deny' }] });
  });
});
