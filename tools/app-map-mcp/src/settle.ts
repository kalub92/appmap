/**
 * [B2] Settle hints (04 §5, issue #26): how a driver knows a step has landed, before it calls
 * `report_step`.
 *
 * Every consumer of `run_recipe` had to invent its own settle policy, and the obvious one —
 * `sleep(n)` — is both slow and flaky. Measured on a real suite: 144.1 s of which ~85% was
 * sleeping, against 79.7 s polling each step's own declared postcondition, with the flake mode
 * gone. It is not a speed/safety trade: a slow network can outrun a fixed wait, and a poll for the
 * assertion the step already declares cannot drift apart from that assertion.
 *
 * The server is the right place for the derivation, for reasons a driver cannot reproduce:
 *
 *  - it already resolves `expect`, so a driver deriving its own is re-deriving what the map knows;
 *  - it knows which elements are `dynamic`, so it can prefer a STABLE target — `screen.<id>` over
 *    a list cell whose label changes per run;
 *  - `timeout_ms` comes from the recipe's own `wait_for` budget rather than each driver guessing;
 *  - it makes every driver fast by default instead of only the ones that thought about it. The
 *    shipped `app-nav-replayer` agent had no settle guidance at all.
 *
 * Where a step declares nothing pollable, the honest answer is NO hint — the driver reports
 * immediately and falls back to whatever floor it wants. Absent is the encoding for that; there is
 * no empty-hint form.
 *
 * Layer: map (imports types only). Pure.
 */
import type {
  DriverTarget, ElementDef, ElementId, Expect, GateId, LoadedMap, RecipeStep, ScreenId, SettleHint, SettleSource,
} from './types.ts';
import { HEADLESS_STRATEGIES, isMarker, markerOfScreen } from './types.ts';

/**
 * The default settle budget, shared with the Maestro export's `extendedWaitUntil` (04 §6.2) so the
 * two rungs wait the same amount for the same assertion.
 */
export const DEFAULT_SETTLE_MS = 10_000;

export interface SettleOptions {
  /** the screen the step is taken on, for resolving an element declared on more than one */
  screen?: ScreenId;
  /** the recipe's own `verify`, used when this is the last step (`finish` checks it on that report) */
  verify?: Expect;
  /** this is the last step of the run */
  isLast?: boolean;
}

/** The one `ElementDef` for `id`, preferring the declaration on `screen` (02 §4.1: ids repeat). */
function defOf(map: LoadedMap, id: ElementId, screen: ScreenId | undefined): ElementDef | undefined {
  const refs = map.elements.get(id) ?? [];
  if (screen !== undefined) {
    const onScreen = refs.find((r) => r.screen === screen);
    if (onScreen !== undefined) return onScreen.element;
  }
  return refs[0]?.element;
}

/**
 * A driver-addressable target for an element, from the same locator cascade the Maestro export
 * uses (`HEADLESS_STRATEGIES`): a settle the driver cannot express is worse than none, because it
 * becomes a timeout on every step.
 *
 * `path` and `geometry` are deliberately excluded. A path is not a selector any driver polls, and
 * geometry is satisfied by an empty region at the right coordinates — it would report "settled"
 * for a screen that never rendered.
 */
export function addressableTarget(def: ElementDef | undefined): DriverTarget | undefined {
  for (const loc of def?.locators ?? []) {
    if (!HEADLESS_STRATEGIES.includes(loc.strategy)) continue;
    if (loc.strategy === 'a11y_id' && typeof loc.value === 'string' && loc.value !== '') return { by: 'id', id: loc.value };
    if (loc.strategy === 'text' && typeof loc.value === 'string' && loc.value !== '') return { by: 'text', text: loc.value };
    if (loc.strategy === 'role_label' && loc.value !== null && typeof loc.value === 'object') {
      const rl = loc.value as { role?: string; label?: string; label_regex?: string };
      // a computed label (07 §9) is a regex, which is an id-shaped pattern to a driver, not a
      // literal to compare — the Maestro export makes the same choice (04 §6.2)
      if (typeof rl.label_regex === 'string' && rl.label_regex !== '') return { by: 'id', id: rl.label_regex };
      if (typeof rl.label === 'string' && rl.label !== '' && def?.role !== undefined) return { by: 'role_label', role: def.role, label: rl.label };
    }
  }
  return undefined;
}

/**
 * Is this element's content data-driven (02 §4.1, 07 §2.3)? A `dynamic` element still has a stable
 * shared id, so it IS pollable — it just proves the list rendered rather than that the right row
 * did. Deprioritised, never banned: if it is the only candidate it still beats sleeping.
 */
function isDynamic(map: LoadedMap, id: ElementId, screen: ScreenId | undefined): boolean {
  if (map.elementRegistry.get(id)?.dynamic === true) return true;
  if (defOf(map, id, screen)?.dynamic === true) return true;
  const file = screen !== undefined ? map.screens.get(screen) : undefined;
  return (file?.dynamic_regions ?? []).includes(id);
}

/** The first id that is addressable, preferring one that is not `dynamic`. */
function pickElement(map: LoadedMap, ids: readonly ElementId[], screen: ScreenId | undefined): DriverTarget | undefined {
  let fallback: DriverTarget | undefined;
  for (const id of ids) {
    const target = addressableTarget(defOf(map, id, screen));
    if (target === undefined) continue;
    if (!isDynamic(map, id, screen)) return target;
    fallback ??= target;
  }
  return fallback;
}

/** The gates the destination screen declares on entry — advisory, so a driver can budget for one. */
function gatesOf(map: LoadedMap, screen: ScreenId | undefined): GateId[] {
  return screen === undefined ? [] : [...(map.screens.get(screen)?.gates ?? [])];
}

/**
 * The settle target an `expect` block declares, in priority order. `screen` first because a screen
 * marker is the stable answer: it is the weight-1.0 identification signal, the instrumentation
 * guarantees it reaches the driver, and it cannot change with the data on the screen.
 */
function fromExpect(
  map: LoadedMap, expect: Expect | undefined, screen: ScreenId | undefined, prefix: 'expect' | 'verify',
): Pick<SettleHint, 'target' | 'condition' | 'source' | 'gates_possible'> | undefined {
  if (expect === undefined) return undefined;
  if (expect.screen !== undefined) {
    const marker = markerOfScreen(expect.screen);
    if (isMarker(marker) && map.screens.has(expect.screen)) {
      const gates = gatesOf(map, expect.screen);
      return {
        target: { by: 'id', id: marker }, condition: 'visible', source: `${prefix}.screen`,
        ...(gates.length > 0 ? { gates_possible: gates } : {}),
      };
    }
  }
  const visible = pickElement(map, expect.visible ?? [], screen);
  if (visible !== undefined) return { target: visible, condition: 'visible', source: `${prefix}.visible` };
  if (typeof expect.text_present === 'string' && expect.text_present !== '') {
    // static copy only (02 §6, 07 §2.1), so nothing data-bearing leaves the map
    return { target: { by: 'text', text: expect.text_present }, condition: 'visible', source: `${prefix}.text_present` };
  }
  // `focused` is not pollable as focus: Argent's iOS snapshot carries no focus flag at all
  // (04 §10), and no driver exposes a focus condition. Waiting for the field to APPEAR is the
  // honest, pollable half of a focus expectation.
  const focused = expect.focused !== undefined ? addressableTarget(defOf(map, expect.focused, screen)) : undefined;
  if (focused !== undefined) return { target: focused, condition: 'visible', source: `${prefix}.focused` };
  // A value assertion is decided at ingest against the raw tree and only a boolean survives
  // (recipes/values.ts), so the VALUE cannot be polled — but the element carrying it can, and
  // waiting for it to appear is strictly better than sleeping.
  const valued = pickElement(map, (expect.value ?? []).map((v) => v.element), screen);
  if (valued !== undefined) return { target: valued, condition: 'visible', source: `${prefix}.value` };
  // last: a negative is also satisfied by the app not having rendered yet, so it is the weakest
  // evidence that anything has settled
  const gone = pickElement(map, expect.not_visible ?? [], screen);
  if (gone !== undefined) return { target: gone, condition: 'not_visible', source: `${prefix}.not_visible` };
  return undefined;
}

/**
 * The settle hint for one step, or `undefined` when the step declares nothing pollable — which is
 * the honest answer, and the encoding for "report immediately, do not sleep".
 */
export function settleFor(map: LoadedMap, step: RecipeStep, opts: SettleOptions = {}): SettleHint | undefined {
  const screen = opts.screen;
  // 0. A gate dismissal the runner synthesized carries no `expect` of its own (04 §5). What it
  //    means to have landed is that the DIALOG IS GONE — so poll the dismiss control's
  //    disappearance, not the interrupted step's postcondition: the runner hands the step back
  //    with `retry`, so the interrupted step has not been re-executed yet and its postcondition
  //    legitimately does not hold. Polling for it would burn the whole budget on every gate.
  //
  //    This is exactly where a fixed sleep does worst — a dialog still animating away — and it is
  //    the case a driver deriving its own hint from `expect` cannot cover at all, because there is
  //    no `expect` to derive from.
  if (step.action === 'dismiss_gate') {
    const dismissId = map.ids.gates.find((g) => g.id === step.gate)?.dismiss;
    const target = dismissId === undefined ? undefined : addressableTarget(defOf(map, dismissId, step.gate));
    if (target !== undefined) {
      return { target, condition: 'not_visible', source: 'gate.retry', timeout_ms: timeoutFor(step) };
    }
  }
  const base = fromExpect(map, step.expect, screen, 'expect');
  if (base !== undefined) return { ...base, timeout_ms: timeoutFor(step) };
  // The recipe's own `verify` is checked on the report for the LAST step (guided `finish`), so it
  // is that step's real postcondition when the step itself declares none.
  if (opts.isLast === true) {
    const fromVerify = fromExpect(map, opts.verify, screen, 'verify');
    if (fromVerify !== undefined) return { ...fromVerify, timeout_ms: timeoutFor(step) };
  }
  return undefined;
}

/** A `wait_for` names its own budget (02 §6); everything else gets the shared default. */
function timeoutFor(step: RecipeStep): number {
  return step.action === 'wait_for' && typeof step.timeout_ms === 'number' ? step.timeout_ms : DEFAULT_SETTLE_MS;
}

/** Compact one-line rendering for `formatRunStep` (04 §5's 120-token step budget). */
export function formatSettle(s: SettleHint | undefined): string | undefined {
  if (s === undefined) return undefined;
  const t = s.target;
  const what = t.by === 'id' ? t.id : t.by === 'text' ? `"${t.text}"` : t.by === 'role_label' ? `${t.role}:${t.label}` : `${t.x},${t.y}`;
  return `settle ${s.condition} ${what} ${s.timeout_ms}ms`;
}

/** Every source a hint can carry, for tests and consumers that switch on it. */
export const SETTLE_SOURCE_VALUES: readonly SettleSource[] = [
  'expect.screen', 'expect.visible', 'expect.text_present', 'expect.focused', 'expect.value', 'expect.not_visible',
  'verify.screen', 'verify.visible', 'verify.text_present', 'verify.focused', 'verify.value', 'verify.not_visible',
  'gate.retry',
];
