/**
 * [D0] The 03 §8 tool bodies, extracted from `server.ts` so BOTH front ends can call them:
 * `server.ts` registers them on the MCP server (03 §8) and `cli.ts` exposes a thin twin of each
 * map tool as a subcommand (03 §10, issue #17). A script, a CI job or a bootstrap run therefore
 * reaches `name_screen`/`identify_screen`/`plan_path`/`run_recipe` without hand-rolling an MCP
 * stdio client — which is exactly what issue #17 reported people doing.
 *
 * | tool                 | input                                            | body                                                      |
 * |----------------------|--------------------------------------------------|-----------------------------------------------------------|
 * | summary              | {}                                               | format.formatSummary(ctx.map).text                        |
 * | identify_screen      | {snapshot?, session?}                            | snapshot ? normalize+scrub+identify : identify(last obs of session); conditions from `probeConditions(ctx.probe)` |
 * | get_screen           | {screen_id, session?}                            | format.formatGetScreen (≤400 tokens); `conf` = the session's last observation's `confidence` when its `screen_after === screen_id`, else `decayConfidence(1, buildsSince(ctx.build, meta.last_verified_build))` (02 §8), else omitted |
 * | find_element         | {screen_id?, element_id? | intent?, session?}    | resolve.findElement against the last observation; an omitted `screen_id` is the last observation's screen (03 §2, issue #17) |
 * | plan_path            | {from?, to}                                      | plan.planPath; an omitted `from` is the last observation's screen, else `unknown` (03 §2, issue #17) |
 * | match_recipe         | {instruction, platform?, session?}               | match.matchRecipe; ALWAYS `observe.declareTask(ctx, session, instruction)` — matched or `no_match` (04 §2; there is no `name_task` tool) |
 * | run_recipe           | {recipe_id, params, mode, session?}              | guided.startGuidedRun | headless.runHeadless              |
 * | report_step          | {run_id, step_id, ok, note?, snapshot?}          | guided.reportStep                                         |
 * | record_observation   | {tool, input, snapshot, ok, session?}            | observe.recordObservation                                 |
 * | name_screen          | {screen_id, title?, deep_link?, force?, session?}| observe.nameScreen (explore mode); `force` re-learns a non-candidate screen (02 §8, issue #16) |
 * | compile_recipe       | {session, task, recipe_id, params[], values?}    | observe.declareTask when the session has none; compile.compileRecipe → draft YAML; on `ok` `observe.finishTask(ctx, session, {ok: true, mode_end})` (04 §3.1) |
 * | mark                 | {recipe_id \| screen_id, status, recipe?, reviewer?, force?} | lifecycle.markRecipe or lifecycle.markScreen — EXACTLY ONE id key says which (02 §6 / 02 §8). Recipe: `recipe` is the reviewed draft (RecipeFile or YAML text), required for `candidate` (04 §3.8); `reviewer` required for `ci_gate` (07 §7). Screen: the only way back out of `verified` (issue #16) |
 * | export               | {}                                               | store/export.exportMap (never `force`; that is the CLI's); names any `machine_recompiles` (04 §8) |
 *
 * Every body is pure input → `ToolResult` and THROWS on bad input: the try/catch that turns a
 * throw into `{error, hint, code}` belongs to the caller (03 §11) — `createServer`'s `guarded`
 * wrapper for MCP, `main`'s catch for the CLI. Every text output passes through
 * `capTokens(text, config.maxContextTokens)`. Results are JSON in a single text content block
 * unless the format is a fixed text block (summary, get_screen, steps). `ctx.loadError`
 * short-circuits every tool but `export` until `export`/reload.
 *
 * Session: MCP gives the server no harness session id, so observation-dependent tools take an
 * optional `session` and otherwise use the session of the newest observation in the cache
 * (`ctx.db.lastObservation()`); a guided run pins its session at `run_recipe` time and never
 * falls back across sessions (03 §2). The CLI twins thread `--session` through for the same
 * reason: a scripted driver records its observations under a session it chose itself.
 *
 * Deliberately imports NO MCP SDK and no zod — the CLI must be able to import this module
 * without pulling a transport in (architecture §1 layering).
 *
 * Layer: top (imports everything below it; imported by server.ts and cli.ts).
 */
import type { Platform } from './config.ts';
import { isPlatform } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { ErrorJson } from './errors.ts';
import { AppMapError, ERROR_CODES, toErrorJson } from './errors.ts';
import type {
  DriverInput, LoadedMap, RecipeFile, RecipeParam, RecipeParams, RecipeStatus, RunMode, ScreenId, ScreenStatus, SessionId,
} from './types.ts';
import { RECIPE_STATUSES, RUN_MODES, SCREEN_STATUSES, UNKNOWN_SCREEN, probeConditions, roleHintsFor } from './types.ts';
import { capTokens } from './token.ts';
import { indexMap } from './yaml/load.ts';
import { decayConfidence, buildsSince, identify } from './identify.ts';
import { findElement } from './resolve.ts';
import { planPath } from './plan.ts';
import {
  GET_SCREEN_MAX_TOKENS, formatFallback, formatGetScreen, formatRunStep, formatSummary,
} from './format.ts';
import { buildScrubPolicy, scrub } from './scrub.ts';
import { normalizeTree } from './tree.ts';
import { declareTask, finishTask, lastObservation, nameScreen, recordObservation } from './observe.ts';
import { matchRecipe } from './recipes/match.ts';
import { compileRecipe } from './recipes/compile.ts';
import { markRecipe, markScreen } from './recipes/lifecycle.ts';
import type { BuildInfoProbe } from './recipes/guided.ts';
import { reportStep, startGuidedRun } from './recipes/guided.ts';
import type { ExecFn, HierarchyProvider } from './recipes/headless.ts';
import { runHeadless } from './recipes/headless.ts';
import { exportMap } from './store/export.ts';

/**
 * The externals the tool bodies inject (architecture §1: "external processes go through
 * injectable ExecFn/HierarchyProvider/BuildInfoProbe parameters"), so a tool runs in-process in
 * a test without a simulator. `server.ts`'s `ServerOptions` extends this with the transport and
 * socket knobs, which the CLI has no use for. All optional: production passes none.
 */
export interface ToolOptions {
  /** 07 §3 build probe used by `run_recipe` (default: `guided.defaultBuildProbe`) */
  probe?: BuildInfoProbe;
  /** process runner for Maestro (default `headless.defaultExec`) */
  exec?: ExecFn;
  /** hierarchy dump after a headless failure (default `headless.defaultHierarchy`) */
  hierarchy?: HierarchyProvider;
  /** required Maestro range (default `package.json` `appMap.maestroVersion`, 03 §13) */
  maestroVersion?: string;
}

/** The complete tool surface (03 §8); the test asserts `TOOL_NAMES.length <= 13`. */
export const TOOL_NAMES = [
  'summary', 'identify_screen', 'get_screen', 'find_element', 'plan_path', 'match_recipe', 'run_recipe', 'report_step',
  'record_observation', 'name_screen', 'compile_recipe', 'mark', 'export',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

/** MCP tool result shape used by every handler. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// result helpers (03 §11)
// ---------------------------------------------------------------------------------------------

/** Text result, capped to `maxTokens` when given. */
export function toolText(text: string, maxTokens?: number): ToolResult {
  const body = typeof text === 'string' ? text : String(text);
  return { content: [{ type: 'text', text: maxTokens !== undefined ? capTokens(body, maxTokens) : body }] };
}

/** JSON result (`JSON.stringify(obj)`), capped; also sets `structuredContent`. */
export function toolJson(obj: Record<string, unknown>, maxTokens?: number): ToolResult {
  const json = JSON.stringify(obj);
  // the text block is what costs context (03 §8 cap); `structuredContent` keeps the full object
  // so a machine consumer never sees a truncated document.
  return {
    content: [{ type: 'text', text: maxTokens !== undefined ? capTokens(json, maxTokens) : json }],
    structuredContent: obj,
  };
}

/** `{content:[{type:'text', text: JSON.stringify({error, hint, code})}], isError: true}` (03 §11). */
export function toolError(e: unknown): ToolResult & { isError: true; structuredContent: ErrorJson & Record<string, unknown> } {
  const json = toErrorJson(e);
  return {
    content: [{ type: 'text', text: JSON.stringify(json) }],
    isError: true,
    structuredContent: json as ErrorJson & Record<string, unknown>,
  };
}

// ---------------------------------------------------------------------------------------------
// input helpers — every `inputSchema` field is `z.unknown().optional()` on purpose: the SDK turns
// a zod failure (a MISSING field *or* a wrong-typed one) into a bare-text `isError` result, while
// 03 §11 demands `{error, hint, code}`. All validation — presence AND type — therefore happens in
// the handler through these helpers, where the hint can name the fix.
// ---------------------------------------------------------------------------------------------

function requireString(v: unknown, field: string, tool: string, hint: string): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${tool} needs \`${field}\` (a non-empty string)`, hint);
  }
  return v;
}

function optionalString(v: unknown, field: string, tool: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || v === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${tool}: \`${field}\` must be a non-empty string when given`, 'omit it to use the newest observation of this cache (03 §2)');
  }
  return v;
}

function asRecord(v: unknown, field: string, tool: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${tool}: \`${field}\` must be an object`, `e.g. {${field}: {amount: 50}}`);
  }
  return v as Record<string, unknown>;
}

/** `ctx.loadError` short-circuits every tool but `export` until a reload succeeds (03 §11). */
export function requireMap(ctx: AppMapContext): LoadedMap {
  if (ctx.loadError !== null) throw ctx.loadError;
  return sessionMap(ctx);
}

/**
 * The map as this session knows it: the cache first, so a screen named by `name_screen` or a
 * recipe written by `mark` is visible to the read tools before `export` runs. `indexMap`
 * is pure (guided.ts does the same).
 */
function sessionMap(ctx: AppMapContext): LoadedMap {
  // fast path (03 §11: get_screen <10 ms): the cache can only differ from the loaded YAML where
  // this session wrote something, and every write marks the row dirty (decision 32, 04 §3.8).
  if (ctx.db.listDirty().length === 0) return ctx.map;
  const screens = ctx.db.listScreens();
  if (screens.length === 0) return ctx.map;
  return indexMap({
    platform: ctx.map.platform, manifest: ctx.map.manifest, ids: ctx.map.ids, screens,
    recipes: ctx.db.listRecipes(), staticStrings: ctx.map.staticLabels, build: ctx.build,
    files: ctx.map.files, ...(ctx.map.treeHash !== undefined ? { treeHash: ctx.map.treeHash } : {}),
  });
}

/**
 * MCP gives the server no harness session id, so observation-dependent tools take an optional
 * `session` and otherwise use the session of the newest observation in the cache (03 §2).
 */
function sessionFor(ctx: AppMapContext, session: string | undefined): SessionId | undefined {
  if (typeof session === 'string' && session !== '') return session;
  return ctx.db.lastObservation()?.session;
}

/** 03 §8: every output is capped by `APP_MAP_MAX_CONTEXT_TOKENS`. */
export function cap(ctx: AppMapContext): number {
  return ctx.config.maxContextTokens;
}

// ---------------------------------------------------------------------------------------------
// tool bodies (03 §8) — each one is pure input → `ToolResult`; `register` adds the try/catch
// ---------------------------------------------------------------------------------------------

export function toolSummary(ctx: AppMapContext): ToolResult {
  const map = requireMap(ctx);
  return toolText(formatSummary(map, { maxTokens: cap(ctx) }).text, cap(ctx));
}

export function toolIdentifyScreen(ctx: AppMapContext, args: { snapshot?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const session = optionalString(args.session, 'session', 'identify_screen');
  if (args.snapshot !== undefined && args.snapshot !== null) {
    // an LLM-supplied tree is normalized and SCRUBBED before anything looks at it (03 §7);
    // nothing is persisted — identify_screen never writes (raw trees never reach disk, 07 §2)
    // same `roleHints` as ingest (observe.ts), so a caller-supplied flat capture identifies
    // exactly the way a recorded one does (03 §5, issue #10)
    const tree = normalizeTree(args.snapshot, { platform: map.platform, roleHints: roleHintsFor(map) });
    const scrubbed = scrub(tree, buildScrubPolicy(map.ids, map.staticLabels));
    const result = identify(map, scrubbed, { build: ctx.build, ...probeConditions(ctx.probe) });
    return toolJson({ ...result, source: 'snapshot' }, cap(ctx));
  }
  const obs = lastObservation(ctx, session);
  if (obs === undefined) {
    throw new AppMapError(
      ERROR_CODES.NO_OBSERVATION,
      'no observation has been recorded yet',
      'drive the app once (the PostToolUse hook records it), or pass `snapshot` (03 §8)',
    );
  }
  if (obs.snapshot === null) {
    throw new AppMapError(
      ERROR_CODES.NO_OBSERVATION,
      `the newest observation of session ${obs.session} carries no accessibility tree`,
      'ask the driver for a snapshot, or pass `snapshot` to identify_screen',
    );
  }
  const route = typeof obs.input.url === 'string' ? obs.input.url : undefined;
  const result = identify(map, obs.snapshot, {
    ...(route !== undefined ? { route } : {}),
    build: ctx.build,
    ...probeConditions(ctx.probe),
  });
  return toolJson({ ...result, source: 'observation', session: obs.session, seq: obs.seq }, cap(ctx));
}

/** architecture §7 decision 44 */
function confidenceFor(ctx: AppMapContext, map: LoadedMap, screenId: ScreenId, session: SessionId | undefined): number | undefined {
  const obs = ctx.db.lastObservation(session);
  if (obs !== undefined && obs.screen_after === screenId && typeof obs.confidence === 'number') return obs.confidence;
  const meta = (map.screens.get(screenId) ?? map.gates.get(screenId))?.meta;
  const since = buildsSince(ctx.build, meta?.last_verified_build);
  return since === undefined ? undefined : decayConfidence(1, since);
}

export function toolGetScreen(ctx: AppMapContext, args: { screen_id?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const screenId = requireString(args.screen_id, 'screen_id', 'get_screen', 'call summary for the screen list, or identify_screen for the current one');
  const session = optionalString(args.session, 'session', 'get_screen');
  const confidence = confidenceFor(ctx, map, screenId, sessionFor(ctx, session));
  // 03 §8: ≤400 tokens, and never more than the context cap
  const maxTokens = Math.min(GET_SCREEN_MAX_TOKENS, cap(ctx));
  return toolText(formatGetScreen(map, screenId, { ...(confidence !== undefined ? { confidence } : {}), maxTokens }), maxTokens);
}

export function toolFindElement(ctx: AppMapContext, args: { screen_id?: unknown; element_id?: unknown; intent?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const session = optionalString(args.session, 'session', 'find_element');
  const obs = lastObservation(ctx, session);
  // issue #17: `screen_id` is OPTIONAL so the CLI twin can be `find-element <element_id>` with
  // no second argument. 03 §2 already says the last observation names the screen the caller is
  // standing on, and that is the screen "the element is on" when nobody says otherwise;
  // `unknown` is not a screen, so it does not supply one.
  const screenId = optionalString(args.screen_id, 'screen_id', 'find_element')
    ?? (obs !== undefined && obs.screen_after !== UNKNOWN_SCREEN ? obs.screen_after : undefined);
  if (screenId === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'find_element needs `screen_id`', 'pass it, or identify the current screen first — an omitted screen_id is the last observation\'s (03 §2)');
  }
  const elementId = optionalString(args.element_id, 'element_id', 'find_element');
  const intent = optionalString(args.intent, 'intent', 'find_element');
  if (elementId === undefined && intent === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'find_element needs `element_id` or `intent`', 'e.g. {screen_id: "invoice_list", element_id: "invoice.add.button"} or {screen_id, intent: "new invoice"}');
  }
  const result = findElement(
    map, screenId,
    { ...(elementId !== undefined ? { element_id: elementId } : {}), ...(intent !== undefined ? { intent } : {}) },
    obs?.snapshot ?? undefined,
  );
  return toolJson({ ...result }, cap(ctx));
}

export function toolPlanPath(ctx: AppMapContext, args: { from?: unknown; to?: unknown }): ToolResult {
  const map = requireMap(ctx);
  // issue #17: `from` is OPTIONAL so the CLI twin can be `plan-path <to>` — 03 §2's newest
  // observation names the screen the caller is standing on. `unknown` is `planPath`'s own word
  // for "not identified" and it already plans from there (deep link, else `kind: none`), so an
  // unidentified or observation-free cache degrades exactly the way an explicit "unknown" does.
  // `from` is validated BEFORE `to` so a wrong-typed pair still names `from` first (03 §11).
  const from = optionalString(args.from, 'from', 'plan_path') ?? ctx.db.lastObservation()?.screen_after ?? UNKNOWN_SCREEN;
  const to = requireString(args.to, 'to', 'plan_path', 'the screen you want to reach (summary lists them)');
  return toolJson({ ...planPath(map, from, to) }, cap(ctx));
}

export function toolMatchRecipe(ctx: AppMapContext, args: { instruction?: unknown; platform?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const instruction = requireString(args.instruction, 'instruction', 'match_recipe', 'pass the user task text, e.g. "create an invoice for $50 for Acme Corp"');
  const platform = optionalString(args.platform, 'platform', 'match_recipe');
  if (platform !== undefined && !isPlatform(platform)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `match_recipe: platform ${platform} is not ios|android`, 'omit it to use the served platform');
  }
  const result = matchRecipe(map, instruction, platform as Platform | undefined);
  // 04 §2 / architecture §7 decision 31: the task is declared on EVERY call (matched or not) —
  // there is no `name_task` tool.
  const session = sessionFor(ctx, optionalString(args.session, 'session', 'match_recipe'));
  if (session !== undefined) declareTask(ctx, session, instruction);
  else ctx.log.debug('match_recipe: no session to declare the task on', { instruction_len: instruction.length });
  return toolJson({ ...result, ...(session !== undefined ? { session } : {}) }, cap(ctx));
}

export async function toolRunRecipe(ctx: AppMapContext, args: { recipe_id?: unknown; params?: unknown; mode?: unknown; session?: unknown }, opts: ToolOptions = {}): Promise<ToolResult> {
  requireMap(ctx);
  const recipeId = requireString(args.recipe_id, 'recipe_id', 'run_recipe', 'call match_recipe or summary for the recipes this platform has');
  const params = asRecord(args.params, 'params', 'run_recipe') as RecipeParams;
  // 03 §8 lists `mode` as required; an omitted mode defaults to the cheap, supervised one
  const requested = args.mode === undefined || args.mode === null || args.mode === '' ? 'guided' : String(args.mode);
  if (!(RUN_MODES as readonly string[]).includes(requested)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `run_recipe: mode ${requested} is not ${RUN_MODES.join('|')}`, 'guided = step by step with report_step; headless = Maestro replay (04 §6)');
  }
  const mode = requested as RunMode;
  const session = optionalString(args.session, 'session', 'run_recipe');
  if (mode === 'headless') {
    const report = await runHeadless(ctx, { recipe_id: recipeId, params, ...(session !== undefined ? { session } : {}) }, {
      ...(opts.exec !== undefined ? { exec: opts.exec } : {}),
      ...(opts.hierarchy !== undefined ? { hierarchy: opts.hierarchy } : {}),
      ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
      ...(opts.maestroVersion !== undefined ? { maestroVersion: opts.maestroVersion } : {}),
    });
    return toolJson({ mode: 'headless', recipe: report.recipe, version: report.version, report }, cap(ctx));
  }
  const started = await startGuidedRun(ctx, { recipe_id: recipeId, params, ...(session !== undefined ? { session } : {}) }, {
    ...(opts.probe !== undefined ? { probe: opts.probe } : {}),
  });
  return toolJson({ ...started, text: formatRunStep(started.step) }, cap(ctx));
}

export async function toolReportStep(ctx: AppMapContext, args: { run_id?: unknown; step_id?: unknown; ok?: unknown; note?: unknown; snapshot?: unknown }): Promise<ToolResult> {
  requireMap(ctx);
  const runId = requireString(args.run_id, 'run_id', 'report_step', 'the run_id run_recipe returned');
  const stepId = requireString(args.step_id, 'step_id', 'report_step', 'the id of the step the server handed out');
  if (typeof args.ok !== 'boolean') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'report_step needs `ok` (true or false)', 'report whether the driver call you just made succeeded');
  }
  const result = await reportStep(ctx, {
    run_id: runId, step_id: stepId, ok: args.ok,
    ...(typeof args.note === 'string' && args.note !== '' ? { note: args.note } : {}),
    ...(args.snapshot !== undefined && args.snapshot !== null ? { snapshot: args.snapshot } : {}),
  });
  // 04 §5: steps and fallbacks are fixed text blocks; the JSON carries them for machines
  const text = result.status === 'ok' || result.status === 'gate' ? formatRunStep(result.step)
    : result.status === 'fallback' ? formatFallback(result.fallback)
      : `done ${result.verified ? 'verified' : 'unverified'}`;
  return toolJson({ ...result, text }, cap(ctx));
}

export function toolRecordObservation(ctx: AppMapContext, args: { tool?: unknown; input?: unknown; snapshot?: unknown; ok?: unknown; session?: unknown; error?: unknown; latency_ms?: unknown }): ToolResult {
  requireMap(ctx);
  const tool = requireString(args.tool, 'tool', 'record_observation', 'the driver tool name, e.g. "mcp__argent__tap"');
  const session = optionalString(args.session, 'session', 'record_observation');
  const result = recordObservation(ctx, {
    tool,
    input: asRecord(args.input, 'input', 'record_observation') as DriverInput,
    snapshot: args.snapshot,
    ok: args.ok !== false,
    ...(session !== undefined ? { session } : {}),
    ...(typeof args.error === 'string' && args.error !== '' ? { error: args.error } : {}),
    ...(typeof args.latency_ms === 'number' && Number.isFinite(args.latency_ms) ? { latency_ms: args.latency_ms } : {}),
  });
  return toolJson({ ...result }, cap(ctx));
}

export function toolNameScreen(ctx: AppMapContext, args: { screen_id?: unknown; title?: unknown; deep_link?: unknown; force?: unknown; session?: unknown }): ToolResult {
  requireMap(ctx);
  const screenId = requireString(args.screen_id, 'screen_id', 'name_screen', 'a screen id registered in ids.yaml screens[] (01 R1)');
  const session = optionalString(args.session, 'session', 'name_screen');
  const result = nameScreen(ctx, {
    screen_id: screenId,
    ...(typeof args.title === 'string' && args.title !== '' ? { title: args.title } : {}),
    ...(typeof args.deep_link === 'string' && args.deep_link !== '' ? { deep_link: args.deep_link } : {}),
    ...(args.force === true ? { force: true } : {}),
    ...(session !== undefined ? { session } : {}),
  });
  // the whole ScreenFile would blow the cap; the ids are what the LLM needs (03 §8)
  return toolJson({
    screen_id: result.screen.id,
    created: result.created,
    from_seq: result.from_seq,
    elements: result.elements,
    ...(result.screen.title !== undefined ? { title: result.screen.title } : {}),
    ...(result.screen.deep_link !== undefined ? { deep_link: result.screen.deep_link } : {}),
    status: result.screen.meta.status,
    // issue #16: a forced re-learn is not an ordinary naming — say so in the tool output too
    ...(result.relearned_from !== undefined ? { relearned_from: result.relearned_from } : {}),
  }, cap(ctx));
}

function asParams(v: unknown): RecipeParam[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe: `params` must be an array of {name, type, required?}', 'e.g. [{name: "amount", type: "money", required: true}]');
  }
  return v as RecipeParam[];
}

export function toolCompileRecipe(ctx: AppMapContext, args: { session?: unknown; task?: unknown; recipe_id?: unknown; params?: unknown; values?: unknown; revision_of?: unknown; from_seq?: unknown; to_seq?: unknown }): ToolResult {
  requireMap(ctx);
  const recipeId = requireString(args.recipe_id, 'recipe_id', 'compile_recipe', 'the id the new recipe should get, e.g. "create_invoice"');
  const task = requireString(args.task, 'task', 'compile_recipe', 'the instruction the session carried out (04 §3)');
  const session = sessionFor(ctx, optionalString(args.session, 'session', 'compile_recipe'));
  if (session === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe needs `session`', 'pass the harness session_id whose trajectory to compile (04 §3)');
  }
  // 04 §2 / architecture §7 decision 31: declare the task when the session has none
  const row = ctx.db.getSession(session);
  if (row?.task === undefined || row.task_end_seq !== undefined) declareTask(ctx, session, task);
  const result = compileRecipe(ctx, {
    session, task, recipe_id: recipeId, params: asParams(args.params),
    ...(args.values !== undefined && args.values !== null ? { values: asRecord(args.values, 'values', 'compile_recipe') as Record<string, string | number> } : {}),
    ...(typeof args.revision_of === 'number' ? { revision_of: args.revision_of } : {}),
    ...(typeof args.from_seq === 'number' ? { from_seq: args.from_seq } : {}),
    ...(typeof args.to_seq === 'number' ? { to_seq: args.to_seq } : {}),
  });
  if (!result.ok) {
    return toolJson({ ok: false, reason: result.reason, message: result.message, ...(result.offending_values !== undefined ? { offending_values: result.offending_values } : {}) }, cap(ctx));
  }
  // 04 §3.1: a successful compile closes the task
  finishTask(ctx, session, { ok: true, mode_end: ctx.db.getSession(session)?.mode ?? 'explore' });
  return toolJson({
    ok: true, recipe_id: result.recipe.id, version: result.recipe.version, status: result.recipe.status,
    yaml: result.yaml, warnings: result.warnings, collapsed_observations: result.collapsed_observations,
    next: `review the draft, then call mark {recipe_id: "${result.recipe.id}", status: "candidate", recipe: <the yaml>}`,
  }, cap(ctx));
}

/**
 * `mark` (03 §8) — one tool for both human status decisions, discriminated by WHICH id key is
 * present rather than by a `kind` enum: every other tool in this surface names its entity that
 * way (`screen_id`, `recipe_id`, `element_id`), it is impossible to pass the wrong kind, and the
 * argument objects existing callers already send are unchanged. Exactly one of the two, because
 * "mark both at once" has no meaning and a silent precedence rule would hide a typo.
 */
export function toolMark(ctx: AppMapContext, args: { recipe_id?: unknown; screen_id?: unknown; status?: unknown; recipe?: unknown; reviewer?: unknown; force?: unknown }): ToolResult {
  requireMap(ctx);
  const hasRecipe = args.recipe_id !== undefined && args.recipe_id !== null;
  const hasScreen = args.screen_id !== undefined && args.screen_id !== null;
  if (hasRecipe === hasScreen) {
    throw new AppMapError(
      ERROR_CODES.BAD_INPUT,
      'mark needs exactly one of `recipe_id` or `screen_id`',
      'e.g. {recipe_id: "create_invoice", status: "candidate"} (02 §6) or {screen_id: "person_detail", status: "candidate"} (02 §8)',
    );
  }

  if (hasScreen) {
    const screenId = requireString(args.screen_id, 'screen_id', 'mark', 'e.g. {screen_id: "person_detail", status: "candidate"}');
    const screenStatus = requireString(args.status, 'status', 'mark', `one of ${SCREEN_STATUSES.join('|')} (02 §8)`);
    if (!(SCREEN_STATUSES as readonly string[]).includes(screenStatus)) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: status ${screenStatus} is not one of ${SCREEN_STATUSES.join('|')}`, 'see 02 §8');
    }
    return toolJson({ ...markScreen(ctx, {
      screen_id: screenId, status: screenStatus as ScreenStatus,
      ...(typeof args.reviewer === 'string' && args.reviewer !== '' ? { reviewer: args.reviewer } : {}),
      ...(args.force === true ? { force: true } : {}),
    }) }, cap(ctx));
  }

  const recipeId = requireString(args.recipe_id, 'recipe_id', 'mark', 'e.g. {recipe_id: "create_invoice", status: "candidate", recipe: <draft yaml>}');
  const status = requireString(args.status, 'status', 'mark', `one of ${RECIPE_STATUSES.join('|')} (02 §6)`);
  if (!(RECIPE_STATUSES as readonly string[]).includes(status)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: status ${status} is not one of ${RECIPE_STATUSES.join('|')}`, 'see 02 §6');
  }
  let draft: RecipeFile | string | undefined;
  if (args.recipe !== undefined && args.recipe !== null) {
    if (typeof args.recipe === 'string') draft = args.recipe;
    else if (typeof args.recipe === 'object' && !Array.isArray(args.recipe)) draft = args.recipe as RecipeFile;
    else {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark: `recipe` must be the draft as YAML text or an object', 'pass the `yaml` compile_recipe returned (04 §3.8)');
    }
  }
  const result = markRecipe(ctx, {
    recipe_id: recipeId, status: status as RecipeStatus,
    ...(draft !== undefined ? { recipe: draft } : {}),
    ...(typeof args.reviewer === 'string' && args.reviewer !== '' ? { reviewer: args.reviewer } : {}),
    ...(args.force === true ? { force: true } : {}),
  });
  return toolJson({ ...result }, cap(ctx));
}

export function toolExport(ctx: AppMapContext): ToolResult {
  // `export` is the one tool that runs with a `loadError` — it is the way out of one (03 §11).
  const result = exportMap(ctx); // never `force`; that is the CLI's (03 §4)
  if (result.written.length > 0 || result.deleted.length > 0 || ctx.loadError !== null) {
    try {
      ctx.reload();
    } catch (e) {
      ctx.log.warn('export: reload after write failed', { error: (e as Error).message });
    }
  }
  // issue #13 criterion 4: only the machine-recompiled paths are listed (the capped tool output
  // stays small), because those are the ones whose steps a human still has to review (04 §8).
  const machine = result.written_from.filter((w) => w.machine_recompile);
  return toolJson({
    written: result.written, deleted: result.deleted, unchanged: result.unchanged,
    conflicts: result.conflicts.map((c) => c.path),
    ...(result.conflicts.length > 0 ? { hint: 'a YAML file changed on disk since load; rerun `app-map export --force` or reload (03 §4)' } : {}),
    ...(machine.length > 0 ? {
      machine_recompiles: machine.map((w) => ({ path: w.path, reason: w.reason })),
      recompile_hint: "these files' steps were rebuilt from a replay trajectory, not authored by a human — each carries provenance.machine_recompile: true; review the diff before merging (04 §8)",
    } : {}),
  }, cap(ctx));
}
