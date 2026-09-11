/**
 * [B1] Screen signatures (02 §4.1, 02 §4.2, 02 §4.4, 02 §5.3).
 *
 * `structuralHash(tree, dynamicRegions)`: sha1 over the sorted multiset of `"<role>\t<a11y_id>"`
 * for every node that has an id, excluding descendants of any node whose id is in
 * `dynamicRegions` (the region node itself IS included), joined with `\n`, hex, prefixed
 * `sha1:`. Text is never hashed; duplicates are kept. The pilot files were generated with
 * exactly this rule — `structuralHash(fixtures/trees/invoice_list.normalized.json,
 * ['invoice.list.table'])` must equal `sha1:262365d418093134bfe9b089192ab10fe3575007`.
 *
 * `labelNorm(s)`: NFKC → lowercase → remove apostrophes (`'’‘\``) → replace every run of
 * non-`[a-z0-9]` with one space → trim. `"Don’t Allow"` → `"dont allow"`, `"New Invoice"` →
 * `"new invoice"`.
 *
 * Layer: tree (imports types + tree). Pure.
 */
import type { AnyTree, ObservedSignature, RoleLabelValue, ScreenFile, TreeNode } from './types.ts';
import { NotImplementedError } from './errors.ts';

export function labelNorm(s: string): string {
  void s;
  throw new NotImplementedError('signature.labelNorm');
}

export function structuralHash(tree: AnyTree, dynamicRegions: readonly string[] = []): string {
  void tree; void dynamicRegions;
  throw new NotImplementedError('signature.structuralHash');
}

/** Fraction of `requiredIds` present as `a11y_id` anywhere in the tree (03 §5.4, 06 R4). 1 when the list is empty. */
export function requiredIdsFraction(tree: AnyTree, requiredIds: readonly string[]): { fraction: number; missing: string[] } {
  void tree; void requiredIds;
  throw new NotImplementedError('signature.requiredIdsFraction');
}

/**
 * Does `node` satisfy a `{role, label | label_regex}` value? Role must equal; `label` is exact
 * (after trimming); `label_regex` is `new RegExp(source)` (no flags) tested against `labelOf(node)`.
 */
export function roleLabelMatches(node: TreeNode, value: RoleLabelValue): boolean {
  void node; void value;
  throw new NotImplementedError('signature.roleLabelMatches');
}

/**
 * Gate signature test (02 §4.2, 03 §5.1): true when the gate's `signature.marker` (if not
 * `none`) is present, and EVERY entry of `signature.required_labels` matches at least one node.
 */
export function gateSignatureMatches(tree: AnyTree, gate: ScreenFile): boolean {
  void tree; void gate;
  throw new NotImplementedError('signature.gateSignatureMatches');
}

/** Nav title candidate: label of the first `navigationBar`, else its first `staticText` child (03 §5.6). */
export function titleOf(tree: AnyTree): string | undefined {
  void tree;
  throw new NotImplementedError('signature.titleOf');
}

/**
 * The signature stored on observations (02 §7): marker (`none` when not exactly one), hash with
 * `screen.dynamic_regions` (empty when `screen` unknown) and the required_ids fraction.
 */
export function observedSignature(tree: AnyTree, screen?: ScreenFile): ObservedSignature {
  void tree; void screen;
  throw new NotImplementedError('signature.observedSignature');
}
