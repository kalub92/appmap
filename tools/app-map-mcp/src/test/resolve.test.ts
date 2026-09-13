/** [B2] resolve.ts — locator resolution (02 §5.2, 03 §6), disambiguation (02 §5.3), find_element (03 §8). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { ElementDef, LoadedMap, Tree, TreeNode } from '../types.ts';
import { DEFAULT_LOCATOR_WEIGHTS, DEGRADED_THRESHOLD, roleHintsFor } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { loadMap } from '../yaml/load.ts';
import { findByA11yId, nodesWithRole, normalizeTree, pathOf, screenRoot, walk } from '../tree.ts';
import { estimateTokens } from '../token.ts';
import {
  DISAMBIGUATION_FACTOR, FIND_ELEMENT_ALTERNATIVES_MAX, MISS_CANDIDATES_MAX, disambiguate, findElement, findElementDef, queryLocator, resolve, targetFor,
} from '../resolve.ts';
import { PILOT_SCREEN_TREES, cloneTree, doubledMarkerXcuiFixture, loadFixtureTree, makeTempAppMapDir, readJsonFixture } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

function node(role: TreeNode['role'], extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode {
  return { role, bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children, ...extra };
}
function synthetic(root: TreeNode): Tree {
  return { schema_version: 1, platform: 'ios', source: 'synthetic', root };
}
function element(partial: Partial<ElementDef> & Pick<ElementDef, 'id' | 'role' | 'locators'>): ElementDef {
  return { status: 'verified', ...partial };
}
/** how many nodes in the tree carry `id` (dynamic cells repeat) */
function countId(tree: Tree, id: string): number {
  return findByA11yId(tree, id).length;
}

describe('resolve — a11y_id on the pilot (02 §5.2)', () => {
  it('resolves every pilot element by a11y_id (confidence 1.0, or 0.9 when a repeated dynamic id is disambiguated)', () => {
    for (const id of PILOT_SCREEN_TREES) {
      const tree = loadFixtureTree(id);
      for (const el of map.screens.get(id)!.elements) {
        const r = resolve(map, el, tree);
        assert.equal(r.status, 'hit', `${id}/${el.id}`);
        if (r.status !== 'hit') continue;
        assert.equal(r.strategy, 'a11y_id');
        assert.equal(r.element, el.id);
        assert.equal(r.node.a11y_id, el.id);
        assert.deepEqual(r.target, { by: 'id', id: el.id });
        assert.equal(r.degraded, false);
        assert.equal(r.path, pathOf(tree, r.node));
        if (countId(tree, el.id) > 1) {
          assert.equal(r.disambiguated, true, `${el.id} repeats`);
          assert.equal(r.confidence, 0.9, '1.0 × 0.9');
          assert.equal(r.path, el.locators.find((l) => l.strategy === 'path')!.value, 'fingerprint picks the first cell');
        } else {
          assert.equal(r.disambiguated, false);
          assert.equal(r.confidence, 1);
        }
      }
    }
  });

  it('gate dismiss controls resolve on the with_gate fixtures (role_label 0.8 from the gate file)', () => {
    const deny = map.gates.get('gate.push_permission')!.elements[0]!;
    const r = resolve(map, deny, loadFixtureTree('invoice_list.with_gate'));
    assert.equal(r.status, 'hit');
    if (r.status !== 'hit') return;
    assert.equal(r.strategy, 'role_label');
    assert.equal(r.confidence, 0.8);
    assert.equal(r.degraded, false);
    assert.deepEqual(r.target, { by: 'role_label', role: 'button', label: 'Don’t Allow' });
    const cancel = map.gates.get('gate.biometric_prompt')!.elements[0]!;
    const c = resolve(map, cancel, loadFixtureTree('login.with_gate'));
    assert.equal(c.status, 'hit');
  });

  it('a screen element never resolves to a control inside a present gate dialog', () => {
    const allow = element({ id: 'x.allow.button', role: 'button', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'Allow' }, weight: 0.6 }] });
    // as recorded, the alert sits beside the marker container: outside the screen root, unreachable either way
    const beside = loadFixtureTree('invoice_list.with_gate');
    assert.equal(resolve(map, allow, beside).status, 'miss');
    assert.equal(resolve(map, allow, beside, { excludeGates: false }).status, 'miss');
    // an alert nested inside the marker container is reachable only when gate exclusion is switched off
    const inside = cloneTree(beside);
    const win = inside.root.children[0]!;
    const alert = win.children.find((n) => n.role === 'alert')!;
    win.children = win.children.filter((n) => n !== alert);
    findByA11yId(inside, 'screen.invoice_list')[0]!.children.push(alert);
    assert.equal(resolve(map, allow, inside).status, 'miss', 'excluded by default');
    assert.equal(resolve(map, allow, inside, { gatesPresent: ['gate.push_permission'] }).status, 'miss', 'excluded via gatesPresent');
    assert.equal(resolve(map, allow, inside, { gatesPresent: [] }).status, 'hit', 'no gate declared present → nothing to exclude');
    const r = resolve(map, allow, inside, { excludeGates: false });
    assert.equal(r.status, 'hit', 'opt-out searches the dialog too');
    // the gate's own dismiss control still resolves inside the nested alert
    const deny = resolve(map, map.gates.get('gate.push_permission')!.elements[0]!, inside);
    assert.equal(deny.status === 'hit' && deny.confidence, 0.8);
  });
});

describe('resolve — degraded matches per the weight table (02 §5.1–5.2)', () => {
  it('no_ids fixture: invoice.add.button falls through to role_label at 0.6 and is degraded (03 §12)', () => {
    const tree = loadFixtureTree('invoice_list.no_ids');
    const r = resolve(map, map.screens.get('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!, tree);
    assert.equal(r.status, 'hit');
    if (r.status !== 'hit') return;
    assert.equal(r.strategy, 'role_label');
    assert.equal(r.confidence, DEFAULT_LOCATOR_WEIGHTS.role_label);
    assert.equal(r.confidence, DEGRADED_THRESHOLD);
    // the authored a11y_id locator (rank 0) missed, so the fall-through is a degraded match
    assert.equal(r.degraded, true);
    assert.equal(r.disambiguated, false);
    assert.deepEqual(r.target, { by: 'role_label', role: 'button', label: 'New Invoice' });
    assert.equal(r.path, 'window/container/navigationBar/button[1]', 'no marker → path from the tree root');
  });

  it('no_ids fixture: every labelled invoice_list element resolves by role_label; id-only dynamic elements miss', () => {
    const tree = loadFixtureTree('invoice_list.no_ids');
    for (const el of map.screens.get('invoice_list')!.elements) {
      const r = resolve(map, el, tree);
      if (el.dynamic) {
        assert.equal(r.status, 'miss', el.id);
        if (r.status === 'miss') {
          assert.deepEqual(r.tried.map((x) => x.strategy), ['a11y_id', 'path']);
          assert.ok(r.candidates.length <= MISS_CANDIDATES_MAX);
          for (const c of r.candidates) assert.equal(c.role, el.role);
        }
      } else {
        assert.equal(r.status, 'hit', el.id);
        if (r.status === 'hit') assert.equal(r.strategy, 'role_label');
      }
    }
  });

  it('a text hit (0.3) is degraded; a role_label authored below 0.6 is degraded; a11y_id never is', () => {
    const tree = loadFixtureTree('invoice_list.no_ids');
    const textOnly = element({ id: 'invoice.add.button', role: 'button', locators: [{ strategy: 'text', value: 'New Invoice', weight: 0.3 }] });
    const r = resolve(map, textOnly, tree);
    assert.equal(r.status, 'hit');
    if (r.status === 'hit') {
      assert.equal(r.strategy, 'text');
      assert.equal(r.confidence, 0.3);
      assert.equal(r.degraded, true);
      assert.deepEqual(r.target, { by: 'role_label', role: 'button', label: 'New Invoice' }, 'a label beats a text target');
    }
    const weak = element({ id: 'invoice.add.button', role: 'button', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'New Invoice' }, weight: 0.5 }] });
    const w = resolve(map, weak, tree);
    assert.equal(w.status === 'hit' && w.degraded, true);
    const path = element({ id: 'invoice.add.button', role: 'button', locators: [{ strategy: 'path', value: 'window/container/navigationBar/button[1]', weight: 0.25 }] });
    const p = resolve(map, path, tree);
    assert.equal(p.status, 'hit');
    if (p.status === 'hit') { assert.equal(p.confidence, 0.25); assert.equal(p.degraded, true); }
    const geo = element({ id: 'invoice.add.button', role: 'button', locators: [{ strategy: 'geometry', value: { x: 0.8461, y: 0.0818 }, weight: 0.1 }] });
    const g = resolve(map, geo, tree);
    assert.equal(g.status, 'hit');
    if (g.status === 'hit') { assert.equal(g.node.label, 'New Invoice', 'smallest bbox containing the point'); assert.equal(g.degraded, true); }
  });

  it('a locator with no weight falls back to the default weight table', () => {
    const noWeight = element({ id: 'invoice.add.button', role: 'button', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'New Invoice' } } as ElementDef['locators'][number]] });
    const r = resolve(map, noWeight, loadFixtureTree('invoice_list.no_ids'));
    assert.equal(r.status === 'hit' && r.confidence, 0.6);
  });
});

describe('resolve — disambiguation (03 §6, 02 §5.3)', () => {
  /** nav bar with two identical Cancel buttons at different positions */
  function twoCancels(): Tree {
    const bar = node('navigationBar', { bbox_norm: { x: 0, y: 0, w: 1, h: 0.1 } }, [
      node('button', { label: 'Cancel', bbox_norm: { x: 0.0, y: 0.05, w: 0.2, h: 0.05 } }),
      node('button', { label: 'Cancel', bbox_norm: { x: 0.8, y: 0.05, w: 0.2, h: 0.05 } }),
    ]);
    return synthetic(node('application', {}, [node('container', { a11y_id: 'screen.invoice_new' }, [bar, node('list', {}, [])])]));
  }
  const cancel = (fingerprint?: ElementDef['fingerprint']): ElementDef => element({
    id: 'invoice.cancel.button', role: 'button', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'Cancel' }, weight: 0.6 }], fingerprint,
  });

  it('two identical role_label matches are disambiguated by sibling_index (confidence × 0.9, degraded)', () => {
    const tree = twoCancels();
    const r = resolve(map, cancel({ role: 'button', parent_role: 'navigationBar', sibling_index: 1 }), tree);
    assert.equal(r.status, 'hit');
    if (r.status !== 'hit') return;
    assert.equal(r.node, tree.root.children[0]!.children[0]!.children[1]);
    assert.equal(r.disambiguated, true);
    assert.equal(r.confidence, 0.54, `0.6 × ${DISAMBIGUATION_FACTOR}`);
    assert.equal(r.degraded, true, '0.54 < 0.6');
    assert.equal(r.path, 'navigationBar/button[1]');
    const first = resolve(map, cancel({ role: 'button', sibling_index: 0 }), tree);
    assert.equal(first.status === 'hit' && first.path, 'navigationBar/button[0]');
  });

  it('falls back to the nearest bbox centre when sibling_index does not decide', () => {
    const tree = twoCancels();
    const r = resolve(map, cancel({ role: 'button', bbox_norm: { x: 0.78, y: 0.05, w: 0.2, h: 0.05 } }), tree);
    assert.equal(r.status === 'hit' && r.path, 'navigationBar/button[1]');
    const a11y = element({ id: 'invoice.list.cell', role: 'cell', locators: [{ strategy: 'a11y_id', value: 'invoice.list.cell', weight: 1 }], fingerprint: { role: 'cell', bbox_norm: { x: 0, y: 0.3104, w: 1, h: 0.0853 } } });
    const c = resolve(map, a11y, loadFixtureTree('invoice_list'));
    assert.equal(c.status === 'hit' && c.path, 'list/cell[1]', 'a11y_id repeats are disambiguated by bbox too');
    assert.equal(c.status === 'hit' && c.confidence, 0.9);
  });

  it('stays a miss when nothing disambiguates (no fingerprint, or an exact tie)', () => {
    const tree = twoCancels();
    const none = resolve(map, cancel(undefined), tree);
    assert.equal(none.status, 'miss');
    if (none.status === 'miss') assert.deepEqual(none.tried, [{ strategy: 'role_label', matches: 2 }]);
    const tie = resolve(map, cancel({ role: 'button', bbox_norm: { x: 0.4, y: 0.05, w: 0.2, h: 0.05 } }), tree);
    assert.equal(tie.status, 'miss');
    assert.equal(disambiguate(tree, [], { role: 'button' }), undefined);
  });

  it('the first UNIQUE match wins: a non-unique earlier strategy is skipped, a later unique one hits (02 §5.2)', () => {
    const tree = twoCancels();
    const el = element({
      id: 'invoice.cancel.button', role: 'button', locators: [
        { strategy: 'text', value: 'Cancel', weight: 0.3 },
        { strategy: 'path', value: 'navigationBar/button[1]', weight: 0.25 },
      ],
    });
    const r = resolve(map, el, tree);
    assert.equal(r.status, 'hit');
    if (r.status !== 'hit') return;
    assert.equal(r.strategy, 'path');
    assert.equal(r.confidence, 0.25);
    assert.equal(r.disambiguated, false);
    assert.equal(r.path, 'navigationBar/button[1]');
  });

  it('only a11y_id and role_label are disambiguated; text with two matches is a miss', () => {
    const tree = twoCancels();
    const textEl = element({ id: 'invoice.cancel.button', role: 'button', locators: [{ strategy: 'text', value: 'Cancel', weight: 0.3 }], fingerprint: { role: 'button', sibling_index: 1 } });
    const r = resolve(map, textEl, tree);
    assert.equal(r.status, 'miss');
    if (r.status === 'miss') assert.deepEqual(r.tried, [{ strategy: 'text', matches: 2 }]);
  });
});

describe('resolve — miss (03 §6)', () => {
  it('reports every strategy tried with its match count and ≤3 role-compatible candidates', () => {
    const tree = loadFixtureTree('invoice_list.no_ids');
    const ghost = element({
      id: 'invoice.ghost.button', role: 'button', locators: [
        { strategy: 'a11y_id', value: 'invoice.ghost.button', weight: 1 },
        { strategy: 'role_label', value: { role: 'button', label: 'Ghost' }, weight: 0.6 },
        { strategy: 'text', value: 'Ghost', weight: 0.3 },
        { strategy: 'path', value: 'nowhere/button', weight: 0.25 },
        { strategy: 'geometry', value: { x: 2, y: 2 }, weight: 0.1 },
      ],
    });
    const r = resolve(map, ghost, tree);
    assert.equal(r.status, 'miss');
    if (r.status !== 'miss') return;
    assert.equal(r.element, 'invoice.ghost.button');
    assert.deepEqual(r.tried, [
      { strategy: 'a11y_id', matches: 0 }, { strategy: 'role_label', matches: 0 }, { strategy: 'text', matches: 0 }, { strategy: 'path', matches: 0 }, { strategy: 'geometry', matches: 0 },
    ]);
    assert.equal(r.candidates.length, MISS_CANDIDATES_MAX);
    for (const c of r.candidates) {
      assert.equal(c.role, 'button');
      assert.ok(typeof c.label === 'string' || typeof c.a11y_id === 'string');
      assert.ok(c.path.length > 0);
    }
  });

  it('an element with no locators or unknown strategies is a miss, never a crash', () => {
    const tree = loadFixtureTree('invoice_list');
    const r = resolve(map, element({ id: 'x.y.z', role: 'button', locators: [] }), tree);
    assert.equal(r.status, 'miss');
    const bogus = resolve(map, element({ id: 'x.y.z', role: 'button', locators: [{ strategy: 'magic', value: 1, weight: 1 } as unknown as ElementDef['locators'][number]] }), tree);
    assert.equal(bogus.status === 'miss' && bogus.tried.length, 0);
  });

  it('malformed input is an AppMapError(bad_input)', () => {
    assert.throws(() => resolve(map, {} as ElementDef, loadFixtureTree('login')), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    assert.throws(() => resolve(map, map.screens.get('login')!.elements[0]!, {} as Tree), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });
});

describe('resolve \u2014 the flat Argent capture (03 \u00a75, follow-up to #10)', () => {
  /** the real committed `argent run native-describe-screen --json` capture of the pilot */
  const flatInvoiceList = (): Tree => normalizeTree(
    readJsonFixture('raw/argent-native-describe-screen.invoice_list.json'),
    { platform: 'ios', roleHints: roleHintsFor(map) },
  );

  it('resolves a registered tab to the tab itself, never to the screen container by geometry', () => {
    const tree = flatInvoiceList();
    // the tabs must be inside the scope `resolve` searches (`screenRoot`), not beside it
    assert.equal(nodesWithRole(screenRoot(tree), 'tab').length, 3);
    const screen = map.screens.get('invoice_list')!;
    const expected = [
      ['nav.invoices.tab', 'tabBar/tab[0]'],
      ['nav.clients.tab', 'tabBar/tab[1]'],
      ['nav.settings.tab', 'tabBar/tab[2]'],
    ] as const;
    for (const [id, path] of expected) {
      const def = screen.elements.find((e) => e.id === id)!;
      assert.ok(def, id);
      const r = resolve(map, def, tree);
      assert.equal(r.status, 'hit', id);
      if (r.status !== 'hit') continue;
      // the bug: all four real locators scored zero out of scope and the weight-0.1 geometry
      // fallback matched the full-screen marker container, so `run_recipe` tapped the screen
      // overlay and called it a success
      assert.notDeepEqual(r.target, { by: 'id', id: 'screen.invoice_list' }, `${id} must not tap the screen overlay`);
      assert.notEqual(r.strategy, 'geometry', id);
      assert.deepEqual(r.target, { by: 'id', id }, id);
      assert.equal(r.strategy, 'a11y_id', id);
      assert.equal(r.confidence, 1, id);
      assert.equal(r.degraded, false, id);
      assert.equal(r.node.a11y_id, id, id);
      assert.equal(r.path, path, id);
      assert.equal(pathOf(tree, r.node), path, id);
    }
  });

  it('the learned rank-3 `path` locator also counts in scope now (it was rejected as out of scope)', () => {
    const tree = flatInvoiceList();
    const def = map.screens.get('invoice_list')!.elements.find((e) => e.id === 'nav.clients.tab')!;
    const pathLocator = def.locators.find((l) => l.strategy === 'path')!;
    assert.equal(pathLocator.value, 'tabBar/tab[1]', 'the pilot locator, unchanged by the move');
    assert.deepEqual(queryLocator(tree, pathLocator).map((n) => n.a11y_id), ['nav.clients.tab']);
    assert.deepEqual(
      queryLocator(tree, { strategy: 'role_label', value: { role: 'tab', label_regex: '^(Clients|Settings)$' }, weight: 0.6 })
        .map((n) => n.a11y_id),
      ['nav.clients.tab', 'nav.settings.tab'],
    );
  });
});

describe('queryLocator and targetFor', () => {
  it('queries are scoped to the screen root and honour each strategy', () => {
    const tree = loadFixtureTree('invoice_list');
    assert.equal(queryLocator(tree, { strategy: 'a11y_id', value: 'invoice.list.cell', weight: 1 }).length, 6);
    assert.equal(queryLocator(tree, { strategy: 'role_label', value: { role: 'tab', label_regex: '^(Clients|Settings)$' }, weight: 0.6 }).length, 2);
    assert.equal(queryLocator(tree, { strategy: 'text', value: 'Filter', weight: 0.3 }).length, 1);
    assert.equal(queryLocator(tree, { strategy: 'path', value: 'tabBar/tab[2]', weight: 0.25 })[0]!.a11y_id, 'nav.settings.tab');
    assert.equal(queryLocator(tree, { strategy: 'path', value: 'tabBar/tab[9]', weight: 0.25 }).length, 0);
    assert.equal(queryLocator(tree, { strategy: 'geometry', value: { x: 0.8461, y: 0.0818 }, weight: 0.1 })[0]!.a11y_id, 'invoice.add.button');
    // the status bar sits outside the marker container and is not reachable
    assert.equal(queryLocator(tree, { strategy: 'text', value: '9:41', weight: 0.3 }).length, 0);
    assert.deepEqual(queryLocator(tree, { strategy: 'a11y_id', value: '', weight: 1 }), []);
  });

  it('targetFor prefers id, then role+label, then text (for text hits), then the bbox centre', () => {
    const tree = loadFixtureTree('invoice_list');
    assert.deepEqual(targetFor(tree, node('button', { a11y_id: 'a.b.c', label: 'L' }), 'a11y_id'), { by: 'id', id: 'a.b.c' });
    assert.deepEqual(targetFor(tree, node('button', { label: 'L' }), 'a11y_id'), { by: 'role_label', role: 'button', label: 'L' });
    assert.deepEqual(targetFor(tree, node('button', { text: 'T' }), 'text'), { by: 'text', text: 'T' });
    assert.deepEqual(targetFor(tree, node('button', { bbox_norm: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } }), 'geometry'), { by: 'point', x: 0.3, y: 0.3 });
  });
});

describe('findElementDef / findElement (03 §8)', () => {
  it('looks up by element_id, exact intent, then loose intent/label/id-segment match', () => {
    assert.equal(findElementDef(map, 'invoice_list', { element_id: 'invoice.add.button' }).element!.id, 'invoice.add.button');
    assert.equal(findElementDef(map, 'invoice_list', { intent: 'open_new_invoice' }).element!.id, 'invoice.add.button');
    assert.equal(findElementDef(map, 'invoice_list', { intent: 'New Invoice' }).element!.id, 'invoice.add.button', 'label substring');
    assert.equal(findElementDef(map, 'invoice_list', { intent: 'filter' }).element!.id, 'invoice.filter.button', 'id middle segment');
    assert.equal(findElementDef(map, 'gate.push_permission', { intent: 'dismiss_push_permission' }).element!.id, 'gate.push_permission.deny', 'gates too');
    const ambiguous = findElementDef(map, 'invoice_list', { intent: 'show' });
    assert.equal(ambiguous.element, undefined);
    assert.deepEqual(ambiguous.candidates.map((e) => e.id), ['nav.clients.tab', 'nav.invoices.tab', 'nav.settings.tab']);
    const missing = findElementDef(map, 'invoice_list', { element_id: 'invoice.nope.button' });
    assert.equal(missing.element, undefined);
    assert.ok(missing.candidates.length > 0 && missing.candidates.length <= FIND_ELEMENT_ALTERNATIVES_MAX);
    assert.equal(missing.candidates[0]!.id.split('.')[0], 'invoice', 'same feature first');
  });

  it('matches a natural-language intent by word overlap and ranks the candidates it returns', () => {
    // "save the invoice" contains-matches nothing (the intent is `save_invoice`), and the save
    // button is 6th in id order, so a first-five fallback would drop the one right answer.
    const phrase = findElementDef(map, 'invoice_new', { intent: 'save the invoice' });
    assert.equal(phrase.element?.id, 'invoice.save.button');
    assert.equal(findElementDef(map, 'invoice_list', { intent: 'add a new invoice' }).element?.id, 'invoice.add.button');
    assert.equal(findElementDef(map, 'invoice_new', { intent: 'pick the client' }).element?.id, 'invoice.client.picker');
    // a query that overlaps several elements equally returns them ranked, not the file's first five
    const vague = findElementDef(map, 'invoice_new', { intent: 'invoice' });
    if (vague.element === undefined) {
      assert.ok(vague.candidates.length > 0 && vague.candidates.length <= FIND_ELEMENT_ALTERNATIVES_MAX);
      for (const c of vague.candidates) {
        const words = [c.intent, c.label, c.id].filter((x): x is string => typeof x === 'string').join(' ').toLowerCase();
        assert.match(words, /invoice/, `${c.id} should be scored, not positional`);
      }
    }
    // a query matching nothing at all still yields alternatives rather than an empty payload
    const none = findElementDef(map, 'invoice_new', { intent: 'teleport to mars' });
    assert.equal(none.element, undefined);
    assert.ok(none.candidates.length > 0 && none.candidates.length <= FIND_ELEMENT_ALTERNATIVES_MAX);
  });

  it('errors are structured: unknown screen → not_found, empty query → bad_input', () => {
    assert.throws(() => findElementDef(map, 'nope', { element_id: 'x' }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND);
    assert.throws(() => findElementDef(map, 'invoice_list', {}), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });

  it('static find_element describes the top locator; with a tree it resolves; text ≤120 tokens', () => {
    const s = findElement(map, 'invoice_list', { element_id: 'invoice.add.button' });
    assert.equal(s.found, true);
    if (s.found) {
      assert.equal(s.hit.strategy, 'a11y_id');
      assert.equal(s.hit.confidence, 1);
      assert.equal(s.hit.degraded, false);
      assert.deepEqual(s.hit.target, { by: 'id', id: 'invoice.add.button' });
      assert.ok(!('node' in s.hit));
    }
    assert.ok(estimateTokens(s.text) <= 120);
    assert.match(s.text, /^element invoice\.add\.button on invoice_list: a11y_id 1\.00 -> id "invoice\.add\.button"$/);
    const live = findElement(map, 'invoice_list', { element_id: 'invoice.add.button' }, loadFixtureTree('invoice_list.no_ids'));
    assert.equal(live.found === true && live.hit.strategy, 'role_label');
    assert.ok(estimateTokens(live.text) <= 120);
    const miss = findElement(map, 'invoice_list', { element_id: 'invoice.list.table' }, loadFixtureTree('invoice_list.no_ids'));
    assert.equal(miss.found, false);
    if (!miss.found) { assert.equal(miss.miss?.status, 'miss'); assert.equal(miss.element, 'invoice.list.table'); }
    assert.ok(estimateTokens(miss.text) <= 120);
    const unknown = findElement(map, 'invoice_list', { intent: 'teleport' });
    assert.equal(unknown.found, false);
    if (!unknown.found) assert.ok(unknown.candidates.length > 0 && unknown.candidates.length <= FIND_ELEMENT_ALTERNATIVES_MAX);
    assert.ok(estimateTokens(unknown.text) <= 120);
  });
});

describe('resolve — the tree is never mutated', () => {
  it('resolving every element leaves the fixture identical', () => {
    const tree = loadFixtureTree('invoice_list');
    const before = JSON.stringify(tree);
    for (const el of map.screens.get('invoice_list')!.elements) resolve(map, el, tree);
    let n = 0;
    walk(tree, () => { n++; });
    assert.ok(n > 0);
    assert.equal(JSON.stringify(tree), before);
    const c = cloneTree(tree);
    assert.equal(JSON.stringify(c), before);
  });
});

describe('resolve — a nested capture whose screen marker is doubled (follow-up to #15 and #10)', () => {
  it('scopes to the marker CONTAINER, so every invoice_list element still resolves', () => {
    // `appMapScreen(_:)` stamps `screen.invoice_list` on the container AND on the 1 pt overlay
    // inside it; nesting survives every capture but the flat Argent one, and resolve scopes to
    // `screenRoot` — the childless overlay would leave it a subtree with zero children.
    const tree = normalizeTree(doubledMarkerXcuiFixture(), { platform: 'ios' });
    assert.ok(screenRoot(tree).children.length > 0, 'the screen root must not be the 1 pt overlay');
    const add = map.screens.get('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    const r = resolve(map, add, tree);
    assert.equal(r.status, 'hit');
    if (r.status !== 'hit') return;
    assert.equal(r.strategy, 'a11y_id');
    assert.equal(r.node.a11y_id, 'invoice.add.button');
    assert.equal(r.node.label, 'New Invoice', 'a real element, not the unlabeled marker');
    assert.deepEqual(r.target, { by: 'id', id: 'invoice.add.button' });
    for (const el of map.screens.get('invoice_list')!.elements) {
      assert.equal(resolve(map, el, tree).status, 'hit', el.id);
    }
  });
});
