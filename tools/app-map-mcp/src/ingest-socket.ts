/**
 * [D1] Local ingest socket (03 §2, 05 §3 `app-map-record.sh`): hooks post observations in
 * <50 ms without spawning a Node process per tool call.
 *
 * WIRE PROTOCOL (unix domain socket at `paths.ingestSocket(config)`, newline-delimited JSON):
 *  - the client connects, writes exactly ONE request line — the Claude Code hook stdin payload
 *    (`HookPayload`, schema `hook-payload`) serialized as compact JSON + `\n` — then half-closes
 *    (`socket.end()`);
 *  - the server answers with exactly ONE response line and closes:
 *      `{"ok":true,"screen_before":"invoice_list","screen_after":"invoice_new","seq":12,"gates_present":[],"scrub_hits":0}`
 *      (`RecordResult` with `ok: true`), or `{"ok":true,"ignored":true}` when the payload is
 *      not a driver call, or `{"ok":false,"error":"…","hint":"…","code":"…"}` (`ErrorJson`);
 *  - one request per connection; the server closes idle connections after
 *    `INGEST_TIMEOUT_MS`; request lines over `MAX_REQUEST_BYTES` are rejected with `bad_input`;
 *  - the socket file is created with mode 0600 and unlinked on close; a stale socket file
 *    (no listener) is removed at start; when another instance is already listening (EADDRINUSE
 *    with a live listener) this instance skips the socket — many servers share the cache,
 *    only one owns the socket (03 §2).
 * The hook script (`.claude/hooks/app-map-record.sh`) tries the socket first (e.g. `nc -U`
 * or `socat`) and falls back to `app-map record --stdin`, which calls the same
 * `observe.recordHookPayload` against SQLite directly.
 *
 * Layer: top (imports context + observe).
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { dirname, isAbsolute, relative } from 'node:path';
import type { AppMapConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { ErrorJson } from './errors.ts';
import { AppMapError, ERROR_CODES, toErrorJson } from './errors.ts';
import { ingestSocket } from './paths.ts';
import type { HookPayload, RecordResult } from './types.ts';
import { recordHookPayload } from './observe.ts';

export const INGEST_TIMEOUT_MS = 2000;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;
/** `sun_path` is 108 bytes on Linux/macOS (docs/dev/harness-notes.md §4); leave room for the NUL */
export const MAX_SOCKET_PATH_BYTES = 103;
/** socket file mode (03 §2: created 0600) */
const SOCKET_MODE = 0o600;

export type IngestResponse = ({ ok: true } & RecordResult) | { ok: true; ignored: true } | ({ ok: false } & ErrorJson);

export interface IngestServer {
  socketPath: string;
  /** false when another instance owns the socket */
  listening: boolean;
  close(): Promise<void>;
}

/**
 * `sun_path` is capped at 108 bytes, so a deep checkout must be bound through the shortest
 * spelling of the same file (harness-notes §4). A relative path resolves against `process.cwd()`
 * — the same absolute file the hook's `nc -U <absolute>` connects to.
 */
export function bindPath(absolute: string, cwd: string = process.cwd()): string {
  if (Buffer.byteLength(absolute) <= MAX_SOCKET_PATH_BYTES) return absolute;
  const rel = relative(cwd, absolute);
  if (rel !== '' && !isAbsolute(rel) && Buffer.byteLength(rel) <= MAX_SOCKET_PATH_BYTES) return rel;
  throw new AppMapError(
    ERROR_CODES.BAD_INPUT,
    `ingest socket path is ${Buffer.byteLength(absolute)} bytes; the OS limit is ${MAX_SOCKET_PATH_BYTES}`,
    'move the checkout closer to the filesystem root or point APP_MAP_DIR at a shorter path (03 §2)',
  );
}

/** Pure: parse one request line into a `HookPayload` or an error response. */
export function parseRequestLine(line: string): { payload: HookPayload } | { error: ErrorJson } {
  const bad = (message: string, hint: string): { error: ErrorJson } => ({
    error: { error: message, hint, code: ERROR_CODES.BAD_INPUT },
  });
  if (typeof line !== 'string' || line.trim() === '') {
    return bad('ingest: empty request line', 'write one JSON hook payload followed by a newline (03 §2)');
  }
  if (Buffer.byteLength(line) > MAX_REQUEST_BYTES) {
    return bad(
      `ingest: request line is ${Buffer.byteLength(line)} bytes, over the ${MAX_REQUEST_BYTES}-byte limit`,
      'the driver returned an oversized snapshot; ask it for a compact tree (05 §6.2)',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (e) {
    return bad(`ingest: request line is not JSON: ${(e as Error).message}`, 'the hook posts its stdin payload verbatim as one JSON line (05 §3)');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return bad('ingest: request line is not a JSON object', 'post the Claude Code hook payload (schema hook-payload)');
  }
  const raw = parsed as Record<string, unknown>;
  if (typeof raw.session_id !== 'string' || raw.session_id === '') {
    return bad('ingest: hook payload has no session_id', 'the PostToolUse hook passes `session_id` on stdin (05 §3)');
  }
  if (typeof raw.hook_event_name !== 'string' || raw.hook_event_name === '') {
    return bad('ingest: hook payload has no hook_event_name', 'e.g. "PostToolUse", "PostToolUseFailure" or "Stop" (05 §3)');
  }
  // harness-notes §4: the hooks reference names the failure `tool_error` and the SessionStart
  // trigger `matcher_value`, while `hook-payload.schema.json` names them `error`/`source` —
  // accept both, normalizing onto the schema's names.
  const payload = { ...raw } as HookPayload;
  if (payload.error === undefined && typeof raw.tool_error === 'string') payload.error = raw.tool_error;
  if (payload.source === undefined && typeof raw.matcher_value === 'string') {
    payload.source = raw.matcher_value as HookPayload['source'];
  }
  return { payload };
}

/** One request line → one response line (03 §2); never throws (03 §11). */
function handleLine(ctx: AppMapContext, line: string): IngestResponse {
  const parsed = parseRequestLine(line);
  if ('error' in parsed) return { ok: false, ...parsed.error };
  try {
    const result = recordHookPayload(ctx, parsed.payload);
    // not a driver call (or a Stop that only closed the task): nothing recorded (05 §3)
    if (result === null) return { ok: true, ignored: true };
    return { ok: true, ...result };
  } catch (e) {
    const json = toErrorJson(e);
    ctx.log.warn('ingest: payload rejected', { code: json.code, error: json.error, tool: parsed.payload.tool_name });
    return { ok: false, ...json };
  }
}

/** Is something actually listening on `path`? (03 §2 stale socket file vs a live second instance) */
function probeListener(path: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ path });
    let settled = false;
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy(); // never removeAllListeners: it strips Node's own cleanup handlers
      resolveProbe(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

export async function startIngestServer(ctx: AppMapContext, opts: { socketPath?: string } = {}): Promise<IngestServer> {
  const socketPath = opts.socketPath ?? ingestSocket(ctx.config);
  mkdirSync(dirname(socketPath), { recursive: true });

  // 03 §2: a stale socket file (no listener) is removed; a live listener means another instance
  // owns the socket — many servers share the cache, only one owns the socket.
  if (existsSync(socketPath)) {
    if (await probeListener(socketPath)) {
      ctx.log.info('ingest: another instance owns the socket', { socket: socketPath });
      return { socketPath, listening: false, close: async () => {} };
    }
    try {
      unlinkSync(socketPath);
      ctx.log.info('ingest: removed a stale socket file', { socket: socketPath });
    } catch (e) {
      ctx.log.warn('ingest: stale socket file could not be removed', { socket: socketPath, error: (e as Error).message });
    }
  }

  const server: Server = createServer({ allowHalfOpen: true });
  /** open connections, so `close()` never waits on a half-open client (03 §2: removed on exit) */
  const open = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    open.add(socket);
    socket.once('close', () => open.delete(socket));
    // one request per connection, closed as soon as the answer is written so `nc -U` exits
    // immediately (harness-notes §4)
    let buffer = '';
    let answered = false;
    socket.setEncoding('utf8');
    socket.setTimeout(INGEST_TIMEOUT_MS, () => socket.destroy());
    const answer = (response: IngestResponse): void => {
      if (answered) return;
      answered = true;
      socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on('data', (chunk: string) => {
      if (answered) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        answer({
          ok: false,
          error: `ingest: request exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
          hint: 'the driver returned an oversized snapshot; ask it for a compact tree (05 §6.2)',
          code: ERROR_CODES.BAD_INPUT,
        });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      answer(handleLine(ctx, buffer.slice(0, newline)));
    });
    // a client that half-closes without a newline still gets its one answer (05 §3: `nc -U`);
    // a client that says nothing at all (the liveness probe below) is simply closed
    socket.on('end', () => {
      if (answered) return;
      if (buffer.trim() !== '') answer(handleLine(ctx, buffer));
      else socket.end();
    });
    socket.on('error', (e) => ctx.log.debug('ingest: connection error', { error: e.message }));
  });

  const bound = bindPath(socketPath);
  const listening = await new Promise<boolean>((resolveListen, rejectListen) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      // a live listener appeared between the probe and the bind: that instance owns the socket
      if (e.code === 'EADDRINUSE') {
        resolveListen(false);
        return;
      }
      rejectListen(new AppMapError(ERROR_CODES.STORAGE, `ingest socket ${socketPath} could not be bound: ${e.message}`, 'check that app-map/.local is writable (03 §2)', { cause: e }));
    });
    server.listen(bound, () => resolveListen(true));
  });
  if (!listening) {
    await new Promise<void>((done) => server.close(() => done()));
    return { socketPath, listening: false, close: async () => {} };
  }
  try {
    chmodSync(socketPath, SOCKET_MODE); // 03 §2: 0600
  } catch (e) {
    ctx.log.warn('ingest: socket mode could not be set', { socket: socketPath, error: (e as Error).message });
  }
  ctx.log.info('ingest socket listening', { socket: socketPath, bound });

  let closed = false;
  const removeSocketFile = (): void => {
    try {
      unlinkSync(socketPath);
    } catch { /* already gone */ }
  };
  // 03 §2: the socket file is removed on exit, even when the process is killed mid-session
  process.once('exit', removeSocketFile);

  return {
    socketPath,
    listening: true,
    close: async () => {
      if (closed) return;
      closed = true;
      process.off('exit', removeSocketFile);
      for (const socket of open) socket.destroy();
      open.clear();
      await new Promise<void>((done) => server.close(() => done()));
      removeSocketFile();
    },
  };
}

/**
 * Client side (used by `app-map record --stdin` to prefer the running server, and by tests):
 * resolves the response, or `null` when the socket is absent/unreachable within `timeoutMs`
 * (caller falls back to direct ingest). Never throws for connectivity problems.
 */
export function postToIngestSocket(config: Pick<AppMapConfig, 'dir'>, payload: HookPayload, opts: { timeoutMs?: number; socketPath?: string } = {}): Promise<IngestResponse | null> {
  const socketPath = opts.socketPath ?? ingestSocket(config);
  const timeoutMs = opts.timeoutMs ?? INGEST_TIMEOUT_MS;
  return new Promise((resolvePost) => {
    let settled = false;
    let buffer = '';
    const finish = (response: IngestResponse | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy(); // never removeAllListeners: it strips Node's own cleanup handlers
      resolvePost(response);
    };
    const socket = createConnection({ path: socketPath });
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.once('connect', () => {
      // one request line, then half-close so the server can still answer (03 §2)
      socket.end(`${JSON.stringify(payload)}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline !== -1) finish(parseResponseLine(buffer.slice(0, newline)));
    });
    socket.once('end', () => finish(buffer.trim() === '' ? null : parseResponseLine(buffer)));
    socket.once('error', () => finish(null)); // absent or unreachable → the caller falls back
  });
}

/** a response we cannot parse is treated as "no server" so the caller falls back (03 §2) */
function parseResponseLine(line: string): IngestResponse | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { ok?: unknown }).ok !== 'boolean') return null;
    return parsed as IngestResponse;
  } catch {
    return null;
  }
}
