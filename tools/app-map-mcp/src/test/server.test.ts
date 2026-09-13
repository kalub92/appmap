/**
 * [D1] server.ts — the 03 §8 tool surface, the 03 §9 resources, the 03 §11 error contract and
 * the 03 §13 Maestro check. The server is driven by a real MCP client over the SDK's
 * `InMemoryTransport` pair, and the observations the tools verify against arrive the way they
 * do in production: as hook payloads posted to the 03 §2 ingest socket.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import { ERROR_CODES } from '../errors.ts';
import { idsFile, ingestSocket, recipeFile, screenFile, serverLog } from '../paths.ts';
import type { HookPayload, Observation, RecipeFile, Tree, TreeNode } from '../types.ts';
import { estimateTokens } from '../token.ts';
import { TRUNCATION_MARKER } from '../token.ts';
import { GET_SCREEN_MAX_TOKENS, STEP_MAX_TOKENS, SUMMARY_MAX_TOKENS } from '../format.ts';
import { decayConfidence } from '../identify.ts';
import { normalizeTree, walk } from '../tree.ts';
import type { BuildInfoProbe } from '../recipes/guided.ts';
import type { ExecFn } from '../recipes/headless.ts';
import { RESOURCE_TEMPLATES, SERVER_NAME, TOOL_NAMES, createServer, startServer, toolError, toolJson, toolText } from '../server.ts';
import type { IngestServer } from '../ingest-socket.ts';
import { postToIngestSocket, startIngestServer } from '../ingest-socket.ts';
import { PACKAGE_ROOT, loadFixtureTree, loadTrajectoryFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SESSION = 'sess_2026-09-11_d1';
const PARAMS = { amount: 50, client: 'Acme Corp' };

/** 07 §3: a Debug build pointed at the sandbox, so `run_recipe` may act */
const debugProbe: BuildInfoProbe = async (_config, appId) => ({
  schema_version: 1, build_type: 'debug', sandbox: true, app_id: appId, version: '1.4.0',
  build_number: '4412', git_sha: 'deadbee', auth: 'logged_in',
});

interface ToolAnswer { isError: boolean; text: string; structured: Record<string, unknown> | undefined }

let t: TempAppMapDir;
let ctx: AppMapContext;
let server: McpServer;
let client: Client;
let ingest: IngestServer | undefined;

async function open(env: NodeJS.ProcessEnv = {}): Promise<void> {
  t = makeTempAppMapDir({ env });
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
  server = createServer(ctx, { probe: debugProbe });
  client = new Client({ name: 'server.test', version: '0.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
}
async function shut(): Promise<void> {
  await client.close();
  await server.close();
  await ingest?.close();
  ingest = undefined;
  ctx.close();
  t.cleanup();
}
beforeEach(async () => { await open(); });
afterEach(async () => { await shut(); });

async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolAnswer> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }> | undefined ?? [])
    .map((c) => c.text ?? '').join('');
  return { isError: result.isError === true, text, structured: result.structuredContent as Record<string, unknown> | undefined };
}
/** 03 §11: `{error, hint, code}` in a single text block, `isError` set, the server still alive */
function assertToolError(answer: ToolAnswer, code?: string): { error: string; hint: string; code: string } {
  assert.equal(answer.isError, true, `expected isError: ${answer.text}`);
  const json = JSON.parse(answer.text) as { error: string; hint: string; code: string };
  assert.equal(typeof json.error, 'string');
  assert.ok(json.error.length > 0, 'error message is empty');
  assert.equal(typeof json.hint, 'string');
  assert.ok(json.hint.length > 0, `no hint for ${json.code}`);
  if (code !== undefined) assert.equal(json.code, code, answer.text);
  return json;
}
function ok(answer: ToolAnswer): Record<string, unknown> {
  assert.equal(answer.isError, false, answer.text);
  assert.ok(answer.structured !== undefined, 'a JSON tool result carries structuredContent');
  return answer.structured;
}

/** one driver call, delivered exactly as the PostToolUse hook delivers it (05 §3, 03 §2) */
async function drive(name: string, opts: { url?: string; session?: string; mutate?: (tree: Tree) => void } = {}): Promise<void> {
  if (ingest === undefined) ingest = await startIngestServer(ctx);
  const tree = normalizeTree(loadFixtureTree(name), { platform: 'ios' });
  opts.mutate?.(tree);
  const payload: HookPayload = {
    session_id: opts.session ?? SESSION,
    hook_event_name: 'PostToolUse',
    tool_name: opts.url !== undefined ? 'mcp__argent__open_url' : 'mcp__argent__tap',
    tool_input: opts.url !== undefined ? { url: opts.url } : { id: 'invoice.add.button' },
    tool_response: { structuredContent: { ok: true, latency_ms: 11, snapshot: tree } },
  };
  const response = await postToIngestSocket(t.config, payload, { socketPath: ingest.socketPath });
  assert.ok(response !== null && response.ok === true, `ingest refused the payload: ${JSON.stringify(response)}`);
}

/** 03 §5 signal 2 removed: the same screen without its marker identifies below 1.0 */
function dropMarker(tree: Tree): void {
  walk(tree, (n: TreeNode) => {
    if (typeof n.a11y_id === 'string' && n.a11y_id.startsWith('screen.')) delete n.a11y_id;
    return undefined;
  });
}

// ---------------------------------------------------------------------------------------------
// 03 §8 tool surface / 05 §6.6 tool budget
// ---------------------------------------------------------------------------------------------

describe('tool surface (03 §8, 05 §6.6)', () => {
  it('registers exactly the 13 named tools, each with a short description', async () => {
    const { tools } = await client.listTools();
    assert.equal(TOOL_NAMES.length, 13);
    assert.ok(TOOL_NAMES.length <= 13, '05 §6.6: ≤13 tools');
    assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOL_NAMES].sort());
    for (const tool of tools) {
      assert.ok(typeof tool.description === 'string' && tool.description.length > 0, `${tool.name} has no description`);
      assert.ok(tool.description.length <= 110, `${tool.name} description is ${tool.description.length} chars (05 §6.6 wants short)`);
      assert.ok(tool.inputSchema !== undefined, `${tool.name} has no inputSchema`);
    }
  });

  it('registers the three 03 §9 resource templates verbatim', async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    assert.deepEqual(
      resourceTemplates.map((r) => r.uriTemplate).sort(),
      [RESOURCE_TEMPLATES.recipe, RESOURCE_TEMPLATES.screen, RESOURCE_TEMPLATES.summary].sort(),
    );
    assert.equal(SERVER_NAME, 'app-map');
  });
});

// ---------------------------------------------------------------------------------------------
// summary (03 §8: ≤600 tokens, what SessionStart injects)
// ---------------------------------------------------------------------------------------------

describe('summary', () => {
  it('returns the pilot map in ≤600 tokens (03 §12 acceptance 1)', async () => {
    const answer = await call('summary');
    assert.equal(answer.isError, false, answer.text);
    assert.ok(estimateTokens(answer.text) <= SUMMARY_MAX_TOKENS, `${estimateTokens(answer.text)} tokens`);
    assert.match(answer.text, /app-map ios build 4412/);
    assert.match(answer.text, /create_invoice/);
    assert.match(answer.text, /gate\.push_permission/);
  });

  it('is capped by APP_MAP_MAX_CONTEXT_TOKENS (03 §3, 03 §8)', async () => {
    await shut();
    await open({ APP_MAP_MAX_CONTEXT_TOKENS: '50' }); // 50 is config.ts's floor; the pilot summary is 107 tokens
    const answer = await call('summary');
    assert.ok(estimateTokens(answer.text) <= 50, `${estimateTokens(answer.text)} tokens`);
    assert.ok(answer.text.endsWith(TRUNCATION_MARKER), answer.text);
  });
});

// ---------------------------------------------------------------------------------------------
// identify_screen (03 §5)
// ---------------------------------------------------------------------------------------------

describe('identify_screen', () => {
  it('identifies a fixture snapshot passed inline', async () => {
    const result = ok(await call('identify_screen', { snapshot: loadFixtureTree('invoice_list') }));
    assert.equal(result.screen_id, 'invoice_list');
    assert.equal(result.confidence, 1);
    assert.equal(result.source, 'snapshot');
    assert.deepEqual(result.gates_present, []);
  });

  it('reports gates_present for a snapshot with a gate on it (03 §12 acceptance 2)', async () => {
    const result = ok(await call('identify_screen', { snapshot: loadFixtureTree('invoice_list.with_gate') }));
    assert.equal(result.screen_id, 'invoice_list');
    assert.deepEqual(result.gates_present, ['gate.push_permission']);
  });

  it('returns unknown (not an error) with candidates for an unrecognizable tree (03 §5)', async () => {
    const result = ok(await call('identify_screen', { snapshot: loadFixtureTree('invoice_list.no_ids') }));
    assert.equal(result.screen_id, 'unknown');
    assert.ok(Array.isArray(result.candidates) && result.candidates.length > 0);
  });

  it('falls back to the newest observation of the session (03 §2)', async () => {
    await drive('invoice_new');
    const result = ok(await call('identify_screen', { session: SESSION }));
    assert.equal(result.screen_id, 'invoice_new');
    assert.equal(result.source, 'observation');
    assert.equal(result.session, SESSION);
    // and without an explicit session, the newest observation in the cache wins
    assert.equal(ok(await call('identify_screen')).screen_id, 'invoice_new');
  });

  it('is no_observation when nothing has been recorded and no snapshot is given', async () => {
    assertToolError(await call('identify_screen'), ERROR_CODES.NO_OBSERVATION);
  });
});

// ---------------------------------------------------------------------------------------------
// get_screen (03 §8 fixed block, architecture §7 decision 44)
// ---------------------------------------------------------------------------------------------

describe('get_screen', () => {
  it('returns the fixed block for invoice_list within 400 tokens', async () => {
    const answer = await call('get_screen', { screen_id: 'invoice_list' });
    assert.equal(answer.isError, false, answer.text);
    const lines = answer.text.split('\n');
    assert.match(lines[0] ?? '', /^screen invoice_list {2}conf 1\.00 {2}title "Invoices" {2}deep_link appmap:\/\/invoice_list$/);
    assert.equal(lines[1], 'elements');
    assert.match(answer.text, /invoice\.add\.button {2}/);
    assert.match(answer.text, /^gates {2}gate\.push_permission$/m);
    assert.match(answer.text, /^recipes {2}create_invoice$/m);
    assert.ok(estimateTokens(answer.text) <= GET_SCREEN_MAX_TOKENS, `${estimateTokens(answer.text)} tokens`);
  });

  it('decays conf for a screen this session never observed (02 §8, decision 44)', async () => {
    await shut();
    await open({ APP_MAP_BUILD: '4415' }); // three builds past last_verified_build 4412
    const answer = await call('get_screen', { screen_id: 'invoice_list' });
    const expected = decayConfidence(1, 3).toFixed(2);
    assert.match(answer.text.split('\n')[0] ?? '', new RegExp(`^screen invoice_list {2}conf ${expected} `), answer.text);
  });

  it('takes conf from the last observation when it identified this screen (decision 44)', async () => {
    // the same screen without its marker: identification is confident but not 1.0
    await drive('invoice_list', { mutate: dropMarker });
    const obs = ctx.db.lastObservation(SESSION) as Observation;
    assert.equal(obs.screen_after, 'invoice_list');
    assert.ok(obs.confidence !== undefined && obs.confidence < 1, `confidence ${String(obs.confidence)}`);
    const answer = await call('get_screen', { screen_id: 'invoice_list', session: SESSION });
    assert.match(answer.text.split('\n')[0] ?? '', new RegExp(`^screen invoice_list {2}conf ${(obs.confidence ?? 0).toFixed(2)} `), answer.text);
    // a screen the observation did NOT identify keeps the decayed value instead
    const other = await call('get_screen', { screen_id: 'client_picker', session: SESSION });
    assert.match(other.text.split('\n')[0] ?? '', /^screen client_picker {2}conf 1\.00 /, other.text);
  });

  it('is not_found for an unknown screen id', async () => {
    assertToolError(await call('get_screen', { screen_id: 'nope' }), ERROR_CODES.NOT_FOUND);
  });
});

// ---------------------------------------------------------------------------------------------
// find_element (03 §8, 03 §12 acceptance 3)
// ---------------------------------------------------------------------------------------------

describe('find_element', () => {
  it('resolves a pilot element by a11y_id against the last observation', async () => {
    await drive('invoice_list');
    const result = ok(await call('find_element', { screen_id: 'invoice_list', element_id: 'invoice.add.button', session: SESSION }));
    assert.equal(result.found, true);
    const hit = result.hit as { strategy: string; confidence: number; degraded: boolean; target: Record<string, unknown> };
    assert.equal(hit.strategy, 'a11y_id');
    assert.equal(hit.confidence, 1);
    assert.equal(hit.degraded, false);
    assert.deepEqual(hit.target, { by: 'id', id: 'invoice.add.button' });
  });

  it('resolves by intent as well', async () => {
    await drive('invoice_list');
    const result = ok(await call('find_element', { screen_id: 'invoice_list', intent: 'open_new_invoice' }));
    assert.equal(result.found, true);
    assert.equal(result.element, 'invoice.add.button');
  });

  it('misses with candidates for an element the screen does not declare', async () => {
    await drive('invoice_list');
    const result = ok(await call('find_element', { screen_id: 'invoice_list', element_id: 'invoice.nope.button' }));
    assert.equal(result.found, false);
    const candidates = result.candidates as Array<{ id: string }>;
    assert.ok(candidates.length > 0, 'a miss carries candidates (03 §8)');
    assert.ok(candidates.some((c) => c.id === 'invoice.add.button'));
  });

  it('needs element_id or intent', async () => {
    assertToolError(await call('find_element', { screen_id: 'invoice_list' }), ERROR_CODES.BAD_INPUT);
  });
});

// ---------------------------------------------------------------------------------------------
// plan_path (03 §8, invariant 7)
// ---------------------------------------------------------------------------------------------

describe('plan_path', () => {
  it('prefers the deep link', async () => {
    const result = ok(await call('plan_path', { from: 'invoice_list', to: 'invoice_new' }));
    assert.equal(result.kind, 'deep_link');
    assert.equal(result.deep_link, 'appmap://invoice_new');
  });

  it('plans edges for a screen without a deep link (decision 9)', async () => {
    const result = ok(await call('plan_path', { from: 'invoice_new', to: 'client_picker' }));
    assert.equal(result.kind, 'edges');
    const edges = result.edges as Array<{ from: string; to: string }>;
    assert.equal(edges.at(-1)?.to, 'client_picker');
  });

  it('returns kind none from an unidentified screen without a deep link', async () => {
    const result = ok(await call('plan_path', { from: 'unknown', to: 'client_picker' }));
    assert.equal(result.kind, 'none');
    assert.match(String(result.reason), /unknown/);
  });
});

// ---------------------------------------------------------------------------------------------
// match_recipe (04 §2 + 04 §4)
// ---------------------------------------------------------------------------------------------

describe('match_recipe', () => {
  it('matches the pilot recipe and declares the task on the session (04 §2)', async () => {
    const result = ok(await call('match_recipe', { instruction: 'create an invoice for Acme Corp', session: SESSION }));
    assert.equal(result.matched, true);
    assert.equal(result.recipe_id, 'create_invoice');
    assert.equal(result.confidence, 0.9);
    assert.deepEqual(result.params_needed, ['amount']); // the instruction names no amount (04 §4.1)
    assert.equal(ctx.db.getSession(SESSION)?.task, 'create an invoice for Acme Corp');
  });

  it('declares the task even when nothing matches (decision 31: there is no name_task tool)', async () => {
    const result = ok(await call('match_recipe', { instruction: 'delete a client', session: SESSION }));
    assert.equal(result.matched, false);
    assert.equal(result.no_match, true);
    const candidates = result.candidates as Array<{ id: string }>;
    assert.ok(candidates.length <= 8, '04 §4.2: ≤8 candidate lines');
    assert.equal(ctx.db.getSession(SESSION)?.task, 'delete a client');
  });

  it('stores the task PII-redacted (architecture §7 decision 13, 07 §2.3)', async () => {
    ok(await call('match_recipe', { instruction: 'create an invoice for $50 for Acme Corp', session: SESSION }));
    assert.equal(ctx.db.getSession(SESSION)?.task, 'create an invoice for [redacted] for Acme Corp');
  });

  it('rejects an unknown platform and a missing instruction', async () => {
    assertToolError(await call('match_recipe', {}), ERROR_CODES.BAD_INPUT);
    assertToolError(await call('match_recipe', { instruction: 'x', platform: 'web' }), ERROR_CODES.BAD_INPUT);
  });
});

// ---------------------------------------------------------------------------------------------
// run_recipe (guided) → report_step … → done (04 §5, 04 §9)
// ---------------------------------------------------------------------------------------------

/** the trees the app shows after each create_invoice step, in order (04 §9) */
const HAPPY_PATH: ReadonlyArray<[string, string]> = [
  ['s0', 'invoice_new'],
  ['s1', 'invoice_new.amount_focused'],
  ['s2', 'invoice_new.amount_focused'],
  ['s3', 'client_picker'],
  ['s4', 'invoice_new'],
  ['s5', 'invoice_detail'],
];

describe('run_recipe guided → report_step loop (04 §5)', () => {
  it('walks create_invoice to done with observations arriving through the ingest socket', async () => {
    ok(await call('match_recipe', { instruction: 'create an invoice for $50 for Acme Corp', session: SESSION }));
    await drive('invoice_list');

    const started = ok(await call('run_recipe', { recipe_id: 'create_invoice', params: PARAMS, mode: 'guided', session: SESSION }));
    assert.equal(started.mode, 'guided');
    const runId = String(started.run_id);
    const first = started.step as { id: string; action: string; url?: string };
    assert.equal(first.id, 's0');
    assert.equal(first.action, 'open_link');
    assert.match(String(started.text), /^step s0 open_link appmap:\/\/invoice_new/);
    assert.ok(estimateTokens(String(started.text)) <= STEP_MAX_TOKENS, String(started.text));

    let last: Record<string, unknown> = started;
    for (const [stepId, tree] of HAPPY_PATH) {
      await drive(tree, stepId === 's0' ? { url: 'appmap://invoice_new?fixture=logged_in' } : {});
      last = ok(await call('report_step', { run_id: runId, step_id: stepId, ok: true }));
      assert.equal(last.run_id, runId);
      // 04 §5: every step handed to the replayer stays inside the 120-token budget
      assert.ok(estimateTokens(String(last.text)) <= STEP_MAX_TOKENS, String(last.text));
      if (stepId !== 's5') assert.equal(last.status, 'ok', `${stepId}: ${JSON.stringify(last)}`);
    }
    assert.equal(last.status, 'done');
    assert.equal(last.done, true);
    assert.equal(last.verified, true);
    assert.deepEqual(last.heals, []);
    assert.equal(ctx.db.getRun(runId)?.state, 'done');
    // 04 §3.1 / decision 31: guided `done` closes the task
    assert.ok(ctx.db.getSession(SESSION)?.task_end_seq !== undefined);
  });

  it('refuses an unknown recipe and reports the step the server is waiting for', async () => {
    await drive('invoice_list');
    assertToolError(await call('run_recipe', { recipe_id: 'nope', params: {} }), ERROR_CODES.RECIPE_UNAVAILABLE);
    assertToolError(await call('run_recipe', { recipe_id: 'create_invoice', params: {}, mode: 'sideways' }), ERROR_CODES.BAD_INPUT);
    const started = ok(await call('run_recipe', { recipe_id: 'create_invoice', params: PARAMS, session: SESSION }));
    const wrong = assertToolError(await call('report_step', { run_id: String(started.run_id), step_id: 's4', ok: true }), ERROR_CODES.BAD_INPUT);
    assert.match(wrong.error, /waiting for step s0/);
  });

  it('routes mode: headless to the Maestro runner and reports a missing binary as data (03 §13)', async () => {
    await shut();
    await open();
    const failingExec: ExecFn = async () => ({ code: 127, stdout: '', stderr: 'maestro: command not found' });
    server = createServer(ctx, { probe: debugProbe, exec: failingExec });
    client = new Client({ name: 'server.test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

    const result = ok(await call('run_recipe', { recipe_id: 'create_invoice', params: PARAMS, mode: 'headless' }));
    assert.equal(result.mode, 'headless');
    assert.equal(result.recipe, 'create_invoice');
    const report = result.report as { ok: boolean; error_code?: string; mode: string };
    assert.equal(report.mode, 'headless');
    assert.equal(report.ok, false);
    assert.equal(report.error_code, 'maestro_unavailable'); // 04 §6 / 03 §13, never a crash
  });

  it('is run_not_active for an unknown run id', async () => {
    assertToolError(await call('report_step', { run_id: 'run_nope', step_id: 's0', ok: true }), ERROR_CODES.RUN_NOT_ACTIVE);
  });
});

// ---------------------------------------------------------------------------------------------
// record_observation / name_screen
// ---------------------------------------------------------------------------------------------

describe('record_observation (03 §8 fallback when hooks are unavailable)', () => {
  it('records a tree and answers {screen_before, screen_after}', async () => {
    const result = ok(await call('record_observation', {
      tool: 'mcp__argent__open_url', input: { url: 'appmap://invoice_list' },
      snapshot: loadFixtureTree('invoice_list'), ok: true, session: SESSION,
    }));
    assert.equal(result.screen_before, 'unknown');
    assert.equal(result.screen_after, 'invoice_list');
    assert.equal(result.seq, 1);
    const second = ok(await call('record_observation', {
      tool: 'mcp__argent__tap', input: { id: 'invoice.add.button' },
      snapshot: loadFixtureTree('invoice_new'), ok: true, session: SESSION,
    }));
    assert.equal(second.screen_before, 'invoice_list');
    assert.equal(second.screen_after, 'invoice_new');
  });

  it('needs a tool name', async () => {
    assertToolError(await call('record_observation', { snapshot: loadFixtureTree('invoice_list') }), ERROR_CODES.BAD_INPUT);
  });
});

describe('name_screen (03 §5 explore mode)', () => {
  it('refuses an id that ids.yaml does not register (01 R1)', async () => {
    await drive('invoice_list.no_ids');
    assertToolError(await call('name_screen', { screen_id: 'not_registered', session: SESSION }), ERROR_CODES.INVALID_MAP);
  });
});

// ---------------------------------------------------------------------------------------------
// compile_recipe → mark → export (04 §3.1, 04 §3.8, 03 §4)
// ---------------------------------------------------------------------------------------------

describe('compile_recipe (04 §3)', () => {
  it('compiles the fixture trajectory into a draft and closes the task', async () => {
    const session = 'sess_2026-09-10_0007'; // the session the fixture trajectory belongs to
    const task = 'create an invoice for $50 for Acme Corp';
    ok(await call('match_recipe', { instruction: task, session })); // declares the task first
    for (const observation of loadTrajectoryFixture('create_invoice.session')) ctx.db.insertObservation(observation);

    const result = ok(await call('compile_recipe', {
      session, task, recipe_id: 'create_invoice_v2',
      params: [{ name: 'amount', type: 'money', required: true }, { name: 'client', type: 'string', required: true }],
      values: { amount: 50, client: 'Acme Corp' },
    }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.recipe_id, 'create_invoice_v2');
    assert.match(String(result.yaml), /^id: create_invoice_v2$/m);
    assert.match(String(result.yaml), /amount/);
    // 04 §3.1: a successful compile ends the task
    assert.ok(ctx.db.getSession(session)?.task_end_seq !== undefined);
  });

  it('reports a compile failure as data, not as an error (04 §3)', async () => {
    const result = ok(await call('compile_recipe', { session: 'empty_session', task: 'do a thing', recipe_id: 'nothing', params: [] }));
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_observations');
  });

  it('needs a recipe_id and a task', async () => {
    assertToolError(await call('compile_recipe', { session: SESSION }), ERROR_CODES.BAD_INPUT);
  });
});

describe('mark (04 §3.8, 07 §7, 02 §8)', () => {
  it('refuses candidate without the reviewed draft (decision 35)', async () => {
    const error = assertToolError(await call('mark', { recipe_id: 'brand_new', status: 'candidate' }), ERROR_CODES.BAD_INPUT);
    assert.match(error.error, /no draft was supplied/);
  });

  it('needs exactly one of recipe_id or screen_id (02 §6 / 02 §8)', async () => {
    const none = assertToolError(await call('mark', { status: 'candidate' }), ERROR_CODES.BAD_INPUT);
    assert.match(none.error, /recipe_id/);
    assert.match(none.error, /screen_id/);
    assertToolError(await call('mark', { recipe_id: 'create_invoice', screen_id: 'invoice_list', status: 'candidate' }), ERROR_CODES.BAD_INPUT);
  });

  // issue #16: the screen half — the only way back out of `verified`
  it('demotes a verified screen through screen_id and export writes it (02 §8, issue #16)', async () => {
    const marked = ok(await call('mark', { screen_id: 'invoice_list', status: 'candidate', reviewer: 'dana' }));
    assert.deepEqual({ from: marked.from, to: marked.to, written: marked.written }, { from: 'verified', to: 'candidate', written: true });
    assert.equal(ctx.db.getScreen('invoice_list')!.meta.reviewed_by, 'dana');
    assert.equal(ctx.db.getScreen('invoice_list')!.meta.last_verified_build, undefined);

    const exported = ok(await call('export'));
    assert.ok((exported.written as string[]).includes('ios/screens/invoice_list.yaml'), JSON.stringify(exported.written));
    const yaml = readFileSync(screenFile(t.config, 'invoice_list'), 'utf8');
    assert.match(yaml, /^ {2}status: candidate$/m);
    assert.match(yaml, /^ {2}reviewed_by: dana$/m);
    assert.doesNotMatch(yaml, /^ {2}last_verified_build:/m);
  });

  it('refuses a screen status outside 02 §8 and an unknown screen', async () => {
    assertToolError(await call('mark', { screen_id: 'invoice_list', status: 'ci_gate' }), ERROR_CODES.BAD_INPUT);
    assertToolError(await call('mark', { screen_id: 'nope', status: 'candidate' }), ERROR_CODES.NOT_FOUND);
  });

  it('refuses ci_gate without a reviewer (07 §7)', async () => {
    assertToolError(await call('mark', { recipe_id: 'create_invoice', status: 'ci_gate' }), ERROR_CODES.BAD_INPUT);
  });

  it('refuses a status outside the enum, and a call carrying no id key at all', async () => {
    assertToolError(await call('mark', { recipe_id: 'create_invoice', status: 'blessed' }), ERROR_CODES.BAD_INPUT);
    assertToolError(await call('mark', { status: 'verified' }), ERROR_CODES.BAD_INPUT);
  });

  it('demotes an existing recipe and export writes it back canonically (03 §4)', async () => {
    const marked = ok(await call('mark', { recipe_id: 'create_invoice', status: 'candidate' }));
    assert.equal(marked.from, 'verified');
    assert.equal(marked.to, 'candidate');
    assert.equal(marked.written, true);

    // the read tools serve the cache view while a row is dirty (not yet exported)
    const screen = await call('get_screen', { screen_id: 'invoice_list' });
    assert.match(screen.text, /^recipes {2}create_invoice$/m);

    const exported = ok(await call('export'));
    assert.deepEqual(exported.conflicts, []);
    assert.ok((exported.written as string[]).includes('ios/recipes/create_invoice.yaml'), JSON.stringify(exported.written));
    assert.match(readFileSync(recipeFile(t.config, 'create_invoice'), 'utf8'), /^status: candidate$/m);
    // 03 §8: `export` reloads, so the served map reflects what was written
    assert.equal(ctx.map.recipes.get('create_invoice')?.status, 'candidate');
  });

  it('refuses to overwrite a YAML file that changed on disk since load — the tool never forces (03 §4)', async () => {
    ok(await call('mark', { recipe_id: 'create_invoice', status: 'candidate' }));
    const path = recipeFile(t.config, 'create_invoice');
    const onDisk = `${readFileSync(path, 'utf8')}# edited in another window\n`;
    writeFileSync(path, onDisk);

    const exported = ok(await call('export'));
    assert.deepEqual(exported.written, []);
    assert.deepEqual(exported.conflicts, ['ios/recipes/create_invoice.yaml']);
    assert.match(String(exported.hint), /--force/);
    assert.equal(readFileSync(path, 'utf8'), onDisk, 'the concurrent edit survives');
  });

  it('exports nothing when nothing is dirty', async () => {
    const exported = ok(await call('export'));
    assert.deepEqual(exported.written, []);
    assert.deepEqual(exported.conflicts, []);
  });

  it('names a machine recompile, and says nothing for an ordinary write (04 §8, issue #13)', async () => {
    ok(await call('mark', { recipe_id: 'create_invoice', status: 'candidate' }));
    const human = ok(await call('export'));
    assert.deepEqual(human.written, ['ios/recipes/create_invoice.yaml']);
    assert.equal(human.machine_recompiles, undefined, 'a human mark is not a machine recompile');
    assert.equal(human.recompile_hint, undefined);

    // what `lifecycle.recompileFrom` leaves behind once its 04 §8 guard passes
    const recipe = ctx.db.getRecipe('create_invoice') as RecipeFile;
    ctx.db.putRecipe({ ...recipe, version: recipe.version + 1 }, { dirty: true, reason: 'recompile:recompile_failures' });
    const machine = ok(await call('export'));
    assert.deepEqual(machine.machine_recompiles, [{ path: 'ios/recipes/create_invoice.yaml', reason: 'recompile:recompile_failures' }]);
    assert.match(String(machine.recompile_hint), /rebuilt from a replay trajectory/);
  });
});

// ---------------------------------------------------------------------------------------------
// 03 §9 resources
// ---------------------------------------------------------------------------------------------

describe('resources (03 §9)', () => {
  it('serves a screen file verbatim as application/yaml', async () => {
    const result = await client.readResource({ uri: 'app-map://ios/screens/invoice_list' });
    const [content] = result.contents as Array<{ uri: string; mimeType?: string; text?: string }>;
    assert.equal(content?.mimeType, 'application/yaml');
    assert.equal(content?.text, readFileSync(screenFile(t.config, 'invoice_list'), 'utf8'));
  });

  it('serves a recipe file verbatim', async () => {
    const result = await client.readResource({ uri: 'app-map://ios/recipes/create_invoice' });
    const [content] = result.contents as Array<{ text?: string }>;
    assert.equal(content?.text, readFileSync(recipeFile(t.config, 'create_invoice'), 'utf8'));
  });

  it('serves the summary resource as the summary tool does', async () => {
    const result = await client.readResource({ uri: 'app-map://ios/summary' });
    const [content] = result.contents as Array<{ mimeType?: string; text?: string }>;
    assert.equal(content?.mimeType, 'text/plain');
    assert.equal(content?.text, (await call('summary')).text);
  });

  it('rejects an unknown screen, an unknown platform and the platform this instance does not serve', async () => {
    await assert.rejects(client.readResource({ uri: 'app-map://ios/screens/nope' }), /nope/);
    await assert.rejects(client.readResource({ uri: 'app-map://web/summary' }), /platform/);
    await assert.rejects(client.readResource({ uri: 'app-map://android/summary' }), /serves ios/);
  });
});

// ---------------------------------------------------------------------------------------------
// 03 §11: errors never crash the session
// ---------------------------------------------------------------------------------------------

describe('03 §11 error contract', () => {
  const badCalls: ReadonlyArray<[string, Record<string, unknown>]> = [
    ['identify_screen', { snapshot: 'not a tree' }],
    ['get_screen', { screen_id: 'nope' }],
    ['find_element', { screen_id: 'invoice_list' }],
    ['plan_path', { from: 'invoice_list' }],
    ['match_recipe', {}],
    ['run_recipe', {}],
    ['report_step', { run_id: 'nope', step_id: 's0', ok: true }],
    ['record_observation', {}],
    ['name_screen', {}],
    ['compile_recipe', {}],
    ['mark', {}],
  ];

  it('answers every malformed call with {error, hint, code} and keeps serving', async () => {
    for (const [name, args] of badCalls) {
      assertToolError(await call(name, args));
      // the server is still alive after each failure
      assert.equal((await call('summary')).isError, false, `summary broke after ${name}`);
    }
  });

  it('reports a missing required argument as bad_input, not as a transport error', async () => {
    // the zod shapes are permissive on purpose so the handler can answer with a hint
    const error = assertToolError(await call('get_screen', {}), ERROR_CODES.BAD_INPUT);
    assert.match(error.error, /screen_id/);
  });

  // 03 §11: a WRONG-TYPED argument must come back structured too. A typed zod field would make
  // the SDK reject it before the handler runs, yielding a bare `MCP error -32602` text block.
  it('reports a wrong-typed argument as bad_input with a hint, not as a zod transport error', async () => {
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['report_step', { run_id: 'r', step_id: 's', ok: 'yes' }, /`ok`/],
      ['get_screen', { screen_id: 123 }, /screen_id/],
      ['name_screen', { screen_id: null }, /screen_id/],
      ['find_element', { screen_id: 'invoice_list', element_id: [1, 2] }, /element_id/],
      ['plan_path', { from: 1, to: 2 }, /from/],
      ['run_recipe', { recipe_id: 'create_invoice', params: 'notanobject' }, /params/],
      ['compile_recipe', { session: 's', task: 't', recipe_id: 'r', params: 'x' }, /params/],
      ['record_observation', { tool: 42 }, /tool/],
      ['mark', { recipe_id: 'create_invoice', status: 7 }, /status/],
      ['match_recipe', { instruction: { a: 1 } }, /instruction/],
    ];
    for (const [name, args, expected] of cases) {
      const answer = await call(name, args);
      assert.ok(answer.structured !== undefined, `${name} returned no structuredContent`);
      const error = assertToolError(answer, ERROR_CODES.BAD_INPUT);
      assert.match(error.error, expected, `${name}: ${error.error}`);
      assert.ok(typeof error.hint === 'string' && error.hint !== '', `${name} has no hint`);
      assert.doesNotMatch(error.error, /Invalid arguments for tool/, `${name} was rejected by zod, not the handler`);
    }
    assert.equal((await call('summary')).isError, false, 'the server survived every wrong-typed call');
  });

  it('short-circuits every tool with the load error while the YAML is invalid, and export is the way out', async () => {
    await shut();
    t = makeTempAppMapDir();
    writeFileSync(idsFile(t.config), 'schema_version: 1\nscreens: "not a list"\n');
    ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
    assert.ok(ctx.loadError !== null, 'the fixture must fail validation');
    server = createServer(ctx, { probe: debugProbe });
    client = new Client({ name: 'server.test', version: '0.0.0' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientSide), server.connect(serverSide)]);

    for (const name of ['summary', 'get_screen', 'identify_screen', 'plan_path']) {
      assertToolError(await call(name, { screen_id: 'invoice_list', from: 'a', to: 'b' }), ERROR_CODES.INVALID_MAP);
    }
    // `export` still answers (03 §11: it is the escape hatch)
    assert.equal((await call('export')).isError, false);
  });

  it('toolError shapes anything thrown, not just AppMapError', () => {
    const plain = toolError(new Error('boom'));
    assert.equal(plain.isError, true);
    assert.equal(plain.structuredContent.code, ERROR_CODES.INTERNAL);
    assert.equal(JSON.parse(plain.content[0]?.text ?? '{}').error, 'boom');
  });
});

// ---------------------------------------------------------------------------------------------
// result helpers (03 §8 caps, 03 §11 shape)
// ---------------------------------------------------------------------------------------------

describe('toolText / toolJson / toolError', () => {
  it('caps a text result and leaves it alone without a cap', () => {
    const long = 'word '.repeat(200);
    assert.equal(toolText(long).content[0]?.text, long);
    const capped = toolText(long, 20).content[0]?.text ?? '';
    assert.ok(estimateTokens(capped) <= 20, `${estimateTokens(capped)} tokens`);
    assert.ok(capped.endsWith(TRUNCATION_MARKER));
  });

  it('keeps the whole object in structuredContent even when the text block is capped', () => {
    const payload = { yaml: 'x'.repeat(4000), ok: true };
    const result = toolJson(payload, 20);
    assert.deepEqual(result.structuredContent, payload);
    assert.ok(estimateTokens(result.content[0]?.text ?? '') <= 20);
    assert.equal(result.isError, undefined);
  });
});

// ---------------------------------------------------------------------------------------------
// startServer (03 §2, 03 §11, 03 §13)
// ---------------------------------------------------------------------------------------------

describe('startServer (03 §11 start-up, 03 §13 Maestro check)', () => {
  it('serves tools, owns the ingest socket, warns about Maestro and cleans up', async () => {
    await shut();
    t = makeTempAppMapDir({ env: { APP_MAP_LOG_LEVEL: 'info' } });
    const failingExec: ExecFn = async () => ({ code: 127, stdout: '', stderr: 'maestro: command not found' });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'server.test', version: '0.0.0' });
    const startedMs = Date.now();
    const running = await startServer(t.config, { transport: serverSide, exec: failingExec, probe: debugProbe, context: { skipRetention: true } });
    await client.connect(clientSide);
    const summary = await call('summary');
    const elapsed = Date.now() - startedMs;
    try {
      // 03 §11: server start to first tool <700 ms
      assert.ok(elapsed < 700, `start to first tool took ${elapsed} ms`);
      assert.equal(summary.isError, false, summary.text);
      assert.equal((await client.listTools()).tools.length, TOOL_NAMES.length);

      // 03 §2: this instance owns the socket, and the hook can post to it
      assert.equal(running.ingest?.listening, true);
      const response = await postToIngestSocket(t.config, {
        session_id: SESSION, hook_event_name: 'PostToolUse', tool_name: 'mcp__argent__open_url',
        tool_input: { url: 'appmap://invoice_list' },
        tool_response: { structuredContent: { ok: true, snapshot: normalizeTree(loadFixtureTree('invoice_list'), { platform: 'ios' }) } },
      });
      assert.ok(response !== null && response.ok === true);

      // 03 §13: a missing/mismatched Maestro is a warning, never a failure
      const check = await running.maestroCheck;
      assert.equal(check?.ok, false);
      const log = readFileSync(serverLog(t.config), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
      const warn = log.find((line) => line.level === 'warn' && String(line.msg).includes('maestro'));
      assert.ok(warn !== undefined, `no maestro warning in ${JSON.stringify(log.map((l) => l.msg))}`);
      assert.ok(log.some((line) => line.msg === 'app-map server started'));
    } finally {
      await client.close();
      await running.close();
    }
    assert.equal(existsSync(running.ingest?.socketPath ?? ''), false, '03 §2: the socket is removed on exit');
    t.cleanup();
    // keep afterEach happy
    await open();
  });

  it('starts without the socket when asked, and never writes to stdout', async () => {
    await shut();
    t = makeTempAppMapDir();
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'server.test', version: '0.0.0' });
    const running = await startServer(t.config, {
      transport: serverSide, skipIngestSocket: true, skipMaestroCheck: true,
      context: { skipRetention: true, logSink: 'none' },
    });
    try {
      await client.connect(clientSide);
      assert.equal(running.ingest, undefined);
      assert.equal((await call('summary')).isError, false);
      assert.equal(await running.maestroCheck, null);
    } finally {
      await client.close();
      await running.close();
    }
    t.cleanup();
    await open();
  });
});

// ---------------------------------------------------------------------------------------------
// index.ts — the real stdio entry point `.mcp.json` launches (05 §2)
// ---------------------------------------------------------------------------------------------

describe('index.ts over stdio (05 §2)', () => {
  it('serves the 13 tools, owns the ingest socket and removes it on exit', async () => {
    await shut();
    t = makeTempAppMapDir();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', join(PACKAGE_ROOT, 'src', 'index.ts')],
      env: {
        PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
        APP_MAP_DIR: t.dir, APP_MAP_PLATFORM: 'ios', APP_MAP_LOG_LEVEL: 'error',
        APP_MAP_MAESTRO_BIN: 'definitely-not-maestro-on-this-machine',
      },
      stderr: 'pipe',
    });
    client = new Client({ name: 'server.test', version: '0.0.0' });
    await client.connect(transport);
    const socket = ingestSocket(t.config);
    try {
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((x) => x.name).sort(), [...TOOL_NAMES].sort());
      // stdout carried only JSON-RPC: a polluted stream would have failed the handshake above
      const answer = await call('summary');
      assert.equal(answer.isError, false, answer.text);
      assert.match(answer.text, /app-map ios build 4412/);
      assert.equal(existsSync(socket), true, '03 §2: the entry point starts the ingest socket');
      // and a missing Maestro binary does not stop it serving (03 §13)
      assert.equal((await call('get_screen', { screen_id: 'invoice_list' })).isError, false);
    } finally {
      await client.close();
    }
    // 03 §2: the socket is removed on exit (SIGTERM from the transport)
    for (let i = 0; i < 40 && existsSync(socket); i++) await new Promise<void>((done) => { setTimeout(done, 50); });
    assert.equal(existsSync(socket), false, 'the socket file outlived the process');
    t.cleanup();
    await open();
  });
});
