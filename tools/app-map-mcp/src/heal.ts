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
import type { HealCandidate, HealInput, HealReason, HealResult, PendingHeal, Role } from './types.ts';
import { NotImplementedError } from './errors.ts';

/** roles considered interchangeable for candidate selection */
export const COMPATIBLE_ROLES: ReadonlyArray<ReadonlySet<Role>> = [
  new Set<Role>(['button', 'link', 'tab']),
  new Set<Role>(['field', 'secureField', 'searchField']),
  new Set<Role>(['list', 'scrollView']),
];

/** Pure: 7.1 — candidates sorted by score desc (ties by pre-order position). */
export function scoreCandidates(input: HealInput): HealCandidate[] {
  void input;
  throw new NotImplementedError('heal.scoreCandidates');
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
  void input;
  throw new NotImplementedError('heal.proposeHeal');
}

/** Pure: serializable pending record for `RunRecord.pending_heal` (drops the `node`, keeps its fingerprint). */
export function toPendingHeal(input: HealInput, proposal: HealProposal & { candidate: HealCandidate }, scoredOnSeq: number): PendingHeal {
  void input; void proposal; void scoredOnSeq;
  throw new NotImplementedError('heal.toPendingHeal');
}

/** Pure: the element as it will be stored when the heal is accepted (locator promotion + fingerprint refresh). */
export function healedElement(input: Pick<HealInput, 'element' | 'intent_critical'>, candidate: PendingHeal['candidate']): NonNullable<HealResult['updated_element']> {
  void input; void candidate;
  throw new NotImplementedError('heal.healedElement');
}

/**
 * Stage 3 (accept): the postcondition held. Writes the healed element to the cache
 * (`db.putElement(screen, updated, {reason: 'heal'})` → screen dirty, so `export` produces the
 * PR diff), bumps counters, appends the `heal` event (`accepted: true`) and returns the
 * `HealResult`. Accepts either a live `HealInput` + candidate (headless) or a persisted
 * `PendingHeal` (guided).
 */
export function applyHeal(ctx: AppMapContext, source: { input: HealInput; candidate: HealCandidate; runner_up?: HealCandidate } | { pending: PendingHeal; recipe: string }, opts: { run_id?: string } = {}): HealResult {
  void ctx; void source; void opts;
  throw new NotImplementedError('heal.applyHeal');
}

/**
 * Stage 3 (reject): logs the rejected `heal` event (`accepted: false`, `reason`), bumps the
 * element `misses` counter and returns a `HealResult` whose `candidates` (≤3) feed the fallback
 * payload. `intent_critical_label_changed` additionally makes the guided fallback reason the
 * same string so the LLM confirms with the user (04 §7.2).
 */
export function rejectHeal(ctx: AppMapContext, source: { input: HealInput } | { pending: PendingHeal; recipe: string }, reason: Exclude<HealReason, 'accepted'>, candidates: HealCandidate[], opts: { run_id?: string; runner_up_score?: number } = {}): HealResult {
  void ctx; void source; void reason; void candidates; void opts;
  throw new NotImplementedError('heal.rejectHeal');
}

/**
 * Headless convenience: `proposeHeal` → `verify(candidate)` (re-export from step k and rerun,
 * 04 §6.1) → `applyHeal` | `rejectHeal(postcondition_failed)`. Not used by guided.ts.
 */
export function heal(ctx: AppMapContext, input: HealInput, verify: (candidate: HealCandidate) => Promise<boolean>): Promise<HealResult> {
  void ctx; void input; void verify;
  throw new NotImplementedError('heal.heal');
}

/** Jaro-Winkler similarity in [0,1]; pure. */
export function jaroWinkler(a: string, b: string): number {
  void a; void b;
  throw new NotImplementedError('heal.jaroWinkler');
}

/** LCS length of two sequences; pure. */
export function lcsLength<T>(a: readonly T[], b: readonly T[]): number {
  void a; void b;
  throw new NotImplementedError('heal.lcsLength');
}

/** 1 − min(1, euclidean distance / 0.5) between normalized centres; pure. */
export function bboxProximity(a: { x: number; y: number }, b: { x: number; y: number }): number {
  void a; void b;
  throw new NotImplementedError('heal.bboxProximity');
}
