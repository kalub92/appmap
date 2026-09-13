/**
 * [B1] Accessibility-tree normalization and queries (03 §5 input, 03 §6, 02 §5.1 `path`).
 *
 * Input shapes accepted by `normalizeTree` (detected by `detectTreeShape`):
 *  - `normalized`: our own `Tree` JSON (`{schema_version:1, platform, root:{role,…,children}}`),
 *    e.g. fixtures/trees/*.normalized.json — returned as-is after a structural check;
 *  - `argent`: what `@swmansion/argent@0.25.0` really returns from `argent run
 *    native-describe-screen --json` (issue #10) — a FLAT element list, no nesting at all:
 *    `{status?:'ok', screenFrame:{x,y,width,height}, elements:[{frame, normalizedFrame,
 *    normalizedTapPoint?, tapPoint?, traits:[…], value?, label?, identifier?, viewClassName}]}`.
 *    There is no `type`, no `children`, no `enabled` and NO focus flag of any name — `hasFocus`
 *    and `focused` belong to the nested shape below, not to Argent (issue #18 owns what that
 *    means for `expect.focused`). See `fromArgentScreen` for the two-level rebuild;
 *  - `xcuitest`: the nested XCUITest-like snapshot some other drivers emit — `{type,
 *    identifier?, label?, value?, enabled?, hasFocus?, selected?, frame:{x,y,width,height},
 *    children[]}` possibly wrapped as `{root, screen:{width,height}, build_number?, bundle_id?,
 *    udid?}` (fixtures/raw/xcuitest-snapshot.invoice_list.json — best-effort). The wrapper's
 *    `build_number` → `Tree.build` and `bundle_id` → `Tree.app_id` (03 §3 `APP_MAP_BUILD=auto`,
 *    03 §13; observe.ts calls `ctx.setBuild`); `udid` is dropped (07 §2.2 device identifiers).
 *    The flat Argent capture carries neither, so `APP_MAP_BUILD=auto` falls back to config there;
 *  - `maestro`: `maestro hierarchy` JSON `{elements:[{attributes:{resource-id,text,
 *    accessibilityText,bounds:"[x1,y1][x2,y2]",class,enabled,focused,selected,…},children}]}`
 *    or the bare `{attributes, children}` root (fixtures/raw/maestro-hierarchy.invoice_list.json
 *    — best-effort, verify at implementation time). Maestro ALSO keys on `elements`, so the flat
 *    Argent branch is guarded on `screenFrame` plus the absence of maestro's `attributes`.
 *  `argent run describe` returns `{description:'<indented text>', source}` instead of JSON; it is
 *  deliberately `unknown` rather than mis-detected as one of the above.
 *
 * Role mapping (`ROLE_MAP_XCUI`, `ROLE_MAP_ANDROID`, `ROLE_MAP_ARGENT_CLASS`/`_TRAIT`): unknown
 * types → `other`; a `Button` whose parent is a `TabBar` → `tab`; a `StaticText` inside a `Cell`
 * stays `staticText`. `bbox_norm` = frame ÷ viewport (viewport = wrapper `screen`, else the root
 * frame; `screenFrame` for the flat shape, which also ships a ready `normalizedFrame` that is
 * used verbatim), clamped to [0,1] and rounded to 4 decimals. Empty strings for
 * `identifier`/`resource-id` mean "absent".
 *
 * Flat-capture rebuild (`fromArgentScreen`, ported from the reference integration's Python
 * bridge): `application > window > [marker-subtree, tabBar?]` and nothing deeper — deeper nesting
 * is not recoverable from a flat list and is not needed, because `a11y_id` is the weight-1
 * locator (02 §5.1) and inventing frame-containment would change every `path`,
 * `fingerprint.parent_role` and `sibling_index` the map has already learned. Four rules:
 *   1. exact-duplicate elements collapse (`dedupeArgentElements`) — the iOS AX service reports
 *      the tab bar twice, once with identifiers and once without;
 *   2. only the deepest marker survives (01 R3 as amended for pushed screens, see
 *      `deepestMarker`); the markers it covers are dropped, not kept as siblings;
 *   3. the surviving marker becomes a full-screen `container` (its own 1pt overlay frame — see
 *      issue #15 — is discarded) and every non-tab element becomes its direct child, in capture
 *      order, which is what `sibling_index` records;
 *   4. elements whose role is `tab` are collected into a `tabBar` sibling, sorted by x.
 *
 * Maestro derivations (best-effort, architecture.md decisions 22 and 28: Android trees must
 * hash like the iOS ones, and `tab` is derived): the hierarchy root → `application`; a
 * container child of the root with the root's bbox → `window`; a container/other directly under
 * a `list` → `cell`; a full-width bottom-anchored container whose children are all buttons →
 * `tabBar` (its buttons → `tab`); the first child of a marker node when it is a full-width,
 * top-aligned, short container carrying a label or a button → `navigationBar`. Nodes with a
 * class the map resolves to something more specific are never re-derived. For text-input roles
 * the Android `text` attribute is the typed content and lands in `value` (07 §2.3.1 drops it),
 * never in `label`.
 *
 * `pathOf(tree, node)`: roles from the screen root (`deepestMarker`, else the tree root) —
 * exclusive — down to `node`; each segment is `role` when the node is the
 * only child of that role among its siblings, else `role[i]` with `i` the 0-based index among
 * same-role siblings. Example: `navigationBar/button[1]`. This matches the pilot files exactly.
 * A node outside the marker subtree (an OS alert beside the screen container) is addressed from
 * the lowest common ancestor of the node and the marker (`alert/button` in the pilot gates).
 *
 * Layer: tree (imports types/errors/config only). All functions are pure.
 */
import type { Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import type { AnyTree, BBoxNorm, Role, Tree, TreeNode, TreeSource } from './types.ts';
import { ROLES, TREE_SOURCES, isMarker } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';

export type TreeShape = 'normalized' | 'argent' | 'xcuitest' | 'maestro' | 'unknown';

/** XCUIElementType names → role (best-effort; unknown → `other`). */
export const ROLE_MAP_XCUI: Readonly<Record<string, Role>> = {
  Application: 'application', Window: 'window', Other: 'container', Group: 'container', NavigationBar: 'navigationBar',
  TabBar: 'tabBar', Toolbar: 'toolbar', ScrollView: 'scrollView', Table: 'list', CollectionView: 'list', Cell: 'cell',
  Button: 'button', Link: 'link', Switch: 'toggle', Toggle: 'toggle', TextField: 'field', TextView: 'field',
  SecureTextField: 'secureField', SearchField: 'searchField', Picker: 'picker', PickerWheel: 'picker', DatePicker: 'picker',
  StaticText: 'staticText', Image: 'image', Alert: 'alert', Sheet: 'sheet', Keyboard: 'keyboard', Key: 'key',
};

/** Android class names (suffix match; the longest matching key wins) → role. */
export const ROLE_MAP_ANDROID: Readonly<Record<string, Role>> = {
  FrameLayout: 'container', LinearLayout: 'container', RelativeLayout: 'container', ViewGroup: 'container', ComposeView: 'container',
  ScrollView: 'scrollView', NestedScrollView: 'scrollView', RecyclerView: 'list', ListView: 'list', Button: 'button',
  ImageButton: 'button', Switch: 'toggle', CheckBox: 'toggle', EditText: 'field', TextView: 'staticText', ImageView: 'image',
  Spinner: 'picker', Toolbar: 'navigationBar', BottomNavigationView: 'tabBar', View: 'other',
  // extra suffixes seen on AppCompat/Material widgets (best-effort)
  SwitchCompat: 'toggle', RadioButton: 'toggle', ToggleButton: 'toggle', SearchView: 'searchField', TabLayout: 'tabBar',
  HorizontalScrollView: 'scrollView', WebView: 'container', ViewPager: 'container', ProgressBar: 'other',
};

const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const TEXT_INPUT_ROLES: ReadonlySet<Role> = new Set<Role>(['field', 'secureField', 'searchField']);
const INTERACTIVE_ROLES: ReadonlySet<Role> = new Set<Role>([
  'button', 'link', 'tab', 'toggle', 'field', 'secureField', 'searchField', 'picker', 'list', 'cell', 'key',
]);
const GENERIC_ROLES: ReadonlySet<Role> = new Set<Role>(['container', 'other']);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function badInput(message: string, hint: string): AppMapError {
  return new AppMapError(ERROR_CODES.BAD_INPUT, message, hint);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function num(x: unknown): number {
  if (typeof x === 'number' && Number.isFinite(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return 0;
}

function optString(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined;
}

/** `"true"`/`true` → true, `"false"`/`false` → false, anything else → undefined */
function optBool(x: unknown): boolean | undefined {
  if (typeof x === 'boolean') return x;
  if (x === 'true') return true;
  if (x === 'false') return false;
  return undefined;
}

/** frame ÷ viewport, clamped to [0,1], 4 decimals (header). A zero viewport yields zeros. */
function normalizeBBox(x: number, y: number, w: number, h: number, vw: number, vh: number): BBoxNorm {
  const sx = vw > 0 ? vw : 0;
  const sy = vh > 0 ? vh : 0;
  return {
    x: round4(clamp01(sx ? x / sx : 0)),
    y: round4(clamp01(sy ? y / sy : 0)),
    w: round4(clamp01(sx ? w / sx : 0)),
    h: round4(clamp01(sy ? h / sy : 0)),
  };
}

function isXcuiNode(x: unknown): x is Record<string, unknown> {
  return isRecord(x) && typeof x['type'] === 'string' && (isRecord(x['frame']) || Array.isArray(x['children']));
}

function isMaestroNode(x: unknown): x is Record<string, unknown> {
  return isRecord(x) && isRecord(x['attributes']);
}

/**
 * `argent run native-describe-screen --json` (issue #10): a viewport plus a flat `elements`
 * array. Maestro dumps ALSO carry `elements`, so two things must both hold — a `screenFrame`
 * (maestro has none) and no element carrying maestro's `attributes` object.
 */
function isArgentScreen(x: unknown): x is Record<string, unknown> {
  if (!isRecord(x) || !isRecord(x['screenFrame'])) return false;
  const elements = x['elements'];
  return Array.isArray(elements) && !elements.some(isMaestroNode);
}

export function detectTreeShape(input: unknown): TreeShape {
  if (!isRecord(input)) return 'unknown';
  const self: unknown = input; // a fresh reference: the guards below must not narrow `input` to never
  const root = input['root'];
  if (input['schema_version'] === 1 && isRecord(root) && typeof root['role'] === 'string') return 'normalized';
  if (isXcuiNode(root) || isXcuiNode(self)) return 'xcuitest';
  if (isArgentScreen(self)) return 'argent';
  const elements = input['elements'];
  if ((Array.isArray(elements) && elements.some(isMaestroNode)) || isMaestroNode(self)) return 'maestro';
  return 'unknown';
}

/**
 * Deepest node the converters will walk. A pathologically deep snapshot is a bad input, not an
 * internal error: without this the recursive walk blows the stack with a raw `RangeError`, which
 * reaches the caller as `code: internal` and no actionable hint (03 §11, 05 §6.2).
 */
export const MAX_TREE_DEPTH = 512;

function assertDepth(depth: number): void {
  if (depth <= MAX_TREE_DEPTH) return;
  throw badInput(
    `accessibility tree is deeper than ${MAX_TREE_DEPTH} levels`,
    'ask the driver for a compact tree (05 §6.2)',
  );
}

/**
 * Normalize any accepted shape to a raw `Tree` (never scrubbed). Throws `AppMapError(bad_input)`
 * with a hint naming the shape problem. `opts.source` defaults from the detected shape.
 * `opts.roleHints` (`roleHintsFor(map)`) is consulted only by the flat Argent branch, the one
 * shape whose elements carry no type of their own; every other shape ignores it.
 */
export function normalizeTree(
  input: unknown,
  opts: { platform: Platform; source?: TreeSource; roleHints?: ReadonlyMap<string, Role> },
): Tree {
  let data: unknown = input;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      throw badInput('tree input is a string that is not valid JSON', 'pass the parsed snapshot object or a JSON document');
    }
  }
  const shape = detectTreeShape(data);
  let tree: Tree;
  switch (shape) {
    case 'normalized': {
      const issue = normalizedTreeIssue(data);
      if (issue !== undefined) throw badInput(`normalized tree is malformed: ${issue}`, 'see TreeNode in src/types.ts for the accepted shape');
      // A `scrubbed` marker on the input is not trusted: the runtime brand is only ever minted
      // by scrub() (03 §7), so the result is always a raw tree that must be scrubbed again.
      const { scrubbed: _scrubbed, scrub_hits: _hits, ...rest } = data as Tree & { scrub_hits?: number };
      void _scrubbed; void _hits;
      tree = rest as Tree;
      break;
    }
    case 'argent':
      tree = fromArgentScreen(data, opts.platform, { ...(opts.roleHints !== undefined ? { roleHints: opts.roleHints } : {}) });
      break;
    case 'xcuitest':
      tree = fromXcuiSnapshot(data, opts.platform);
      break;
    case 'maestro':
      tree = fromMaestroHierarchy(data, opts.platform);
      break;
    default:
      throw badInput(
        'unrecognized tree shape',
        'expected a normalized Tree ({schema_version: 1, root: {role, …}}), an Argent screen capture ({screenFrame, elements: [{frame, traits, viewClassName}]}), an XCUITest-like snapshot ({root: {type, frame, children}}) or a maestro hierarchy ({elements: [{attributes, children}]})',
      );
  }
  return opts.source !== undefined && opts.source !== tree.source ? { ...tree, source: opts.source } : tree;
}

// ---------------------------------------------------------------------------------------------
// XCUITest-like nested snapshot
// ---------------------------------------------------------------------------------------------

/**
 * The nested `{type, frame, children}` snapshot (optionally wrapped in `{root, screen, …}`).
 * NOT what `@swmansion/argent` returns — see `fromArgentScreen` for that (issue #10) — but some
 * drivers do emit this shape and the hook fixtures use it, so it keeps its own branch.
 */
export function fromXcuiSnapshot(input: unknown, platform: Platform): Tree {
  if (!isRecord(input)) throw badInput('XCUITest snapshot is not an object', 'expected {root: {type, frame, children}} or a bare node');
  const wrapper = isRecord(input['root']) ? input : undefined;
  const rawRoot = wrapper ? wrapper['root'] : input;
  if (!isXcuiNode(rawRoot)) throw badInput('XCUITest snapshot has no root node', 'the root must carry a string `type` and a `frame` or `children`');

  const rootFrame = isRecord(rawRoot['frame']) ? rawRoot['frame'] : {};
  let vw = 0;
  let vh = 0;
  const screen = wrapper && isRecord(wrapper['screen']) ? wrapper['screen'] : undefined;
  if (screen) {
    vw = num(screen['width']);
    vh = num(screen['height']);
  }
  if (vw <= 0 || vh <= 0) {
    vw = num(rootFrame['width']);
    vh = num(rootFrame['height']);
  }
  const root = convertXcuiNode(rawRoot, undefined, vw, vh);
  const tree: Tree = { schema_version: 1, platform, source: 'xcuitest', root };
  if (vw > 0 && vh > 0) tree.viewport = { w: vw, h: vh };
  if (wrapper) {
    // 03 §3 / 03 §13: the driver-reported build; `udid` (07 §2.2) is deliberately not copied.
    const build = wrapper['build_number'];
    if (typeof build === 'string' && build !== '') tree.build = build;
    else if (typeof build === 'number' && Number.isFinite(build)) tree.build = String(build);
    const bundle = optString(wrapper['bundle_id']);
    if (bundle !== undefined) tree.app_id = bundle;
    const route = optString(wrapper['route']);
    if (route !== undefined) tree.route = route;
    const captured = optString(wrapper['captured_at']);
    if (captured !== undefined) tree.captured_at = captured;
  }
  // build order: viewport before root for a readable compact form
  return reorderTree(tree);
}

function convertXcuiNode(n: Record<string, unknown>, parentType: string | undefined, vw: number, vh: number, depth = 0): TreeNode {
  assertDepth(depth);
  const type = typeof n['type'] === 'string' ? n['type'] : '';
  const kids = n['children'];
  const id = optString(n['identifier']);
  // header: a Button whose parent is a TabBar → tab
  let role: Role = parentType === 'TabBar' && type === 'Button' ? 'tab' : (ROLE_MAP_XCUI[type] ?? 'other');
  // An id-less `Other`/`Group` that groups fewer than two children is a leaf decoration (status
  // bar, divider line) — `other`, as in the pilot trees; a real grouping stays `container`.
  if (role === 'container' && id === undefined && (!Array.isArray(kids) || kids.length < 2)) role = 'other';
  const frame = isRecord(n['frame']) ? n['frame'] : {};
  const node: TreeNode = { role, bbox_norm: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
  if (id !== undefined) node.a11y_id = id;
  if (typeof n['label'] === 'string') node.label = n['label'];
  const value = n['value'];
  if (typeof value === 'string') node.value = value;
  else if (typeof value === 'number' || typeof value === 'boolean') node.value = String(value);
  const enabled = optBool(n['enabled']);
  if (enabled !== undefined) node.enabled = enabled;
  const focused = optBool(n['hasFocus'] ?? n['focused']);
  if (focused !== undefined) node.focused = focused;
  const selected = optBool(n['selected']);
  if (selected !== undefined) node.selected = selected;
  node.bbox_norm = normalizeBBox(num(frame['x']), num(frame['y']), num(frame['width']), num(frame['height']), vw, vh);
  if (Array.isArray(kids)) {
    for (const k of kids) if (isRecord(k)) node.children.push(convertXcuiNode(k, type, vw, vh, depth + 1));
  }
  return node;
}

// ---------------------------------------------------------------------------------------------
// Argent — the real `native-describe-screen` flat capture (03 §5, issue #10)
// ---------------------------------------------------------------------------------------------

/**
 * `viewClassName` → role. Exact match first, then the longest matching suffix (as `androidRole`
 * does), so `SwiftUI.ListCollectionViewCell` lands on `ListCollectionViewCell`. The list-row
 * classes are best-effort — the exact class SwiftUI reports for a `List` row is not documented —
 * but a REGISTERED row is also covered by its `roleHints` entry whatever class it reports, so a
 * wrong guess there degrades to the registry rather than to a wrong role.
 */
export const ROLE_MAP_ARGENT_CLASS: Readonly<Record<string, Role>> = {
  UITextField: 'field', UITextView: 'field', UISearchBar: 'searchField',
  UILabel: 'staticText', UIImageView: 'image', UISwitch: 'toggle', UIButton: 'button',
  UITabBar: 'tabBar', UINavigationBar: 'navigationBar', UIToolbar: 'toolbar', UIScrollView: 'scrollView',
  UITableView: 'list', UICollectionView: 'list', UIPickerView: 'picker', UIDatePicker: 'picker',
  _UITabButton: 'tab', _UIButtonBarButton: 'button',
  // suffix keys: SwiftUI list rows (`SwiftUI.ListCollectionViewCell`, `_UICollectionViewListCell`)
  // and the UIKit cells they wrap
  TableViewCell: 'cell', CollectionViewCell: 'cell', ListCollectionViewCell: 'cell',
};

/**
 * A `traits[]` entry → role. The values the issue reports observing are `button`, `staticText`,
 * `header`, `image` and `selected`; `link`, `searchField` and `keyboardKey` are the remaining
 * UIAccessibilityTraits that name a role we have. `selected` carries no role (it becomes
 * `TreeNode.selected`), and there is no focus trait at all — Argent does not report focus in any
 * form (issue #10, issue #18).
 */
export const ROLE_MAP_ARGENT_TRAIT: Readonly<Record<string, Role>> = {
  button: 'button', link: 'link', image: 'image', staticText: 'staticText',
  header: 'staticText', searchField: 'searchField', keyboardKey: 'key',
};

/**
 * Roles that are a MORE specific spelling of a registry kind's role. A `kind: field` hint must
 * never demote a capture that says `searchField`/`secureField`, nor `kind: list` a `scrollView`.
 */
const KIND_SPECIALIZATIONS: Readonly<Partial<Record<Role, readonly Role[]>>> = {
  field: ['searchField', 'secureField'],
  list: ['scrollView'],
};

export interface ArgentScreenOptions {
  /** `roleHintsFor(map)` — `ids.yaml` kinds as roles, for elements the capture cannot type */
  roleHints?: ReadonlyMap<string, Role>;
}

const FULL_SCREEN: BBoxNorm = { x: 0, y: 0, w: 1, h: 1 };

function full(): BBoxNorm {
  return { ...FULL_SCREEN };
}

/** longest-suffix class lookup; exact matches win (`_UITabButton` is not a `UIButton`) */
function argentClassRole(cls: string | undefined): Role | undefined {
  if (cls === undefined) return undefined;
  const short = cls.split(/[.$]/).pop() ?? cls;
  const exact = ROLE_MAP_ARGENT_CLASS[short];
  if (exact !== undefined) return exact;
  let best: string | undefined;
  for (const key of Object.keys(ROLE_MAP_ARGENT_CLASS)) {
    if (short.endsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : ROLE_MAP_ARGENT_CLASS[best];
}

/** first trait (in the element's own order) that names a role */
function argentTraitRole(traits: unknown): Role | undefined {
  if (!Array.isArray(traits)) return undefined;
  for (const t of traits) {
    if (typeof t !== 'string') continue;
    const role = ROLE_MAP_ARGENT_TRAIT[t];
    if (role !== undefined) return role;
  }
  return undefined;
}

function hasTrait(traits: unknown, want: string): boolean {
  return Array.isArray(traits) && traits.some((t) => t === want);
}

/**
 * Role of one flat element: the screen marker IS the screen container (01 R3) whatever class the
 * 1pt overlay of issue #15 reports; otherwise `viewClassName`, then `traits`, then the registry
 * hint — which only fills a gap and never demotes a more specific derived role.
 */
function argentRole(el: Record<string, unknown>, hints: ReadonlyMap<string, Role> | undefined): Role {
  const id = optString(el['identifier']);
  if (isMarker(id)) return 'container';
  const derived = argentClassRole(optString(el['viewClassName'])) ?? argentTraitRole(el['traits']);
  const hint = id === undefined ? undefined : hints?.get(id);
  if (hint === undefined) return derived ?? 'other';
  if (derived !== undefined && (KIND_SPECIALIZATIONS[hint] ?? []).includes(derived)) return derived;
  return hint;
}

/**
 * The element's frame in 0..1, UNCLAMPED: `normalizedFrame` verbatim (rounded to 4) when the
 * driver sent one, else `frame` ÷ `screenFrame`. Verbatim matters — the real capture's
 * `normalizedFrame.width` 0.7902 and its `frame.width / screenFrame.width` 0.790299 → 0.7903
 * disagree in the last digit, and the map learned from the driver's own number. Unclamped
 * matters for `dedupeArgentElements`: two list rows that both hang below the fold clamp to the
 * same box but are not the same element.
 */
function argentFrame(el: Record<string, unknown>, vw: number, vh: number): BBoxNorm {
  const nf = el['normalizedFrame'];
  if (isRecord(nf)) {
    return { x: round4(num(nf['x'])), y: round4(num(nf['y'])), w: round4(num(nf['width'])), h: round4(num(nf['height'])) };
  }
  const f = isRecord(el['frame']) ? el['frame'] : {};
  const sx = vw > 0 ? vw : 0;
  const sy = vh > 0 ? vh : 0;
  return {
    x: round4(sx ? num(f['x']) / sx : 0), y: round4(sy ? num(f['y']) / sy : 0),
    w: round4(sx ? num(f['width']) / sx : 0), h: round4(sy ? num(f['height']) / sy : 0),
  };
}

function clampBBox(b: BBoxNorm): BBoxNorm {
  return { x: round4(clamp01(b.x)), y: round4(clamp01(b.y)), w: round4(clamp01(b.w)), h: round4(clamp01(b.h)) };
}

/**
 * One element per `(normalized frame, label, value)`, preferring the twin that carries an
 * `identifier` and keeping the first twin's position in capture order (`sibling_index`, 02 §5.1).
 *
 * This is a GENERAL exact-duplicate rule, not a tab-bar special case, even though the tab bar is
 * where it bites (the iOS AX service reports every tab twice, once identified and once not, and
 * the map then sees six tabs and rejects every tab heal as `ambiguous` — issue #10). Two elements
 * that share an identical normalized frame AND an identical label and value are one control the
 * AX service reported twice: no locator strategy we have could ever tell them apart, so keeping
 * both only manufactures ambiguity and doubles every `sibling_index`. Restricting the rule to the
 * tab bar would need a tab-bar detector that itself depends on the duplicates already being gone.
 * The deliberate cost: two genuinely distinct, exactly coincident controls with the same label
 * collapse into one — which no locator could have addressed separately anyway.
 */
export function dedupeArgentElements(
  elements: readonly Record<string, unknown>[], vw: number, vh: number,
): Record<string, unknown>[] {
  const slots = new Map<string, number>();
  const out: Record<string, unknown>[] = [];
  for (const el of elements) {
    const b = argentFrame(el, vw, vh);
    const key = `${b.x}|${b.y}|${b.w}|${b.h}|${optString(el['label']) ?? ''}|${optString(el['value']) ?? ''}`;
    const at = slots.get(key);
    if (at === undefined) {
      slots.set(key, out.length);
      out.push(el);
    } else if (optString(out[at]!['identifier']) === undefined && optString(el['identifier']) !== undefined) {
      out[at] = el;
    }
  }
  return out;
}

function argentNode(el: Record<string, unknown>, role: Role, vw: number, vh: number): TreeNode {
  const node: TreeNode = { role, bbox_norm: clampBBox(argentFrame(el, vw, vh)), children: [] };
  const id = optString(el['identifier']);
  if (id !== undefined) node.a11y_id = id;
  const label = optString(el['label']);
  if (label !== undefined) node.label = label;
  const value = optString(el['value']);
  if (value !== undefined) node.value = value;
  // only the positive: Argent reports `selected` as a trait and never its absence, and it reports
  // neither `enabled` nor any focus flag — a false here would be an invention (issue #10/#18)
  if (hasTrait(el['traits'], 'selected')) node.selected = true;
  return node;
}

/**
 * Normalize `argent run native-describe-screen --json` (issue #10). See the header for the
 * two-level rebuild and the four rules; `opts.roleHints` types the elements the capture cannot.
 */
export function fromArgentScreen(input: unknown, platform: Platform, opts: ArgentScreenOptions = {}): Tree {
  if (!isRecord(input)) throw badInput('argent screen capture is not an object', 'expected {screenFrame: {width, height}, elements: [{frame, traits, viewClassName}]}');
  const status = input['status'];
  if (typeof status === 'string' && status !== 'ok') {
    throw badInput(`argent reported status ${JSON.stringify(status)}`, 'only a capture with `status: "ok"` carries a usable element list — retry the capture');
  }
  const screen = input['screenFrame'];
  if (!isRecord(screen)) throw badInput('argent screen capture has no screenFrame', 'expected {screenFrame: {x, y, width, height}, elements: […]}');
  const rawElements = input['elements'];
  if (!Array.isArray(rawElements)) throw badInput('argent screen capture has no elements array', 'expected {screenFrame: {…}, elements: [{frame, traits, viewClassName}]}');
  // `screenFrame.x/y` are ignored: `normalizedFrame` is already viewport-relative
  const vw = num(screen['width']);
  const vh = num(screen['height']);

  const unique = dedupeArgentElements(rawElements.filter(isRecord), vw, vh);

  // 01 R3 as amended (issue #10): a pushed detail screen leaves the covered screen's marker in
  // the tree. This is `deepestMarker`'s rule applied before the rebuild, and it reduces to the
  // same answer: a flat capture has no hierarchy, so every marker is at the same depth and `y`
  // decides — the lower marker is the one the pushed screen drew — with document order (last
  // wins) breaking an exact tie, exactly as `deepestMarker` does.
  let top: Record<string, unknown> | undefined;
  let topY = -1;
  for (const el of unique) {
    if (!isMarker(optString(el['identifier']))) continue;
    const y = argentFrame(el, vw, vh).y;
    if (y >= topY) { top = el; topY = y; }
  }

  let marker: TreeNode | undefined;
  const tabs: TreeNode[] = [];
  const body: TreeNode[] = [];
  for (const el of unique) {
    const role = argentRole(el, opts.roleHints);
    if (isMarker(optString(el['identifier']))) {
      // every marker the top one covers is dropped: keeping it would shift every `sibling_index`
      // and change `structural_hash` (02 §4.4)
      if (el !== top) continue;
      marker = argentNode(el, role, vw, vh);
      // the 1pt marker overlay (issue #15) carries no geometry worth keeping: the screen
      // container IS the screen, so `pathOf`/`resolve` get a real full-screen subtree
      marker.bbox_norm = full();
      continue;
    }
    (role === 'tab' ? tabs : body).push(argentNode(el, role, vw, vh));
  }
  // no marker on screen (an OS dialog, or a miss): the container still exists so `pathOf` works
  if (marker === undefined) marker = { role: 'container', bbox_norm: full(), children: [] };
  marker.children = body;

  const windowChildren: TreeNode[] = [marker];
  if (tabs.length > 0) {
    let barY = 1;
    for (const t of tabs) barY = Math.min(barY, t.bbox_norm.y);
    windowChildren.push({
      role: 'tabBar',
      bbox_norm: { x: 0, y: round4(barY), w: 1, h: round4(1 - barY) },
      children: [...tabs].sort((a, b) => a.bbox_norm.x - b.bbox_norm.x),
    });
  }

  const root: TreeNode = {
    role: 'application', bbox_norm: full(),
    children: [{ role: 'window', bbox_norm: full(), children: windowChildren }],
  };
  const tree: Tree = { schema_version: 1, platform, source: 'argent', root };
  if (vw > 0 && vh > 0) tree.viewport = { w: vw, h: vh };
  // no `build` / `app_id`: the flat capture reports neither (the bundle id is an *argument* to
  // the CLI, not part of its answer), so `APP_MAP_BUILD=auto` falls back to config here (03 §3)
  return reorderTree(tree);
}

// ---------------------------------------------------------------------------------------------
// Maestro hierarchy
// ---------------------------------------------------------------------------------------------

const BOUNDS_RE = /\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/;

interface RawBounds { x: number; y: number; w: number; h: number }

function parseBounds(attrs: Record<string, unknown>): RawBounds {
  const b = attrs['bounds'];
  if (typeof b === 'string') {
    const m = BOUNDS_RE.exec(b);
    if (m) {
      const x1 = Number(m[1]); const y1 = Number(m[2]); const x2 = Number(m[3]); const y2 = Number(m[4]);
      return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1) };
    }
  } else if (isRecord(b)) {
    // tolerate an object form {x, y, width, height} or {left, top, right, bottom}
    if ('width' in b || 'height' in b) return { x: num(b['x']), y: num(b['y']), w: num(b['width']), h: num(b['height']) };
    if ('right' in b || 'bottom' in b) {
      const l = num(b['left']); const t = num(b['top']);
      return { x: l, y: t, w: Math.max(0, num(b['right']) - l), h: Math.max(0, num(b['bottom']) - t) };
    }
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

/** suffix match on the class name; the longest matching key wins (`BottomNavigationView` beats `View`) */
function androidRole(cls: string): Role {
  const short = cls.split(/[.$]/).pop() ?? cls;
  let best: string | undefined;
  for (const key of Object.keys(ROLE_MAP_ANDROID)) {
    if (short === key || short.endsWith(key)) {
      if (best === undefined || key.length > best.length) best = key;
    }
  }
  return best === undefined ? 'other' : (ROLE_MAP_ANDROID[best] ?? 'other');
}

export function fromMaestroHierarchy(input: unknown, platform: Platform): Tree {
  if (!isRecord(input)) throw badInput('maestro hierarchy is not an object', 'expected {elements: [{attributes, children}]} or a bare {attributes, children} node');
  let roots: Record<string, unknown>[];
  const elements = input['elements'];
  if (Array.isArray(elements)) roots = elements.filter(isMaestroNode);
  else if (isMaestroNode(input)) roots = [input];
  else throw badInput('maestro hierarchy has no elements', 'expected {elements: [{attributes, children}]} or a bare {attributes, children} node');
  if (roots.length === 0) throw badInput('maestro hierarchy has no elements', 'the `elements` array must contain at least one {attributes, children} node');

  // viewport = extent of the root bounds (x2, y2); a multi-root dump uses the union
  let vw = 0;
  let vh = 0;
  for (const r of roots) {
    const b = parseBounds(r['attributes'] as Record<string, unknown>);
    vw = Math.max(vw, b.x + b.w);
    vh = Math.max(vh, b.y + b.h);
  }
  let root: TreeNode;
  const rawSelected = new Map<TreeNode, boolean>();
  if (roots.length === 1) {
    root = convertMaestroNode(roots[0] as Record<string, unknown>, undefined, vw, vh, true, rawSelected);
  } else {
    root = { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: roots.map((r) => convertMaestroNode(r, undefined, vw, vh, false, rawSelected)) };
  }
  applyMaestroDerivations(root, undefined);
  const tree: Tree = { schema_version: 1, platform, source: 'maestro', root };
  if (vw > 0 && vh > 0) tree.viewport = { w: vw, h: vh };
  return reorderTree(tree);
}

/** `rawSelected` records the driver's `selected` per node so the parent can decide which `false`s to keep. */
function convertMaestroNode(
  n: Record<string, unknown>, parentRole: Role | undefined, vw: number, vh: number, isRoot: boolean, rawSelected: Map<TreeNode, boolean>, depth = 0,
): TreeNode {
  assertDepth(depth);
  const a = isRecord(n['attributes']) ? n['attributes'] : {};
  const cls = typeof a['class'] === 'string' ? a['class'] : '';
  let role: Role = androidRole(cls);
  if (isRoot && GENERIC_ROLES.has(role)) role = 'application';
  if (parentRole === 'tabBar' && role === 'button') role = 'tab';
  if (parentRole === 'list' && GENERIC_ROLES.has(role)) role = 'cell';

  const node: TreeNode = { role, bbox_norm: { x: 0, y: 0, w: 0, h: 0 }, children: [] };
  const id = optString(a['resource-id']) ?? optString(a['resourceId']);
  if (id !== undefined) node.a11y_id = id;

  const text = optString(a['text']);
  const accText = optString(a['accessibilityText']) ?? optString(a['content-desc']) ?? optString(a['contentDescription']);
  const hint = optString(a['hintText']) ?? optString(a['hint']);
  if (TEXT_INPUT_ROLES.has(role)) {
    // 07 §2.3.1: the text of an input is its typed content → `value`, never `label`
    const label = accText ?? hint;
    if (label !== undefined) node.label = label;
    if (text !== undefined) node.value = text;
  } else {
    const label = accText ?? text;
    if (label !== undefined) node.label = label;
    if (text !== undefined && text !== label) node.text = text;
  }

  const enabled = optBool(a['enabled']);
  const clickable = optBool(a['clickable']) === true;
  // XCUITest reports `enabled` on identified controls (pilot trees); mirror that so Android
  // trees look alike. A disabled node is always worth reporting.
  if (enabled !== undefined && (enabled === false || (id !== undefined && (clickable || INTERACTIVE_ROLES.has(role))))) node.enabled = enabled;
  const focused = optBool(a['focused']);
  if (focused !== undefined && (focused || TEXT_INPUT_ROLES.has(role))) node.focused = focused;
  const selected = optBool(a['selected']);
  const checked = optBool(a['checked']);
  if (selected === true) node.selected = true;
  else if (role === 'toggle' && checked !== undefined) node.selected = checked;
  if (selected !== undefined) rawSelected.set(node, selected);

  const b = parseBounds(a);
  node.bbox_norm = normalizeBBox(b.x, b.y, b.w, b.h, vw, vh);

  const kids = n['children'];
  if (Array.isArray(kids)) {
    for (const k of kids) if (isRecord(k)) node.children.push(convertMaestroNode(k, role, vw, vh, false, rawSelected, depth + 1));
  }
  // `selected: false` is kept only when a same-role sibling is selected (a segmented control / tab bar)
  const selectedRoles = new Set(node.children.filter((c) => c.selected === true).map((c) => c.role));
  for (const c of node.children) {
    if (c.selected === undefined && rawSelected.get(c) === false && selectedRoles.has(c.role)) c.selected = false;
  }
  return node;
}

/** Post-pass structural derivations (header "Maestro derivations"). Mutates in place. */
function applyMaestroDerivations(node: TreeNode, parent: TreeNode | undefined): void {
  const bb = node.bbox_norm;
  if (parent === undefined) {
    // children of the root that fill it are windows
    for (const c of node.children) {
      if (GENERIC_ROLES.has(c.role) && c.a11y_id === undefined && sameBBox(c.bbox_norm, bb)) c.role = 'window';
    }
  }
  if (GENERIC_ROLES.has(node.role) && node.children.length >= 2 && node.children.every((c) => c.role === 'button')
    && bb.w >= 0.9 && bb.y + bb.h >= 0.98) {
    node.role = 'tabBar';
    for (const c of node.children) c.role = 'tab';
  }
  if (isMarker(node.a11y_id) && node.children.length > 0) {
    const first = node.children[0]!;
    const fb = first.bbox_norm;
    if (GENERIC_ROLES.has(first.role) && first.a11y_id === undefined && fb.w >= 0.9 && fb.h <= 0.1
      && Math.abs(fb.y - bb.y) <= 0.005 && (first.label !== undefined || first.children.some((c) => c.role === 'button'))) {
      first.role = 'navigationBar';
    }
  }
  for (const c of node.children) applyMaestroDerivations(c, node);
}

function sameBBox(a: BBoxNorm, b: BBoxNorm): boolean {
  return Math.abs(a.x - b.x) <= 0.001 && Math.abs(a.y - b.y) <= 0.001 && Math.abs(a.w - b.w) <= 0.001 && Math.abs(a.h - b.h) <= 0.001;
}

/** Fixed top-level key order (schema_version, platform, source, viewport, …, root). */
function reorderTree(t: Tree): Tree {
  const out: Tree = { schema_version: 1, platform: t.platform, source: t.source, root: t.root };
  if (t.viewport !== undefined) out.viewport = t.viewport;
  if (t.captured_at !== undefined) out.captured_at = t.captured_at;
  if (t.route !== undefined) out.route = t.route;
  if (t.build !== undefined) out.build = t.build;
  if (t.app_id !== undefined) out.app_id = t.app_id;
  // keep `root` last
  const { root, ...rest } = out;
  return { ...rest, root } as Tree;
}

// ---------------------------------------------------------------------------------------------
// Structural check of the normalized shape
// ---------------------------------------------------------------------------------------------

function inUnit(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
}

function nodeIssue(n: unknown, at: string, depth = 0): string | undefined {
  if (depth > MAX_TREE_DEPTH) return `${at} exceeds the maximum tree depth of ${MAX_TREE_DEPTH}`;
  if (!isRecord(n)) return `${at} is not an object`;
  if (typeof n['role'] !== 'string' || !ROLE_SET.has(n['role'])) return `${at}.role ${JSON.stringify(n['role'])} is not a known role`;
  for (const k of ['a11y_id', 'label', 'value', 'text'] as const) {
    if (n[k] !== undefined && typeof n[k] !== 'string') return `${at}.${k} must be a string`;
  }
  for (const k of ['enabled', 'focused', 'selected'] as const) {
    if (n[k] !== undefined && typeof n[k] !== 'boolean') return `${at}.${k} must be a boolean`;
  }
  const bb = n['bbox_norm'];
  if (!isRecord(bb) || !inUnit(bb['x']) || !inUnit(bb['y']) || !inUnit(bb['w']) || !inUnit(bb['h'])) {
    return `${at}.bbox_norm must be {x, y, w, h} with each value in [0, 1]`;
  }
  const kids = n['children'];
  if (!Array.isArray(kids)) return `${at}.children must be an array`;
  for (let i = 0; i < kids.length; i++) {
    const issue = nodeIssue(kids[i], `${at}.children[${i}]`, depth + 1);
    if (issue !== undefined) return issue;
  }
  return undefined;
}

function normalizedTreeIssue(t: unknown): string | undefined {
  if (!isRecord(t)) return 'tree is not an object';
  if (t['schema_version'] !== 1) return 'schema_version must be 1';
  if (!(PLATFORMS as readonly string[]).includes(t['platform'] as string)) return `platform must be one of ${PLATFORMS.join('|')}`;
  if (!(TREE_SOURCES as readonly string[]).includes(t['source'] as string)) return `source must be one of ${TREE_SOURCES.join('|')}`;
  const vp = t['viewport'];
  if (vp !== undefined && !(isRecord(vp) && typeof vp['w'] === 'number' && typeof vp['h'] === 'number')) return 'viewport must be {w, h}';
  return nodeIssue(t['root'], 'root');
}

/** Structural check of a normalized tree (roles in `ROLES`, bbox in range, children arrays). */
export function isNormalizedTree(input: unknown): input is Tree {
  return normalizedTreeIssue(input) === undefined;
}

// ---------------------------------------------------------------------------------------------
// Hook payload extraction (05 §3)
// ---------------------------------------------------------------------------------------------

const SNAPSHOT_KEYS = ['snapshot', 'hierarchy', 'tree'] as const;

function pickSnapshotKey(o: unknown): unknown | undefined {
  if (!isRecord(o)) return undefined;
  for (const k of SNAPSHOT_KEYS) {
    const v = o[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

function tryParseJson(s: string): unknown | undefined {
  const t = s.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/**
 * Best-effort extraction of the driver's snapshot from a hook `tool_response` (05 §3): looks at
 * `structuredContent.snapshot|hierarchy|tree`, then `content[].text` that parses as JSON with
 * one of those keys or is itself a tree, then the response object itself. `undefined` when
 * nothing tree-like is found (the observation is recorded with `snapshot: null`).
 */
export function extractSnapshot(toolResponse: unknown): unknown | undefined {
  if (typeof toolResponse === 'string') {
    const parsed = tryParseJson(toolResponse);
    return parsed === undefined ? undefined : extractSnapshot(parsed);
  }
  if (!isRecord(toolResponse)) return undefined;
  const sc = toolResponse['structuredContent'];
  const fromSc = pickSnapshotKey(sc);
  if (fromSc !== undefined) return fromSc;
  if (detectTreeShape(sc) !== 'unknown') return sc;
  const content = toolResponse['content'];
  if (Array.isArray(content)) {
    for (const item of content) {
      if (!isRecord(item) || typeof item['text'] !== 'string') continue;
      const parsed = tryParseJson(item['text']);
      if (parsed === undefined) continue;
      const picked = pickSnapshotKey(parsed);
      if (picked !== undefined) return picked;
      if (detectTreeShape(parsed) !== 'unknown') return parsed;
    }
  }
  const direct = pickSnapshotKey(toolResponse);
  if (direct !== undefined) return direct;
  if (detectTreeShape(toolResponse) !== 'unknown') return toolResponse;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Traversal and queries
// ---------------------------------------------------------------------------------------------

export type Visitor = (node: TreeNode, parent: TreeNode | undefined, depth: number) => void | false;

function rootOf(tree: AnyTree | TreeNode): TreeNode {
  return 'root' in tree && isRecord((tree as AnyTree).root) ? (tree as AnyTree).root : (tree as TreeNode);
}

/** Pre-order traversal; returning `false` from the visitor skips that node's children. */
export function walk(tree: AnyTree | TreeNode, visit: Visitor): void {
  const stack: Array<{ node: TreeNode; parent: TreeNode | undefined; depth: number }> = [{ node: rootOf(tree), parent: undefined, depth: 0 }];
  while (stack.length > 0) {
    const { node, parent, depth } = stack.pop()!;
    if (visit(node, parent, depth) === false) continue;
    const kids = Array.isArray(node.children) ? node.children : [];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ node: kids[i]!, parent: node, depth: depth + 1 });
  }
}

/** All nodes in pre-order. */
export function allNodes(tree: AnyTree | TreeNode): TreeNode[] {
  const out: TreeNode[] = [];
  walk(tree, (n) => { out.push(n); });
  return out;
}

export function findByA11yId(tree: AnyTree | TreeNode, id: string): TreeNode[] {
  const out: TreeNode[] = [];
  walk(tree, (n) => { if (n.a11y_id === id) out.push(n); });
  return out;
}

export function nodesWithRole(tree: AnyTree | TreeNode, role: Role): TreeNode[] {
  const out: TreeNode[] = [];
  walk(tree, (n) => { if (n.role === role) out.push(n); });
  return out;
}

/** Nodes whose `a11y_id` matches `^screen\.` — presence and count (drift.ts `marker_present`). Identification and `pathOf` want `deepestMarker` instead (01 R3, issue #10). */
export function findMarkerNodes(tree: AnyTree): { nodes: TreeNode[]; count: number } {
  const nodes: TreeNode[] = [];
  walk(tree, (n) => { if (isMarker(n.a11y_id)) nodes.push(n); });
  return { nodes, count: nodes.length };
}

/**
 * The marker that identification, `pathOf` and `resolve` must use when more than one is present
 * (01 R3, issue #10). A pushed detail screen leaves the covered screen's marker in the
 * accessibility tree, so "exactly one marker" is not a fact tooling can rely on; taking the first
 * identifies the screen that is COVERED. Order of preference:
 *  1. deepest in the node hierarchy — a marker nested inside another is the one drawn on top;
 *  2. then the greatest `bbox_norm.y` — in a FLAT capture (`fromArgentScreen`) there is no real
 *     hierarchy, so every marker sits at the same depth and `y` is the only cue there is;
 *  3. then document order, last wins — a driver appends the screen it has just pushed.
 * `undefined` when the tree carries no marker at all.
 */
export function deepestMarker(tree: AnyTree): TreeNode | undefined {
  let best: TreeNode | undefined;
  let bestDepth = -1;
  let bestY = -1;
  walk(tree, (n, _parent, depth) => {
    if (!isMarker(n.a11y_id)) return undefined;
    const y = typeof n.bbox_norm?.y === 'number' ? n.bbox_norm.y : 0;
    if (depth > bestDepth || (depth === bestDepth && y >= bestY)) {
      best = n;
      bestDepth = depth;
      bestY = y;
    }
    return undefined;
  });
  return best;
}

/** The `deepestMarker`, else the tree root (base for `pathOf`). */
export function screenRoot(tree: AnyTree): TreeNode {
  return deepestMarker(tree) ?? tree.root;
}

/** root → … → node (inclusive); `undefined` when `node` is not in the tree (identity comparison). */
function chainTo(tree: AnyTree, node: TreeNode): TreeNode[] | undefined {
  const parents = new Map<TreeNode, TreeNode | undefined>();
  let found = false;
  walk(tree, (n, parent) => {
    parents.set(n, parent);
    if (n === node) found = true;
  });
  if (!found) return undefined;
  const chain: TreeNode[] = [];
  for (let cur: TreeNode | undefined = node; cur !== undefined; cur = parents.get(cur)) chain.push(cur);
  return chain.reverse();
}

function requireChain(tree: AnyTree, node: TreeNode): TreeNode[] {
  const chain = chainTo(tree, node);
  if (chain === undefined) throw badInput('node is not part of the tree', 'pass a node object obtained from the same tree instance');
  return chain;
}

/**
 * Index in `chain` of the path base: the screen root when it is an ancestor of the node, else
 * the lowest common ancestor of the node and the screen root (header, OS alerts beside the
 * marker container).
 */
function baseIndex(tree: AnyTree, chain: TreeNode[]): number {
  const sr = screenRoot(tree);
  const idx = chain.indexOf(sr);
  if (idx >= 0) return idx;
  const srChain = chainTo(tree, sr) ?? [tree.root];
  let common = 0;
  while (common + 1 < chain.length && common + 1 < srChain.length && chain[common + 1] === srChain[common + 1]) common++;
  return common;
}

export function parentOf(tree: AnyTree, node: TreeNode): TreeNode | undefined {
  let result: TreeNode | undefined;
  let found = false;
  walk(tree, (n, parent) => {
    if (found) return false;
    if (n === node) { result = parent; found = true; return false; }
    return undefined;
  });
  return result;
}

/** index among ALL siblings (0-based); 0 for the root */
export function siblingIndex(tree: AnyTree, node: TreeNode): number {
  const parent = parentOf(tree, node);
  if (parent === undefined) return 0;
  const i = parent.children.indexOf(node);
  return i < 0 ? 0 : i;
}

function pathSegment(parent: TreeNode, node: TreeNode): string {
  const same = parent.children.filter((c) => c.role === node.role);
  return same.length === 1 ? node.role : `${node.role}[${same.indexOf(node)}]`;
}

export function pathOf(tree: AnyTree, node: TreeNode): string {
  const chain = requireChain(tree, node);
  const start = baseIndex(tree, chain);
  const segments: string[] = [];
  for (let i = start + 1; i < chain.length; i++) segments.push(pathSegment(chain[i - 1]!, chain[i]!));
  return segments.join('/');
}

const SEGMENT_RE = /^([A-Za-z]+)(?:\[(\d+)\])?$/;

function resolvePath(base: TreeNode, segments: string[]): TreeNode | undefined {
  let cur: TreeNode = base;
  for (const seg of segments) {
    const m = SEGMENT_RE.exec(seg);
    if (!m) return undefined;
    const same = cur.children.filter((c) => c.role === m[1]);
    let next: TreeNode | undefined;
    if (m[2] !== undefined) next = same[Number(m[2])];
    else next = same.length === 1 ? same[0] : undefined; // an un-indexed segment must be unique (02 §5.2)
    if (next === undefined) return undefined;
    cur = next;
  }
  return cur;
}

/** Inverse of `pathOf`; `undefined` when the path does not resolve. */
export function nodeAtPath(tree: AnyTree, path: string): TreeNode | undefined {
  if (typeof path !== 'string') return undefined;
  const sr = screenRoot(tree);
  if (path === '') return sr;
  const segments = path.split('/');
  const hit = resolvePath(sr, segments);
  if (hit !== undefined) return hit;
  // paths of nodes beside the marker are based at an ancestor of the screen root (see pathOf)
  if (sr !== tree.root) {
    const chain = chainTo(tree, sr) ?? [];
    for (let i = chain.length - 2; i >= 0; i--) {
      const alt = resolvePath(chain[i]!, segments);
      if (alt !== undefined) return alt;
    }
  }
  return undefined;
}

/** Role sequence from the screen root to `node` (inclusive) — the input to heal's LCS feature (04 §7.1). */
export function rolePath(tree: AnyTree, node: TreeNode): Role[] {
  const chain = requireChain(tree, node);
  const start = baseIndex(tree, chain);
  return chain.slice(start).map((n) => n.role);
}

/** `label ?? text` — the string a role_label/text locator tests against. */
export function labelOf(node: TreeNode): string | undefined {
  return node.label ?? node.text;
}

export function countNodes(tree: AnyTree | TreeNode): number {
  let n = 0;
  walk(tree, () => { n++; });
  return n;
}

/** Normalized centre point of a node's bbox (the `geometry` locator value). */
export function centerOf(node: TreeNode): { x: number; y: number } {
  const b = node.bbox_norm;
  return { x: round4(clamp01(b.x + b.w / 2)), y: round4(clamp01(b.y + b.h / 2)) };
}

// ---------------------------------------------------------------------------------------------
// Compact stable JSON
// ---------------------------------------------------------------------------------------------

function orderedNode(n: TreeNode): Record<string, unknown> {
  const o: Record<string, unknown> = { role: n.role };
  if (n.a11y_id !== undefined) o['a11y_id'] = n.a11y_id;
  if (n.label !== undefined) o['label'] = n.label;
  if (n.value !== undefined) o['value'] = n.value;
  if (n.text !== undefined) o['text'] = n.text;
  if (n.enabled !== undefined) o['enabled'] = n.enabled;
  if (n.focused !== undefined) o['focused'] = n.focused;
  if (n.selected !== undefined) o['selected'] = n.selected;
  const b = n.bbox_norm;
  o['bbox_norm'] = { x: b.x, y: b.y, w: b.w, h: b.h };
  o['children'] = (Array.isArray(n.children) ? n.children : []).map(orderedNode);
  return o;
}

/** Compact stable JSON of a tree (no whitespace) — used for `perception_bytes` (08 §2) and the trajectory. */
export function compactJson(tree: AnyTree): string {
  const o: Record<string, unknown> = { schema_version: 1, platform: tree.platform, source: tree.source };
  if (tree.viewport !== undefined) o['viewport'] = { w: tree.viewport.w, h: tree.viewport.h };
  if (tree.captured_at !== undefined) o['captured_at'] = tree.captured_at;
  if (tree.route !== undefined) o['route'] = tree.route;
  if (tree.build !== undefined) o['build'] = tree.build;
  if (tree.app_id !== undefined) o['app_id'] = tree.app_id;
  o['root'] = orderedNode(tree.root);
  if (tree.scrubbed === true) {
    o['scrubbed'] = true;
    const hits = (tree as { scrub_hits?: number }).scrub_hits;
    if (hits !== undefined) o['scrub_hits'] = hits;
  }
  return JSON.stringify(o);
}
