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
import type { AppMapContext } from '../context.ts';
import type { ElementDef, LoadedMap, MaestroExportResult, RecipeFile, RecipeParams, RecipeStatus, StepId } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

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
}

/** Pure. */
export function recipeToMaestroFlow(map: LoadedMap, recipe: RecipeFile, params: RecipeParams, opts: FlowOptions = {}): MaestroFlow {
  void map; void recipe; void params; void opts;
  throw new NotImplementedError('recipes/maestro.recipeToMaestroFlow');
}

/** Pure: first exportable locator of an element (`a11y_id`, then `role_label`, then `text`), or `undefined`. */
export function maestroSelectorFor(element: ElementDef): MaestroSelector | undefined {
  void element;
  throw new NotImplementedError('recipes/maestro.maestroSelectorFor');
}

/** Pure: Maestro's failing command index → the recipe step it belongs to. */
export function stepForCommandIndex(flow: MaestroFlow, commandIndex: number): StepId | undefined {
  void flow; void commandIndex;
  throw new NotImplementedError('recipes/maestro.stepForCommandIndex');
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
  void path; void opts;
  throw new NotImplementedError('recipes/maestro.readParamsFile');
}

/** Pure: the values a recipe will run with (see `MaestroExportOptions.params`); throws `bad_input` listing missing required params. */
export function resolveRecipeParams(recipe: RecipeFile, sources: { explicit?: RecipeParams; file?: RecipeParams }): RecipeParams {
  void recipe; void sources;
  throw new NotImplementedError('recipes/maestro.resolveRecipeParams');
}

/** `app-map maestro-export [R | --all] [--status s,…] [--params-file f] --out DIR` — writes one flow per recipe. */
export function maestroExport(ctx: AppMapContext, opts: MaestroExportOptions): MaestroExportResult {
  void ctx; void opts;
  throw new NotImplementedError('recipes/maestro.maestroExport');
}
