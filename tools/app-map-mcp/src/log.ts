/**
 * [A2] Structured JSON logging (03 §11): one JSON object per line to `.local/server.log`,
 * rotated at 20 MB (rename to `server.log.1`, keep one generation); NEVER stdout (stdout is
 * the MCP transport — docs/dev/toolchain.md). The CLI logs to stderr instead of the file.
 *
 * Privacy: no tree content at `info` or above (03 §11). `debug` may log node counts, ids and
 * roles but never labels/values. Fields named `snapshot`, `tree`, `label`, `value` are dropped
 * by `sanitizeFields` before serialization at every level.
 *
 * Line shape: `{"ts":"…","level":"info","msg":"…","pid":123,"platform":"ios",…fields}`.
 *
 * Layer: leaf-ish (imports config/paths only).
 */
import type { AppMapConfig, LogLevel } from './config.ts';
import { NotImplementedError } from './errors.ts';

export const LOG_ROTATE_BYTES = 20 * 1024 * 1024;

export type LogFields = Record<string, unknown>;

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** logger that merges `fields` into every line (e.g. `{session, run_id}`) */
  child(fields: LogFields): Logger;
  /** flush and release the file handle; idempotent */
  close(): void;
}

export interface LoggerOptions {
  /** `file` (default for the server) | `stderr` (CLI) | `both` | `none` (tests) */
  sink?: 'file' | 'stderr' | 'both' | 'none';
  /** override `paths.serverLog(config)` */
  file?: string;
  /** static fields on every line */
  fields?: LogFields;
}

/** Create the process logger; creates `.local/` if missing; rotates on open and on every write past the limit. */
export function createLogger(config: AppMapConfig, opts: LoggerOptions = {}): Logger {
  void config; void opts;
  throw new NotImplementedError('log.createLogger');
}

/** A logger that records lines in memory (`lines`) — for tests. */
export function createMemoryLogger(level: LogLevel = 'debug'): Logger & { lines: Array<Record<string, unknown>> } {
  void level;
  throw new NotImplementedError('log.createMemoryLogger');
}

/** Rotate `path` → `path.1` when it exceeds `LOG_ROTATE_BYTES`; returns true when rotated. */
export function rotateIfNeeded(path: string, limit: number = LOG_ROTATE_BYTES): boolean {
  void path; void limit;
  throw new NotImplementedError('log.rotateIfNeeded');
}

/** Drop tree-content fields (`snapshot`, `tree`, `root`, `label`, `value`, `text`, `children`) recursively; pure. */
export function sanitizeFields(fields: LogFields): LogFields {
  void fields;
  throw new NotImplementedError('log.sanitizeFields');
}
