/**
 * [C1] Observation ingest (02 §7, 03 §2, 03 §7, 03 §8 `record_observation`, 04 §2, 05 §3).
 *
 * Ingest path (hook or socket or tool):
 *  1. `isDriverTool(config, payload.tool_name)` — non-driver tools are ignored (return `null`),
 *     except `PostToolUseFailure` for `mcp__app-map__*` which is logged only;
 *  2. `extractSnapshot(tool_response)` → `normalizeTree` → `scrub` (RAW TREES NEVER TOUCH DISK,
 *     03 §7); a driver response without a tree yields `snapshot: null`;
 *  3. `identify(map, scrubbedTree, {route: input.url, build})` → `screen_after`, `gates_present`;
 *     `screen_before` = previous observation's `screen_after` in this session (or `unknown`);
 *  4. resolved `element`: `input.id` when it is a registered element id; else, for a tap with
 *     `text`/point on a known `screen_before`, the element whose locator resolves to the tapped
 *     node (resolve.ts) — best-effort, may be absent (04 §2);
 *  5. `seq = db.nextSeq(session)`, `task` = session's declared task (04 §2);
 *  6. persist: append the JSON line to `trajectoryFile(config, session)`, `db.insertObservation`,
 *     `db.setScreenLastSeen`, bump `screen.seen` and element `hits`/`misses`, session
 *     `driver_calls`/`perception_bytes` (+`screenshots` when the tool name contains `screenshot`);
 *  7. emit an `identify` event (08 §2) with `signal` = the winning signal or `none`.
 *
 * `latency_ms` is taken from `structuredContent.latency_ms` when the driver reports it, else 0.
 * Must run in <50 ms end to end so the socket path stays cheap (03 §2).
 *
 * Layer: session (imports context, tree, scrub, signature, identify, resolve, paths, events).
 */
import type { AppMapConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { HookPayload, Observation, RecordObservationInput, RecordResult, SessionId, SessionMode } from './types.ts';
import { NotImplementedError } from './errors.ts';

/** `^mcp__<driver>__` (config.driverToolPattern). */
export function isDriverTool(config: Pick<AppMapConfig, 'driver'>, toolName: string | undefined): boolean {
  void config; void toolName;
  throw new NotImplementedError('observe.isDriverTool');
}

/**
 * Steps 2–5 without persistence: build the `Observation` for a hook payload. `seq` is taken
 * from `opts.seq` (tests) or allocated via `ctx.db.nextSeq`. Throws `bad_input` for payloads
 * without `session_id`/`tool_name`.
 */
export function hookPayloadToObservation(ctx: AppMapContext, payload: HookPayload, opts: { now?: Date; seq?: number } = {}): Observation {
  void ctx; void payload; void opts;
  throw new NotImplementedError('observe.hookPayloadToObservation');
}

/** Steps 6–7: persist an already-built observation and return the socket/CLI/tool result. */
export function ingestObservation(ctx: AppMapContext, obs: Observation): RecordResult {
  void ctx; void obs;
  throw new NotImplementedError('observe.ingestObservation');
}

/**
 * The whole ingest path for one hook payload (`record --stdin`, the ingest socket).
 * Returns `null` when the payload is not a driver call (nothing recorded, exit 0 — never block
 * the agent, 05 §3).
 */
export function recordHookPayload(ctx: AppMapContext, payload: HookPayload): RecordResult | null {
  void ctx; void payload;
  throw new NotImplementedError('observe.recordHookPayload');
}

/** `record_observation` tool (03 §8) — same path with the snapshot passed explicitly. `session` defaults to `'tool'`. */
export function recordObservation(ctx: AppMapContext, input: RecordObservationInput): RecordResult {
  void ctx; void input;
  throw new NotImplementedError('observe.recordObservation');
}

/** Newest observation (for `identify_screen` without snapshot, `report_step` verification). */
export function lastObservation(ctx: AppMapContext, session?: SessionId): Observation | undefined {
  void ctx; void session;
  throw new NotImplementedError('observe.lastObservation');
}

/** 04 §2: attach the task text from `match_recipe` / `name_task`; records `task_seq` = current last seq + 1. */
export function declareTask(ctx: AppMapContext, session: SessionId, task: string, mode: SessionMode = 'explore'): void {
  void ctx; void session; void task; void mode;
  throw new NotImplementedError('observe.declareTask');
}

/** Close a task: emits the `task` event with the session's counters (08 §2) and resets them. */
export function finishTask(ctx: AppMapContext, session: SessionId, outcome: { ok: boolean; mode_end: SessionMode }): void {
  void ctx; void session; void outcome;
  throw new NotImplementedError('observe.finishTask');
}

/** Read a trajectory file back (compile input); tolerates a truncated last line. */
export function readTrajectory(config: Pick<AppMapConfig, 'dir'>, session: SessionId): Observation[] {
  void config; void session;
  throw new NotImplementedError('observe.readTrajectory');
}
