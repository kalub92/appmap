/** [B2] identify.ts — identification cascade (03 §5), variants (02 §4.3), decay (02 §8). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AnyTree, IdentifySignal, LoadedMap, ScreenFile, Tree, TreeNode } from '../types.ts';
import { IDENTIFY_SCORES, IDENTIFY_UNKNOWN_THRESHOLD, UNKNOWN_SCREEN, probeConditions, roleHintsFor } from '../types.ts';
import { loadMap } from '../yaml/load.ts';
import { structuralHash } from '../signature.ts';
import { findByA11yId, normalizeTree, walk } from '../tree.ts';
import {
  DECAY_FACTOR, DECAY_FLOOR, buildsSince, combineSignals, decayConfidence, evaluateCondition, identify, scoreScreen,
} from '../identify.ts';
import { PILOT_SCREEN_TREES, cloneTree, loadFixtureTree, makeTempAppMapDir, readJsonFixture } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

/** the same tree with every `screen.*` marker id dropped (cascade path, 03 §5.3–5.6) */
function withoutMarker(tree: Tree): Tree {
  const c = cloneTree(tree);
  walk(c, (n) => { if (typeof n.a11y_id === 'string' && n.a11y_id.startsWith('screen.')) delete n.a11y_id; });
  return c;
}

/** shallow map copy with one screen replaced (pure `identify` never sees the disk) */
function withScreen(base: LoadedMap, screen: ScreenFile): LoadedMap {
  const screens = new Map(base.screens);
  screens.set(screen.id, screen);
  return { ...base, screens };
}

function node(role: TreeNode['role'], extra: Partial<TreeNode> = {}, children: TreeNode[] = []): TreeNode {
  return { role, bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children, ...extra };
}

function synthetic(root: TreeNode, route?: string): Tree {
  const tree: Tree = { schema_version: 1, platform: 'ios', source: 'synthetic', root };
  if (route !== undefined) tree.route = route;
  return tree;
}

const kinds = (signals: IdentifySignal[]): string[] => signals.map((s) => s.kind).sort();

describe('identify — marker (03 §5.2)', () => {
  it('identifies every pilot fixture tree as its screen with confidence 1.0 via the marker', () => {
    for (const id of PILOT_SCREEN_TREES) {
      const tree = loadFixtureTree(id);
      const r = identify(map, tree);
      assert.equal(r.screen_id, id);
      assert.equal(r.confidence, 1);
      assert.deepEqual(r.signals.map((s) => s.kind), ['marker']);
      assert.equal(r.signals[0]!.score, IDENTIFY_SCORES.marker);
      assert.equal(r.marker, `screen.${id}`);
      assert.equal(r.variant, undefined);
      assert.equal(r.candidates, undefined);
      assert.deepEqual(r.gates_present, []);
      assert.equal(r.structural_hash, map.screens.get(id)!.signature.structural_hash, `${id} hash uses the screen's dynamic_regions`);
      assert.equal(r.builds_since_verified, undefined, 'no build → no decay');
    }
  });

  it('identifies the android fixture trees against the android map', () => {
    const ta = makeTempAppMapDir({ platform: 'android' });
    try {
      const android = loadMap(ta.config);
      for (const id of PILOT_SCREEN_TREES) {
        const r = identify(android, loadFixtureTree(`android/${id}`));
        assert.equal(r.screen_id, id);
        assert.equal(r.confidence, 1);
      }
    } finally {
      ta.cleanup();
    }
  });

  it('the invoice_new.amount_focused and pii fixtures still identify by marker', () => {
    assert.equal(identify(map, loadFixtureTree('invoice_new.amount_focused')).screen_id, 'invoice_new');
    assert.equal(identify(map, loadFixtureTree('pii')).screen_id, 'invoice_list');
  });

  it('with_gate fixtures → the screen plus gates_present (03 §5.1)', () => {
    const r = identify(map, loadFixtureTree('invoice_list.with_gate'));
    assert.equal(r.screen_id, 'invoice_list');
    assert.equal(r.confidence, 1);
    assert.deepEqual(r.gates_present, ['gate.push_permission']);
    const l = identify(map, loadFixtureTree('login.with_gate'));
    assert.equal(l.screen_id, 'login');
    assert.deepEqual(l.gates_present, ['gate.biometric_prompt']);
  });

  it('a marker for an unknown screen id falls through to the cascade', () => {
    const tree = cloneTree(loadFixtureTree('invoice_list'));
    findByA11yId(tree, 'screen.invoice_list')[0]!.a11y_id = 'screen.not_in_map';
    const r = identify(map, tree);
    assert.equal(r.screen_id, 'invoice_list');
    assert.ok(!r.signals.some((s) => s.kind === 'marker'));
    assert.equal(r.marker, 'screen.not_in_map', 'the marker seen is still reported');
  });

  it('two markers → the deepest wins: a pushed detail leaves the parent marker in the tree (01 R3, issue #10)', () => {
    // the reporter saw `identify_screen` answer `films_list` while `person_detail` was on screen:
    // taking the first marker identifies the screen the pushed one COVERS
    const tree = cloneTree(loadFixtureTree('invoice_list'));
    findByA11yId(tree, 'invoice.list.table')[0]!.children.push(node('container', { a11y_id: 'screen.login' }));
    const r = identify(map, tree);
    assert.equal(r.marker, 'screen.login');
    assert.deepEqual(r.signals.map((s) => s.kind), ['marker']);
    assert.equal(r.screen_id, 'login');
    assert.equal(r.confidence, 1);
  });

  it('identifies a real flat Argent capture of a pushed screen as the pushed screen (issue #10)', () => {
    const raw = readJsonFixture('raw/argent-native-describe-screen.invoice_detail.json');
    const tree = normalizeTree(raw, { platform: 'ios', roleHints: roleHintsFor(map) });
    const r = identify(map, tree);
    assert.equal(r.screen_id, 'invoice_detail', 'not invoice_list, whose marker is still in the tree');
    assert.equal(r.marker, 'screen.invoice_detail');
    assert.equal(r.confidence, 1);
  });

  it('a gate-only tree is unknown with the gate present, never the gate as screen_id (decision 19)', () => {
    const alert = node('alert', {}, [node('button', { label: 'Don’t Allow' }), node('button', { label: 'Allow' })]);
    const r = identify(map, synthetic(node('application', {}, [node('window', {}, [alert])])));
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
    assert.deepEqual(r.gates_present, ['gate.push_permission']);
    assert.deepEqual(r.candidates, []);
    assert.equal(r.confidence, 0);
  });
});

describe('identify — cascade scores (03 §5.3–5.6)', () => {
  it('marker removed: required_ids (0.8) and title (0.4) agree → 0.85', () => {
    for (const id of ['invoice_list', 'invoice_new', 'invoice_detail', 'client_picker']) {
      const r = identify(map, withoutMarker(loadFixtureTree(id)));
      assert.equal(r.screen_id, id);
      assert.deepEqual(kinds(r.signals), ['required_ids', 'title']);
      assert.equal(r.signals.find((s) => s.kind === 'required_ids')!.score, IDENTIFY_SCORES.required_ids);
      assert.equal(r.signals.find((s) => s.kind === 'title')!.score, IDENTIFY_SCORES.title);
      assert.equal(r.confidence, 0.85, id);
      assert.equal(r.marker, undefined);
    }
  });

  it('login has no nav bar: required_ids alone → exactly 0.8 (no agreement bonus)', () => {
    const r = identify(map, withoutMarker(loadFixtureTree('login')));
    assert.equal(r.screen_id, 'login');
    assert.deepEqual(kinds(r.signals), ['required_ids']);
    assert.equal(r.confidence, 0.8);
  });

  it('structural_hash match scores 0.7 and joins the agreement bonus (0.8 + 0.05 × 2 = 0.9)', () => {
    const tree = withoutMarker(loadFixtureTree('invoice_list'));
    const screen = structuredClone(map.screens.get('invoice_list')!);
    screen.signature.structural_hash = structuralHash(tree, screen.dynamic_regions ?? []);
    const r = identify(withScreen(map, screen), tree);
    assert.equal(r.screen_id, 'invoice_list');
    assert.deepEqual(kinds(r.signals), ['required_ids', 'structural_hash', 'title']);
    assert.equal(r.signals.find((s) => s.kind === 'structural_hash')!.score, IDENTIFY_SCORES.structural_hash);
    assert.equal(r.confidence, 0.9);
    assert.equal(r.structural_hash, screen.signature.structural_hash);
  });

  it('structural_hash alone → 0.7 (still ≥ 0.6, so identified)', () => {
    const tree = withoutMarker(loadFixtureTree('invoice_list'));
    const screen = structuredClone(map.screens.get('invoice_list')!);
    screen.signature.structural_hash = structuralHash(tree, screen.dynamic_regions ?? []);
    screen.signature.required_ids = ['not.in.tree.one', 'not.in.tree.two'];
    screen.title = 'Something Else';
    const r = identify(withScreen(map, screen), tree);
    assert.equal(r.screen_id, 'invoice_list');
    assert.deepEqual(kinds(r.signals), ['structural_hash']);
    assert.equal(r.confidence, 0.7);
  });

  it('required_ids: 0.8 × f only when f ≥ 0.5; below → no signal', () => {
    // login has 3 required ids and no title: 2/3 present → 0.8 × 0.6667 = 0.5333 (< 0.6 → unknown, but a candidate)
    const two = withoutMarker(loadFixtureTree('login'));
    delete findByA11yId(two, 'login.email.field')[0]!.a11y_id;
    const r2 = identify(map, two);
    assert.equal(r2.screen_id, UNKNOWN_SCREEN);
    assert.equal(r2.candidates![0]!.screen_id, 'login');
    assert.equal(r2.candidates![0]!.confidence, 0.5333);
    assert.deepEqual(r2.candidates![0]!.signals, ['required_ids']);
    assert.equal(r2.confidence, 0.5333, 'unknown reports the best score');
    // 1/3 present → f < 0.5 → no required_ids signal → nothing scores → no candidates
    const one = cloneTree(two);
    delete findByA11yId(one, 'login.password.field')[0]!.a11y_id;
    const r1 = identify(map, one);
    assert.equal(r1.screen_id, UNKNOWN_SCREEN);
    assert.deepEqual(r1.candidates, []);
    assert.equal(r1.confidence, 0);
  });

  it('route: a known deep link scores 0.9 from opts.route or tree.route; the query is ignored', () => {
    const tree = withoutMarker(loadFixtureTree('invoice_list'));
    const viaOpts = identify(map, tree, { route: 'appmap://invoice_list?fixture=three_invoices' });
    assert.equal(viaOpts.screen_id, 'invoice_list');
    assert.deepEqual(kinds(viaOpts.signals), ['required_ids', 'route', 'title']);
    assert.equal(viaOpts.signals.find((s) => s.kind === 'route')!.score, IDENTIFY_SCORES.route);
    assert.equal(viaOpts.confidence, 1, '0.9 + 0.05 × 2 = 1.0 (capped)');
    const viaTree = identify(map, { ...tree, route: 'appmap://invoice_list' });
    assert.equal(viaTree.confidence, 1);
    // a route alone, on a tree with nothing else, is enough (0.9 ≥ 0.6)
    const bare = identify(map, synthetic(node('application'), 'appmap://invoice_new'));
    assert.equal(bare.screen_id, 'invoice_new');
    assert.deepEqual(kinds(bare.signals), ['route']);
    assert.equal(bare.confidence, 0.9);
    // `none` and unknown routes are ignored
    assert.equal(identify(map, synthetic(node('application'), 'none')).screen_id, UNKNOWN_SCREEN);
    assert.equal(identify(map, synthetic(node('application'), 'appmap://nowhere')).screen_id, UNKNOWN_SCREEN);
  });

  it('title alone scores 0.4 → unknown with the screen as top candidate (no_ids fixture, decision 14)', () => {
    const r = identify(map, loadFixtureTree('invoice_list.no_ids'));
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
    assert.equal(r.confidence, 0.4);
    assert.deepEqual(r.signals, []);
    assert.ok(r.candidates!.length >= 1 && r.candidates!.length <= 3);
    assert.equal(r.candidates![0]!.screen_id, 'invoice_list');
    assert.equal(r.candidates![0]!.confidence, IDENTIFY_SCORES.title);
    assert.deepEqual(r.candidates![0]!.signals, ['title']);
    assert.ok(r.confidence < IDENTIFY_UNKNOWN_THRESHOLD);
  });

  it('an unrelated tree → unknown, confidence 0, no candidates, hash of the bare tree', () => {
    const tree = synthetic(node('application', {}, [node('window', {}, [node('button', { label: 'Hello', a11y_id: 'other.thing.button' })])]));
    const r = identify(map, tree);
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
    assert.equal(r.confidence, 0);
    assert.deepEqual(r.candidates, []);
    assert.deepEqual(r.gates_present, []);
    assert.equal(r.structural_hash, structuralHash(tree, []));
  });

  it('unknown carries at most 3 candidates, best per screen, score desc then id', () => {
    // half of every screen's required ids: all five screens score < 0.6
    const ids = ['invoice.add.button', 'client.picker.list', 'invoice.detail.send.button', 'login.email.field', 'login.password.field', 'invoice.amount.field', 'invoice.client.picker'];
    const tree = synthetic(node('application', {}, ids.map((id) => node('other', { a11y_id: id }))));
    const r = identify(map, tree);
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
    assert.equal(r.candidates!.length, 3);
    assert.deepEqual(r.candidates!.map((c) => c.screen_id), ['invoice_new', 'login', 'client_picker']);
    assert.deepEqual(r.candidates!.map((c) => c.confidence), [0.5333, 0.5333, 0.4]);
  });

  it('retired screens never identify through the cascade', () => {
    const screen = structuredClone(map.screens.get('invoice_list')!);
    screen.meta.status = 'retired';
    const r = identify(withScreen(map, screen), withoutMarker(loadFixtureTree('invoice_list')));
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
  });
});

describe('identify — variants (02 §4.3)', () => {
  /** marker dropped, `invoice.list.table` renamed to the variant's collection id */
  function variantTree(): Tree {
    const tree = withoutMarker(loadFixtureTree('invoice_list'));
    findByA11yId(tree, 'invoice.list.table')[0]!.a11y_id = 'invoice.list.collection';
    return tree;
  }

  it('the variant wins when its flag holds (probeConditions flags)', () => {
    const facts = probeConditions({ schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'x', version: '1', build_number: '4412', git_sha: 'a', flags: { new_invoices_ui: true } });
    const r = identify(map, variantTree(), facts);
    assert.equal(r.screen_id, 'invoice_list');
    assert.equal(r.variant, 'new_invoices_ui');
    assert.equal(r.confidence, 0.85, 'variant required_ids 0.8 + title agree');
    assert.ok(r.signals.every((s) => s.variant === 'new_invoices_ui'));
  });

  it('the variant is excluded when its flag is known false', () => {
    const r = identify(map, variantTree(), { flags: { new_invoices_ui: false } });
    assert.equal(r.variant, undefined);
    // base scores 0.4 (1/2 required ids) + title → 0.45 → unknown, candidate is the base screen
    assert.equal(r.screen_id, UNKNOWN_SCREEN);
    assert.equal(r.candidates![0]!.screen_id, 'invoice_list');
    assert.equal(r.candidates![0]!.variant, undefined);
    assert.equal(r.candidates![0]!.confidence, 0.45);
  });

  it('without probe facts any variant may match', () => {
    const r = identify(map, variantTree());
    assert.equal(r.variant, 'new_invoices_ui');
    assert.equal(r.confidence, 0.85);
    const base = identify(map, withoutMarker(loadFixtureTree('invoice_list')));
    assert.equal(base.variant, undefined, 'the base screen wins on the base tree');
  });

  it('scoreScreen scores one screen or one of its variants', () => {
    const screen = map.screens.get('invoice_list')!;
    const tree = variantTree();
    assert.equal(scoreScreen(map, screen, tree, {}).score, 0.45);
    assert.equal(scoreScreen(map, screen, tree, {}, screen.variants![0]).score, 0.85);
  });
});

describe('combineSignals and evaluateCondition', () => {
  const sig = (kind: IdentifySignal['kind'], score: number): IdentifySignal => ({ kind, screen: 'x', score });
  it('score = max + 0.05 × (n − 1), capped at 1.0; 0 for no signals', () => {
    assert.equal(combineSignals([]), 0);
    assert.equal(combineSignals([sig('title', 0.4)]), 0.4);
    assert.equal(combineSignals([sig('required_ids', 0.8), sig('title', 0.4)]), 0.85);
    assert.equal(combineSignals([sig('required_ids', 0.8), sig('structural_hash', 0.7), sig('title', 0.4)]), 0.9);
    assert.equal(combineSignals([sig('route', 0.9), sig('required_ids', 0.8), sig('structural_hash', 0.7), sig('title', 0.4)]), 1);
  });

  it('evaluateCondition: true / false / undefined (unknown)', () => {
    assert.equal(evaluateCondition({}, undefined), true);
    assert.equal(evaluateCondition({ flag: 'f', value: true }, undefined, { f: true }), true);
    assert.equal(evaluateCondition({ flag: 'f', value: true }, undefined, { f: false }), false);
    assert.equal(evaluateCondition({ flag: 'f' }, undefined, { f: true }), true, 'value defaults to true');
    assert.equal(evaluateCondition({ flag: 'f', value: 'b' }, undefined, {}), undefined);
    assert.equal(evaluateCondition({ auth: 'logged_in' }, { auth: 'logged_in' }), true);
    assert.equal(evaluateCondition({ auth: 'logged_in' }, { auth: 'logged_out' }), false);
    assert.equal(evaluateCondition({ auth: 'logged_in' }, {}), undefined);
    assert.equal(evaluateCondition({ platform_version: '>=17.0' }, { platform_version: '17.4' }), true);
    assert.equal(evaluateCondition({ platform_version: '<15' }, { platform_version: '17.4' }), false);
    assert.equal(evaluateCondition({ platform_version: '17' }, { platform_version: '17.0' }), true);
    assert.equal(evaluateCondition({ platform_version: '>=17.0' }, undefined), undefined);
    assert.equal(evaluateCondition({ auth: 'logged_in', flag: 'f' }, { auth: 'logged_out' }, {}), false, 'a definite false beats an unknown');
  });
});

describe('decay (02 §8, decision 18)', () => {
  it('decayConfidence = base × 0.9^n with a 0.2 floor, computed not stored', () => {
    assert.equal(DECAY_FACTOR, 0.9);
    assert.equal(DECAY_FLOOR, 0.2);
    assert.equal(decayConfidence(1, 0), 1);
    assert.equal(decayConfidence(1, 1), 0.9);
    assert.equal(decayConfidence(1, 3), 0.729);
    assert.equal(decayConfidence(0.85, 2), 0.6885);
    assert.equal(decayConfidence(1, 100), 0.2, 'floor');
    assert.equal(decayConfidence(0.15, 3), 0.15, 'the floor never lifts a confidence above its base');
    assert.equal(decayConfidence(1, -2), 1);
  });

  it('buildsSince: numeric difference, 0 when the map is newer, undefined when not numeric', () => {
    assert.equal(buildsSince('4415', '4412'), 3);
    assert.equal(buildsSince('4412', '4412'), 0);
    assert.equal(buildsSince('4400', '4412'), 0);
    assert.equal(buildsSince('auto', '4412'), undefined);
    assert.equal(buildsSince('4412', undefined), undefined);
    assert.equal(buildsSince('4412', '1.2.3'), undefined);
  });

  it('identify applies decay against meta.last_verified_build only when opts.build is numeric', () => {
    const tree = loadFixtureTree('invoice_list');
    const same = identify(map, tree, { build: '4412' });
    assert.equal(same.confidence, 1);
    assert.equal(same.builds_since_verified, 0);
    const later = identify(map, tree, { build: '4415' });
    assert.equal(later.confidence, 0.729);
    assert.equal(later.builds_since_verified, 3);
    assert.equal(later.screen_id, 'invoice_list');
    const far = identify(map, tree, { build: '9999' });
    assert.equal(far.confidence, DECAY_FLOOR);
    const nonNumeric = identify(map, tree, { build: 'auto' });
    assert.equal(nonNumeric.confidence, 1);
    assert.equal(nonNumeric.builds_since_verified, undefined);
    // computed, never stored (02 §8): the screen file and the base confidence are untouched
    assert.equal(map.screens.get('invoice_list')!.meta.last_verified_build, '4412');
    assert.equal(identify(map, tree).confidence, 1);
    // decay applies to cascade results too
    const cascade = identify(map, withoutMarker(tree), { build: '4413' });
    assert.equal(cascade.confidence, 0.765, '0.85 × 0.9');
  });
});

describe('identify — performance (03 §11)', () => {
  it('scores a 2,000-node tree in under 50 ms', () => {
    const tree = cloneTree(loadFixtureTree('invoice_list'));
    const list = findByA11yId(tree, 'invoice.list.table')[0]!;
    let n = 0;
    while (n < 2000) {
      const cell = node('cell', { a11y_id: 'invoice.list.cell' }, [node('staticText', { label: `row ${n}` }), node('button', { label: 'More' })]);
      list.children.push(cell);
      n += 3;
    }
    let count = 0;
    walk(tree as AnyTree, () => { count++; });
    assert.ok(count >= 2000, `tree has ${count} nodes`);
    identify(map, tree); // warm-up (JIT)
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const start = performance.now();
      const r = identify(map, tree);
      best = Math.min(best, performance.now() - start);
      assert.equal(r.screen_id, 'invoice_list');
    }
    assert.ok(best < 50, `identify took ${best.toFixed(1)} ms`);
  });
});
