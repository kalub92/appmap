/**
 * [D2] `bin/app-map` CLI (03 §10). Shares the library with the server; never talks to a
 * running server except `record`, which prefers the ingest socket (03 §2) and falls back to
 * direct SQLite writes.
 *
 * | command                                                     | used by            | body                                              |
 * |-------------------------------------------------------------|--------------------|---------------------------------------------------|
 * | validate [--platform p]                                     | CI, pre-commit     | validate.validateMap → issues, exit 1 on error     |
 * | export [--force] [--check]                                  | dev, Stop hook, CI | store/export.exportMap                            |
 * | record --stdin                                              | PostToolUse hook   | ingest-socket.postToIngestSocket ‖ observe.recordHookPayload; ALWAYS exit 0 |
 * | summary [--max-tokens N] [--hook-json]                      | SessionStart hook  | format.formatSessionStartContext; `--hook-json` wraps in `SessionStartHookOutput` |
 * | import-router <json> [--no-retire] [--dry-run]              | CI                 | router-import.importRouter (+ export unless dry-run) |
 * | compile --session S --task T --name R [--param name:type…]  | dev                | compile.compileRecipe → prints YAML                |
 * | run R --params k=v… [--headless] [--all --status s,…] [--report path] | dev, CI | guided (prints first step) or headless (report JSON) |
 * | maestro-export [R | --all] [--status s,…] --out DIR         | CI                 | maestro.maestroExport                             |
 * | drift --build B [--platform p] [--router path] [--out path] | CI                 | drift.driftTour; exit 1 when `summary.blocking`    |
 * | report [--since ISO|30d] [--json]                            | dev                | report.report                                     |
 * | gen-configs [--check]                                       | CI, dev            | gen-configs.genConfigs                            |
 * | lint-ids                                                    | CI                 | lint-ids.lintIds                                  |
 * | policy-check                                                | CI                 | policy-check.policyCheck                          |
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
import { NotImplementedError } from './errors.ts';

export interface CliIo {
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export const COMMANDS = [
  'validate', 'export', 'record', 'summary', 'import-router', 'compile', 'run', 'maestro-export', 'drift', 'report',
  'gen-configs', 'lint-ids', 'policy-check', 'merge-driver', 'migrate-id', 'help',
] as const;
export type Command = (typeof COMMANDS)[number];

export interface ParsedArgs {
  command: Command;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

/** Pure: argv → command + positionals + flags (`--k v`, `--k=v`, repeated `--params k=v`). Throws `bad_input` on unknown command. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  void argv;
  throw new NotImplementedError('cli.parseArgs');
}

/** Run one command; returns the process exit code. Never throws. */
export function main(argv: readonly string[], io?: Partial<CliIo>): Promise<number> {
  void argv; void io;
  throw new NotImplementedError('cli.main');
}

export const USAGE = `app-map <command> [options]

commands:
  validate                       02 §10 rules; exit 1 on any error
  export [--force] [--check]     cache → canonical YAML (03 §4)
  record --stdin                 ingest one hook payload (05 §3); always exits 0
  summary [--max-tokens N] [--hook-json]
  import-router <json>           seed/refresh screens from the router export (01 R6)
  compile --session S --task T --name R [--param name:type ...]
  run R --params k=v ... [--headless] | run --all --status s,... --headless [--report path]
  maestro-export [R | --all] [--status s,...] --out DIR
  drift --build B [--router path] [--out path]
  report [--since ISO|30d] [--json]
  gen-configs [--check]
  lint-ids
  policy-check
  merge-driver %O %A %B [%P]
  migrate-id OLD NEW [--dry-run]
global: --dir, --platform, --build, --json, --quiet
`;

if (process.argv[1] && /(^|[/\\])cli\.(ts|js)$/.test(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e: unknown) => {
    process.stderr.write(`${JSON.stringify({ error: String(e), hint: '', code: 'internal' })}\n`);
    process.exit(1);
  });
}
