/**
 * [D1] MCP server (03 §8 tools, 03 §9 resources, 03 §11). Registered on `McpServer` from
 * `@modelcontextprotocol/sdk` (see docs/dev/toolchain.md for the exact API). Tool names appear
 * to the harness as `mcp__app-map__<name>`; ≤13 tools with short descriptions (05 §6.6).
 *
 * | tool                 | input                                            | body                                                      |
 * |----------------------|--------------------------------------------------|-----------------------------------------------------------|
 * | summary              | {}                                               | format.formatSummary(ctx.map).text                        |
 * | identify_screen      | {snapshot?}                                      | snapshot ? normalize+scrub+identify : identify(last obs)  |
 * | get_screen           | {screen_id}                                      | format.formatGetScreen (≤400 tokens)                      |
 * | find_element         | {screen_id, element_id? | intent?}               | resolve.findElement against the last observation          |
 * | plan_path            | {from, to}                                       | plan.planPath                                             |
 * | match_recipe         | {instruction, platform?}                         | match.matchRecipe + observe.declareTask                   |
 * | run_recipe           | {recipe_id, params, mode}                        | guided.startGuidedRun | headless.runHeadless              |
 * | report_step          | {run_id, step_id, ok, note?, snapshot?}          | guided.reportStep                                         |
 * | record_observation   | {tool, input, snapshot, ok}                      | observe.recordObservation                                 |
 * | name_screen          | {screen_id, title?, deep_link?}                  | candidate screen from the last observation (explore mode) |
 * | compile_recipe       | {session, task, recipe_id, params[]}             | compile.compileRecipe → draft YAML                        |
 * | mark_recipe          | {recipe_id, status}                              | lifecycle.markRecipe                                      |
 * | export               | {}                                               | store/export.exportMap                                    |
 *
 * Every handler: `try { … } catch (e) { return toolError(e) }` — never throws (03 §11); every
 * text output passes through `capTokens(text, config.maxContextTokens)`. Results are JSON in
 * a single text content block unless the format is a fixed text block (summary, get_screen,
 * steps). `ctx.loadError` short-circuits every tool with that error until `export`/reload.
 * The session id for observation-dependent tools is taken from the newest observation unless
 * the input carries `session`.
 *
 * Resources (03 §9): `app-map://{platform}/summary`, `app-map://{platform}/screens/{id}`,
 * `app-map://{platform}/recipes/{id}` (YAML verbatim from disk, `application/yaml`).
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
