/**
 * [D2] `bin/app-map` CLI (03 §10). Shares the library with the server; never talks to a
 * running server except `record`, which prefers the ingest socket (03 §2) and falls back to
 * direct SQLite writes.
 *
 * | command                                                     | used by            | body                                              |
 * |-------------------------------------------------------------|--------------------|---------------------------------------------------|
 * | validate [--platform p] [--router path]                     | CI, pre-commit     | validate.validateMap → issues, exit 1 on error     |
 * | export [--force] [--check]                                  | dev, Stop hook, CI | store/export.exportMap                            |
 * | record --stdin                                              | PostToolUse hook   | ingest-socket.postToIngestSocket ‖ observe.recordHookPayload; ALWAYS exit 0 |
 * | summary [--max-tokens N] [--hook-json]                      | SessionStart hook  | format.formatSessionStartContext; `--hook-json` wraps in `SessionStartHookOutput` |
 * | import-router <json> [--no-retire] [--strict] [--purge-retired] [--dry-run] | CI | router-import.importRouter (+ export unless dry-run) |
 * | compile --session S --task T --name R [--param name:type[=value]…] [--to-seq N] | dev | compile.compileRecipe (`=value` fills `values`) → prints YAML |
 * | run R --params k=v… [--headless] [--params-file f] | run --all --status s,… --headless [--params-file f] [--report path] | dev, CI | guided (prints first step) or headless (report JSON) |
 * | maestro-export [R | --all] [--status s,…] [--params-file f] --out DIR | CI      | maestro.maestroExport; exit 1 (`bad_input`) when a required param has no value |
 * | drift [--build B] [--platform p] [--router path] [--out path] | CI               | drift.driftTour; `--build` defaults to the router export's build, else `APP_MAP_BUILD`/manifest; exit 1 when `summary.blocking` |
 * | report [--since ISO|30d] [--json]                            | dev                | report.report                                     |
 * | gen-configs [--check]                                       | CI, dev            | gen-configs.genConfigs                            |
 * | lint-ids [--platform ios,android] [--src dir…]              | CI                 | lint-ids.lintIds                                  |
 * | policy-check                                                | CI                 | policy-check.policyCheck                          |
 * | intent-critical-diff <base-ref> [--markdown]                | CI (bot comment)   | policy-check.intentCriticalDiff; exit 1 when `downgraded` is non-empty (07 §7 two approvals) |
 * | mark R STATUS [--reviewer NAME] [--recipe-file path] [--force] | dev            | lifecycle.markRecipe (CLI twin of the tool)      |
 * | merge-driver %O %A %B [%P]                                  | git                | merge-driver.runMergeDriver                       |
 * | migrate-id OLD NEW [--dry-run]                              | dev                | migrate-id.migrateId                              |
 *
 * Global flags: `--dir`, `--platform`, `--build`, `--json` (machine output), `--quiet`. Env
 * (config.ts) supplies defaults. Exit codes: 0 ok · 1 command failed / findings · 2 usage.
 * Errors print `{error, hint, code}` as JSON on stderr (03 §11). Logging goes to stderr (never
 * stdout, which is the command's output) via `openContext(config, {logSink:'stderr'})`.
 *
 * Layer: top.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AppMapConfig, Platform } from './config.ts';
import { PLATFORMS, isPlatform, loadConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import { openContext } from './context.ts';
import { AppMapError, ERROR_CODES, toErrorJson } from './errors.ts';
import { cacheFile, PACKAGE_ROOT } from './paths.ts';
import type {
  HookPayload, RecipeParam, RecipeParams, RecipeStatus, RouterExport, SessionStartHookOutput,
} from './types.ts';
import { PARAM_TYPES, RECIPE_STATUSES } from './types.ts';
import { formatIssues, validateMap } from './validate.ts';
import { exportMap } from './store/export.ts';
import { formatRunStep, formatSessionStartContext } from './format.ts';
import { recordHookPayload } from './observe.ts';
import { parseRequestLine, postToIngestSocket } from './ingest-socket.ts';
import { importRouter } from './router-import.ts';
import { compileRecipe } from './recipes/compile.ts';
import { markRecipe } from './recipes/lifecycle.ts';
import { maestroExport } from './recipes/maestro.ts';
import { runAllHeadless, runHeadless } from './recipes/headless.ts';
import { startGuidedRun } from './recipes/guided.ts';
import { driftTour, formatDriftTable } from './drift.ts';
import { formatReport, report as buildReport } from './report.ts';
import { genConfigs } from './gen-configs.ts';
import { DEFAULT_ANDROID_DIRS, DEFAULT_IOS_DIRS, lintIds } from './lint-ids.ts';
import { intentCriticalDiff, policyCheck } from './policy-check.ts';
import { runMergeDriver } from './merge-driver.ts';
import { migrateId } from './migrate-id.ts';
import { readAllowlist } from './yaml/load.ts';

export interface CliIo {
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const COMMANDS = [
  'validate', 'export', 'record', 'summary', 'import-router', 'compile', 'run', 'maestro-export', 'drift', 'report',
  'gen-configs', 'lint-ids', 'policy-check', 'intent-critical-diff', 'mark', 'merge-driver', 'migrate-id', 'help',
] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command: Command;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** flags that never take a value (everything else consumes the next token) */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  'force', 'check', 'json', 'quiet', 'stdin', 'headless', 'all', 'dry-run', 'no-retire', 'strict',
  'purge-retired', 'hook-json', 'markdown', 'help', 'guided',
]);
/** flags that collect every following non-flag token (`--params a=1 b=2`, `--param x:string --param y:money`) */
const LIST_FLAGS: ReadonlySet<string> = new Set(['param', 'params', 'src', 'instrumented']);

/** A usage error (exit 2) as opposed to a command failure (exit 1) — 03 §10. */
class UsageError extends AppMapError {
  constructor(message: string, hint = 'run `app-map help` for the command list') {
    super(ERROR_CODES.BAD_INPUT, message, hint);
    this.name = 'UsageError';
  }
}

/**
 * Index of the command token in `argv`, skipping any leading flags with their values, so the
 * flags `help` calls global (`--dir`, `--platform`, …) work on either side of the command
 * (`app-map --platform android summary` used to be `unknown command: --platform`). `-1` when
 * argv holds no command token.
 */
function commandIndex(argv: readonly string[]): number {
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === '--') return -1;
    if (!token.startsWith('-')) return i;
    if (token.startsWith('--') && token.includes('=')) continue;
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (token === '-h' || BOOLEAN_FLAGS.has(name)) continue;
    if (LIST_FLAGS.has(name)) {
      while (i + 1 < argv.length && !argv[i + 1]!.startsWith('--')) i++;
      continue;
    }
    i++; // `--k v`: the value is not the command
  }
  return -1;
}

/** Pure: argv → command + positionals + flags (`--k v`, `--k=v`, repeated `--params k=v`). Throws `bad_input` on unknown command. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const first = argv[0];
  if (first === undefined || first === '--help' || first === '-h' || first === 'help') {
    return { command: 'help', positional: [], flags: {} };
  }
  const at = commandIndex(argv);
  const commandToken = at < 0 ? undefined : argv[at]!;
  if (commandToken === undefined) {
    throw new UsageError('no command given', `known commands: ${COMMANDS.join(', ')}`);
  }
  if (commandToken === 'help') return { command: 'help', positional: [], flags: {} };
  if (!(COMMANDS as readonly string[]).includes(commandToken)) {
    throw new UsageError(`unknown command: ${commandToken}`, `known commands: ${COMMANDS.join(', ')}`);
  }
  const command = commandToken as Command;
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  const rest = [...argv.slice(0, at), ...argv.slice(at + 1)];
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token === '--') {
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const name = (eq < 0 ? token.slice(2) : token.slice(2, eq)).trim();
    if (name.length === 0) throw new UsageError(`malformed flag: ${token}`);
    const inlineValue = eq < 0 ? undefined : token.slice(eq + 1);
    if (inlineValue !== undefined) {
      if (LIST_FLAGS.has(name)) flags[name] = [...asList(flags[name]), inlineValue];
      else flags[name] = inlineValue;
      continue;
    }
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
      continue;
    }
    if (LIST_FLAGS.has(name)) {
      const values = asList(flags[name]);
      while (i + 1 < rest.length && !rest[i + 1]!.startsWith('--')) values.push(rest[++i]!);
      if (values.length === 0) throw new UsageError(`--${name} needs at least one value`);
      flags[name] = values;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    flags[name] = rest[++i]!;
  }
  return { command, positional, flags };
}

function asList(v: string | boolean | string[] | undefined): string[] {
  if (Array.isArray(v)) return [...v];
  return typeof v === 'string' ? [v] : [];
}

/** Run one command; returns the process exit code. Never throws. */
export async function main(argv: readonly string[], io: Partial<CliIo> = {}): Promise<number> {
  const out: CliIo = {
    stdin: io.stdin ?? readAllStdin,
    stdout: io.stdout ?? ((t) => { process.stdout.write(t); }),
    stderr: io.stderr ?? ((t) => { process.stderr.write(t); }),
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
  };
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    out.stderr(`${JSON.stringify(toErrorJson(e))}\n${USAGE}`);
    return 2;
  }
  if (args.command === 'help' || args.flags.help === true) {
    out.stdout(USAGE);
    return 0;
  }
  // `record` must never fail the hook (05 §3: exit 0 always, even on failure).
  if (args.command === 'record') return cmdRecord(args, out);
  try {
    return await dispatch(args, out);
  } catch (e) {
    out.stderr(`${JSON.stringify(toErrorJson(e))}\n`);
    return e instanceof UsageError ? 2 : 1;
  }
}

async function dispatch(args: ParsedArgs, io: CliIo): Promise<number> {
  switch (args.command) {
    case 'validate': return cmdValidate(args, io);
    case 'export': return cmdExport(args, io);
    case 'summary': return cmdSummary(args, io);
    case 'import-router': return cmdImportRouter(args, io);
    case 'compile': return cmdCompile(args, io);
    case 'run': return cmdRun(args, io);
    case 'maestro-export': return cmdMaestroExport(args, io);
    case 'drift': return cmdDrift(args, io);
    case 'report': return cmdReport(args, io);
    case 'gen-configs': return cmdGenConfigs(args, io);
    case 'lint-ids': return cmdLintIds(args, io);
    case 'policy-check': return cmdPolicyCheck(args, io);
    case 'intent-critical-diff': return cmdIntentCriticalDiff(args, io);
    case 'mark': return cmdMark(args, io);
    case 'merge-driver': return cmdMergeDriver(args, io);
    case 'migrate-id': return cmdMigrateId(args, io);
    default: throw new UsageError(`unhandled command: ${args.command}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------------------------

/** env + global flags (`--dir`, `--platform`, `--build`) → config (03 §3). */
function configFor(args: ParsedArgs, io: CliIo): AppMapConfig {
  const env: NodeJS.ProcessEnv = { ...io.env };
  const dir = str(args, 'dir');
  if (dir !== undefined) env.APP_MAP_DIR = dir;
  const platform = str(args, 'platform');
  if (platform !== undefined) {
    if (!isPlatform(platform)) throw new UsageError(`--platform ${platform} is not one of ${PLATFORMS.join('|')}`);
    env.APP_MAP_PLATFORM = platform;
  }
  const build = str(args, 'build');
  if (build !== undefined) env.APP_MAP_BUILD = build;
  return loadConfig(env, io.cwd);
}

/** CLI contexts log to stderr — stdout is the command's output (03 §11). */
function withContext<T>(config: AppMapConfig, opts: { readOnly?: boolean; skipRetention?: boolean }, fn: (ctx: AppMapContext) => T): T {
  // `readOnly` never creates the cache, so fall back when a fresh clone has none yet.
  const readOnly = opts.readOnly === true && existsSync(cacheFile(config));
  const ctx = openContext(config, {
    logSink: 'stderr',
    ...(readOnly ? { readOnly: true } : {}),
    ...(opts.skipRetention === true ? { skipRetention: true } : {}),
  });
  try {
    return fn(ctx);
  } finally {
    ctx.close();
  }
}

async function withContextAsync<T>(config: AppMapConfig, opts: { readOnly?: boolean }, fn: (ctx: AppMapContext) => Promise<T>): Promise<T> {
  const readOnly = opts.readOnly === true && existsSync(cacheFile(config));
  const ctx = openContext(config, { logSink: 'stderr', ...(readOnly ? { readOnly: true } : {}) });
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags[name];
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.join(',');
  throw new UsageError(`--${name} needs a value`);
}

function bool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

function int(args: ParsedArgs, name: string): number | undefined {
  const raw = str(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new UsageError(`--${name} must be an integer (got ${raw})`);
  return n;
}

function list(args: ParsedArgs, name: string): string[] {
  const v = args.flags[name];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v.flatMap((x) => x.split(',')).map((x) => x.trim()).filter((x) => x.length > 0);
  if (typeof v === 'string') return v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
  throw new UsageError(`--${name} needs a value`);
}

function statuses(args: ParsedArgs): RecipeStatus[] {
  return list(args, 'status').map((s) => {
    if (!(RECIPE_STATUSES as readonly string[]).includes(s)) throw new UsageError(`--status ${s} is not one of ${RECIPE_STATUSES.join('|')}`);
    return s as RecipeStatus;
  });
}

function platformsFlag(args: ParsedArgs): Platform[] | undefined {
  const values = list(args, 'platform');
  if (values.length === 0) return undefined;
  return values.map((p) => {
    if (!isPlatform(p)) throw new UsageError(`--platform ${p} is not one of ${PLATFORMS.join('|')}`);
    return p;
  });
}

function absPath(io: CliIo, p: string): string {
  return isAbsolute(p) ? p : resolve(io.cwd, p);
}

/** nearest ancestor of `cwd` holding `.mcp.json` or `.git`; falls back to the package's repo root */
function repoRootFor(io: CliIo): string {
  let dir = resolve(io.cwd);
  for (;;) {
    if (existsSync(join(dir, '.mcp.json')) || existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(PACKAGE_ROOT, '..', '..');
}

function emit(io: CliIo, args: ParsedArgs, json: unknown, text: string): void {
  if (bool(args, 'json')) io.stdout(`${JSON.stringify(json, null, 2)}\n`);
  else if (!bool(args, 'quiet')) io.stdout(text.endsWith('\n') ? text : `${text}\n`);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function readJsonFile<T>(path: string): T {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `cannot read ${path}: ${(e as Error).message}`, 'check the path');
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${path} is not valid JSON: ${(e as Error).message}`, 'the file must be a single JSON document');
  }
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function cmdValidate(args: ParsedArgs, io: CliIo): number {
  const config = configFor(args, io);
  const platforms = platformsFlag(args);
  // 02 §11: `--router <path>` brings the fifth schema (router-export) under `validate`; the file
  // is a build artifact outside the map, so it has to be named explicitly.
  const router = str(args, 'router');
  const routerExports = router === undefined ? [] : [absPath(io, router)];
  const result = validateMap(config, {
    ...(platforms !== undefined ? { platforms } : {}),
    ...(routerExports.length > 0 ? { routerExports } : {}),
  });
  emit(io, args, result, `${formatIssues(result.issues)}\n${result.ok ? 'ok' : 'FAILED'} — ${result.files_checked} file(s) checked`);
  return result.ok ? 0 : 1;
}

function cmdExport(args: ParsedArgs, io: CliIo): number {
  const config = configFor(args, io);
  return withContext(config, {}, (ctx) => {
    const result = exportMap(ctx, { force: bool(args, 'force'), check: bool(args, 'check') });
    if (bool(args, 'check')) {
      emit(io, args, result, result.non_canonical.length === 0 ? 'ok — every file is canonical' : `non-canonical:\n${result.non_canonical.map((p) => `  ${p}`).join('\n')}`);
      return result.non_canonical.length === 0 ? 0 : 1;
    }
    if (result.conflicts.length > 0) {
      // 03 §4: the stop hook relays this to stderr; the diff names what changed underneath us.
      io.stderr(`${result.conflicts.map((c) => `conflict: ${c.path}\n${c.diff}`).join('\n')}\n`);
      return 1;
    }
    // issue #13 criterion 4: a file whose STEPS were rebuilt by an automated recompile (04 §8)
    // is not the same event as a canonicalisation, so say so — on stderr, beside the conflict
    // diffs, because stdout is the harness contract below and must stay a bare path list.
    const machine = result.written_from.filter((w) => w.machine_recompile);
    if (machine.length > 0) {
      io.stderr(`${machine.map((w) => `machine recompile: ${w.path} (${w.reason}) — these steps were rebuilt from a replay trajectory, not authored; the file says so as provenance.machine_recompile: true. Review the diff before merging (04 §8)`).join('\n')}\n`);
    }
    // harness contract: written paths, one per line, on stdout (deletions marked, 02 §8)
    if (bool(args, 'json')) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const p of result.written) io.stdout(`${p}\n`);
      for (const p of result.deleted) io.stdout(`deleted ${p}\n`);
    }
    return 0;
  });
}

/** 05 §3: ingest one hook payload. ALWAYS exits 0 — never block the agent. */
async function cmdRecord(args: ParsedArgs, io: CliIo): Promise<number> {
  try {
    if (!bool(args, 'stdin')) throw new UsageError('record needs --stdin');
    const text = await io.stdin();
    const payload = parseHookPayload(text);
    if (payload === undefined) return 0;
    const config = configFor(args, io);
    // 03 §2: prefer the running server's ingest socket, fall back to a direct SQLite write.
    try {
      const viaSocket = await postToIngestSocket(config, payload);
      if (viaSocket !== null && viaSocket !== undefined) return 0;
    } catch {
      // socket unavailable / not implemented → fall through to the direct path
    }
    // 07 §2.4 puts the retention sweep on SERVER START; this is the ≤50 ms per-driver-call hook
    // path (05 §3), and the sweep is O(events.jsonl). context.ts documents `skipRetention` for
    // exactly this case.
    withContext(config, { skipRetention: true }, (ctx) => recordHookPayload(ctx, payload));
  } catch (e) {
    io.stderr(`${JSON.stringify(toErrorJson(e))}\n`);
  }
  return 0;
}

/**
 * stdin → one hook payload. The hook script flattens the payload to a single line (05 §3), but a
 * human piping a file in gets a pretty-printed document, so try the whole text first and fall back
 * to the first non-empty line (JSONL). Returns undefined for empty input; throws on garbage.
 */
function parseHookPayload(text: string): HookPayload | undefined {
  const whole = text.trim();
  if (whole.length === 0) return undefined;
  try {
    return JSON.parse(whole) as HookPayload;
  } catch {
    const line = text.split('\n').find((l) => l.trim().length > 0);
    if (line === undefined) return undefined;
    // the ingest socket is the same logical entry point for the same bytes, so it must give the
    // same structured answer (03 §11) — `parseRequestLine` owns that wording
    const parsed = parseRequestLine(line);
    if ('error' in parsed) throw new AppMapError(parsed.error.code, parsed.error.error, parsed.error.hint);
    return parsed.payload;
  }
}

function cmdSummary(args: ParsedArgs, io: CliIo): number {
  const config = configFor(args, io);
  const maxTokens = int(args, 'max-tokens') ?? config.maxContextTokens;
  return withContext(config, { readOnly: true }, (ctx) => {
    const text = formatSessionStartContext(ctx.map, maxTokens);
    if (bool(args, 'hook-json')) {
      const payload: SessionStartHookOutput = { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
      io.stdout(`${JSON.stringify(payload)}\n`);
    } else {
      // harness contract: plain text on stdout; the hook JSON-escapes it itself
      io.stdout(`${text}\n`);
    }
    return 0;
  });
}

function cmdImportRouter(args: ParsedArgs, io: CliIo): number {
  const file = args.positional[0];
  if (file === undefined) throw new UsageError('import-router needs a router export path');
  const doc = readJsonFile<RouterExport>(absPath(io, file));
  const config = configFor(args, io);
  const dryRun = bool(args, 'dry-run');
  return withContext(config, {}, (ctx) => {
    const result = importRouter(ctx, doc, {
      retire: !bool(args, 'no-retire'),
      strict: bool(args, 'strict'),
      purgeRetired: bool(args, 'purge-retired'),
      dryRun,
    });
    const exported = dryRun ? undefined : exportMap(ctx, {});
    const text = [
      `created ${result.created.length}: ${result.created.join(', ') || '-'}`,
      `updated ${result.updated.length}: ${result.updated.join(', ') || '-'}`,
      `retired ${result.retired.length}: ${result.retired.join(', ') || '-'}`,
      `unregistered ${result.unregistered.length}: ${result.unregistered.join(', ') || '-'}`,
      `purged ${result.purged.length}: ${result.purged.join(', ') || '-'}`,
      `purged_recipes ${result.purged_recipes.length}: ${result.purged_recipes.join(', ') || '-'}`,
      `edges_added ${result.edges_added}`,
      ...(exported === undefined ? ['(dry run — nothing written)'] : [
        ...exported.written.map((p) => `wrote ${p}`),
        ...exported.deleted.map((p) => `deleted ${p}`),
      ]),
    ].join('\n');
    emit(io, args, { ...result, written: exported?.written ?? [], deleted: exported?.deleted ?? [] }, text);
    return 0;
  });
}

function cmdCompile(args: ParsedArgs, io: CliIo): number {
  const session = str(args, 'session');
  const task = str(args, 'task');
  const name = str(args, 'name');
  if (session === undefined || task === undefined || name === undefined) {
    throw new UsageError('compile needs --session, --task and --name');
  }
  const { params, values } = parseParamSpecs(list(args, 'param'));
  const toSeq = int(args, 'to-seq');
  const config = configFor(args, io);
  return withContext(config, {}, (ctx) => {
    const result = compileRecipe(ctx, {
      session, task, recipe_id: name, params,
      ...(Object.keys(values).length > 0 ? { values } : {}),
      ...(toSeq !== undefined ? { to_seq: toSeq } : {}),
    });
    if (!result.ok) {
      emit(io, args, result, `compile failed: ${result.reason} — ${result.message}`);
      return 1;
    }
    // a dropped driver call must be visible without `--json` too: stdout is the draft YAML
    // (03 §11), so the warnings — "the `type` step is gone" above all — go to stderr (issue #9)
    for (const w of result.warnings) io.stderr(`warning: ${w}\n`);
    emit(io, args, result, result.yaml);
    return 0;
  });
}

/** `--param name:type[=value]` → the recipe's `params[]` plus `values` (04 §3.4). */
function parseParamSpecs(specs: readonly string[]): { params: RecipeParam[]; values: Record<string, string | number> } {
  const params: RecipeParam[] = [];
  const values: Record<string, string | number> = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    const head = eq < 0 ? spec : spec.slice(0, eq);
    const colon = head.indexOf(':');
    if (colon < 0) throw new UsageError(`--param ${spec} must be name:type[=value] (types: ${PARAM_TYPES.join('|')})`);
    const name = head.slice(0, colon).trim();
    const type = head.slice(colon + 1).trim();
    if (name.length === 0 || !(PARAM_TYPES as readonly string[]).includes(type)) {
      throw new UsageError(`--param ${spec} must be name:type[=value] (types: ${PARAM_TYPES.join('|')})`);
    }
    params.push({ name, type: type as RecipeParam['type'], required: true });
    if (eq >= 0) {
      const raw = spec.slice(eq + 1);
      values[name] = type === 'number' || type === 'money' ? Number(raw) : raw;
    }
  }
  return { params, values };
}

/** `k=v` pairs → `RecipeParams` (numbers stay numbers so money/number params compare equal). */
function parseKeyValues(pairs: readonly string[]): RecipeParams {
  const out: RecipeParams = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw new UsageError(`--params ${pair} must be key=value`);
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    if (raw === 'true' || raw === 'false') out[key] = raw === 'true';
    else if (raw.trim().length > 0 && Number.isFinite(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

async function cmdRun(args: ParsedArgs, io: CliIo): Promise<number> {
  const config = configFor(args, io);
  const paramsFile = str(args, 'params-file');
  const headless = bool(args, 'headless');
  if (bool(args, 'all')) {
    if (!headless) throw new UsageError('run --all requires --headless (06 R5)');
    const wanted = statuses(args);
    if (wanted.length === 0) throw new UsageError('run --all needs --status (e.g. --status verified,ci_gate)');
    return withContextAsync(config, {}, async (ctx) => {
      const healReport = await runAllHeadless(ctx, { statuses: wanted, ...(paramsFile !== undefined ? { paramsFile: absPath(io, paramsFile) } : {}) });
      const reportPath = str(args, 'report');
      if (reportPath !== undefined) {
        // 06 R6 / harness-notes §4: the nightly job reads this file (heal-report.schema.json)
        const abs = absPath(io, reportPath);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, `${JSON.stringify(healReport, null, 2)}\n`, 'utf8');
        emit(io, args, healReport, abs);
      } else {
        emit(io, args, healReport, JSON.stringify(healReport, null, 2));
      }
      return healReport.runs.every((r) => r.ok) ? 0 : 1;
    });
  }
  const recipeId = args.positional[0];
  if (recipeId === undefined) throw new UsageError('run needs a recipe id (or --all --status …)');
  const params = parseKeyValues(list(args, 'params'));
  return withContextAsync(config, {}, async (ctx) => {
    if (headless) {
      const result = await runHeadless(ctx, { recipe_id: recipeId, params, ...(paramsFile !== undefined ? { paramsFile: absPath(io, paramsFile) } : {}) });
      emit(io, args, result, JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    const result = await startGuidedRun(ctx, { recipe_id: recipeId, params });
    emit(io, args, result, `run ${result.run_id} (${result.recipe} v${result.version})\n${formatRunStep(result.step)}`);
    return 0;
  });
}

function cmdMaestroExport(args: ParsedArgs, io: CliIo): number {
  const outDir = str(args, 'out');
  const config = configFor(args, io);
  const wanted = statuses(args);
  const recipes = args.positional;
  return withContext(config, {}, (ctx) => {
    const result = maestroExport(ctx, {
      ...(recipes.length > 0 ? { recipes } : {}),
      ...(bool(args, 'all') ? { all: true } : {}),
      ...(wanted.length > 0 ? { statuses: wanted } : {}),
      ...(outDir !== undefined ? { outDir: absPath(io, outDir) } : {}),
      ...(str(args, 'params-file') !== undefined ? { paramsFile: absPath(io, str(args, 'params-file')!) } : {}),
    });
    emit(io, args, result, result.flows.map((f) => `${f.recipe}: ${f.eligible ? f.path : `SKIPPED (ineligible steps ${f.ineligible_steps.join(',')})`}`).join('\n') || '(no recipes matched)');
    return result.flows.every((f) => f.eligible) ? 0 : 1;
  });
}

async function cmdDrift(args: ParsedArgs, io: CliIo): Promise<number> {
  const config = configFor(args, io);
  const routerPath = str(args, 'router');
  const router = routerPath !== undefined ? readJsonFile<RouterExport>(absPath(io, routerPath)) : undefined;
  const build = str(args, 'build');
  const outPath = str(args, 'out');
  return withContextAsync(config, {}, async (ctx) => {
    const result = await driftTour(ctx, {
      ...(build !== undefined ? { build } : {}),
      ...(router !== undefined ? { router } : {}),
      ...(outPath !== undefined ? { outPath: absPath(io, outPath) } : {}),
    });
    emit(io, args, result, formatDriftTable(result));
    // 06 R4.5 / 06 §4: a ci_gate-referenced screen that is broken blocks the PR.
    return result.summary.blocking ? 1 : 0;
  });
}

function cmdReport(args: ParsedArgs, io: CliIo): number {
  const config = configFor(args, io);
  const since = str(args, 'since');
  const artifactsDir = str(args, 'artifacts-dir');
  return withContext(config, { readOnly: true }, (ctx) => {
    const metrics = buildReport(ctx, {
      ...(since !== undefined ? { since } : {}),
      // 08 §8: the CI artifacts. `--artifacts-dir` names where they were downloaded to; the repo
      // root is where the shipped workflow writes them.
      ...(artifactsDir !== undefined ? { artifactsDir: absPath(io, artifactsDir) } : {}),
      repoRoot: repoRootFor(io),
    });
    emit(io, args, metrics, formatReport(metrics));
    return 0;
  });
}

function cmdGenConfigs(args: ParsedArgs, io: CliIo): number {
  const repoRoot = repoRootFor(io);
  const result = genConfigs(repoRoot, { check: bool(args, 'check') });
  const text = bool(args, 'check')
    ? (result.ok ? 'ok — generated harness configs match .mcp.json' : `stale (run \`app-map gen-configs\`):\n${result.stale.map((p) => `  ${p}`).join('\n')}`)
    : (result.written.length === 0 ? 'ok — nothing to write' : result.written.map((p) => `wrote ${p}`).join('\n'));
  emit(io, args, result, text);
  return result.ok ? 0 : 1;
}

function cmdLintIds(args: ParsedArgs, io: CliIo): number {
  const config = configFor(args, io);
  const repoRoot = repoRootFor(io);
  const platforms = platformsFlag(args);
  const src = list(args, 'src').map((d) => absPath(io, d));
  // 01 R8: platforms whose app source is in THIS repo — a missing marker there is an error, not
  // an "not instrumented yet" warning.
  const instrumented = [
    ...list(args, 'instrumented'),
    ...(io.env.APP_MAP_INSTRUMENTED_PLATFORMS ?? '').split(','),
  ].map((p) => p.trim()).filter((p): p is Platform => isPlatform(p));
  const result = lintIds(config, {
    repoRoot,
    ...(platforms !== undefined ? { platforms } : {}),
    ...(instrumented.length > 0 ? { instrumentedPlatforms: [...new Set(instrumented)] } : {}),
    // `--src dir…` extends the defaults for both platforms; the extension filter separates them
    ...(src.length > 0 ? { iosDirs: [...DEFAULT_IOS_DIRS, ...src], androidDirs: [...DEFAULT_ANDROID_DIRS, ...src] } : {}),
  });
  const text = result.issues.length === 0
    ? 'ok — every id is registered and referenced (01 R8)'
    : result.issues.map((i) => `${i.severity}: ${i.rule}${i.platform !== undefined ? ` [${i.platform}]` : ''} ${i.file !== undefined ? `${i.file}${i.line !== undefined ? `:${i.line}` : ''} ` : ''}— ${i.message}`).join('\n');
  emit(io, args, result, text);
  return result.ok ? 0 : 1;
}

function cmdPolicyCheck(args: ParsedArgs, io: CliIo): number {
  // 03 §10: a security command must never report on a repo it did not read. An explicit
  // positional names the root to check; without one it is the repo the cwd belongs to.
  const repoRoot = args.positional[0] !== undefined ? absPath(io, args.positional[0]) : repoRootFor(io);
  if (args.positional.length > 1) throw new UsageError('policy-check takes at most one repo root');
  const config = configFor(args, io);
  // an explicit `--dir` (tests, a map outside the repo) also chooses the allowlist to check against
  const result = policyCheck(repoRoot, str(args, 'dir') !== undefined ? { allowlist: readAllowlist(config) } : {});
  const text = result.ok
    ? 'ok — every MCP server is on the allowlist, pinned, secret-free and hooks stay in .claude/hooks/'
    : result.violations.map((v) => `${v.rule}: ${v.file} — ${v.message}`).join('\n');
  emit(io, args, result, text);
  return result.ok ? 0 : 1;
}

function cmdIntentCriticalDiff(args: ParsedArgs, io: CliIo): number {
  const baseRef = args.positional[0];
  if (baseRef === undefined) throw new UsageError('intent-critical-diff needs a base ref');
  const repoRoot = repoRootFor(io);
  const result = intentCriticalDiff(repoRoot, baseRef);
  // markdown is the default (the bot comment); `--markdown` is explicit, `--json` machine output
  if (bool(args, 'json')) io.stdout(`${JSON.stringify(result, null, 2)}\n`);
  else if (!bool(args, 'quiet')) io.stdout(`${result.markdown}\n`);
  // 07 §7: a downgrade needs two approvals — fail so the workflow demands the second.
  return result.downgraded.length > 0 ? 1 : 0;
}

function cmdMark(args: ParsedArgs, io: CliIo): number {
  const recipeId = args.positional[0];
  const status = args.positional[1];
  if (recipeId === undefined || status === undefined) throw new UsageError('mark needs a recipe id and a status');
  if (!(RECIPE_STATUSES as readonly string[]).includes(status)) throw new UsageError(`status ${status} is not one of ${RECIPE_STATUSES.join('|')}`);
  const recipeFile = str(args, 'recipe-file');
  const reviewer = str(args, 'reviewer');
  const config = configFor(args, io);
  return withContext(config, {}, (ctx) => {
    const result = markRecipe(ctx, {
      recipe_id: recipeId,
      status: status as RecipeStatus,
      ...(recipeFile !== undefined ? { recipe: readFileSync(absPath(io, recipeFile), 'utf8') } : {}),
      ...(reviewer !== undefined ? { reviewer } : {}),
      ...(bool(args, 'force') ? { force: true } : {}),
    });
    emit(io, args, result, `${result.recipe_id}: ${result.from ?? '(new)'} → ${result.to}${result.written ? ' (written)' : ''}`);
    return 0;
  });
}

function cmdMergeDriver(args: ParsedArgs, io: CliIo): number {
  const [base, ours, theirs, real] = args.positional;
  if (base === undefined || ours === undefined || theirs === undefined) {
    throw new UsageError('merge-driver needs %O %A %B [%P]');
  }
  return runMergeDriver(absPath(io, base), absPath(io, ours), absPath(io, theirs), real !== undefined ? { realPath: real } : {});
}

function cmdMigrateId(args: ParsedArgs, io: CliIo): number {
  const [oldId, newId] = args.positional;
  if (oldId === undefined || newId === undefined) throw new UsageError('migrate-id needs OLD and NEW');
  const config = configFor(args, io);
  const result = migrateId(config, oldId, newId, bool(args, 'dry-run') ? { dryRun: true } : {});
  emit(io, args, result, `${result.old_id} → ${result.new_id}: ${result.references} reference(s) in ${result.files_changed.length} file(s)\n${result.files_changed.map((f) => `  ${f}`).join('\n')}`);
  return 0;
}

export const USAGE = `app-map <command> [options]

commands:
  validate [--router path]       02 §10 rules (+ router-export.schema.json); exit 1 on any error
  export [--force] [--check]     cache → canonical YAML (03 §4)
  record --stdin                 ingest one hook payload (05 §3); always exits 0
  summary [--max-tokens N] [--hook-json]
  import-router <json> [--no-retire] [--strict] [--purge-retired] [--dry-run]
  compile --session S --task T --name R [--param name:type[=value] ...] [--to-seq N]
  run R --params k=v ... [--headless] [--params-file f] | run --all --status s,... --headless [--params-file f] [--report path]
  maestro-export [R | --all] [--status s,...] [--params-file f] --out DIR
  drift [--build B] [--router path] [--out path]
  report [--since ISO|30d] [--artifacts-dir DIR] [--json]
  gen-configs [--check]
  lint-ids [--platform ios,android] [--src dir ...] [--instrumented ios,android]
  policy-check [REPO_ROOT]
  intent-critical-diff <base-ref> [--markdown]
  mark R STATUS [--reviewer NAME] [--recipe-file path] [--force]
  merge-driver %O %A %B [%P]
  migrate-id OLD NEW [--dry-run]
global (before or after the command): --dir, --platform, --build, --json, --quiet
env: APP_MAP_INSTRUMENTED_PLATFORMS (lint-ids: platforms whose app source is in this repo)
`;

if (process.argv[1] && /(^|[/\\])cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: String(e), hint: '', code: 'internal' })}\n`);
    process.exit(1);
  });
}
