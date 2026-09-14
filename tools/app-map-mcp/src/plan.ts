/**
 * [B2] `plan_path {from, to}` (03 §8; invariant: prefer deep links, 05 §6.4).
 *
 * 1. If `to` has a `deep_link !== 'none'` → `{kind:'deep_link', deep_link}` regardless of `from`
 *    (the deep link's own `?fixture=` is kept as written in the screen file).
 * 2. Else BFS over `edges` with `status !== 'retired'` from `from` to `to`, treating
 *    `_previous` edges as non-traversable, gates as pass-through nodes (an edge whose `to` is a
 *    gate id is followed to the gate's `_previous`, i.e. back to the source), and preferring
 *    fewer edges, then `verified` edges over `candidate`. Returns the ordered edge list.
 * 3. No route (or `from === 'unknown'` and no deep link) → `{kind:'none', reason}`.
 *
 * Layer: map (imports types only). Pure.
 */
import type { Edge, EdgeAction, LoadedMap, PlanPathResult, ScreenId } from './types.ts';
import { PREVIOUS_SCREEN, UNKNOWN_SCREEN, emitDeepLink, isGateId } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';

type EdgeStep = { from: ScreenId; action: EdgeAction; to: ScreenId };

/**
 * A usable deep link: a non-empty string other than the literal `none` (01 R5, decision 9), in
 * the scheme the app actually registers — the map writes every link `appmap://` and this is one
 * of the points it is handed to a caller who will open it (issue #25).
 */
function deepLinkOf(map: LoadedMap, id: ScreenId): string | undefined {
  const link = map.screens.get(id)?.deep_link;
  if (typeof link !== 'string' || link === '' || link === 'none') return undefined;
  return emitDeepLink(link, map.manifest?.deep_link_scheme);
}

function requireScreen(map: LoadedMap, id: ScreenId, role: 'from' | 'to'): void {
  if (typeof id !== 'string' || id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `plan_path: ${role} must be a screen id`, 'pass {from, to} screen ids (from may be "unknown")');
  }
  if (map.screens.has(id)) return;
  const what = map.gates.has(id) || isGateId(id) ? `${JSON.stringify(id)} is a gate, not a screen` : `screen ${JSON.stringify(id)} is not in the map`;
  throw new AppMapError(ERROR_CODES.NOT_FOUND, `plan_path: ${what}`, 'call summary for the list of screens, or identify_screen to find the current one');
}

/**
 * Outgoing traversable edges of `screen` (03 §8, 02 §8): `status !== 'retired'`, `to` a known
 * `kind: screen` file that is itself not retired. `_previous` cannot be planned statically and
 * an edge into a gate only returns to its source (`_previous`), so both are skipped.
 */
function outgoing(map: LoadedMap, screenId: ScreenId): Array<{ edge: Edge; to: ScreenId }> {
  const screen = map.screens.get(screenId);
  if (screen === undefined || !Array.isArray(screen.edges)) return [];
  const out: Array<{ edge: Edge; to: ScreenId }> = [];
  for (const edge of screen.edges) {
    if (!edge || typeof edge !== 'object' || edge.status === 'retired') continue;
    const to = edge.to;
    if (typeof to !== 'string' || to === PREVIOUS_SCREEN || to === screenId) continue;
    if (map.gates.has(to) || isGateId(to)) continue; // pass-through: gate → _previous → source
    const target = map.screens.get(to);
    if (target === undefined || target.meta?.status === 'retired') continue;
    out.push({ edge, to });
  }
  return out;
}

/**
 * Shortest path by edge count, ties broken by the number of non-`verified` edges, then by the
 * deterministic order of screens/edges as authored. Small graphs: label-setting search over
 * lexicographic `(hops, candidates)` costs (a Dijkstra with tuple weights).
 */
function search(map: LoadedMap, from: ScreenId, to: ScreenId): EdgeStep[] | undefined {
  if (from === to) return [];
  interface Best { hops: number; candidates: number; via?: { prev: ScreenId; step: EdgeStep } }
  const best = new Map<ScreenId, Best>([[from, { hops: 0, candidates: 0 }]]);
  const better = (a: { hops: number; candidates: number }, b: Best | undefined): boolean =>
    b === undefined || a.hops < b.hops || (a.hops === b.hops && a.candidates < b.candidates);
  const open: ScreenId[] = [from];
  const closed = new Set<ScreenId>();
  while (open.length > 0) {
    // pick the open node with the smallest (hops, candidates), stable on insertion order
    let idx = 0;
    for (let i = 1; i < open.length; i++) {
      if (better(best.get(open[i]!)!, best.get(open[idx]!))) idx = i;
    }
    const current = open.splice(idx, 1)[0]!;
    if (closed.has(current)) continue;
    closed.add(current);
    if (current === to) break;
    const cur = best.get(current)!;
    for (const { edge, to: next } of outgoing(map, current)) {
      if (closed.has(next)) continue;
      const cost = { hops: cur.hops + 1, candidates: cur.candidates + (edge.status === 'verified' ? 0 : 1) };
      if (better(cost, best.get(next))) {
        best.set(next, { ...cost, via: { prev: current, step: { from: current, action: edge.action, to: next } } });
        open.push(next);
      }
    }
  }
  const end = best.get(to);
  if (end === undefined) return undefined;
  const steps: EdgeStep[] = [];
  for (let node = end; node.via !== undefined; node = best.get(node.via.prev)!) steps.push(node.via.step);
  return steps.reverse();
}

export function planPath(map: LoadedMap, from: ScreenId | 'unknown', to: ScreenId, opts: { preferDeepLink?: boolean } = {}): PlanPathResult {
  requireScreen(map, to, 'to');
  const preferDeepLink = opts?.preferDeepLink ?? true;
  // 1. deep link (03 §8 "prefers deep link", 05 §6.4) — works from any screen, even `unknown`
  if (preferDeepLink) {
    const link = deepLinkOf(map, to);
    if (link !== undefined) return { kind: 'deep_link', from, to, deep_link: link };
  }
  // 3. nothing to plan from an unidentified screen without a deep link
  if (from === UNKNOWN_SCREEN) {
    return { kind: 'none', from, to, reason: `current screen is unknown and ${to} has no deep link; identify the screen first (identify_screen) or navigate manually` };
  }
  requireScreen(map, from, 'from');
  return shortestEdgePath(map, from, to);
}

/** Shortest edge path without the deep-link shortcut (used for `entry.fallback_path` at run time, 04 §5). */
export function shortestEdgePath(map: LoadedMap, from: ScreenId, to: ScreenId): PlanPathResult & { kind: 'edges' | 'none' } {
  requireScreen(map, from, 'from');
  requireScreen(map, to, 'to');
  const edges = search(map, from, to);
  if (edges === undefined) {
    return { kind: 'none', from, to, reason: `no non-retired edge path from ${from} to ${to}` };
  }
  return { kind: 'edges', from, to, edges };
}
