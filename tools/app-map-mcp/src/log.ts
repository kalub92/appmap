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
import { closeSync, fstatSync, mkdirSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppMapConfig, LogLevel } from './config.ts';
import { LOG_LEVELS } from './config.ts';
import { serverLog } from './paths.ts';

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

/**
 * Keys that may carry tree content (labels, values, whole snapshots) and are therefore dropped
 * from every log line at every level (03 §11, 07 §2.2 "never in logs").
 */
const FORBIDDEN_FIELD_KEYS: ReadonlySet<string> = new Set(['snapshot', 'tree', 'root', 'label', 'value', 'text', 'children']);

/** `debug` < `info` < `warn` < `error` */
function levelRank(level: LogLevel): number {
  return LOG_LEVELS.indexOf(level);
}

/** A line is a write sink; the logger core is shared by file/stderr/memory sinks. */
type LineSink = (line: Record<string, unknown>) => void;

function buildLogger(level: LogLevel, statics: LogFields, sink: LineSink, close: () => void): Logger {
  const minRank = levelRank(level);
  const emit = (lvl: LogLevel, msg: string, fields?: LogFields): void => {
    if (levelRank(lvl) < minRank) return;
    try {
      const line: Record<string, unknown> = { ts: new Date().toISOString(), level: lvl, msg };
      Object.assign(line, sanitizeFields({ ...statics, ...(fields ?? {}) }));
      sink(line);
    } catch {
      // logging must never throw into the server (03 §11)
    }
  };
  return {
    level,
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    child: (fields) => buildLogger(level, { ...statics, ...fields }, sink, close),
    close,
  };
}

/** JSON.stringify that tolerates Errors, bigints and cycles (a log call must never throw). */
function serializeLine(line: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(line, (_k, v: unknown) => {
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Error) return { name: v.name, message: v.message, ...(('code' in v) ? { code: (v as { code?: unknown }).code } : {}) };
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
    }
    return v;
  });
}

/** Append-only file sink with 03 §11 rotation: rename to `.1` once the file passes `limit` bytes. */
class RotatingFile {
  private readonly path: string;
  private readonly limit: number;
  private fd: number | undefined;
  private size = 0;

  constructor(path: string, limit: number) {
    this.path = path;
    this.limit = limit;
    mkdirSync(dirname(path), { recursive: true });
    rotateIfNeeded(path, limit); // rotate on open
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.path, 'a');
    this.size = fstatSync(this.fd).size;
  }

  write(text: string): void {
    if (this.fd === undefined) return;
    const bytes = Buffer.from(text, 'utf8');
    writeSync(this.fd, bytes);
    this.size += bytes.length;
    // rotate on every write past the limit (03 §11: "rotated at 20 MB")
    if (this.size > this.limit) {
      closeSync(this.fd);
      this.fd = undefined;
      rotateIfNeeded(this.path, this.limit);
      this.open();
    }
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } finally {
      this.fd = undefined;
    }
  }
}

/** Create the process logger; creates `.local/` if missing; rotates on open and on every write past the limit. */
export function createLogger(config: AppMapConfig, opts: LoggerOptions = {}): Logger {
  const sink = opts.sink ?? 'file';
  const statics: LogFields = { pid: process.pid, platform: config.platform, ...(opts.fields ?? {}) };
  let file: RotatingFile | undefined;
  let toStderr = sink === 'stderr' || sink === 'both';
  if (sink === 'file' || sink === 'both') {
    const path = opts.file ?? serverLog(config);
    try {
      file = new RotatingFile(path, LOG_ROTATE_BYTES);
    } catch (e) {
      // an unwritable log file must not take the server down (03 §11); degrade to stderr
      toStderr = true;
      process.stderr.write(`${serializeLine({ ts: new Date().toISOString(), level: 'warn', msg: 'log file unavailable, logging to stderr', pid: process.pid, path, error: (e as Error).message })}\n`);
    }
  }
  const write: LineSink = (line) => {
    if (sink === 'none') return;
    const text = `${serializeLine(line)}\n`;
    if (file) file.write(text);
    if (toStderr) process.stderr.write(text); // never stdout: it is the MCP transport
  };
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    file?.close();
  };
  return buildLogger(config.logLevel, statics, write, close);
}

/** A logger that records lines in memory (`lines`) — for tests. */
export function createMemoryLogger(level: LogLevel = 'debug'): Logger & { lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  // round-trip through JSON so the recorded shape equals what a file sink would write
  const logger = buildLogger(level, { pid: process.pid }, (line) => lines.push(JSON.parse(serializeLine(line)) as Record<string, unknown>), () => undefined);
  return Object.assign(logger, { lines });
}

/** Rotate `path` → `path.1` when it exceeds `LOG_ROTATE_BYTES`; returns true when rotated. */
export function rotateIfNeeded(path: string, limit: number = LOG_ROTATE_BYTES): boolean {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return false; // nothing to rotate
  }
  if (size <= limit) return false;
  try {
    renameSync(path, `${path}.1`); // one generation kept; an older `.1` is overwritten
    return true;
  } catch {
    return false;
  }
}

/** Drop tree-content fields (`snapshot`, `tree`, `root`, `label`, `value`, `text`, `children`) recursively; pure. */
export function sanitizeFields(fields: LogFields): LogFields {
  return sanitizeValue(fields, new WeakSet()) as LogFields;
}

function sanitizeValue(v: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(v)) {
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    return v.map((x) => sanitizeValue(x, seen));
  }
  if (typeof v === 'object' && v !== null) {
    if (v instanceof Error || v instanceof Date) return v;
    if (seen.has(v)) return '[circular]';
    seen.add(v);
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (FORBIDDEN_FIELD_KEYS.has(k)) continue;
      out[k] = sanitizeValue(x, seen);
    }
    return out;
  }
  return v;
}
