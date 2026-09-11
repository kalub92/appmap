/**
 * [B2] Screen identification (03 §5), variants (02 §4.3), decay (02 §8).
 *
 * `identify(map, tree, opts)`:
 *  1. gates: for every `map.gates` entry, `gateSignatureMatches` → `gates_present`;
 *  2. marker: exactly one node with id `^screen\.` (findMarkerNodes.count === 1) whose suffix is
 *     a known screen → `{screen_id, confidence 1.0, signals:[marker]}` — done (still compute
 *     `structural_hash` and, when `opts.build` given, apply decay);
 *  3. route: `opts.route` (or `tree.route`) whose `routeKey` is in `map.routes` → 0.9;
 *  4. required_ids: fraction f of `signature.required_ids` present, only if f ≥ 0.5 → 0.8 × f;
 *  5. structural_hash: `structuralHash(tree, screen.dynamic_regions)` equals
 *     `signature.structural_hash` → 0.7;
 *  6. title: `titleOf(tree)` equals `screen.title` → 0.4.
 *  score = max(signals) + 0.05 × (agreeing signals − 1), capped at 1.0. Variants are scored the
 *  same way with their own `required_ids`/`structural_hash`, only when `evaluateCondition(when,
 *  opts.conditions)` is true or undefined (unknown ⇒ any variant may match). Best (screen,
 *  variant) wins; best < 0.6 → `screen_id: 'unknown'` with top-3 `candidates`.
 *  Gates are never the `screen_id`; a tree that is only a gate (no screen underneath) is
 *  `unknown` with the gate in `gates_present`.
 *
 * Decay (02 §8): `confidence = base × 0.9^buildsSince`, floor 0.2, where buildsSince =
 * `buildsSince(opts.build, screen.meta.last_verified_build)`; not applied when either is
 * missing or non-numeric. Computed, never stored.
 *
 * Performance: <50 ms on a 2,000-node tree (03 §11) — index the tree once (ids set, hash) and
 * score screens against the index.
 *
 * Layer: map (imports types + tree + signature). Pure.
 */
import type { BuildNumber, Condition, IdentifyOptions, IdentifyResult, IdentifySignal, LoadedMap, AnyTree, ScreenFile, Variant } from './types.ts';
import { NotImplementedError } from './errors.ts';

export const DECAY_FACTOR = 0.9;
export const DECAY_FLOOR = 0.2;

export function identify(map: LoadedMap, tree: AnyTree, opts: IdentifyOptions = {}): IdentifyResult {
  void map; void tree; void opts;
  throw new NotImplementedError('identify.identify');
}

/** Signals 3–6 for one screen or one of its variants (`variant` overrides required_ids/hash). */
export function scoreScreen(map: LoadedMap, screen: ScreenFile, tree: AnyTree, opts: IdentifyOptions, variant?: Variant): { score: number; signals: IdentifySignal[] } {
  void map; void screen; void tree; void opts; void variant;
  throw new NotImplementedError('identify.scoreScreen');
}

/** `max + 0.05 × (n − 1)` capped at 1; 0 for no signals. */
export function combineSignals(signals: readonly IdentifySignal[]): number {
  void signals;
  throw new NotImplementedError('identify.combineSignals');
}

/**
 * Evaluate a variant `when` (or edge pre/postcondition) against known facts. `true`/`false` when
 * every key in `cond` is present in `facts`; `undefined` when any key is unknown (02 §4.3
 * "unknown conditions are treated as any variant may match"). `platform_version` compares
 * dotted versions with the leading operator.
 */
export function evaluateCondition(cond: Condition, facts: Condition | undefined): boolean | undefined {
  void cond; void facts;
  throw new NotImplementedError('identify.evaluateCondition');
}

export function decayConfidence(base: number, buildsSinceVerified: number): number {
  void base; void buildsSinceVerified;
  throw new NotImplementedError('identify.decayConfidence');
}

/** Numeric difference `current − lastVerified` when both parse as non-negative integers (≥0), else `undefined`. */
export function buildsSince(current: BuildNumber, lastVerified: BuildNumber | undefined): number | undefined {
  void current; void lastVerified;
  throw new NotImplementedError('identify.buildsSince');
}
