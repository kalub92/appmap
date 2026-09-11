/** [B2] plan.ts — plan_path (03 §8): deep link first (05 §6.4), else shortest non-retired edge path. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Edge, LoadedMap, ScreenFile } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { loadMap } from '../yaml/load.ts';
import { planPath, shortestEdgePath } from '../plan.ts';
import { makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

/** map copy with one screen edited in place (pure planPath never sees the disk) */
function edit(base: LoadedMap, id: string, fn: (screen: ScreenFile) => void): LoadedMap {
  const screen = structuredClone(base.screens.get(id)!);
  fn(screen);
  const screens = new Map(base.screens);
  screens.set(id, screen);
  return { ...base, screens };
}
const tap = (element: string, to: string, status: Edge['status'] = 'verified'): Edge => ({ action: { type: 'tap', element }, to, status });
const isCode = (code: string) => (e: unknown): boolean => AppMapError.is(e) && e.code === code;

describe('planPath — deep link preferred (invariant 7)', () => {
  it('login → invoice_new is the deep link, whatever the edge graph says', () => {
    assert.deepEqual(planPath(map, 'login', 'invoice_new'), { kind: 'deep_link', from: 'login', to: 'invoice_new', deep_link: 'appmap://invoice_new' });
  });

  it('works from unknown and keeps the screen file\'s ?fixture query as written', () => {
    assert.deepEqual(planPath(map, 'unknown', 'invoice_list'), { kind: 'deep_link', from: 'unknown', to: 'invoice_list', deep_link: 'appmap://invoice_list' });
    const r = planPath(map, 'login', 'invoice_detail');
    assert.equal(r.kind, 'deep_link');
    if (r.kind === 'deep_link') assert.equal(r.deep_link, 'appmap://invoice_detail?fixture=one_draft_invoice');
  });

  it('from === to with a deep link still returns the deep link; without one, an empty edge list', () => {
    assert.equal(planPath(map, 'login', 'login').kind, 'deep_link');
    assert.deepEqual(planPath(map, 'client_picker', 'client_picker'), { kind: 'edges', from: 'client_picker', to: 'client_picker', edges: [] });
  });

  it('preferDeepLink: false forces the edge search', () => {
    const r = planPath(map, 'login', 'invoice_new', { preferDeepLink: false });
    assert.equal(r.kind, 'edges');
    if (r.kind === 'edges') assert.equal(r.edges.length, 2);
  });
});

describe('planPath — edge paths (03 §8 ordered edge list)', () => {
  it('login → invoice_detail (no deep-link shortcut) is submit then tap a cell', () => {
    const r = shortestEdgePath(map, 'login', 'invoice_detail');
    assert.deepEqual(r, {
      kind: 'edges', from: 'login', to: 'invoice_detail', edges: [
        { from: 'login', action: { type: 'tap', element: 'login.submit.button' }, to: 'invoice_list' },
        { from: 'invoice_list', action: { type: 'tap', element: 'invoice.list.cell' }, to: 'invoice_detail' },
      ],
    });
  });

  it('invoice_new → client_picker is one edge (client_picker has deep_link none, decision 9)', () => {
    assert.deepEqual(planPath(map, 'invoice_new', 'client_picker'), {
      kind: 'edges', from: 'invoice_new', to: 'client_picker', edges: [
        { from: 'invoice_new', action: { type: 'tap', element: 'invoice.client.picker' }, to: 'client_picker' },
      ],
    });
  });

  it('login → client_picker chains three verified edges, consecutive and ordered', () => {
    const r = planPath(map, 'login', 'client_picker');
    assert.equal(r.kind, 'edges');
    if (r.kind !== 'edges') return;
    assert.deepEqual(r.edges.map((e) => [e.from, e.to]), [['login', 'invoice_list'], ['invoice_list', 'invoice_new'], ['invoice_new', 'client_picker']]);
    for (let i = 1; i < r.edges.length; i++) assert.equal(r.edges[i]!.from, r.edges[i - 1]!.to);
  });

  it('client_picker → invoice_detail goes through invoice_new (select or cancel edge, the first authored wins)', () => {
    const r = shortestEdgePath(map, 'client_picker', 'invoice_detail');
    assert.equal(r.kind, 'edges');
    if (r.kind === 'edges') {
      assert.equal(r.edges.length, 2);
      assert.deepEqual(r.edges[0]!.action, { type: 'select', element: 'client.picker.cell' });
      assert.deepEqual(r.edges[1]!.action, { type: 'tap', element: 'invoice.save.button' });
    }
  });

  it('prefers fewer edges, then verified over candidate edges', () => {
    // a candidate edge authored before the verified one: same hop count → the verified one wins
    const m = edit(map, 'invoice_new', (s) => { s.edges.unshift(tap('invoice.due.picker', 'client_picker', 'candidate')); });
    const r = planPath(m, 'invoice_new', 'client_picker');
    assert.equal(r.kind === 'edges' && r.edges[0]!.action.type === 'tap' && r.edges[0]!.action.element, 'invoice.client.picker');
    // but a shorter candidate path beats a longer verified one
    const direct = edit(map, 'login', (s) => { s.edges.push(tap('login.forgot.link', 'client_picker', 'candidate')); });
    const d = planPath(direct, 'login', 'client_picker');
    assert.equal(d.kind === 'edges' && d.edges.length, 1);
  });

  it('retired edges and edges into retired screens are not traversed', () => {
    const retiredEdge = edit(map, 'invoice_new', (s) => { s.edges.find((e) => e.to === 'client_picker')!.status = 'retired'; });
    assert.equal(planPath(retiredEdge, 'invoice_new', 'client_picker').kind, 'none');
    const retiredScreen = edit(map, 'invoice_list', (s) => { s.meta.status = 'retired'; });
    assert.equal(shortestEdgePath(retiredScreen, 'login', 'invoice_new').kind, 'none', 'the only route passes through invoice_list');
  });

  it('_previous edges and gate edges are pass-through, never planned', () => {
    const m = edit(map, 'invoice_new', (s) => {
      s.edges = [tap('invoice.cancel.button', '_previous'), tap('invoice.note.field', 'gate.push_permission'), ...s.edges.filter((e) => e.to !== 'invoice_list')];
    });
    const r = shortestEdgePath(m, 'invoice_new', 'client_picker');
    assert.equal(r.kind, 'edges');
    if (r.kind === 'edges') assert.ok(r.edges.every((e) => e.to !== '_previous' && !e.to.startsWith('gate.')));
    // a gate can never be a destination
    assert.throws(() => planPath(m, 'invoice_new', 'gate.push_permission'), isCode(ERROR_CODES.NOT_FOUND));
  });
});

describe('planPath — none and errors', () => {
  it('unreachable → kind none with a reason', () => {
    const r = planPath(map, 'client_picker', 'login', { preferDeepLink: false });
    assert.equal(r.kind, 'none');
    if (r.kind === 'none') { assert.equal(r.from, 'client_picker'); assert.equal(r.to, 'login'); assert.match(r.reason, /no .*edge path/); }
    const noDeep = edit(map, 'login', (s) => { s.deep_link = 'none'; });
    assert.equal(planPath(noDeep, 'client_picker', 'login').kind, 'none');
  });

  it('from unknown without a deep link → none, pointing at identify_screen', () => {
    const r = planPath(map, 'unknown', 'client_picker');
    assert.equal(r.kind, 'none');
    if (r.kind === 'none') assert.match(r.reason, /unknown/);
  });

  it('unknown or gate screen ids are AppMapError(not_found); empty ids are bad_input', () => {
    assert.throws(() => planPath(map, 'login', 'nowhere'), isCode(ERROR_CODES.NOT_FOUND));
    assert.throws(() => planPath(map, 'nowhere', 'client_picker'), isCode(ERROR_CODES.NOT_FOUND));
    assert.throws(() => planPath(map, 'gate.push_permission', 'client_picker'), isCode(ERROR_CODES.NOT_FOUND));
    assert.throws(() => shortestEdgePath(map, 'unknown', 'login'), isCode(ERROR_CODES.NOT_FOUND), 'shortestEdgePath needs a real from');
    assert.throws(() => planPath(map, 'login', ''), isCode(ERROR_CODES.BAD_INPUT));
    assert.throws(() => planPath(map, 'login', undefined as unknown as string), isCode(ERROR_CODES.BAD_INPUT));
  });

  it('never mutates the map', () => {
    const before = JSON.stringify(Array.from(map.screens.values()));
    planPath(map, 'login', 'client_picker');
    shortestEdgePath(map, 'client_picker', 'login');
    assert.equal(JSON.stringify(Array.from(map.screens.values())), before);
  });
});
