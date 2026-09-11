/**
 * [B1] Screen signatures (02 §4.1, 02 §4.2, 02 §4.4, 02 §5.3).
 *
 * `structuralHash(tree, dynamicRegions)`: sha1 over the sorted multiset of `"<role>\t<a11y_id>"`
 * for every node that has an id, excluding descendants of any node whose id is in
 * `dynamicRegions` (the region node itself IS included), joined with `\n`, hex, prefixed
 * `sha1:`. Text is never hashed; duplicates are kept; a `[redacted]` id counts as no id (it was
 * row data, see scrub.ts rule 4). The pilot files were generated with
 * exactly this rule — `structuralHash(fixtures/trees/invoice_list.normalized.json,
 * ['invoice.list.table'])` must equal `sha1:262365d418093134bfe9b089192ab10fe3575007`.
 *
 * `labelNorm(s)`: NFKC → lowercase → remove apostrophes (`'’‘\``) → replace every run of
 * non-`[a-z0-9]` with one space → trim. `"Don’t Allow"` → `"dont allow"`, `"New Invoice"` →
 * `"new invoice"`.
 *
 * Layer: tree (imports types + tree). Pure.
 */
import { createHash } from 'node:crypto';
import type { AnyTree, ObservedSignature, RoleLabelValue, ScreenFile, TreeNode } from './types.ts';
import { REDACTED } from './types.ts';
import { findMarkerNodes, labelOf, nodesWithRole, walk } from './tree.ts';

export function labelNorm(s: string): string {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** code-point order (ids are ASCII; UTF-16 unit order coincides for them) */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function structuralHash(tree: AnyTree, dynamicRegions: readonly string[] = []): string {
  const regions = new Set(dynamicRegions);
  const pairs: string[] = [];
  walk(tree, (n) => {
    const id = n.a11y_id;
    // a `[redacted]` id (07 §2.3.4) was row data, not structure: it is not "a node with an id"
    if (typeof id !== 'string' || id === '' || id === REDACTED) return undefined;
    pairs.push(`${n.role}\t${id}`);
    // 02 §4.4: nothing under a dynamic region is hashed (the region node itself is, above)
    return regions.has(id) ? false : undefined;
  });
  pairs.sort(byCodePoint);
  return `sha1:${createHash('sha1').update(pairs.join('\n'), 'utf8').digest('hex')}`;
}

/** Fraction of `requiredIds` present as `a11y_id` anywhere in the tree (03 §5.4, 06 R4). 1 when the list is empty. */
export function requiredIdsFraction(tree: AnyTree, requiredIds: readonly string[]): { fraction: number; missing: string[] } {
  const wanted = Array.from(new Set(requiredIds.filter((id) => typeof id === 'string' && id !== '')));
  if (wanted.length === 0) return { fraction: 1, missing: [] };
  const present = new Set<string>();
  walk(tree, (n) => { if (typeof n.a11y_id === 'string') present.add(n.a11y_id); });
  const missing = wanted.filter((id) => !present.has(id));
  return { fraction: (wanted.length - missing.length) / wanted.length, missing };
}

const REGEX_CACHE = new Map<string, RegExp | null>();

/** `new RegExp(source)` (no flags), cached; `null` when the source does not compile. */
function compile(source: string): RegExp | null {
  let re = REGEX_CACHE.get(source);
  if (re === undefined) {
    try {
      re = new RegExp(source);
    } catch {
      re = null;
    }
    REGEX_CACHE.set(source, re);
  }
  return re;
}

/**
 * Does `node` satisfy a `{role, label | label_regex}` value? Role must equal; `label` is exact
 * (after trimming); `label_regex` is `new RegExp(source)` (no flags) tested against `labelOf(node)`.
 * A value with neither (schema-invalid) matches on role alone; an invalid regex never matches.
 */
export function roleLabelMatches(node: TreeNode, value: RoleLabelValue): boolean {
  if (!node || !value || node.role !== value.role) return false;
  const text = labelOf(node);
  if (typeof value.label === 'string') {
    return text !== undefined && text.trim() === value.label.trim();
  }
  if (typeof value.label_regex === 'string') {
    if (text === undefined) return false;
    const re = compile(value.label_regex);
    return re !== null && re.test(text);
  }
  return true;
}

/**
 * Gate signature test (02 §4.2, 03 §5.1): true when the gate's `signature.marker` (if not
 * `none`) is present, and EVERY entry of `signature.required_labels` matches at least one node.
 * A gate with `marker: none` and no `required_labels` has no signature and never matches.
 */
export function gateSignatureMatches(tree: AnyTree, gate: ScreenFile): boolean {
  const sig = gate?.signature;
  if (!sig) return false;
  const marker = typeof sig.marker === 'string' ? sig.marker : 'none';
  const labels = Array.isArray(sig.required_labels) ? sig.required_labels : [];
  if (marker !== 'none' && marker !== '') {
    let found = false;
    walk(tree, (n) => { if (n.a11y_id === marker) { found = true; return false; } return undefined; });
    if (!found) return false;
  } else if (labels.length === 0) {
    return false;
  }
  for (const value of labels) {
    const candidates = nodesWithRole(tree, value.role);
    if (!candidates.some((n) => roleLabelMatches(n, value))) return false;
  }
  return true;
}

/** Nav title candidate: label of the first `navigationBar`, else its first `staticText` child (03 §5.6). */
export function titleOf(tree: AnyTree): string | undefined {
  const bars = nodesWithRole(tree, 'navigationBar');
  const bar = bars[0];
  if (bar === undefined) return undefined;
  if (typeof bar.label === 'string' && bar.label.trim() !== '') return bar.label;
  const direct = bar.children.find((c) => c.role === 'staticText' && typeof c.label === 'string' && c.label.trim() !== '');
  if (direct !== undefined) return direct.label;
  let deep: string | undefined;
  walk(bar, (n) => {
    if (deep !== undefined) return false;
    if (n !== bar && n.role === 'staticText' && typeof n.label === 'string' && n.label.trim() !== '') { deep = n.label; return false; }
    return undefined;
  });
  return deep;
}

/**
 * The signature stored on observations (02 §7): marker (`none` when not exactly one), hash with
 * `screen.dynamic_regions` (empty when `screen` unknown) and the required_ids fraction.
 */
export function observedSignature(tree: AnyTree, screen?: ScreenFile): ObservedSignature {
  const { nodes, count } = findMarkerNodes(tree);
  const marker = count === 1 ? nodes[0]!.a11y_id! : 'none';
  const structural_hash = structuralHash(tree, screen?.dynamic_regions ?? []);
  const required_present = screen ? requiredIdsFraction(tree, screen.signature?.required_ids ?? []).fraction : 0;
  return { marker, structural_hash, required_present };
}
