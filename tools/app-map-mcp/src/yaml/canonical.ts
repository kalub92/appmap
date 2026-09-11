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
import type { YamlKind } from '../paths.ts';
import { NotImplementedError } from '../errors.ts';

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
  meta: ['sources', 'status', 'last_verified_build'],
  recipe: ['id', 'version', 'platform', 'description', 'matches', 'params', 'preconditions', 'entry', 'steps', 'verify', 'status', 'provenance', 'last_verified_build'],
  param: ['name', 'type', 'required', 'values'],
  entry: ['deep_link', 'fallback_path'],
  step: ['id', 'action', 'element', 'list', 'match', 'text', 'direction', 'duration_ms', 'url', 'gate', 'timeout_ms', 'expect', 'intent_critical'],
  match: ['text'],
  expect: ['screen', 'focused', 'visible', 'not_visible', 'text_present'],
  provenance: ['compiled_from', 'compiled_by', 'reviewed_by', 'revision_of'],
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
 * Return a deep copy of `obj` with keys ordered and lists sorted per the rules above. Pure.
 * Unknown keys are preserved (after known ones) so a newer schema never loses data on export.
 */
export function canonicalize(type: CanonicalType, obj: unknown): unknown {
  void type; void obj;
  throw new NotImplementedError('yaml/canonical.canonicalize');
}

/** `stringify(canonicalize(kind, obj))` with `YAML_STRINGIFY_OPTIONS`; always ends with one LF. */
export function canonicalYaml(kind: YamlKind, obj: unknown): string {
  void kind; void obj;
  throw new NotImplementedError('yaml/canonical.canonicalYaml');
}

/** True when `text` equals `canonicalYaml(kind, parse(text))` (02 §10.7). */
export function isCanonical(kind: YamlKind, text: string): boolean {
  void kind; void text;
  throw new NotImplementedError('yaml/canonical.isCanonical');
}
