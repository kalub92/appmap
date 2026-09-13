/**
 * [A1] Canonical YAML serializer (02 §2.3, 02 §10.7, 06 R1 `export --check`).
 *
 * Contract: `canonicalYaml(kind, obj)` is a pure function of `obj`; serializing the pilot files
 * under app-map/ must reproduce them byte-for-byte (they were generated with exactly these
 * rules — see docs/dev/architecture.md "Canonical YAML"). Rules:
 *
 * 1. Key order per type is `KEY_ORDER[type]`; keys not listed come after, sorted by code point.
 * 2. `undefined`/`null` values are omitted. Optional empty arrays are omitted; required arrays
 *    (`elements`, `edges`, `steps`, `params`, `screens`, `gates`, `servers`) are kept even if empty.
 * 3. Lists of objects under `screens`, `gates`, `elements`, `variants` are sorted by `id`
 *    (code point order). `edges` sort by `(action.type, action.element|url|gate, action.direction, to)`.
 *    `servers` sort by `name`. String sets `required_ids`, `dynamic_regions`, `gates`, `sources`,
 *    `visible`, `not_visible` are sorted. Everything else keeps authored order because order is
 *    semantics: `steps`, `locators` (rank), `matches` (tried in order), `params`, `fallback_path`,
 *    `preconditions`, `postconditions`, `required_labels`, `args`, `values`.
 * 4. Text is produced by `yaml@2.9 stringify(ordered, YAML_STRINGIFY_OPTIONS)`: block style
 *    everywhere (the flow-style `{…}` in the spec examples is illustrative), 2-space indent,
 *    `lineWidth: 0` (never fold), default quoting (plain when possible; `"4412"`, `"{amount}"`
 *    and `"true"`-like strings double-quoted), LF, trailing newline, no comments, no document
 *    markers. Numbers print as JS numbers (`1`, not `1.0`).
 *
 * Layer: yaml (imports types/paths only).
 */
import { LineCounter, parse, parseDocument, stringify } from 'yaml';
import type { YamlKind } from '../paths.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';

/**
 * `yaml.parse` of text already in memory; parse errors carry `file` + `line:col` and are
 * `AppMapError(invalid_map)` (02 §10.1). Lives here (not load.ts) so validate.ts can parse
 * without importing the loader — the layering has no cycles (architecture §1).
 */
export function parseYamlText<T = unknown>(text: string, file: string): T {
  // parseDocument (not parse) so every error is collected with its position; uniqueKeys is the
  // yaml default, so duplicate keys are parse errors too.
  // LineCounter gives line:col without prettyErrors (which would echo source lines into the message)
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { prettyErrors: false, lineCounter });
  if (doc.errors.length) {
    const lines = doc.errors.map((e) => {
      const offset = e.pos[0];
      const pos = offset !== undefined ? lineCounter.linePos(offset) : undefined;
      return `  ${file}${pos ? `:${pos.line}:${pos.col}` : ''} ${e.code}: ${e.message}`;
    });
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `${file} is not valid YAML:\n${lines.join('\n')}`, 'fix the YAML syntax (02 §2.3: block style, 2-space indent)');
  }
  return doc.toJS() as T;
}

/** Options passed verbatim to `yaml.stringify`. */
export const YAML_STRINGIFY_OPTIONS = {
  indent: 2,
  lineWidth: 0,
  minContentWidth: 0,
  singleQuote: false,
  nullStr: 'null',
} as const;

/** Sub-types addressed by `KEY_ORDER`; a YamlKind is also a canonical type. */
export type CanonicalType =
  | 'ids' | 'ids.screen' | 'ids.gate' | 'ids.element'
  | 'manifest' | 'build'
  | 'screen' | 'signature' | 'variant' | 'element' | 'locator' | 'role_label' | 'point' | 'bbox' | 'fingerprint'
  | 'edge' | 'action' | 'condition' | 'meta'
  | 'recipe' | 'param' | 'entry' | 'step' | 'match' | 'expect' | 'provenance'
  | 'mcp-allowlist' | 'server';

export const KEY_ORDER: Readonly<Record<CanonicalType, readonly string[]>> = {
  ids: ['schema_version', 'screens', 'gates', 'elements'],
  'ids.screen': ['id', 'title', 'deep_link'],
  'ids.gate': ['id', 'dismiss'],
  'ids.element': ['id', 'kind', 'intent_critical', 'dynamic', 'label_regex'],
  manifest: ['schema_version', 'app_id', 'platform', 'deep_link_scheme', 'build', 'generated_at', 'generator'],
  build: ['version', 'build_number', 'git_sha'],
  screen: ['id', 'kind', 'title', 'deep_link', 'signature', 'dynamic_regions', 'gates', 'variants', 'elements', 'edges', 'meta'],
  signature: ['marker', 'route', 'nav_class', 'required_ids', 'required_labels', 'structural_hash'],
  variant: ['id', 'when', 'required_ids', 'structural_hash'],
  element: ['id', 'role', 'label', 'intent', 'intent_critical', 'dynamic', 'locators', 'fingerprint', 'status', 'last_verified_build'],
  locator: ['strategy', 'value', 'weight'],
  role_label: ['role', 'label', 'label_regex'],
  point: ['x', 'y'],
  bbox: ['x', 'y', 'w', 'h'],
  fingerprint: ['role', 'label_norm', 'parent_role', 'sibling_index', 'bbox_norm'],
  edge: ['action', 'to', 'preconditions', 'postconditions', 'status', 'last_verified_build'],
  action: ['type', 'element', 'direction', 'url', 'gate'],
  condition: ['auth', 'screen', 'flag', 'value', 'platform_version'],
  // `relearned_from` sits directly above `reviewed_by` for the reason `provenance.machine_recompile`
  // does (issue #13, #16): in a PR diff the two lines are then read together — "this screen was
  // re-learned over a verified one, and here is who signed off since" — instead of the marker
  // landing after the build stamp where it reads as a footnote.
  meta: ['sources', 'status', 'relearned_from', 'reviewed_by', 'last_verified_build'],
  recipe: ['id', 'version', 'platform', 'description', 'matches', 'params', 'preconditions', 'entry', 'steps', 'verify', 'status', 'provenance', 'last_verified_build'],
  param: ['name', 'type', 'required', 'values'],
  entry: ['deep_link', 'fallback_path'],
  // `cell` sits beside `list`: they are the two element keys of the two `select` forms (issue #19)
  step: ['id', 'action', 'element', 'list', 'cell', 'match', 'text', 'direction', 'duration_ms', 'url', 'gate', 'timeout_ms', 'expect', 'intent_critical'],
  match: ['text'],
  expect: ['screen', 'focused', 'visible', 'not_visible', 'text_present'],
  // `machine_recompile` sits directly above `reviewed_by` on purpose (issue #13 criterion 4): in a
  // PR diff the two lines are then read together — "these steps are machine-made, the signature
  // below is historical" — instead of the marker landing at the end where it reads as a footnote.
  provenance: ['compiled_from', 'compiled_by', 'machine_recompile', 'reviewed_by', 'revision_of'],
  'mcp-allowlist': ['schema_version', 'servers'],
  server: ['name', 'source', 'transport', 'command', 'args', 'package', 'version', 'reviewer', 'reviewed_at', 'notes'],
};

/** child key → sub-type, per parent type (locator `value` is typed by `strategy`: role_label | point | scalar). */
export const CHILD_TYPES: Readonly<Partial<Record<CanonicalType, Readonly<Record<string, CanonicalType>>>>> = {
  ids: { screens: 'ids.screen', gates: 'ids.gate', elements: 'ids.element' },
  manifest: { build: 'build' },
  screen: { signature: 'signature', variants: 'variant', elements: 'element', edges: 'edge', meta: 'meta' },
  signature: { required_labels: 'role_label' },
  variant: { when: 'condition' },
  element: { locators: 'locator', fingerprint: 'fingerprint' },
  fingerprint: { bbox_norm: 'bbox' },
  edge: { action: 'action', preconditions: 'condition', postconditions: 'condition' },
  recipe: { params: 'param', preconditions: 'condition', entry: 'entry', steps: 'step', verify: 'expect', provenance: 'provenance' },
  step: { match: 'match', expect: 'expect' },
  'mcp-allowlist': { servers: 'server' },
};

export const SORTED_STRING_SETS: ReadonlySet<string> = new Set(['required_ids', 'dynamic_regions', 'gates', 'sources', 'visible', 'not_visible']);
export const ID_SORTED_LISTS: ReadonlySet<string> = new Set(['screens', 'gates', 'elements', 'variants']);

/**
 * Required arrays per parent type (rule 2: kept even when empty). Every other empty array is an
 * optional one and is omitted. `matches` is required by the schema (minItems 1) so keeping it
 * empty only makes the schema error visible instead of hiding the key.
 */
export const REQUIRED_ARRAYS: Readonly<Partial<Record<CanonicalType, ReadonlySet<string>>>> = {
  ids: new Set(['screens', 'gates', 'elements']),
  screen: new Set(['elements', 'edges']),
  recipe: new Set(['matches', 'params', 'steps']),
  'mcp-allowlist': new Set(['servers']),
};

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x) && Object.getPrototypeOf(x) !== Map.prototype;
}

/** code point comparison (`<`), the only ordering used by the canonical form (architecture §3.3) */
export function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sub-type of the `value` key of a locator, decided by its `strategy`. */
function locatorValueType(strategy: unknown): CanonicalType | undefined {
  if (strategy === 'role_label') return 'role_label';
  if (strategy === 'geometry') return 'point';
  return undefined;
}

/** The canonical sub-type of `key` under `parent`, or `undefined` for scalars / untyped children. */
export function childType(parent: CanonicalType, key: string, parentObj?: Record<string, unknown>): CanonicalType | undefined {
  if (parent === 'locator' && key === 'value') return locatorValueType(parentObj?.['strategy']);
  return CHILD_TYPES[parent]?.[key];
}

/** Sort key of an edge (architecture §3.3): `(action.type, action.element ?? url ?? gate ?? '', direction ?? '', to)`. */
export function edgeSortKey(edge: unknown): [string, string, string, string] {
  const e = isPlainObject(edge) ? edge : {};
  const a = isPlainObject(e['action']) ? e['action'] : {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
  return [str(a['type']), str(a['element'] ?? a['url'] ?? a['gate']), str(a['direction']), str(e['to'])];
}

function compareTuple(x: readonly string[], y: readonly string[]): number {
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const c = codePointCompare(x[i] ?? '', y[i] ?? '');
    if (c !== 0) return c;
  }
  return 0;
}

/** Stable sort by a string key; equal keys keep authored order. */
function sortBy<T>(items: T[], key: (item: T) => readonly string[]): T[] {
  return items
    .map((item, i) => ({ item, i, k: key(item) }))
    .sort((a, b) => compareTuple(a.k, b.k) || a.i - b.i)
    .map((x) => x.item);
}

function canonicalizeArray(parent: CanonicalType, key: string, arr: unknown[]): unknown[] {
  const itemType = childType(parent, key);
  const items = arr
    .filter((v) => v !== undefined && v !== null)
    .map((v) => (itemType ? canonicalize(itemType, v) : canonicalizeUntyped(v)));
  const allStrings = items.every((v) => typeof v === 'string');
  const allObjects = items.every(isPlainObject);
  if (allStrings && SORTED_STRING_SETS.has(key)) return [...(items as string[])].sort(codePointCompare);
  if (allObjects && ID_SORTED_LISTS.has(key)) return sortBy(items, (o) => [String((o as Record<string, unknown>)['id'] ?? '')]);
  if (allObjects && key === 'edges') return sortBy(items, edgeSortKey);
  if (allObjects && key === 'servers') return sortBy(items, (o) => [String((o as Record<string, unknown>)['name'] ?? '')]);
  return items;
}

/** Unknown-shaped values (forward compatibility): keys sorted, nulls dropped, order of lists kept. */
function canonicalizeUntyped(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null).map(canonicalizeUntyped);
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort(codePointCompare)) {
      const c = v[k];
      if (c === undefined || c === null) continue;
      out[k] = canonicalizeUntyped(c);
    }
    return out;
  }
  return v;
}

/**
 * Return a deep copy of `obj` with keys ordered and lists sorted per the rules above. Pure.
 * Unknown keys are preserved (after known ones) so a newer schema never loses data on export.
 */
export function canonicalize(type: CanonicalType, obj: unknown): unknown {
  if (Array.isArray(obj)) {
    // a bare list of `type` items (used by the merge driver to render one list item)
    return obj.filter((v) => v !== undefined && v !== null).map((v) => canonicalize(type, v));
  }
  if (!isPlainObject(obj)) return obj;
  const known = KEY_ORDER[type];
  const knownSet = new Set(known);
  const keys = [...known.filter((k) => k in obj), ...Object.keys(obj).filter((k) => !knownSet.has(k)).sort(codePointCompare)];
  const required = REQUIRED_ARRAYS[type];
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null) continue; // rule 2
    if (Array.isArray(v)) {
      const arr = canonicalizeArray(type, k, v);
      if (arr.length === 0 && !required?.has(k)) continue; // optional empty array
      out[k] = arr;
      continue;
    }
    if (isPlainObject(v)) {
      const sub = childType(type, k, obj);
      out[k] = sub ? canonicalize(sub, v) : canonicalizeUntyped(v);
      continue;
    }
    out[k] = v;
  }
  return out;
}

/** `stringify(canonicalize(type, obj))` for any canonical sub-type (merge driver renders subtrees with it). */
export function canonicalYamlOf(type: CanonicalType, obj: unknown): string {
  const text = stringify(canonicalize(type, obj), YAML_STRINGIFY_OPTIONS);
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** `stringify(canonicalize(kind, obj))` with `YAML_STRINGIFY_OPTIONS`; always ends with one LF. */
export function canonicalYaml(kind: YamlKind, obj: unknown): string {
  return canonicalYamlOf(kind, obj);
}

/** True when `text` equals `canonicalYaml(kind, parse(text))` (02 §10.7). Unparseable text is never canonical. */
export function isCanonical(kind: YamlKind, text: string): boolean {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch {
    return false;
  }
  return canonicalYaml(kind, doc) === text;
}
