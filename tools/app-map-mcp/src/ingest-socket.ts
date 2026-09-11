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
import type { AppMapConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { ErrorJson } from './errors.ts';
import type { HookPayload, RecordResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export const INGEST_TIMEOUT_MS = 2000;
export const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

export type IngestResponse = ({ ok: true } & RecordResult) | { ok: true; ignored: true } | ({ ok: false } & ErrorJson);

export interface IngestServer {
  socketPath: string;
  /** false when another instance owns the socket */
  listening: boolean;
  close(): Promise<void>;
}

export function startIngestServer(ctx: AppMapContext, opts: { socketPath?: string } = {}): Promise<IngestServer> {
  void ctx; void opts;
  throw new NotImplementedError('ingest-socket.startIngestServer');
}

/**
 * Client side (used by `app-map record --stdin` to prefer the running server, and by tests):
 * resolves the response, or `null` when the socket is absent/unreachable within `timeoutMs`
 * (caller falls back to direct ingest). Never throws for connectivity problems.
 */
export function postToIngestSocket(config: Pick<AppMapConfig, 'dir'>, payload: HookPayload, opts: { timeoutMs?: number; socketPath?: string } = {}): Promise<IngestResponse | null> {
  void config; void payload; void opts;
  throw new NotImplementedError('ingest-socket.postToIngestSocket');
}

/** Pure: parse one request line into a `HookPayload` or an error response. */
export function parseRequestLine(line: string): { payload: HookPayload } | { error: ErrorJson } {
  void line;
  throw new NotImplementedError('ingest-socket.parseRequestLine');
}
