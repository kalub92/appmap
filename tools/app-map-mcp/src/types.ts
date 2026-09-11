/**
 * Every domain type of app-map. These mirror `app-map/schema/*.schema.json` one-to-one (the
 * schemas are the source of truth for validation; these types are the source of truth for
 * code). Section references point at docs/specs/*.md.
 *
 * Conventions:
 * - closed string unions are declared as `as const` arrays + derived types (no `enum`, see
 *   docs/dev/toolchain.md);
 * - optional fields are `?:` and are omitted (never `null`) in YAML/JSON;
 * - "build" is always the build *number* as a string (`"4412"`, 02 §8).
 *
 * Layer: leaf (imports only config types).
 */
import type { Platform } from './config.ts';

export type { Platform } from './config.ts';

// =============================================================================================
// Identifiers (01 R2)
// =============================================================================================

/** `^[a-z0-9]+(\.[a-z0-9_]+)+$` — every dotted id (elements, markers, gates, dismiss controls) */
export const ID_REGEX = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
/** element ids: `<feature>.<name>.<kind>`, three or more segments, never `screen.`/`gate.` */
export const ELEMENT_ID_REGEX = /^(?!screen\.|gate\.)[a-z0-9]+(\.[a-z0-9_]+){2,}$/;
/** screen ids: snake_case */
export const SCREEN_ID_REGEX = /^[a-z][a-z0-9_]*$/;
/** gate ids: `gate.<name>` */
export const GATE_ID_REGEX = /^gate\.[a-z0-9_]+$/;
/** gate dismiss controls: `gate.<name>.<verb>` */
export const GATE_DISMISS_REGEX = /^gate\.[a-z0-9_]+\.[a-z0-9_]+$/;
/** screen markers: `screen.<screen_id>` (01 R3) */
export const MARKER_REGEX = /^screen\.([a-z][a-z0-9_]*)$/;
/** deep links `appmap://<screen_id>[?k=v…]` (01 R5) */
export const DEEP_LINK_REGEX = /^appmap:\/\/([a-z][a-z0-9_]*)(\?[A-Za-z0-9_.=&%-]*)?$/;
/** structural hash (02 §4.4) */
export const STRUCTURAL_HASH_REGEX = /^sha1:[0-9a-f]{40}$/;
/** recipe step ids (02 §6) */
export const STEP_ID_REGEX = /^s[0-9]+$/;
/** `{param}` slot in a recipe step (04 §3.4) */
export const PARAM_SLOT_REGEX = /^\{([a-z][a-z0-9_]*)\}$/;

export type ScreenId = string;
export type ElementId = string;
export type GateId = string;
export type RecipeId = string;
export type StepId = string;
export type SessionId = string;
export type RunId = string;
/** build number as string (02 §8) */
export type BuildNumber = string;
/** RFC 3339 UTC timestamp, e.g. `2026-09-10T17:02:11Z` */
export type Timestamp = string;

// =============================================================================================
// Closed vocabularies
// =============================================================================================

export const ELEMENT_KINDS = ['button', 'field', 'list', 'cell', 'toggle', 'tab', 'picker', 'link', 'text', 'sheet'] as const;
export type ElementKind = (typeof ELEMENT_KINDS)[number];

/** Normalized accessibility roles shared by both platforms (schema `role` enum). */
export const ROLES = [
  'application', 'window', 'container', 'navigationBar', 'tabBar', 'toolbar', 'scrollView', 'list', 'cell',
  'button', 'link', 'tab', 'toggle', 'field', 'secureField', 'searchField', 'picker', 'staticText', 'image',
  'alert', 'sheet', 'keyboard', 'key', 'other',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles whose `label` may survive scrubbing when it matches a static string (03 §7). */
export const STATIC_LABEL_ROLES: readonly Role[] = ['button', 'tab', 'navigationBar', 'staticText'];

export const LOCATOR_STRATEGIES = ['a11y_id', 'role_label', 'text', 'path', 'geometry'] as const;
export type LocatorStrategy = (typeof LOCATOR_STRATEGIES)[number];

/** 02 §5.1 default weights; a hit with weight < DEGRADED_THRESHOLD is a degraded match (02 §5.2). */
export const DEFAULT_LOCATOR_WEIGHTS: Readonly<Record<LocatorStrategy, number>> = {
  a11y_id: 1.0, role_label: 0.6, text: 0.3, path: 0.25, geometry: 0.1,
};
export const DEGRADED_THRESHOLD = 0.6;
/** strategies that Maestro can express (04 §6.2) */
export const HEADLESS_STRATEGIES: readonly LocatorStrategy[] = ['a11y_id', 'role_label', 'text'];

export const STEP_ACTIONS = ['tap', 'type', 'select', 'swipe', 'open_link', 'wait_for', 'dismiss_gate'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

/** edge actions are the step actions minus `wait_for` */
export const EDGE_ACTION_TYPES = ['tap', 'type', 'select', 'swipe', 'open_link', 'dismiss_gate'] as const;
export type EdgeActionKind = (typeof EDGE_ACTION_TYPES)[number];

export const EXPECT_KEYS = ['screen', 'focused', 'visible', 'not_visible', 'text_present'] as const;
export type ExpectKey = (typeof EXPECT_KEYS)[number];

export const SWIPE_DIRECTIONS = ['up', 'down', 'left', 'right'] as const;
export type SwipeDirection = (typeof SWIPE_DIRECTIONS)[number];

export const ELEMENT_STATUSES = ['candidate', 'verified', 'healed_pending_review'] as const;
export type ElementStatus = (typeof ELEMENT_STATUSES)[number];

export const SCREEN_STATUSES = ['candidate', 'verified', 'retired'] as const;
export type ScreenStatus = (typeof SCREEN_STATUSES)[number];
export type EdgeStatus = ScreenStatus;

export const RECIPE_STATUSES = ['candidate', 'verified', 'ci_gate', 'retired'] as const;
export type RecipeStatus = (typeof RECIPE_STATUSES)[number];

export const SCREEN_SOURCES = ['router_export', 'exploration', 'manual'] as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[number];

export const AUTH_STATES = ['logged_in', 'logged_out', 'any'] as const;
export type AuthState = (typeof AUTH_STATES)[number];

export const PARAM_TYPES = ['string', 'money', 'number', 'bool', 'enum'] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export const RUN_MODES = ['guided', 'headless'] as const;
export type RunMode = (typeof RUN_MODES)[number];

/** session modes as seen by the `task` event (08 §2); `explore` = LLM drives with the map as a prior */
export const SESSION_MODES = ['explore', 'guided', 'headless'] as const;
export type SessionMode = (typeof SESSION_MODES)[number];

export const DRIFT_STATUSES = ['ok', 'degraded', 'broken', 'skipped'] as const;
export type DriftStatus = (typeof DRIFT_STATUSES)[number];

export const HEAL_REASONS = ['accepted', 'low_score', 'ambiguous', 'intent_critical_label_changed', 'no_expect', 'postcondition_failed', 'no_candidates'] as const;
export type HealReason = (typeof HEAL_REASONS)[number];

export const IDENTIFY_SIGNALS = ['marker', 'route', 'required_ids', 'structural_hash', 'title', 'none'] as const;
export type IdentifySignalKind = (typeof IDENTIFY_SIGNALS)[number];

/** 03 §5 signal scores */
export const IDENTIFY_SCORES: Readonly<Record<Exclude<IdentifySignalKind, 'none'>, number>> = {
  marker: 1.0, route: 0.9, required_ids: 0.8, structural_hash: 0.7, title: 0.4,
};
/** required_ids only counts when the present fraction is ≥ this (03 §5 step 4) */
export const REQUIRED_IDS_MIN_FRACTION = 0.5;
/** best score below this → `unknown` (03 §5) */
export const IDENTIFY_UNKNOWN_THRESHOLD = 0.6;
/** bonus per agreeing signal beyond the first (03 §5) */
export const IDENTIFY_AGREEMENT_BONUS = 0.05;
export const UNKNOWN_SCREEN = 'unknown' as const;
/** edge target meaning "whatever was underneath" (02 §4.2) */
export const PREVIOUS_SCREEN = '_previous' as const;

// =============================================================================================
// ids.yaml (01 R1) — schema `ids`
// =============================================================================================

export interface IdsScreen {
  id: ScreenId;
  /** static nav title (optional hint for the `title` identification signal) */
  title?: string;
  /** `appmap://…` or `none` */
  deep_link?: string;
}
export interface IdsGate {
  id: GateId;
  /** `gate.<name>.<verb>` — the dismiss control. Registered here, NOT under `elements`. */
  dismiss: ElementId;
}
export interface IdsElement {
  id: ElementId;
  kind: ElementKind;
  /** default false */
  intent_critical?: boolean;
  /** data-driven container/text: scrubber drops its text, signature excludes descendants (01 R4) */
  dynamic?: boolean;
  /** 07 §9: allows computed labels ("3 invoices") to survive scrubbing when they match */
  label_regex?: string;
}
export interface IdsRegistry {
  schema_version: 1;
  screens: IdsScreen[];
  gates: IdsGate[];
  elements: IdsElement[];
}

// =============================================================================================
// manifest.yaml (02 §3) — schema `manifest`
// =============================================================================================

export interface BuildInfo {
  version: string;
  build_number: BuildNumber;
  git_sha: string;
}
export interface Manifest {
  schema_version: 1;
  app_id: string;
  platform: Platform;
  deep_link_scheme: string;
  build: BuildInfo;
  generated_at: Timestamp;
  /** `app-map-mcp@<semver>` */
  generator: string;
}

// =============================================================================================
// Screens (02 §4) — schema `screen`
// =============================================================================================

/** 02 §4.1 pre/postconditions and 02 §4.3 variant `when`. At least one key. */
export interface Condition {
  auth?: AuthState;
  screen?: ScreenId;
  flag?: string;
  value?: boolean | string | number;
  /** `>=17.0`, `<15` … */
  platform_version?: string;
}

export interface BBoxNorm { x: number; y: number; w: number; h: number }
export interface PointNorm { x: number; y: number }

/** `{role, label}` or `{role, label_regex}` — exactly one of the two. */
export interface RoleLabelValue {
  role: Role;
  label?: string;
  /** JS regex source, tested against the node label (case-sensitive) */
  label_regex?: string;
}

export interface LocatorA11yId { strategy: 'a11y_id'; value: string; weight: number }
export interface LocatorRoleLabel { strategy: 'role_label'; value: RoleLabelValue; weight: number }
export interface LocatorText { strategy: 'text'; value: string; weight: number }
/** `parentRole/childRole[i]/…` from the screen root (see `pathOf` in tree.ts) */
export interface LocatorPath { strategy: 'path'; value: string; weight: number }
/** normalized centre point */
export interface LocatorGeometry { strategy: 'geometry'; value: PointNorm; weight: number }
export type Locator = LocatorA11yId | LocatorRoleLabel | LocatorText | LocatorPath | LocatorGeometry;

/** 02 §5.3 — stored at verification time, used only for heal scoring. Never contains values. */
export interface Fingerprint {
  role: Role;
  /** lowercased, punctuation stripped, whitespace collapsed (see `labelNorm`) */
  label_norm?: string;
  parent_role?: Role;
  /** index among ALL siblings (0-based) */
  sibling_index?: number;
  bbox_norm?: BBoxNorm;
}

export interface ElementDef {
  id: ElementId;
  role: Role;
  /** static UI copy only; never data; absent on dynamic elements */
  label?: string;
  /** free-form snake_case verb phrase used by `find_element {intent}` */
  intent?: string;
  intent_critical?: boolean;
  dynamic?: boolean;
  /** ranked; first unique hit wins (02 §5.2) */
  locators: Locator[];
  fingerprint?: Fingerprint;
  status: ElementStatus;
  last_verified_build?: BuildNumber;
}

export interface EdgeActionTap { type: 'tap'; element: ElementId }
export interface EdgeActionTypeText { type: 'type'; element: ElementId }
export interface EdgeActionSelect { type: 'select'; element: ElementId }
export interface EdgeActionSwipe { type: 'swipe'; direction: SwipeDirection; element?: ElementId }
export interface EdgeActionOpenLink { type: 'open_link'; url: string }
export interface EdgeActionDismissGate { type: 'dismiss_gate'; gate: GateId }
export type EdgeAction = EdgeActionTap | EdgeActionTypeText | EdgeActionSelect | EdgeActionSwipe | EdgeActionOpenLink | EdgeActionDismissGate;

export interface Edge {
  action: EdgeAction;
  /** screen id or `_previous` */
  to: ScreenId | typeof PREVIOUS_SCREEN;
  preconditions?: Condition[];
  postconditions?: Condition[];
  status: EdgeStatus;
  last_verified_build?: BuildNumber;
}

export interface Variant {
  id: string;
  when: Condition;
  required_ids?: ElementId[];
  structural_hash?: string;
}

export interface Signature {
  /** `screen.<id>` or `none` (OS gates) */
  marker: string;
  route?: string;
  /** SwiftUI view / VC / Activity / Fragment / composable */
  nav_class?: string;
  required_ids?: ElementId[];
  /** gate signature for OS dialogs (02 §4.2) */
  required_labels?: RoleLabelValue[];
  structural_hash?: string;
}

export interface ScreenMeta {
  sources: ScreenSource[];
  status: ScreenStatus;
  last_verified_build?: BuildNumber;
}

export interface ScreenFile {
  id: ScreenId | GateId;
  kind: 'screen' | 'gate';
  title?: string;
  /** required for `kind: screen`; `none` for gates */
  deep_link?: string;
  signature: Signature;
  dynamic_regions?: ElementId[];
  /** gates observed on entry to this screen */
  gates?: GateId[];
  variants?: Variant[];
  elements: ElementDef[];
  edges: Edge[];
  meta: ScreenMeta;
}

// =============================================================================================
// Recipes (02 §6, 04) — schema `recipe`
// =============================================================================================

export interface Expect {
  screen?: ScreenId;
  focused?: ElementId;
  visible?: ElementId[];
  not_visible?: ElementId[];
  /** static copy only */
  text_present?: string;
}

export interface RecipeParam {
  name: string;
  type: ParamType;
  required: boolean;
  /** for `enum` */
  values?: string[];
}

interface StepBase {
  id: StepId;
  /** verification point; steps without one inherit "screen unchanged" (02 §6) */
  expect?: Expect;
  /** mirrors ids.yaml for the touched element (04 §3.7) */
  intent_critical?: boolean;
}
export interface StepTap extends StepBase { action: 'tap'; element: ElementId }
/** `text` is literal static copy or a `{param}` slot */
export interface StepType extends StepBase { action: 'type'; element: ElementId; text: string }
export interface StepSelect extends StepBase { action: 'select'; list: ElementId; match: { text: string } }
export interface StepSwipe extends StepBase { action: 'swipe'; direction: SwipeDirection; element?: ElementId; duration_ms?: number }
export interface StepOpenLink extends StepBase { action: 'open_link'; url: string }
/** `expect` is required for wait_for */
export interface StepWaitFor extends StepBase { action: 'wait_for'; expect: Expect; timeout_ms?: number }
export interface StepDismissGate extends StepBase { action: 'dismiss_gate'; gate: GateId }
export type RecipeStep = StepTap | StepType | StepSelect | StepSwipe | StepOpenLink | StepWaitFor | StepDismissGate;

export interface RecipeEntry {
  deep_link?: string;
  /** screen ids; edges resolved at run time */
  fallback_path?: ScreenId[];
}
export interface RecipeProvenance {
  /** trajectory/session id */
  compiled_from: string;
  /** `app-map-mcp@<semver>` */
  compiled_by: string;
  reviewed_by?: string;
  /** previous version this revision was compiled from (04 §8) */
  revision_of?: number;
}
export interface RecipeFile {
  id: RecipeId;
  version: number;
  platform: Platform;
  description: string;
  /** case-insensitive regexes tried in order (04 §4) */
  matches: string[];
  params: RecipeParam[];
  preconditions?: Condition[];
  entry: RecipeEntry;
  steps: RecipeStep[];
  verify: Expect;
  status: RecipeStatus;
  provenance: RecipeProvenance;
  last_verified_build?: BuildNumber;
}

/** parameter values supplied to `run_recipe` (03 §8); money/number accepted as string or number */
export type RecipeParams = Record<string, string | number | boolean>;

// =============================================================================================
// Router export (01 R6) — schema `router-export`
// =============================================================================================

export interface RouterExportScreen {
  id: ScreenId;
  /** `appmap://…` or `none` */
  route: string;
  view_type: string;
  title?: string;
  edges?: Array<{ action: EdgeAction; to: ScreenId | typeof PREVIOUS_SCREEN }>;
}
export interface RouterExport {
  schema_version: 1;
  app_id: string;
  platform: Platform;
  build: BuildInfo;
  screens: RouterExportScreen[];
  gates?: IdsGate[];
}

// =============================================================================================
// Policy (07 §6) — schema `mcp-allowlist`
// =============================================================================================

export interface AllowlistServer {
  name: string;
  source: 'in-repo' | 'npm' | 'binary';
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  package?: string;
  version: string;
  reviewer: string;
  /** date (YYYY-MM-DD) */
  reviewed_at: string;
  notes?: string;
}
export interface McpAllowlist {
  schema_version: 1;
  servers: AllowlistServer[];
}

// =============================================================================================
// Accessibility trees (03 §5, 03 §7)
// =============================================================================================

/**
 * Normalized tree node — the ONLY tree shape past `tree.ts`.
 *
 * - `role`: normalized role (see `ROLES`); unknown platform types map to `other`.
 * - `a11y_id`: accessibilityIdentifier (iOS) / resource-id or testTag (Android); absent when empty.
 * - `label`: accessibility label / content-description / visible text of static controls.
 * - `value`: field value (raw trees only; the scrubber drops it unconditionally, 07 §2.3.1).
 * - `text`: visible text distinct from `label` (Android `text` attribute; raw trees only).
 * - `enabled`/`focused`/`selected`: present only when the driver reported them.
 * - `bbox_norm`: frame normalized to the viewport, each coordinate in [0,1].
 * - `children`: document order (top-to-bottom, left-to-right as reported by the driver).
 */
export interface TreeNode {
  role: Role;
  a11y_id?: string;
  label?: string;
  value?: string;
  text?: string;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  bbox_norm: BBoxNorm;
  children: TreeNode[];
}

export const TREE_SOURCES = ['argent', 'maestro', 'normalized', 'synthetic'] as const;
export type TreeSource = (typeof TREE_SOURCES)[number];

/** A raw (unscrubbed) normalized tree. Must never be written to disk (03 §7). */
export interface Tree {
  schema_version: 1;
  platform: Platform;
  source: TreeSource;
  /** viewport in points/dp when known; lets `bbox_norm` be de-normalized for taps */
  viewport?: { w: number; h: number };
  /** ISO timestamp of capture when known */
  captured_at?: Timestamp;
  /** route/deep link the driver reported for this state, if any (identification signal 03 §5.3) */
  route?: string;
  /** build number the driver reported, if any (03 §13) */
  build?: BuildNumber;
  root: TreeNode;
  /** absent or false on raw trees */
  scrubbed?: false;
}

/** The only tree form that exists past the ingest boundary (03 §7). Runtime-branded by `scrubbed: true`. */
export interface ScrubbedTree extends Omit<Tree, 'scrubbed'> {
  scrubbed: true;
  /** number of strings replaced by `[redacted]` (07 §2.3.4); >0 flags the observation `scrub_hit` */
  scrub_hits?: number;
}
export type AnyTree = Tree | ScrubbedTree;
export const REDACTED = '[redacted]' as const;

/** Inputs the scrubber needs (03 §7, 07 §2.3). Built once per loaded map by `buildScrubPolicy`. */
export interface ScrubPolicy {
  /** ids registered with `dynamic: false` (label kept) */
  staticIds: ReadonlySet<string>;
  /** ids registered with `dynamic: true` (all text under them dropped) */
  dynamicIds: ReadonlySet<string>;
  /** per-id computed-label regexes from ids.yaml `label_regex` (07 §9) */
  labelRegexById: ReadonlyMap<string, RegExp>;
  /** static string table snapshot (`.local/strings.<platform>.txt`), exact-match */
  staticLabels: ReadonlySet<string>;
  /** PII deny list applied to every surviving string (07 §2.3.4) */
  piiPatterns: readonly RegExp[];
}

// =============================================================================================
// Observations (02 §7, 04 §2)
// =============================================================================================

/** signature of the tree after the action, as recorded in the trajectory (02 §7) */
export interface ObservedSignature {
  /** `screen.<id>` or `none` */
  marker: string;
  structural_hash: string;
  /** fraction of the identified screen's `required_ids` present (0 when unknown) */
  required_present: number;
}

/** Driver tool arguments are opaque; these are the keys the compiler understands (04 §3.3). */
export interface DriverInput {
  id?: string;
  text?: string;
  url?: string;
  direction?: SwipeDirection;
  x?: number;
  y?: number;
  index?: number;
  [k: string]: unknown;
}

/**
 * One observation per driver tool call (02 §7). Written as one JSON line to
 * `.local/trajectories/<session>.jsonl` and mirrored in the `observations` table.
 */
export interface Observation {
  ts: Timestamp;
  session: SessionId;
  /** 1-based, monotonic per session */
  seq: number;
  /** task text declared via match_recipe/name_task; absent before a task is declared (04 §2) */
  task?: string;
  /** e.g. `mcp__argent__tap` */
  tool: string;
  input: DriverInput;
  /** resolved element id for the tapped/typed node when one exists (04 §2) */
  element?: ElementId;
  /** `unknown` when nothing was observed before, or identification failed */
  screen_before: ScreenId | typeof UNKNOWN_SCREEN;
  screen_after: ScreenId | typeof UNKNOWN_SCREEN;
  signature_after: ObservedSignature;
  gates_present?: GateId[];
  /** scrubbed compact tree after the action; `null` when the driver returned no tree */
  snapshot: ScrubbedTree | null;
  ok: boolean;
  /** tool error text on failure (PostToolUseFailure) */
  error?: string;
  latency_ms: number;
  /** 07 §2.3.4 */
  scrub_hits?: number;
  /** identification confidence for `screen_after` */
  confidence?: number;
}

// =============================================================================================
// Identification (03 §5) and resolution (03 §6)
// =============================================================================================

export interface IdentifySignal {
  kind: IdentifySignalKind;
  screen: ScreenId | GateId;
  variant?: string;
  score: number;
  /** e.g. required_ids fraction, matched marker, matched title */
  detail?: string;
}
export interface IdentifyCandidate {
  screen_id: ScreenId;
  variant?: string;
  confidence: number;
  signals: IdentifySignalKind[];
}
export interface IdentifyResult {
  screen_id: ScreenId | typeof UNKNOWN_SCREEN;
  variant?: string;
  /** 0..1 (after 02 §8 decay when `build` is supplied) */
  confidence: number;
  /** signals that contributed to the winner (empty when unknown) */
  signals: IdentifySignal[];
  gates_present: GateId[];
  /** top-3 when `screen_id === 'unknown'` (03 §5) */
  candidates?: IdentifyCandidate[];
  /** the marker found, when exactly one exists */
  marker?: string;
  structural_hash: string;
  /** builds since `last_verified_build` used for decay, when computable */
  builds_since_verified?: number;
}
export interface IdentifyOptions {
  /** route/deep link the observation carried (signal 3) */
  route?: string;
  /** current build number for confidence decay (02 §8); omit = no decay */
  build?: BuildNumber;
  /** evaluated against variant `when` conditions (02 §4.3); unknown keys → any variant may match */
  conditions?: Condition;
  /** platform of the tree; defaults to the map's */
  platform?: Platform;
}

export interface ResolveHit {
  status: 'hit';
  element: ElementId;
  node: TreeNode;
  /** path from the screen root, for taps by path and for logs */
  path: string;
  strategy: LocatorStrategy;
  locator: Locator;
  /** locator weight (× 0.9 when disambiguated) */
  confidence: number;
  /** confidence < 0.6 → heal proposal (02 §5.2) */
  degraded: boolean;
  /** true when a11y_id/role_label matched >1 node and fingerprint disambiguation picked one */
  disambiguated: boolean;
  /** how to address the node with the driver: id when present, else role+label, else geometry */
  target: DriverTarget;
}
export interface ResolveMiss {
  status: 'miss';
  element: ElementId;
  /** per-locator match counts, in rank order */
  tried: Array<{ strategy: LocatorStrategy; matches: number }>;
  /** best-effort suggestions (role-compatible nodes with labels), ≤3 */
  candidates: Array<{ path: string; role: Role; label?: string; a11y_id?: string }>;
}
export type ResolveResult = ResolveHit | ResolveMiss;

/** What the LLM/replayer passes to the driver (05 §5). Exactly one addressing form. */
export type DriverTarget =
  | { by: 'id'; id: string }
  | { by: 'role_label'; role: Role; label: string }
  | { by: 'text'; text: string }
  | { by: 'point'; x: number; y: number };

// =============================================================================================
// Healing (04 §7)
// =============================================================================================

export const HEAL_WEIGHTS = { role: 0.35, label: 0.3, path: 0.15, bbox: 0.1, parent_sibling: 0.1 } as const;
export const HEAL_ACCEPT_SCORE = 0.75;
export const HEAL_RUNNER_UP_MARGIN = 0.1;

export interface HealCandidate {
  node: TreeNode;
  path: string;
  role: Role;
  label?: string;
  a11y_id?: string;
  score: number;
  features: { role: number; label: number; path: number; bbox: number; parent_sibling: number };
  /** the locator that would be promoted/added if accepted */
  proposed_locator: Locator;
}
export interface HealRecord {
  recipe: RecipeId;
  step: StepId;
  element: ElementId;
  old_strategy: LocatorStrategy;
  new_strategy?: LocatorStrategy;
  old_locator?: Locator;
  new_locator?: Locator;
  score: number;
  runner_up_score?: number;
  accepted: boolean;
  reason: HealReason;
  intent_critical: boolean;
  build: BuildNumber;
}
export interface HealResult {
  accepted: boolean;
  reason: HealReason;
  record: HealRecord;
  /** winner when accepted */
  candidate?: HealCandidate;
  /** top-3 for the fallback payload when rejected */
  candidates: HealCandidate[];
  /** the element as updated in the cache when accepted (status healed_pending_review) */
  updated_element?: ElementDef;
}
export interface HealInput {
  recipe: RecipeId;
  step: RecipeStep;
  screen: ScreenId;
  element: ElementDef;
  intent_critical: boolean;
  tree: AnyTree;
  /** the resolution that triggered healing */
  trigger: ResolveResult;
  build: BuildNumber;
}

// =============================================================================================
// Guided replay protocol (04 §5)
// =============================================================================================

export const GUIDED_LIMITS = { gate_dismissals_per_step: 2, heals_per_step: 1 } as const;

/** A step handed to the LLM/replayer: ≤120 tokens once formatted (04 §5). */
export interface RunStep {
  id: StepId;
  action: StepAction;
  /** element being acted on (tap/type/select-list/swipe) */
  element?: ElementId;
  /** how the driver should address it (the strategy that will hit) */
  target?: DriverTarget;
  /** resolved strategy + confidence when the element was resolved against the last observation */
  resolved?: { strategy: LocatorStrategy; confidence: number; degraded: boolean };
  /** parameter-substituted text for `type` */
  text?: string;
  /** substituted match text for `select` */
  match_text?: string;
  direction?: SwipeDirection;
  url?: string;
  gate?: GateId;
  expect?: Expect;
  intent_critical?: boolean;
  /** 07 §3: candidate recipes announce intent_critical steps to the user before acting */
  announce?: boolean;
}

export const FALLBACK_REASONS = [
  'miss', 'expect_failed', 'unknown_screen', 'no_observation', 'gate_limit', 'heal_limit', 'heal_rejected',
  'intent_critical_label_changed', 'entry_failed', 'not_headless_eligible', 'driver_error',
] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

export interface FallbackPayload {
  step: StepId;
  reason: FallbackReason;
  screen_seen: ScreenId | typeof UNKNOWN_SCREEN;
  expected?: Expect;
  /** top-3 heal candidates or identify candidates, already compact */
  candidates: string[];
  /** one-line human explanation */
  message: string;
}
export interface HealSummary {
  step: StepId;
  element: ElementId;
  old_strategy: LocatorStrategy;
  new_strategy: LocatorStrategy;
  score: number;
}

export type ReportStepResult =
  | { run_id: RunId; status: 'ok'; step: RunStep; healed?: HealSummary }
  | { run_id: RunId; status: 'gate'; step: RunStep; /** step to retry after the gate is dismissed */ retry: StepId }
  | { run_id: RunId; status: 'fallback'; fallback: FallbackPayload }
  | { run_id: RunId; status: 'done'; done: true; verified: boolean; heals: HealSummary[] };

export interface ReportStepInput {
  run_id: RunId;
  step_id: StepId;
  ok: boolean;
  note?: string;
  /** required only when hooks are unavailable (04 §5); expensive */
  snapshot?: unknown;
}

export type RunRecipeResult =
  | { mode: 'guided'; run_id: RunId; recipe: RecipeId; version: number; step: RunStep }
  | { mode: 'headless'; run_id: RunId; recipe: RecipeId; version: number; report: HeadlessReport };

/** persisted guided-run state (table `runs` + `run_steps`) */
export const RUN_STATES = ['active', 'done', 'fallback', 'failed'] as const;
export type RunState = (typeof RUN_STATES)[number];
export interface RunRecord {
  run_id: RunId;
  recipe: RecipeId;
  version: number;
  mode: RunMode;
  session?: SessionId;
  params: RecipeParams;
  state: RunState;
  /** step currently handed out (`s0` = entry) */
  current_step: StepId;
  /** index into the expanded step list (entry = -1) */
  step_index: number;
  /** step to retry after a `dismiss_gate` step completes */
  retry_step?: StepId;
  heals: HealSummary[];
  fallbacks: number;
  started_at: Timestamp;
  finished_at?: Timestamp;
  build: BuildNumber;
  /** seq of the last observation consumed, so report_step never re-verifies a stale one */
  last_seq?: number;
}
export interface RunStepRecord {
  run_id: RunId;
  step_id: StepId;
  attempt: number;
  gate_dismissals: number;
  heals: number;
  ok?: boolean;
  result?: ReportStepResult;
  ts: Timestamp;
}

/** 07 §3 debug-endpoint record (iOS: `defaults read <bundle> app_map_debug_probe`). */
export interface BuildProbeResult {
  schema_version: 1;
  build_type: 'debug' | 'release';
  sandbox: boolean;
  app_id: string;
  version: string;
  build_number: BuildNumber;
  git_sha: string;
  written_at?: Timestamp;
}

// =============================================================================================
// Headless replay (04 §6.1) and heal report (06 R6) — schema `heal-report`
// =============================================================================================

export interface HeadlessReport {
  recipe: RecipeId;
  version: number;
  mode: 'headless';
  ok: boolean;
  steps: number;
  steps_done: number;
  heals: HealRecord[];
  fallback_step?: StepId;
  screen_seen?: ScreenId | typeof UNKNOWN_SCREEN;
  retries: number;
  ms: number;
  build: BuildNumber;
  flow_path?: string;
  error?: string;
}
export interface HealReport {
  schema_version: 1;
  platform: Platform;
  build: BuildNumber;
  generated_at: Timestamp;
  runs: HeadlessReport[];
  /** accepted heals (exported to YAML) */
  heals: HealRecord[];
  /** rejected: intent_critical or low score */
  needs_human: HealRecord[];
}

// =============================================================================================
// Drift (06 R4) — schema `drift-report`
// =============================================================================================

export interface DriftScreenResult {
  screen: ScreenId;
  status: DriftStatus;
  marker_present: boolean;
  required_present: number;
  missing_ids: ElementId[];
  hash_changed: boolean;
  unresolvable_elements: ElementId[];
  ci_gate_referenced: boolean;
  reason?: string;
}
export interface DriftReport {
  schema_version: 1;
  platform: Platform;
  build: BuildNumber;
  generated_at: Timestamp;
  screens: DriftScreenResult[];
  summary: { ok: number; degraded: number; broken: number; skipped: number; blocking: boolean };
}

// =============================================================================================
// Hook payloads (05 §3) — schema `hook-payload`
// =============================================================================================

export const HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact'] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** Claude Code hook stdin. Also the ingest-socket request body (03 §2). Extra keys are ignored. */
export interface HookPayload {
  session_id: SessionId;
  hook_event_name: HookEventName;
  transcript_path?: string;
  cwd?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: 'startup' | 'resume' | 'clear' | 'compact';
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  /** MCP result: `{content:[{type:'text',text}], structuredContent?}` or anything the driver returns */
  tool_response?: unknown;
  /** PostToolUseFailure */
  error?: string;
  stop_hook_active?: boolean;
  trigger?: string;
  custom_instructions?: string;
  [k: string]: unknown;
}
/** SessionStart hook stdout (05 §3) */
export interface SessionStartHookOutput {
  hookSpecificOutput: { hookEventName: 'SessionStart'; additionalContext: string };
}

// =============================================================================================
// Events (08 §2) — schema `events` (one JSON line each)
// =============================================================================================

interface EventBase { ts: Timestamp; platform?: Platform; session?: SessionId }
export interface TaskEvent extends EventBase {
  kind: 'task'; session: SessionId; task: string; mode_start: SessionMode; mode_end: SessionMode; ok: boolean;
  driver_calls: number; perception_bytes: number; screenshots: number; ms: number; build?: BuildNumber;
}
export interface RecipeRunEvent extends EventBase {
  kind: 'recipe_run'; recipe: RecipeId; version: number; mode: RunMode; ok: boolean; steps: number; steps_done: number;
  heals: number; fallbacks: number; ms: number; build: BuildNumber; run_id?: RunId; fallback_step?: StepId; fallback_reason?: string;
}
export interface HealEvent extends EventBase {
  kind: 'heal'; recipe: RecipeId; step: StepId; element: ElementId; old_strategy: LocatorStrategy; new_strategy?: LocatorStrategy;
  score: number; accepted: boolean; reason: string; build: BuildNumber; intent_critical?: boolean; run_id?: RunId;
}
export interface IdentifyEvent extends EventBase {
  kind: 'identify'; screen: ScreenId | typeof UNKNOWN_SCREEN; confidence: number; signal: IdentifySignalKind; build: BuildNumber;
  variant?: string; gates_present?: GateId[]; candidates?: ScreenId[];
}
export interface DriftEvent extends EventBase {
  kind: 'drift'; screen: ScreenId; status: DriftStatus; missing_ids: ElementId[]; hash_changed: boolean; build: BuildNumber; ci_gate_referenced?: boolean;
}
export interface CompileEvent extends EventBase {
  kind: 'compile'; recipe: RecipeId; version: number; from_session: SessionId; steps: number; params: string[]; ok?: boolean; reason?: string;
}
export type Event = TaskEvent | RecipeRunEvent | HealEvent | IdentifyEvent | DriftEvent | CompileEvent;
export type EventKind = Event['kind'];
/** an event before `ts` is stamped by `appendEvent` */
export type EventInput = Event extends infer E ? (E extends Event ? Omit<E, 'ts'> & { ts?: Timestamp } : never) : never;

// =============================================================================================
// Loaded map (in-memory index, 03 §4)
// =============================================================================================

/** Where an element is declared; the same id may appear on several screens (e.g. gates, tabs). */
export interface ElementRef { screen: ScreenId | GateId; element: ElementDef }

export interface LoadedMap {
  platform: Platform;
  manifest: Manifest;
  ids: IdsRegistry;
  /** every registered id (screens' markers, gates, dismiss controls, elements) → registry entry */
  idsIndex: ReadonlyMap<string, IdsElement | IdsGate | IdsScreen>;
  /** element registry entries by id, including gate dismiss controls synthesized as `{kind:'button'}` */
  elementRegistry: ReadonlyMap<ElementId, IdsElement>;
  /** `kind: screen` files by id */
  screens: ReadonlyMap<ScreenId, ScreenFile>;
  /** `kind: gate` files by id */
  gates: ReadonlyMap<GateId, ScreenFile>;
  recipes: ReadonlyMap<RecipeId, RecipeFile>;
  /** element id → every declaration */
  elements: ReadonlyMap<ElementId, ElementRef[]>;
  /** marker (`screen.<id>`) → screen id */
  markers: ReadonlyMap<string, ScreenId>;
  /** deep link (query stripped) → screen id */
  routes: ReadonlyMap<string, ScreenId>;
  /** static labels from screen files (element labels + titles) ∪ `.local/strings.<platform>.txt` */
  staticLabels: ReadonlySet<string>;
  /** git tree hash of `app-map/` at load time (03 §4 reload check); `undefined` outside a git repo */
  treeHash?: string;
  /** effective build number (config, driver or manifest) */
  build: BuildNumber;
  loadedAt: Timestamp;
}

// =============================================================================================
// Tool / CLI result shapes (03 §8, 03 §10)
// =============================================================================================

export interface SummaryResult {
  platform: Platform;
  build: BuildNumber;
  screens: number;
  screens_verified: number;
  recipes: Array<{ id: RecipeId; description: string; status: RecipeStatus }>;
  gates: GateId[];
  /** the ≤600-token text block injected at SessionStart (05 §3) */
  text: string;
}
export interface GetScreenResult {
  screen_id: ScreenId;
  /** fixed parse-stable block (03 §8) */
  text: string;
}
export type FindElementResult =
  | { found: true; screen_id: ScreenId; element: ElementId; hit: Omit<ResolveHit, 'node'>; /** ≤120-token text */ text: string }
  | { found: false; screen_id: ScreenId; element?: ElementId; miss?: ResolveMiss; candidates: Array<{ id: ElementId; intent?: string; label?: string }>; text: string };
export type PlanPathResult =
  | { kind: 'deep_link'; from: ScreenId | typeof UNKNOWN_SCREEN; to: ScreenId; deep_link: string }
  | { kind: 'edges'; from: ScreenId; to: ScreenId; edges: Array<{ from: ScreenId; action: EdgeAction; to: ScreenId }> }
  | { kind: 'none'; from: ScreenId | typeof UNKNOWN_SCREEN; to: ScreenId; reason: string };
export type MatchRecipeResult =
  | { matched: true; recipe_id: RecipeId; version: number; confidence: number; params_needed: string[]; description: string }
  | { matched: false; no_match: true; candidates: Array<{ id: RecipeId; description: string }>; /** ≤8 lines */ text: string };
export interface RecordResult {
  screen_before: ScreenId | typeof UNKNOWN_SCREEN;
  screen_after: ScreenId | typeof UNKNOWN_SCREEN;
  seq: number;
  gates_present: GateId[];
  scrub_hits: number;
}
export interface RecordObservationInput {
  session?: SessionId;
  tool: string;
  input: DriverInput;
  snapshot: unknown;
  ok: boolean;
  error?: string;
  latency_ms?: number;
}
export interface NameScreenInput { screen_id: ScreenId; title?: string; deep_link?: string; session?: SessionId }
export interface NameScreenResult { screen: ScreenFile; created: boolean; from_seq: number }
export interface CompileRecipeInput {
  session: SessionId;
  task: string;
  recipe_id: RecipeId;
  params: RecipeParam[];
  /** when set, compile a revision of this recipe (04 §8) */
  revision_of?: number;
  /** start compiling at this seq (guided_fallback revisions) */
  from_seq?: number;
}
export type CompileRecipeResult =
  | { ok: true; recipe: RecipeFile; /** canonical YAML for review */ yaml: string; collapsed_observations: number; warnings: string[] }
  | { ok: false; reason: 'unparameterized_value' | 'no_task' | 'no_observations' | 'loops_never_converge' | 'missing_postcondition' | 'unknown_screen'; message: string; offending_values?: string[] };
export interface MarkRecipeResult { recipe_id: RecipeId; from: RecipeStatus | null; to: RecipeStatus; written: boolean }
export interface ExportResult {
  /** relative paths written */
  written: string[];
  /** paths skipped because unchanged */
  unchanged: string[];
  /** paths refused because the git blob changed since load (03 §4); non-empty ⇒ rerun with --force or reload */
  conflicts: Array<{ path: string; diff: string }>;
  /** `--check` mode: paths whose canonical form differs from disk (06 R1) */
  non_canonical: string[];
}
export interface ValidationIssue {
  /** 02 §10 rule number (1–8) */
  rule: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  severity: 'error' | 'warning';
  /** path relative to `APP_MAP_DIR` */
  file: string;
  /** JSON pointer-ish location inside the file */
  location?: string;
  message: string;
}
export interface ValidateResult { ok: boolean; issues: ValidationIssue[]; files_checked: number }
export interface MigrateIdResult { old_id: ElementId | ScreenId; new_id: string; files_changed: string[]; references: number }
export interface ImportRouterResult { created: ScreenId[]; updated: ScreenId[]; retired: ScreenId[]; unchanged: ScreenId[]; edges_added: number }
export interface MaestroExportResult { flows: Array<{ recipe: RecipeId; path: string; eligible: boolean; ineligible_steps: StepId[] }>; out_dir: string }
export interface LintIdsResult { ok: boolean; issues: Array<{ rule: 'marker_unreferenced' | 'bad_id' | 'orphan_constant' | 'string_literal_id' | 'generated_out_of_sync'; message: string; file?: string; line?: number }> }
export interface GenConfigsResult { written: string[]; stale: string[]; ok: boolean }
export interface PolicyCheckResult { ok: boolean; violations: Array<{ rule: 'unlisted_server' | 'unpinned_npx' | 'secret_literal' | 'hook_outside_dir'; file: string; message: string }> }
export interface MergeResult { merged: string; conflicts: Array<{ path: string; base?: unknown; ours: unknown; theirs: unknown }> }

/** 08 §4 steady-state metrics for one platform over a window */
export interface ReportMetrics {
  platform: Platform;
  since: Timestamp;
  until: Timestamp;
  replay_rate: number;
  fallback_rate_per_recipe: Record<RecipeId, number>;
  heal_rate_per_100_runs: number;
  pending_review_heals: number;
  intent_critical_rejections: number;
  brittleness_index: number;
  unknown_screen_rate: number;
  map_coverage: number;
  convergence: Record<RecipeId, number[]>;
  alerts: string[];
  /** 08 §3 baseline counters when `task` events exist */
  tasks: { count: number; success_rate: number; driver_calls_mean: number; perception_bytes_mean: number; screenshots_mean: number; ms_mean: number };
}

// =============================================================================================
// Helpers on types (pure, cheap; live here so every layer can use them without a dependency)
// =============================================================================================

export function isGateId(id: string): boolean {
  return GATE_ID_REGEX.test(id);
}
export function isMarker(id: string | undefined): id is string {
  return typeof id === 'string' && MARKER_REGEX.test(id);
}
export function screenIdOfMarker(marker: string): ScreenId | undefined {
  const m = MARKER_REGEX.exec(marker);
  return m?.[1];
}
export function markerOfScreen(screenId: ScreenId): string {
  return `screen.${screenId}`;
}
/** `appmap://invoice_new?fixture=x` → `invoice_new` */
export function screenIdOfDeepLink(url: string): ScreenId | undefined {
  const m = DEEP_LINK_REGEX.exec(url);
  return m?.[1];
}
/** strip the query so routes index by screen (`appmap://x?y=1` → `appmap://x`) */
export function routeKey(url: string): string {
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}
/** the element a step acts on, if any */
export function stepElement(step: RecipeStep): ElementId | undefined {
  switch (step.action) {
    case 'tap': case 'type': return step.element;
    case 'select': return step.list;
    case 'swipe': return step.element;
    default: return undefined;
  }
}
/** the element an edge action acts on, if any */
export function edgeElement(action: EdgeAction): ElementId | undefined {
  switch (action.type) {
    case 'tap': case 'type': case 'select': return action.element;
    case 'swipe': return action.element;
    default: return undefined;
  }
}
export function isScrubbed(t: AnyTree): t is ScrubbedTree {
  return t.scrubbed === true;
}
export function now(): Timestamp {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
