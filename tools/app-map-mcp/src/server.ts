/**
 * [D1] MCP server (03 §8 tools, 03 §9 resources, 03 §11). Registered on `McpServer` from
 * `@modelcontextprotocol/sdk` (see docs/dev/toolchain.md for the exact API). Tool names appear
 * to the harness as `mcp__app-map__<name>`; ≤13 tools with short descriptions (05 §6.6).
 *
 * | tool                 | input                                            | body                                                      |
 * |----------------------|--------------------------------------------------|-----------------------------------------------------------|
 * | summary              | {}                                               | format.formatSummary(ctx.map).text                        |
 * | identify_screen      | {snapshot?, session?}                            | snapshot ? normalize+scrub+identify : identify(last obs of session); conditions from `probeConditions(ctx.probe)` |
 * | get_screen           | {screen_id, session?}                            | format.formatGetScreen (≤400 tokens); `conf` = the session's last observation's `confidence` when its `screen_after === screen_id`, else `decayConfidence(1, buildsSince(ctx.build, meta.last_verified_build))` (02 §8), else omitted |
 * | find_element         | {screen_id, element_id? | intent?, session?}     | resolve.findElement against the last observation          |
 * | plan_path            | {from, to}                                       | plan.planPath                                             |
 * | match_recipe         | {instruction, platform?, session?}               | match.matchRecipe; ALWAYS `observe.declareTask(ctx, session, instruction)` — matched or `no_match` (04 §2; there is no `name_task` tool) |
 * | run_recipe           | {recipe_id, params, mode, session?}              | guided.startGuidedRun | headless.runHeadless              |
 * | report_step          | {run_id, step_id, ok, note?, snapshot?}          | guided.reportStep                                         |
 * | record_observation   | {tool, input, snapshot, ok, session?}            | observe.recordObservation                                 |
 * | name_screen          | {screen_id, title?, deep_link?, session?}        | observe.nameScreen (explore mode)                         |
 * | compile_recipe       | {session, task, recipe_id, params[], values?}    | observe.declareTask when the session has none; compile.compileRecipe → draft YAML; on `ok` `observe.finishTask(ctx, session, {ok: true, mode_end})` (04 §3.1) |
 * | mark_recipe          | {recipe_id, status, recipe?, reviewer?}          | lifecycle.markRecipe(ctx, MarkRecipeInput) — `recipe` is the reviewed draft (RecipeFile or YAML text), required for `candidate` (04 §3.8); `reviewer` required for `ci_gate` (07 §7) |
 * | export               | {}                                               | store/export.exportMap (never `force`; that is the CLI's); names any `machine_recompiles` (04 §8) |
 *
 * Every handler: `try { … } catch (e) { return toolError(e) }` — never throws (03 §11); every
 * text output passes through `capTokens(text, config.maxContextTokens)`. Results are JSON in
 * a single text content block unless the format is a fixed text block (summary, get_screen,
 * steps). `ctx.loadError` short-circuits every tool with that error until `export`/reload.
 * Session: MCP gives the server no harness session id, so observation-dependent tools take an
 * optional `session` and otherwise use the session of the newest observation in the cache
 * (`ctx.db.lastObservation()`); a guided run pins its session at `run_recipe` time and never
 * falls back across sessions (03 §2).
 *
 * Resources (03 §9): `app-map://{platform}/summary`, `app-map://{platform}/screens/{id}`,
 * `app-map://{platform}/recipes/{id}` (YAML verbatim from disk, `application/yaml`).
 *
 * Startup (`startServer`): `openContext` → `startIngestServer` → connect stdio; then, without
 * blocking the first tool (03 §11 <700 ms), `headless.checkMaestroVersion(defaultExec,
 * config.maestroBin, package.json appMap.maestroVersion)` once, non-fatal — a mismatch or
 * missing binary is logged as `warn` (03 §13, 07 §5.3); headless runs re-check and fail with
 * `maestro_unavailable`.
 *
 * `createServer(ctx, opts)` / `startServer(config, opts)` take an optional `ServerOptions`
 * (added to the stub's signatures): the injectable externals architecture §1 requires —
 * `probe` (07 §3 build probe), `exec`/`hierarchy` (Maestro), `maestroVersion`,
 * `skipMaestroCheck` — plus `transport` (default `StdioServerTransport`), `socketPath` /
 * `skipIngestSocket` and `context` (forwarded to `openContext`), so the whole server runs
 * in-process in a test without a simulator. Production passes nothing.
 *
 * Logging goes to `ctx.log` (file) — never stdout.
 *
 * Layer: top (imports everything).
 */
import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { AppMapConfig, Platform } from './config.ts';
import { isPlatform } from './config.ts';
import type { AppMapContext, OpenContextOptions } from './context.ts';
import { openContext } from './context.ts';
import type { ErrorJson } from './errors.ts';
import { AppMapError, ERROR_CODES, toErrorJson } from './errors.ts';
import { recipeFile, screenFile } from './paths.ts';
import type {
  DriverInput, LoadedMap, RecipeFile, RecipeParam, RecipeParams, RecipeStatus, RunMode, ScreenId, SessionId,
} from './types.ts';
import { RECIPE_STATUSES, RUN_MODES, probeConditions } from './types.ts';
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
import { markRecipe } from './recipes/lifecycle.ts';
import type { BuildInfoProbe } from './recipes/guided.ts';
import { reportStep, startGuidedRun } from './recipes/guided.ts';
import type { ExecFn, HierarchyProvider } from './recipes/headless.ts';
import { checkMaestroVersion, defaultExec, requiredMaestroVersion, runHeadless } from './recipes/headless.ts';
import { exportMap } from './store/export.ts';
import { startIngestServer } from './ingest-socket.ts';
import type { IngestServer } from './ingest-socket.ts';

export const SERVER_NAME = 'app-map';
export const SERVER_VERSION = '0.1.0';

/** The complete tool surface (03 §8); the test asserts `TOOL_NAMES.length <= 13`. */
export const TOOL_NAMES = [
  'summary', 'identify_screen', 'get_screen', 'find_element', 'plan_path', 'match_recipe', 'run_recipe', 'report_step',
  'record_observation', 'name_screen', 'compile_recipe', 'mark_recipe', 'export',
] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export const RESOURCE_TEMPLATES = {
  summary: 'app-map://{platform}/summary',
  screen: 'app-map://{platform}/screens/{id}',
  recipe: 'app-map://{platform}/recipes/{id}',
} as const;

/** MCP tool result shape used by every handler. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/**
 * Injectable externals (architecture §1 "external processes go through injectable
 * ExecFn/HierarchyProvider/BuildInfoProbe parameters") plus the transport, so the whole server
 * is testable in-process without a simulator. All optional: production passes none.
 */
export interface ServerOptions {
  /** 07 §3 build probe used by `run_recipe` (default: `guided.defaultBuildProbe`) */
  probe?: BuildInfoProbe;
  /** process runner for Maestro (default `headless.defaultExec`) */
  exec?: ExecFn;
  /** hierarchy dump after a headless failure (default `headless.defaultHierarchy`) */
  hierarchy?: HierarchyProvider;
  /** required Maestro range (default `package.json` `appMap.maestroVersion`, 03 §13) */
  maestroVersion?: string;
  /** skip the 03 §13 start-up version check entirely (tests) */
  skipMaestroCheck?: boolean;
  /** transport to connect (default `StdioServerTransport`; tests pass an `InMemoryTransport`) */
  transport?: Transport;
  /** override the ingest socket path (tests) */
  socketPath?: string;
  /** skip the ingest socket (CLI-ish embeddings, tests) */
  skipIngestSocket?: boolean;
  /** forwarded to `openContext` (log sink, retention, db path) */
  context?: OpenContextOptions;
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
function requireMap(ctx: AppMapContext): LoadedMap {
  if (ctx.loadError !== null) throw ctx.loadError;
  return sessionMap(ctx);
}

/**
 * The map as this session knows it: the cache first, so a screen named by `name_screen` or a
 * recipe written by `mark_recipe` is visible to the read tools before `export` runs. `indexMap`
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
function cap(ctx: AppMapContext): number {
  return ctx.config.maxContextTokens;
}

// ---------------------------------------------------------------------------------------------
// tool bodies (03 §8) — each one is pure input → `ToolResult`; `register` adds the try/catch
// ---------------------------------------------------------------------------------------------

function toolSummary(ctx: AppMapContext): ToolResult {
  const map = requireMap(ctx);
  return toolText(formatSummary(map, { maxTokens: cap(ctx) }).text, cap(ctx));
}

function toolIdentifyScreen(ctx: AppMapContext, args: { snapshot?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const session = optionalString(args.session, 'session', 'identify_screen');
  if (args.snapshot !== undefined && args.snapshot !== null) {
    // an LLM-supplied tree is normalized and SCRUBBED before anything looks at it (03 §7);
    // nothing is persisted — identify_screen never writes (raw trees never reach disk, 07 §2)
    const tree = normalizeTree(args.snapshot, { platform: map.platform });
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

function toolGetScreen(ctx: AppMapContext, args: { screen_id?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const screenId = requireString(args.screen_id, 'screen_id', 'get_screen', 'call summary for the screen list, or identify_screen for the current one');
  const session = optionalString(args.session, 'session', 'get_screen');
  const confidence = confidenceFor(ctx, map, screenId, sessionFor(ctx, session));
  // 03 §8: ≤400 tokens, and never more than the context cap
  const maxTokens = Math.min(GET_SCREEN_MAX_TOKENS, cap(ctx));
  return toolText(formatGetScreen(map, screenId, { ...(confidence !== undefined ? { confidence } : {}), maxTokens }), maxTokens);
}

function toolFindElement(ctx: AppMapContext, args: { screen_id?: unknown; element_id?: unknown; intent?: unknown; session?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const screenId = requireString(args.screen_id, 'screen_id', 'find_element', 'the screen the element is on (identify_screen returns it)');
  const elementId = optionalString(args.element_id, 'element_id', 'find_element');
  const intent = optionalString(args.intent, 'intent', 'find_element');
  if (elementId === undefined && intent === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'find_element needs `element_id` or `intent`', 'e.g. {screen_id: "invoice_list", element_id: "invoice.add.button"} or {screen_id, intent: "new invoice"}');
  }
  const session = optionalString(args.session, 'session', 'find_element');
  const obs = lastObservation(ctx, session);
  const result = findElement(
    map, screenId,
    { ...(elementId !== undefined ? { element_id: elementId } : {}), ...(intent !== undefined ? { intent } : {}) },
    obs?.snapshot ?? undefined,
  );
  return toolJson({ ...result }, cap(ctx));
}

function toolPlanPath(ctx: AppMapContext, args: { from?: unknown; to?: unknown }): ToolResult {
  const map = requireMap(ctx);
  const from = requireString(args.from, 'from', 'plan_path', 'the current screen id, or "unknown" when it is not identified');
  const to = requireString(args.to, 'to', 'plan_path', 'the screen you want to reach (summary lists them)');
  return toolJson({ ...planPath(map, from, to) }, cap(ctx));
}

function toolMatchRecipe(ctx: AppMapContext, args: { instruction?: unknown; platform?: unknown; session?: unknown }): ToolResult {
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

async function toolRunRecipe(ctx: AppMapContext, args: { recipe_id?: unknown; params?: unknown; mode?: unknown; session?: unknown }, opts: ServerOptions): Promise<ToolResult> {
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

async function toolReportStep(ctx: AppMapContext, args: { run_id?: unknown; step_id?: unknown; ok?: unknown; note?: unknown; snapshot?: unknown }): Promise<ToolResult> {
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

function toolRecordObservation(ctx: AppMapContext, args: { tool?: unknown; input?: unknown; snapshot?: unknown; ok?: unknown; session?: unknown; error?: unknown; latency_ms?: unknown }): ToolResult {
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

function toolNameScreen(ctx: AppMapContext, args: { screen_id?: unknown; title?: unknown; deep_link?: unknown; session?: unknown }): ToolResult {
  requireMap(ctx);
  const screenId = requireString(args.screen_id, 'screen_id', 'name_screen', 'a screen id registered in ids.yaml screens[] (01 R1)');
  const session = optionalString(args.session, 'session', 'name_screen');
  const result = nameScreen(ctx, {
    screen_id: screenId,
    ...(typeof args.title === 'string' && args.title !== '' ? { title: args.title } : {}),
    ...(typeof args.deep_link === 'string' && args.deep_link !== '' ? { deep_link: args.deep_link } : {}),
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
  }, cap(ctx));
}

function asParams(v: unknown): RecipeParam[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'compile_recipe: `params` must be an array of {name, type, required?}', 'e.g. [{name: "amount", type: "money", required: true}]');
  }
  return v as RecipeParam[];
}

function toolCompileRecipe(ctx: AppMapContext, args: { session?: unknown; task?: unknown; recipe_id?: unknown; params?: unknown; values?: unknown; revision_of?: unknown; from_seq?: unknown; to_seq?: unknown }): ToolResult {
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
    next: `review the draft, then call mark_recipe {recipe_id: "${result.recipe.id}", status: "candidate", recipe: <the yaml>}`,
  }, cap(ctx));
}

function toolMarkRecipe(ctx: AppMapContext, args: { recipe_id?: unknown; status?: unknown; recipe?: unknown; reviewer?: unknown; force?: unknown }): ToolResult {
  requireMap(ctx);
  const recipeId = requireString(args.recipe_id, 'recipe_id', 'mark_recipe', 'e.g. {recipe_id: "create_invoice", status: "candidate", recipe: <draft yaml>}');
  const status = requireString(args.status, 'status', 'mark_recipe', `one of ${RECIPE_STATUSES.join('|')} (02 §6)`);
  if (!(RECIPE_STATUSES as readonly string[]).includes(status)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark_recipe: status ${status} is not one of ${RECIPE_STATUSES.join('|')}`, 'see 02 §6');
  }
  let draft: RecipeFile | string | undefined;
  if (args.recipe !== undefined && args.recipe !== null) {
    if (typeof args.recipe === 'string') draft = args.recipe;
    else if (typeof args.recipe === 'object' && !Array.isArray(args.recipe)) draft = args.recipe as RecipeFile;
    else {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark_recipe: `recipe` must be the draft as YAML text or an object', 'pass the `yaml` compile_recipe returned (04 §3.8)');
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

function toolExport(ctx: AppMapContext): ToolResult {
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

// ---------------------------------------------------------------------------------------------
// registration
// ---------------------------------------------------------------------------------------------

/** Build the server with every tool/resource registered; does not connect a transport. */
export function createServer(ctx: AppMapContext, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  /**
   * 03 §11: a tool handler never throws — it returns `{error, hint, code}` with `isError`.
   * The cast widens `ToolResult` to the SDK's `CallToolResult` (which carries an index
   * signature for `_meta` and friends); the shape itself is identical.
   */
  const guarded = <A>(name: ToolName, body: (args: A) => ToolResult | Promise<ToolResult>) => async (args: A): Promise<ToolResult & Record<string, unknown>> => {
    const startedMs = Date.now();
    try {
      const result = await body(args);
      ctx.log.debug('tool ok', { tool: name, ms: Date.now() - startedMs });
      return { ...result } as ToolResult & Record<string, unknown>;
    } catch (e) {
      const json = toErrorJson(e);
      ctx.log.warn('tool failed', { tool: name, code: json.code, error: json.error, ms: Date.now() - startedMs });
      return { ...toolError(e) } as ToolResult & Record<string, unknown>;
    }
  };

  const sessionArg = { session: z.unknown().optional().describe('harness session_id; defaults to the newest observation') };

  server.registerTool('summary', {
    title: 'App-map summary',
    description: 'Screens, gates and recipes of the loaded app-map. Call this first.',
    inputSchema: {},
  }, guarded<Record<string, never>>('summary', () => toolSummary(ctx)));

  server.registerTool('identify_screen', {
    title: 'Identify screen',
    description: 'Identify the current screen from the last driver observation, or from a snapshot.',
    inputSchema: { snapshot: z.unknown().optional().describe('accessibility tree; omit to use the last observation'), ...sessionArg },
  }, guarded('identify_screen', (args: { snapshot?: unknown; session?: unknown }) => toolIdentifyScreen(ctx, args)));

  server.registerTool('get_screen', {
    title: 'Get screen',
    description: 'Elements, gates and recipes of one screen (≤400 tokens).',
    inputSchema: { screen_id: z.unknown().optional().describe('screen id, e.g. invoice_list'), ...sessionArg },
  }, guarded('get_screen', (args: { screen_id?: unknown; session?: unknown }) => toolGetScreen(ctx, args)));

  server.registerTool('find_element', {
    title: 'Find element',
    description: 'Resolve an element id or intent on a screen to a driver locator.',
    inputSchema: {
      screen_id: z.unknown().optional().describe('screen the element is on'),
      element_id: z.unknown().optional().describe('registered element id'),
      intent: z.unknown().optional().describe('what the element does, when the id is unknown'),
      ...sessionArg,
    },
  }, guarded('find_element', (args: { screen_id?: unknown; element_id?: unknown; intent?: unknown; session?: unknown }) => toolFindElement(ctx, args)));

  server.registerTool('plan_path', {
    title: 'Plan path',
    description: 'Deep link or ordered edge list from one screen to another.',
    inputSchema: {
      from: z.unknown().optional().describe('current screen id, or "unknown"'),
      to: z.unknown().optional().describe('destination screen id'),
    },
  }, guarded('plan_path', (args: { from?: unknown; to?: unknown }) => toolPlanPath(ctx, args)));

  server.registerTool('match_recipe', {
    title: 'Match recipe',
    description: 'Find a recipe for a task instruction; also records the task on the session.',
    inputSchema: {
      instruction: z.unknown().optional().describe('the user task text'),
      platform: z.unknown().optional().describe('ios | android; defaults to the served platform'),
      ...sessionArg,
    },
  }, guarded('match_recipe', (args: { instruction?: unknown; platform?: unknown; session?: unknown }) => toolMatchRecipe(ctx, args)));

  server.registerTool('run_recipe', {
    title: 'Run recipe',
    description: 'Start a recipe run: guided (one step at a time) or headless (Maestro).',
    inputSchema: {
      recipe_id: z.unknown().optional().describe('recipe to run'),
      params: z.unknown().optional().describe('recipe params, e.g. {amount: 50}'),
      mode: z.unknown().optional().describe('guided (default) | headless'),
      ...sessionArg,
    },
  }, guarded('run_recipe', async (args: { recipe_id?: unknown; params?: unknown; mode?: unknown; session?: unknown }) => await toolRunRecipe(ctx, args, opts)));

  server.registerTool('report_step', {
    title: 'Report step',
    description: 'Report a guided step; returns the next step, done, or a fallback.',
    inputSchema: {
      run_id: z.unknown().optional().describe('run_recipe run id'),
      step_id: z.unknown().optional().describe('the step the server handed out'),
      ok: z.unknown().optional().describe('did the driver call succeed'),
      note: z.unknown().optional().describe('one line of context on a failure'),
      snapshot: z.unknown().optional().describe('only when hooks are unavailable (expensive)'),
    },
  }, guarded('report_step', async (args: { run_id?: unknown; step_id?: unknown; ok?: unknown; note?: unknown; snapshot?: unknown }) => await toolReportStep(ctx, args)));

  server.registerTool('record_observation', {
    title: 'Record observation',
    description: 'Record a driver call and its snapshot. Only when the hook is unavailable.',
    inputSchema: {
      tool: z.unknown().optional().describe('driver tool name, e.g. mcp__argent__tap'),
      input: z.unknown().optional().describe('the driver input'),
      snapshot: z.unknown().optional().describe('accessibility tree after the call'),
      ok: z.unknown().optional().describe('did the call succeed (default true)'),
      error: z.unknown().optional(),
      latency_ms: z.unknown().optional(),
      ...sessionArg,
    },
  }, guarded('record_observation', (args: { tool?: unknown; input?: unknown; snapshot?: unknown; ok?: unknown; session?: unknown; error?: unknown; latency_ms?: unknown }) => toolRecordObservation(ctx, args)));

  server.registerTool('name_screen', {
    title: 'Name screen',
    description: 'Name the unknown screen of the last observation (explore mode only).',
    inputSchema: {
      screen_id: z.unknown().optional().describe('id registered in ids.yaml screens[]'),
      title: z.unknown().optional(),
      deep_link: z.unknown().optional().describe('appmap://<id>, or none'),
      ...sessionArg,
    },
  }, guarded('name_screen', (args: { screen_id?: unknown; title?: unknown; deep_link?: unknown; session?: unknown }) => toolNameScreen(ctx, args)));

  server.registerTool('compile_recipe', {
    title: 'Compile recipe',
    description: 'Compile the session trajectory into a draft recipe for review.',
    inputSchema: {
      session: z.unknown().optional().describe('session whose trajectory to compile'),
      task: z.unknown().optional().describe('the instruction that was carried out'),
      recipe_id: z.unknown().optional().describe('id for the new recipe'),
      params: z.unknown().optional().describe('[{name, type, required?}] (02 §6)'),
      values: z.unknown().optional().describe('the concrete values used, e.g. {amount: 50}'),
      revision_of: z.unknown().optional().describe('version being revised (04 §8)'),
      from_seq: z.unknown().optional(),
      to_seq: z.unknown().optional(),
    },
  }, guarded('compile_recipe', (args: { session?: unknown; task?: unknown; recipe_id?: unknown; params?: unknown; values?: unknown; revision_of?: unknown; from_seq?: unknown; to_seq?: unknown }) => toolCompileRecipe(ctx, args)));

  server.registerTool('mark_recipe', {
    title: 'Mark recipe',
    description: 'Promote or demote a recipe (candidate | verified | ci_gate | retired).',
    inputSchema: {
      recipe_id: z.unknown().optional(),
      status: z.unknown().optional().describe('candidate | verified | ci_gate | retired'),
      recipe: z.unknown().optional().describe('the reviewed draft (YAML text or object); required for a new candidate'),
      reviewer: z.unknown().optional().describe('required for ci_gate (07 §7)'),
      force: z.unknown().optional(),
    },
  }, guarded('mark_recipe', (args: { recipe_id?: unknown; status?: unknown; recipe?: unknown; reviewer?: unknown; force?: unknown }) => toolMarkRecipe(ctx, args)));

  server.registerTool('export', {
    title: 'Export',
    description: 'Write this session\'s map changes to canonical YAML.',
    inputSchema: {},
  }, guarded<Record<string, never>>('export', () => toolExport(ctx)));

  // 03 §9 resources — for harnesses that prefer reading over tool calls
  const platformOf = (value: unknown): Platform => {
    const p = Array.isArray(value) ? value[0] : value;
    if (!isPlatform(p)) {
      throw new AppMapError(ERROR_CODES.NOT_FOUND, `unknown platform ${String(p)} in resource uri`, 'use app-map://ios/… or app-map://android/…');
    }
    return p;
  };
  const one = (value: unknown): string => (Array.isArray(value) ? String(value[0]) : String(value));
  /**
   * 03 §9: the YAML file verbatim from disk. The error names the path RELATIVE to the map dir —
   * the absolute path is the developer's checkout location and has no business in a response
   * that leaves the process (07 §2); it goes to the log instead.
   */
  const readYaml = (path: string, what: string): string => {
    try {
      return readFileSync(path, 'utf8');
    } catch (e) {
      const rel = relative(ctx.config.dir, path).split(sep).join('/');
      ctx.log.debug('resource not found', { what, path, error: (e as Error).message });
      throw new AppMapError(ERROR_CODES.NOT_FOUND, `${what} has no YAML file at ${rel}`, 'call summary for what this platform has');
    }
  };

  server.registerResource('summary', new ResourceTemplate(RESOURCE_TEMPLATES.summary, { list: undefined }), {
    title: 'App-map summary', description: 'Same as the summary tool.', mimeType: 'text/plain',
  }, (uri, vars) => {
    const platform = platformOf(vars.platform);
    // 03 §3: one instance serves one platform; the other platform's summary needs its own server
    if (platform !== ctx.map.platform) {
      throw new AppMapError(ERROR_CODES.NOT_FOUND, `this server serves ${ctx.map.platform}, not ${platform}`, 'set APP_MAP_PLATFORM to the platform you want (03 §3)');
    }
    const map = requireMap(ctx);
    return { contents: [{ uri: uri.href, mimeType: 'text/plain', text: capTokens(formatSummary(map, { maxTokens: cap(ctx) }).text, cap(ctx)) }] };
  });

  server.registerResource('screen', new ResourceTemplate(RESOURCE_TEMPLATES.screen, { list: undefined }), {
    title: 'Screen YAML', description: 'One screen file, verbatim.', mimeType: 'application/yaml',
  }, (uri, vars) => {
    const platform = platformOf(vars.platform);
    const id = one(vars.id);
    const text = readYaml(screenFile(ctx.config, id, platform), `screen ${id}`);
    return { contents: [{ uri: uri.href, mimeType: 'application/yaml', text }] };
  });

  server.registerResource('recipe', new ResourceTemplate(RESOURCE_TEMPLATES.recipe, { list: undefined }), {
    title: 'Recipe YAML', description: 'One recipe file, verbatim.', mimeType: 'application/yaml',
  }, (uri, vars) => {
    const platform = platformOf(vars.platform);
    const id = one(vars.id);
    const text = readYaml(recipeFile(ctx.config, id, platform), `recipe ${id}`);
    return { contents: [{ uri: uri.href, mimeType: 'application/yaml', text }] };
  });

  return server;
}

export interface RunningServer {
  server: McpServer;
  ctx: AppMapContext;
  /** the ingest socket this instance started; `listening: false` when another instance owns it */
  ingest?: IngestServer;
  /** the 03 §13 Maestro check, started after connect and never awaited on the critical path */
  maestroCheck?: Promise<{ ok: boolean; version?: string; message?: string } | null>;
  close(): Promise<void>;
}

/**
 * Open the context, start the ingest socket (ingest-socket.ts), connect stdio. Server start to
 * first tool must be <700 ms (03 §11). Signals (SIGINT/SIGTERM) close everything.
 */
export async function startServer(config: AppMapConfig, opts: ServerOptions = {}): Promise<RunningServer> {
  const ctx = openContext(config, { logSink: 'file', ...opts.context });
  let ingest: IngestServer | undefined;
  let server: McpServer | undefined;
  try {
    if (opts.skipIngestSocket !== true) {
      // 03 §2: hooks post observations here; a second instance finds a live listener and skips it
      ingest = await startIngestServer(ctx, { ...(opts.socketPath !== undefined ? { socketPath: opts.socketPath } : {}) });
    }
    server = createServer(ctx, opts);
    await server.connect(opts.transport ?? new StdioServerTransport());
  } catch (e) {
    await ingest?.close();
    ctx.close();
    throw e;
  }

  // 03 §13 / architecture §7 decision 43: one Maestro version check, after connect, non-fatal
  // and off the first-tool critical path (03 §11 <700 ms).
  const maestroCheck: Promise<{ ok: boolean; version?: string; message?: string } | null> = opts.skipMaestroCheck === true
    ? Promise.resolve(null)
    : (async () => {
      try {
        const range = opts.maestroVersion ?? requiredMaestroVersion();
        const result = await checkMaestroVersion(opts.exec ?? defaultExec, config.maestroBin, range);
        if (!result.ok) ctx.log.warn('maestro version check failed (headless replay will not run)', { bin: config.maestroBin, range, ...(result.version !== undefined ? { version: result.version } : {}), ...(result.message !== undefined ? { message: result.message } : {}) });
        else ctx.log.info('maestro ok', { bin: config.maestroBin, version: result.version ?? 'unknown', range });
        return result;
      } catch (e) {
        ctx.log.warn('maestro version check errored', { error: (e as Error).message });
        return { ok: false, message: (e as Error).message };
      }
    })();

  let closed = false;
  const running: RunningServer = {
    server,
    ctx,
    ...(ingest !== undefined ? { ingest } : {}),
    maestroCheck,
    async close() {
      if (closed) return;
      closed = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      try {
        await server?.close();
      } catch (e) {
        ctx.log.warn('server close failed', { error: (e as Error).message });
      }
      await ingest?.close();
      ctx.close();
    },
  };
  function onSignal(): void {
    void running.close().then(() => process.exit(0), () => process.exit(1));
  }
  // stdin EOF (the harness went away) tears down the socket too — 03 §2: removed on exit
  server.server.onclose = () => { void running.close(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  ctx.log.info('app-map server started', {
    platform: config.platform, build: ctx.build, screens: ctx.map.screens.size, recipes: ctx.map.recipes.size,
    tools: TOOL_NAMES.length, socket: ingest?.listening === true ? ingest.socketPath : 'not owned',
    ...(ctx.loadError !== null ? { load_error: ctx.loadError.code } : {}),
  });
  return running;
}
