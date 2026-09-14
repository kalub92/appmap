/**
 * [B2] Locator resolution (02 §5.2, 03 §6) and `find_element` (03 §8).
 *
 * `resolve(map, element, tree)`:
 * ```
 * for locator in element.locators (ranked, as authored):
 *   matches = queryLocator(tree, locator)
 *   if 1 match  → hit {confidence: weight, degraded: weight < 0.6}
 *   if >1 match and strategy ∈ {a11y_id, role_label} → disambiguate(tree, matches, fingerprint)
 *        by sibling_index (same parent role, same index) then nearest bbox centre;
 *        unique → hit {confidence: weight × 0.9, disambiguated: true}
 * no unique match on any strategy → miss {tried, candidates ≤3}
 * ```
 * Query semantics per strategy:
 *  - `a11y_id`: `node.a11y_id === value`;
 *  - `role_label`: `roleLabelMatches(node, value)` (signature.ts);
 *  - `text`: `labelOf(node) === value` (exact) on any role;
 *  - `path`: `nodeAtPath(tree, value)` (0 or 1 match);
 *  - `geometry`: nodes whose bbox contains the point, preferring the smallest area; the single
 *    smallest is the match (ties → 2 matches → not unique).
 * Resolution is scoped to the tree under `screenRoot(tree)`; nodes under an `alert`/`sheet`
 * that is a gate are excluded when `opts.excludeGates` (default true) so a dialog never
 * satisfies a screen element.
 *
 * `target` of a hit: `{by:'id'}` when the node has an id, else `{by:'role_label'}` when it has a
 * label, else `{by:'text'}` when a text locator hit, else `{by:'point'}` at the bbox centre.
 *
 * Side effects (counters `hits`/`misses`, heal proposals) are the caller's job (observe.ts,
 * guided.ts) — this module is pure.
 *
 * Layer: map (imports types + tree + signature).
 */
import type { AnyTree, DriverTarget, ElementDef, ElementId, GateId, FindElementResult, Fingerprint, LoadedMap, Locator, ResolveHit, ResolveMiss, ResolveResult, ScreenId, TreeNode } from './types.ts';
import { DEGRADED_THRESHOLD, DEFAULT_LOCATOR_WEIGHTS, LOCATOR_STRATEGIES, REDACTED, isGateId } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { centerOf, labelOf, nodeAtPath, parentOf, pathOf, screenRoot, siblingIndex, walk } from './tree.ts';
import { gateSignatureMatches, roleLabelMatches } from './signature.ts';
import { formatFindElement } from './format.ts';

/** 03 §6: a disambiguated hit keeps 90 % of the locator weight */
export const DISAMBIGUATION_FACTOR = 0.9;
export const MISS_CANDIDATES_MAX = 3;
export const FIND_ELEMENT_ALTERNATIVES_MAX = 5;

export interface ResolveOptions {
  /** exclude nodes under matched gate dialogs (default true) */
  excludeGates?: boolean;
  /** ids of gates present (from identify) to exclude; computed via gateSignatureMatches when omitted */
  gatesPresent?: readonly string[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function subtreeSet(node: TreeNode): Set<TreeNode> {
  const set = new Set<TreeNode>();
  walk(node, (n) => { set.add(n); });
  return set;
}

/** the element belongs to a gate file (or is a gate dismiss control): resolve it against the whole tree */
function isGateElement(map: LoadedMap, element: ElementDef): boolean {
  if (isGateId(element.id) || /^gate\./.test(element.id)) return true;
  const refs = map.elements.get(element.id) ?? [];
  return refs.length > 0 && refs.every((r) => map.gates.has(r.screen));
}

/**
 * The subtree node of the dialog `gateId` is showing, or `undefined` when it is not up. The
 * one-gate variant of `gateDialogNodes`, exported so healing can scope its candidate search to the
 * dialog a gate control lives in (issue #24) instead of walking the whole screen.
 */
export function gateDialogRoot(map: LoadedMap, tree: AnyTree, gateId: GateId): TreeNode | undefined {
  const gate = map.gates.get(gateId);
  if (gate === undefined || !tree?.root) return undefined;
  let found: TreeNode | undefined;
  walk(tree, (n) => {
    if (found !== undefined) return false;
    if (n.role !== 'alert' && n.role !== 'sheet') return undefined;
    if (gateSignatureMatches({ ...tree, root: n } as AnyTree, gate)) { found = n; return false; }
    return undefined;
  });
  return found;
}

/** The gate `def` belongs to: named by the step, or the gate file that declares the element. */
export function gateOfElement(map: LoadedMap, def: ElementDef, named?: GateId): GateId | undefined {
  if (named !== undefined) return named;
  for (const [id, gate] of map.gates) {
    if ((gate.elements ?? []).some((e) => e.id === def.id)) return id;
  }
  return undefined;
}

/**
 * The two structural bounds a heal of a GATE control gets (04 §7.3, issue #24) — the dialog it may
 * look in, and the sibling controls it may never propose. `{}` for an ordinary screen element,
 * which heals exactly as before; `undefined` means REFUSE THE HEAL.
 *
 * Both halves fail CLOSED, because the situation where they cannot be computed is precisely a
 * redesign of the dialog — which is also precisely when a heal is attempted. An unbounded walk
 * would then be free to propose the button next to the one we lost, and the whole point is that
 * "heal Cancel into Delete" must be impossible rather than merely improbable: two buttons in one
 * alert agree on role, role path and parent role and sit close together, so the 04 §7.1 score
 * alone lands within noise of the acceptance line.
 *
 * Shared by both replay rungs on purpose. The guided runner and the headless runner build their
 * own `HealInput`, and a safety property that only one of them applies is not a safety property.
 */
export function gateHealScope(
  map: LoadedMap, def: ElementDef, tree: AnyTree, named?: GateId,
): { candidateRoot?: TreeNode; forbiddenNodes?: ReadonlySet<TreeNode> } | undefined {
  const gateId = gateOfElement(map, def, named);
  if (gateId === undefined) return {};
  const root = gateDialogRoot(map, tree, gateId);
  if (root === undefined) return undefined;
  const siblings = new Set<TreeNode>();
  const registered = map.ids.gates.find((g) => g.id === gateId);
  const others = [registered?.dismiss, ...(registered?.controls ?? []).map((c) => c.id)]
    .filter((id): id is ElementId => typeof id === 'string' && id !== '' && id !== def.id);
  for (const id of others) {
    const otherDef = map.gates.get(gateId)?.elements?.find((e) => e.id === id);
    if (otherDef === undefined) continue;
    const hit = resolve(map, otherDef, tree);
    // a sibling that does NOT resolve is the dangerous case, not a benign one: its node is still in
    // the dialog and is now the best-scoring lookalike for the control being healed
    if (hit.status !== 'hit') return undefined;
    siblings.add(hit.node);
  }
  return { candidateRoot: root, ...(siblings.size > 0 ? { forbiddenNodes: siblings } : {}) };
}

/**
 * Nodes under an `alert`/`sheet` (other than the screen root itself) whose subtree satisfies the
 * signature of a gate that is present — those never satisfy a screen element (header).
 */
function gateDialogNodes(map: LoadedMap, tree: AnyTree, root: TreeNode, opts: ResolveOptions): Set<TreeNode> {
  const excluded = new Set<TreeNode>();
  const present = opts.gatesPresent !== undefined
    ? opts.gatesPresent.map((id) => map.gates.get(id)).filter((g): g is NonNullable<typeof g> => g !== undefined)
    : Array.from(map.gates.values()).filter((g) => gateSignatureMatches(tree, g));
  if (present.length === 0) return excluded;
  walk(tree, (n) => {
    if (n === root || (n.role !== 'alert' && n.role !== 'sheet')) return undefined;
    const sub: AnyTree = { ...tree, root: n } as AnyTree;
    if (present.some((g) => gateSignatureMatches(sub, g))) {
      for (const x of subtreeSet(n)) excluded.add(x);
      return false;
    }
    return undefined;
  });
  return excluded;
}

function weightOf(locator: Locator): number {
  const w = locator.weight;
  if (typeof w === 'number' && Number.isFinite(w)) return Math.max(0, Math.min(1, w));
  return DEFAULT_LOCATOR_WEIGHTS[locator.strategy] ?? 0;
}

export function resolve(map: LoadedMap, element: ElementDef, tree: AnyTree, opts: ResolveOptions = {}): ResolveResult {
  if (!element || typeof element !== 'object' || typeof element.id !== 'string') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'resolve: element definition is missing an id', 'pass an ElementDef from a loaded screen file');
  }
  if (!tree || typeof tree !== 'object' || !tree.root) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'resolve: tree has no root', 'pass a normalized tree (tree.normalizeTree)');
  }
  const gateElement = isGateElement(map, element);
  // gate controls live beside the marker container (pilot alerts), so they search the whole tree
  const scope = gateElement ? tree.root : screenRoot(tree);
  const excludeGates = !gateElement && (opts.excludeGates ?? true);
  const excluded = excludeGates ? gateDialogNodes(map, tree, scope, opts) : new Set<TreeNode>();

  const locators = Array.isArray(element.locators) ? element.locators : [];
  const tried: ResolveMiss['tried'] = [];
  for (let rank = 0; rank < locators.length; rank += 1) {
    const locator = locators[rank]!;
    if (!locator || typeof locator !== 'object' || !(LOCATOR_STRATEGIES as readonly string[]).includes(locator.strategy)) continue;
    let matches = queryLocator(tree, locator, scope);
    if (excluded.size > 0) matches = matches.filter((n) => !excluded.has(n));
    tried.push({ strategy: locator.strategy, matches: matches.length });
    const weight = weightOf(locator);
    if (matches.length === 1) {
      return hit(tree, element, matches[0]!, locator, weight, false, rank);
    }
    if (matches.length > 1 && (locator.strategy === 'a11y_id' || locator.strategy === 'role_label')) {
      // 03 §6: fingerprint disambiguation, confidence × 0.9
      const picked = disambiguate(tree, matches, element.fingerprint);
      if (picked !== undefined) return hit(tree, element, picked, locator, round4(weight * DISAMBIGUATION_FACTOR), true, rank);
    }
  }
  return miss(tree, element, scope, excluded, tried);
}

function hit(
  tree: AnyTree,
  element: ElementDef,
  node: TreeNode,
  locator: Locator,
  confidence: number,
  disambiguated: boolean,
  rank: number,
): ResolveHit {
  return {
    status: 'hit',
    element: element.id,
    node,
    path: safePath(tree, node),
    strategy: locator.strategy,
    locator,
    confidence,
    // 02 §5.2: a hit below the threshold proceeds but is a degraded match (heal proposal).
    // 03 §12 / 04 §9 additionally treat a fall-through as degraded: the authored top locator
    // (rank 0, normally a11y_id at weight 1.0) missed, so the element drifted even though the
    // runner-up strategy's own weight is not below the threshold.
    degraded: confidence < DEGRADED_THRESHOLD || rank > 0,
    disambiguated,
    target: targetFor(tree, node, locator.strategy),
  };
}

function safePath(tree: AnyTree, node: TreeNode): string {
  try {
    return pathOf(tree, node);
  } catch {
    return '';
  }
}

function miss(tree: AnyTree, element: ElementDef, scope: TreeNode, excluded: Set<TreeNode>, tried: ResolveMiss['tried']): ResolveMiss {
  const candidates: ResolveMiss['candidates'] = [];
  walk(scope, (n) => {
    if (candidates.length >= MISS_CANDIDATES_MAX) return false;
    if (excluded.has(n)) return false;
    if (n.role !== element.role) return undefined;
    const label = labelOf(n);
    const id = n.a11y_id;
    if (label === undefined && id === undefined) return undefined;
    const c: ResolveMiss['candidates'][number] = { path: safePath(tree, n), role: n.role };
    if (label !== undefined) c.label = label;
    if (id !== undefined) c.a11y_id = id;
    candidates.push(c);
    return undefined;
  });
  return { status: 'miss', element: element.id, tried, candidates };
}

function contains(node: TreeNode, p: { x: number; y: number }): boolean {
  const b = node.bbox_norm;
  if (!b) return false;
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

/** All nodes matching one locator (see semantics above). */
export function queryLocator(tree: AnyTree, locator: Locator, scope?: TreeNode): TreeNode[] {
  if (!tree || !tree.root || !locator || typeof locator !== 'object') return [];
  const root = scope ?? screenRoot(tree);
  const out: TreeNode[] = [];
  switch (locator.strategy) {
    case 'a11y_id': {
      const value = locator.value;
      if (typeof value !== 'string' || value === '' || value === REDACTED) return [];
      walk(root, (n) => { if (n.a11y_id === value) out.push(n); });
      return out;
    }
    case 'role_label': {
      const value = locator.value;
      if (!value || typeof value !== 'object' || typeof value.role !== 'string') return [];
      walk(root, (n) => { if (roleLabelMatches(n, value)) out.push(n); });
      return out;
    }
    case 'text': {
      const value = locator.value;
      if (typeof value !== 'string' || value === '') return [];
      walk(root, (n) => { if (labelOf(n) === value) out.push(n); });
      return out;
    }
    case 'path': {
      if (typeof locator.value !== 'string') return [];
      const node = nodeAtPath(tree, locator.value);
      if (node === undefined) return [];
      // a path only counts inside the requested scope
      if (root !== tree.root && !subtreeSet(root).has(node)) return [];
      return [node];
    }
    case 'geometry': {
      const p = locator.value;
      if (!p || typeof p !== 'object' || typeof p.x !== 'number' || typeof p.y !== 'number') return [];
      let best: TreeNode[] = [];
      let bestArea = Number.POSITIVE_INFINITY;
      walk(root, (n) => {
        if (!contains(n, p)) return undefined;
        const area = n.bbox_norm.w * n.bbox_norm.h;
        if (area < bestArea - 1e-9) { bestArea = area; best = [n]; }
        else if (Math.abs(area - bestArea) <= 1e-9) best.push(n);
        return undefined;
      });
      return best;
    }
    default:
      return [];
  }
}

function centreDistance(node: TreeNode, fp: NonNullable<Fingerprint['bbox_norm']>): number {
  const c = centerOf(node);
  const fx = fp.x + fp.w / 2;
  const fy = fp.y + fp.h / 2;
  return Math.hypot(c.x - fx, c.y - fy);
}

/** Pick one of `matches` using the stored fingerprint; `undefined` when still ambiguous. */
export function disambiguate(tree: AnyTree, matches: readonly TreeNode[], fingerprint: Fingerprint | undefined): TreeNode | undefined {
  if (!Array.isArray(matches) || matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0];
  if (!fingerprint || typeof fingerprint !== 'object') return undefined;
  let pool: TreeNode[] = [...matches];
  // 1. same parent role and same index among all siblings (02 §5.3)
  if (fingerprint.sibling_index !== undefined || fingerprint.parent_role !== undefined) {
    const filtered = pool.filter((n) => {
      if (fingerprint.parent_role !== undefined) {
        const parent = parentOf(tree, n);
        if (parent === undefined || parent.role !== fingerprint.parent_role) return false;
      }
      if (fingerprint.sibling_index !== undefined && siblingIndex(tree, n) !== fingerprint.sibling_index) return false;
      return true;
    });
    if (filtered.length === 1) return filtered[0];
    if (filtered.length > 1) pool = filtered;
  }
  // 2. nearest bbox centre; an exact tie stays ambiguous
  const bb = fingerprint.bbox_norm;
  if (bb && typeof bb.x === 'number' && typeof bb.y === 'number' && typeof bb.w === 'number' && typeof bb.h === 'number') {
    let best: TreeNode | undefined;
    let bestD = Number.POSITIVE_INFINITY;
    let tie = false;
    for (const n of pool) {
      const d = centreDistance(n, bb);
      if (d < bestD - 1e-9) { best = n; bestD = d; tie = false; }
      else if (Math.abs(d - bestD) <= 1e-9) tie = true;
    }
    return tie ? undefined : best;
  }
  return undefined;
}

export function targetFor(tree: AnyTree, node: TreeNode, viaStrategy: Locator['strategy']): DriverTarget {
  void tree;
  if (typeof node.a11y_id === 'string' && node.a11y_id !== '' && node.a11y_id !== REDACTED) return { by: 'id', id: node.a11y_id };
  if (typeof node.label === 'string' && node.label !== '' && node.label !== REDACTED) return { by: 'role_label', role: node.role, label: node.label };
  if (viaStrategy === 'text') {
    const text = labelOf(node);
    if (typeof text === 'string' && text !== '' && text !== REDACTED) return { by: 'text', text };
  }
  const c = centerOf(node);
  return { by: 'point', x: c.x, y: c.y };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** the segments between the feature and the kind: `invoice.add.button` → `add`, `a.b.c.d` → `b c` */
function middleSegment(id: string): string {
  const parts = id.split('.');
  if (parts.length <= 2) return parts[parts.length - 1] ?? id;
  return parts.slice(1, -1).join(' ');
}

/**
 * Words carrying no intent signal. The LLM phrases `intent` in natural language
 * ("save the invoice"), so these are dropped before token overlap scoring.
 */
const INTENT_STOPWORDS = new Set(['a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'into', 'it', 'my', 'of', 'on', 'please', 'that', 'the', 'then', 'this', 'to', 'with']);

function intentTokens(s: string): string[] {
  return norm(s).split(' ').filter((w) => w !== '' && !INTENT_STOPWORDS.has(w));
}

/** searchable tokens of an element: its intent, its static label, and its id's middle segment */
function elementTokens(e: ElementDef): Set<string> {
  const out = new Set<string>();
  for (const source of [e.intent, e.label, middleSegment(e.id)]) {
    if (typeof source !== 'string') continue;
    for (const w of intentTokens(source)) out.add(w);
  }
  return out;
}

/**
 * Fraction of the query's meaningful words this element carries (0..1). Used only to rank the
 * miss payload's candidates so 03 §8's "top candidates" are the closest ones, never the first
 * five in id order.
 */
function intentScore(e: ElementDef, queryTokens: readonly string[]): number {
  if (queryTokens.length === 0) return 0;
  const hay = elementTokens(e);
  let hits = 0;
  for (const w of queryTokens) if (hay.has(w)) hits += 1;
  return hits / queryTokens.length;
}

function screenOrGate(map: LoadedMap, screenId: ScreenId) {
  const file = map.screens.get(screenId) ?? map.gates.get(screenId);
  if (file === undefined) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `screen ${JSON.stringify(screenId)} is not in the map`, 'call summary for the list of screens, or identify_screen to find the current one');
  }
  return file;
}

/**
 * Look up an element on a screen by id or by `intent` (exact, then case-insensitive substring,
 * then word overlap — over `intent`, `label`, and the id's middle segment). Returns the
 * definition plus up to 5 alternatives, ranked by closeness, for the miss payload.
 */
export function findElementDef(map: LoadedMap, screenId: ScreenId, query: { element_id?: ElementId; intent?: string }): { element?: ElementDef; candidates: ElementDef[] } {
  const file = screenOrGate(map, screenId);
  const elements = Array.isArray(file.elements) ? file.elements : [];
  const q = query ?? {};
  if (typeof q.element_id === 'string' && q.element_id !== '') {
    const element = elements.find((e) => e.id === q.element_id);
    if (element) return { element, candidates: [] };
    // alternatives: same feature prefix first, then the rest, ≤5
    const feature = q.element_id.split('.')[0] ?? '';
    const same = elements.filter((e) => e.id.split('.')[0] === feature);
    const rest = elements.filter((e) => !same.includes(e));
    return { candidates: [...same, ...rest].slice(0, FIND_ELEMENT_ALTERNATIVES_MAX) };
  }
  if (typeof q.intent === 'string' && q.intent.trim() !== '') {
    const exact = elements.filter((e) => e.intent === q.intent);
    if (exact.length === 1) return { element: exact[0], candidates: [] };
    if (exact.length > 1) return { candidates: exact.slice(0, FIND_ELEMENT_ALTERNATIVES_MAX) };
    const needle = norm(q.intent);
    if (needle === '') return { candidates: elements.slice(0, FIND_ELEMENT_ALTERNATIVES_MAX) };
    const loose = elements.filter((e) => {
      const hay = [e.intent, e.label, middleSegment(e.id)].filter((x): x is string => typeof x === 'string').map(norm);
      return hay.some((h) => h.includes(needle));
    });
    if (loose.length === 1) return { element: loose[0], candidates: [] };
    if (loose.length > 1) return { candidates: loose.slice(0, FIND_ELEMENT_ALTERNATIVES_MAX) };
    // No substring hit: a multi-word phrase ("save the invoice") never contains-matches
    // `save_invoice`. Score by word overlap instead; a single strictly-best element is the hit,
    // otherwise the ranked candidates are the miss payload (03 §8 "top candidates").
    const queryTokens = intentTokens(q.intent);
    const scored = elements
      .map((e, i) => ({ e, i, score: intentScore(e, queryTokens) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => (b.score - a.score) || (a.i - b.i));
    const best = scored[0];
    if (best !== undefined) {
      const runnerUp = scored[1];
      if (runnerUp === undefined || best.score > runnerUp.score) return { element: best.e, candidates: [] };
      return { candidates: scored.slice(0, FIND_ELEMENT_ALTERNATIVES_MAX).map((s) => s.e) };
    }
    return { candidates: elements.slice(0, FIND_ELEMENT_ALTERNATIVES_MAX) };
  }
  throw new AppMapError(ERROR_CODES.BAD_INPUT, 'find_element needs element_id or intent', 'pass {screen_id, element_id} or {screen_id, intent}');
}

/** the driver target a locator describes without a tree (static `find_element`) */
function staticTarget(element: ElementDef, locator: Locator): DriverTarget {
  switch (locator.strategy) {
    case 'a11y_id': return { by: 'id', id: locator.value };
    case 'role_label': return { by: 'role_label', role: locator.value.role, label: locator.value.label ?? element.label ?? locator.value.label_regex ?? '' };
    case 'text': return { by: 'text', text: locator.value };
    case 'geometry': return { by: 'point', x: locator.value.x, y: locator.value.y };
    default: return element.label !== undefined ? { by: 'role_label', role: element.role, label: element.label } : { by: 'text', text: element.id };
  }
}

/**
 * `find_element` tool body (03 §8): definition lookup, then `resolve` against `tree` when one
 * is supplied (the last observation), else a "static" hit describing the top locator with its
 * weight and `degraded: false`. Output text ≤120 tokens (format.ts formatFindElement).
 */
export function findElement(map: LoadedMap, screenId: ScreenId, query: { element_id?: ElementId; intent?: string }, tree?: AnyTree): FindElementResult {
  const { element, candidates } = findElementDef(map, screenId, query);
  const compact = (list: ElementDef[]) => list.map((e) => ({ id: e.id, ...(e.intent !== undefined ? { intent: e.intent } : {}), ...(e.label !== undefined ? { label: e.label } : {}) }));
  if (element === undefined) {
    const partial = { found: false as const, screen_id: screenId, candidates: compact(candidates), text: '' };
    return { ...partial, text: formatFindElement(partial) };
  }
  if (tree !== undefined) {
    const r = resolve(map, element, tree);
    if (r.status === 'hit') {
      const { node: _node, ...hitNoNode } = r;
      void _node;
      const partial = { found: true as const, screen_id: screenId, element: element.id, hit: hitNoNode, text: '' };
      return { ...partial, text: formatFindElement(partial) };
    }
    const partial = { found: false as const, screen_id: screenId, element: element.id, miss: r, candidates: compact(candidates), text: '' };
    return { ...partial, text: formatFindElement(partial) };
  }
  const top = (Array.isArray(element.locators) ? element.locators : [])[0];
  if (top === undefined) {
    const partial = { found: false as const, screen_id: screenId, element: element.id, candidates: compact(candidates), text: '' };
    return { ...partial, text: formatFindElement(partial) };
  }
  const weight = weightOf(top);
  const hitNoNode: Omit<ResolveHit, 'node'> = {
    status: 'hit', element: element.id, path: '', strategy: top.strategy, locator: top, confidence: weight,
    degraded: false, disambiguated: false, target: staticTarget(element, top),
  };
  const partial = { found: true as const, screen_id: screenId, element: element.id, hit: hitNoNode, text: '' };
  return { ...partial, text: formatFindElement(partial) };
}
