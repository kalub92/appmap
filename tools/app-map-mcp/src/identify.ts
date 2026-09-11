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
import type { BuildNumber, Condition, IdentifyCandidate, IdentifyOptions, IdentifyResult, IdentifySignal, LoadedMap, AnyTree, ScreenFile, Variant } from './types.ts';
import {
  IDENTIFY_AGREEMENT_BONUS, IDENTIFY_SCORES, IDENTIFY_UNKNOWN_THRESHOLD, REQUIRED_IDS_MIN_FRACTION, UNKNOWN_SCREEN,
  routeKey, screenIdOfMarker,
} from './types.ts';
import { findMarkerNodes, walk } from './tree.ts';
import { gateSignatureMatches, structuralHash, titleOf } from './signature.ts';

export const DECAY_FACTOR = 0.9;
export const DECAY_FLOOR = 0.2;

/** scores are rounded so `0.8 + 0.05` style sums compare exactly in tests and events */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/**
 * One-pass index of a tree: the set of ids present, the nav title and a memo of structural
 * hashes keyed by the dynamic-region set (03 §11: score 300 screens without re-walking).
 */
interface TreeIndex {
  ids: ReadonlySet<string>;
  title: string | undefined;
  hashes: Map<string, string>;
  tree: AnyTree;
}

function indexTree(tree: AnyTree): TreeIndex {
  const ids = new Set<string>();
  walk(tree, (n) => { if (typeof n.a11y_id === 'string' && n.a11y_id !== '') ids.add(n.a11y_id); });
  return { ids, title: titleOf(tree), hashes: new Map(), tree };
}

function hashFor(index: TreeIndex, regions: readonly string[]): string {
  const key = Array.from(new Set(regions)).sort().join('\n');
  let h = index.hashes.get(key);
  if (h === undefined) {
    h = structuralHash(index.tree, regions);
    index.hashes.set(key, h);
  }
  return h;
}

/**
 * Dynamic regions used to hash a screen or one of its variants: `screen.dynamic_regions` plus,
 * for a variant, those of its `required_ids` the registry marks `dynamic: true`. The pilot
 * variant hash (`invoice_list` / `new_invoices_ui`) was generated with its dynamic list
 * (`invoice.list.collection`) excluded exactly like the base screen's `invoice.list.table`, and
 * a variant cannot declare its own `dynamic_regions` (02 §4.3 schema).
 */
function regionsFor(map: LoadedMap, screen: ScreenFile, variant?: Variant): string[] {
  const regions = Array.isArray(screen.dynamic_regions) ? [...screen.dynamic_regions] : [];
  if (variant && Array.isArray(variant.required_ids)) {
    for (const id of variant.required_ids) {
      if (map.elementRegistry.get(id)?.dynamic === true && !regions.includes(id)) regions.push(id);
    }
  }
  return regions;
}

function resolveRoute(map: LoadedMap, tree: AnyTree, opts: IdentifyOptions): string | undefined {
  const raw = opts.route ?? tree.route;
  if (typeof raw !== 'string' || raw === '' || raw === 'none') return undefined;
  return map.routes.get(routeKey(raw));
}

/** Signals 3–6 against a prebuilt index (the public `scoreScreen` builds the index itself). */
function scoreAgainst(map: LoadedMap, screen: ScreenFile, index: TreeIndex, routeScreen: string | undefined, variant?: Variant): { score: number; signals: IdentifySignal[] } {
  const signals: IdentifySignal[] = [];
  const base = { screen: screen.id, ...(variant ? { variant: variant.id } : {}) };
  // 3. route (03 §5.3) — a property of the screen, shared by its variants
  if (routeScreen !== undefined && routeScreen === screen.id) {
    signals.push({ ...base, kind: 'route', score: IDENTIFY_SCORES.route, detail: routeScreen });
  }
  // 4. required_ids (03 §5.4): 0.8 × f, only when f ≥ 0.5; an empty list carries no evidence
  const required = variant?.required_ids ?? screen.signature?.required_ids;
  if (Array.isArray(required) && required.length > 0) {
    const wanted = Array.from(new Set(required.filter((id) => typeof id === 'string' && id !== '')));
    if (wanted.length > 0) {
      const present = wanted.filter((id) => index.ids.has(id)).length;
      const f = present / wanted.length;
      if (f >= REQUIRED_IDS_MIN_FRACTION) {
        signals.push({ ...base, kind: 'required_ids', score: round4(IDENTIFY_SCORES.required_ids * f), detail: `${present}/${wanted.length}` });
      }
    }
  }
  // 5. structural_hash (03 §5.5, 02 §4.4)
  const expected = variant?.structural_hash ?? screen.signature?.structural_hash;
  if (typeof expected === 'string' && expected !== '') {
    const actual = hashFor(index, regionsFor(map, screen, variant));
    if (actual === expected) signals.push({ ...base, kind: 'structural_hash', score: IDENTIFY_SCORES.structural_hash, detail: actual });
  }
  // 6. title (03 §5.6): exact nav-title equality
  if (typeof screen.title === 'string' && index.title !== undefined && index.title.trim() === screen.title.trim()) {
    signals.push({ ...base, kind: 'title', score: IDENTIFY_SCORES.title, detail: screen.title });
  }
  return { score: combineSignals(signals), signals };
}

interface Scored { screen: ScreenFile; variant?: Variant; score: number; signals: IdentifySignal[] }

export function identify(map: LoadedMap, tree: AnyTree, opts: IdentifyOptions = {}): IdentifyResult {
  // 1. gates (03 §5.1) — every gate whose signature matches, sorted for stable output
  const gates_present: string[] = [];
  for (const gate of map.gates.values()) {
    if (gateSignatureMatches(tree, gate)) gates_present.push(gate.id);
  }
  gates_present.sort();

  const index = indexTree(tree);
  const { nodes: markerNodes, count } = findMarkerNodes(tree);
  const marker = count === 1 ? markerNodes[0]!.a11y_id : undefined;

  // 2. marker (03 §5.2): exactly one marker whose suffix is a known `kind: screen` file (gates
  // never win identification — architecture §7 decision 19)
  if (marker !== undefined) {
    const suffix = screenIdOfMarker(marker);
    const byIndex = map.markers.get(marker);
    const screenId = byIndex !== undefined && map.screens.has(byIndex) ? byIndex : (suffix !== undefined && map.screens.has(suffix) ? suffix : undefined);
    if (screenId !== undefined) {
      const screen = map.screens.get(screenId)!;
      const signal: IdentifySignal = { kind: 'marker', screen: screenId, score: IDENTIFY_SCORES.marker, detail: marker };
      return finish(map, screen, undefined, IDENTIFY_SCORES.marker, [signal], gates_present, marker, index, opts);
    }
  }

  // 3–6. score every (screen, variant) pair against the index
  const routeScreen = resolveRoute(map, tree, opts);
  const scored: Scored[] = [];
  for (const screen of map.screens.values()) {
    if (screen.meta?.status === 'retired') continue;
    const baseScore = scoreAgainst(map, screen, index, routeScreen);
    scored.push({ screen, ...baseScore });
    for (const variant of screen.variants ?? []) {
      // 02 §4.3: a variant is only excluded when its condition is known to be false
      if (evaluateCondition(variant.when ?? {}, opts.conditions, opts.flags) === false) continue;
      const v = scoreAgainst(map, screen, index, routeScreen, variant);
      scored.push({ screen, variant, ...v });
    }
  }
  scored.sort(compareScored);

  const best = scored[0];
  if (best !== undefined && best.score >= IDENTIFY_UNKNOWN_THRESHOLD) {
    return finish(map, best.screen, best.variant, best.score, best.signals, gates_present, marker, index, opts);
  }

  // unknown (03 §5): not an error — explore mode; top-3 candidates, best entry per screen
  const candidates: IdentifyCandidate[] = [];
  const seen = new Set<string>();
  for (const s of scored) {
    if (s.score <= 0 || seen.has(s.screen.id)) continue;
    seen.add(s.screen.id);
    candidates.push({
      screen_id: s.screen.id,
      ...(s.variant ? { variant: s.variant.id } : {}),
      confidence: s.score,
      signals: s.signals.map((x) => x.kind),
    });
    if (candidates.length === 3) break;
  }
  const result: IdentifyResult = {
    screen_id: UNKNOWN_SCREEN,
    confidence: best?.score ?? 0,
    signals: [],
    gates_present,
    candidates,
    structural_hash: hashFor(index, []),
  };
  if (marker !== undefined) result.marker = marker;
  return result;
}

/** deterministic order: score desc, then screen id, then base screen before its variants */
function compareScored(a: Scored, b: Scored): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.screen.id !== b.screen.id) return a.screen.id < b.screen.id ? -1 : 1;
  const av = a.variant?.id ?? '';
  const bv = b.variant?.id ?? '';
  return av < bv ? -1 : av > bv ? 1 : 0;
}

function finish(
  map: LoadedMap, screen: ScreenFile, variant: Variant | undefined, score: number, signals: IdentifySignal[],
  gates_present: string[], marker: string | undefined, index: TreeIndex, opts: IdentifyOptions,
): IdentifyResult {
  const result: IdentifyResult = {
    screen_id: screen.id,
    ...(variant ? { variant: variant.id } : {}),
    confidence: score,
    signals,
    gates_present,
    structural_hash: hashFor(index, regionsFor(map, screen, variant)),
  };
  if (marker !== undefined) result.marker = marker;
  // 02 §8 decay — only when both build numbers are known and numeric (architecture §7 decision 18)
  if (opts.build !== undefined) {
    const n = buildsSince(opts.build, screen.meta?.last_verified_build);
    if (n !== undefined) {
      result.builds_since_verified = n;
      result.confidence = decayConfidence(score, n);
    }
  }
  return result;
}

/** Signals 3–6 for one screen or one of its variants (`variant` overrides required_ids/hash). */
export function scoreScreen(map: LoadedMap, screen: ScreenFile, tree: AnyTree, opts: IdentifyOptions, variant?: Variant): { score: number; signals: IdentifySignal[] } {
  return scoreAgainst(map, screen, indexTree(tree), resolveRoute(map, tree, opts ?? {}), variant);
}

/** `max + 0.05 × (n − 1)` capped at 1; 0 for no signals. */
export function combineSignals(signals: readonly IdentifySignal[]): number {
  if (!Array.isArray(signals) || signals.length === 0) return 0;
  let max = 0;
  for (const s of signals) if (typeof s.score === 'number' && s.score > max) max = s.score;
  return round4(Math.min(1, max + IDENTIFY_AGREEMENT_BONUS * (signals.length - 1)));
}

const VERSION_OP_RE = /^\s*(>=|<=|==|=|>|<)?\s*(.*?)\s*$/;

/** dotted-version compare: `17.4` vs `17` → 1; non-numeric segments compare as 0 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function versionSatisfies(actual: string, expr: string): boolean {
  const m = VERSION_OP_RE.exec(expr);
  const op = m?.[1] ?? '=';
  const want = m?.[2] ?? expr;
  const c = compareVersions(actual, want);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    default: return c === 0;
  }
}

/**
 * Evaluate a variant `when` (or edge pre/postcondition) against known facts. `true`/`false` when
 * every key in `cond` is present in `facts` (`flag`/`value` pairs are looked up in `flags`:
 * `flags[cond.flag] === cond.value`); `undefined` when any key is unknown (02 §4.3 "unknown
 * conditions are treated as any variant may match"). `platform_version` compares dotted
 * versions with the leading operator. Facts come from `probeConditions(ctx.probe)`.
 */
export function evaluateCondition(cond: Condition, facts: Condition | undefined, flags?: IdentifyOptions['flags']): boolean | undefined {
  if (!cond || typeof cond !== 'object') return true;
  let unknown = false;
  // a definite `false` on any key wins over an unknown on another: the variant cannot hold
  if (cond.flag !== undefined) {
    const known = flags !== undefined && Object.prototype.hasOwnProperty.call(flags, cond.flag);
    if (!known) unknown = true;
    else if (flags![cond.flag] !== (cond.value === undefined ? true : cond.value)) return false;
  }
  if (cond.auth !== undefined) {
    if (facts?.auth === undefined) unknown = true;
    else if (cond.auth !== 'any' && facts.auth !== 'any' && facts.auth !== cond.auth) return false;
  }
  if (cond.screen !== undefined) {
    if (facts?.screen === undefined) unknown = true;
    else if (facts.screen !== cond.screen) return false;
  }
  if (cond.platform_version !== undefined) {
    if (facts?.platform_version === undefined) unknown = true;
    else if (!versionSatisfies(facts.platform_version, cond.platform_version)) return false;
  }
  return unknown ? undefined : true;
}

export function decayConfidence(base: number, buildsSinceVerified: number): number {
  if (typeof base !== 'number' || !Number.isFinite(base)) return 0;
  if (typeof buildsSinceVerified !== 'number' || !Number.isFinite(buildsSinceVerified) || buildsSinceVerified <= 0) return base;
  // 02 §8: base × 0.9^n with a 0.2 floor; the floor never lifts a confidence above its base
  const decayed = base * Math.pow(DECAY_FACTOR, buildsSinceVerified);
  return round4(Math.max(Math.min(base, DECAY_FLOOR), decayed));
}

const BUILD_RE = /^\d+$/;

/** Numeric difference `current − lastVerified` when both parse as non-negative integers (≥0), else `undefined`. */
export function buildsSince(current: BuildNumber, lastVerified: BuildNumber | undefined): number | undefined {
  if (typeof current !== 'string' || typeof lastVerified !== 'string') return undefined;
  const c = current.trim();
  const l = lastVerified.trim();
  if (!BUILD_RE.test(c) || !BUILD_RE.test(l)) return undefined;
  const diff = Number(c) - Number(l);
  if (!Number.isFinite(diff)) return undefined;
  // a map verified on a newer build than the running one has nothing to decay
  return Math.max(0, diff);
}
