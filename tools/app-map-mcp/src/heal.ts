/**
 * [C2] Healing (04 §7). Triggered by a `miss` or `degraded` resolution during any replay.
 *
 * 7.1 scoring — for every node in the current scrubbed tree with a compatible role (equal role,
 * or `button`↔`link`↔`tab`, `field`↔`secureField`↔`searchField`, `list`↔`scrollView`):
 *   score = 0.35·role_eq + 0.30·jaroWinkler(labelNorm(node), fingerprint.label_norm)
 *         + 0.15·lcs(rolePath(node), rolePath of stored `path` locator) / max(len)
 *         + 0.10·(1 − min(1, dist(centre(node), centre(fingerprint.bbox_norm)) / 0.5))
 *         + 0.10·(parent_role equal && sibling_index equal ? 1 : parent_role equal ? 0.5 : 0)
 *   Missing fingerprint fields contribute 0 for their feature.
 *
 * 7.2 acceptance — ALL of: score ≥ 0.75 and runner-up ≤ score − 0.10; if `intent_critical`,
 *   `labelNorm(node)` === stored `label_norm` exactly (invariant 6); the step's `expect` holds
 *   after acting on the candidate. The postcondition check is asynchronous by nature, so the
 *   API is split in three pure-ish stages that the runners sequence:
 *
 *   1. `proposeHeal(input)`            pure: score + static rules → `candidate` or a rejection reason;
 *   2. the runner acts on the candidate (guided: hands `candidate.proposed_locator` out as the
 *      step target and stores `toPendingHeal(...)` on `RunRecord.pending_heal`; headless:
 *      re-exports the flow from step k with the candidate and reruns);
 *   3. `applyHeal(ctx, pending|input, candidate)` once `expect` held → writes `updated_element`
 *      (new `a11y_id` locator at rank 0 when the node has an id, else the winning strategy —
 *      `role_label` from the node's label; never `text`/`geometry` alone on `intent_critical`,
 *      04 §7.3 — promoted to rank 0; fingerprint refreshed; `status: healed_pending_review`),
 *      `db.putElement` (screen dirty, reason `heal`), bumps the element `heals` counter and logs
 *      the `heal` event; or `rejectHeal(ctx, pending|input, reason, candidates)` which logs the
 *      rejected `heal` event (`postcondition_failed`, `low_score`, `ambiguous`,
 *      `intent_critical_label_changed`, `no_candidates`; a step without `expect` → `no_expect`,
 *      never heals).
 *
 *   `heal()` is the one-call convenience for headless mode (propose → `verify` → apply/reject).
 *   Guided mode cannot use it: the postcondition is only observable on the NEXT `report_step`
 *   call, possibly in a new process (state lives in the db, architecture §2.2).
 *
 * Layer: session (imports context, types, tree, signature, resolve, events).
 */
import type { AppMapContext } from './context.ts';
import type { AnyTree, BBoxNorm, ElementDef, Fingerprint, HealCandidate, HealInput, HealReason, HealRecord, HealResult, Locator, LocatorStrategy, PendingHeal, Role, ScreenId, TreeNode } from './types.ts';
import { DEFAULT_LOCATOR_WEIGHTS, HEAL_ACCEPT_SCORE, HEAL_RUNNER_UP_MARGIN, HEAL_WEIGHTS, REDACTED, now } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { centerOf, labelOf, parentOf, pathOf, rolePath, screenRoot, siblingIndex, walk } from './tree.ts';
import { labelNorm } from './signature.ts';

/** roles considered interchangeable for candidate selection */
export const COMPATIBLE_ROLES: ReadonlyArray<ReadonlySet<Role>> = [
  new Set<Role>(['button', 'link', 'tab']),
  new Set<Role>(['field', 'secureField', 'searchField']),
  new Set<Role>(['list', 'scrollView']),
];

/** top-3 candidates travel with every rejection (04 §7.2 "fallback … with the top-3 candidates listed") */
const CANDIDATES_MAX = 3;
/** 04 §7.1 bbox feature: the distance at which proximity reaches 0 */
const BBOX_ZERO_DISTANCE = 0.5;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** 04 §7.1 "compatible role": equal, or inside one of the `COMPATIBLE_ROLES` groups. */
function compatibleRole(target: Role, role: Role): boolean {
  if (target === role) return true;
  return COMPATIBLE_ROLES.some((set) => set.has(target) && set.has(role));
}

/** a usable (non-redacted) label for locator/scoring purposes */
function usableLabel(node: TreeNode): string | undefined {
  const label = labelOf(node);
  if (typeof label !== 'string' || label === '' || label === REDACTED) return undefined;
  return label;
}

function usableId(node: TreeNode): string | undefined {
  const id = node.a11y_id;
  if (typeof id !== 'string' || id === '' || id === REDACTED) return undefined;
  return id;
}

function safePath(tree: HealInput['tree'], node: TreeNode): string {
  try {
    return pathOf(tree, node);
  } catch {
    return '';
  }
}

/** `navigationBar/button[1]` → the role sequence the LCS feature compares against `rolePath(node)`. */
function storedRolePath(tree: HealInput['tree'], element: ElementDef): Role[] {
  const locator = (element.locators ?? []).find((l) => l && l.strategy === 'path');
  if (locator === undefined || typeof locator.value !== 'string' || locator.value === '') return [];
  let rootRole: Role | undefined;
  try {
    rootRole = screenRoot(tree).role;
  } catch {
    rootRole = undefined;
  }
  // `pathOf` (what the stored locator holds) is exclusive of the screen root while `rolePath`
  // (what the live node gives) is inclusive — prepend the screen root's role to align them
  const segments = locator.value.split('/').map((s) => s.replace(/\[\d+\]$/, '') as Role);
  return rootRole === undefined ? segments : [rootRole, ...segments];
}

function centreOfBox(b: BBoxNorm): { x: number; y: number } {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

/**
 * 04 §7.3: never a `text`/`geometry` strategy alone on an `intent_critical` element. The cascade
 * is `a11y_id` → `role_label` → `path` (→ `text`/`geometry` only when not intent_critical).
 */
function proposeLocator(tree: HealInput['tree'], node: TreeNode, path: string, intentCritical: boolean): Locator {
  const id = usableId(node);
  if (id !== undefined) return { strategy: 'a11y_id', value: id, weight: DEFAULT_LOCATOR_WEIGHTS.a11y_id };
  const label = usableLabel(node);
  if (label !== undefined) return { strategy: 'role_label', value: { role: node.role, label }, weight: DEFAULT_LOCATOR_WEIGHTS.role_label };
  if (path !== '') return { strategy: 'path', value: path, weight: DEFAULT_LOCATOR_WEIGHTS.path };
  if (intentCritical) {
    // nothing addressable that is allowed on an intent_critical element: a path of '' is the
    // screen root, which never heals anything — keep it, the acceptance rules reject it anyway
    return { strategy: 'path', value: path, weight: DEFAULT_LOCATOR_WEIGHTS.path };
  }
  const c = centerOf(node);
  return { strategy: 'geometry', value: { x: c.x, y: c.y }, weight: DEFAULT_LOCATOR_WEIGHTS.geometry };
}

/** 02 §5.3 fingerprint of a live node (refreshed on every accepted heal). */
function fingerprintOf(tree: HealInput['tree'], node: TreeNode): Fingerprint {
  const parent = parentOf(tree, node);
  const label = usableLabel(node);
  const fp: Fingerprint = { role: node.role };
  if (label !== undefined) fp.label_norm = labelNorm(label);
  if (parent !== undefined) fp.parent_role = parent.role;
  fp.sibling_index = siblingIndex(tree, node);
  if (node.bbox_norm !== undefined) fp.bbox_norm = { ...node.bbox_norm };
  return fp;
}

/** Pure: 7.1 — candidates sorted by score desc (ties by pre-order position). */
export function scoreCandidates(input: HealInput): HealCandidate[] {
  if (!input || typeof input !== 'object') return [];
  const { element, tree } = input;
  if (!element || typeof element !== 'object' || !tree || typeof tree !== 'object' || !tree.root) return [];
  const fp = element.fingerprint;
  const targetRole: Role = fp?.role ?? element.role;
  const stored = storedRolePath(tree, element);
  const intentCritical = input.intent_critical === true;
  const scored: Array<{ order: number; candidate: HealCandidate }> = [];
  let order = 0;
  // 04 §7.1 / issue #24. Two bounds on WHERE a replacement may be found, both structural:
  //  - `candidateRoot` narrows the walk (default `tree.root`, so nothing else changes). For a gate
  //    control the caller passes the dialog's own subtree, mirroring the scoping `resolve` already
  //    does — a confirm button is never replaced by something outside its dialog.
  //  - `forbiddenNodes` removes, at ANY score, the nodes that currently resolve to another control
  //    of the same gate. Without it "heal Cancel into Delete" is merely improbable rather than
  //    impossible: two buttons in one alert share role, role path and parent role and sit close
  //    together, so the scoring alone lands near the 0.75 acceptance line. A destructive commit is
  //    not a thing to leave to arithmetic.
  const searchRoot = input.candidateRoot ?? tree.root;
  const forbidden = input.forbiddenNodes;
  walk({ ...tree, root: searchRoot } as AnyTree, (node) => {
    const position = order++;
    if (forbidden?.has(node) === true) return undefined;
    if (!compatibleRole(targetRole, node.role)) return undefined;
    // 7.1 role equality (0.35) — a merely *compatible* role scores 0 on this feature
    const roleFeature = node.role === targetRole ? 1 : 0;
    // 7.1 label_norm similarity (0.30); a missing stored label_norm contributes 0
    const labelFeature = fp?.label_norm === undefined ? 0 : jaroWinkler(labelNorm(usableLabel(node) ?? ''), fp.label_norm);
    // 7.1 path similarity (0.15) as LCS over the role path ÷ the longer of the two
    let pathFeature = 0;
    if (stored.length > 0) {
      let live: Role[] = [];
      try {
        live = rolePath(tree, node);
      } catch {
        live = [];
      }
      const longest = Math.max(live.length, stored.length);
      if (longest > 0) pathFeature = lcsLength(live, stored) / longest;
    }
    // 7.1 bbox proximity (0.10)
    const bboxFeature = fp?.bbox_norm === undefined || node.bbox_norm === undefined
      ? 0
      : bboxProximity(centerOf(node), centreOfBox(fp.bbox_norm));
    // 7.1 parent role + sibling index (0.10)
    let parentSiblingFeature = 0;
    if (fp?.parent_role !== undefined && parentOf(tree, node)?.role === fp.parent_role) {
      parentSiblingFeature = fp.sibling_index !== undefined && siblingIndex(tree, node) === fp.sibling_index ? 1 : 0.5;
    }
    const features = {
      role: round4(roleFeature), label: round4(labelFeature), path: round4(pathFeature),
      bbox: round4(bboxFeature), parent_sibling: round4(parentSiblingFeature),
    };
    const score = round4(
      HEAL_WEIGHTS.role * roleFeature + HEAL_WEIGHTS.label * labelFeature + HEAL_WEIGHTS.path * pathFeature
      + HEAL_WEIGHTS.bbox * bboxFeature + HEAL_WEIGHTS.parent_sibling * parentSiblingFeature,
    );
    const path = safePath(tree, node);
    const id = usableId(node);
    const label = usableLabel(node);
    const candidate: HealCandidate = {
      node, path, role: node.role, ...(label !== undefined ? { label } : {}), ...(id !== undefined ? { a11y_id: id } : {}),
      score, features, proposed_locator: proposeLocator(tree, node, path, intentCritical),
    };
    scored.push({ order: position, candidate });
    return undefined;
  });
  scored.sort((a, b) => (b.candidate.score - a.candidate.score) || (a.order - b.order));
  return scored.map((s) => s.candidate);
}

/** What `proposeHeal` returns: the static verdict before any postcondition. */
export interface HealProposal {
  /** present only when every static rule (score, margin, intent_critical label) passed */
  candidate?: HealCandidate;
  runner_up?: HealCandidate;
  /** `accepted` when `candidate` is set (pending the postcondition), else the rejection reason */
  reason: HealReason;
  /** top-3 by score, for the fallback payload */
  candidates: HealCandidate[];
}

/** Pure: 7.2 static checks (score, margin, intent_critical label, `no_expect`) — no postcondition yet. */
export function proposeHeal(input: HealInput): HealProposal {
  const candidates = scoreCandidates(input).slice(0, CANDIDATES_MAX);
  const top = candidates[0];
  const runnerUp = candidates[1];
  const withRunner = (reason: HealReason): HealProposal =>
    ({ reason, candidates, ...(runnerUp !== undefined ? { runner_up: runnerUp } : {}) });
  // 04 §7.3: "never accepts a heal without a postcondition" — checked before anything else, so a
  // step without `expect` never even looks like a heal
  if (input?.step?.expect === undefined) return withRunner('no_expect');
  if (top === undefined) return { reason: 'no_candidates', candidates: [] };
  // 04 §7.2 rule 2 / invariant 6 — reported ahead of the score so the LLM is told the *reason*
  // it must confirm with the user (04 §7.2 "an intent_critical rejection additionally sets …")
  if (input.intent_critical === true) {
    const stored = input.element.fingerprint?.label_norm;
    if (stored === undefined || labelNorm(top.label ?? '') !== stored) return withRunner('intent_critical_label_changed');
  }
  // 04 §7.2 rule 1
  if (top.score < HEAL_ACCEPT_SCORE) return withRunner('low_score');
  if (runnerUp !== undefined && top.score - runnerUp.score < HEAL_RUNNER_UP_MARGIN) return withRunner('ambiguous');
  return { candidate: top, ...(runnerUp !== undefined ? { runner_up: runnerUp } : {}), reason: 'accepted', candidates };
}

/** the locator a heal replaces: the element's rank-0 locator, else what the trigger tried */
function oldLocatorOf(input: Pick<HealInput, 'element' | 'trigger'>): { strategy: LocatorStrategy; locator?: Locator } {
  const first = (input.element.locators ?? [])[0];
  if (first !== undefined) return { strategy: first.strategy, locator: first };
  const trigger = input.trigger;
  if (trigger !== undefined && trigger.status === 'hit') return { strategy: trigger.strategy };
  const tried = trigger !== undefined && trigger.status === 'miss' ? trigger.tried[0] : undefined;
  return { strategy: tried?.strategy ?? 'a11y_id' };
}

/** Pure: serializable pending record for `RunRecord.pending_heal` (drops the `node`, keeps its fingerprint). */
export function toPendingHeal(input: HealInput, proposal: HealProposal & { candidate: HealCandidate }, scoredOnSeq: number): PendingHeal {
  const { node, ...rest } = proposal.candidate;
  const old = oldLocatorOf(input);
  return {
    step: input.step.id,
    screen: input.screen,
    element: input.element.id,
    intent_critical: input.intent_critical === true,
    old_strategy: old.strategy,
    ...(old.locator !== undefined ? { old_locator: old.locator } : {}),
    candidate: { ...rest, fingerprint: fingerprintOf(input.tree, node) },
    ...(proposal.runner_up !== undefined ? { runner_up_score: proposal.runner_up.score } : {}),
    scored_on_seq: scoredOnSeq,
    ts: now(),
  };
}

function sameLocator(a: Locator, b: Locator): boolean {
  return a.strategy === b.strategy && JSON.stringify(a.value) === JSON.stringify(b.value);
}

/** Pure: the element as it will be stored when the heal is accepted (locator promotion + fingerprint refresh). */
export function healedElement(input: Pick<HealInput, 'element' | 'intent_critical'>, candidate: PendingHeal['candidate']): NonNullable<HealResult['updated_element']> {
  const element = input.element;
  const promoted = candidate.proposed_locator;
  // 04 §7.2 "new a11y_id if the candidate has one, else the winning strategy promoted": the
  // replaced strategy never survives at a lower rank (a stale id would only ever miss)
  const rest = (element.locators ?? []).filter((l) => l !== undefined && l.strategy !== promoted.strategy && !sameLocator(l, promoted));
  const updated: ElementDef = {
    ...element,
    locators: [promoted, ...rest],
    fingerprint: candidate.fingerprint,
    status: 'healed_pending_review',
  };
  // the label the new locator addresses is the element's label from now on (never on a dynamic
  // element, which has no static copy to keep — 02 §4.1)
  if (element.label !== undefined && candidate.label !== undefined) updated.label = candidate.label;
  return updated;
}

/** the element as the session knows it (the cache first: earlier heals and `name_screen` land there) */
function elementOf(ctx: AppMapContext, screen: ScreenId, id: string): ElementDef {
  const file = ctx.db.getScreen(screen) ?? ctx.map.screens.get(screen) ?? ctx.map.gates.get(screen);
  const def = file?.elements.find((e) => e.id === id);
  if (def === undefined) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `element ${id} is not declared on ${screen}`, 'reload the map (the pending heal refers to an element that no longer exists)');
  }
  return def;
}

interface HealTarget {
  recipe: string;
  step: string;
  screen: ScreenId;
  element: ElementDef;
  intent_critical: boolean;
  build: string;
  old_strategy: LocatorStrategy;
  old_locator?: Locator;
  run_id?: string;
}

function targetOf(ctx: AppMapContext, source: { input: HealInput } | { pending: PendingHeal; recipe: string }, opts: { run_id?: string }): HealTarget {
  if ('pending' in source) {
    const p = source.pending;
    return {
      recipe: source.recipe, step: p.step, screen: p.screen, element: elementOf(ctx, p.screen, p.element),
      intent_critical: p.intent_critical === true, build: ctx.build, old_strategy: p.old_strategy,
      ...(p.old_locator !== undefined ? { old_locator: p.old_locator } : {}),
      ...(opts.run_id !== undefined ? { run_id: opts.run_id } : {}),
    };
  }
  const input = source.input;
  const old = oldLocatorOf(input);
  const runId = opts.run_id ?? input.run_id;
  return {
    recipe: input.recipe, step: input.step.id, screen: input.screen, element: input.element,
    intent_critical: input.intent_critical === true, build: input.build ?? ctx.build, old_strategy: old.strategy,
    ...(old.locator !== undefined ? { old_locator: old.locator } : {}),
    ...(runId !== undefined ? { run_id: runId } : {}),
  };
}

/**
 * Stage 3 (accept): the postcondition held. Writes the healed element to the cache
 * (`db.putElement(screen, updated, {reason: 'heal'})` → screen dirty, so `export` produces the
 * PR diff), bumps counters, appends the `heal` event (`accepted: true`) and returns the
 * `HealResult`. Accepts either a live `HealInput` + candidate (headless) or a persisted
 * `PendingHeal` (guided).
 */
export function applyHeal(ctx: AppMapContext, source: { input: HealInput; candidate: HealCandidate; runner_up?: HealCandidate } | { pending: PendingHeal; recipe: string }, opts: { run_id?: string } = {}): HealResult {
  const target = targetOf(ctx, 'pending' in source ? { pending: source.pending, recipe: source.recipe } : { input: source.input }, opts);
  const stored: PendingHeal['candidate'] = 'pending' in source
    ? source.pending.candidate
    : (() => { const { node, ...rest } = source.candidate; return { ...rest, fingerprint: fingerprintOf(source.input.tree, node) }; })();
  const runnerUpScore = 'pending' in source ? source.pending.runner_up_score : source.runner_up?.score;
  const updated = healedElement({ element: target.element, intent_critical: target.intent_critical }, stored);

  // 04 §7.2: the cache is the only writer — YAML changes travel through `app-map export` (7.3)
  ctx.db.putElement(target.screen, updated, { reason: 'heal' });
  ctx.db.bumpCounter('element', updated.id, 'heals');

  const record: HealRecord = {
    recipe: target.recipe, step: target.step, element: updated.id, old_strategy: target.old_strategy,
    new_strategy: stored.proposed_locator.strategy,
    ...(target.old_locator !== undefined ? { old_locator: target.old_locator } : {}),
    new_locator: stored.proposed_locator, score: stored.score,
    ...(runnerUpScore !== undefined ? { runner_up_score: runnerUpScore } : {}),
    accepted: true, reason: 'accepted', intent_critical: target.intent_critical, build: target.build,
  };
  // 08 §2 `heal`: old locator, new locator, score and step
  ctx.events.append({
    kind: 'heal', recipe: record.recipe, step: record.step, element: record.element,
    old_strategy: record.old_strategy, new_strategy: record.new_strategy, score: record.score,
    accepted: true, reason: 'accepted', build: record.build, intent_critical: record.intent_critical,
    ...(target.run_id !== undefined ? { run_id: target.run_id } : {}),
  });
  ctx.log.info('heal accepted', { element: record.element, step: record.step, score: record.score, new_strategy: record.new_strategy });
  return {
    accepted: true, reason: 'accepted', record,
    ...('pending' in source ? {} : { candidate: source.candidate }),
    candidates: [], updated_element: updated,
  };
}

/**
 * Stage 3 (reject): logs the rejected `heal` event (`accepted: false`, `reason`), bumps the
 * element `misses` counter and returns a `HealResult` whose `candidates` (≤3) feed the fallback
 * payload. `intent_critical_label_changed` additionally makes the guided fallback reason the
 * same string so the LLM confirms with the user (04 §7.2).
 */
export function rejectHeal(ctx: AppMapContext, source: { input: HealInput } | { pending: PendingHeal; recipe: string }, reason: Exclude<HealReason, 'accepted'>, candidates: HealCandidate[], opts: { run_id?: string; runner_up_score?: number } = {}): HealResult {
  const target = targetOf(ctx, source, opts);
  const top = Array.isArray(candidates) ? candidates[0] : undefined;
  const pendingCandidate = 'pending' in source ? source.pending.candidate : undefined;
  const runnerUpScore = opts.runner_up_score ?? ('pending' in source ? source.pending.runner_up_score : candidates?.[1]?.score);
  const record: HealRecord = {
    recipe: target.recipe, step: target.step, element: target.element.id, old_strategy: target.old_strategy,
    ...(target.old_locator !== undefined ? { old_locator: target.old_locator } : {}),
    score: top?.score ?? pendingCandidate?.score ?? 0,
    ...(runnerUpScore !== undefined ? { runner_up_score: runnerUpScore } : {}),
    accepted: false, reason, intent_critical: target.intent_critical, build: target.build,
  };
  ctx.db.bumpCounter('element', record.element, 'misses');
  ctx.events.append({
    kind: 'heal', recipe: record.recipe, step: record.step, element: record.element,
    old_strategy: record.old_strategy, score: record.score, accepted: false, reason,
    build: record.build, intent_critical: record.intent_critical,
    ...(target.run_id !== undefined ? { run_id: target.run_id } : {}),
  });
  ctx.log.info('heal rejected', { element: record.element, step: record.step, reason, score: record.score });
  return { accepted: false, reason, record, candidates: (candidates ?? []).slice(0, CANDIDATES_MAX) };
}

/**
 * Headless convenience: `proposeHeal` → `verify(candidate)` (re-export from step k and rerun,
 * 04 §6.1) → `applyHeal` | `rejectHeal(postcondition_failed)`. Not used by guided.ts.
 */
export async function heal(ctx: AppMapContext, input: HealInput, verify: (candidate: HealCandidate) => Promise<boolean>): Promise<HealResult> {
  const proposal = proposeHeal(input);
  if (proposal.candidate === undefined) {
    return rejectHeal(ctx, { input }, proposal.reason as Exclude<HealReason, 'accepted'>, proposal.candidates, {
      ...(proposal.runner_up !== undefined ? { runner_up_score: proposal.runner_up.score } : {}),
    });
  }
  let held = false;
  try {
    held = await verify(proposal.candidate) === true;
  } catch (e) {
    // a driver/Maestro failure during verification is a failed postcondition, never a crash (03 §11)
    ctx.log.warn('heal: postcondition check failed', { element: input.element.id, error: (e as Error).message });
    held = false;
  }
  if (!held) {
    return rejectHeal(ctx, { input }, 'postcondition_failed', proposal.candidates, {
      ...(proposal.runner_up !== undefined ? { runner_up_score: proposal.runner_up.score } : {}),
    });
  }
  return applyHeal(ctx, { input, candidate: proposal.candidate, ...(proposal.runner_up !== undefined ? { runner_up: proposal.runner_up } : {}) });
}

/** Jaro-Winkler similarity in [0,1]; pure. */
export function jaroWinkler(a: string, b: string): number {
  const s1 = typeof a === 'string' ? a : '';
  const s2 = typeof b === 'string' ? b : '';
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1);
  const m1 = new Array<boolean>(s1.length).fill(false);
  const m2 = new Array<boolean>(s2.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s1.length; i++) {
    const from = Math.max(0, i - window);
    const to = Math.min(i + window + 1, s2.length);
    for (let j = from; j < to; j++) {
      if (m2[j] || s1[i] !== s2[j]) continue;
      m1[i] = true;
      m2[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (!m1[i]) continue;
    while (!m2[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  const t = transpositions / 2;
  const jaro = (matches / s1.length + matches / s2.length + (matches - t) / matches) / 3;
  // Winkler: up to 4 shared leading characters, scale 0.1
  let prefix = 0;
  while (prefix < 4 && prefix < s1.length && prefix < s2.length && s1[prefix] === s2[prefix]) prefix++;
  return round4(jaro + prefix * 0.1 * (1 - jaro));
}

/** LCS length of two sequences; pure. */
export function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  let previous = new Array<number>(b.length + 1).fill(0);
  let current = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!);
    }
    const swap = previous;
    previous = current;
    current = swap;
    current.fill(0);
  }
  return previous[b.length] ?? 0;
}

/** 1 − min(1, euclidean distance / 0.5) between normalized centres; pure. */
export function bboxProximity(a: { x: number; y: number }, b: { x: number; y: number }): number {
  if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return 0;
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  return round4(1 - Math.min(1, distance / BBOX_ZERO_DISTANCE));
}
