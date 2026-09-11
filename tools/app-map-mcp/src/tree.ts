/**
 * [B1] Accessibility-tree normalization and queries (03 §5 input, 03 §6, 02 §5.1 `path`).
 *
 * Input shapes accepted by `normalizeTree` (detected by `detectTreeShape`):
 *  - `normalized`: our own `Tree` JSON (`{schema_version:1, platform, root:{role,…,children}}`),
 *    e.g. fixtures/trees/*.normalized.json — returned as-is after a structural check;
 *  - `argent`: XCUITest-like `{type, identifier?, label?, value?, enabled?, hasFocus?,
 *    selected?, frame:{x,y,width,height}, children[]}` possibly wrapped as `{root, screen:{width,
 *    height}}` (fixtures/raw/argent-snapshot.invoice_list.json — best-effort, field names
 *    unverified against the real driver);
 *  - `maestro`: `maestro hierarchy` JSON `{elements:[{attributes:{resource-id,text,
 *    accessibilityText,bounds:"[x1,y1][x2,y2]",class,enabled,focused,selected,…},children}]}`
 *    or the bare `{attributes, children}` root (fixtures/raw/maestro-hierarchy.invoice_list.json
 *    — best-effort, verify at implementation time).
 *
 * Role mapping (`ROLE_MAP_XCUI`, `ROLE_MAP_ANDROID`): unknown types → `other`; a `Button`
 * whose parent is a `TabBar` → `tab`; a `StaticText` inside a `Cell` stays `staticText`.
 * `bbox_norm` = frame ÷ viewport (viewport = wrapper `screen`, else the root frame), clamped to
 * [0,1] and rounded to 4 decimals. Empty strings for `identifier`/`resource-id` mean "absent".
 *
 * `pathOf(tree, node)`: roles from the screen root (the marker node when exactly one exists,
 * else the tree root) — exclusive — down to `node`; each segment is `role` when the node is the
 * only child of that role among its siblings, else `role[i]` with `i` the 0-based index among
 * same-role siblings. Example: `navigationBar/button[1]`. This matches the pilot files exactly.
 *
 * Layer: tree (imports types/errors only). All functions are pure.
 */
import type { Platform } from './config.ts';
import type { AnyTree, Role, Tree, TreeNode, TreeSource } from './types.ts';
import { NotImplementedError } from './errors.ts';

export type TreeShape = 'normalized' | 'argent' | 'maestro' | 'unknown';

/** XCUIElementType names → role (best-effort; unknown → `other`). */
export const ROLE_MAP_XCUI: Readonly<Record<string, Role>> = {
  Application: 'application', Window: 'window', Other: 'container', Group: 'container', NavigationBar: 'navigationBar',
  TabBar: 'tabBar', Toolbar: 'toolbar', ScrollView: 'scrollView', Table: 'list', CollectionView: 'list', Cell: 'cell',
  Button: 'button', Link: 'link', Switch: 'toggle', Toggle: 'toggle', TextField: 'field', TextView: 'field',
  SecureTextField: 'secureField', SearchField: 'searchField', Picker: 'picker', PickerWheel: 'picker', DatePicker: 'picker',
  StaticText: 'staticText', Image: 'image', Alert: 'alert', Sheet: 'sheet', Keyboard: 'keyboard', Key: 'key',
};

/** Android class names (suffix match) → role. */
export const ROLE_MAP_ANDROID: Readonly<Record<string, Role>> = {
  FrameLayout: 'container', LinearLayout: 'container', RelativeLayout: 'container', ViewGroup: 'container', ComposeView: 'container',
  ScrollView: 'scrollView', NestedScrollView: 'scrollView', RecyclerView: 'list', ListView: 'list', Button: 'button',
  ImageButton: 'button', Switch: 'toggle', CheckBox: 'toggle', EditText: 'field', TextView: 'staticText', ImageView: 'image',
  Spinner: 'picker', Toolbar: 'navigationBar', BottomNavigationView: 'tabBar', View: 'other',
};

export function detectTreeShape(input: unknown): TreeShape {
  void input;
  throw new NotImplementedError('tree.detectTreeShape');
}

/**
 * Normalize any accepted shape to a raw `Tree` (never scrubbed). Throws `AppMapError(bad_input)`
 * with a hint naming the shape problem. `opts.source` defaults from the detected shape.
 */
export function normalizeTree(input: unknown, opts: { platform: Platform; source?: TreeSource }): Tree {
  void input; void opts;
  throw new NotImplementedError('tree.normalizeTree');
}

export function fromArgentSnapshot(input: unknown, platform: Platform): Tree {
  void input; void platform;
  throw new NotImplementedError('tree.fromArgentSnapshot');
}

export function fromMaestroHierarchy(input: unknown, platform: Platform): Tree {
  void input; void platform;
  throw new NotImplementedError('tree.fromMaestroHierarchy');
}

/** Structural check of a normalized tree (roles in `ROLES`, bbox in range, children arrays). */
export function isNormalizedTree(input: unknown): input is Tree {
  void input;
  throw new NotImplementedError('tree.isNormalizedTree');
}

/**
 * Best-effort extraction of the driver's snapshot from a hook `tool_response` (05 §3): looks at
 * `structuredContent.snapshot|hierarchy|tree`, then `content[].text` that parses as JSON with
 * one of those keys or is itself a tree, then the response object itself. `undefined` when
 * nothing tree-like is found (the observation is recorded with `snapshot: null`).
 */
export function extractSnapshot(toolResponse: unknown): unknown | undefined {
  void toolResponse;
  throw new NotImplementedError('tree.extractSnapshot');
}

export type Visitor = (node: TreeNode, parent: TreeNode | undefined, depth: number) => void | false;

/** Pre-order traversal; returning `false` from the visitor skips that node's children. */
export function walk(tree: AnyTree | TreeNode, visit: Visitor): void {
  void tree; void visit;
  throw new NotImplementedError('tree.walk');
}

/** All nodes in pre-order. */
export function allNodes(tree: AnyTree | TreeNode): TreeNode[] {
  void tree;
  throw new NotImplementedError('tree.allNodes');
}

export function findByA11yId(tree: AnyTree | TreeNode, id: string): TreeNode[] {
  void tree; void id;
  throw new NotImplementedError('tree.findByA11yId');
}

export function nodesWithRole(tree: AnyTree | TreeNode, role: Role): TreeNode[] {
  void tree; void role;
  throw new NotImplementedError('tree.nodesWithRole');
}

/** Nodes whose `a11y_id` matches `^screen\.` — `count` tells identify whether exactly one exists (03 §5.2). */
export function findMarkerNodes(tree: AnyTree): { nodes: TreeNode[]; count: number } {
  void tree;
  throw new NotImplementedError('tree.findMarkerNodes');
}

/** The marker node when exactly one exists, else the tree root (base for `pathOf`). */
export function screenRoot(tree: AnyTree): TreeNode {
  void tree;
  throw new NotImplementedError('tree.screenRoot');
}

export function parentOf(tree: AnyTree, node: TreeNode): TreeNode | undefined {
  void tree; void node;
  throw new NotImplementedError('tree.parentOf');
}

/** index among ALL siblings (0-based); 0 for the root */
export function siblingIndex(tree: AnyTree, node: TreeNode): number {
  void tree; void node;
  throw new NotImplementedError('tree.siblingIndex');
}

export function pathOf(tree: AnyTree, node: TreeNode): string {
  void tree; void node;
  throw new NotImplementedError('tree.pathOf');
}

/** Inverse of `pathOf`; `undefined` when the path does not resolve. */
export function nodeAtPath(tree: AnyTree, path: string): TreeNode | undefined {
  void tree; void path;
  throw new NotImplementedError('tree.nodeAtPath');
}

/** Role sequence from the screen root to `node` (inclusive) — the input to heal's LCS feature (04 §7.1). */
export function rolePath(tree: AnyTree, node: TreeNode): Role[] {
  void tree; void node;
  throw new NotImplementedError('tree.rolePath');
}

/** `label ?? text` — the string a role_label/text locator tests against. */
export function labelOf(node: TreeNode): string | undefined {
  void node;
  throw new NotImplementedError('tree.labelOf');
}

export function countNodes(tree: AnyTree | TreeNode): number {
  void tree;
  throw new NotImplementedError('tree.countNodes');
}

/** Normalized centre point of a node's bbox (the `geometry` locator value). */
export function centerOf(node: TreeNode): { x: number; y: number } {
  void node;
  throw new NotImplementedError('tree.centerOf');
}

/** Compact stable JSON of a tree (no whitespace) — used for `perception_bytes` (08 §2) and the trajectory. */
export function compactJson(tree: AnyTree): string {
  void tree;
  throw new NotImplementedError('tree.compactJson');
}
