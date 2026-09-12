/**
 * [D1] ingest-socket.ts — the 03 §2 local ingest socket and its wire protocol
 * (docs/dev/harness-notes.md §4: one newline-delimited JSON hook payload per connection, the
 * connection closed right after the single answer, a stale socket file removed on start, the
 * socket removed on exit). The <50 ms budget (03 §2) is measured on the pilot fixture payload.
 */
import assert from 'node:assert/strict';
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import { ERROR_CODES } from '../errors.ts';
import { ingestSocket } from '../paths.ts';
import type { HookPayload } from '../types.ts';
import { normalizeTree } from '../tree.ts';
import type { IngestServer } from '../ingest-socket.ts';
import {
  INGEST_TIMEOUT_MS, MAX_REQUEST_BYTES, MAX_SOCKET_PATH_BYTES, bindPath, parseRequestLine,
  postToIngestSocket, startIngestServer,
} from '../ingest-socket.ts';
import { loadFixtureTree, loadHookFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let ctx: AppMapContext;
let ingest: IngestServer | undefined;

beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
afterEach(async () => {
  await ingest?.close();
  ingest = undefined;
  ctx.close();
  t.cleanup();
});

/** the committed PostToolUse fixture, with a session of this test's choosing */
function tapPayload(session = 'sess_socket_0001'): HookPayload {
  return { ...loadHookFixture('post-tool-use.tap'), session_id: session };
}

/** raw client: exactly what `nc -U` does — write one line, half-close, read one line */
function rawPost(socketPath: string, line: string, timeoutMs = 2000): Promise<{ response: string; closedByServer: boolean }> {
  return new Promise((resolveRaw, rejectRaw) => {
    let response = '';
    let closedByServer = false;
    const socket = createConnection({ path: socketPath });
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => { socket.destroy(); rejectRaw(new Error('raw client timed out')); });
    socket.once('connect', () => socket.end(line));
    socket.on('data', (chunk: string) => { response += chunk; });
    socket.once('end', () => { closedByServer = true; });
    socket.once('close', () => resolveRaw({ response, closedByServer }));
    socket.once('error', rejectRaw);
  });
}

// ---------------------------------------------------------------------------------------------
// parseRequestLine (pure)
// ---------------------------------------------------------------------------------------------

describe('parseRequestLine (03 §2 wire protocol)', () => {
  it('accepts the committed PostToolUse payload', () => {
    const parsed = parseRequestLine(JSON.stringify(tapPayload()));
    assert.ok('payload' in parsed);
    assert.equal(parsed.payload.tool_name, 'mcp__argent__tap');
    assert.equal(parsed.payload.hook_event_name, 'PostToolUse');
  });

  it('normalizes the hooks-reference names onto the schema names (harness-notes §4)', () => {
    const failure = { session_id: 's1', hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__argent__tap', tool_error: 'element not found' };
    const parsed = parseRequestLine(JSON.stringify(failure));
    assert.ok('payload' in parsed);
    assert.equal(parsed.payload.error, 'element not found', 'tool_error ?? error');
    const start = { session_id: 's1', hook_event_name: 'SessionStart', matcher_value: 'compact' };
    const parsedStart = parseRequestLine(JSON.stringify(start));
    assert.ok('payload' in parsedStart);
    assert.equal(parsedStart.payload.source, 'compact', 'matcher_value ?? source');
  });

  it('keeps an explicit `error`/`source` when both spellings are present', () => {
    const both = { session_id: 's1', hook_event_name: 'PostToolUseFailure', error: 'schema name', tool_error: 'hooks name' };
    const parsed = parseRequestLine(JSON.stringify(both));
    assert.ok('payload' in parsed);
    assert.equal(parsed.payload.error, 'schema name');
  });

  it('rejects an empty line, non-JSON, a non-object, and a payload without session_id/hook_event_name', () => {
    for (const line of ['', '   ', 'not json', '[1,2]', 'null', '{"hook_event_name":"Stop"}', '{"session_id":"s1"}']) {
      const parsed = parseRequestLine(line);
      assert.ok('error' in parsed, `accepted ${JSON.stringify(line)}`);
      assert.equal(parsed.error.code, ERROR_CODES.BAD_INPUT);
      assert.ok(parsed.error.error.length > 0 && parsed.error.hint.length > 0);
    }
  });

  it('rejects a line over MAX_REQUEST_BYTES (4 MiB)', () => {
    const huge = `{"session_id":"s1","hook_event_name":"PostToolUse","pad":"${'x'.repeat(MAX_REQUEST_BYTES)}"}`;
    const parsed = parseRequestLine(huge);
    assert.ok('error' in parsed);
    assert.equal(parsed.error.code, ERROR_CODES.BAD_INPUT);
    assert.match(parsed.error.error, /limit/);
  });
});

// ---------------------------------------------------------------------------------------------
// bindPath (harness-notes §4: sun_path is 108 bytes)
// ---------------------------------------------------------------------------------------------

describe('bindPath (sun_path cap)', () => {
  it('uses the absolute path when it fits', () => {
    assert.equal(bindPath('/tmp/a/ingest.sock', '/tmp'), '/tmp/a/ingest.sock');
  });

  it('falls back to the shorter relative spelling of the same file', () => {
    const deep = `/${'directory/'.repeat(12)}app-map/.local/ingest.sock`;
    assert.ok(Buffer.byteLength(deep) > MAX_SOCKET_PATH_BYTES);
    const cwd = `/${'directory/'.repeat(12)}`;
    assert.equal(bindPath(deep, cwd), 'app-map/.local/ingest.sock');
  });

  it('throws bad_input when neither spelling fits', () => {
    const deep = `/${'directory/'.repeat(12)}${'nested/'.repeat(6)}ingest.sock`;
    assert.throws(() => bindPath(deep, '/'), (e: unknown) => (e as { code?: string }).code === ERROR_CODES.BAD_INPUT);
  });
});

// ---------------------------------------------------------------------------------------------
// round trip
// ---------------------------------------------------------------------------------------------

describe('startIngestServer (03 §2)', () => {
  it('round-trips a hook payload in <50 ms and identifies the screen', async () => {
    ingest = await startIngestServer(ctx);
    assert.equal(ingest.listening, true);
    assert.equal(ingest.socketPath, ingestSocket(t.config));
    // 03 §2: created 0600
    assert.equal(statSync(ingest.socketPath).mode & 0o777, 0o600);

    const startedMs = Date.now();
    const session = 'sess_socket_0001';
    const response = await postToIngestSocket(t.config, tapPayload(session));
    const elapsed = Date.now() - startedMs;
    assert.ok(response !== null, 'no response');
    assert.equal(response.ok, true);
    assert.ok(response.ok === true && !('ignored' in response));
    if (response.ok === true && !('ignored' in response)) {
      // 05 §3: the hook's answer is {screen_before, screen_after}
      assert.equal(response.screen_before, 'unknown', 'first observation of a session');
      assert.equal(response.screen_after, 'invoice_new');
      assert.equal(response.seq, 1);
      assert.deepEqual(response.gates_present, []);
    }
    assert.ok(elapsed < 50, `ingest took ${elapsed} ms (03 §2 budget is 50 ms)`);

    // and it really landed in the cache
    const stored = ctx.db.lastObservation(session);
    assert.equal(stored?.screen_after, 'invoice_new');
  });

  it('closes the connection right after the single answer (harness-notes §4: `nc -U`)', async () => {
    ingest = await startIngestServer(ctx);
    const { response, closedByServer } = await rawPost(ingest.socketPath, `${JSON.stringify(tapPayload())}\n`);
    assert.equal(closedByServer, true, 'the server must close so `nc -U` exits');
    assert.equal(response.split('\n').filter((l) => l !== '').length, 1, 'exactly one response line');
    assert.ok(response.endsWith('\n'), 'the response is newline-delimited');
    assert.equal((JSON.parse(response.trim()) as { ok: boolean }).ok, true);
  });

  it('records a PostToolUseFailure payload (no snapshot, `tool_error`) end to end', async () => {
    ingest = await startIngestServer(ctx);
    const failure = { ...loadHookFixture('post-tool-use-failure.tap'), session_id: 'fail_session' };
    const response = await postToIngestSocket(t.config, failure);
    assert.ok(response !== null && response.ok === true && !('ignored' in response), JSON.stringify(response));
    if (response.ok === true && !('ignored' in response)) {
      assert.equal(response.screen_after, 'unknown', 'no snapshot means nothing was perceived');
      assert.equal(response.seq, 1);
    }
    const stored = ctx.db.lastObservation('fail_session');
    assert.equal(stored?.ok, false);
    assert.equal(stored?.snapshot, null);
  });

  it('answers exactly once per connection even when two lines arrive together (03 §2)', async () => {
    ingest = await startIngestServer(ctx);
    const line = `${JSON.stringify(tapPayload('one_per_conn'))}\n`;
    const { response } = await rawPost(ingest.socketPath, `${line}${line}`);
    assert.equal(response.split('\n').filter((l) => l !== '').length, 1, 'one request per connection');
    assert.equal(ctx.db.lastObservation('one_per_conn')?.seq, 1, 'the second line is not recorded');
  });

  it('closes an idle connection after INGEST_TIMEOUT_MS (03 §2)', async () => {
    ingest = await startIngestServer(ctx);
    const startedMs = Date.now();
    await new Promise<void>((done, fail) => {
      const socket = createConnection({ path: ingest!.socketPath });
      socket.once('connect', () => { /* say nothing, keep the connection open */ });
      socket.once('close', () => done());
      socket.once('error', fail);
    });
    const elapsed = Date.now() - startedMs;
    assert.ok(elapsed >= INGEST_TIMEOUT_MS - 100 && elapsed < INGEST_TIMEOUT_MS * 3, `idle connection closed after ${elapsed} ms`);
  });

  it('answers `ignored` for a non-driver tool and for the Stop hook (05 §3)', async () => {
    ingest = await startIngestServer(ctx);
    const nonDriver = await postToIngestSocket(t.config, { session_id: 's1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} });
    assert.deepEqual(nonDriver, { ok: true, ignored: true });
    const stop = await postToIngestSocket(t.config, { ...loadHookFixture('stop'), session_id: 's1' });
    assert.deepEqual(stop, { ok: true, ignored: true });
  });

  it('answers {ok:false, error, hint, code} for a malformed line without dying', async () => {
    ingest = await startIngestServer(ctx);
    const bad = await rawPost(ingest.socketPath, 'not json\n');
    const parsed = JSON.parse(bad.response.trim()) as { ok: boolean; error: string; hint: string; code: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, ERROR_CODES.BAD_INPUT);
    assert.ok(parsed.hint.length > 0);
    // the server still serves the next client
    const ok = await postToIngestSocket(t.config, tapPayload());
    assert.equal(ok?.ok, true);
  });

  it('rejects an oversized request with bad_input before buffering it all (03 §2)', async () => {
    ingest = await startIngestServer(ctx);
    const line = `{"session_id":"s1","hook_event_name":"PostToolUse","pad":"${'x'.repeat(MAX_REQUEST_BYTES + 16)}"}\n`;
    const { response } = await rawPost(ingest.socketPath, line, 10_000);
    const parsed = JSON.parse(response.trim().split('\n')[0] as string) as { ok: boolean; code: string; error: string };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, ERROR_CODES.BAD_INPUT);
    assert.match(parsed.error, /limit/);
  });

  it('serves concurrent clients, one request per connection, without corrupting the cache', async () => {
    ingest = await startIngestServer(ctx);
    const sessions = ['c1', 'c2', 'c3', 'c4', 'c5'];
    const responses = await Promise.all(sessions.map((s) => postToIngestSocket(t.config, tapPayload(s))));
    for (const [i, response] of responses.entries()) {
      assert.ok(response !== null, `client ${i} got no response`);
      assert.equal(response.ok, true);
      if (response.ok === true && !('ignored' in response)) assert.equal(response.screen_after, 'invoice_new');
    }
    // every session got its own seq 1 (03 §2: many clients, one cache)
    for (const s of sessions) assert.equal(ctx.db.lastObservation(s)?.seq, 1, s);
  });

  it('removes a stale socket file on start and the socket on close (03 §2)', async () => {
    const path = ingestSocket(t.config);
    writeFileSync(path, 'stale');
    ingest = await startIngestServer(ctx);
    assert.equal(ingest.listening, true, 'a stale socket file must not stop the server');
    assert.equal((await postToIngestSocket(t.config, tapPayload()))?.ok, true);
    await ingest.close();
    ingest = undefined;
    assert.equal(existsSync(path), false, 'the socket file is removed on close');
  });

  it('skips the socket when another instance is already listening (03 §2)', async () => {
    ingest = await startIngestServer(ctx);
    const second = await startIngestServer(ctx);
    try {
      assert.equal(second.listening, false, 'only one instance owns the socket');
      assert.equal(second.socketPath, ingest.socketPath);
      await second.close(); // closing the non-owner must not remove the owner's socket
      assert.equal(existsSync(ingest.socketPath), true);
      assert.equal((await postToIngestSocket(t.config, tapPayload()))?.ok, true);
    } finally {
      await second.close();
    }
  });

  // The probe must use the spelling the bind uses. Over the sun_path cap `bindPath` shortens to a
  // cwd-relative path; probing the absolute one always got ENOENT, so the second instance decided
  // the socket was stale, UNLINKED the owner's live socket and bound its own (03 §2).
  it('a socket path over the sun_path cap still yields exactly one owner', async () => {
    const deep = mkdtempSync(join(tmpdir(), 'app-map-sock-'));
    // build a directory whose absolute socket path is comfortably over MAX_SOCKET_PATH_BYTES
    let dir = deep;
    while (Buffer.byteLength(join(dir, 'ingest.sock')) <= MAX_SOCKET_PATH_BYTES) dir = join(dir, 'nested-segment');
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'ingest.sock');
    const cwd = process.cwd();
    process.chdir(dir); // bindPath relativizes against the process cwd
    let first: Awaited<ReturnType<typeof startIngestServer>> | undefined;
    let second: Awaited<ReturnType<typeof startIngestServer>> | undefined;
    try {
      first = await startIngestServer(ctx, { socketPath: path });
      assert.equal(first.listening, true, 'the first instance owns the socket');
      second = await startIngestServer(ctx, { socketPath: path });
      assert.equal(second.listening, false, 'the second instance must NOT take the socket over');
      assert.equal(existsSync(path), true, "the owner's socket file survives");
    } finally {
      await second?.close();
      await first?.close();
      process.chdir(cwd);
      rmSync(deep, { recursive: true, force: true });
    }
  });

  it('skips the socket when a foreign process already listens on the path', async () => {
    // a socket file that exists and has a live listener that is NOT an app-map server
    const dir = mkdtempSync(join(tmpdir(), 'app-map-sock-'));
    const path = join(dir, 'ingest.sock');
    const foreign = createServer();
    await new Promise<void>((done) => foreign.listen(path, () => done()));
    try {
      const skipped = await startIngestServer(ctx, { socketPath: path });
      assert.equal(skipped.listening, false);
      await skipped.close();
      assert.equal(existsSync(path), true, 'the other listener keeps its socket');
    } finally {
      await new Promise<void>((done) => foreign.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('binds a custom socket path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-map-sock-'));
    const path = join(dir, 'custom.sock');
    ingest = await startIngestServer(ctx, { socketPath: path });
    assert.equal(ingest.socketPath, path);
    assert.equal((await postToIngestSocket(t.config, tapPayload(), { socketPath: path }))?.ok, true);
    await ingest.close();
    ingest = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  it('records a normalized snapshot posted by a driver that reports a tree directly', async () => {
    ingest = await startIngestServer(ctx);
    const tree = normalizeTree(loadFixtureTree('invoice_list'), { platform: 'ios' });
    const response = await postToIngestSocket(t.config, {
      session_id: 'direct', hook_event_name: 'PostToolUse', tool_name: 'mcp__argent__open_url',
      tool_input: { url: 'appmap://invoice_list' },
      tool_response: { structuredContent: { ok: true, latency_ms: 12, snapshot: tree } },
    });
    assert.ok(response !== null && response.ok === true && !('ignored' in response));
    if (response.ok === true && !('ignored' in response)) assert.equal(response.screen_after, 'invoice_list');
  });
});

describe('postToIngestSocket (client fallback, 03 §2)', () => {
  it('returns null when no socket exists so the caller falls back to `record --stdin`', async () => {
    const response = await postToIngestSocket(t.config, tapPayload());
    assert.equal(response, null);
  });

  it('returns null when the socket file exists but nothing listens', async () => {
    writeFileSync(ingestSocket(t.config), 'stale');
    assert.equal(await postToIngestSocket(t.config, tapPayload()), null);
  });

  it('returns null (never throws) when the server never answers, within timeoutMs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-map-sock-'));
    const path = join(dir, 'silent.sock');
    const accepted: Socket[] = [];
    const silent = createServer((socket) => accepted.push(socket)); // accept and say nothing
    await new Promise<void>((done) => silent.listen(path, () => done()));
    try {
      const startedMs = Date.now();
      assert.equal(await postToIngestSocket(t.config, tapPayload(), { socketPath: path, timeoutMs: 150 }), null);
      const elapsed = Date.now() - startedMs;
      assert.ok(elapsed >= 150 && elapsed < INGEST_TIMEOUT_MS, `the explicit timeout wins (${elapsed} ms)`);
    } finally {
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((done) => silent.close(() => done()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
