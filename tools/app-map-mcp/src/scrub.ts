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
 *  4. apply `policy.piiPatterns` to every surviving string (07 §2.3.4): every `label`, and every
 *     `a11y_id` that is NOT registered (`staticIds ∪ dynamicIds ∪ markers ∪ labelRegexById
 *     keys`) — Android resource-ids / testTags and some iOS identifiers embed row data
 *     (`cell_billing@acme.example`); registered ids can never be PII and stay intact. Any hit
 *     → the string becomes `[redacted]` and `scrub_hits` increments;
 *  5. keep `role`, `a11y_id`, `bbox_norm`, `enabled`, `focused`, `selected`, `children`;
 *     set `scrubbed: true`, `scrub_hits`.
 *
 * The tree-level `route` keeps its key (an identification signal) and loses its query string
 * when the query hits the deny list; `viewport`, `build`, `app_id` and `captured_at` are copied
 * as they are.
 *
 * Layer: tree (imports types/errors + tree.ts for `compactJson`). Pure.
 */
import type { IdsRegistry, ScrubPolicy, ScrubbedTree, Tree, TreeNode } from './types.ts';
import { REDACTED, STATIC_LABEL_ROLES, markerOfScreen } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { compactJson } from './tree.ts';

/**
 * 07 §2.3.4 deny list. Order matters only for reporting. Each pattern is tested with `.test`
 * against the whole string (no `g` flag — keep them stateless).
 */
export const PII_PATTERNS: readonly RegExp[] = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, // email
  /\+?\d[\d\s().-]{8,}\d/, // E.164 / US phone (10+ digits with separators)
  /\d(?:[ -]?\d){12,18}/, // 13–19 digit runs (cards)
  /[$€£]\s?\d[\d.,]*/, // currency — the whole amount, so redaction never leaves digits behind
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}(?:\s?[A-Z0-9]{1,4})?\b/, // IBAN-like
  /\b\d{3}-\d{2}-\d{4}\b/, // SSN-like
];

const STATIC_ROLE_SET: ReadonlySet<string> = new Set(STATIC_LABEL_ROLES);

/**
 * Build the policy from the registry and the static string table (`.local/strings.<platform>.txt`
 * ∪ labels/titles declared in screen files, i.e. `LoadedMap.staticLabels`).
 *
 * Gate dismiss controls (`ids.gates[].dismiss`, architecture.md decision 2) count as registered
 * static ids. An element with `label_regex` is in `labelRegexById` only (its label survives
 * solely through the regex, rule a'); one whose regex does not compile is treated as dynamic
 * (label dropped, id still registered — the safe direction for a privacy filter; validate rule
 * 1 reports it).
 */
export function buildScrubPolicy(ids: IdsRegistry, staticLabels: ReadonlySet<string>, opts: { piiPatterns?: readonly RegExp[] } = {}): ScrubPolicy {
  const staticIds = new Set<string>();
  const dynamicIds = new Set<string>();
  const labelRegexById = new Map<string, RegExp>();
  const markers = new Set<string>();
  const elements = Array.isArray(ids?.elements) ? ids.elements : [];
  for (const el of elements) {
    if (!el || typeof el.id !== 'string') continue;
    if (el.dynamic === true) {
      dynamicIds.add(el.id); // rule 2 wins over any label_regex
      continue;
    }
    if (typeof el.label_regex === 'string' && el.label_regex !== '') {
      // a computed label (07 §9) survives only when it matches — never via rule (a)
      try {
        labelRegexById.set(el.id, new RegExp(el.label_regex));
      } catch {
        dynamicIds.add(el.id); // invalid user regex: keep the id registered, drop its label
      }
      continue;
    }
    staticIds.add(el.id);
  }
  const gates = Array.isArray(ids?.gates) ? ids.gates : [];
  for (const g of gates) {
    if (g && typeof g.dismiss === 'string' && g.dismiss !== '') staticIds.add(g.dismiss);
  }
  const screens = Array.isArray(ids?.screens) ? ids.screens : [];
  for (const s of screens) {
    if (s && typeof s.id === 'string' && s.id !== '') markers.add(markerOfScreen(s.id));
  }
  return {
    staticIds,
    dynamicIds,
    labelRegexById,
    markers,
    staticLabels: new Set(staticLabels),
    piiPatterns: opts.piiPatterns ?? PII_PATTERNS,
  };
}

function isRegisteredId(id: string, policy: ScrubPolicy): boolean {
  return policy.staticIds.has(id) || policy.dynamicIds.has(id) || policy.markers.has(id) || policy.labelRegexById.has(id);
}

/** rule 3 — may this label survive on this node? */
function labelAllowed(node: TreeNode, label: string, policy: ScrubPolicy): boolean {
  const id = node.a11y_id;
  if (id !== undefined) {
    if (policy.staticIds.has(id)) return true; // (a)
    const re = policy.labelRegexById.get(id);
    if (re !== undefined && safeTest(re, label)) return true; // (a')
  }
  return STATIC_ROLE_SET.has(node.role) && policy.staticLabels.has(label); // (b)
}

/** `.test` with a reset `lastIndex` so a caller-supplied `g`/`y` pattern cannot go stateful. */
function safeTest(re: RegExp, s: string): boolean {
  if (re.global || re.sticky) re.lastIndex = 0;
  const hit = re.test(s);
  if (re.global || re.sticky) re.lastIndex = 0;
  return hit;
}

interface Counter { hits: number }

function scrubNode(node: TreeNode, policy: ScrubPolicy, inDynamic: boolean, counter: Counter): TreeNode {
  const id = typeof node.a11y_id === 'string' && node.a11y_id !== '' ? node.a11y_id : undefined;
  const dynamic = inDynamic || (id !== undefined && policy.dynamicIds.has(id));
  const b = node.bbox_norm ?? { x: 0, y: 0, w: 0, h: 0 };
  const out: TreeNode = { role: node.role, bbox_norm: { x: b.x, y: b.y, w: b.w, h: b.h }, children: [] };

  if (id !== undefined) {
    if (isRegisteredId(id, policy)) out.a11y_id = id;
    else {
      // rule 4 on unregistered ids (resource-ids / testTags can embed row data)
      const r = redactString(id, policy.piiPatterns);
      if (r.hit) counter.hits++;
      out.a11y_id = r.value;
    }
  }
  // rule 1: `value` and `text` are never copied. rules 2 + 3 + 4 on `label`:
  if (!dynamic && typeof node.label === 'string' && labelAllowed(node, node.label, policy)) {
    const r = redactString(node.label, policy.piiPatterns);
    if (r.hit) counter.hits++;
    out.label = r.value;
  }
  // rule 5: flags
  if (typeof node.enabled === 'boolean') out.enabled = node.enabled;
  if (typeof node.focused === 'boolean') out.focused = node.focused;
  if (typeof node.selected === 'boolean') out.selected = node.selected;
  const kids = Array.isArray(node.children) ? node.children : [];
  for (const k of kids) {
    if (k && typeof k === 'object') out.children.push(scrubNode(k, policy, dynamic, counter));
  }
  return out;
}

/** The ONLY place a `ScrubbedTree` is minted (the compile-time brand is applied by one cast here). */
export function scrub(tree: Tree, policy: ScrubPolicy): ScrubbedTree {
  if (!tree || typeof tree !== 'object' || !tree.root || typeof tree.root !== 'object') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'scrub: tree has no root node', 'normalize the snapshot with tree.normalizeTree first');
  }
  if (!policy || !policy.staticIds || !policy.dynamicIds || !policy.piiPatterns) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'scrub: invalid policy', 'build it with buildScrubPolicy(ids, staticLabels)');
  }
  const counter: Counter = { hits: 0 };
  const root = scrubNode(tree.root, policy, false, counter);
  const out: Record<string, unknown> = { schema_version: 1, platform: tree.platform, source: tree.source };
  if (tree.viewport !== undefined) out['viewport'] = { w: tree.viewport.w, h: tree.viewport.h };
  if (tree.captured_at !== undefined) out['captured_at'] = tree.captured_at;
  if (typeof tree.route === 'string') {
    // the route is an identification signal (03 §5.3): only its query can carry data, so a hit
    // there drops the query (`routeKey`) instead of the whole string
    const q = tree.route.indexOf('?');
    if (q >= 0 && redactString(tree.route.slice(q + 1), policy.piiPatterns).hit) {
      counter.hits++;
      out['route'] = tree.route.slice(0, q);
    } else {
      out['route'] = tree.route;
    }
  }
  if (tree.build !== undefined) out['build'] = tree.build;
  if (tree.app_id !== undefined) out['app_id'] = tree.app_id;
  out['root'] = root;
  out['scrubbed'] = true;
  out['scrub_hits'] = counter.hits;
  // The `[SCRUBBED]` symbol never exists at runtime (types.ts); this is the single cast that mints it.
  return out as unknown as ScrubbedTree;
}

/**
 * Every matched SUBSTRING replaced by `[redacted]`; pure.
 *
 * Only the match is replaced, not the whole string: blanking the lot destroyed the surrounding
 * structure the map actually needs — a label keeps its static copy, and the 04 §3.4 param
 * inference can still see which words were typed (`create an invoice for [redacted] for Acme
 * Corp`, not `[redacted]`). 07 §2.2's requirement is that the VALUE never reaches disk, which
 * splicing satisfies exactly as well (architecture §7 decision 13).
 */
export function redactString(s: string, patterns: readonly RegExp[] = PII_PATTERNS): { value: string; hit: boolean } {
  if (typeof s !== 'string') return { value: '', hit: false };
  const spans = forbiddenSpans(s, patterns);
  if (spans.length === 0) return { value: s, hit: false };
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    out += s.slice(cursor, start) + REDACTED;
    cursor = end;
  }
  return { value: out + s.slice(cursor), hit: true };
}

/** Merged, ordered `[start, end)` spans of `text` that any pattern matches; pure. */
function forbiddenSpans(text: string, patterns: readonly RegExp[]): Array<[number, number]> {
  const raw: Array<[number, number]> = [];
  for (const p of patterns) {
    if (!safeTest(p, text)) continue; // keeps the ReDoS guard on the cheap path
    const g = new RegExp(p.source, p.flags.includes('g') ? p.flags : `${p.flags}g`);
    for (const m of text.matchAll(g)) {
      if (m[0] === '') break; // never spin on an empty match
      raw.push([m.index, m.index + m[0].length]);
    }
  }
  if (raw.length === 0) return raw;
  raw.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [raw[0]!];
  for (const span of raw.slice(1)) {
    const last = merged[merged.length - 1]!;
    if (span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push(span);
  }
  return merged;
}

/** Every substring of `text` that a pattern matches, with the pattern index — validate rule 8 (02 §10.8). */
export function findForbiddenContent(text: string, patterns: readonly RegExp[] = PII_PATTERNS): Array<{ match: string; pattern: number }> {
  const out: Array<{ match: string; pattern: number }> = [];
  if (typeof text !== 'string' || text === '') return out;
  for (let i = 0; i < patterns.length; i++) {
    const p = patterns[i]!;
    const flags = p.flags.includes('g') ? p.flags : `${p.flags}g`;
    const g = new RegExp(p.source, flags);
    for (const m of text.matchAll(g)) {
      if (m[0] === '') break; // never spin on an empty match
      out.push({ match: m[0], pattern: i });
    }
  }
  return out;
}

/** Bytes of `compactJson(tree)` — the `perception_bytes` contribution of one observation (08 §2). */
export function perceptionBytes(tree: ScrubbedTree): number {
  return Buffer.byteLength(compactJson(tree), 'utf8');
}
