/**
 * [C3] Headless replay through Maestro (04 §6.1, 03 §8 `run_recipe` mode headless, 03 §10
 * `run --headless`, 06 R6 nightly heal). Zero LLM calls.
 *
 * `runHeadless(ctx, {recipe_id, params}, opts)`:
 *  0. 07 §3 build/sandbox check (same probe as guided.ts); 03 §13 `checkMaestroVersion`
 *     against `package.json` `appMap.maestroVersion` (`maestro_unavailable` on failure);
 *  1. `recipeToMaestroFlow` → write to `paths.maestroFlowFile(config, recipe)`; not eligible →
 *     `not_headless_eligible` (the recipe stays at `guided`);
 *  2. `exec(maestroBin, ['test', flow, ...(simUdid ? ['--udid', simUdid] : [])])`; parse exit
 *     code + failing command index (`parseMaestroResult` scans stdout/stderr for the failed
 *     command marker; best-effort, tolerant of format changes);
 *  3. on failure at step k: `hierarchy()` (default: `maestro hierarchy` → fromMaestroHierarchy;
 *     tests inject fixtures) → scrub → identify → if a gate is present, prepend a dismiss and
 *     retry; else heal (heal.ts) with `verify` = re-export from step k and rerun; max
 *     `opts.maxRetries` (2) reruns;
 *  4. return `HeadlessReport {ok, steps_done, heals, fallback_step?, screen_seen?, retries, ms,
 *     error_code?, failed_command_index?}` — closed codes only, Maestro's stdout/stderr goes to
 *     `ctx.log` at `debug` (07 §2.4: the report is a CI artifact); log a `recipe_run` event,
 *     `lifecycle.markVerified(ctx, {recipe, screens, elements})` on success and
 *     `lifecycle.recordRunOutcome`. On `fallback_step` the caller may resume in guided mode
 *     from that step. Headless runs record a `RunRecord` with `session: 'headless:<run_id>'`.
 *  Params come from `input.params` merged per `maestro.resolveRecipeParams` (params file, enum
 *  defaults); a missing required param is `bad_input` before anything is exported.
 *
 * `runAllHeadless` (06 R6 / CLI `run --all --status verified,ci_gate --headless --report`):
 * runs every recipe with the given statuses, aggregates a `HealReport` (accepted heals vs
 * `needs_human`) that validates against `heal-report.schema.json`.
 *
 * Layer: session (imports context, types, paths, tree, scrub, identify, heal, maestro,
 * lifecycle, guided (probe), events). All process spawning goes through the injectable `exec`.
 */
import type { AppMapContext } from '../context.ts';
import type { AnyTree, HeadlessErrorCode, HeadlessReport, HealReport, RecipeParams, RecipeStatus, SessionId, StepId, Tree } from '../types.ts';
import type { BuildInfoProbe } from './guided.ts';
import { NotImplementedError } from '../errors.ts';

export interface ExecResult { code: number; stdout: string; stderr: string; timed_out?: boolean }
/** Injectable process runner (default wraps `child_process.spawn`, never a shell). */
export type ExecFn = (cmd: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<ExecResult>;
/** Injectable hierarchy dump after a failure (default: `maestro hierarchy` via `exec`). */
export type HierarchyProvider = (opts: { exec: ExecFn; udid?: string }) => Promise<Tree | AnyTree | null>;

export interface HeadlessInput { recipe_id: string; params: RecipeParams; session?: SessionId; /** `--params-file` (default `paths.ciParamsFile`) */ paramsFile?: string }
export interface HeadlessOptions {
  exec?: ExecFn;
  hierarchy?: HierarchyProvider;
  probe?: BuildInfoProbe;
  skipBuildCheck?: boolean;
  /** re-runs after a heal (default 2, 04 §6.1) */
  maxRetries?: number;
  /** per `maestro test` invocation (default 10 min) */
  timeoutMs?: number;
  /** override `.local/maestro` */
  outDir?: string;
}

export function runHeadless(ctx: AppMapContext, input: HeadlessInput, opts: HeadlessOptions = {}): Promise<HeadlessReport> {
  void ctx; void input; void opts;
  throw new NotImplementedError('recipes/headless.runHeadless');
}

export function runAllHeadless(ctx: AppMapContext, opts: HeadlessOptions & { statuses: RecipeStatus[]; params?: Record<string, RecipeParams>; paramsFile?: string }): Promise<HealReport> {
  void ctx; void opts;
  throw new NotImplementedError('recipes/headless.runAllHeadless');
}

/** Pure: exit code + output → outcome; `failed_command_index` when Maestro names the failing command. `message` is for the log only, never the report. */
export function parseMaestroResult(result: ExecResult): { ok: boolean; failed_command_index?: number; error_code?: HeadlessErrorCode; message?: string } {
  void result;
  throw new NotImplementedError('recipes/headless.parseMaestroResult');
}

/** `maestro --version` vs the `>=x.y.z` range in package.json (03 §13, 07 §5.3). */
export function checkMaestroVersion(exec: ExecFn, bin: string, range: string): Promise<{ ok: boolean; version?: string; message?: string }> {
  void exec; void bin; void range;
  throw new NotImplementedError('recipes/headless.checkMaestroVersion');
}

/** Default `exec`: `child_process.spawn` with `stdio: pipe`, no shell, kills on timeout. */
export const defaultExec: ExecFn = async (cmd, args, opts) => {
  void cmd; void args; void opts;
  throw new NotImplementedError('recipes/headless.defaultExec');
};

/** Default hierarchy provider: `maestro hierarchy [--udid]` → `fromMaestroHierarchy`. */
export const defaultHierarchy: HierarchyProvider = async (opts) => {
  void opts;
  throw new NotImplementedError('recipes/headless.defaultHierarchy');
};

/** Step id the run stopped at, given the flow and Maestro's failing command index (re-exported from maestro.ts for callers). */
export function fallbackStepFor(flowCommandIndex: Record<StepId, number>, failedCommandIndex: number): StepId | undefined {
  void flowCommandIndex; void failedCommandIndex;
  throw new NotImplementedError('recipes/headless.fallbackStepFor');
}
