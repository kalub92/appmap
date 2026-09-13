/** [B1] signature.ts — structural hash (02 §4.4), gate signatures (02 §4.2), labelNorm (02 §5.3). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { buildScrubPolicy, scrub } from '../scrub.ts';
import { gateSignatureMatches, labelNorm, observedSignature, requiredIdsFraction, roleLabelMatches, structuralHash, titleOf } from '../signature.ts';
import { allNodes, findByA11yId } from '../tree.ts';
import type { IdsRegistry, ScreenFile, Tree, TreeNode } from '../types.ts';
import { REDACTED, STRUCTURAL_HASH_REGEX } from '../types.ts';
import { PILOT_APP_MAP_DIR, PILOT_SCREEN_TREES, cloneTree, loadFixtureTree, loadStaticStringsFixture } from './helpers.ts';

function loadScreenFile(platform: 'ios' | 'android', id: string): ScreenFile {
  return parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, platform, 'screens', `${id}.yaml`), 'utf8')) as ScreenFile;
}
const INVOICE_LIST_HASH = 'sha1:262365d418093134bfe9b089192ab10fe3575007';
const NEW_INVOICES_UI_HASH = 'sha1:5b4f1a1248e62318577a669a261e799283ecc621';

describe('labelNorm (02 §5.3)', () => {
  it('lowercases, strips apostrophes and punctuation, collapses whitespace', () => {
    assert.equal(labelNorm('Don’t Allow'), 'dont allow');
    assert.equal(labelNorm("Don't Allow"), 'dont allow');
    assert.equal(labelNorm('New Invoice'), 'new invoice');
    assert.equal(labelNorm('  Sign-In!  '), 'sign in');
    assert.equal(labelNorm('Forgot password?'), 'forgot password');
    assert.equal(labelNorm('Ｆｕｌｌｗｉｄｔｈ ３'), 'fullwidth 3', 'NFKC');
    assert.equal(labelNorm('a\t\n b'), 'a b');
    assert.equal(labelNorm(''), '');
    assert.equal(labelNorm('$1,250.00'), '1 250 00');
    assert.equal(labelNorm('Sign in with Face ID'), 'sign in with face id');
  });
});

describe('structuralHash (02 §4.4)', () => {
  it('equals the committed signature.structural_hash of every pilot screen on both platforms', () => {
    for (const platform of ['ios', 'android'] as const) {
      for (const id of PILOT_SCREEN_TREES) {
        const screen = loadScreenFile(platform, id);
        const tree = loadFixtureTree(platform === 'ios' ? id : `android/${id}`);
        assert.equal(structuralHash(tree, screen.dynamic_regions ?? []), screen.signature.structural_hash, `${platform}/${id}`);
      }
    }
    assert.equal(structuralHash(loadFixtureTree('invoice_list'), ['invoice.list.table']), INVOICE_LIST_HASH);
    assert.match(INVOICE_LIST_HASH, STRUCTURAL_HASH_REGEX);
  });

  it('reproduces the new_invoices_ui variant hash', () => {
    const t = cloneTree(loadFixtureTree('invoice_list'));
    findByA11yId(t, 'invoice.list.table')[0]!.a11y_id = 'invoice.list.collection';
    const variant = loadScreenFile('ios', 'invoice_list').variants!.find((v) => v.id === 'new_invoices_ui')!;
    assert.equal(structuralHash(t, ['invoice.list.collection']), variant.structural_hash);
    assert.equal(variant.structural_hash, NEW_INVOICES_UI_HASH);
    assert.notEqual(structuralHash(t, ['invoice.list.collection']), INVOICE_LIST_HASH);
  });

  it('is stable under label, text, value, flag and layout changes', () => {
    const t = cloneTree(loadFixtureTree('invoice_list'));
    for (const n of allNodes(t)) {
      if (n.label !== undefined) n.label = `${n.label} (changed)`;
      n.text = 'extra';
      n.value = 'typed';
      n.enabled = false;
      n.bbox_norm = { x: 0.5, y: 0.5, w: 0.1, h: 0.1 };
    }
    t.root.children.reverse();
    assert.equal(structuralHash(t, ['invoice.list.table']), INVOICE_LIST_HASH);
    assert.equal(structuralHash({ ...t, platform: 'android', viewport: { w: 1, h: 1 } }, ['invoice.list.table']), INVOICE_LIST_HASH);
  });

  it('equals the hash of the scrubbed tree', () => {
    const ids = parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), 'utf8')) as IdsRegistry;
    const scrubbed = scrub(loadFixtureTree('invoice_list'), buildScrubPolicy(ids, loadStaticStringsFixture('ios')));
    assert.equal(structuralHash(scrubbed, ['invoice.list.table']), INVOICE_LIST_HASH);
  });

  it('changes when an id-bearing node is added, removed or re-roled; ignores id-less nodes', () => {
    const base = loadFixtureTree('invoice_list');
    const leaf = (extra: Partial<TreeNode>): TreeNode => ({ role: 'button', bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [], ...extra });
    const withId = cloneTree(base);
    withId.root.children.push(leaf({ a11y_id: 'extra.thing.button' }));
    assert.notEqual(structuralHash(withId, ['invoice.list.table']), INVOICE_LIST_HASH);
    const withoutId = cloneTree(base);
    withoutId.root.children.push(leaf({ label: 'Extra' }));
    assert.equal(structuralHash(withoutId, ['invoice.list.table']), INVOICE_LIST_HASH);
    const reRoled = cloneTree(base);
    findByA11yId(reRoled, 'invoice.add.button')[0]!.role = 'link';
    assert.notEqual(structuralHash(reRoled, ['invoice.list.table']), INVOICE_LIST_HASH);
    const removed = cloneTree(base);
    findByA11yId(removed, 'invoice.filter.button')[0]!.a11y_id = undefined;
    assert.notEqual(structuralHash(removed, ['invoice.list.table']), INVOICE_LIST_HASH);
    const emptyId = cloneTree(base);
    findByA11yId(emptyId, 'invoice.filter.button')[0]!.a11y_id = '';
    assert.equal(structuralHash(emptyId, ['invoice.list.table']), structuralHash(removed, ['invoice.list.table']), 'an empty id counts as absent');
  });

  it('excludes descendants of dynamic regions but includes the region node itself; duplicates are kept', () => {
    const base = loadFixtureTree('invoice_list');
    const all = structuralHash(base, []);
    assert.notEqual(all, INVOICE_LIST_HASH, 'without regions the six cells are hashed');
    const fewerCells = cloneTree(base);
    findByA11yId(fewerCells, 'invoice.list.table')[0]!.children.pop();
    assert.notEqual(structuralHash(fewerCells, []), all, 'duplicates count');
    assert.equal(structuralHash(fewerCells, ['invoice.list.table']), INVOICE_LIST_HASH, 'row count is invisible under the region');
    const noTableId = cloneTree(base);
    findByA11yId(noTableId, 'invoice.list.table')[0]!.a11y_id = undefined;
    assert.notEqual(structuralHash(noTableId, ['invoice.list.table']), INVOICE_LIST_HASH, 'the region node itself is hashed');
    assert.equal(structuralHash(base, ['invoice.list.table', 'not.in.tree']), INVOICE_LIST_HASH, 'unknown regions are harmless');
    assert.equal(structuralHash(base), all, 'default: no regions');
  });

  it('ignores `[redacted]` ids (row data leaked into a resource-id is not structure)', () => {
    const t = cloneTree(loadFixtureTree('invoice_list'));
    findByA11yId(t, 'invoice.list.cell')[0]!.a11y_id = REDACTED;
    assert.equal(structuralHash(t, ['invoice.list.table']), INVOICE_LIST_HASH);
    const base = structuralHash(loadFixtureTree('invoice_list'), []);
    assert.notEqual(structuralHash(t, []), base, 'one registered cell id fewer');
    t.root.children.push({ role: 'cell', a11y_id: REDACTED, bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] });
    assert.equal(structuralHash(t, ['invoice.list.table']), INVOICE_LIST_HASH);
  });

  it('hashes an id-less tree to sha1 of the empty string and formats as sha1:<40 hex>', () => {
    const noIds = loadFixtureTree('invoice_list.no_ids');
    assert.equal(structuralHash(noIds), 'sha1:da39a3ee5e6b4b0d3255bfef95601890afd80709');
    for (const id of PILOT_SCREEN_TREES) assert.match(structuralHash(loadFixtureTree(id)), STRUCTURAL_HASH_REGEX);
  });
});

describe('requiredIdsFraction (03 §5.4)', () => {
  it('reports the present fraction and the missing ids', () => {
    const tree = loadFixtureTree('invoice_list');
    assert.deepEqual(requiredIdsFraction(tree, ['invoice.add.button', 'invoice.list.table']), { fraction: 1, missing: [] });
    assert.deepEqual(requiredIdsFraction(tree, ['invoice.add.button', 'invoice.list.collection']), { fraction: 0.5, missing: ['invoice.list.collection'] });
    assert.deepEqual(requiredIdsFraction(tree, ['a.b.c', 'd.e.f', 'g.h.i', 'invoice.add.button']), { fraction: 0.25, missing: ['a.b.c', 'd.e.f', 'g.h.i'] });
    assert.deepEqual(requiredIdsFraction(tree, []), { fraction: 1, missing: [] });
    assert.deepEqual(requiredIdsFraction(tree, ['invoice.add.button', 'invoice.add.button']), { fraction: 1, missing: [] }, 'duplicates collapse');
    assert.deepEqual(requiredIdsFraction(loadFixtureTree('invoice_list.no_ids'), ['invoice.add.button']), { fraction: 0, missing: ['invoice.add.button'] });
  });
});

describe('roleLabelMatches', () => {
  const node: TreeNode = { role: 'button', label: 'Don’t Allow', bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] };
  it('matches role + exact (trimmed) label or role + regex', () => {
    assert.ok(roleLabelMatches(node, { role: 'button', label: 'Don’t Allow' }));
    assert.ok(roleLabelMatches({ ...node, label: ' Don’t Allow ' }, { role: 'button', label: 'Don’t Allow' }), 'exact label is trimmed');
    assert.ok(roleLabelMatches(node, { role: 'button', label: ' Don’t Allow\n' }));
    assert.equal(roleLabelMatches({ ...node, label: ' Don’t Allow ' }, { role: 'button', label_regex: '^Don.t Allow$' }), false, 'label_regex runs on the untrimmed labelOf');
    assert.ok(roleLabelMatches(node, { role: 'button', label_regex: '^Don.t Allow$' }));
    assert.ok(roleLabelMatches(node, { role: 'button', label_regex: '^(Allow|Don.t Allow)$' }));
    assert.equal(roleLabelMatches(node, { role: 'tab', label: 'Don’t Allow' }), false, 'role must equal');
    assert.equal(roleLabelMatches(node, { role: 'button', label: 'Allow' }), false);
    assert.equal(roleLabelMatches(node, { role: 'button', label: 'don’t allow' }), false, 'case-sensitive');
    assert.equal(roleLabelMatches(node, { role: 'button', label_regex: '^Allow$' }), false);
    assert.equal(roleLabelMatches(node, { role: 'button', label_regex: '(' }), false, 'invalid regex never matches');
    assert.equal(roleLabelMatches({ ...node, label: undefined }, { role: 'button', label: 'x' }), false);
    assert.equal(roleLabelMatches({ ...node, label: undefined }, { role: 'button', label_regex: '.*' }), false, 'no label → no regex match');
    assert.ok(roleLabelMatches({ ...node, label: undefined, text: 'Allow' }, { role: 'button', label: 'Allow' }), 'falls back to text (labelOf)');
    assert.ok(roleLabelMatches(node, { role: 'button' }), 'role-only value matches on role');
  });
});

describe('gateSignatureMatches (02 §4.2)', () => {
  const push = loadScreenFile('ios', 'gate.push_permission');
  const bio = loadScreenFile('ios', 'gate.biometric_prompt');

  it('matches the with_gate fixtures and not the plain ones', () => {
    assert.equal(gateSignatureMatches(loadFixtureTree('invoice_list.with_gate'), push), true);
    assert.equal(gateSignatureMatches(loadFixtureTree('invoice_list.with_gate'), bio), false);
    assert.equal(gateSignatureMatches(loadFixtureTree('login.with_gate'), bio), true);
    assert.equal(gateSignatureMatches(loadFixtureTree('login.with_gate'), push), false);
    for (const id of [...PILOT_SCREEN_TREES, 'pii', 'invoice_list.no_ids']) {
      assert.equal(gateSignatureMatches(loadFixtureTree(id), push), false, `${id} × push`);
      assert.equal(gateSignatureMatches(loadFixtureTree(id), bio), false, `${id} × bio`);
    }
  });

  it('requires EVERY required_labels entry and the marker when it is not none', () => {
    const t = cloneTree(loadFixtureTree('login.with_gate'));
    const cancel = allNodes(t).find((n) => n.role === 'button' && n.label === 'Cancel')!;
    cancel.label = 'Dismiss';
    assert.equal(gateSignatureMatches(t, bio), false, 'one label missing → no match');
    const withMarker: ScreenFile = { ...push, signature: { marker: 'screen.invoice_list', required_labels: push.signature.required_labels } };
    assert.equal(gateSignatureMatches(loadFixtureTree('invoice_list.with_gate'), withMarker), true);
    assert.equal(gateSignatureMatches(loadFixtureTree('invoice_list.with_gate'), { ...push, signature: { marker: 'screen.login', required_labels: push.signature.required_labels } }), false);
    const markerOnly: ScreenFile = { ...push, signature: { marker: 'screen.login' } };
    assert.equal(gateSignatureMatches(loadFixtureTree('login'), markerOnly), true);
    assert.equal(gateSignatureMatches(loadFixtureTree('invoice_list'), markerOnly), false);
    assert.equal(gateSignatureMatches(loadFixtureTree('login'), { ...push, signature: { marker: 'none' } }), false, 'no signature never matches');
    assert.equal(gateSignatureMatches(loadFixtureTree('login'), { ...push, signature: { marker: 'none', required_labels: [] } }), false);
  });

  it('still matches after scrubbing (gate button labels are static strings)', () => {
    const ids = parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), 'utf8')) as IdsRegistry;
    const policy = buildScrubPolicy(ids, loadStaticStringsFixture('ios'));
    assert.equal(gateSignatureMatches(scrub(loadFixtureTree('invoice_list.with_gate'), policy), push), true);
    assert.equal(gateSignatureMatches(scrub(loadFixtureTree('login.with_gate'), policy), bio), true);
  });
});

describe('titleOf (03 §5.6)', () => {
  it('returns the navigation bar label, else its first staticText, else undefined', () => {
    assert.equal(titleOf(loadFixtureTree('invoice_list')), 'Invoices');
    assert.equal(titleOf(loadFixtureTree('invoice_new')), 'New Invoice');
    assert.equal(titleOf(loadFixtureTree('invoice_list.no_ids')), 'Invoices');
    assert.equal(titleOf(loadFixtureTree('login')), undefined, 'no navigation bar');
    const t = cloneTree(loadFixtureTree('invoice_list'));
    const nav = allNodes(t).find((n) => n.role === 'navigationBar')!;
    nav.label = undefined;
    nav.children.unshift({ role: 'staticText', label: 'Title Text', bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] });
    assert.equal(titleOf(t), 'Title Text');
    nav.children.shift();
    assert.equal(titleOf(t), undefined);
  });
});

describe('observedSignature (02 §7)', () => {
  it('records marker, hash with the screen dynamic regions and the required_ids fraction', () => {
    const screen = loadScreenFile('ios', 'invoice_list');
    const tree = loadFixtureTree('invoice_list');
    assert.deepEqual(observedSignature(tree, screen), { marker: 'screen.invoice_list', structural_hash: INVOICE_LIST_HASH, required_present: 1 });
    const unknown = observedSignature(tree);
    assert.equal(unknown.marker, 'screen.invoice_list');
    assert.equal(unknown.structural_hash, structuralHash(tree, []));
    assert.equal(unknown.required_present, 0, '0 when the screen is unknown');
    const noIds = observedSignature(loadFixtureTree('invoice_list.no_ids'), screen);
    assert.equal(noIds.marker, 'none');
    assert.equal(noIds.required_present, 0);
    const two = cloneTree(tree);
    two.root.children[0]!.children[0]!.a11y_id = 'screen.other';
    // 01 R3 as amended by issue #10: two markers no longer degrade to `none` — the deepest wins,
    // and at equal depth that is the greater `y` (`screen.other` is the status bar at y 0)
    assert.equal(observedSignature(two, screen).marker, 'screen.invoice_list', 'two markers → the deepest');
    const pushed = cloneTree(tree);
    findByA11yId(pushed, 'invoice.list.table')[0]!.children.push({ role: 'container', a11y_id: 'screen.invoice_detail', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [] });
    assert.equal(observedSignature(pushed, screen).marker, 'screen.invoice_detail', 'a pushed screen is deeper');
    const synthetic: Tree = { schema_version: 1, platform: 'ios', source: 'synthetic', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [] } };
    assert.deepEqual(observedSignature(synthetic, { ...screen, signature: { marker: 'screen.x' } }), { marker: 'none', structural_hash: structuralHash(synthetic), required_present: 1 });
  });
});
