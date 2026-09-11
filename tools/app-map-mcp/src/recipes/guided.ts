/**
 * [C2] Guided replay state machine (04 §5, 03 §8 `run_recipe` mode guided + `report_step`,
 * 07 §3 execution policy). State lives in the db (`runs`, `run_steps`) so `report_step` works
 * across separate tool calls, server restarts and a fresh `openContext` between calls.
 *
 * `startGuidedRun`:
 *  1. recipe must exist, be non-retired and match the platform (`recipe_unavailable`);
 *  2. required params present (`bad_input` listing the missing names);
 *  3. `opts.probe(config, app_id)` (07 §3): `build_type !== 'debug'` or `sandbox !== true` or
 *     probe `null` (endpoint absent = Release) → `release_build_refused`. A successful probe is
 *     cached with `ctx.setProbe(probe)` so identification can evaluate variants
 *     (`probeConditions`, 02 §4.3). Tests inject a fake probe; the default probe runs
 *     `xcrun simctl spawn <udid|booted> defaults read <app_id> app_map_debug_probe` (iOS) /
 *     `adb shell run-as <app_id> cat files/app_map_debug_probe.json` (Android, best-effort);
 *  4. session: `input.session` ?? the newest observation's session; none → `no_observation`
 *     (a run needs a session to verify against, 03 §2 — many instances share the cache);
 *     `start_seq = last_seq = db.getSession(session)?.last_seq ?? 0`;
 *  5. expand steps: `s0` = `open_link entry.deep_link` with `expect {screen: <first step's
 *     screen>}` when the recipe has a deep link, else the `fallback_path` as a series of edge
 *     taps (plan.shortestEdgePath) numbered `s0a…` (RUN_STEP_ID_REGEX); then the recipe steps;
 *  6. insert the `RunRecord` (`state: active`, `current_step: s0`), return `{run_id, step}` where
 *     `step` is `toRunStep(s0)` (≤120 tokens; `announce: true` on intent_critical steps when the
 *     recipe is `candidate`, 07 §3).
 *
 * `reportStep(run_id, step_id, ok, note?, snapshot?)` — the server never trusts `ok` alone:
 *  1. run must be `active` and `step_id === current_step` (`run_not_active` / `bad_input`);
 *  2. observation = newest of `db.listObservations(run.session, {fromSeq: run.last_seq + 1})`
 *     (or `snapshot` normalized + scrubbed when supplied); none → fallback `no_observation`;
 *     `run.last_seq` advances to its seq;
 *  3. gates: if `identify.gates_present` is non-empty and the gate is not what the step expects →
 *     `{status:'gate', step: dismiss_gate <gate>, retry: step_id}`; at most
 *     `GUIDED_LIMITS.gate_dismissals_per_step` per step, then fallback `gate_limit`;
 *  4. verify `expect` (`checkExpect`): `screen` via identify, `focused`/`visible`/`not_visible`
 *     via resolve on the scrubbed tree, `text_present` via labelOf equality; a step without
 *     `expect` inherits "screen unchanged";
 *     4a. if `run.pending_heal` is set for this step: `expect` held → `heal.applyHeal(ctx,
 *     {pending, recipe})` (element written, `heals[]` gets the summary, `pending_heal` cleared);
 *     `expect` failed → `heal.rejectHeal(…, 'postcondition_failed', …)` and fallback
 *     `heal_rejected` (04 §7.2 rule 3);
 *     4b. on `ok` for a step with `expect.screen` or a marker hit whose `required_ids` are all
 *     present → `lifecycle.markVerified(ctx, {screens:[screen], elements:[…step element…],
 *     edges:[…]})` (02 §8 lazy re-verify);
 *  5. ok → advance: if no more steps, check recipe `verify` → `{status:'done', verified, heals}`,
 *     `lifecycle.markVerified(ctx, {recipe})` when verified and `lifecycle.recordRunOutcome`;
 *     else resolve the next step's element against the observation (resolve.ts):
 *     hit → `{status:'ok', step}`; degraded/miss → `heal.proposeHeal` at most
 *     `GUIDED_LIMITS.heals_per_step` per step: candidate → hand it out as the step target
 *     (`RunStep.target` from `candidate.proposed_locator`, `RunStep.healing: true`), persist
 *     `run.pending_heal = heal.toPendingHeal(...)`, return `{status:'ok', step}` — the
 *     `healed` summary is only reported on the following call once 4a accepted it; rejected →
 *     `heal.rejectHeal` + `{status:'fallback'}` with `reason` `heal_rejected` (or
 *     `intent_critical_label_changed`), `screen_seen`, top-3 candidates;
 *  6. expect failed → `{status:'fallback', reason:'expect_failed'}`; the run is marked
 *     `fallback`, a `recipe_run` event with `fallbacks: 1` is logged (04 §5 "guided_fallback"),
 *     and the trajectory from this seq is compilable into a revision (compile `from_seq`).
 *
 * Layer: session (imports context, types, observe, identify, resolve, heal, plan, format,
 * lifecycle, events).
 */
import type { AppMapConfig } from '../config.ts';
import type { AppMapContext } from '../context.ts';
import type { AnyTree, BuildProbeResult, Expect, LoadedMap, RecipeFile, RecipeParams, RecipeStep, ReportStepInput, ReportStepResult, RunRecipeResult, RunRecord, RunStep, ScreenId, SessionId } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

/** Injectable build/environment probe (07 §3). `null` = endpoint absent (treated as Release). */
export type BuildInfoProbe = (config: AppMapConfig, appId: string) => Promise<BuildProbeResult | null>;

export interface StartGuidedRunInput {
  recipe_id: string;
  params: RecipeParams;
  /** defaults to the newest observation's session (see module doc, step 4) */
  session?: SessionId;
}
export interface GuidedRunOptions {
  probe?: BuildInfoProbe;
  /** skip the 07 §3 probe entirely (tests of the state machine only) */
  skipBuildCheck?: boolean;
  now?: () => Date;
  /** run id generator (default: `run_<timestamp>_<random>`) */
  runId?: () => string;
}

export function startGuidedRun(ctx: AppMapContext, input: StartGuidedRunInput, opts: GuidedRunOptions = {}): Promise<Extract<RunRecipeResult, { mode: 'guided' }>> {
  void ctx; void input; void opts;
  throw new NotImplementedError('recipes/guided.startGuidedRun');
}

export function reportStep(ctx: AppMapContext, input: ReportStepInput): Promise<ReportStepResult> {
  void ctx; void input;
  throw new NotImplementedError('recipes/guided.reportStep');
}

/** Default probe: shells out to `xcrun simctl` / `adb` (best-effort; see module doc). */
export const defaultBuildProbe: BuildInfoProbe = async (config, appId) => {
  void config; void appId;
  throw new NotImplementedError('recipes/guided.defaultBuildProbe');
};

/** Throws `release_build_refused` unless `probe` is a sandbox Debug build. Pure. */
export function assertDebugSandbox(probe: BuildProbeResult | null): void {
  void probe;
  throw new NotImplementedError('recipes/guided.assertDebugSandbox');
}

/** Resolve the session a run verifies against (module doc, step 4); throws `no_observation`. */
export function resolveRunSession(ctx: AppMapContext, session: SessionId | undefined): { session: SessionId; last_seq: number } {
  void ctx; void session;
  throw new NotImplementedError('recipes/guided.resolveRunSession');
}

/** Pure: entry steps (`s0`, or `s0a…` for the fallback path) + recipe steps, with the screen each is taken on. */
export function expandSteps(map: LoadedMap, recipe: RecipeFile): Array<{ step: RecipeStep; screen: ScreenId | undefined }> {
  void map; void recipe;
  throw new NotImplementedError('recipes/guided.expandSteps');
}

/** Pure: a `RecipeStep` → `RunStep` with params substituted and, when `tree` is given, the resolved target. */
export function toRunStep(map: LoadedMap, step: RecipeStep, params: RecipeParams, opts: { tree?: AnyTree; announce?: boolean; pending?: RunRecord['pending_heal'] } = {}): RunStep {
  void map; void step; void params; void opts;
  throw new NotImplementedError('recipes/guided.toRunStep');
}

/** Pure: `{amount}` → params.amount (String()); unknown slots left as-is. */
export function substituteParams(text: string, params: RecipeParams): string {
  void text; void params;
  throw new NotImplementedError('recipes/guided.substituteParams');
}

/** Pure: does `expect` hold on `tree`? `screenId` is the identified screen (or `unknown`). */
export function checkExpect(map: LoadedMap, expect: Expect | undefined, tree: AnyTree, screenId: ScreenId | 'unknown', opts: { previousScreen?: ScreenId | 'unknown' } = {}): { ok: boolean; failed: string[] } {
  void map; void expect; void tree; void screenId; void opts;
  throw new NotImplementedError('recipes/guided.checkExpect');
}
