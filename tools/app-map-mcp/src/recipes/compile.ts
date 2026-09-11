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
 *     `{compiled_from: session, compiled_by: app-map-mcp@<pkg version>}`, `matches: []`
 *     placeholder replaced by `[task]` escaped as a literal regex, and canonical YAML text;
 *     emit a `compile` event (08 §2).
 *
 * Layer: session (imports context, types, tree, identify, resolve, yaml/canonical, events).
 */
import type { AppMapContext } from '../context.ts';
import type { CompileRecipeInput, CompileRecipeResult, ElementId, Expect, LoadedMap, Observation, RecipeEntry, RecipeParam, RecipeStep, ScreenId } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

export function compileRecipe(ctx: AppMapContext, input: CompileRecipeInput): CompileRecipeResult {
  void ctx; void input;
  throw new NotImplementedError('recipes/compile.compileRecipe');
}

/** Step 1. Pure. `toSeq` (inclusive) wins over `verify`. */
export function sliceTrajectory(observations: readonly Observation[], opts: { fromSeq: number; toSeq?: number; verify?: Expect }): Observation[] {
  void observations; void opts;
  throw new NotImplementedError('recipes/compile.sliceTrajectory');
}

/** Step 2. Pure. `removed` = seqs dropped. */
export function collapseBacktracking(observations: readonly Observation[]): { observations: Observation[]; removed: number[] } {
  void observations;
  throw new NotImplementedError('recipes/compile.collapseBacktracking');
}

/** literal (un-parameterized) step + the screen it was taken on */
export interface TranslatedStep { step: RecipeStep; screen: ScreenId; from_seq: number }

/** Step 3. Pure. */
export function translateSteps(map: LoadedMap, observations: readonly Observation[]): TranslatedStep[] {
  void map; void observations;
  throw new NotImplementedError('recipes/compile.translateSteps');
}

/** Step 4. Pure. `values` = `input.values` merged over `inferParams` (see module doc). */
export function parameterize(steps: readonly TranslatedStep[], params: readonly RecipeParam[], values: Readonly<Record<string, string | number>>, staticLabels: ReadonlySet<string>): { steps: TranslatedStep[]; offending: string[] } {
  void steps; void params; void values; void staticLabels;
  throw new NotImplementedError('recipes/compile.parameterize');
}

/** Step 5. Pure. */
export function optimizeEntry(map: LoadedMap, steps: readonly TranslatedStep[], loggedIn: boolean): { entry: RecipeEntry; steps: TranslatedStep[] } {
  void map; void steps; void loggedIn;
  throw new NotImplementedError('recipes/compile.optimizeEntry');
}

/** Step 6. Pure. Returns steps with `expect` filled, or the ids of steps that have none. */
export function inferPostconditions(map: LoadedMap, steps: readonly TranslatedStep[], observations: readonly Observation[]): { steps: RecipeStep[]; missing: string[] } {
  void map; void steps; void observations;
  throw new NotImplementedError('recipes/compile.inferPostconditions');
}

/** Step 7. Pure. */
export function markIntentCritical(map: LoadedMap, steps: readonly RecipeStep[]): RecipeStep[] {
  void map; void steps;
  throw new NotImplementedError('recipes/compile.markIntentCritical');
}

/** The focused element id in a scrubbed snapshot (registered ids only), for `type` translation. */
export function focusedElement(map: LoadedMap, obs: Observation): ElementId | undefined {
  void map; void obs;
  throw new NotImplementedError('recipes/compile.focusedElement');
}
