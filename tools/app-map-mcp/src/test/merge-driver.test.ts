/**
 * [A1] `app-map merge-driver` (02 §9): 3-way merge of id-keyed lists; add on one side + edit on
 * the other merges cleanly (02 §11); same-key change conflicts with git-style markers, exit 1.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { inferKindFromContent, inferKindFromPath, mergeYamlDocuments, runMergeDriver } from '../merge-driver.ts';
import type { IdsRegistry, RecipeFile, ScreenFile } from '../types.ts';
import { canonicalYaml, isCanonical } from '../yaml/canonical.ts';
import { PILOT_APP_MAP_DIR } from './helpers.ts';

const pilot = (rel: string): string => readFileSync(join(PILOT_APP_MAP_DIR, rel), 'utf8');
const edit = <T>(text: string, kind: 'screen' | 'recipe' | 'ids', fn: (d: T) => void): string => {
  const d = parse(text) as T;
  fn(d);
  return canonicalYaml(kind, d);
};

describe('mergeYamlDocuments', () => {
  it('add on one side + edit on the other merges cleanly and canonically (screen elements)', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const ours = edit<ScreenFile>(base, 'screen', (d) => {
      d.elements.push({ id: 'invoice.filter.sheet', role: 'sheet', locators: [{ strategy: 'a11y_id', value: 'invoice.filter.sheet', weight: 1 }, { strategy: 'path', value: 'sheet', weight: 0.25 }], status: 'candidate' });
      d.edges.push({ action: { type: 'tap', element: 'invoice.filter.button' }, to: 'invoice_list', status: 'candidate' });
    });
    const theirs = edit<ScreenFile>(base, 'screen', (d) => {
      const el = d.elements.find((e) => e.id === 'invoice.add.button')!;
      el.status = 'healed_pending_review';
      el.locators[2] = { strategy: 'text', value: 'Create Invoice', weight: 0.3 };
      d.meta.last_verified_build = '4413';
    });
    const r = mergeYamlDocuments('screen', base, ours, theirs);
    assert.deepEqual(r.conflicts, []);
    assert.ok(isCanonical('screen', r.merged));
    const m = parse(r.merged) as ScreenFile;
    assert.ok(m.elements.some((e) => e.id === 'invoice.filter.sheet'));
    assert.equal(m.elements.find((e) => e.id === 'invoice.add.button')!.status, 'healed_pending_review');
    assert.equal(m.elements.find((e) => e.id === 'invoice.add.button')!.locators[2]!.value, 'Create Invoice');
    assert.equal(m.meta.last_verified_build, '4413');
    assert.equal(m.edges.length, 3);
    assert.deepEqual(m.elements.map((e) => e.id), [...m.elements.map((e) => e.id)].sort(), 'id-sorted');
  });

  it('a file added on one branch only is taken verbatim (base and ours empty)', () => {
    const text = pilot('ios/screens/client_picker.yaml');
    const r = mergeYamlDocuments('screen', '', '', text);
    assert.deepEqual(r.conflicts, []);
    assert.equal(r.merged, text);
    assert.equal(mergeYamlDocuments('screen', '', text, '').merged, text);
  });

  it('the same key changed on both sides conflicts with git-style markers around canonical subtrees', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const ours = edit<ScreenFile>(base, 'screen', (d) => { d.elements[0]!.label = 'Add Invoice'; });
    const theirs = edit<ScreenFile>(base, 'screen', (d) => { d.elements[0]!.label = 'Create Invoice'; });
    const r = mergeYamlDocuments('screen', base, ours, theirs);
    assert.equal(r.conflicts.length, 1);
    assert.deepEqual(r.conflicts[0], { path: '/elements/invoice.add.button/label', base: 'New Invoice', ours: 'Add Invoice', theirs: 'Create Invoice' });
    const lines = r.merged.split('\n');
    const start = lines.indexOf('<<<<<<< ours');
    assert.ok(start >= 0, r.merged);
    assert.deepEqual(lines.slice(start, start + 5), ['<<<<<<< ours', '    label: Add Invoice', '=======', '    label: Create Invoice', '>>>>>>> theirs']);
    assert.ok(!r.merged.includes('__APPMAP_CONFLICT'));
    assert.ok(r.merged.endsWith('\n'));
    // the rest of the document is intact around the block
    assert.ok(lines.includes('  - id: invoice.add.button') && lines.includes('    role: button'));
  });

  it('identical changes on both sides and one-sided deletions merge cleanly; delete vs edit conflicts', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const same = edit<ScreenFile>(base, 'screen', (d) => { d.meta.status = 'candidate'; });
    assert.deepEqual(mergeYamlDocuments('screen', base, same, same).conflicts, []);
    const del = edit<ScreenFile>(base, 'screen', (d) => { d.elements = d.elements.filter((e) => e.id !== 'invoice.filter.button'); });
    const other = edit<ScreenFile>(base, 'screen', (d) => { d.title = 'All Invoices'; });
    const r = mergeYamlDocuments('screen', base, del, other);
    assert.deepEqual(r.conflicts, []);
    const m = parse(r.merged) as ScreenFile;
    assert.ok(!m.elements.some((e) => e.id === 'invoice.filter.button') && m.title === 'All Invoices');
    const editDeleted = edit<ScreenFile>(base, 'screen', (d) => { d.elements.find((e) => e.id === 'invoice.filter.button')!.status = 'candidate'; });
    const c = mergeYamlDocuments('screen', base, del, editDeleted);
    assert.equal(c.conflicts.length, 1);
    assert.equal(c.conflicts[0]!.path, '/elements/invoice.filter.button');
    assert.equal(c.conflicts[0]!.ours, undefined);
    const lines = c.merged.split('\n');
    const start = lines.indexOf('<<<<<<< ours');
    assert.equal(lines[start + 1], '=======', 'deleted side renders empty');
    assert.equal(lines[start + 2], '  - id: invoice.filter.button', 'list item rendered with its dash at the list indent');
  });

  it('ids.yaml: both sides add different elements → clean and sorted; same id with different kind → conflict', () => {
    const base = pilot('ids.yaml');
    const ours = edit<IdsRegistry>(base, 'ids', (d) => { d.elements.push({ id: 'zzz.new.button', kind: 'button' }); });
    const theirs = edit<IdsRegistry>(base, 'ids', (d) => { d.elements.push({ id: 'aaa.new.field', kind: 'field' }); d.screens.push({ id: 'settings', title: 'Settings', deep_link: 'appmap://settings' }); });
    const r = mergeYamlDocuments('ids', base, ours, theirs);
    assert.deepEqual(r.conflicts, []);
    const m = parse(r.merged) as IdsRegistry;
    assert.equal(m.elements[0]!.id, 'aaa.new.field');
    assert.equal(m.elements[m.elements.length - 1]!.id, 'zzz.new.button');
    assert.ok(m.screens.some((s) => s.id === 'settings'));
    assert.ok(isCanonical('ids', r.merged));
    const clash = edit<IdsRegistry>(base, 'ids', (d) => { d.elements.push({ id: 'zzz.new.button', kind: 'link' }); });
    const c = mergeYamlDocuments('ids', base, ours, clash);
    assert.equal(c.conflicts.length, 1);
    assert.equal(c.conflicts[0]!.path, '/elements/zzz.new.button/kind');
    assert.match(c.merged, /<<<<<<< ours\n    kind: button\n=======\n    kind: link\n>>>>>>> theirs/);
  });

  it('recipes: steps keyed by id keep order; both sides reordering differently conflicts; matches[] is ordered', () => {
    const base = pilot('ios/recipes/create_invoice.yaml');
    const ours = edit<RecipeFile>(base, 'recipe', (d) => { d.steps.push({ id: 's6', action: 'wait_for', expect: { screen: 'invoice_detail' } }); });
    const theirs = edit<RecipeFile>(base, 'recipe', (d) => { (d.steps[1] as { expect?: unknown }).expect = { focused: 'invoice.amount.field' }; d.status = 'ci_gate'; });
    const r = mergeYamlDocuments('recipe', base, ours, theirs);
    assert.deepEqual(r.conflicts, []);
    const m = parse(r.merged) as RecipeFile;
    assert.deepEqual(m.steps.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5', 's6']);
    assert.equal(m.status, 'ci_gate');
    const oursOrder = edit<RecipeFile>(base, 'recipe', (d) => { d.steps.reverse(); });
    const theirsOrder = edit<RecipeFile>(base, 'recipe', (d) => { const [a, b] = [d.steps[0]!, d.steps[1]!]; d.steps[0] = b; d.steps[1] = a; });
    assert.equal(mergeYamlDocuments('recipe', base, oursOrder, theirsOrder).conflicts[0]?.path, '/steps');
    const oursMatch = edit<RecipeFile>(base, 'recipe', (d) => { d.matches.push('invoice for .*'); });
    const theirsMatch = edit<RecipeFile>(base, 'recipe', (d) => { d.matches.unshift('new invoice'); });
    const c = mergeYamlDocuments('recipe', base, oursMatch, theirsMatch);
    assert.equal(c.conflicts[0]?.path, '/matches');
    assert.match(c.merged, /<<<<<<< ours\nmatches:\n  - /);
  });

  it('string sets merge as sets (both add different required_ids)', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const ours = edit<ScreenFile>(base, 'screen', (d) => { d.signature.required_ids!.push('nav.invoices.tab'); });
    const theirs = edit<ScreenFile>(base, 'screen', (d) => { d.signature.required_ids = d.signature.required_ids!.filter((x) => x !== 'invoice.list.table'); });
    const r = mergeYamlDocuments('screen', base, ours, theirs);
    assert.deepEqual(r.conflicts, []);
    assert.deepEqual((parse(r.merged) as ScreenFile).signature.required_ids, ['invoice.add.button', 'nav.invoices.tab']);
  });

  it('rejects non-mapping input as bad_input', () => {
    assert.throws(() => mergeYamlDocuments('ids', '- a\n', '- b\n', '- c\n'), /not a YAML mapping/);
  });
});

describe('runMergeDriver (git entry point)', () => {
  const setup = (base: string, ours: string, theirs: string): { dir: string; b: string; o: string; t: string } => {
    const dir = mkdtempSync(join(tmpdir(), 'app-map-merge-'));
    const b = join(dir, 'base.yaml');
    const o = join(dir, 'ours.yaml');
    const t = join(dir, 'theirs.yaml');
    writeFileSync(b, base);
    writeFileSync(o, ours);
    writeFileSync(t, theirs);
    return { dir, b, o, t };
  };

  it('exits 0 on a clean merge and writes canonical YAML to %A', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const ours = edit<ScreenFile>(base, 'screen', (d) => { d.title = 'All Invoices'; });
    const theirs = edit<ScreenFile>(base, 'screen', (d) => { d.meta.last_verified_build = '4413'; });
    const f = setup(base, ours, theirs);
    try {
      assert.equal(runMergeDriver(f.b, f.o, f.t, { realPath: 'app-map/ios/screens/invoice_list.yaml' }), 0);
      const out = readFileSync(f.o, 'utf8');
      assert.ok(isCanonical('screen', out));
      const m = parse(out) as ScreenFile;
      assert.equal(m.title, 'All Invoices');
      assert.equal(m.meta.last_verified_build, '4413');
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('exits 1 on a conflict and leaves markers in %A; infers the kind from content without %P', () => {
    const base = pilot('ios/screens/invoice_list.yaml');
    const ours = edit<ScreenFile>(base, 'screen', (d) => { d.title = 'All Invoices'; });
    const theirs = edit<ScreenFile>(base, 'screen', (d) => { d.title = 'Your Invoices'; });
    const f = setup(base, ours, theirs);
    try {
      assert.equal(runMergeDriver(f.b, f.o, f.t), 1);
      const out = readFileSync(f.o, 'utf8');
      assert.match(out, /<<<<<<< ours\ntitle: All Invoices\n=======\ntitle: Your Invoices\n>>>>>>> theirs\n/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on unreadable input or undecidable kind, leaving %A untouched', () => {
    const f = setup('a: [\n', 'a: 1\n', 'a: 2\n');
    try {
      assert.equal(runMergeDriver(f.b, f.o, f.t), 2);
      assert.equal(readFileSync(f.o, 'utf8'), 'a: 1\n');
      assert.equal(runMergeDriver(join(f.dir, 'missing.yaml'), f.o, f.t, { realPath: 'app-map/ids.yaml' }), 2);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('infers kinds from paths and from content', () => {
    assert.equal(inferKindFromPath('app-map/ids.yaml'), 'ids');
    assert.equal(inferKindFromPath('app-map/policy/mcp-allowlist.yaml'), 'mcp-allowlist');
    assert.equal(inferKindFromPath('app-map/ios/manifest.yaml'), 'manifest');
    assert.equal(inferKindFromPath('app-map/android/screens/login.yaml'), 'screen');
    assert.equal(inferKindFromPath('app-map/ios/recipes/create_invoice.yaml'), 'recipe');
    assert.equal(inferKindFromPath('/tmp/abc123.yaml'), undefined);
    assert.equal(inferKindFromContent({ steps: [] }), 'recipe');
    assert.equal(inferKindFromContent({ signature: {}, elements: [] }), 'screen');
    assert.equal(inferKindFromContent({ elements: [], screens: [] }), 'ids');
    assert.equal(inferKindFromContent({ servers: [] }), 'mcp-allowlist');
    assert.equal(inferKindFromContent({ app_id: 'x' }), 'manifest');
    assert.equal(inferKindFromContent({ other: 1 }), undefined);
  });
});
