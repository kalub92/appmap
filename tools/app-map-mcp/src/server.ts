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
 * | export               | {}                                               | store/export.exportMap (never `force`; that is the CLI's) |
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
 * Logging goes to `ctx.log` (file) — never stdout.
 *
 * Layer: top (imports everything).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppMapConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { ErrorJson } from './errors.ts';
import { NotImplementedError } from './errors.ts';

export const SERVER_NAME = 'app-map';

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

/** Build the server with every tool/resource registered; does not connect a transport. */
export function createServer(ctx: AppMapContext): McpServer {
  void ctx;
  throw new NotImplementedError('server.createServer');
}

export interface RunningServer {
  server: McpServer;
  ctx: AppMapContext;
  close(): Promise<void>;
}

/**
 * Open the context, start the ingest socket (ingest-socket.ts), connect stdio. Server start to
 * first tool must be <700 ms (03 §11). Signals (SIGINT/SIGTERM) close everything.
 */
export function startServer(config: AppMapConfig): Promise<RunningServer> {
  void config;
  throw new NotImplementedError('server.startServer');
}

/** Text result, capped to `maxTokens` when given. */
export function toolText(text: string, maxTokens?: number): ToolResult {
  void text; void maxTokens;
  throw new NotImplementedError('server.toolText');
}

/** JSON result (`JSON.stringify(obj)`), capped; also sets `structuredContent`. */
export function toolJson(obj: Record<string, unknown>, maxTokens?: number): ToolResult {
  void obj; void maxTokens;
  throw new NotImplementedError('server.toolJson');
}

/** `{content:[{type:'text', text: JSON.stringify({error, hint, code})}], isError: true}` (03 §11). */
export function toolError(e: unknown): ToolResult & { isError: true; structuredContent: ErrorJson & Record<string, unknown> } {
  void e;
  throw new NotImplementedError('server.toolError');
}
