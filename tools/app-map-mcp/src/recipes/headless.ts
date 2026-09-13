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
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppMapContext } from '../context.ts';
import type { AnyTree, ElementDef, ElementId, HealCandidate, HealInput, HealRecord, HealResult, HeadlessErrorCode, HeadlessReport, HealReport, LoadedMap, RecipeFile, RecipeParams, RecipeStatus, RecipeStep, RunRecord, ScreenId, SessionId, StepId, Tree } from '../types.ts';
import { DEEP_LINK_REGEX, UNKNOWN_SCREEN, now, probeConditions, selectTarget } from '../types.ts';
import type { BuildInfoProbe } from './guided.ts';
import { defaultBuildProbe } from './guided.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { PACKAGE_ROOT, maestroFlowFile, maestroOutDir } from '../paths.ts';
import { fromMaestroHierarchy, normalizeTree } from '../tree.ts';
import { buildScrubPolicy, scrub } from '../scrub.ts';
import { identify } from '../identify.ts';
import { resolve as resolveElement } from '../resolve.ts';
import { heal as healOnce } from '../heal.ts';
import { markVerified as lifecycleMarkVerified, recordRunOutcome as lifecycleRecordRunOutcome } from './lifecycle.ts';
import type { VerifiedEntities } from './lifecycle.ts';
import { readParamsFile, recipeToMaestroFlow, resolveRecipeParams, stepForCommandIndex } from './maestro.ts';
import { ciParamsFile } from '../paths.ts';

export interface ExecResult { code: number; stdout: string; stderr: string; timed_out?: boolean }
/** Injectable process runner (default wraps `child_process.spawn`, never a shell). */
export type ExecFn = (cmd: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }) => Promise<ExecResult>;
/** Injectable hierarchy dump after a failure (default: `maestro hierarchy` via `exec`). */
export type HierarchyProvider = (opts: { exec: ExecFn; udid?: string; bin?: string; platform?: 'ios' | 'android' }) => Promise<Tree | AnyTree | null>;

/** `heal.heal` — injected so the runner is testable without a device or a scored tree. */
export type HealFn = (ctx: AppMapContext, input: HealInput, verify: (candidate: HealCandidate) => Promise<boolean>) => Promise<HealResult>;
/** the two `recipes/lifecycle.ts` writes a headless run performs (02 §8, 04 §8); injected in tests. */
export interface LifecycleHooks {
  markVerified: (ctx: AppMapContext, entities: VerifiedEntities, build?: string) => unknown;
  recordRunOutcome: (ctx: AppMapContext, run: RunRecord, outcome: { ok: boolean; steps: number; steps_done: number; ms: number }) => unknown;
}

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
  /** heal implementation (default `heal.heal`, 04 §7) */
  healer?: HealFn;
  /** lifecycle writes (default `recipes/lifecycle`) */
  lifecycle?: LifecycleHooks;
  /** required Maestro range (default: `package.json` `appMap.maestroVersion`, 03 §13) */
  maestroVersion?: string;
  /** skip the 03 §13 version probe (the server already ran it at start, decision 43) */
  skipVersionCheck?: boolean;
  now?: () => Date;
  runId?: () => string;
}

/** 04 §6.1: at most two reruns after the first failure. */
export const DEFAULT_MAX_RETRIES = 2;
/** one `maestro test` invocation (06 R5 budgets <15 min for the whole gate job) */
export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function defaultRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 03 §13 / 07 §5.3: the Maestro range this package was reviewed against. */
export function requiredMaestroVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { appMap?: { maestroVersion?: string } };
    return pkg.appMap?.maestroVersion ?? '>=0.0.0';
  } catch {
    return '>=0.0.0';
  }
}

/** every declaration of `id`, preferring the one on `screen` */
function elementDefFor(map: LoadedMap, id: ElementId, screen?: ScreenId): ElementDef | undefined {
  const refs = map.elements.get(id) ?? [];
  if (screen !== undefined) {
    const onScreen = refs.find((r) => r.screen === screen);
    if (onScreen) return onScreen.element;
  }
  return refs[0]?.element;
}

/** the element a step acts on (`element`, or the `list`/`cell` a `select` names), when it has one */
function elementOfStep(step: RecipeStep): ElementId | undefined {
  if ('element' in step && typeof step.element === 'string') return step.element;
  if (step.action === 'select') return selectTarget(step);
  // issue #24: without this the headless rung can neither resolve nor heal the one step that
  // commits a destructive action — every safety rule below would be dead code for it
  if (step.action === 'tap_gate') return step.control;
  return undefined;
}

/** screens a recipe visits: the entry deep link plus every `expect.screen` and `verify.screen` */
function screensOfRecipe(recipe: RecipeFile): ScreenId[] {
  const out = new Set<ScreenId>();
  const entry = DEEP_LINK_REGEX.exec(recipe.entry?.deep_link ?? '')?.[1];
  if (entry) out.add(entry);
  for (const step of recipe.steps ?? []) if (step.expect?.screen) out.add(step.expect.screen);
  if (recipe.verify?.screen) out.add(recipe.verify.screen);
  return Array.from(out);
}

/** scrub policy for this map (07 §2.3); raw trees never leave this function's caller */
function policyFor(map: LoadedMap): ReturnType<typeof buildScrubPolicy> {
  return buildScrubPolicy(map.ids, map.staticLabels);
}

export async function runHeadless(ctx: AppMapContext, input: HeadlessInput, opts: HeadlessOptions = {}): Promise<HeadlessReport> {
  const startedMs = Date.now();
  const exec = opts.exec ?? defaultExec;
  const hierarchy = opts.hierarchy ?? defaultHierarchy;
  const healer = opts.healer ?? healOnce;
  const lifecycle: LifecycleHooks = opts.lifecycle ?? { markVerified: lifecycleMarkVerified, recordRunOutcome: lifecycleRecordRunOutcome };
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const outDir = opts.outDir ?? maestroOutDir(ctx.config);
  const map = ctx.map;
  const build = ctx.build;
  const runId = (opts.runId ?? defaultRunId)();
  const session: SessionId = input.session ?? `headless:${runId}`;

  const recipe = ctx.db.getRecipe(input.recipe_id) ?? map.recipes.get(input.recipe_id);
  if (!recipe) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `recipe not found: ${input.recipe_id}`, 'run `app-map validate` or check app-map/<platform>/recipes/');
  }
  if (recipe.status === 'retired' || recipe.platform !== ctx.config.platform) {
    throw new AppMapError(ERROR_CODES.RECIPE_UNAVAILABLE, `recipe ${recipe.id} is ${recipe.status} on ${recipe.platform}`, `this server serves ${ctx.config.platform}`);
  }

  let steps = 0;
  const heals: HealRecord[] = [];
  const report = (over: Partial<HeadlessReport>): HeadlessReport => ({
    recipe: recipe.id,
    version: recipe.version,
    mode: 'headless',
    ok: false,
    steps,
    steps_done: 0,
    heals,
    retries: 0,
    ms: Date.now() - startedMs,
    build,
    ...over,
  });

  // ---- 0. 07 §3 execution policy: Debug build, sandbox environment -------------------------
  if (!opts.skipBuildCheck) {
    const probe = await (opts.probe ?? defaultBuildProbe)(ctx.config, map.manifest.app_id);
    // 07 §3: a missing endpoint is treated as a Release build.
    if (!probe || probe.build_type !== 'debug' || probe.sandbox !== true) {
      ctx.log.warn('headless: refusing to run against a non-sandbox build', { recipe: recipe.id, build_type: probe?.build_type, sandbox: probe?.sandbox });
      return report({ error_code: 'release_build_refused' });
    }
    ctx.setProbe(probe);
  }

  // ---- 0b. 03 §13 Maestro version -----------------------------------------------------------
  if (!opts.skipVersionCheck) {
    const version = await checkMaestroVersion(exec, ctx.config.maestroBin, opts.maestroVersion ?? requiredMaestroVersion());
    if (!version.ok) {
      ctx.log.warn('headless: maestro unavailable', { recipe: recipe.id, version: version.version, message: version.message });
      return report({ error_code: 'maestro_unavailable' });
    }
  }

  // ---- params (bad_input before anything is exported, 04 §6.2) -------------------------------
  const fileParams = readParamsFile(input.paramsFile ?? ciParamsFile(ctx.config), { required: input.paramsFile !== undefined });
  const params = resolveRecipeParams(recipe, { explicit: input.params, file: fileParams[recipe.id] });

  // ---- 1. export ----------------------------------------------------------------------------
  const flow = recipeToMaestroFlow(map, recipe, params);
  const stepIds = Object.keys(flow.command_index);
  steps = stepIds.length;
  if (!flow.eligible) {
    ctx.log.warn('headless: recipe is not headless-eligible', { recipe: recipe.id, ineligible_steps: flow.ineligible_steps });
    return report({ error_code: 'not_headless_eligible', fallback_step: flow.ineligible_steps[0] ?? stepIds[0] });
  }
  const flowPath = maestroFlowFile(ctx.config, recipe.id, outDir);
  mkdirSync(dirname(flowPath), { recursive: true });
  writeFileSync(flowPath, flow.flow, 'utf8');

  const udid = ctx.config.simUdid;
  const runFlowFile = async (path: string): Promise<ExecResult> => {
    const args = ['test', path, ...(udid ? ['--udid', udid] : [])];
    const r = await exec(ctx.config.maestroBin, args, { timeoutMs });
    // 07 §2.4: Maestro output can echo on-screen text — debug log only, never the report.
    ctx.log.debug('maestro test finished', { recipe: recipe.id, code: r.code, timed_out: r.timed_out === true, stdout: r.stdout, stderr: r.stderr });
    return r;
  };
  const writeRetryFlow = (text: string, suffix: string): string => {
    const p = maestroFlowFile(ctx.config, `${recipe.id}.${suffix}`, outDir);
    writeFileSync(p, text, 'utf8');
    return p;
  };

  // ---- 2/3. run, then gate-dismiss / heal loop ----------------------------------------------
  let parsed = parseMaestroResult(await runFlowFile(flowPath));
  let retries = 0;
  let fallbackStep: StepId | undefined;
  let screenSeen: ScreenId | typeof UNKNOWN_SCREEN | undefined;
  let errorCode: HeadlessErrorCode | undefined;
  let failedCommandIndex: number | undefined;
  const gateTried = new Set<StepId>();

  while (!parsed.ok) {
    failedCommandIndex = parsed.failed_command_index ?? failedCommandIndex;
    errorCode = parsed.error_code ?? 'maestro_failed';
    if (errorCode === 'maestro_unavailable' || errorCode === 'timeout') break;
    const stepId = parsed.failed_command_index !== undefined ? stepForCommandIndex(flow, parsed.failed_command_index) : undefined;
    fallbackStep = stepId ?? stepIds[0];
    if (retries >= maxRetries) break;

    const raw = await hierarchy({ exec, ...(udid ? { udid } : {}), bin: ctx.config.maestroBin, platform: ctx.config.platform });
    if (!raw) {
      errorCode = 'hierarchy_unavailable';
      break;
    }
    // the raw tree dies here: only the scrubbed form is identified, resolved or logged (07 §2)
    const tree = scrub(normalizeTree(raw, { platform: ctx.config.platform, source: 'maestro' }), policyFor(map));
    const ident = identify(map, tree, { build, ...probeConditions(ctx.probe) });
    screenSeen = ident.screen_id;
    retries++;

    // 04 §6.1 step 3: a gate first — it is the cheap explanation for a step that "vanished".
    if (ident.gates_present.length > 0 && fallbackStep !== undefined && !gateTried.has(fallbackStep)) {
      gateTried.add(fallbackStep);
      const retry = recipeToMaestroFlow(map, recipe, params, { fromStep: fallbackStep, dismissGates: ident.gates_present });
      const path = writeRetryFlow(retry.flow, `gate${retries}`);
      parsed = parseMaestroResult(await runFlowFile(path));
      continue;
    }

    // 04 §7: heal the step's element, verifying by re-exporting from step k and rerunning.
    const step = (recipe.steps ?? []).find((s) => s.id === fallbackStep);
    const elementId = step ? elementOfStep(step) : undefined;
    const screenId = ident.screen_id === UNKNOWN_SCREEN ? undefined : ident.screen_id;
    const def = elementId ? elementDefFor(map, elementId, screenId) : undefined;
    if (!step || !def) {
      ctx.log.debug('headless: nothing to heal at the failing step', { recipe: recipe.id, step: fallbackStep });
      break;
    }
    const healInput: HealInput = {
      recipe: recipe.id,
      step,
      screen: screenId ?? (map.elements.get(def.id)?.[0]?.screen ?? UNKNOWN_SCREEN),
      element: def,
      // the REGISTRY is the third source, as guided.isIntentCritical reads it (02 §10.6): a gate
      // control declares its criticality in ids.yaml `gates[].controls[]`, not in the screen file,
      // so without this 04 §7.2's exact-label protection never fires on the headless rung (issue #24)
      intent_critical: step.intent_critical === true || def.intent_critical === true || map.elementRegistry.get(def.id)?.intent_critical === true,
      tree,
      trigger: resolveElement(map, def, tree),
      build,
      run_id: runId,
    };
    const result = await healer(ctx, healInput, async (candidate) => {
      const retry = recipeToMaestroFlow(map, recipe, params, { fromStep: step.id, overrides: { [def.id]: candidate.proposed_locator } });
      const path = writeRetryFlow(retry.flow, `heal${retries}`);
      const after = parseMaestroResult(await runFlowFile(path));
      failedCommandIndex = after.failed_command_index ?? failedCommandIndex;
      return after.ok;
    });
    heals.push(result.record);
    if (result.accepted) {
      // the verify rerun from step k passed: the recipe completed
      parsed = { ok: true };
      fallbackStep = undefined;
      errorCode = undefined;
      failedCommandIndex = undefined;
      break;
    }
    // rejected (low score, intent_critical, postcondition): hand the step back (04 §6.1)
    break;
  }

  const ok = parsed.ok;
  const stepsDone = ok ? steps : Math.max(0, stepIds.indexOf(fallbackStep ?? ''));
  const final: HeadlessReport = report({
    ok,
    steps_done: stepsDone,
    retries,
    ...(ok ? {} : { error_code: errorCode ?? 'maestro_failed' }),
    ...(fallbackStep !== undefined && !ok ? { fallback_step: fallbackStep } : {}),
    ...(screenSeen !== undefined ? { screen_seen: screenSeen } : {}),
    ...(failedCommandIndex !== undefined && !ok ? { failed_command_index: failedCommandIndex } : {}),
    ms: Date.now() - startedMs,
  });

  // ---- 4. bookkeeping ------------------------------------------------------------------------
  const run: RunRecord = {
    run_id: runId,
    recipe: recipe.id,
    version: recipe.version,
    mode: 'headless',
    session,
    params,
    state: ok ? 'done' : 'fallback',
    current_step: fallbackStep ?? stepIds[stepIds.length - 1] ?? 's0',
    step_index: stepsDone - 1,
    heals: heals.filter((h) => h.accepted && h.new_strategy).map((h) => ({ step: h.step, element: h.element, old_strategy: h.old_strategy, new_strategy: h.new_strategy as HealRecord['old_strategy'], score: h.score })),
    fallbacks: ok ? 0 : 1,
    started_at: (opts.now ? opts.now() : new Date(startedMs)).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    finished_at: now(),
    build,
    start_seq: 0,
    last_seq: 0,
  };
  try {
    ctx.db.insertRun(run);
  } catch (e) {
    ctx.log.warn('headless: could not record the run', { recipe: recipe.id, error: (e as Error).message });
  }
  if (ok) {
    const entities: VerifiedEntities = {
      recipe: recipe.id,
      screens: screensOfRecipe(recipe),
      elements: (recipe.steps ?? []).flatMap((s) => {
        const id = elementOfStep(s);
        if (!id) return [];
        const ref = map.elements.get(id)?.[0];
        return ref ? [{ screen: ref.screen, element: id }] : [];
      }),
    };
    lifecycle.markVerified(ctx, entities, build);
  }
  lifecycle.recordRunOutcome(ctx, run, { ok, steps, steps_done: stepsDone, ms: final.ms });
  ctx.events.append({
    kind: 'recipe_run',
    recipe: recipe.id,
    version: recipe.version,
    mode: 'headless',
    ok,
    steps,
    steps_done: stepsDone,
    heals: heals.length,
    fallbacks: ok ? 0 : 1,
    ms: final.ms,
    build,
    run_id: runId,
    ...(final.fallback_step ? { fallback_step: final.fallback_step, fallback_reason: final.error_code } : {}),
  });
  return final;
}

export async function runAllHeadless(ctx: AppMapContext, opts: HeadlessOptions & { statuses: RecipeStatus[]; params?: Record<string, RecipeParams>; paramsFile?: string }): Promise<HealReport> {
  const statuses = opts.statuses.length > 0 ? opts.statuses : (['verified', 'ci_gate'] as RecipeStatus[]);
  let recipes = ctx.db.listRecipes({ statuses });
  if (recipes.length === 0) recipes = Array.from(ctx.map.recipes.values()).filter((r) => statuses.includes(r.status));
  recipes = recipes.filter((r) => r.platform === ctx.config.platform).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const runs: HeadlessReport[] = [];
  for (const recipe of recipes) {
    const input: HeadlessInput = { recipe_id: recipe.id, params: opts.params?.[recipe.id] ?? {}, ...(opts.paramsFile ? { paramsFile: opts.paramsFile } : {}) };
    try {
      runs.push(await runHeadless(ctx, input, opts));
    } catch (e) {
      // 06 R6: one unrunnable recipe must not abort the nightly sweep.
      ctx.log.warn('run --all: recipe skipped', { recipe: recipe.id, error: (e as Error).message });
    }
  }
  const all = runs.flatMap((r) => r.heals);
  return {
    schema_version: 1,
    platform: ctx.config.platform,
    build: ctx.build,
    generated_at: now(),
    runs,
    heals: all.filter((h) => h.accepted),
    needs_human: all.filter((h) => !h.accepted),
  };
}

/** `Failed command index: 3`, `command #3 failed`, or the ✅/❌ command list Maestro prints. */
const COMMAND_INDEX_PATTERNS: readonly RegExp[] = [
  /fail(?:ed|ing)\s+command\s*(?:index)?\s*[:#]?\s*(\d+)/i,
  /command\s*[:#]?\s*(\d+)\s+failed/i,
];

/** Pure: exit code + output → outcome; `failed_command_index` when Maestro names the failing command. `message` is for the log only, never the report. */
export function parseMaestroResult(result: ExecResult): { ok: boolean; failed_command_index?: number; error_code?: HeadlessErrorCode; message?: string } {
  const out = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.timed_out === true) return { ok: false, error_code: 'timeout', message: 'maestro test timed out' };
  if (result.code === 0) return { ok: true };
  // 127 / ENOENT: the binary is not on PATH (03 §13)
  if (result.code === 127 || /\b(command not found|ENOENT|No such file or directory)\b/i.test(out)) {
    return { ok: false, error_code: 'maestro_unavailable', message: out.trim().slice(0, 500) };
  }
  let index: number | undefined;
  for (const re of COMMAND_INDEX_PATTERNS) {
    const m = re.exec(out);
    if (m?.[1] !== undefined) {
      index = Number(m[1]);
      break;
    }
  }
  if (index === undefined) {
    // best-effort: Maestro prints one line per command; count the completed ones before the
    // first failure marker. Tolerant of format changes — an unparsable log just yields no index.
    let completed = 0;
    for (const line of out.split('\n')) {
      if (/^\s*(\[ok\]|✅|✔)/.test(line)) completed++;
      else if (/^\s*(\[failed\]|❌|✖|✘)/.test(line)) {
        index = completed;
        break;
      }
    }
  }
  return { ok: false, error_code: 'maestro_failed', ...(index !== undefined ? { failed_command_index: index } : {}), message: out.trim().slice(0, 500) };
}

/** `1.39.2` → `[1, 39, 2]` (missing parts are 0) */
function parseVersion(s: string): number[] | undefined {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s);
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** `maestro --version` vs the `>=x.y.z` range in package.json (03 §13, 07 §5.3). */
export async function checkMaestroVersion(exec: ExecFn, bin: string, range: string): Promise<{ ok: boolean; version?: string; message?: string }> {
  let result: ExecResult;
  try {
    result = await exec(bin, ['--version'], { timeoutMs: 30_000 });
  } catch (e) {
    return { ok: false, message: `${bin} could not be started: ${(e as Error).message}` };
  }
  if (result.code !== 0) return { ok: false, message: `${bin} --version exited ${result.code}` };
  const found = parseVersion(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (!found) return { ok: false, message: `${bin} --version did not print a version` };
  const version = found.join('.');
  const m = /^\s*(>=|<=|>|<|=)?\s*(\d+(?:\.\d+)*)\s*$/.exec(range);
  if (!m) return { ok: true, version, message: `unparsable range ${range}; accepted` };
  const want = parseVersion(m[2] as string);
  if (!want) return { ok: true, version };
  const cmp = compareVersions(found, want);
  const op = m[1] ?? '>=';
  const ok = op === '>=' ? cmp >= 0 : op === '>' ? cmp > 0 : op === '<=' ? cmp <= 0 : op === '<' ? cmp < 0 : cmp === 0;
  return { ok, version, ...(ok ? {} : { message: `maestro ${version} does not satisfy ${range}` }) };
}

/** Default `exec`: `child_process.spawn` with `stdio: pipe`, no shell, kills on timeout. */
export const defaultExec: ExecFn = async (cmd, args, opts) => {
  return await new Promise<ExecResult>((resolveExec) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const child = spawn(cmd, [...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      ...(opts?.cwd ? { cwd: opts.cwd } : {}),
      ...(opts?.env ? { env: { ...process.env, ...opts.env } } : {}),
    });
    const timer = opts?.timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, opts.timeoutMs)
      : undefined;
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      if (timer) clearTimeout(timer);
      resolveExec({ code: 127, stdout, stderr: `${stderr}${(e as Error).message}`, timed_out: timedOut });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolveExec({ code: code ?? 1, stdout, stderr, ...(timedOut ? { timed_out: true } : {}) });
    });
  });
};

/** Default hierarchy provider: `maestro hierarchy [--udid]` → `fromMaestroHierarchy`. */
export const defaultHierarchy: HierarchyProvider = async (opts) => {
  const bin = opts.bin ?? 'maestro';
  const args = ['hierarchy', ...(opts.udid ? ['--udid', opts.udid] : [])];
  const result = await opts.exec(bin, args, { timeoutMs: 60_000 });
  if (result.code !== 0) return null;
  const start = result.stdout.indexOf('{');
  if (start < 0) return null;
  try {
    return fromMaestroHierarchy(JSON.parse(result.stdout.slice(start)), opts.platform ?? 'ios');
  } catch {
    return null;
  }
};

/** Step id the run stopped at, given the flow and Maestro's failing command index (re-exported from maestro.ts for callers). */
export function fallbackStepFor(flowCommandIndex: Record<StepId, number>, failedCommandIndex: number): StepId | undefined {
  let best: StepId | undefined;
  let bestAt = -1;
  for (const [stepId, at] of Object.entries(flowCommandIndex)) {
    if (at <= failedCommandIndex && at >= bestAt) {
      best = stepId;
      bestAt = at;
    }
  }
  return best;
}
