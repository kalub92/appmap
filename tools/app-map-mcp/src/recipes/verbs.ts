/**
 * [C1] Driver verb table (04 §3.3, 03 §3 `APP_MAP_DRIVER`, 02 §6 step vocabulary).
 *
 * Driver calls reach the compiler as `mcp__<driver>__<tool>` (config.driverToolPattern, 05 §3).
 * `classifyVerb(tool, driver)` says what such a call IS, so `recipes/compile.ts` can turn it into
 * a step, skip it knowingly, or warn about it. The classification is a TABLE keyed on
 * `APP_MAP_DRIVER` rather than the five pattern literals it replaces: swapping drivers (03 §3)
 * is then a table entry, not a regex edit.
 *
 * `@swmansion/argent@0.25.0`'s surface (`ARGENT_VERBS`) was confirmed against `argent tools`
 * (issue #9) and answers the open question in docs/dev/harness-notes.md §2. Neither `type_text`
 * nor `open_url` exists there: the driver types with `keyboard --text` and opens links with
 * `open-url`. Both fell through the old regexes and vanished from the compiled recipe — which is
 * why classification is now total: every call is a step, a known non-step, or a warning.
 *
 * A driver with no table, and a tool its table does not list, fall back to generic patterns that
 * keep older trajectories (`tap`, `type_text`, `open_url`, `swipe`, `describe_ui`) and other
 * drivers compiling. Whatever matches nothing at all is `unknown`, never silent.
 *
 * The table only ever covered the tools ONE onboarding made visible, so `unsupported` listed
 * exactly the two non-tap gestures Argent happens to name. The generic fallback decided the rest,
 * and its tap test is a bare substring match — so `long_press`, `touch_and_hold`, `double_tap`
 * and `press_back` all classified as a plain `tap`. A UIKit row that opens a context menu on
 * long-press, or a Compose `combinedClickable(onLongClick = …)`, then compiled to a tap that
 * opens the row instead: replay navigated somewhere else entirely and the following `expect`
 * either passed on the wrong screen or failed misleadingly. `HOLD_RE`/`BACK_RE` below are
 * therefore tested BEFORE the tap pattern — same #9 failure class, in the gesture shapes the
 * pilot app never used.
 *
 * Layer: leaf (imports nothing). Pure.
 */

/** A driver call that becomes a recipe step (04 §3.3 → 02 §6 `tap`/`type`/`swipe`/`open_link`). */
export type StepVerb = 'tap' | 'type' | 'swipe' | 'open_link';

/**
 * What a driver call is. The kinds that are not a `StepVerb`:
 *  - `perception` — reading the screen (`screenshot`, `describe`, a hierarchy dump): never a step
 *    and never a warning, since the compiler expects the driver to look before it acts (03 §8);
 *  - `lifecycle` — waits, app launch/restart, log dumps, and the `report_step` observation
 *    guided replay synthesizes without hooks (04 §5): a KNOWN non-step, so it is silent too;
 *  - `batch` — several interactions inside one call (Argent `run-sequence`), rejected with a
 *    warning: one observation carries one screen pair and one element (02 §7), so the per-step
 *    postconditions of 04 §3.6 cannot be reconstructed from it;
 *  - `unsupported` — a real interaction that 02 §6 has no step for: Argent's `button` and
 *    `tv-remote`, plus everything the generic `HOLD_RE`/`BACK_RE` below catch (a long press, a
 *    double tap, a pinch/drag, Android's system Back). The point of the kind is that the call is
 *    NOT silently turned into the nearest step that exists;
 *  - `unknown` — in no table and matching no pattern: always a warning (issue #9).
 */
export type VerbKind = StepVerb | 'perception' | 'lifecycle' | 'batch' | 'unsupported' | 'unknown';

/** normalized tool name (see `normalizeVerb`) → what a call to it is. */
export type DriverVerbTable = Readonly<Record<string, VerbKind>>;

/** `mcp__<driver>__x` → `x`; a foreign `mcp__*__` prefix is stripped too (a trajectory outlives an `APP_MAP_DRIVER` change); a bare name is returned unchanged. */
export function bareToolName(tool: string, driver: string): string {
  if (typeof tool !== 'string') return '';
  const own = `mcp__${driver}__`;
  if (tool.startsWith(own)) return tool.slice(own.length);
  // `mcp__<anything>__<tool>`: the recorded prefix is whatever driver was configured then
  const foreign = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(tool);
  return foreign !== null ? foreign[1]! : tool;
}

/** `mcp__argent__gesture-tap` → `gesture_tap`: prefix stripped, lower-cased, `-` unified to `_`. */
export function normalizeVerb(tool: string, driver: string): string {
  return bareToolName(tool, driver).toLowerCase().replace(/-/g, '_');
}

/**
 * `@swmansion/argent@0.25.0` (`argent tools`, issue #9). Keys are normalized, so `open-url` and
 * `open_url` are the same entry — the hyphen is exactly what the old `OPEN_LINK_RE` missed.
 * The ~20 tools below are the ones the flow uses; the other 56 fall to the generic patterns.
 */
export const ARGENT_VERBS: DriverVerbTable = {
  // interactions that are steps
  gesture_tap: 'tap',
  gesture_swipe: 'swipe', // takes `--fromX/--fromY/--toX/--toY` and NO direction flag (harness-notes §2): compile.ts derives the direction from the pair
  gesture_scroll: 'swipe', // Chromium only, but a scroll is a swipe as far as 02 §6 is concerned
  keyboard: 'type', // `--text` types; `--key return` presses a named key (no step — compile.ts warns)
  paste: 'type',
  open_url: 'open_link',
  // interactions with no step in 02 §6
  button: 'unsupported', // hardware buttons (home, lock, volume)
  tv_remote: 'unsupported',
  run_sequence: 'batch',
  // perception (03 §8): the driver reads the screen; the compiler records, never replays, these
  screenshot: 'perception',
  describe: 'perception',
  native_describe_screen: 'perception',
  native_full_hierarchy: 'perception',
  // waits, app lifecycle and log dumps: known non-steps
  await_ui_element: 'lifecycle',
  await_screen_idle: 'lifecycle',
  launch_app: 'lifecycle',
  restart_app: 'lifecycle',
  reinstall_app: 'lifecycle',
  native_network_logs: 'lifecycle',
  view_network_logs: 'lifecycle',
};

/**
 * Pseudo-calls the harness itself synthesizes under the driver's prefix, whatever the driver is:
 * `guided.reportStep` records `mcp__<driver>__report_step` when there are no hooks (04 §5). It
 * is a report, not an interaction, so it must not warn on every recompile.
 */
export const UNIVERSAL_VERBS: DriverVerbTable = { report_step: 'lifecycle' };

/** Every known driver's table, keyed by `APP_MAP_DRIVER` (03 §3). */
export const DRIVER_VERBS: Readonly<Record<string, DriverVerbTable>> = { argent: ARGENT_VERBS };

// Generic fallback, in the same precedence the pre-#9 literals used, matched on the NORMALIZED
// name so `open-url` and `open_url` behave alike for an untabled driver as well.
//
// `normalizeVerb` lower-cases, so camelCase collapses into one word (`longPress` → `longpress`);
// and `_` is a word character, so `\b` cannot separate `go_back` from `feedback`. Both patterns
// below therefore spell their separators out: `_?` between the words of a compound, `(?:^|_)` /
// `(?:_|$)` around a word that must stand alone.
//
// A gesture 02 §6 has no step for. Tested FIRST, because `TAP_RE` is a bare substring test and
// `long_press`/`touch_and_hold`/`double_tap` all contain one of its four words — which is how a
// context-menu long-press used to compile to a tap that opened the row (module doc above).
// `unsupported`, not `unknown`: these ARE interactions, the vocabulary just cannot express them,
// and compile.ts already drops an `unsupported` call with a warning naming the tool.
const HOLD_RE = /long_?(?:press|tap|click|touch|hold)|(?:press|tap|click|touch)_?and_?hold|double_?(?:tap|click|press|touch)|triple_?(?:tap|click)|force_?(?:touch|press)|3d_?touch|deep_?press|(?:^|_)hold(?:_|$)|pinch|zoom|rotate|drag/;
// Android's system Back, and the raw key dispatch it is usually sent through (`adb shell input
// keyevent 4`). `press_back` matched `press` and compiled to a TAP on whatever was last resolved;
// `back`, `go_back`, `key_event` and `keycode` matched nothing and were reported as "not a known
// verb", which reads like a typo rather than the navigation it is.
//
// `unsupported` rather than `lifecycle`, deliberately: Back CHANGES THE SCREEN, so it is not a
// known non-step the way a wait or a screenshot is. `lifecycle` is silent, and a silent drop of a
// navigation leaves a hole in the recipe — the next step then runs on a screen the recipe never
// reached, which is the #9 failure mode this whole classification exists to stop. 02 §6 has no
// `back` step (a back edge is modelled in the map, 02 §4.2), so the honest answer is "a real
// interaction with no step": dropped, and WARNED about, so the reviewer re-drives or adds an edge.
const BACK_RE = /(?:^|_)back(?:_|$)|go_?back|press_?back|nav(?:igate)?_?back|back_?button|key_?event|key_?code/;
const TAP_RE = /tap|click|press|touch/;
const PERCEPTION_RE = /screenshot|snapshot|hierarchy|describe|dump|accessibility/;
const OPEN_LINK_RE = /open_?url|open_?link|deep_?link/;
const TYPE_RE = /type|input_text|set_text|enter_text|keyboard|paste/;
const SWIPE_RE = /swipe|scroll/;

/** What a driver call is (04 §3.3). Total: an unrecognised tool is `unknown`, never nothing. */
export function classifyVerb(tool: string, driver: string): VerbKind {
  const name = normalizeVerb(tool, driver);
  if (name === '') return 'unknown';
  const universal = UNIVERSAL_VERBS[name];
  if (universal !== undefined) return universal;
  const tabled = DRIVER_VERBS[driver]?.[name];
  if (tabled !== undefined) return tabled;
  // a gesture or a system Back BEFORE the tap test: each contains `press`/`touch`/`tap`, and a
  // `tap` is the wrong step for every one of them (see the notes on the patterns)
  if (HOLD_RE.test(name) || BACK_RE.test(name)) return 'unsupported';
  // `tap_and_describe` acts before it reads: a name that is both is an interaction
  const tapish = TAP_RE.test(name);
  if (PERCEPTION_RE.test(name) && !tapish) return 'perception';
  if (OPEN_LINK_RE.test(name)) return 'open_link';
  if (TYPE_RE.test(name)) return 'type';
  if (SWIPE_RE.test(name) && !tapish) return 'swipe';
  if (tapish) return 'tap';
  return 'unknown';
}

/** Does this kind become a recipe step? (narrows for `translateSteps`' switch) */
export function isStepVerb(kind: VerbKind): kind is StepVerb {
  return kind === 'tap' || kind === 'type' || kind === 'swipe' || kind === 'open_link';
}
