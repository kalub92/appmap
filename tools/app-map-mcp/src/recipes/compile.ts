/**
 * [C1] Recipe compiler (04 §3, 03 §8 `compile_recipe`, 03 §10 `compile`).
 *
 * `compileRecipe(ctx, input)` produces a DRAFT (`status: candidate`) from the session's
 * trajectory (observe.readTrajectory / db.listObservations) and returns it for LLM review.
 * Nothing is written until `mark_recipe(candidate)` (lifecycle.markRecipe) — 04 §3.8.
 *
 *  1. slice: observations from the task's `task_seq` (or `input.from_seq`) to `input.to_seq`,
 *     else the session's `task_end_seq` (set by `observe.finishTask`: compile_recipe/Stop hook/
 *     guided done — 04 §3.1's "report_task(ok)"), else the first observation whose
 *     `screen_after` satisfies `verify`, else the last observation; observations before a task
 *     is declared are not compilable (`no_task`);
 *  2. collapse backtracking: remove `A → B → A` loops where no `type` happened in B (repeat until
 *     stable) and repeated identical consecutive taps; a trajectory that keeps looping without
 *     converging on a new screen → `loops_never_converge`;
 *  3. translate: tap with `element` → `tap`; `type_text` → `type` on the focused element of the
 *     previous snapshot (else the last tapped field); tap on a `dynamic` cell → `select` on the
 *     enclosing dynamic `list` with `match.text` = the tapped text; `open_url` → `open_link`;
 *     `swipe` → `swipe`; a tap that dismissed a gate (gate present before, absent after, element
 *     is a gate dismiss id) → `dismiss_gate`;
 *  4. parameterize: every typed/selected value equal (case-insensitive, trimmed; money values
 *     compared numerically) to a declared param's value becomes `{name}`; values come from
 *     `input.values` (the LLM/CLI knows what it typed) and, for params without one, from
 *     `match.inferParams(recipe-like {params}, input.task)`; literal values that are not static
 *     copy (`map.staticLabels`) → `unparameterized_value` with `offending_values` so the LLM
 *     re-calls with `values` (07 §2.3.5);
 *  5. entry: if the first acted-on screen has a `deep_link`, `entry.deep_link` = that link
 *     (`?fixture=logged_in` appended when the recipe has `auth: logged_in`) and the leading
 *     navigation steps become `entry.fallback_path` (screen ids);
 *  6. postconditions: `expect.screen` when the screen changed, else `focused`/`visible` inferred
 *     from the next observation's snapshot; a step whose outcome cannot be expressed →
 *     `missing_postcondition`;
 *  7. `intent_critical: true` on steps touching `intent_critical` elements;
 *  8. emit `RecipeFile` (version 1, or `revision_of + 1` for revisions) with provenance
 *     `{compiled_from: session, compiled_by: app-map-mcp@<pkg version>}`, a placeholder `matches` derived from the recipe id (never the raw task text,
 *     which 02 §10 rule 8 would reject)
 *     placeholder replaced by `[task]` escaped as a literal regex, and canonical YAML text;
 *     emit a `compile` event (08 §2).
 *
 * Layer: session (imports context, types, tree, identify, resolve, yaml/canonical, events).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppMapContext } from '../context.ts';
import type { CompileRecipeInput, CompileRecipeResult, ElementId, Expect, LoadedMap, Observation, RecipeEntry, RecipeFile, RecipeParam, RecipeStep, ScreenId, ScrubbedTree, StepId } from '../types.ts';
import { PARAM_SLOT_REGEX, UNKNOWN_SCREEN, screenIdOfDeepLink, stepElement } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { PACKAGE_ROOT } from '../paths.ts';
import { walk } from '../tree.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { inferParams } from './match.ts';
import { readTrajectory } from '../observe.ts';

/** 07 §4 / recipe.schema.json: a `matches[]` source is at most this many characters. */
const MAX_MATCH_SOURCE = 200;

/** `app-map-mcp@<semver>` for `provenance.compiled_by` (read once, falls back to the declared version). */
let cachedVersion: string | undefined;
export function compiledBy(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: unknown };
      cachedVersion = typeof pkg.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+/.test(pkg.version) ? pkg.version : '0.1.0';
    } catch {
      cachedVersion = '0.1.0';
    }
  }
  return `app-map-mcp@${cachedVersion}`;
}

// ---------------------------------------------------------------------------------------------
// Step 1 — slice (04 §3.1)
// ---------------------------------------------------------------------------------------------

/** ids present on a snapshot (postcondition checks + `visible` assertions) */
function idsOf(snapshot: ScrubbedTree | null): Set<string> {
  const out = new Set<string>();
  if (snapshot === null) return out;
  walk(snapshot, (n) => { if (typeof n.a11y_id === 'string' && n.a11y_id !== '') out.add(n.a11y_id); });
  return out;
}

/** Does the state after `obs` satisfy `expect`? (the compiler's own minimal check — guided.ts owns replay-time verification) */
function satisfies(obs: Observation, expect: Expect): boolean {
  if (expect.screen !== undefined && obs.screen_after !== expect.screen) return false;
  const ids = idsOf(obs.snapshot);
  if (expect.visible !== undefined && !expect.visible.every((id) => ids.has(id))) return false;
  if (expect.not_visible !== undefined && expect.not_visible.some((id) => ids.has(id))) return false;
  if (expect.focused !== undefined && focusedIdOf(obs.snapshot) !== expect.focused) return false;
  return true;
}

/** Step 1. Pure. `toSeq` (inclusive) wins over `verify`. */
export function sliceTrajectory(observations: readonly Observation[], opts: { fromSeq: number; toSeq?: number; verify?: Expect }): Observation[] {
  const ordered = [...observations].sort((a, b) => a.seq - b.seq).filter((o) => o.seq >= opts.fromSeq);
  if (opts.toSeq !== undefined) return ordered.filter((o) => o.seq <= opts.toSeq!);
  if (opts.verify !== undefined) {
    // 04 §3.1: "to the first observation where … a `verify`-satisfying screen appears"
    const end = ordered.findIndex((o) => satisfies(o, opts.verify!));
    if (end >= 0) return ordered.slice(0, end + 1);
  }
  return ordered;
}

// ---------------------------------------------------------------------------------------------
// Step 2 — collapse backtracking (04 §3.2)
// ---------------------------------------------------------------------------------------------

/**
 * "nothing was typed in B" (04 §3.2). A driver call enters a value when it types text or when
 * it taps BY TEXT — the latter is 04 §3.3's "tap on a dynamic cell", which compiles to a
 * `select` carrying the selected value. Derivable from the observation alone (this function has
 * no map): the scrubber may have dropped the row's text from the tree, but the driver `input`
 * still carries what the agent asked for (architecture §7 decision 13).
 */
function entersValue(obs: Observation): boolean {
  if (/type|input_text|set_text|enter_text/i.test(obs.tool)) return true;
  return typeof obs.input.text === 'string' && obs.input.text !== '';
}

/** two consecutive driver calls that are the same tap (04 §3.2 "repeated identical taps") */
function sameTap(a: Observation, b: Observation): boolean {
  if (a.tool !== b.tool) return false;
  if (a.screen_before !== b.screen_before || a.screen_after !== b.screen_after) return false;
  const ka = JSON.stringify([a.input.id ?? null, a.input.text ?? null, a.input.x ?? null, a.input.y ?? null]);
  const kb = JSON.stringify([b.input.id ?? null, b.input.text ?? null, b.input.x ?? null, b.input.y ?? null]);
  return ka === kb;
}

/** Step 2. Pure. `removed` = seqs dropped. */
export function collapseBacktracking(observations: readonly Observation[]): { observations: Observation[]; removed: number[] } {
  let list = [...observations];
  const removed: number[] = [];
  // bounded: each pass removes at least one observation, so at most `length` passes run
  for (let pass = 0; pass <= observations.length; pass++) {
    let changed = false;

    // (a) A → B → A with nothing typed or selected in B
    outer: for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const A = a.screen_before;
      const B = a.screen_after;
      if (A === B || A === UNKNOWN_SCREEN || B === UNKNOWN_SCREEN) continue;
      for (let j = i + 1; j < list.length; j++) {
        const back = list[j]!;
        // the excursion must stay inside B and leave no value behind
        if (list.slice(i + 1, j + 1).some(entersValue)) break;
        if (back.screen_before !== B) break;
        if (back.screen_after === A) {
          for (const o of list.slice(i, j + 1)) removed.push(o.seq);
          list = [...list.slice(0, i), ...list.slice(j + 1)];
          changed = true;
          break outer;
        }
        if (back.screen_after !== B) break; // wandered further away: not a simple A → B → A loop
      }
    }
    if (changed) continue;

    // (b) repeated identical consecutive taps
    for (let i = 1; i < list.length; i++) {
      if (!sameTap(list[i - 1]!, list[i]!)) continue;
      removed.push(list[i]!.seq);
      list = [...list.slice(0, i), ...list.slice(i + 1)];
      changed = true;
      break;
    }
    if (!changed) break;
  }
  removed.sort((a, b) => a - b);
  return { observations: list, removed };
}

// ---------------------------------------------------------------------------------------------
// Step 3 — translate (04 §3.3)
// ---------------------------------------------------------------------------------------------

/** literal (un-parameterized) step + the screen it was taken on */
export interface TranslatedStep { step: RecipeStep; screen: ScreenId; from_seq: number }

/** the id of the focused node of a snapshot, registered or not */
function focusedIdOf(snapshot: ScrubbedTree | null): string | undefined {
  if (snapshot === null) return undefined;
  let found: string | undefined;
  walk(snapshot, (n) => {
    if (found === undefined && n.focused === true && typeof n.a11y_id === 'string' && n.a11y_id !== '') found = n.a11y_id;
  });
  return found;
}

/** The focused element id in a scrubbed snapshot (registered ids only), for `type` translation. */
export function focusedElement(map: LoadedMap, obs: Observation): ElementId | undefined {
  const id = focusedIdOf(obs?.snapshot ?? null);
  return id !== undefined && map.elementRegistry.has(id) ? id : undefined;
}

const OPEN_LINK_RE = /open_url|open_link|openlink|deep_?link/i;
const SWIPE_RE = /swipe|scroll/i;
const TYPE_RE = /type|input_text|set_text|enter_text/i;
const TAP_RE = /tap|click|press|touch/i;
/** perception-only calls are not steps (03 §8 "do not take screenshots"); they never reach a recipe */
const PERCEPTION_RE = /screenshot|snapshot|hierarchy|describe|dump|accessibility/i;

/** the dynamic `list` enclosing a dynamic cell on `screen` (04 §3.3 `select`) */
function enclosingDynamicList(map: LoadedMap, screen: ScreenId, cell: ElementId): ElementId | undefined {
  const file = map.screens.get(screen);
  if (file === undefined) return undefined;
  const lists = file.elements.filter((e) => e.dynamic === true && e.role === 'list' && e.id !== cell);
  if (lists.length === 1) return lists[0]!.id;
  // several dynamic lists: prefer the one sharing the cell's id prefix (`client.picker.cell` → `client.picker.list`)
  const prefix = cell.slice(0, cell.lastIndexOf('.') + 1);
  return lists.find((e) => e.id.startsWith(prefix))?.id;
}

/** Step 3. Pure. */
export function translateSteps(map: LoadedMap, observations: readonly Observation[]): TranslatedStep[] {
  const out: TranslatedStep[] = [];
  let lastTypedTarget: ElementId | undefined;
  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i]!;
    const prev = observations[i - 1];
    // the screen the step was taken ON (`unknown` before anything was identified, decision 15)
    const screen: ScreenId = obs.screen_before;
    const id = `s${out.length + 1}`;
    const push = (step: RecipeStep): void => { out.push({ step, screen, from_seq: obs.seq }); };

    if (PERCEPTION_RE.test(obs.tool) && !TAP_RE.test(obs.tool)) continue;

    if (OPEN_LINK_RE.test(obs.tool) && typeof obs.input.url === 'string') {
      push({ id, action: 'open_link', url: obs.input.url });
      continue;
    }
    if (TYPE_RE.test(obs.tool)) {
      // 04 §3.3: `type` lands on the focused element of the previous snapshot, else the last tapped field
      const element = (prev !== undefined ? focusedElement(map, prev) : undefined) ?? obs.element ?? lastTypedTarget;
      if (element === undefined) continue;
      push({ id, action: 'type', element, text: String(obs.input.text ?? '') });
      continue;
    }
    if (SWIPE_RE.test(obs.tool) && !TAP_RE.test(obs.tool)) {
      push({ id, action: 'swipe', direction: obs.input.direction ?? 'up', ...(obs.element !== undefined ? { element: obs.element } : {}) });
      continue;
    }
    if (TAP_RE.test(obs.tool)) {
      const element = obs.element;
      if (element === undefined) continue; // an unresolvable tap is not compilable into a step
      lastTypedTarget = element;
      // a tap that dismissed a gate: the gate was present before and is gone after, and the
      // element is that gate's dismiss control (04 §3.3)
      const before = prev?.gates_present ?? [];
      const after = obs.gates_present ?? [];
      const dismissed = before.find((g) => !after.includes(g) && map.ids.gates.some((x) => x.id === g && x.dismiss === element));
      if (dismissed !== undefined) {
        push({ id, action: 'dismiss_gate', gate: dismissed });
        continue;
      }
      // a tap on a `dynamic` cell is a `select` on the enclosing dynamic list (04 §3.3)
      if (map.elementRegistry.get(element)?.dynamic === true) {
        const list = enclosingDynamicList(map, screen, element);
        if (list !== undefined) {
          push({ id, action: 'select', list, match: { text: String(obs.input.text ?? obs.input.index ?? '') } });
          continue;
        }
      }
      push({ id, action: 'tap', element });
      continue;
    }
    // an unknown driver verb is not a step; the LLM sees it in `warnings`
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Step 4 — parameterize (04 §3.4)
// ---------------------------------------------------------------------------------------------

/** the literal value a step carries (the only place a data value can hide in a step) */
function literalOf(step: RecipeStep): string | undefined {
  if (step.action === 'type') return step.text;
  if (step.action === 'select') return step.match.text;
  return undefined;
}
function withLiteral(step: RecipeStep, value: string): RecipeStep {
  if (step.action === 'type') return { ...step, text: value };
  if (step.action === 'select') return { ...step, match: { ...step.match, text: value } };
  return step;
}

function numeric(x: string | number): number | undefined {
  const n = typeof x === 'number' ? x : Number(String(x).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** Step 4. Pure. `values` = `input.values` merged over `inferParams` (see module doc). */
export function parameterize(steps: readonly TranslatedStep[], params: readonly RecipeParam[], values: Readonly<Record<string, string | number>>, staticLabels: ReadonlySet<string>): { steps: TranslatedStep[]; offending: string[] } {
  const out: TranslatedStep[] = [];
  const offending: string[] = [];
  for (const ts of steps) {
    const literal = literalOf(ts.step);
    if (literal === undefined || literal === '' || PARAM_SLOT_REGEX.test(literal)) {
      out.push(ts);
      continue;
    }
    let slot: string | undefined;
    for (const param of params) {
      const value = values[param.name];
      if (value === undefined) continue;
      if (param.type === 'money' || param.type === 'number') {
        const a = numeric(literal);
        const b = numeric(value);
        if (a !== undefined && b !== undefined && a === b) { slot = `{${param.name}}`; break; }
      } else if (String(value).trim().toLowerCase() === literal.trim().toLowerCase()) {
        slot = `{${param.name}}`;
        break;
      }
    }
    if (slot !== undefined) {
      out.push({ ...ts, step: withLiteral(ts.step, slot) });
      continue;
    }
    // 04 §3.4: a literal survives only when it is static copy; otherwise the LLM must declare a param
    if (staticLabels.has(literal)) {
      out.push(ts);
      continue;
    }
    if (!offending.includes(literal)) offending.push(literal);
    out.push(ts);
  }
  return { steps: out, offending };
}

// ---------------------------------------------------------------------------------------------
// Step 5 — entry optimization (04 §3.5)
// ---------------------------------------------------------------------------------------------

/** 04 §3.5: `?fixture=logged_in` is appended when the recipe has `auth: logged_in` */
function withFixture(deepLink: string, loggedIn: boolean): string {
  if (!loggedIn || /[?&]fixture=/.test(deepLink)) return deepLink;
  return `${deepLink}${deepLink.includes('?') ? '&' : '?'}fixture=logged_in`;
}

function deepLinkOf(map: LoadedMap, screen: ScreenId): string | undefined {
  const link = map.screens.get(screen)?.deep_link;
  return typeof link === 'string' && link !== 'none' && link !== '' ? link : undefined;
}

/**
 * A step that only moved between screens: a deep link, or an action on a non-`intent_critical`
 * element that entered no value and left the screen. Everything else is a step of the recipe
 * proper and fixes "the first screen where a step is taken" (04 §3.5).
 */
function isNavigation(map: LoadedMap, current: TranslatedStep, next: TranslatedStep | undefined): boolean {
  if (next === undefined) return false; // at least one step always survives
  if (current.step.action === 'open_link') return true;
  if (current.screen === next.screen) return false; // it acted without moving: this is the entry screen
  if (literalOf(current.step) !== undefined) return false; // it entered a value
  const element = stepElement(current.step);
  // 04 §7.2 invariant 6: an intent_critical action is never "just navigation"
  if (element !== undefined && map.elementRegistry.get(element)?.intent_critical === true) return false;
  return true;
}

/** Step 5. Pure. */
export function optimizeEntry(map: LoadedMap, steps: readonly TranslatedStep[], loggedIn: boolean): { entry: RecipeEntry; steps: TranslatedStep[] } {
  if (steps.length === 0) return { entry: {}, steps: [] };
  let entryIdx = 0;
  while (entryIdx < steps.length - 1 && isNavigation(map, steps[entryIdx]!, steps[entryIdx + 1]!)) entryIdx++;
  const entryScreen = steps[entryIdx]!.screen;

  // the screens the leading navigation traversed, ending on the entry screen (02 §6 fallback_path)
  const path: ScreenId[] = [];
  for (const s of steps.slice(0, entryIdx)) {
    if (s.screen !== UNKNOWN_SCREEN && !path.includes(s.screen)) path.push(s.screen);
  }
  if (entryScreen !== UNKNOWN_SCREEN && !path.includes(entryScreen)) path.push(entryScreen);

  const link = deepLinkOf(map, entryScreen);
  if (link === undefined) {
    // no deep link (01 R5 "screens without one cost navigation steps"): keep the navigation steps
    return { entry: path.length > 0 ? { fallback_path: path } : {}, steps: [...steps] };
  }
  return { entry: { deep_link: withFixture(link, loggedIn), fallback_path: path }, steps: steps.slice(entryIdx) };
}

// ---------------------------------------------------------------------------------------------
// Steps 6–7 — postconditions and intent_critical (04 §3.6, 04 §3.7)
// ---------------------------------------------------------------------------------------------

/** Step 6. Pure. Returns steps with `expect` filled, or the ids of steps that have none. */
export function inferPostconditions(map: LoadedMap, steps: readonly TranslatedStep[], observations: readonly Observation[]): { steps: RecipeStep[]; missing: string[] } {
  const bySeq = new Map<number, Observation>();
  for (const o of observations) bySeq.set(o.seq, o);
  const ordered = [...observations].sort((a, b) => a.seq - b.seq);
  const out: RecipeStep[] = [];
  const missing: string[] = [];

  for (const ts of steps) {
    const obs = bySeq.get(ts.from_seq);
    const step = { ...ts.step } as RecipeStep;
    if (obs === undefined) {
      // no observation behind the step: its outcome cannot be expressed (04 §3)
      missing.push(step.id);
      out.push(step);
      continue;
    }
    if (obs.screen_after === UNKNOWN_SCREEN) {
      missing.push(step.id);
      out.push(step);
      continue;
    }
    if (obs.screen_before !== obs.screen_after) {
      step.expect = { screen: obs.screen_after };
      out.push(step);
      continue;
    }
    // the screen did not change: a focus that the action newly established is the postcondition
    // (02 §6: a step without `expect` inherits "screen unchanged", so nothing else is added)
    const prev = ordered[ordered.findIndex((o) => o.seq === obs.seq) - 1];
    const focusedNow = focusedElement(map, obs);
    const focusedBefore = prev !== undefined ? focusedElement(map, prev) : undefined;
    if (focusedNow !== undefined && focusedNow !== focusedBefore) step.expect = { focused: focusedNow };
    out.push(step);
  }
  // a `wait_for` step is meaningless without `expect` (types.ts StepWaitFor)
  for (const s of out) if (s.action === 'wait_for' && s.expect === undefined) missing.push(s.id);
  return { steps: out, missing };
}

/** Step 7. Pure. */
export function markIntentCritical(map: LoadedMap, steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.map((step) => {
    const element = stepElement(step);
    if (element === undefined) return { ...step };
    // 02 §10.6: `intent_critical` must agree with ids.yaml; absent means false
    const critical = map.elementRegistry.get(element)?.intent_critical === true;
    return critical ? { ...step, intent_critical: true } : { ...step };
  });
}

// ---------------------------------------------------------------------------------------------
// Step 8 — emit (04 §3.8)
// ---------------------------------------------------------------------------------------------

/**
 * 04 §3.8 placeholders for the two fields the LLM must author (`description`, `matches`).
 *
 * They are derived from the recipe ID — map structure, never task data — because the task text
 * routinely names a client or an amount and `description`/`matches` are structure-only fields
 * (02 §10.8, 07 §2): seeding them from `input.task` made the compiler's own draft fail
 * `validate` rule 8, so `mark_recipe` rejected it. The schema requires a non-empty description
 * and at least one match, so the placeholder is the humanised id rather than an empty value.
 */
export function placeholderDescription(recipeId: string): string {
  const words = recipeId.replace(/_/g, ' ').trim();
  return words === '' ? 'TODO: describe this recipe' : `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}
export function placeholderMatches(recipeId: string): string[] {
  const words = recipeId.replace(/_/g, ' ').trim();
  return [literalRegex(words === '' ? 'TODO' : words)];
}

/** the task text as a literal regex, bounded by the schema's 200-char limit (07 §4) */
function literalRegex(task: string): string {
  let out = '';
  for (const ch of task.trim()) {
    const piece = /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    if (out.length + piece.length > MAX_MATCH_SOURCE) break;
    out += piece;
  }
  return out;
}

function renumber(steps: readonly RecipeStep[]): RecipeStep[] {
  return steps.map((s, i) => ({ ...s, id: `s${i + 1}` as StepId }));
}
function renumberTranslated(steps: readonly TranslatedStep[]): TranslatedStep[] {
  return steps.map((ts, i) => ({ ...ts, step: { ...ts.step, id: `s${i + 1}` as StepId } }));
}

function fail(ctx: AppMapContext, input: CompileRecipeInput, version: number, reason: Extract<CompileRecipeResult, { ok: false }>['reason'], message: string, offending?: string[]): CompileRecipeResult {
  ctx.events.append({ kind: 'compile', session: input.session, recipe: input.recipe_id, version, from_session: input.session, steps: 0, params: (input.params ?? []).map((p) => p.name), ok: false, reason });
  return { ok: false, reason, message, ...(offending !== undefined ? { offending_values: offending } : {}) };
}

export function compileRecipe(ctx: AppMapContext, input: CompileRecipeInput): CompileRecipeResult {
  if (!input || typeof input.session !== 'string' || input.session === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe needs a session id', 'pass the harness session_id whose trajectory to compile (04 §3)');
  }
  if (typeof input.recipe_id !== 'string' || input.recipe_id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe needs a recipe_id', 'e.g. {recipe_id: "create_invoice"}');
  }
  if (typeof input.task !== 'string' || input.task.trim() === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe needs the task text', 'the same instruction match_recipe saw (04 §2)');
  }
  const params: RecipeParam[] = Array.isArray(input.params) ? input.params : [];
  const version = input.revision_of !== undefined ? input.revision_of + 1 : 1;
  const warnings: string[] = [];

  // the cache is authoritative; a trajectory file is the fallback (`app-map compile` after a restart)
  let observations = ctx.db.listObservations(input.session);
  if (observations.length === 0) observations = readTrajectory(ctx.config, input.session);
  if (observations.length === 0) {
    return fail(ctx, input, version, 'no_observations', `session ${input.session} has no recorded observations`);
  }

  // 1. slice (04 §3.1)
  const sessionRow = ctx.db.getSession(input.session);
  const fromSeq = input.from_seq ?? sessionRow?.task_seq ?? observations.find((o) => o.task !== undefined)?.seq;
  if (fromSeq === undefined) {
    // 04 §2: observations before a task is declared are kept but not compilable
    return fail(ctx, input, version, 'no_task', `session ${input.session} declared no task: nothing in it is compilable`);
  }
  const previous = input.revision_of !== undefined ? ctx.db.getRecipe(input.recipe_id) ?? ctx.map.recipes.get(input.recipe_id) : undefined;
  const sliced = sliceTrajectory(observations, {
    fromSeq,
    ...(input.to_seq !== undefined ? { toSeq: input.to_seq } : sessionRow?.task_end_seq !== undefined ? { toSeq: sessionRow.task_end_seq } : {}),
    ...(previous?.verify !== undefined ? { verify: previous.verify } : {}),
  });
  const usable = sliced.filter((o) => o.ok !== false);
  if (usable.length < sliced.length) warnings.push(`${sliced.length - usable.length} failed driver call(s) dropped from the slice`);
  if (usable.length === 0) {
    return fail(ctx, input, version, 'no_observations', `session ${input.session} has no usable observations in [${fromSeq}, ${input.to_seq ?? '…'}]`);
  }

  // 2. collapse backtracking (04 §3.2)
  const collapsed = collapseBacktracking(usable);
  if (collapsed.observations.length === 0) {
    return fail(ctx, input, version, 'loops_never_converge', 'every observation in the slice was part of a backtracking loop: the trajectory never converged on a new screen');
  }

  // 3. translate (04 §3.3)
  let steps = translateSteps(ctx.map, collapsed.observations);
  if (steps.length === 0) {
    return fail(ctx, input, version, 'no_observations', 'no driver call in the slice translates to a recipe step');
  }
  if (steps.length < collapsed.observations.length) {
    warnings.push(`${collapsed.observations.length - steps.length} observation(s) were not translatable to a step (unknown driver verb or unresolved element)`);
  }

  // 4. parameterize (04 §3.4) — explicit `values` win over what the task text implies
  const values: Record<string, string | number> = { ...(inferParams({ params }, input.task) as Record<string, string | number>), ...(input.values ?? {}) };
  const parameterized = parameterize(steps, params, values, ctx.map.staticLabels);
  if (parameterized.offending.length > 0) {
    return fail(
      ctx, input, version, 'unparameterized_value',
      `these typed/selected values match no declared param and are not static copy: ${parameterized.offending.join(', ')}`,
      parameterized.offending,
    );
  }
  steps = parameterized.steps;

  // 5. entry optimization (04 §3.5)
  const loggedIn = ctx.probe?.auth === 'logged_in'
    || collapsed.observations.some((o) => typeof o.input.url === 'string' && /[?&]fixture=logged_in\b/.test(o.input.url));
  const optimized = optimizeEntry(ctx.map, steps, loggedIn);
  steps = renumberTranslated(optimized.steps);
  if (steps.length === 0) {
    return fail(ctx, input, version, 'no_observations', 'entry optimization consumed every step: the trajectory is pure navigation');
  }

  // 6. postconditions (04 §3.6)
  const post = inferPostconditions(ctx.map, steps, collapsed.observations);
  if (post.missing.length > 0) {
    return fail(ctx, input, version, 'missing_postcondition', `no postcondition can be expressed for step(s) ${post.missing.join(', ')} (the screen after them is unknown)`);
  }

  // 7. intent_critical (04 §3.7)
  const finalSteps = renumber(markIntentCritical(ctx.map, post.steps));

  // 8. emit (04 §3.8) — a DRAFT: nothing is written until mark_recipe(candidate)
  const lastScreen = collapsed.observations[collapsed.observations.length - 1]!.screen_after;
  if (previous?.verify === undefined && lastScreen === UNKNOWN_SCREEN) {
    return fail(ctx, input, version, 'unknown_screen', 'the final screen of the trajectory could not be identified, so `verify` cannot be written');
  }
  const verify: Expect = previous?.verify ?? { screen: lastScreen };
  // 04 §3.8: `description` and `matches` are the LLM's to author; a fresh compile emits a
  // structure-only placeholder so the draft itself never carries task data (02 §10.8, 07 §2).
  const description = previous?.description ?? placeholderDescription(input.recipe_id);
  const recipe: RecipeFile = {
    id: input.recipe_id,
    version,
    platform: ctx.map.platform,
    description,
    // the LLM replaces this with real patterns before mark_recipe (04 §3.8)
    matches: previous?.matches ?? placeholderMatches(input.recipe_id),
    params,
    ...(loggedIn ? { preconditions: [{ auth: 'logged_in' as const }] } : {}),
    entry: optimized.entry,
    steps: finalSteps,
    verify,
    status: 'candidate',
    provenance: {
      compiled_from: input.session,
      compiled_by: compiledBy(),
      ...(input.revision_of !== undefined ? { revision_of: input.revision_of } : {}),
    },
  };
  if (previous === undefined) warnings.push('`description` and `matches` are placeholders derived from the recipe id — write real ones (structure only, never task data), and add `verify.visible` assertions, before mark_recipe (04 §3.8, 02 §10.8)');
  if (collapsed.removed.length > 0) warnings.push(`collapsed ${collapsed.removed.length} backtracking observation(s): seq ${collapsed.removed.join(', ')}`);

  const yaml = canonicalYaml('recipe', recipe);
  ctx.events.append({
    kind: 'compile', session: input.session, recipe: recipe.id, version: recipe.version,
    from_session: input.session, steps: recipe.steps.length, params: params.map((p) => p.name), ok: true,
  });
  return { ok: true, recipe, yaml, collapsed_observations: collapsed.removed.length, warnings };
}

/** the screens a compiled draft walks through (`fallback_path` sanity check for callers) */
export function entryScreens(entry: RecipeEntry): ScreenId[] {
  const out: ScreenId[] = [];
  const link = entry.deep_link !== undefined ? screenIdOfDeepLink(entry.deep_link) : undefined;
  if (link !== undefined) out.push(link);
  for (const s of entry.fallback_path ?? []) if (!out.includes(s)) out.push(s);
  return out;
}
