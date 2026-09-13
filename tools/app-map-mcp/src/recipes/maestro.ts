/**
 * [C3] Recipe → Maestro flow (04 §6.2, 03 §10 `maestro-export`, 06 R5). Flows are generated,
 * never committed (06 R5); default output `.local/maestro/<recipe>.yaml`.
 *
 * Flow file: `appId: <manifest.app_id>` header, `---`, then commands:
 * | step                    | Maestro                                                                 |
 * |-------------------------|-------------------------------------------------------------------------|
 * | open_link url           | `- openLink: <url>`                                                     |
 * | tap element             | `- tapOn: {id: "<a11y_id>"}` — regex `id:` when the top exportable locator is `role_label` with `label_regex`; `text:` for `role_label.label`/`text` |
 * | type element text       | `- tapOn: {id}` then `- inputText: "<text>"`                             |
 * | select list match.text  | `- scrollUntilVisible: {element: {text: "<text>"}}` then `- tapOn: {text: "<text>"}` |
 * | select cell match.text  | the same two commands — neither form addresses the container, so the cell form (issue #19) exports identically and stays headless-eligible |
 * | swipe                   | `- swipe: {direction: <UP|DOWN|LEFT|RIGHT>, duration: <ms>}`             |
 * | dismiss_gate g          | `- runFlow: {when: {visible: {id|text: "<marker or label regex>"}}, commands: [- tapOn: {…dismiss…}]}` — emitted before every step on a screen whose `gates` lists `g`, and for explicit dismiss_gate steps |
 * | expect screen s         | `- extendedWaitUntil: {visible: {id: "screen.<s>"}, timeout: 10000}`      |
 * | expect visible e        | `- assertVisible: {id: "<e>"}`                                           |
 * | expect not_visible e    | `- assertNotVisible: {id: "<e>"}`                                        |
 * | expect focused e        | `- assertVisible: {id: "<e>", focused: true}` (04 §10: falls back to plain assertVisible when `opts.focusedSelector === false`) |
 * | expect text_present t   | `- assertVisible: {text: "<t>"}`                                          |
 * | wait_for                | `- extendedWaitUntil: {visible: …, timeout: <timeout_ms ?? 10000>}`       |
 * | recipe verify           | assertions for `screen` and each `visible`                              |
 * Params are substituted before export (`{amount}` → value). Locators export in cascade order
 * as far as Maestro can express them: `a11y_id` → `id:`, `role_label` → `id:` regex or `text:`,
 * `text` → `text:`. `path`/`geometry` are not exported; a step whose only viable locator is one
 * of those makes the recipe not headless-eligible (`eligible: false`, `ineligible_steps`).
 * Output is plain YAML (yaml.stringify, block style) — it is not an app-map document so the
 * canonical serializer is not used.
 *
 * Layer: session (imports context, types, paths, resolve, guided.substituteParams).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { stringify } from 'yaml';
import type { AppMapContext } from '../context.ts';
import type { ElementDef, ElementId, Expect, GateId, Locator, LocatorStrategy, LoadedMap, MaestroExportResult, RecipeFile, RecipeParams, RecipeStatus, RecipeStep, ScreenFile, ScreenId, StepId } from '../types.ts';
import { DEEP_LINK_REGEX, HEADLESS_STRATEGIES } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { ciParamsFile, maestroFlowFile, maestroOutDir } from '../paths.ts';

export type MaestroSelector = { id: string } | { text: string };

export interface MaestroFlow {
  /** the YAML text */
  flow: string;
  eligible: boolean;
  ineligible_steps: StepId[];
  /** step id → index of its first command in the flow (to map Maestro's failing command index back to a step, 04 §6.1) */
  command_index: Record<StepId, number>;
}

export interface FlowOptions {
  /** re-export from this step (04 §6.1 retry after heal) */
  fromStep?: StepId;
  /** default true; false compiles `expect.focused` to a plain assertVisible (04 §10) */
  focusedSelector?: boolean;
  appId?: string;
  /**
   * locator overrides per element id — the headless runner re-exports from step k with the
   * heal candidate's `proposed_locator` so `heal.verify` can test the postcondition (04 §6.1,
   * 04 §7.2 rule 3) without writing anything to the map first.
   */
  overrides?: Readonly<Record<ElementId, Locator>>;
  /**
   * gates to dismiss before the first emitted step, on top of the ones the screen declares —
   * used when the hierarchy dump after a failure showed a gate the map does not list on that
   * screen (04 §6.1 step 3 "attempt gate dismissal").
   */
  dismissGates?: readonly GateId[];
}

/** one Maestro command (`{tapOn: {...}}`, `{openLink: "..."}`, …) */
type Command = Record<string, unknown>;

/** 10 000 ms — the `expect screen` / `wait_for` default from the 04 §6.2 mapping table. */
const DEFAULT_WAIT_MS = 10_000;

/**
 * `{amount}` → `params.amount` (String()); unknown slots are left as-is. Mirrors
 * `guided.substituteParams` (04 §3.4) — kept local so the export path (CI, 06 R5) does not
 * depend on the guided-replay state machine.
 */
function substituteSlots(text: string, params: RecipeParams): string {
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
    const v = params[name];
    return v === undefined ? whole : String(v);
  });
}

/** the screen a deep link lands on (`appmap://invoice_new?fixture=…` → `invoice_new`), when it names one */
function screenOfDeepLink(link: string | undefined): ScreenId | undefined {
  if (typeof link !== 'string') return undefined;
  const m = DEEP_LINK_REGEX.exec(link);
  return m?.[1];
}

/** every declaration of `id`, preferring the one on `screen` (02 §5: ids are unique per screen file) */
function elementDefFor(map: LoadedMap, id: ElementId, screen?: ScreenId): ElementDef | undefined {
  const refs = map.elements.get(id) ?? [];
  if (refs.length === 0) return undefined;
  if (screen !== undefined) {
    const onScreen = refs.find((r) => r.screen === screen);
    if (onScreen) return onScreen.element;
  }
  return refs[0]?.element;
}

/** 04 §6.2 locator cascade, as far as Maestro can express it. */
export function maestroSelectorFor(element: ElementDef): MaestroSelector | undefined {
  const locators = Array.isArray(element?.locators) ? element.locators : [];
  for (const loc of locators) {
    const sel = selectorForLocator(loc);
    if (sel) return sel;
  }
  return undefined;
}

/** `a11y_id` → `id:`; `role_label` → `id:` regex (label_regex) or `text:` (label); `text` → `text:`. */
function selectorForLocator(loc: Locator | undefined): MaestroSelector | undefined {
  if (!loc || !(HEADLESS_STRATEGIES as readonly LocatorStrategy[]).includes(loc.strategy)) return undefined;
  if (loc.strategy === 'a11y_id') return typeof loc.value === 'string' && loc.value !== '' ? { id: loc.value } : undefined;
  if (loc.strategy === 'text') return typeof loc.value === 'string' && loc.value !== '' ? { text: loc.value } : undefined;
  // role_label: Maestro matches `id:`/`text:` as regexes, so a `label_regex` exports as the
  // regex form of `id:` (04 §6.2) and a literal label as `text:`.
  const v = loc.value;
  if (!v || typeof v !== 'object') return undefined;
  const rl = v as { label?: string; label_regex?: string };
  if (typeof rl.label_regex === 'string' && rl.label_regex !== '') return { id: rl.label_regex };
  if (typeof rl.label === 'string' && rl.label !== '') return { text: rl.label };
  return undefined;
}

/** selector for an element id, honouring `opts.overrides` (heal candidates, 04 §6.1). */
function selectorForElement(map: LoadedMap, id: ElementId, screen: ScreenId | undefined, overrides: FlowOptions['overrides']): MaestroSelector | undefined {
  const override = overrides?.[id];
  if (override) return selectorForLocator(override);
  const def = elementDefFor(map, id, screen);
  if (!def) return undefined;
  return maestroSelectorFor(def);
}

/** `{id}`/`{text}` for a gate's `when:` guard: the gate marker, else its first `required_labels` entry. */
function gateWhenSelector(gate: ScreenFile): MaestroSelector | undefined {
  const marker = gate.signature?.marker;
  if (typeof marker === 'string' && marker !== '' && marker !== 'none') return { id: marker };
  const label = gate.signature?.required_labels?.[0];
  if (label) {
    if (typeof label.label_regex === 'string' && label.label_regex !== '') return { id: label.label_regex };
    if (typeof label.label === 'string' && label.label !== '') return { text: label.label };
  }
  return undefined;
}

/**
 * `- runFlow: {when: {visible: <gate marker|label regex>}, commands: [- tapOn: <dismiss>]}`
 * (04 §6.2). `undefined` when the gate or its dismiss control cannot be expressed — the caller
 * marks the step ineligible.
 */
function gateGuard(map: LoadedMap, gateId: GateId, overrides: FlowOptions['overrides']): Command | undefined {
  const gate = map.gates.get(gateId);
  if (!gate) return undefined;
  const when = gateWhenSelector(gate);
  const dismissId = map.ids.gates.find((g) => g.id === gateId)?.dismiss;
  if (!when || !dismissId) return undefined;
  const dismiss = selectorForElement(map, dismissId, gateId, overrides);
  if (!dismiss) return undefined;
  return { runFlow: { when: { visible: when }, commands: [{ tapOn: dismiss }] } };
}

interface EmitState {
  map: LoadedMap;
  params: RecipeParams;
  focused: boolean;
  overrides: FlowOptions['overrides'];
  commands: Command[];
  ineligible: Set<StepId>;
  screen: ScreenId | undefined;
}

/** `extendedWaitUntil` on a screen marker (04 §6.2 `expect screen`). */
function waitForScreen(screen: ScreenId, timeout = DEFAULT_WAIT_MS): Command {
  return { extendedWaitUntil: { visible: { id: `screen.${screen}` }, timeout } };
}

/** assertions for one `expect` block, in EXPECT_KEYS order; `skip` drops keys a `wait_for` already consumed. */
/**
 * `expect.visible` / `expect.not_visible` as an array of element ids. The JSON schema already
 * requires an array, but this library is also callable with an unvalidated `RecipeFile`, and a
 * scalar there used to crash with a raw TypeError instead of the `AppMapError(code, message,
 * hint)` every error in this package is (architecture §1, 03 §11).
 */
function idList(value: unknown, stepId: StepId, field: string): ElementId[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AppMapError(
      ERROR_CODES.BAD_INPUT,
      `${stepId}: ${field} must be an array of element ids`,
      `e.g. ${field}: [invoice.save.button]`,
    );
  }
  return value as ElementId[];
}

function emitExpect(st: EmitState, stepId: StepId, expect: Expect | undefined, skip: { screen?: boolean; firstVisible?: boolean; text_present?: boolean } = {}): void {
  if (!expect) return;
  if (expect.screen && !skip.screen) st.commands.push(waitForScreen(expect.screen));
  if (expect.focused) {
    const sel = selectorForElement(st.map, expect.focused, st.screen, st.overrides);
    if (!sel) st.ineligible.add(stepId);
    // 04 §10: Maestro's `focused` selector is unconfirmed; `focusedSelector: false` degrades it
    // to a plain visibility assertion.
    else st.commands.push({ assertVisible: st.focused ? { ...sel, focused: true } : { ...sel } });
  }
  const visible = idList(expect.visible, stepId, 'expect.visible');
  visible.forEach((id, i) => {
    if (i === 0 && skip.firstVisible) return;
    const sel = selectorForElement(st.map, id, st.screen, st.overrides);
    if (!sel) st.ineligible.add(stepId);
    else st.commands.push({ assertVisible: sel });
  });
  for (const id of idList(expect.not_visible, stepId, 'expect.not_visible')) {
    const sel = selectorForElement(st.map, id, st.screen, st.overrides);
    if (!sel) st.ineligible.add(stepId);
    else st.commands.push({ assertNotVisible: sel });
  }
  if (expect.text_present && !skip.text_present) st.commands.push({ assertVisible: { text: expect.text_present } });
}

/** the gate guards a step on `st.screen` carries (04 §6.2: emitted before every step listing the gate). */
function emitGateGuards(st: EmitState, stepId: StepId, extra: readonly GateId[] = []): void {
  const declared = (st.screen !== undefined ? st.map.screens.get(st.screen)?.gates : undefined) ?? [];
  const seen = new Set<GateId>();
  for (const gateId of [...extra, ...declared]) {
    if (seen.has(gateId)) continue;
    seen.add(gateId);
    const guard = gateGuard(st.map, gateId, st.overrides);
    if (!guard) st.ineligible.add(stepId);
    else st.commands.push(guard);
  }
}

/** one recipe step → its Maestro commands (04 §6.2 mapping table). */
function emitStep(st: EmitState, step: RecipeStep): void {
  const id = step.id;
  switch (step.action) {
    case 'open_link': {
      st.commands.push({ openLink: substituteSlots(step.url, st.params) });
      break;
    }
    case 'tap': {
      const sel = selectorForElement(st.map, step.element, st.screen, st.overrides);
      if (!sel) st.ineligible.add(id);
      else st.commands.push({ tapOn: sel });
      break;
    }
    case 'type': {
      const sel = selectorForElement(st.map, step.element, st.screen, st.overrides);
      if (!sel) st.ineligible.add(id);
      else st.commands.push({ tapOn: sel });
      st.commands.push({ inputText: substituteSlots(step.text, st.params) });
      break;
    }
    case 'select': {
      // Neither form addresses the container: Maestro scrolls to the matching row by text. That
      // is already exactly the semantics of `select {cell, match}` (the rows share one id, the
      // text picks one), so both forms export to the same two commands (04 §6.2, issue #19).
      const text = substituteSlots(step.match.text, st.params);
      st.commands.push({ scrollUntilVisible: { element: { text } } });
      st.commands.push({ tapOn: { text } });
      break;
    }
    case 'swipe': {
      const swipe: Record<string, unknown> = { direction: step.direction.toUpperCase() };
      if (typeof step.duration_ms === 'number') swipe.duration = step.duration_ms;
      st.commands.push({ swipe });
      break;
    }
    case 'dismiss_gate': {
      const guard = gateGuard(st.map, step.gate, st.overrides);
      if (!guard) st.ineligible.add(id);
      else st.commands.push(guard);
      break;
    }
    case 'wait_for': {
      const timeout = typeof step.timeout_ms === 'number' ? step.timeout_ms : DEFAULT_WAIT_MS;
      const expect = step.expect;
      if (expect.screen) {
        st.commands.push(waitForScreen(expect.screen, timeout));
        emitExpect(st, id, expect, { screen: true });
      } else if (expect.visible?.[0]) {
        const sel = selectorForElement(st.map, expect.visible[0], st.screen, st.overrides);
        if (!sel) st.ineligible.add(id);
        else st.commands.push({ extendedWaitUntil: { visible: sel, timeout } });
        emitExpect(st, id, expect, { firstVisible: true });
      } else if (expect.text_present) {
        st.commands.push({ extendedWaitUntil: { visible: { text: expect.text_present }, timeout } });
        emitExpect(st, id, expect, { text_present: true });
      } else {
        emitExpect(st, id, expect);
      }
      return; // wait_for already emitted its own expect block
    }
  }
  emitExpect(st, id, step.expect);
}

/**
 * Pure. Entry (`s0`) is the recipe's deep link plus an `extendedWaitUntil` on the screen it
 * lands on; without a deep link the `entry.fallback_path` expands to `s0a, s0b, …` edge taps
 * (RUN_STEP_ID_REGEX, architecture §7 decision 17). With `opts.fromStep` the entry is skipped
 * and the flow starts at that step — 04 §6.1 re-runs from step k on the device the previous
 * run left mid-flow.
 */
export function recipeToMaestroFlow(map: LoadedMap, recipe: RecipeFile, params: RecipeParams, opts: FlowOptions = {}): MaestroFlow {
  const st: EmitState = {
    map,
    params,
    focused: opts.focusedSelector !== false,
    overrides: opts.overrides,
    commands: [],
    ineligible: new Set<StepId>(),
    screen: undefined,
  };
  const command_index: Record<StepId, number> = {};
  const entry = recipe.entry ?? {};
  const fallbackPath = entry.fallback_path ?? [];
  const deepLink = entry.deep_link && entry.deep_link !== 'none' ? entry.deep_link : undefined;
  let started = opts.fromStep === undefined;
  let pendingExtraGates = opts.dismissGates ?? [];

  const begin = (stepId: StepId): boolean => {
    if (!started && stepId === opts.fromStep) started = true;
    if (!started) return false;
    command_index[stepId] = st.commands.length;
    emitGateGuards(st, stepId, pendingExtraGates);
    pendingExtraGates = [];
    return true;
  };

  // ---- entry (04 §5 step 5: `s0`, or `s0a…` from the fallback path) -------------------------
  if (deepLink) {
    const target = screenOfDeepLink(deepLink);
    if (begin('s0')) {
      st.commands.push({ openLink: substituteSlots(deepLink, params) });
      if (target) st.commands.push(waitForScreen(target));
    }
    st.screen = target;
  } else if (fallbackPath.length > 0) {
    const first = fallbackPath[0] as ScreenId;
    const firstLink = map.screens.get(first)?.deep_link;
    if (firstLink && firstLink !== 'none') {
      if (begin('s0')) {
        st.commands.push({ openLink: firstLink });
        st.commands.push(waitForScreen(first));
      }
      st.screen = first;
    } else {
      // no way in without a deep link: the recipe stays guided (04 §6.2)
      if (begin('s0')) st.ineligible.add('s0');
      st.screen = first;
    }
    for (let i = 0; i + 1 < fallbackPath.length; i++) {
      const from = fallbackPath[i] as ScreenId;
      const to = fallbackPath[i + 1] as ScreenId;
      const stepId = `s0${String.fromCharCode(97 + i)}`;
      const edge = map.screens.get(from)?.edges?.find((e) => e.to === to);
      if (!begin(stepId)) {
        st.screen = to;
        continue;
      }
      const action = edge?.action;
      if (!action || (action.type !== 'tap' && action.type !== 'select' && action.type !== 'open_link')) {
        st.ineligible.add(stepId);
      } else if (action.type === 'open_link') {
        st.commands.push({ openLink: action.url });
      } else {
        const sel = selectorForElement(map, action.element, from, st.overrides);
        if (!sel) st.ineligible.add(stepId);
        else st.commands.push({ tapOn: sel });
      }
      st.commands.push(waitForScreen(to));
      st.screen = to;
    }
  } else {
    if (begin('s0')) st.ineligible.add('s0');
  }

  // ---- recipe steps ------------------------------------------------------------------------
  for (const step of recipe.steps ?? []) {
    if (!begin(step.id)) {
      if (step.expect?.screen) st.screen = step.expect.screen;
      continue;
    }
    emitStep(st, step);
    if (step.expect?.screen) st.screen = step.expect.screen;
  }

  // ---- recipe verify (04 §6.2 last row) -----------------------------------------------------
  if (started) emitExpect(st, recipe.steps?.[recipe.steps.length - 1]?.id ?? 's0', recipe.verify);

  const appId = opts.appId ?? map.manifest.app_id;
  const body = stringify(st.commands, { indent: 2, lineWidth: 0, minContentWidth: 0, singleQuote: false, nullStr: 'null' });
  const ineligible_steps = Array.from(st.ineligible);
  return {
    flow: `appId: ${appId}\n---\n${body}`,
    eligible: ineligible_steps.length === 0,
    ineligible_steps,
    command_index,
  };
}

/** Pure: Maestro's failing command index → the recipe step it belongs to. */
export function stepForCommandIndex(flow: MaestroFlow, commandIndex: number): StepId | undefined {
  let best: StepId | undefined;
  let bestAt = -1;
  for (const [stepId, at] of Object.entries(flow.command_index)) {
    if (at <= commandIndex && at >= bestAt) {
      best = stepId;
      bestAt = at;
    }
  }
  return best;
}

export interface MaestroExportOptions {
  recipes?: string[];
  all?: boolean;
  /** filter by status (06 R5 uses `['ci_gate']`) */
  statuses?: RecipeStatus[];
  /** default `paths.maestroOutDir(config)` */
  outDir?: string;
  /**
   * params per recipe. Resolution order per param: `params[recipe][name]` → the params file
   * (`paramsFile` ?? `paths.ciParamsFile(config)` when it exists) → `params[].values?.[0]`
   * (enum default). A REQUIRED param still without a value → `AppMapError(bad_input)` naming
   * `<recipe>.<param>` — the flow is never written with a literal `{slot}`.
   */
  params?: Record<string, RecipeParams>;
  /** `--params-file <json>`: `{ "<recipe_id>": { "<param>": value } }` (fixture data from the app, never committed — 07 §2.3.5) */
  paramsFile?: string;
}

/** Load a params file (`{recipe: {param: value}}`); `bad_input` on shape errors; `{}` when absent and `required` is false. */
export function readParamsFile(path: string, opts: { required?: boolean } = {}): Record<string, RecipeParams> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    if (opts.required) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `params file not found: ${path}`, 'generate .local/ci-params.<platform>.json at build time or pass --params-file (04 §6.2)');
    }
    return {};
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `params file ${path} is not valid JSON: ${(e as Error).message}`, 'expected {"<recipe_id>": {"<param>": value}}');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `params file ${path} must be an object of recipes`, 'expected {"<recipe_id>": {"<param>": value}}');
  }
  const out: Record<string, RecipeParams> = {};
  for (const [recipe, values] of Object.entries(doc as Record<string, unknown>)) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `params file ${path}: ${recipe} must map param names to scalars`, 'expected {"<recipe_id>": {"<param>": value}}');
    }
    const params: RecipeParams = {};
    for (const [name, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new AppMapError(ERROR_CODES.BAD_INPUT, `params file ${path}: ${recipe}.${name} must be a string, number or boolean`, 'fixture values are scalars (07 §2.3.5)');
      }
      params[name] = value;
    }
    out[recipe] = params;
  }
  return out;
}

/** Pure: the values a recipe will run with (see `MaestroExportOptions.params`); throws `bad_input` listing missing required params. */
export function resolveRecipeParams(recipe: RecipeFile, sources: { explicit?: RecipeParams; file?: RecipeParams }): RecipeParams {
  const out: RecipeParams = {};
  const missing: string[] = [];
  for (const param of recipe.params ?? []) {
    const explicit = sources.explicit?.[param.name];
    const fromFile = sources.file?.[param.name];
    const enumDefault = param.values?.[0];
    const value = explicit ?? fromFile ?? enumDefault;
    if (value === undefined) {
      if (param.required) missing.push(`${recipe.id}.${param.name}`);
      continue;
    }
    out[param.name] = value;
  }
  if (missing.length > 0) {
    throw new AppMapError(
      ERROR_CODES.BAD_INPUT,
      `missing required recipe params: ${missing.join(', ')}`,
      'pass --params-file, generate .local/ci-params.<platform>.json, or supply the values inline (04 §6.2, 06 R5)',
    );
  }
  return out;
}

/** `app-map maestro-export [R | --all] [--status s,…] [--params-file f] --out DIR` — writes one flow per recipe. */
export function maestroExport(ctx: AppMapContext, opts: MaestroExportOptions): MaestroExportResult {
  const outDir = opts.outDir ?? maestroOutDir(ctx.config);
  const platform = ctx.config.platform;
  const wanted = opts.recipes ?? [];
  let recipes: RecipeFile[];
  if (wanted.length > 0) {
    recipes = wanted.map((id) => {
      const r = ctx.db.getRecipe(id) ?? ctx.map.recipes.get(id);
      if (!r) throw new AppMapError(ERROR_CODES.NOT_FOUND, `recipe not found: ${id}`, 'run `app-map validate` or check app-map/<platform>/recipes/');
      return r;
    });
  } else {
    // 06 R5: `--status ci_gate`; retired recipes are never exported (04 §8)
    const statuses = opts.statuses ?? (['candidate', 'verified', 'ci_gate'] as RecipeStatus[]);
    recipes = ctx.db.listRecipes({ statuses });
    if (recipes.length === 0) recipes = Array.from(ctx.map.recipes.values()).filter((r) => statuses.includes(r.status));
  }
  recipes = recipes.filter((r) => r.platform === platform).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fileParams = readParamsFile(opts.paramsFile ?? ciParamsFile(ctx.config), { required: opts.paramsFile !== undefined });
  const flows: MaestroExportResult['flows'] = [];
  for (const recipe of recipes) {
    const params = resolveRecipeParams(recipe, { explicit: opts.params?.[recipe.id], file: fileParams[recipe.id] });
    const flow = recipeToMaestroFlow(ctx.map, recipe, params);
    const path = maestroFlowFile(ctx.config, recipe.id, outDir);
    // An ineligible flow is never written: 06 R5 runs `maestro test <dir>` over the whole
    // directory and a half-expressible flow would fail the gate for the wrong reason.
    if (flow.eligible) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, flow.flow, 'utf8');
    } else {
      ctx.log.warn('maestro-export: recipe is not headless-eligible', { recipe: recipe.id, ineligible_steps: flow.ineligible_steps });
    }
    flows.push({ recipe: recipe.id, path, eligible: flow.eligible, ineligible_steps: flow.ineligible_steps });
  }
  return { flows, out_dir: outDir };
}
