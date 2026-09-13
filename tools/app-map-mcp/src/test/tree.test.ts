/** [B1] tree.ts — normalization of the four input shapes, queries, paths (02 §5.1), bbox. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { structuralHash } from '../signature.ts';
import {
  MAX_TREE_DEPTH,
  allNodes, centerOf, compactJson, countNodes, deepestMarker, detectTreeShape, extractSnapshot, findByA11yId,
  findMarkerNodes, fromArgentScreen, fromMaestroHierarchy, fromXcuiSnapshot, isNormalizedTree, labelOf, nodeAtPath,
  nodesWithRole, normalizeTree, parentOf, pathOf, rolePath, screenRoot, siblingIndex, walk,
} from '../tree.ts';
import type { Role, ScreenFile, Tree, TreeNode } from '../types.ts';
import { PILOT_APP_MAP_DIR, PILOT_SCREEN_TREES, cloneTree, loadFixtureTree, loadHookFixture, readJsonFixture } from './helpers.ts';

const xcuiRaw = (): unknown => readJsonFixture('raw/xcuitest-snapshot.invoice_list.json');
const maestroRaw = (): unknown => readJsonFixture('raw/maestro-hierarchy.invoice_list.json');
/** a real `argent run native-describe-screen --json` capture (issue #10) */
const argentRaw = (screen: string): unknown => readJsonFixture(`raw/argent-native-describe-screen.${screen}.json`);

/**
 * `roleHintsFor(map)` for the reference integration's registry, inlined: the swapi map is not a
 * fixture of this package, and the hint is plain data by design (types.ts `roleHintsFor`).
 */
const SWAPI_HINTS: ReadonlyMap<string, Role> = new Map<string, Role>([
  ['people.search.field', 'field'], ['people.list.cell', 'cell'], ['people.count.text', 'staticText'],
  ['people.sort.button', 'button'], ['films.list.cell', 'cell'],
  ['nav.people.tab', 'tab'], ['nav.films.tab', 'tab'], ['nav.favorites.tab', 'tab'],
]);
/** the pilot registry's kinds, for the fixtures that use pilot ids */
const PILOT_HINTS: ReadonlyMap<string, Role> = new Map<string, Role>([
  ['invoice.filter.button', 'button'], ['invoice.add.button', 'button'], ['invoice.list.cell', 'cell'],
  ['invoice.detail.back.button', 'button'], ['invoice.detail.edit.button', 'button'],
  ['invoice.detail.amount.text', 'staticText'], ['invoice.detail.client.text', 'staticText'],
  ['invoice.detail.status.text', 'staticText'], ['invoice.detail.item.cell', 'cell'],
  ['invoice.detail.send.button', 'button'],
  ['nav.invoices.tab', 'tab'], ['nav.clients.tab', 'tab'], ['nav.settings.tab', 'tab'],
]);

/** the comparable shape of a tree: role, id, label, bbox and flags per node in pre-order */
function projection(t: Tree): string[] {
  return allNodes(t).map((n) => [n.role, n.a11y_id ?? '', n.label ?? '', JSON.stringify(n.bbox_norm), n.enabled, n.focused, n.selected].join('|'));
}

function loadScreenFile(id: string): ScreenFile {
  return parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, 'ios', 'screens', `${id}.yaml`), 'utf8')) as ScreenFile;
}

describe('detectTreeShape', () => {
  it('recognizes the four shapes and rejects the rest', () => {
    assert.equal(detectTreeShape(loadFixtureTree('invoice_list')), 'normalized');
    assert.equal(detectTreeShape(xcuiRaw()), 'xcuitest');
    assert.equal(detectTreeShape((xcuiRaw() as { root: unknown }).root), 'xcuitest', 'bare XCUITest node');
    assert.equal(detectTreeShape(argentRaw('people_list')), 'argent');
    assert.equal(detectTreeShape(maestroRaw()), 'maestro');
    assert.equal(detectTreeShape((maestroRaw() as { elements: unknown[] }).elements[0]), 'maestro', 'bare maestro node');
    for (const bad of [null, undefined, 42, 'text', [], {}, { root: {} }, { elements: [] }, { elements: [{}] }]) {
      assert.equal(detectTreeShape(bad), 'unknown', JSON.stringify(bad));
    }
  });

  it('never confuses the flat Argent shape with maestro, nor `argent run describe` with either (issue #10)', () => {
    // maestro ALSO keys on `elements`; its nodes carry `attributes`, which is the guard
    const maestroish = { screenFrame: { width: 402, height: 874 }, elements: [{ attributes: { class: 'android.view.View', bounds: '[0,0][10,10]' }, children: [] }] };
    assert.equal(detectTreeShape(maestroish), 'maestro');
    // `argent run describe` answers with a human-readable text rendering, not JSON
    assert.equal(detectTreeShape({ description: 'Application\n  Button "Sort"', source: 'ax' }), 'unknown');
    // an element list without a viewport is not a capture
    assert.equal(detectTreeShape({ elements: [{ frame: { x: 0, y: 0, width: 1, height: 1 } }] }), 'unknown');
  });
});

describe('normalizeTree', () => {
  it('normalizes the XCUITest snapshot, the maestro hierarchy and the normalized file to the same shape', () => {
    const expected = loadFixtureTree('invoice_list');
    const fromArgent = normalizeTree(xcuiRaw(), { platform: 'ios' });
    const fromMaestro = normalizeTree(maestroRaw(), { platform: 'android' });
    const fromNormalized = normalizeTree(expected, { platform: 'ios' });
    assert.equal(fromArgent.source, 'xcuitest');
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
    for (const t of [normalizeTree(xcuiRaw(), { platform: 'ios' }), normalizeTree(maestroRaw(), { platform: 'android' })]) {
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
    assert.equal(normalizeTree(xcuiRaw(), { platform: 'ios', source: 'synthetic' }).source, 'synthetic');
  });

  it('accepts a JSON string and rejects garbage with bad_input + hint', () => {
    const t = normalizeTree(JSON.stringify(xcuiRaw()), { platform: 'ios' });
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

describe('fromXcuiSnapshot', () => {
  it('maps the wrapper: build_number → build, bundle_id → app_id, udid dropped (07 §2.2)', () => {
    const t = fromXcuiSnapshot(xcuiRaw(), 'ios');
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
    const t = fromXcuiSnapshot(raw, 'ios');
    assert.deepEqual(t.viewport, { w: 200, h: 400 });
    const f = t.root.children[0]!;
    assert.equal(f.role, 'field');
    assert.equal(f.a11y_id, 'x.y.field');
    assert.equal(f.value, 'a@b.co');
    assert.equal(f.focused, true);
    assert.equal(f.enabled, false);
    assert.deepEqual(f.bbox_norm, { x: 0.05, y: 0.05, w: 0.5, h: 0.1 });
    assert.equal(fromXcuiSnapshot({ root: raw, build_number: 4413 }, 'ios').build, '4413');
    assert.throws(() => fromXcuiSnapshot({ root: { label: 'no type' } }, 'ios'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
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
    const t = fromXcuiSnapshot(raw, 'ios');
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
    const t = fromXcuiSnapshot(raw, 'ios');
    assert.deepEqual(t.root.children[0]!.bbox_norm, { x: 0, y: 0.9479, w: 1, h: 0.1185 });
    assert.deepEqual(t.root.children[1]!.bbox_norm, { x: 0.0026, y: 0.0012, w: 0.0026, h: 0.0012 });
    const zero = fromXcuiSnapshot({ type: 'Application', frame: { x: 0, y: 0, width: 0, height: 0 }, children: [] }, 'ios');
    assert.deepEqual(zero.root.bbox_norm, { x: 0, y: 0, w: 0, h: 0 });
    assert.equal(zero.viewport, undefined);
    assert.ok(isNormalizedTree(t) && isNormalizedTree(zero));
  });
});

// ---------------------------------------------------------------------------------------------
// The real Argent flat capture (03 §5 input, issue #10)
// ---------------------------------------------------------------------------------------------

describe('fromArgentScreen — real @swmansion/argent@0.25.0 output (03 §5, issue #10)', () => {
  it('normalizes the flat element list: roles from traits/viewClassName, viewport from screenFrame', () => {
    const t = fromArgentScreen(argentRaw('people_list'), 'ios');
    assert.equal(t.source, 'argent');
    assert.equal(t.platform, 'ios');
    assert.deepEqual(t.viewport, { w: 402, h: 874 }, 'the viewport is `screenFrame`');
    assert.ok(isNormalizedTree(t));
    // two levels and no more: application > window > [marker subtree, tabBar?]
    assert.equal(t.root.role, 'application');
    assert.deepEqual(t.root.bbox_norm, { x: 0, y: 0, w: 1, h: 1 });
    const window = t.root.children[0]!;
    assert.equal(window.role, 'window');
    assert.equal(window.children.length, 1, 'people_list has no tab bar');
    // roles come from viewClassName first, traits second
    assert.equal(findByA11yId(t, 'people.search.field')[0]!.role, 'field', 'UITextField');
    assert.equal(findByA11yId(t, 'people.count.text')[0]!.role, 'staticText', 'UILabel');
    assert.equal(findByA11yId(t, 'people.sort.button')[0]!.role, 'button', '_UIButtonBarButton');
    const title = nodesWithRole(t, 'staticText').find((n) => n.label === 'Characters')!;
    assert.equal(title.a11y_id, undefined, 'an unregistered nav label keeps no id');
    // the driver's `value` lands on the node; `traits: []` adds nothing
    assert.equal(findByA11yId(t, 'people.search.field')[0]!.value, 'Search characters');
    // `build`/`app_id` are NOT invented: the flat capture reports neither (03 §3)
    assert.equal(t.build, undefined);
    assert.equal(t.app_id, undefined);
  });

  it('reproduces the reference map learned from a real capture: roles, paths, sibling_index, bbox_norm (issue #10)', () => {
    const t = normalizeTree(argentRaw('people_list'), { platform: 'ios', roleHints: SWAPI_HINTS });
    // the marker IS the screen container and owns the whole viewport (its 1pt overlay frame,
    // issue #15, is discarded)
    const root = screenRoot(t);
    assert.equal(root.a11y_id, 'screen.people_list');
    assert.equal(root.role, 'container');
    assert.deepEqual(root.bbox_norm, { x: 0, y: 0, w: 1, h: 1 });
    // every value below is copied from swapi-explorer app-map/ios/screens/people_list.yaml
    const expected = [
      { id: 'people.search.field', role: 'field', path: 'field', sibling: 0, bbox: { x: 0.1401, y: 0.2025, w: 0.7902, h: 0.0252 }, centre: { x: 0.5352, y: 0.2151 } },
      { id: 'people.list.cell', role: 'cell', path: 'cell[0]', sibling: 1, bbox: { x: 0.0398, y: 0.2933, w: 0.9204, h: 0.0763 }, centre: { x: 0.5, y: 0.3315 } },
      { id: 'people.count.text', role: 'staticText', path: 'staticText[0]', sibling: 11, bbox: { x: 0.0398, y: 0.2471, w: 0.9204, h: 0.0461 }, centre: { x: 0.5, y: 0.2702 } },
      { id: 'people.sort.button', role: 'button', path: 'button', sibling: 12, bbox: { x: 0.8607, y: 0.0755, w: 0.0896, h: 0.0412 }, centre: { x: 0.9055, y: 0.0961 } },
    ] as const;
    for (const e of expected) {
      const n = findByA11yId(t, e.id)[0]!;
      assert.ok(n, e.id);
      assert.equal(n.role, e.role, `${e.id} role`);
      assert.equal(pathOf(t, n), e.path, `${e.id} path`);
      assert.equal(nodeAtPath(t, e.path), n, `${e.id} nodeAtPath`);
      assert.equal(siblingIndex(t, n), e.sibling, `${e.id} sibling_index`);
      assert.equal(parentOf(t, n)!.role, 'container', `${e.id} parent_role`);
      assert.deepEqual(n.bbox_norm, e.bbox, `${e.id} bbox_norm`);
      assert.deepEqual(centerOf(n), e.centre, `${e.id} geometry locator`);
    }
    assert.equal(findByA11yId(t, 'people.list.cell').length, 10);
    // the hint is a net, not a crutch: every role above is also reachable from
    // `viewClassName`/`traits` alone, so an unregistered id on these screens still types correctly
    const unhinted = normalizeTree(argentRaw('people_list'), { platform: 'ios' });
    assert.deepEqual(
      allNodes(unhinted).map((n) => n.role),
      allNodes(t).map((n) => n.role),
      'no element of the reference map depends on the registry for its role',
    );
    assert.equal(
      structuralHash(t, ['people.count.text', 'people.list.cell']),
      'sha1:09acab35a2c649202fe3f1555d277651cf99fb50',
      'people_list.yaml signature.structural_hash',
    );
  });

  it('uses normalizedFrame verbatim and only falls back to frame ÷ screenFrame', () => {
    // the real capture disagrees with itself: 317.7 / 402 = 0.790299 → 0.7903, the driver says
    // 0.7902, and the map learned the driver's number
    const field = findByA11yId(normalizeTree(argentRaw('people_list'), { platform: 'ios' }), 'people.search.field')[0]!;
    assert.equal(field.bbox_norm.w, 0.7902);
    assert.equal(field.bbox_norm.x, 0.1401);
    const recomputed = fromArgentScreen({
      screenFrame: { x: 0, y: 0, width: 402, height: 874 },
      elements: [{ frame: { x: 56.3, y: 177, width: 317.7, height: 22 }, identifier: 'a.b.field', viewClassName: 'UITextField', traits: [] }],
    }, 'ios');
    assert.deepEqual(findByA11yId(recomputed, 'a.b.field')[0]!.bbox_norm, { x: 0.14, y: 0.2025, w: 0.7903, h: 0.0252 });
    // out-of-viewport rows clamp, but they are still distinct elements (the dedupe key is the
    // UNCLAMPED normalized frame)
    const below = fromArgentScreen({
      screenFrame: { width: 100, height: 100 },
      elements: [
        { normalizedFrame: { x: 0, y: 1.02, width: 1, height: 0.1 }, identifier: 'x.list.cell', traits: [] },
        { normalizedFrame: { x: 0, y: 1.14, width: 1, height: 0.1 }, identifier: 'x.list.cell', traits: [] },
      ],
    }, 'ios');
    assert.equal(findByA11yId(below, 'x.list.cell').length, 2);
    assert.deepEqual(findByA11yId(below, 'x.list.cell')[0]!.bbox_norm, { x: 0, y: 1, w: 1, h: 0.1 });
  });

  it('collapses the doubled tab bar to one element per (frame, label), keeping the identified twin', () => {
    const raw = argentRaw('films_list') as { elements: Array<Record<string, unknown>> };
    assert.equal(raw.elements.filter((e) => e['viewClassName'] === '_UITabButton').length, 6, 'the capture really does report six');
    assert.equal(raw.elements.filter((e) => e['viewClassName'] === '_UITabButton' && e['identifier'] === undefined).length, 3);
    const t = normalizeTree(raw, { platform: 'ios', roleHints: SWAPI_HINTS });
    const bar = t.root.children[0]!.children[1]!;
    assert.equal(bar.role, 'tabBar');
    assert.deepEqual(bar.bbox_norm, { x: 0, y: 0.9096, w: 1, h: 0.0904 });
    assert.equal(bar.children.length, 3, 'three tabs, not six');
    assert.deepEqual(bar.children.map((c) => c.a11y_id), ['nav.people.tab', 'nav.films.tab', 'nav.favorites.tab'], 'sorted by x, identified twin kept');
    assert.deepEqual(bar.children.map((c) => pathOf(t, c)), ['tabBar/tab[0]', 'tabBar/tab[1]', 'tabBar/tab[2]']);
    assert.deepEqual(bar.children.map((c) => siblingIndex(t, c)), [0, 1, 2]);
    assert.deepEqual(centerOf(bar.children[1]!), { x: 0.5001, y: 0.9405 }, 'films_list.yaml geometry locator');
    assert.equal(bar.children[1]!.selected, true, 'the `selected` trait, and only the positive');
    assert.equal(bar.children[0]!.selected, undefined, 'Argent never reports the negative');
    assert.equal(
      structuralHash(t, ['films.list.cell']),
      'sha1:f146624953c6f612abb0b886da783c60421173ff',
      'films_list.yaml signature.structural_hash',
    );
  });

  it('keeps only the deepest marker — a pushed detail leaves the parent marker behind', () => {
    const raw = argentRaw('invoice_detail') as { elements: Array<Record<string, unknown>> };
    assert.equal(raw.elements.filter((e) => String(e['identifier'] ?? '').startsWith('screen.')).length, 2, 'the capture carries both');
    const t = normalizeTree(raw, { platform: 'ios', roleHints: PILOT_HINTS });
    const { nodes, count } = findMarkerNodes(t);
    assert.equal(count, 1, 'the covered marker is dropped, not kept as a sibling');
    assert.equal(nodes[0]!.a11y_id, 'screen.invoice_detail');
    assert.equal(screenRoot(t), nodes[0]);
    // dropping it (rather than keeping it as a body child) is what keeps `sibling_index` and the
    // structural hash stable
    assert.equal(siblingIndex(t, findByA11yId(t, 'invoice.detail.back.button')[0]!), 0);
  });

  it('prefers the registry kind only where the capture has no type, never over a more specific role', () => {
    const raw = argentRaw('invoice_detail');
    const withHints = normalizeTree(raw, { platform: 'ios', roleHints: PILOT_HINTS });
    const without = normalizeTree(raw, { platform: 'ios' });
    assert.equal(findByA11yId(withHints, 'invoice.detail.item.cell')[0]!.role, 'cell', 'ids.yaml kind: cell');
    assert.equal(findByA11yId(without, 'invoice.detail.item.cell')[0]!.role, 'cell', 'and the SwiftUI list-cell class agrees, so the hint never contradicts it');
    // a row whose class we cannot read falls back to its traits, and only the hint rescues it
    const odd = {
      screenFrame: { width: 100, height: 200 },
      elements: [
        { normalizedFrame: { x: 0, y: 0.1, width: 1, height: 0.1 }, identifier: 'x.list.cell', traits: ['button'], viewClassName: 'App.MysteryRow' },
        { normalizedFrame: { x: 0, y: 0.3, width: 1, height: 0.05 }, identifier: 'x.search.field', traits: [], viewClassName: 'UISearchBar' },
      ],
    };
    const hints = new Map<string, Role>([['x.list.cell', 'cell'], ['x.search.field', 'field']]);
    assert.equal(findByA11yId(fromArgentScreen(odd, 'ios'), 'x.list.cell')[0]!.role, 'button', 'traits only');
    assert.equal(findByA11yId(fromArgentScreen(odd, 'ios', { roleHints: hints }), 'x.list.cell')[0]!.role, 'cell');
    assert.equal(
      findByA11yId(fromArgentScreen(odd, 'ios', { roleHints: hints }), 'x.search.field')[0]!.role,
      'searchField',
      'a `field` hint must not demote a derived searchField',
    );
    // the marker is a container whatever the 1pt overlay reports (01 R3)
    assert.equal(screenRoot(normalizeTree(argentRaw('people_list'), { platform: 'ios' })).role, 'container');
  });

  it('reports no focus and no enabled flag — Argent does not expose them (issue #10, issue #18)', () => {
    const t = normalizeTree(argentRaw('people_list'), { platform: 'ios', roleHints: SWAPI_HINTS });
    for (const n of allNodes(t)) {
      assert.equal(n.focused, undefined, `${n.a11y_id ?? n.role} focused`);
      assert.equal(n.enabled, undefined, `${n.a11y_id ?? n.role} enabled`);
    }
    assert.ok(!/"focused"|"hasFocus"|"enabled"/.test(compactJson(t)));
  });

  it('rejects a non-ok status and a capture that is not an object with bad_input + hint', () => {
    const bad = (input: unknown): void => {
      assert.throws(() => fromArgentScreen(input, 'ios'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && e.hint.length > 0, JSON.stringify(input));
    };
    assert.throws(
      () => fromArgentScreen({ status: 'error', screenFrame: { width: 1, height: 1 }, elements: [] }, 'ios'),
      (e: unknown) => AppMapError.is(e) && /status "error"/.test(e.message),
    );
    bad('nope');
    bad({ elements: [] });
    bad({ screenFrame: { width: 1, height: 1 } });
    // an empty capture is not an error: the screen container still exists so `pathOf` keeps
    // working, and with no marker `screenRoot` falls back to the tree root as everywhere else
    const empty = fromArgentScreen({ status: 'ok', screenFrame: { width: 402, height: 874 }, elements: [] }, 'ios');
    const container = empty.root.children[0]!.children[0]!;
    assert.equal(container.role, 'container');
    assert.equal(container.a11y_id, undefined);
    assert.equal(screenRoot(empty), empty.root);
    assert.ok(isNormalizedTree(empty));
  });
});

describe('deepestMarker / screenRoot (01 R3, issue #10)', () => {
  const marked = (id: string, y: number, children: TreeNode[] = []): TreeNode =>
    ({ role: 'container', a11y_id: id, bbox_norm: { x: 0, y, w: 1, h: 1 - y }, children });
  const tree = (children: TreeNode[]): Tree =>
    ({ schema_version: 1, platform: 'ios', source: 'synthetic', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children } });

  it('prefers depth, then y, then document order, and bases pathOf on it', () => {
    const leaf: TreeNode = { role: 'button', a11y_id: 'x.ok.button', bbox_norm: { x: 0, y: 0.5, w: 1, h: 0.1 }, children: [] };
    // depth beats y: the covering screen sits lower on the screen but higher in the tree
    const nested = tree([marked('screen.invoice_list', 0.5, [marked('screen.invoice_detail', 0.1, [leaf])])]);
    assert.equal(deepestMarker(nested)!.a11y_id, 'screen.invoice_detail');
    assert.equal(screenRoot(nested), deepestMarker(nested));
    assert.equal(pathOf(nested, leaf), 'button', 'paths are relative to the deepest marker');
    assert.equal(nodeAtPath(nested, 'button'), leaf);

    // equal depth → the greater y (a flat capture has no hierarchy to compare)
    const flat = tree([marked('screen.a', 0), marked('screen.b', 0.3)]);
    assert.equal(deepestMarker(flat)!.a11y_id, 'screen.b');

    // equal depth and equal y → document order, last wins
    const tie = tree([marked('screen.a', 0.2), marked('screen.b', 0.2)]);
    assert.equal(deepestMarker(tie)!.a11y_id, 'screen.b');

    const noIds = loadFixtureTree('invoice_list.no_ids');
    assert.equal(deepestMarker(noIds), undefined, 'no marker at all');
    assert.equal(screenRoot(noIds), noIds.root);
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
    assert.equal(detectTreeShape(snap), 'xcuitest');
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
    assert.equal(findMarkerNodes(two).count, 2, 'findMarkerNodes still reports both (drift.ts asks for presence)');
    // 01 R3 as amended by issue #10: two markers no longer make the tree root the base — the
    // deepest wins, and at equal depth that is the one with the greater `y` (`screen.other` is
    // the status-bar node at y 0, the real marker container is at 0.0557)
    assert.equal(screenRoot(two), findByA11yId(two, 'screen.invoice_list')[0], 'two markers → the deepest');
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

// ---------------------------------------------------------------------------------------------
// depth bound (03 §11 structured errors, 05 §6.2 oversized snapshots)
// ---------------------------------------------------------------------------------------------

describe('normalizeTree — depth bound', () => {
  const deepArgent = (n: number): unknown => {
    const root: Record<string, unknown> = { type: 'Other', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] };
    let cursor = root;
    for (let i = 0; i < n; i += 1) {
      const child: Record<string, unknown> = { type: 'Other', frame: { x: 0, y: 0, width: 10, height: 10 }, children: [] };
      (cursor['children'] as unknown[]).push(child);
      cursor = child;
    }
    return { root };
  };

  it('a tree within the bound normalizes', () => {
    assert.ok(normalizeTree(deepArgent(MAX_TREE_DEPTH - 2), { platform: 'ios' }).root);
  });

  it('a pathologically deep tree is bad_input, not a RangeError', () => {
    assert.throws(
      () => normalizeTree(deepArgent(MAX_TREE_DEPTH + 5000), { platform: 'ios' }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /deeper than/.test(e.message) && e.hint !== '',
    );
  });

  it('a deep NORMALIZED tree is rejected by the structural check with a named issue', () => {
    const tree = normalizeTree(deepArgent(1), { platform: 'ios' });
    let tail: TreeNode = tree.root;
    for (let i = 0; i < MAX_TREE_DEPTH + 10; i += 1) {
      const next: TreeNode = { role: 'other', bbox_norm: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
      tail.children.push(next);
      tail = next;
    }
    assert.throws(
      () => normalizeTree(tree, { platform: 'ios' }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && /maximum tree depth/.test(e.message),
    );
  });
});
