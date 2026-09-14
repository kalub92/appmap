/**
 * [B2] Screen identification (03 §5), variants (02 §4.3), decay (02 §8).
 *
 * `identify(map, tree, opts)`:
 *  1. gates: for every `map.gates` entry, `gateSignatureMatches` → `gates_present`;
 *  2. marker: the DEEPEST node with id `^screen\.` (`deepestMarker`) whose suffix is a known
 *     screen → `{screen_id, confidence 1.0, signals:[marker]}` — done (still compute
 *     `structural_hash` and, when `opts.build` given, apply decay). Deepest, not "exactly one":
 *     a pushed detail screen leaves the covered screen's marker in the tree (01 R3, issue #10),
 *     and taking the first would identify the screen underneath;
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
import type { BuildNumber, Condition, IdentifyCandidate, IdentifyOptions, IdentifyResult, IdentifySignal, LoadedMap, AnyTree, ScreenFile, ScreenId, Variant } from './types.ts';
import {
  IDENTIFY_AGREEMENT_BONUS, IDENTIFY_SCORES, IDENTIFY_UNKNOWN_THRESHOLD, REQUIRED_IDS_MIN_FRACTION, UNKNOWN_SCREEN,
  canonicalDeepLink, markerOfScreen, routeKey, screenIdOfMarker,
} from './types.ts';
import { deepestMarker, walk } from './tree.ts';
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
  // the driver reports the URL it opened, which is in the scheme the APP registers; `map.routes`
  // is keyed on the canonical `appmap://` form the map writes (issue #25)
  return map.routes.get(routeKey(canonicalDeepLink(raw, map.manifest?.deep_link_scheme)));
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
  const marker = deepestMarker(tree)?.a11y_id;

  // 1b. covered screen (03 §5.1b, issue #24). A modal hides the presenting screen's subtree
  // INCLUDING its `screen.<id>` marker, so the deepest surviving marker is an ANCESTOR — and rule
  // 2 below would answer it at confidence 1.0, an answer built on the absence of the evidence
  // that mattered. While a gate is up the tree is a known-unreliable witness of what is underneath
  // it, which is the one licence to prefer what the session remembers. The marker-named ancestor
  // is not hidden: it travels in `candidates`, so both readings are visible.
  const covered = coveredScreen(map, opts, gates_present, marker, index);
  if (covered !== undefined) {
    const signal: IdentifySignal = { kind: 'covered', screen: covered.id, score: IDENTIFY_SCORES.covered, detail: gates_present.join(',') };
    const result = finish(map, covered, undefined, IDENTIFY_SCORES.covered, [signal], gates_present, marker, index, opts);
    if (covered.ancestor !== undefined) {
      result.candidates = [{ screen_id: covered.ancestor, confidence: IDENTIFY_SCORES.marker, signals: ['marker'] }];
    }
    return result;
  }

  // 2. marker (03 §5.2): the deepest marker whose suffix is a known `kind: screen` file (gates
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

/**
 * 03 §5.1b / issue #24: the screen the session says it was on, when a gate is up and the tree's
 * deepest marker names a DIFFERENT screen. `undefined` (i.e. fall through to the normal rules)
 * `undefined` (fall through to the normal rules) when no gate is present, when nothing was
 * remembered, when the memory is not a live screen, when the remembered screen's own marker is
 * still in the tree, when the marker already agrees, or when the marker-named screen declares one
 * of the present gates on entry — a memory must never override evidence that is still there.
 */
function coveredScreen(
  map: LoadedMap, opts: IdentifyOptions, gates_present: readonly string[], marker: string | undefined, index: TreeIndex,
): (ScreenFile & { ancestor?: ScreenId }) | undefined {
  if (gates_present.length === 0) return undefined;
  const remembered = opts.covered_screen;
  if (typeof remembered !== 'string' || remembered === '' || remembered === UNKNOWN_SCREEN) return undefined;
  const screen = map.screens.get(remembered);
  if (screen === undefined || screen.meta?.status === 'retired') return undefined;
  // the remembered screen's OWN marker is still in the tree: nothing is occluded, and rule 2 is
  // about to answer it from evidence. A memory may only speak where the evidence has gone.
  if (index.ids.has(markerOfScreen(remembered))) return undefined;
  const markerScreen = marker !== undefined ? (map.markers.get(marker) ?? screenIdOfMarker(marker)) : undefined;
  if (markerScreen === remembered) return undefined; // the marker survived; it is better evidence
  // THE DISCRIMINATOR. "A gate is up and the marker names a different screen" happens two ways,
  // and only one of them is occlusion:
  //   - a modal over `team_detail` hides its marker, leaving the ancestor `teams` — the gate
  //     belongs to the dialog, and `teams` knows nothing about it;
  //   - the app NAVIGATED to `login`, which raises `gate.biometric_prompt` on entry — the marker
  //     names where we actually are, and the screen itself says that gate is its own.
  // A screen's `gates` list is exactly "gates observed on entry to this screen" (02 §4.2), so when
  // the marker-named screen claims a gate that is present, the marker is the better witness and
  // the memory must stand down. Without this the covered rule masks every navigation to a
  // gate-raising screen — reporting the screen we came from for as long as the gate is up.
  const markerFile = markerScreen !== undefined ? map.screens.get(markerScreen) : undefined;
  if (markerFile !== undefined && (markerFile.gates ?? []).some((g) => gates_present.includes(g))) return undefined;
  // The stronger form of the same question, when the caller can answer it. A screen's `gates` list
  // is LEARNED (02 §4.2), so it is silent about a screen that has not met this gate yet — and the
  // two situations produce byte-identical trees, so nothing in this capture alone can separate
  // them. What can: 01 R3 leaves a covered screen's marker behind, so under a modal the surviving
  // ancestor was already on screen a moment ago, while a marker appearing for the first time
  // TOGETHER with the gate is a navigation and the tree is the better witness.
  if (opts.previous_markers !== undefined && marker !== undefined && !opts.previous_markers.has(marker)) return undefined;
  return markerScreen !== undefined && map.screens.has(markerScreen) ? { ...screen, ancestor: markerScreen } : screen;
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
