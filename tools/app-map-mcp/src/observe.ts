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
import type { AppMapConfig } from './config.ts';
import type { AppMapContext } from './context.ts';
import type { HookPayload, NameScreenInput, NameScreenResult, Observation, RecordObservationInput, RecordResult, SessionId, SessionMode } from './types.ts';
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

/** Steps 6–8: persist an already-built observation and return the socket/CLI/tool result. Asserts the snapshot is scrubbed. */
export function ingestObservation(ctx: AppMapContext, obs: Observation): RecordResult {
  void ctx; void obs;
  throw new NotImplementedError('observe.ingestObservation');
}

/**
 * The whole ingest path for one hook payload (`record --stdin`, the ingest socket).
 * Returns `null` when the payload is not a driver call (nothing recorded, exit 0 — never block
 * the agent, 05 §3). A `Stop` payload calls `finishTask` for `session_id` (when a task is open)
 * and returns `null`.
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

/** Newest observation (for `identify_screen` without snapshot). Prefer the session-scoped form; the unscoped form is for single-window use only. */
export function lastObservation(ctx: AppMapContext, session?: SessionId): Observation | undefined {
  void ctx; void session;
  throw new NotImplementedError('observe.lastObservation');
}

/**
 * 04 §2: attach the task text (PII-redacted) to the session; records `task_seq` = current last
 * seq + 1 and `mode`. Called by `match_recipe` (always) and `compile_recipe` (when absent).
 * Re-declaring a different task first `finishTask`s the open one with `ok: false`.
 */
export function declareTask(ctx: AppMapContext, session: SessionId, task: string, mode: SessionMode = 'explore'): void {
  void ctx; void session; void task; void mode;
  throw new NotImplementedError('observe.declareTask');
}

/**
 * Close a task: emits the `task` event with the session's counters (08 §2), stores
 * `task_end_seq = last_seq` on the session row (the compiler's default slice end) and resets
 * the counters. No-op when the session has no open task.
 */
export function finishTask(ctx: AppMapContext, session: SessionId, outcome: { ok: boolean; mode_end: SessionMode }): void {
  void ctx; void session; void outcome;
  throw new NotImplementedError('observe.finishTask');
}

/** `ok` for the Stop hook (module doc): last observation ok and no guided run of the session in `fallback`. */
export function inferTaskOutcome(ctx: AppMapContext, session: SessionId): { ok: boolean; mode_end: SessionMode } {
  void ctx; void session;
  throw new NotImplementedError('observe.inferTaskOutcome');
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
  void ctx; void input;
  throw new NotImplementedError('observe.nameScreen');
}

/** Read a trajectory file back (compile input); tolerates a truncated last line. */
export function readTrajectory(config: Pick<AppMapConfig, 'dir'>, session: SessionId): Observation[] {
  void config; void session;
  throw new NotImplementedError('observe.readTrajectory');
}
