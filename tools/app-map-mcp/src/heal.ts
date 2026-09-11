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
 *   after acting on the candidate (`verify` callback — the guided runner asks the LLM to act and
 *   checks the next observation; the headless runner re-exports and reruns).
 *   Accepted → `updated_element`: new `a11y_id` locator at rank 0 when the node has an id, else
 *   the winning strategy (`role_label` from the node's label; never `text`/`geometry` alone on
 *   `intent_critical`, 04 §7.3) promoted to rank 0; `status: healed_pending_review`; fingerprint
 *   refreshed; `db.putElement` marks the screen dirty; `heal` event logged.
 *   Rejected → reasons `low_score` | `ambiguous` | `intent_critical_label_changed` |
 *   `postcondition_failed` | `no_candidates`; a step without `expect` → `no_expect` (never heals).
 *
 * Layer: session (imports context, types, tree, signature, resolve, events).
 */
import type { AppMapContext } from './context.ts';
import type { HealCandidate, HealInput, HealResult, Role } from './types.ts';
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

/** Pure: 7.2 static checks (score, margin, intent_critical label) — no postcondition yet. */
export function proposeHeal(input: HealInput): { candidate?: HealCandidate; runner_up?: HealCandidate; reason: HealResult['reason']; candidates: HealCandidate[] } {
  void input;
  throw new NotImplementedError('heal.proposeHeal');
}

/**
 * Full heal: propose, then `verify(candidate)` for the postcondition, then apply to the cache
 * and log. `verify` resolves `true` when `expect` held after acting on the candidate.
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
