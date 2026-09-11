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
import type { LoadedMap, PlanPathResult, ScreenId } from './types.ts';
import { NotImplementedError } from './errors.ts';

export function planPath(map: LoadedMap, from: ScreenId | 'unknown', to: ScreenId, opts: { preferDeepLink?: boolean } = {}): PlanPathResult {
  void map; void from; void to; void opts;
  throw new NotImplementedError('plan.planPath');
}

/** Shortest edge path without the deep-link shortcut (used for `entry.fallback_path` at run time, 04 §5). */
export function shortestEdgePath(map: LoadedMap, from: ScreenId, to: ScreenId): PlanPathResult & { kind: 'edges' | 'none' } {
  void map; void from; void to;
  throw new NotImplementedError('plan.shortestEdgePath');
}
