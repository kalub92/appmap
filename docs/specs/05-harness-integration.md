# 05 — Harness Integration

Status: draft v0.1 · Depends on: 03, 04 · Consumed by: 06, 08

## 1. Purpose

Wire the app-map server into Claude Code (primary) and Cursor/Codex (generated config) so that every session starts with the map, every driver call is recorded out-of-band, and the LLM reaches for a recipe before it reaches for a guess. Nothing in this spec holds map state; the harness only relays.

## 2. MCP configuration

Committed, project-scoped `.mcp.json`. Secrets never appear as literals; everything is `${VAR}` or a relative path. `CLAUDE_PROJECT_DIR` is not guaranteed at parse time, hence the `:-.` default.

```json
{
  "mcpServers": {
    "app-map": {
      "command": "node",
      "args": ["${CLAUDE_PROJECT_DIR:-.}/tools/app-map-mcp/dist/index.js"],
      "env": {
        "APP_MAP_DIR": "${CLAUDE_PROJECT_DIR:-.}/app-map",
        "APP_MAP_PLATFORM": "${APP_MAP_PLATFORM:-ios}",
        "APP_MAP_LOG_LEVEL": "${APP_MAP_LOG_LEVEL:-info}"
      }
    },
    "argent": {
      "command": "npx",
      "args": ["-y", "@swmansion/argent@<pinned-version>"]
    }
  }
}
```

- `argent` is pinned to an exact version; moving to a vendored install is tracked in 07 §5.
- Each developer approves the project-scoped servers once on first run (Claude Code trust prompt). If the org enables `allowManagedMcpServersOnly`, both servers must be on the managed allowlist first (07 §6).
- `app-map gen-configs` generates `.cursor/mcp.json` (same JSON, `mcpServers` key) and `.codex/config.toml` (`[mcp_servers.app-map]` / `[mcp_servers.argent]`). Generated files are committed; CI checks they match (06 R2). Codex loads project config only for trusted projects.

## 3. Hooks

`.claude/settings.json` (committed):

```json
{
  "hooks": {
    "SessionStart": [
      {"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/app-map-session-start.sh"}]}
    ],
    "PostToolUse": [
      {"matcher": "mcp__argent__.*",
       "hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/app-map-record.sh", "timeout": 5}]}
    ],
    "PostToolUseFailure": [
      {"matcher": "mcp__argent__.*|mcp__app-map__.*",
       "hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/app-map-record.sh", "timeout": 5}]}
    ],
    "Stop": [
      {"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/app-map-session-stop.sh"}]}
    ],
    "PreCompact": [
      {"hooks": [{"type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/app-map-session-start.sh"}]}
    ]
  }
}
```

Hook scripts are reviewed like code (07 §5). Contracts:

| script | reads | does | emits |
|---|---|---|---|
| `app-map-session-start.sh` | stdin JSON (`session_id`, `cwd`) | `app-map summary --max-tokens 600` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<summary + rules>"}}` |
| `app-map-record.sh` | stdin JSON (`session_id`, `tool_name`, `tool_input`, `tool_response`) | posts to ingest socket, falls back to `app-map record --stdin` | nothing; exit 0 always, even on failure — never block the agent |
| `app-map-session-stop.sh` | stdin JSON | `app-map export` (non-forcing); prints files written to stderr | nothing |

The `additionalContext` injected at SessionStart is the summary plus a fixed preamble:

```
app-map is loaded for <platform> build <build>. Before driving the simulator:
1. call mcp__app-map__match_recipe with the task; if it matches, run_recipe (guided) and follow report_step.
2. otherwise call identify_screen, then get_screen, before any tap. Prefer plan_path deep links.
3. do not take screenshots unless the accessibility tree is empty.
4. when a new task succeeds, call compile_recipe and review the draft.
Recipes: create_invoice, filter_invoices, …
```

Verify field names (`tool_response`, `hookSpecificOutput`, `PostToolUseFailure`) against the current hooks reference at implementation time; this surface has changed repeatedly.

## 4. Skill

`.claude/skills/app-nav/SKILL.md` — progressive-disclosure instructions loaded when the task mentions the simulator, the app, a screen, or a flow. Contents: the four rules above expanded with examples, the ladder (00 §3), the fallback protocol (04 §5), and "how to review a compiled recipe" (check `matches`, params, `intent_critical` steps). Keep under 800 tokens; link to the specs for detail.

## 5. Replayer subagent

`.claude/agents/app-nav-replayer.md`:

```markdown
---
name: app-nav-replayer
description: Replays a known app-map recipe step by step on the simulator. Use for any task that match_recipe resolves.
tools: mcp__app-map__run_recipe, mcp__app-map__report_step, mcp__app-map__identify_screen, mcp__argent__gesture-tap, mcp__argent__keyboard, mcp__argent__open-url, mcp__argent__gesture-swipe, mcp__argent__await-ui-element
model: haiku
---
You execute exactly the step the app-map server returns, then call report_step. You never take screenshots, never call get_screen, and never improvise. If report_step returns fallback, stop and return the fallback payload to the caller.
```

The main agent delegates matched tasks here; exploration stays on the main model. This is the model-routing lever: cheap model for replay, large model for recovery.

The tool names above are the ones `@swmansion/argent@0.25.0` actually registers, confirmed against `argent tools` (issues #9, #21) — they are **hyphenated**, and neither `tap`, `type_text`, `open_url` nor `swipe` exists. Four of them carry the four 02 §6 step verbs (`gesture-tap` → `tap`, `keyboard` → `type`, `open-url` → `open_link`, `gesture-swipe` → `swipe`); a `select` step replays as a tap on the matched row (04 §3.3, issue #19), so it needs no tool of its own.

`await-ui-element` is the fifth, and the one grant that is not a step verb. Every step the server hands out may carry a `settle` hint — the postcondition `report_step` is about to check anyway — and the replayer polls for it instead of sleeping between the action and the report (04 §5, issue #26). Without the grant the instruction is inert and the subagent falls back to a fixed sleep, which measured ~1.8× slower across a real suite and is *less* reliable, since a slow network outruns a hard-coded wait. It stays compatible with §6 rule 1: the poll answers a boolean about one selector, it does not read the tree, so it is not perception and costs no tokens. `verbs.ts` classifies it `lifecycle`, and `verbs.test.ts` admits it by name rather than by kind so no other non-step tool can arrive with it. The `tools` field accepts `mcp__argent` (whole server) and `mcp__argent__*` (all of a server's tools) but no per-tool glob, so the list stays explicit — and narrow, per §6 rule 6. `tools/app-map-mcp/src/recipes/verbs.ts` (`ARGENT_VERBS`) is the machine-readable copy of the same table, and `verbs.test.ts` pins this block and the subagent file to it so neither can drift back to a name the driver does not answer to.

## 6. Token rules for exploration

Enforced by the skill and, where the harness allows, by hooks:

1. Accessibility tree over screenshots. Screenshot only when the tree is empty or the task is visual (layout bug).
2. Ask the driver for compact snapshots if it supports a filter; never request the full hierarchy twice for the same unchanged screen.
3. `get_screen` at most once per screen visit; the server caps it at 400 tokens.
4. Enter via `plan_path` deep links; navigation by tapping is the fallback.
5. Do not paste trees back into `record_observation` when hooks are active; the hook already recorded them.
6. Tool-definition overhead: the app-map server registers ≤13 tools with short descriptions; keep Argent's tool surface to what the task needs if the harness supports deferred tool loading.

Optional (phase 2): a PreToolUse hook on `mcp__argent__gesture-tap` that consults `find_element` and rewrites a text-based or coordinate-based tap into the element's `a11y_id` via `updatedInput`. Only if measurement (08) shows the LLM still guesses locators on known screens.

## 7. Acceptance criteria

- [ ] Fresh clone → `claude` → approve servers → `summary` context visible in the first turn without any manual step.
- [ ] Driving the pilot flow with Argent produces a trajectory in `app-map/.local/trajectories/` with correct `screen_before/after` on every observation, with no tree content passing through the LLM twice.
- [ ] Stop hook exports dirty durable changes; `git status` shows only the expected screen/recipe files.
- [ ] The `app-nav-replayer` subagent completes `create_invoice` in guided mode on the cheap model.
- [ ] `.cursor/mcp.json` and `.codex/config.toml` are generated and load the app-map server in those harnesses (smoke test only).

## 8. Open questions

- Whether Claude Code's PostToolUse can rewrite the driver's tool output (to strip a full tree down to a diff). If it can, add it; if not, rely on the driver's own snapshot options.
- Session correlation across subagents: confirm the subagent's driver calls carry a `session_id` the hook can map to the parent run.
