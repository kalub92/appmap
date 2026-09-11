/** [B1] tree.ts — normalization of the three input shapes, queries, paths (02 §5.1), bbox. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import {
  allNodes, centerOf, compactJson, countNodes, detectTreeShape, extractSnapshot, findByA11yId, findMarkerNodes,
  fromArgentSnapshot, fromMaestroHierarchy, isNormalizedTree, labelOf, nodeAtPath, nodesWithRole, normalizeTree,
  parentOf, pathOf, rolePath, screenRoot, siblingIndex, walk,
} from '../tree.ts';
import type { ScreenFile, Tree, TreeNode } from '../types.ts';
import { PILOT_APP_MAP_DIR, PILOT_SCREEN_TREES, cloneTree, loadFixtureTree, loadHookFixture, readJsonFixture } from './helpers.ts';

const argentRaw = (): unknown => readJsonFixture('raw/argent-snapshot.invoice_list.json');
const maestroRaw = (): unknown => readJsonFixture('raw/maestro-hierarchy.invoice_list.json');

/** the comparable shape of a tree: role, id, label, bbox and flags per node in pre-order */
function projection(t: Tree): string[] {
  return allNodes(t).map((n) => [n.role, n.a11y_id ?? '', n.label ?? '', JSON.stringify(n.bbox_norm), n.enabled, n.focused, n.selected].join('|'));
}

function loadScreenFile(id: string): ScreenFile {
  return parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, 'ios', 'screens', `${id}.yaml`), 'utf8')) as ScreenFile;
}

describe('detectTreeShape', () => {
  it('recognizes the three shapes and rejects the rest', () => {
    assert.equal(detectTreeShape(loadFixtureTree('invoice_list')), 'normalized');
    assert.equal(detectTreeShape(argentRaw()), 'argent');
    assert.equal(detectTreeShape((argentRaw() as { root: unknown }).root), 'argent', 'bare Argent node');
    assert.equal(detectTreeShape(maestroRaw()), 'maestro');
    assert.equal(detectTreeShape((maestroRaw() as { elements: unknown[] }).elements[0]), 'maestro', 'bare maestro node');
    for (const bad of [null, undefined, 42, 'text', [], {}, { root: {} }, { elements: [] }, { elements: [{}] }]) {
      assert.equal(detectTreeShape(bad), 'unknown', JSON.stringify(bad));
    }
  });
});

describe('normalizeTree', () => {
  it('normalizes the Argent snapshot, the maestro hierarchy and the normalized file to the same shape', () => {
    const expected = loadFixtureTree('invoice_list');
    const fromArgent = normalizeTree(argentRaw(), { platform: 'ios' });
    const fromMaestro = normalizeTree(maestroRaw(), { platform: 'android' });
    const fromNormalized = normalizeTree(expected, { platform: 'ios' });
    assert.equal(fromArgent.source, 'argent');
    assert.equal(fromMaestro.source, 'maestro');
    assert.equal(fromNormalized.source, 'normalized');
    assert.deepEqual(projection(fromArgent), projection(expected));
    assert.deepEqual(projection(fromMaestro), projection(expected));
    assert.deepEqual(projection(fromNormalized), projection(expected));
    assert.deepEqual(fromArgent.viewport, { w: 390, h: 844 });
    assert.deepEqual(fromMaestro.viewport, { w: 390, h: 844 });
    assert.ok(isNormalizedTree(fromArgent) && isNormalizedTree(fromMaestro));
  });

  it('keeps every bbox within 0.01 of the reference (architecture.md B1)', () => {
    const expected = allNodes(loadFixtureTree('invoice_list'));
    for (const t of [normalizeTree(argentRaw(), { platform: 'ios' }), normalizeTree(maestroRaw(), { platform: 'android' })]) {
      const got = allNodes(t);
      assert.equal(got.length, expected.length);
      got.forEach((n, i) => {
        for (const k of ['x', 'y', 'w', 'h'] as const) assert.ok(Math.abs(n.bbox_norm[k] - expected[i]!.bbox_norm[k]) <= 0.01, `${i}.${k}`);
      });
    }
  });

  it('honours opts.source and leaves the normalized input untouched', () => {
    const input = loadFixtureTree('invoice_list');
    const before = JSON.stringify(input);
    const t = normalizeTree(input, { platform: 'ios', source: 'synthetic' });
    assert.equal(t.source, 'synthetic');
    assert.equal(JSON.stringify(input), before);
    assert.equal(normalizeTree(argentRaw(), { platform: 'ios', source: 'synthetic' }).source, 'synthetic');
  });

  it('accepts a JSON string and rejects garbage with bad_input + hint', () => {
    const t = normalizeTree(JSON.stringify(argentRaw()), { platform: 'ios' });
    assert.equal(t.root.role, 'application');
    for (const bad of ['{not json', { hello: 'world' }, 42, null]) {
      assert.throws(() => normalizeTree(bad, { platform: 'ios' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && e.hint.length > 0);
    }
  });

  it('names the structural problem of a malformed normalized tree', () => {
    const t = cloneTree(loadFixtureTree('invoice_list')) as unknown as { root: { children: Array<{ role: string }> } };
    t.root.children[0]!.role = 'Widget';
    assert.throws(() => normalizeTree(t, { platform: 'ios' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /role/.test(e.message) && /children\[0\]/.test(e.message));
  });

  it('never trusts a `scrubbed` flag on its input (only scrub() mints it)', () => {
    const t = { ...loadFixtureTree('invoice_list'), scrubbed: true, scrub_hits: 3 };
    const out = normalizeTree(t, { platform: 'ios' });
    assert.equal(out.scrubbed, undefined);
    assert.equal((out as { scrub_hits?: number }).scrub_hits, undefined);
  });
});

describe('fromArgentSnapshot', () => {
  it('maps the wrapper: build_number → build, bundle_id → app_id, udid dropped (07 §2.2)', () => {
    const t = fromArgentSnapshot(argentRaw(), 'ios');
    assert.equal(t.build, '4412');
    assert.equal(t.app_id, 'com.example.app');
    assert.ok(!JSON.stringify(t).includes('00000000-0000'), 'udid must not survive');
    assert.ok(!('udid' in t));
    assert.equal(t.platform, 'ios');
    assert.equal(t.schema_version, 1);
  });

  it('accepts a bare node (viewport from the root frame), numeric build numbers, hasFocus and value', () => {
    const raw = {
      type: 'Application', frame: { x: 0, y: 0, width: 200, height: 400 },
      children: [{ type: 'TextField', identifier: 'x.y.field', label: 'Email', value: 'a@b.co', hasFocus: true, enabled: false, frame: { x: 10, y: 20, width: 100, height: 40 }, children: [] }],
    };
    const t = fromArgentSnapshot(raw, 'ios');
    assert.deepEqual(t.viewport, { w: 200, h: 400 });
    const f = t.root.children[0]!;
    assert.equal(f.role, 'field');
    assert.equal(f.a11y_id, 'x.y.field');
    assert.equal(f.value, 'a@b.co');
    assert.equal(f.focused, true);
    assert.equal(f.enabled, false);
    assert.deepEqual(f.bbox_norm, { x: 0.05, y: 0.05, w: 0.5, h: 0.1 });
    assert.equal(fromArgentSnapshot({ root: raw, build_number: 4413 }, 'ios').build, '4413');
    assert.throws(() => fromArgentSnapshot({ root: { label: 'no type' } }, 'ios'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });

  it('derives roles: Button under TabBar → tab, StaticText in Cell stays, unknown type → other, empty identifier → absent', () => {
    const raw = {
      type: 'Application', frame: { x: 0, y: 0, width: 100, height: 100 },
      children: [
        { type: 'TabBar', frame: { x: 0, y: 90, width: 100, height: 10 }, children: [{ type: 'Button', identifier: '', label: 'A', frame: { x: 0, y: 90, width: 50, height: 10 }, children: [] }] },
        { type: 'Cell', frame: { x: 0, y: 0, width: 100, height: 10 }, children: [{ type: 'StaticText', label: 'x', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] }] },
        { type: 'Slider', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] },
      ],
    };
    const t = fromArgentSnapshot(raw, 'ios');
    const [tabBar, cell, slider] = t.root.children;
    assert.equal(tabBar!.role, 'tabBar');
    assert.equal(tabBar!.children[0]!.role, 'tab');
    assert.equal(tabBar!.children[0]!.a11y_id, undefined);
    assert.equal(cell!.role, 'cell');
    assert.equal(cell!.children[0]!.role, 'staticText');
    assert.equal(slider!.role, 'other');
  });

  it('normalizes bboxes: ÷ viewport, clamped to [0,1], 4 decimals, no NaN on a zero viewport', () => {
    const raw = {
      root: { type: 'Application', frame: { x: 0, y: 0, width: 390, height: 844 }, children: [
        { type: 'Other', frame: { x: -10, y: 800, width: 500, height: 100 }, children: [] },
        { type: 'Other', frame: { x: 1, y: 1, width: 1, height: 1 }, children: [] },
      ] },
      screen: { width: 390, height: 844 },
    };
    const t = fromArgentSnapshot(raw, 'ios');
    assert.deepEqual(t.root.children[0]!.bbox_norm, { x: 0, y: 0.9479, w: 1, h: 0.1185 });
    assert.deepEqual(t.root.children[1]!.bbox_norm, { x: 0.0026, y: 0.0012, w: 0.0026, h: 0.0012 });
    const zero = fromArgentSnapshot({ type: 'Application', frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] }, 'ios');
    assert.deepEqual(zero.root.bbox_norm, { x: 0, y: 0, w: 0, h: 0 });
    assert.equal(zero.viewport, undefined);
    assert.ok(isNormalizedTree(t) && isNormalizedTree(zero));
  });
});

describe('fromMaestroHierarchy', () => {
  it('parses bounds, resource-id, accessibilityText/text and string flags', () => {
    const t = fromMaestroHierarchy(maestroRaw(), 'android');
    const add = findByA11yId(t, 'invoice.add.button')[0]!;
    assert.equal(add.role, 'button');
    assert.equal(add.label, 'New Invoice');
    assert.equal(add.text, undefined, 'text equal to the label is not duplicated');
    assert.equal(add.enabled, true);
    assert.deepEqual(add.bbox_norm, { x: 0.7179, y: 0.0604, w: 0.2564, h: 0.0427 });
    const tab = findByA11yId(t, 'nav.invoices.tab')[0]!;
    assert.equal(tab.role, 'tab');
    assert.equal(tab.selected, true);
    assert.equal(findByA11yId(t, 'nav.clients.tab')[0]!.selected, false);
    assert.equal(findByA11yId(t, 'invoice.list.cell').length, 6);
    assert.ok(findByA11yId(t, 'invoice.list.cell').every((c) => c.role === 'cell'));
    assert.equal(t.root.role, 'application');
    assert.equal(t.root.children[0]!.role, 'window');
  });

  it('puts the typed text of an input into `value`, never `label` (07 §2.3.1)', () => {
    const raw = { elements: [{ attributes: { class: 'android.widget.FrameLayout', bounds: '[0,0][100,100]' }, children: [
      { attributes: { 'resource-id': 'login.email.field', class: 'androidx.appcompat.widget.AppCompatEditText', text: 'me@example.com', accessibilityText: 'Email', hintText: 'Email', bounds: '[0,0][100,10]', enabled: 'true', focused: 'true', selected: 'false' }, children: [] },
      { attributes: { class: 'android.widget.TextView', text: 'Visible', accessibilityText: 'Spoken', bounds: '[0,10][100,20]' }, children: [] },
    ] }] };
    const t = fromMaestroHierarchy(raw, 'android');
    const field = t.root.children[0]!;
    assert.equal(field.role, 'field');
    assert.equal(field.label, 'Email');
    assert.equal(field.value, 'me@example.com');
    assert.equal(field.text, undefined);
    assert.equal(field.focused, true);
    const tv = t.root.children[1]!;
    assert.equal(tv.label, 'Spoken');
    assert.equal(tv.text, 'Visible', 'distinct visible text is kept on raw trees');
    assert.equal(tv.enabled, undefined, 'flags the driver did not report stay absent');
  });

  it('accepts a bare {attributes, children} root and rejects empty hierarchies', () => {
    const bare = (maestroRaw() as { elements: unknown[] }).elements[0];
    assert.equal(fromMaestroHierarchy(bare, 'android').root.role, 'application');
    assert.throws(() => fromMaestroHierarchy({ elements: [] }, 'android'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    assert.throws(() => fromMaestroHierarchy('nope', 'android'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    const noBounds = fromMaestroHierarchy({ attributes: { class: 'android.view.View' }, children: [{ attributes: {}, children: [] }] }, 'android');
    assert.ok(isNormalizedTree(noBounds));
  });
});

describe('isNormalizedTree', () => {
  it('accepts every fixture tree (ios + android) and rejects structural defects', () => {
    for (const name of [...PILOT_SCREEN_TREES, 'pii', 'invoice_list.with_gate', 'login.with_gate', 'invoice_list.no_ids', 'invoice_new.amount_focused']) {
      assert.ok(isNormalizedTree(loadFixtureTree(name)), name);
    }
    for (const name of PILOT_SCREEN_TREES) assert.ok(isNormalizedTree(loadFixtureTree(`android/${name}`)), `android/${name}`);
    const t = cloneTree(loadFixtureTree('login'));
    t.root.bbox_norm.w = 1.5;
    assert.equal(isNormalizedTree(t), false, 'bbox out of range');
    const t2 = cloneTree(loadFixtureTree('login')) as unknown as { root: { children: unknown } };
    t2.root.children = undefined;
    assert.equal(isNormalizedTree(t2), false, 'children missing');
    assert.equal(isNormalizedTree({ ...loadFixtureTree('login'), platform: 'web' }), false, 'platform');
    assert.equal(isNormalizedTree({ ...loadFixtureTree('login'), source: 'xcode' }), false, 'source');
    assert.equal(isNormalizedTree({ ...loadFixtureTree('login'), schema_version: 2 }), false, 'schema_version');
  });
});

describe('extractSnapshot', () => {
  it('finds the snapshot in the hook fixture and normalizes it', () => {
    const snap = extractSnapshot(loadHookFixture('post-tool-use.tap').tool_response);
    assert.notEqual(snap, undefined);
    assert.equal(detectTreeShape(snap), 'argent');
    const t = normalizeTree(snap, { platform: 'ios' });
    assert.equal(findMarkerNodes(t).nodes[0]?.a11y_id, 'screen.invoice_new');
  });

  it('looks in structuredContent, then content[].text JSON, then the response itself', () => {
    const tree = loadFixtureTree('login');
    assert.deepEqual(extractSnapshot({ structuredContent: { hierarchy: maestroRaw() } }), maestroRaw());
    assert.deepEqual(extractSnapshot({ structuredContent: maestroRaw() }), maestroRaw(), 'structuredContent that is itself a tree');
    assert.deepEqual(extractSnapshot({ structuredContent: { tree } }), tree);
    assert.deepEqual(extractSnapshot({ content: [{ type: 'text', text: 'Tapped' }, { type: 'text', text: JSON.stringify({ snapshot: tree }) }] }), tree);
    assert.deepEqual(extractSnapshot({ content: [{ type: 'text', text: JSON.stringify(tree) }] }), tree);
    assert.deepEqual(extractSnapshot({ snapshot: tree }), tree);
    assert.deepEqual(extractSnapshot(tree), tree);
    assert.deepEqual(extractSnapshot(JSON.stringify({ structuredContent: { snapshot: tree } })), tree);
    assert.equal(extractSnapshot({ content: [{ type: 'text', text: 'Tapped element' }], structuredContent: { ok: true } }), undefined);
    assert.equal(extractSnapshot('plain text'), undefined);
    assert.equal(extractSnapshot(null), undefined);
    assert.equal(extractSnapshot(undefined), undefined);
  });
});

describe('traversal and queries', () => {
  const tree = loadFixtureTree('invoice_list');

  it('walk is pre-order with parent/depth and honours `false`', () => {
    const seen: string[] = [];
    walk(tree, (n, parent, depth) => {
      seen.push(`${depth}:${n.role}`);
      if (parent !== undefined) assert.ok(parent.children.includes(n));
      if (n.role === 'list') return false;
      return undefined;
    });
    assert.equal(seen[0], '0:application');
    assert.equal(seen[1], '1:window');
    assert.ok(seen.includes('3:list'));
    assert.ok(!seen.some((s) => s.startsWith('4:cell')), 'children of the list were skipped');
    assert.ok(seen.includes('3:tabBar'), 'siblings after the skipped node are still visited');
    assert.equal(countNodes(tree), 55);
    assert.equal(allNodes(tree).length, 55);
    assert.equal(allNodes(tree.root).length, 55, 'a bare node is accepted too');
  });

  it('findByA11yId / nodesWithRole / findMarkerNodes / screenRoot', () => {
    assert.equal(findByA11yId(tree, 'invoice.list.cell').length, 6);
    assert.equal(findByA11yId(tree, 'nope').length, 0);
    assert.equal(nodesWithRole(tree, 'tab').length, 3);
    const { nodes, count } = findMarkerNodes(tree);
    assert.equal(count, 1);
    assert.equal(nodes[0]!.a11y_id, 'screen.invoice_list');
    assert.equal(screenRoot(tree), nodes[0]);
    const noIds = loadFixtureTree('invoice_list.no_ids');
    assert.equal(findMarkerNodes(noIds).count, 0);
    assert.equal(screenRoot(noIds), noIds.root);
    const two = cloneTree(tree);
    two.root.children[0]!.children[0]!.a11y_id = 'screen.other';
    assert.equal(findMarkerNodes(two).count, 2);
    assert.equal(screenRoot(two), two.root, 'two markers → tree root');
  });

  it('parentOf / siblingIndex agree with the pilot fingerprints', () => {
    const add = findByA11yId(tree, 'invoice.add.button')[0]!;
    assert.equal(parentOf(tree, add)!.role, 'navigationBar');
    assert.equal(siblingIndex(tree, add), 1);
    assert.equal(siblingIndex(tree, findByA11yId(tree, 'invoice.list.table')[0]!), 3);
    assert.equal(siblingIndex(tree, tree.root), 0);
    assert.equal(parentOf(tree, tree.root), undefined);
    assert.equal(parentOf(tree, { role: 'other', bbox_norm: { x: 0, y: 0, w: 0, h: 0 }, children: [] }), undefined);
  });

  it('labelOf / centerOf', () => {
    const node: TreeNode = { role: 'button', text: 'T', bbox_norm: { x: 0.7179, y: 0.0604, w: 0.2564, h: 0.0427 }, children: [] };
    assert.equal(labelOf(node), 'T');
    assert.equal(labelOf({ ...node, label: 'L' }), 'L');
    assert.equal(labelOf({ role: 'other', bbox_norm: node.bbox_norm, children: [] }), undefined);
    assert.deepEqual(centerOf(node), { x: 0.8461, y: 0.0818 }, 'matches the geometry locator of invoice.add.button');
  });
});

describe('pathOf / nodeAtPath / rolePath (02 §5.1)', () => {
  it('reproduces every path locator of the pilot iOS screens and inverts it', () => {
    let checked = 0;
    for (const id of PILOT_SCREEN_TREES) {
      const tree = loadFixtureTree(id);
      const screen = loadScreenFile(id);
      for (const el of screen.elements) {
        const idLoc = el.locators.find((l) => l.strategy === 'a11y_id');
        const pathLoc = el.locators.find((l) => l.strategy === 'path');
        if (!idLoc || !pathLoc) continue;
        const node = findByA11yId(tree, idLoc.value as string)[0];
        assert.ok(node, `${id}: ${el.id} present`);
        assert.equal(pathOf(tree, node), pathLoc.value, `${id}: ${el.id}`);
        assert.equal(nodeAtPath(tree, pathLoc.value as string), node, `${id}: nodeAtPath(${String(pathLoc.value)})`);
        checked++;
      }
    }
    assert.ok(checked >= 20, `checked ${checked} path locators`);
  });

  it('addresses an OS alert beside the marker from their common ancestor (gate.biometric_prompt: alert/button)', () => {
    const tree = loadFixtureTree('login.with_gate');
    const cancel = nodesWithRole(tree, 'button').find((b) => b.label === 'Cancel')!;
    assert.equal(pathOf(tree, cancel), 'alert/button');
    assert.equal(nodeAtPath(tree, 'alert/button'), cancel);
    assert.deepEqual(rolePath(tree, cancel), ['window', 'alert', 'button']);
    const push = loadFixtureTree('invoice_list.with_gate');
    const deny = nodesWithRole(push, 'button').find((b) => b.label === 'Don’t Allow')!;
    assert.equal(pathOf(push, deny), 'alert/button[0]');
    assert.equal(nodeAtPath(push, 'alert/button[0]'), deny);
  });

  it('is exclusive of the base, indexes only among same-role siblings, and falls back to the tree root', () => {
    const tree = loadFixtureTree('invoice_list');
    const marker = screenRoot(tree);
    assert.equal(pathOf(tree, marker), '');
    assert.equal(nodeAtPath(tree, ''), marker);
    assert.deepEqual(rolePath(tree, findByA11yId(tree, 'invoice.add.button')[0]!), ['container', 'navigationBar', 'button']);
    const noIds = loadFixtureTree('invoice_list.no_ids');
    const filter = nodesWithRole(noIds, 'button').find((b) => b.label === 'Filter')!;
    assert.equal(pathOf(noIds, filter), 'window/container/navigationBar/button[0]');
    assert.equal(nodeAtPath(noIds, 'window/container/navigationBar/button[0]'), filter);
    assert.equal(pathOf(noIds, noIds.root), '');
  });

  it('nodeAtPath returns undefined for unknown, malformed or ambiguous paths', () => {
    const tree = loadFixtureTree('invoice_list');
    assert.equal(nodeAtPath(tree, 'list/cell[9]'), undefined);
    assert.equal(nodeAtPath(tree, 'list/cell'), undefined, 'un-indexed segment must be unique');
    assert.equal(nodeAtPath(tree, 'navigationBar/button'), undefined);
    assert.equal(nodeAtPath(tree, 'nope'), undefined);
    assert.equal(nodeAtPath(tree, 'list/cell[x]'), undefined);
    assert.equal(nodeAtPath(tree, '../list'), undefined);
    assert.equal(nodeAtPath(tree, 42 as unknown as string), undefined);
    assert.throws(() => pathOf(tree, { role: 'other', bbox_norm: { x: 0, y: 0, w: 0, h: 0 }, children: [] }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });
});

describe('compactJson', () => {
  it('is whitespace-free, round-trips, and is stable under key order', () => {
    const tree = loadFixtureTree('invoice_list');
    const s = compactJson(tree);
    assert.ok(!/\n|  /.test(s));
    assert.deepEqual(JSON.parse(s), tree);
    const shuffled = JSON.parse(JSON.stringify(tree, (_k, v) => {
      if (v && typeof v === 'object' && !Array.isArray(v)) return Object.fromEntries(Object.entries(v as Record<string, unknown>).reverse());
      return v;
    })) as Tree;
    assert.equal(compactJson(shuffled), s);
    assert.ok(s.startsWith('{"schema_version":1,"platform":"ios","source":"normalized","viewport":{"w":390,"h":844},"root":{"role":"application"'));
  });
});
