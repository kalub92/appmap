/**
 * [B1] Scrubber (03 §7, 07 §2.3). Applied to every tree before it is stored, hashed or returned
 * to the LLM; the scrubbed tree is the only form that exists past the ingest boundary.
 *
 * `scrub(tree, policy)` returns a new `ScrubbedTree` (input untouched):
 *  1. drop `value` and `text` unconditionally;
 *  2. under any node whose id is in `policy.dynamicIds`, drop every `label` (the region node
 *     itself keeps nothing but role/id/bbox/flags either);
 *  3. keep `label` only if (a) the node's id is in `policy.staticIds` (registered, `dynamic:
 *     false`), or (a') the id has a `labelRegexById` entry that matches, or (b) the role is in
 *     `STATIC_LABEL_ROLES` and the label exactly equals an entry of `policy.staticLabels`;
 *     otherwise drop it. Gate dialogs work because their button labels are in the static table.
 *  4. apply `policy.piiPatterns` to every surviving string (`label`, `a11y_id` is exempt);
 *     any hit → the string becomes `[redacted]` and `scrub_hits` increments (07 §2.3.4);
 *  5. keep `role`, `a11y_id`, `bbox_norm`, `enabled`, `focused`, `selected`, `children`;
 *     set `scrubbed: true`, `scrub_hits`.
 *
 * Layer: tree (imports types only). Pure.
 */
import type { IdsRegistry, ScrubPolicy, ScrubbedTree, Tree } from './types.ts';
import { NotImplementedError } from './errors.ts';

/**
 * 07 §2.3.4 deny list. Order matters only for reporting. Each pattern is tested with `.test`
 * against the whole string (no `g` flag — keep them stateless).
 */
export const PII_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\+?\d[\d\s().-]{8,}\d/, // E.164 / US phone (10+ digits with separators)
  /\d(?:[ -]?\d){12,18}/, // 13–19 digit runs (cards)
  /[$€£]\s?\d/, // currency
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/, // IBAN-like
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-like
];

/**
 * Build the policy from the registry and the static string table (`.local/strings.<platform>.txt`
 * ∪ labels/titles declared in screen files, i.e. `LoadedMap.staticLabels`).
 */
export function buildScrubPolicy(ids: IdsRegistry, staticLabels: ReadonlySet<string>, opts: { piiPatterns?: readonly RegExp[] } = {}): ScrubPolicy {
  void ids; void staticLabels; void opts;
  throw new NotImplementedError('scrub.buildScrubPolicy');
}

export function scrub(tree: Tree, policy: ScrubPolicy): ScrubbedTree {
  void tree; void policy;
  throw new NotImplementedError('scrub.scrub');
}

/** `[redacted]` when any pattern hits; pure. */
export function redactString(s: string, patterns: readonly RegExp[] = PII_PATTERNS): { value: string; hit: boolean } {
  void s; void patterns;
  throw new NotImplementedError('scrub.redactString');
}

/** Every substring of `text` that a pattern matches, with the pattern index — validate rule 8 (02 §10.8). */
export function findForbiddenContent(text: string, patterns: readonly RegExp[] = PII_PATTERNS): Array<{ match: string; pattern: number }> {
  void text; void patterns;
  throw new NotImplementedError('scrub.findForbiddenContent');
}

/** Bytes of `compactJson(tree)` — the `perception_bytes` contribution of one observation (08 §2). */
export function perceptionBytes(tree: ScrubbedTree): number {
  void tree;
  throw new NotImplementedError('scrub.perceptionBytes');
}
