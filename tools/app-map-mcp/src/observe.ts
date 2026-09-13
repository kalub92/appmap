/**
 * [C1] Observation ingest (02 §7, 03 §2, 03 §7, 03 §8 `record_observation` + `name_screen`,
 * 04 §2, 05 §3) and task association (04 §2, 08 §2 `task` event).
 *
 * Ingest path (hook or socket or tool):
 *  1. `isDriverTool(config, payload.tool_name)` — non-driver tools are ignored (return `null`),
 *     except `PostToolUseFailure` for `mcp__app-map__*` which is logged only, and
 *     `hook_event_name: Stop` which closes the session's task (see `finishTask`) and returns
 *     `null`;
 *  2. `extractSnapshot(tool_response)` → `normalizeTree` → `scrub` (RAW TREES NEVER TOUCH DISK,
 *     03 §7); a driver response without a tree yields `snapshot: null`; when `config.build ===
 *     'auto'` and the tree carries `build`, `ctx.setBuild(tree.build)` (03 §3);
 *  3. `identify(map, scrubbedTree, {route: input.url, build, ...probeConditions(ctx.probe)})`
 *     → `screen_after`, `gates_present`; `screen_before` = previous observation's `screen_after`
 *     in this session (or `unknown`);
 *  4. resolved `element`: `input.id` when it is a registered element id; else, for a tap with
 *     `text`/point on a known `screen_before`, the element whose locator resolves to the tapped
 *     node (resolve.ts) — best-effort, may be absent (04 §2);
 *  5. `seq = db.nextSeq(session)`, `task` = session's declared task (04 §2); `input.text` and
 *     `task` pass through `redactString` (PII deny list) before they are persisted — the
 *     compiler only needs equality with a declared param value (architecture §7 decision 13);
 *  6. persist: `assertScrubbed(snapshot)`, append the JSON line to `trajectoryFile(config,
 *     session)`, `db.insertObservation`, `db.setScreenLastSeen`, bump `screen.seen` and element
 *     `hits`/`misses`, session `driver_calls`/`perception_bytes` (+`screenshots` when the tool
 *     name contains `screenshot`);
 *  7. emit an `identify` event (08 §2) with `signal` = the winning signal or `none`;
 *  8. lazy re-verify (02 §8, 08 §5 row 5): when the winning signal is `marker`, every
 *     `required_ids` entry is present and the structural hash matches the committed one (or a
 *     variant's) → `lifecycle.markVerified(ctx, {screens: [screen_after]}, ctx.build)`.
 *
 * `latency_ms` is taken from `structuredContent.latency_ms` when the driver reports it, else 0.
 * Must run in <50 ms end to end so the socket path stays cheap (03 §2).
 *
 * Task association (04 §2, architecture §7 decision 31):
 *  - `declareTask` is called by the `match_recipe` tool ALWAYS (matched or `no_match`) and by
 *    `compile_recipe` when the session has no task yet — there is no `name_task` tool (the 13
 *    tool budget is full, 03 §8/05 §6.6);
 *  - `finishTask` is called (a) by `compile_recipe` on `ok: true` (mode_end from the session
 *    row), (b) by the `Stop` hook through `record --stdin` / the socket (`ok` inferred: the
 *    last observation was `ok` and no guided run of this session is in `fallback`), and (c) by
 *    `guided.reportStep` on `done`. It emits the `task` event (08 §2/§3) with the session
 *    counters, stores `task_end_seq` for the compiler's slice and resets the counters.
 *
 * Layer: session (imports context, tree, scrub, signature, identify, resolve, paths, events,
 * lifecycle.markVerified).
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import type { AppMapConfig } from './config.ts';
import { driverToolPattern } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { DriverInput, ElementDef, ElementId, Fingerprint, HookPayload, IdentifyResult, IdentifySignalKind, Locator, NameScreenInput, NameScreenResult, Observation, ObservedSignature, RecordObservationInput, RecordResult, ScreenFile, ScrubPolicy, ScrubbedTree, SessionId, SessionMode, TreeNode } from './types.ts';
import {
  DEEP_LINK_REGEX, DEFAULT_LOCATOR_WEIGHTS, UNKNOWN_SCREEN, assertScrubbed, isMarker, markerOfScreen, now,
  probeConditions, roleHintsFor, routeKey,
} from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { trajectoriesDir, trajectoryFile } from './paths.ts';
import { identify } from './identify.ts';
import { resolve as resolveElement } from './resolve.ts';
import { PII_PATTERNS, buildScrubPolicy, perceptionBytes, redactString, scrub } from './scrub.ts';
import { labelNorm, observedSignature, structuralHash } from './signature.ts';
import { centerOf, extractSnapshot, normalizeTree, parentOf, pathOf, siblingIndex, walk } from './tree.ts';
import { markVerified } from './recipes/lifecycle.ts';

/** tool names that cost a screenshot (08 §2 `screenshots` counter) */
const SCREENSHOT_RE = /screenshot|screen_shot|capture_image/i;
/** `mcp__app-map__*` failures are logged, never recorded (05 §3 PostToolUseFailure matcher) */
const SERVER_TOOL_RE = /^mcp__app-map__/;
/** the observation carries no snapshot: nothing was perceived (02 §7) */
const NO_SIGNATURE: ObservedSignature = { marker: 'none', structural_hash: 'none', required_present: 0 };

/** `^mcp__<driver>__` (config.driverToolPattern). */
export function isDriverTool(config: Pick<AppMapConfig, 'driver'>, toolName: string | undefined): boolean {
  if (typeof toolName !== 'string' || toolName === '') return false;
  return driverToolPattern(config as Pick<AppMapConfig, 'driver'>).test(toolName);
}

/** one scrub policy per loaded map — rebuilding it per observation would blow the 50 ms budget (03 §2) */
const policyCache = new WeakMap<object, ScrubPolicy>();
function policyFor(ctx: AppMapContext): ScrubPolicy {
  const key = ctx.map as unknown as object;
  let policy = policyCache.get(key);
  if (policy === undefined) {
    policy = buildScrubPolicy(ctx.map.ids, ctx.map.staticLabels);
    policyCache.set(key, policy);
  }
  return policy;
}

function asDriverInput(x: unknown): DriverInput {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? { ...(x as DriverInput) } : {};
}

/** `structuredContent.latency_ms` when the driver reports it, else 0 (module doc). */
function latencyOf(toolResponse: unknown): number {
  if (toolResponse === null || typeof toolResponse !== 'object') return 0;
  const sc = (toolResponse as { structuredContent?: unknown }).structuredContent;
  const n = sc !== null && typeof sc === 'object' ? (sc as { latency_ms?: unknown }).latency_ms : undefined;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
}

/** `structuredContent.ok === false` is a driver-reported failure even on a PostToolUse hook */
function responseOk(toolResponse: unknown): boolean {
  if (toolResponse === null || typeof toolResponse !== 'object') return true;
  const sc = (toolResponse as { structuredContent?: unknown }).structuredContent;
  if (sc === null || typeof sc !== 'object') return true;
  return (sc as { ok?: unknown }).ok !== false;
}

function requireSession(payload: HookPayload): SessionId {
  const id = payload?.session_id;
  if (typeof id !== 'string' || id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'hook payload has no session_id', 'the PostToolUse hook passes `session_id` on stdin (05 §3)');
  }
  return id;
}

/** every registered id present on a tree, in document order */
function idsPresent(tree: ScrubbedTree | null): Map<string, TreeNode> {
  const out = new Map<string, TreeNode>();
  if (tree === null) return out;
  walk(tree, (n) => {
    if (typeof n.a11y_id === 'string' && n.a11y_id !== '' && !out.has(n.a11y_id)) out.set(n.a11y_id, n);
  });
  return out;
}

/**
 * Step 4: the element the driver acted on. `input.id` wins when it is registered; otherwise a
 * tap by text/point is mapped back to an element of `screenBefore` using the PREVIOUS snapshot
 * (the state the tap was aimed at) — best effort, may be absent (04 §2).
 */
function resolveActedElement(ctx: AppMapContext, input: DriverInput, screenBefore: string, previous: ScrubbedTree | null): ElementId | undefined {
  if (typeof input.id === 'string' && ctx.map.elementRegistry.has(input.id)) return input.id;
  const screen = ctx.map.screens.get(screenBefore);
  if (screen === undefined || previous === null) return undefined;

  // the node the driver was told to hit
  let target: TreeNode | undefined;
  if (typeof input.text === 'string' && input.text !== '') {
    walk(previous, (n) => { if (target === undefined && n.label === input.text) target = n; });
  } else if (typeof input.x === 'number' && typeof input.y === 'number') {
    const vp = previous.viewport;
    const x = vp ? input.x / vp.w : input.x;
    const y = vp ? input.y / vp.h : input.y;
    walk(previous, (n) => {
      const b = n.bbox_norm;
      if (b !== undefined && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) target = n; // deepest wins
    });
  }
  if (target !== undefined) {
    for (const def of screen.elements) {
      const hit = resolveElement(ctx.map, def, previous);
      if (hit.status === 'hit' && hit.node === target) return def.id;
    }
  }
  // 04 §3.3: a tap by TEXT on a screen whose data text the scrubber dropped (07 §2.3) is a data
  // row — attributable only when the screen declares exactly one dynamic cell
  if (typeof input.text === 'string' && input.text !== '') {
    const cells = screen.elements.filter((e) => e.dynamic === true && e.role === 'cell');
    if (cells.length === 1) return cells[0]!.id;
  }
  return undefined;
}

/**
 * Steps 2–5 without persistence: build the `Observation` for a hook payload. `seq` is taken
 * from `opts.seq` (tests) or allocated via `ctx.db.nextSeq`. Throws `bad_input` for payloads
 * without `session_id`/`tool_name`.
 */
export function hookPayloadToObservation(ctx: AppMapContext, payload: HookPayload, opts: { now?: Date; seq?: number } = {}): Observation {
  const session = requireSession(payload);
  const tool = payload.tool_name;
  if (typeof tool !== 'string' || tool === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'hook payload has no tool_name', 'the PostToolUse hook passes `tool_name` on stdin (05 §3)');
  }
  const input = asDriverInput(payload.tool_input);

  // 2. raw tree → normalize → scrub. The raw tree exists only inside this function (03 §7).
  let snapshot: ScrubbedTree | null = null;
  const raw = extractSnapshot(payload.tool_response);
  if (raw !== undefined) {
    try {
      // `roleHints`: a flat driver capture (03 §5, issue #10) carries no element type, so the
      // registry's kinds are what make a registered list row come out `cell` and not `other`
      const tree = normalizeTree(raw, { platform: ctx.map.platform, roleHints: roleHintsFor(ctx.map) });
      // 03 §3: `APP_MAP_BUILD=auto` takes the build the driver reported
      if (ctx.config.build === 'auto' && typeof tree.build === 'string' && tree.build !== '' && tree.build !== ctx.build) ctx.setBuild(tree.build);
      snapshot = scrub(tree, policyFor(ctx));
    } catch (e) {
      // a driver that returns something tree-shaped but broken must not break the session (03 §11)
      ctx.log.warn('observe: snapshot could not be normalized', { tool, error: (e as Error).message });
      snapshot = null;
    }
  }

  // 3. identify
  const previous = ctx.db.lastObservation(session);
  const screen_before: string = previous?.screen_after ?? UNKNOWN_SCREEN;
  let identified: IdentifyResult | undefined;
  if (snapshot !== null) {
    identified = identify(ctx.map, snapshot, {
      ...(typeof input.url === 'string' ? { route: input.url } : {}),
      build: ctx.build,
      ...probeConditions(ctx.probe),
    });
  }
  const screen_after: string = identified?.screen_id ?? UNKNOWN_SCREEN;
  // the cache, not the map: heals and `name_screen` land there first, so it holds the current
  // `required_ids`/`dynamic_regions` the lazy re-verify (step 8) will compare against
  const signature_after = snapshot === null
    ? { ...NO_SIGNATURE }
    : observedSignature(snapshot, screenOf(ctx, screen_after));

  // 4. the element acted on
  const element = resolveActedElement(ctx, input, screen_before, previous?.snapshot ?? null);

  // 5. seq, task and the PII sweep over the two strings that survive (architecture §7 decision 13)
  const seq = opts.seq ?? ctx.db.nextSeq(session);
  const sessionRow = ctx.db.getSession(session);
  const ts = (opts.now ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const redactedInput: DriverInput = { ...input };
  if (typeof input.text === 'string') redactedInput.text = redactString(input.text, PII_PATTERNS).value;

  const ok = payload.hook_event_name !== 'PostToolUseFailure' && responseOk(payload.tool_response);
  const obs: Observation = {
    ts,
    session,
    seq,
    ...(sessionRow?.task !== undefined ? { task: redactString(sessionRow.task, PII_PATTERNS).value } : {}),
    tool,
    input: redactedInput,
    ...(element !== undefined ? { element } : {}),
    screen_before,
    screen_after,
    signature_after,
    ...(identified !== undefined ? { gates_present: identified.gates_present } : {}),
    snapshot,
    ok,
    ...(typeof payload.error === 'string' && payload.error !== '' ? { error: redactString(payload.error, PII_PATTERNS).value } : {}),
    latency_ms: latencyOf(payload.tool_response),
    ...(snapshot?.scrub_hits !== undefined ? { scrub_hits: snapshot.scrub_hits } : {}),
    ...(identified !== undefined ? { confidence: identified.confidence } : {}),
  };
  return obs;
}

/** the screen as the session knows it: the cache first (heals and name_screen land there), then the map */
function screenOf(ctx: AppMapContext, id: string): ScreenFile | undefined {
  return ctx.db.getScreen(id) ?? ctx.map.screens.get(id);
}

/**
 * Step 7: the winning 03 §5 signal, re-derived from the stored observation (the `identify`
 * event carries it; the observation does not store the signal list).
 */
function winningSignal(ctx: AppMapContext, obs: Observation): IdentifySignalKind {
  if (obs.screen_after === UNKNOWN_SCREEN) return 'none';
  const screen = screenOf(ctx, obs.screen_after);
  if (obs.signature_after.marker === markerOfScreen(obs.screen_after)) return 'marker';
  if (typeof obs.input.url === 'string' && ctx.map.routes.get(routeKey(obs.input.url)) === obs.screen_after) return 'route';
  if (obs.signature_after.required_present >= 0.5) return 'required_ids';
  if (screen?.signature.structural_hash === obs.signature_after.structural_hash) return 'structural_hash';
  return 'title';
}

/**
 * Step 8 (02 §8, 08 §5 row 5): the marker is present, every `required_ids` entry is there and
 * the structural hash still matches the committed one (or one of the variants').
 */
function isLazyReverify(ctx: AppMapContext, obs: Observation, signal: IdentifySignalKind): boolean {
  if (signal !== 'marker' || obs.snapshot === null) return false;
  const screen = screenOf(ctx, obs.screen_after);
  if (screen === undefined) return false;
  if (obs.signature_after.required_present < 1) return false;
  const hash = obs.signature_after.structural_hash;
  if (screen.signature.structural_hash === hash) return true;
  return (screen.variants ?? []).some((v) => v.structural_hash === hash);
}

/** Steps 6–8: persist an already-built observation and return the socket/CLI/tool result. Asserts the snapshot is scrubbed. */
export function ingestObservation(ctx: AppMapContext, obs: Observation): RecordResult {
  if (!obs || typeof obs.session !== 'string' || obs.session === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'observation has no session', 'build it with hookPayloadToObservation');
  }
  // 03 §7 / 07 §8: raw trees never touch disk — the trajectory writer asserts before the db does
  if (obs.snapshot !== null) assertScrubbed(obs.snapshot, 'observe.ingestObservation');

  // 6a. trajectory line (02 §7); a failed append must not fail the driver call (05 §3)
  try {
    mkdirSync(trajectoriesDir(ctx.config), { recursive: true });
    appendFileSync(trajectoryFile(ctx.config, obs.session), `${JSON.stringify(obs)}\n`, 'utf8');
  } catch (e) {
    ctx.log.warn('observe: trajectory append failed', { session: obs.session, error: (e as Error).message });
  }

  // 6b. cache + counters
  ctx.db.insertObservation(obs);
  if (obs.screen_after !== UNKNOWN_SCREEN) {
    ctx.db.setScreenLastSeen(obs.screen_after, obs.ts);
    ctx.db.bumpCounter('screen', obs.screen_after, 'seen');
  }
  const touched = obs.element ?? (typeof obs.input.id === 'string' ? obs.input.id : undefined);
  if (touched !== undefined) ctx.db.bumpCounter('element', touched, obs.ok ? 'hits' : 'misses');
  const row = ctx.db.getSession(obs.session);
  ctx.db.upsertSession({
    session: obs.session,
    driver_calls: (row?.driver_calls ?? 0) + 1,
    perception_bytes: (row?.perception_bytes ?? 0) + (obs.snapshot === null ? 0 : perceptionBytes(obs.snapshot)),
    screenshots: (row?.screenshots ?? 0) + (SCREENSHOT_RE.test(obs.tool) ? 1 : 0),
  });

  // 7. identify event (08 §2)
  const signal = winningSignal(ctx, obs);
  ctx.events.append({
    kind: 'identify', session: obs.session, screen: obs.screen_after, confidence: obs.confidence ?? 0,
    signal, build: ctx.build,
    ...(obs.gates_present !== undefined && obs.gates_present.length > 0 ? { gates_present: obs.gates_present } : {}),
  });

  // 8. lazy re-verify (02 §8, 08 §5 row 5)
  if (isLazyReverify(ctx, obs, signal)) markVerified(ctx, { screens: [obs.screen_after] }, ctx.build);

  return {
    screen_before: obs.screen_before,
    screen_after: obs.screen_after,
    seq: obs.seq,
    gates_present: obs.gates_present ?? [],
    scrub_hits: obs.scrub_hits ?? 0,
  };
}

/**
 * The whole ingest path for one hook payload (`record --stdin`, the ingest socket).
 * Returns `null` when the payload is not a driver call (nothing recorded, exit 0 — never block
 * the agent, 05 §3). A `Stop` payload calls `finishTask` for `session_id` (when a task is open)
 * and returns `null`.
 */
export function recordHookPayload(ctx: AppMapContext, payload: HookPayload): RecordResult | null {
  const session = requireSession(payload);
  // 0. Stop closes the session's task (architecture §2.1 step 0, decision 31)
  if (payload.hook_event_name === 'Stop') {
    const row = ctx.db.getSession(session);
    if (row?.task !== undefined && row.task_end_seq === undefined) finishTask(ctx, session, inferTaskOutcome(ctx, session));
    return null;
  }
  // 1. non-driver tools are ignored; an app-map tool failure is logged only (05 §3)
  if (!isDriverTool(ctx.config, payload.tool_name)) {
    if (payload.hook_event_name === 'PostToolUseFailure' && SERVER_TOOL_RE.test(payload.tool_name ?? '')) {
      ctx.log.warn('app-map tool failed', { session, tool: payload.tool_name, error: payload.error });
    }
    return null;
  }
  return ingestObservation(ctx, hookPayloadToObservation(ctx, payload));
}

/** `record_observation` tool (03 §8) — same path with the snapshot passed explicitly. `session` defaults to `'tool'`. */
export function recordObservation(ctx: AppMapContext, input: RecordObservationInput): RecordResult {
  if (!input || typeof input.tool !== 'string' || input.tool === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'record_observation needs a `tool` name', 'e.g. {tool: "mcp__argent__tap", input: {id: "invoice.add.button"}, snapshot, ok: true}');
  }
  const payload: HookPayload = {
    session_id: input.session ?? 'tool',
    hook_event_name: input.ok === false ? 'PostToolUseFailure' : 'PostToolUse',
    tool_name: input.tool,
    tool_input: asDriverInput(input.input),
    tool_response: { structuredContent: { ok: input.ok !== false, snapshot: input.snapshot, latency_ms: input.latency_ms ?? 0 } },
    ...(input.error !== undefined ? { error: input.error } : {}),
  };
  return ingestObservation(ctx, hookPayloadToObservation(ctx, payload));
}

/** Newest observation (for `identify_screen` without snapshot). Prefer the session-scoped form; the unscoped form is for single-window use only. */
export function lastObservation(ctx: AppMapContext, session?: SessionId): Observation | undefined {
  return ctx.db.lastObservation(session);
}

/**
 * `sessions.task_end_seq` has no `null` in `SessionRow` (it is "absent while open"), but the
 * store writes any non-`undefined` value straight through — this is how the column is cleared
 * when a new task opens on the same session.
 */
const CLEAR_TASK_END = null as unknown as number;

/**
 * 04 §2: attach the task text (PII-redacted) to the session; records `task_seq` = current last
 * seq + 1 and `mode`. Called by `match_recipe` (always) and `compile_recipe` (when absent).
 * Re-declaring a different task first `finishTask`s the open one with `ok: false`.
 */
export function declareTask(ctx: AppMapContext, session: SessionId, task: string, mode: SessionMode = 'explore'): void {
  if (typeof session !== 'string' || session === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'declareTask needs a session id', 'pass the harness session_id (05 §3)');
  }
  if (typeof task !== 'string' || task.trim() === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'declareTask needs a task text', 'match_recipe passes the user instruction (04 §2)');
  }
  const redacted = redactString(task.trim(), PII_PATTERNS).value;
  const row = ctx.db.getSession(session);
  if (row?.task !== undefined && row.task_end_seq === undefined) {
    if (row.task === redacted) return; // the same task re-declared (match_recipe called twice) — keep task_seq
    finishTask(ctx, session, { ok: false, mode_end: row.mode });
  }
  const lastSeq = ctx.db.getSession(session)?.last_seq ?? 0;
  ctx.db.upsertSession({ session, task: redacted, task_seq: lastSeq + 1, task_end_seq: CLEAR_TASK_END, mode });
}

/**
 * Close a task: emits the `task` event with the session's counters (08 §2), stores
 * `task_end_seq = last_seq` on the session row (the compiler's default slice end) and resets
 * the counters. No-op when the session has no open task.
 */
export function finishTask(ctx: AppMapContext, session: SessionId, outcome: { ok: boolean; mode_end: SessionMode }): void {
  const row = ctx.db.getSession(session);
  if (row === undefined || row.task === undefined || row.task_end_seq !== undefined) return;
  const observations = ctx.db.listObservations(session, { fromSeq: row.task_seq ?? 1 });
  const first = observations[0];
  const last = observations[observations.length - 1];
  const startMs = Date.parse(first?.ts ?? row.started_at);
  const endMs = Date.parse(last?.ts ?? now());
  const ms = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  ctx.events.append({
    kind: 'task', session, task: row.task, mode_start: row.mode, mode_end: outcome.mode_end, ok: outcome.ok === true,
    driver_calls: row.driver_calls, perception_bytes: row.perception_bytes, screenshots: row.screenshots,
    ms, build: ctx.build,
  });
  ctx.db.upsertSession({ session, task_end_seq: row.last_seq, mode: outcome.mode_end, driver_calls: 0, perception_bytes: 0, screenshots: 0 });
}

/** `ok` for the Stop hook (module doc): last observation ok and no guided run of the session in `fallback`. */
export function inferTaskOutcome(ctx: AppMapContext, session: SessionId): { ok: boolean; mode_end: SessionMode } {
  const last = ctx.db.lastObservation(session);
  const fellBack = ctx.db.listRunsForSession(session, { states: ['fallback'] }).length > 0;
  const runs = ctx.db.listRunsForSession(session);
  const mode_end: SessionMode = runs[0]?.mode ?? ctx.db.getSession(session)?.mode ?? 'explore';
  return { ok: last !== undefined && last.ok === true && !fellBack, mode_end };
}

/** the ranked locator cascade a freshly named element gets (02 §5.1 default weights) */
function locatorsFor(snapshot: ScrubbedTree, node: TreeNode, id: ElementId): Locator[] {
  const locators: Locator[] = [{ strategy: 'a11y_id', value: id, weight: DEFAULT_LOCATOR_WEIGHTS.a11y_id }];
  if (typeof node.label === 'string' && node.label !== '') {
    locators.push({ strategy: 'role_label', value: { role: node.role, label: node.label }, weight: DEFAULT_LOCATOR_WEIGHTS.role_label });
  }
  locators.push({ strategy: 'path', value: pathOf(snapshot, node), weight: DEFAULT_LOCATOR_WEIGHTS.path });
  const c = centerOf(node);
  locators.push({ strategy: 'geometry', value: { x: c.x, y: c.y }, weight: DEFAULT_LOCATOR_WEIGHTS.geometry });
  return locators;
}

/** 02 §5.3 fingerprint from the observed node (never contains values) */
function fingerprintFor(snapshot: ScrubbedTree, node: TreeNode): Fingerprint {
  const parent = parentOf(snapshot, node);
  const fp: Fingerprint = { role: node.role };
  if (typeof node.label === 'string' && node.label !== '') fp.label_norm = labelNorm(node.label);
  if (parent !== undefined) fp.parent_role = parent.role;
  const idx = siblingIndex(snapshot, node);
  if (idx >= 0) fp.sibling_index = idx;
  fp.bbox_norm = { ...node.bbox_norm };
  return fp;
}

/**
 * `name_screen {screen_id, title?, deep_link?}` (03 §5 "creates a candidate screen once the
 * LLM names it", 03 §8) — explore mode only. Construction from the session's newest observation
 * (`no_observation` when none; `bad_input` when its `screen_after` is not `unknown` and differs
 * from `screen_id` — the LLM is naming a screen the map already knows):
 *  - `screen_id` must be registered in ids.yaml `screens[]` (`invalid_map` naming it);
 *    `deep_link` defaults to the registry's, must equal it when both are present, else `none`;
 *  - `signature`: `marker` = `screen.<id>` when the snapshot carries it else `none`; `route` =
 *    the observation's `input.url` when it is a deep link; `required_ids` = registered
 *    non-dynamic ids found on the snapshot; `structural_hash` with `dynamic_regions` = registered
 *    dynamic ids found;
 *  - `elements`: one per registered id present on the snapshot — `role` from the node, `label`
 *    only when the node kept one after scrubbing, locators `a11y_id` (1.0), `role_label` (0.6,
 *    when a label survived), `path` (0.25, `tree.pathOf`), `geometry` (0.1); fingerprint from
 *    the node; `status: candidate`; `intent_critical`/`dynamic` mirrored from ids.yaml;
 *  - `edges: []`, `gates` = the observation's `gates_present`, `meta {sources: [exploration],
 *    status: candidate}`; no `last_verified_build` (02 §8: set on verification only);
 *  - existing screen (from an earlier `name_screen`, still `candidate`) → elements merged
 *    (`created: false`), verified screens are never overwritten (`bad_input`);
 *  - `db.putScreen(screen, {dirty: true, reason: 'name_screen'})`; `export` writes the file.
 */
export function nameScreen(ctx: AppMapContext, input: NameScreenInput): NameScreenResult {
  if (!input || typeof input.screen_id !== 'string' || input.screen_id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'name_screen needs a screen_id', 'e.g. {screen_id: "invoice_new"}');
  }
  const registry = ctx.map.ids.screens.find((s) => s.id === input.screen_id);
  if (registry === undefined) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `name_screen: ${input.screen_id} is not registered in ids.yaml screens[]`, 'add it to ids.yaml (01 R1) — the registry is the id source of truth');
  }
  const obs = ctx.db.lastObservation(input.session);
  if (obs === undefined) {
    throw new AppMapError(ERROR_CODES.NO_OBSERVATION, 'name_screen: the session has no observation yet', 'drive the app once (the PostToolUse hook records it) or call record_observation');
  }
  const sessionRow = ctx.db.getSession(obs.session);
  if (sessionRow !== undefined && sessionRow.mode !== 'explore') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `name_screen is explore mode only (session is in ${sessionRow.mode})`, 'finish the replay first (03 §8)');
  }
  if (obs.screen_after !== UNKNOWN_SCREEN && obs.screen_after !== input.screen_id) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `name_screen: the last observation already identifies as ${obs.screen_after}`, `call get_screen ${obs.screen_after} instead of naming it again`);
  }
  const snapshot = obs.snapshot;
  if (snapshot === null) {
    throw new AppMapError(ERROR_CODES.NO_OBSERVATION, 'name_screen: the last observation carries no snapshot', 'the driver returned no accessibility tree — drive it again');
  }

  // deep link: the registry is authoritative (validate rule 2 / decision 34)
  const registryLink = registry.deep_link !== undefined && registry.deep_link !== 'none' ? registry.deep_link : undefined;
  if (input.deep_link !== undefined && input.deep_link !== 'none' && registryLink !== undefined && routeKey(input.deep_link) !== routeKey(registryLink)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `name_screen: deep_link ${input.deep_link} disagrees with ids.yaml (${registryLink})`, 'migrate the route in ids.yaml first (02 §10 rule 2)');
  }
  const deep_link = registryLink ?? (input.deep_link !== undefined && input.deep_link !== 'none' ? input.deep_link : 'none');

  const present = idsPresent(snapshot);
  const marker = markerOfScreen(input.screen_id);
  const registered: Array<{ id: ElementId; node: TreeNode }> = [];
  const requiredIds: ElementId[] = [];
  const dynamicRegions: ElementId[] = [];
  for (const [id, node] of present) {
    if (isMarker(id)) continue; // markers are the signature, not elements (01 R3)
    const entry = ctx.map.elementRegistry.get(id);
    if (entry === undefined) continue;
    registered.push({ id, node });
    if (entry.dynamic === true) dynamicRegions.push(id);
    else requiredIds.push(id);
  }
  requiredIds.sort();
  dynamicRegions.sort();

  const elements: ElementDef[] = registered
    .map(({ id, node }) => {
      const entry = ctx.map.elementRegistry.get(id)!;
      const def: ElementDef = {
        id,
        role: node.role,
        ...(typeof node.label === 'string' && node.label !== '' ? { label: node.label } : {}),
        ...(entry.intent_critical === true ? { intent_critical: true } : {}),
        ...(entry.dynamic === true ? { dynamic: true } : {}),
        locators: locatorsFor(snapshot, node, id),
        fingerprint: fingerprintFor(snapshot, node),
        status: 'candidate',
      };
      return def;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));

  const screen: ScreenFile = {
    id: input.screen_id,
    kind: 'screen',
    ...(input.title !== undefined ? { title: input.title } : registry.title !== undefined ? { title: registry.title } : {}),
    deep_link,
    signature: {
      marker: present.has(marker) ? marker : 'none',
      ...(typeof obs.input.url === 'string' && DEEP_LINK_REGEX.test(obs.input.url) ? { route: routeKey(obs.input.url) } : {}),
      ...(requiredIds.length > 0 ? { required_ids: requiredIds } : {}),
      structural_hash: structuralHash(snapshot, dynamicRegions),
    },
    ...(dynamicRegions.length > 0 ? { dynamic_regions: dynamicRegions } : {}),
    ...(obs.gates_present !== undefined && obs.gates_present.length > 0 ? { gates: [...obs.gates_present].sort() } : {}),
    elements,
    edges: [],
    // 02 §8: `last_verified_build` is stamped by verification only, never at naming time
    meta: { sources: ['exploration'], status: 'candidate' },
  };

  const existing = ctx.db.getScreen(input.screen_id) ?? ctx.map.screens.get(input.screen_id);
  let created = true;
  if (existing !== undefined) {
    if (existing.meta.status !== 'candidate') {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `name_screen: ${input.screen_id} is already ${existing.meta.status}`, 'a verified screen is only changed by a reviewed edit or a heal (04 §7.3)');
    }
    created = false;
    const merged = new Map(existing.elements.map((e) => [e.id, e]));
    for (const e of elements) merged.set(e.id, e);
    screen.elements = [...merged.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    screen.edges = existing.edges;
    screen.meta = { ...existing.meta, sources: [...new Set([...existing.meta.sources, 'exploration' as const])].sort(), status: 'candidate' };
  }

  ctx.db.putScreen(screen, { dirty: true, reason: 'name_screen' });
  return { screen, created, from_seq: obs.seq, elements: elements.map((e) => e.id) };
}

/** Read a trajectory file back (compile input); tolerates a truncated last line. */
export function readTrajectory(config: Pick<AppMapConfig, 'dir'>, session: SessionId): Observation[] {
  if (typeof session !== 'string' || session === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'readTrajectory needs a session id', 'e.g. readTrajectory(config, "sess_2026-09-10_0007")');
  }
  let text: string;
  try {
    text = readFileSync(trajectoryFile(config, session), 'utf8');
  } catch {
    return [];
  }
  const out: Observation[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obs = JSON.parse(line) as Observation;
      if (obs !== null && typeof obs === 'object' && typeof obs.seq === 'number') out.push(obs);
    } catch {
      // a writer that died mid-line leaves a torn tail; only that line is lost (02 §7)
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}
