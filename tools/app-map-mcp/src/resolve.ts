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
import type { AnyTree, DriverTarget, ElementDef, ElementId, FindElementResult, Fingerprint, LoadedMap, Locator, ResolveResult, ScreenId, TreeNode } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface ResolveOptions {
  /** exclude nodes under matched gate dialogs (default true) */
  excludeGates?: boolean;
  /** ids of gates present (from identify) to exclude; computed via gateSignatureMatches when omitted */
  gatesPresent?: readonly string[];
}

export function resolve(map: LoadedMap, element: ElementDef, tree: AnyTree, opts: ResolveOptions = {}): ResolveResult {
  void map; void element; void tree; void opts;
  throw new NotImplementedError('resolve.resolve');
}

/** All nodes matching one locator (see semantics above). */
export function queryLocator(tree: AnyTree, locator: Locator, scope?: TreeNode): TreeNode[] {
  void tree; void locator; void scope;
  throw new NotImplementedError('resolve.queryLocator');
}

/** Pick one of `matches` using the stored fingerprint; `undefined` when still ambiguous. */
export function disambiguate(tree: AnyTree, matches: readonly TreeNode[], fingerprint: Fingerprint | undefined): TreeNode | undefined {
  void tree; void matches; void fingerprint;
  throw new NotImplementedError('resolve.disambiguate');
}

export function targetFor(tree: AnyTree, node: TreeNode, viaStrategy: Locator['strategy']): DriverTarget {
  void tree; void node; void viaStrategy;
  throw new NotImplementedError('resolve.targetFor');
}

/**
 * Look up an element on a screen by id or by `intent` (exact, then case-insensitive substring
 * over `intent`, `label`, and the id's middle segment). Returns the definition plus up to 5
 * alternatives for the miss payload.
 */
export function findElementDef(map: LoadedMap, screenId: ScreenId, query: { element_id?: ElementId; intent?: string }): { element?: ElementDef; candidates: ElementDef[] } {
  void map; void screenId; void query;
  throw new NotImplementedError('resolve.findElementDef');
}

/**
 * `find_element` tool body (03 §8): definition lookup, then `resolve` against `tree` when one
 * is supplied (the last observation), else a "static" hit describing the top locator with its
 * weight and `degraded: false`. Output text ≤120 tokens (format.ts formatFindElement).
 */
export function findElement(map: LoadedMap, screenId: ScreenId, query: { element_id?: ElementId; intent?: string }, tree?: AnyTree): FindElementResult {
  void map; void screenId; void query; void tree;
  throw new NotImplementedError('resolve.findElement');
}
