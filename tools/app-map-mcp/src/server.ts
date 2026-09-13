/**
 * [D1] MCP server (03 §8 tools, 03 §9 resources, 03 §11). Registered on `McpServer` from
 * `@modelcontextprotocol/sdk` (see docs/dev/toolchain.md for the exact API). Tool names appear
 * to the harness as `mcp__app-map__<name>`; ≤13 tools with short descriptions (05 §6.6).
 *
 * The tool BODIES live in `tools.ts` — they are shared verbatim with the CLI twins (03 §10,
 * issue #17), which is why this module only declares the `inputSchema`s, wraps each body in
 * `guarded()` and owns the transport. `tools.ts` carries the per-tool table; the contract each
 * body keeps (throws on bad input, caps every output, `ctx.loadError` short-circuits all but
 * `export`, 03 §2 session fallback) is documented there too.
 *
 * Registration adds the one thing MCP needs on top: `guarded()` turns a thrown error into
 * `{error, hint, code}` with `isError` (03 §11), so a handler never throws at the transport.
 * Every `inputSchema` field is `z.unknown().optional()` on purpose — a zod failure would come
 * back as bare text, while 03 §11 demands the structured shape, so ALL validation (presence and
 * type) happens in the body where the hint can name the fix.
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
 * `probe` (07 §3 build probe), `exec`/`hierarchy` (Maestro), `maestroVersion` (all four from
 * `tools.ToolOptions`), `skipMaestroCheck` — plus `transport` (default `StdioServerTransport`),
 * `socketPath` / `skipIngestSocket` and `context` (forwarded to `openContext`), so the whole
 * server runs in-process in a test without a simulator. Production passes nothing.
 *
 * Logging goes to `ctx.log` (file) — never stdout.
 *
 * Layer: top (imports everything, `tools.ts` included).
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
import { AppMapError, ERROR_CODES, toErrorJson } from './errors.ts';
import { recipeFile, screenFile } from './paths.ts';
import { capTokens } from './token.ts';
import { formatSummary } from './format.ts';
import { checkMaestroVersion, defaultExec, requiredMaestroVersion } from './recipes/headless.ts';
import { startIngestServer } from './ingest-socket.ts';
import type { IngestServer } from './ingest-socket.ts';
import type { ToolName, ToolOptions, ToolResult } from './tools.ts';
import {
  TOOL_NAMES, cap, requireMap, toolCompileRecipe, toolError, toolExport, toolFindElement, toolGetScreen,
  toolIdentifyScreen, toolMark, toolMatchRecipe, toolNameScreen, toolPlanPath, toolRecordObservation,
  toolReportStep, toolRunRecipe, toolSummary,
} from './tools.ts';

/**
 * Re-exported so an importer of the server surface (and `server.test.ts`) still finds the tool
 * result helpers where they have always been; `tools.ts` owns them now (issue #17).
 */
export { TOOL_NAMES, toolError, toolJson, toolText } from './tools.ts';
export type { ToolName, ToolResult } from './tools.ts';

export const SERVER_NAME = 'app-map';
export const SERVER_VERSION = '0.1.0';

export const RESOURCE_TEMPLATES = {
  summary: 'app-map://{platform}/summary',
  screen: 'app-map://{platform}/screens/{id}',
  recipe: 'app-map://{platform}/recipes/{id}',
} as const;

/**
 * Injectable externals (`tools.ToolOptions`: `probe`, `exec`, `hierarchy`, `maestroVersion`)
 * plus the transport and socket knobs only a server has, so the whole server is testable
 * in-process without a simulator. All optional: production passes none.
 */
export interface ServerOptions extends ToolOptions {
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
      screen_id: z.unknown().optional().describe('screen the element is on; defaults to the last observation'),
      element_id: z.unknown().optional().describe('registered element id'),
      intent: z.unknown().optional().describe('what the element does, when the id is unknown'),
      ...sessionArg,
    },
  }, guarded('find_element', (args: { screen_id?: unknown; element_id?: unknown; intent?: unknown; session?: unknown }) => toolFindElement(ctx, args)));

  server.registerTool('plan_path', {
    title: 'Plan path',
    description: 'Deep link or ordered edge list from one screen to another.',
    inputSchema: {
      from: z.unknown().optional().describe('current screen id; defaults to the last observation, else "unknown"'),
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
      force: z.unknown().optional().describe('re-learn a screen that is no longer candidate (02 §8); records meta.relearned_from'),
      ...sessionArg,
    },
  }, guarded('name_screen', (args: { screen_id?: unknown; title?: unknown; deep_link?: unknown; force?: unknown; session?: unknown }) => toolNameScreen(ctx, args)));

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

  server.registerTool('mark', {
    title: 'Mark',
    description: 'Promote or demote one recipe or one screen (human review).',
    inputSchema: {
      recipe_id: z.unknown().optional().describe('a recipe id; pass this or screen_id, never both'),
      screen_id: z.unknown().optional().describe('a screen id; the only way back out of verified (02 §8)'),
      status: z.unknown().optional().describe('recipe: candidate | verified | ci_gate | retired · screen: candidate | verified | retired'),
      recipe: z.unknown().optional().describe('the reviewed draft (YAML text or object); required for a new candidate'),
      reviewer: z.unknown().optional().describe('required for ci_gate, and for a forced screen verified (07 §7)'),
      force: z.unknown().optional(),
    },
  }, guarded('mark', (args: { recipe_id?: unknown; screen_id?: unknown; status?: unknown; recipe?: unknown; reviewer?: unknown; force?: unknown }) => toolMark(ctx, args)));

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
