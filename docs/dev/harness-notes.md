# Harness notes (05 §3 implementation record)

What was verified against the official docs on 2026-09-11, what the hooks and scripts in this repo
assume of the `app-map` CLI, and where the implementation deviates from the specs.

## 1. Verified against https://code.claude.com/docs/en/hooks

| topic | verified |
|---|---|
| Event names | `SessionStart`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact` all exist (also `SessionEnd`, `PostCompact`, `SubagentStop`, `PreToolUse`, …). |
| `PostToolUse` stdin | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_use_id`, **`tool_response`** (object). |
| `PostToolUseFailure` stdin | same, but **`tool_error`** instead of `tool_response`. The record hook forwards the payload verbatim; the CLI/socket must accept both. |
| Subagent calls | payloads carry `agent_id` / `agent_type` when the tool ran inside a subagent (answers 05 §8: correlate replayer calls to the parent via `session_id` + `agent_id`). |
| `SessionStart` output | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`; plain stdout is *also* injected as context for this event (used as the no-node fallback). |
| `SessionStart` stdin | includes `matcher_value` ∈ `startup\|resume\|clear\|compact\|fork` — it fires **after compaction** too, which is what re-injects the summary. |
| `PreCompact` | stdin `matcher_value` ∈ `manual\|auto`; **no context-injection channel documented**. See deviation D1. |
| `timeout` | **seconds**; default 600 for `command` hooks. Spec's `5` → 5 s. |
| Matchers | unanchored regex when they contain regex characters; `mcp__argent__.*` and `mcp__argent__.*\|mcp__app-map__.*` are valid. |
| Config shape | `hooks.<Event>[] = {matcher?, hooks: [{type: "command", command, timeout?}]}` — as in 05 §3. |

## 2. Verified against https://code.claude.com/docs/en/sub-agents

- Frontmatter: `name` (lowercase + hyphens), `description`, `tools` (comma-separated string **or** YAML
  list), `model` (`haiku`, `sonnet`, `opus`, `inherit`, or a full id), plus `disallowedTools`,
  `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `effort`, …
- `tools` accepts MCP patterns: `mcp__argent` (whole server) and `mcp__argent__*` (all tools of a
  server). Per-tool globs beyond that are not documented, so `.claude/agents/app-nav-replayer.md`
  lists the tools explicitly exactly as 05 §5 does. **Argent's tool names are now confirmed**
  against `@swmansion/argent@0.25.0` (`argent tools`, 76 tools): `gesture-tap`, `gesture-swipe`,
  `gesture-scroll`, `keyboard` (`--text` types, `--key` presses a named key), `paste`, `open-url`,
  `button`, `tv-remote`, `run-sequence`, `describe`, `native-describe-screen`,
  `native-full-hierarchy`, `screenshot`, `await-ui-element`, `await-screen-idle`,
  `launch-app`/`restart-app`/`reinstall-app`, `native-network-logs`/`view-network-logs`. Neither
  `type_text` nor `open_url` exists — the compiler's mapping lives in
  `tools/app-map-mcp/src/recipes/verbs.ts` (`ARGENT_VERBS`), which the old regexes missed so
  `keyboard` and `open-url` observations were dropped from compiled recipes (issue #9).
- **`native-describe-screen` reports no focus and no enabled flag.** Each element carries exactly
  `frame`, `normalizedFrame`, `normalizedTapPoint`, `tapPoint`, `traits`, `value`, `identifier`,
  `viewClassName`; `traits` carries `button`, `staticText`, `header`, `image`, `selected` and
  never a focus trait. There is no `hasFocus` and no `focused` key, so nothing in an iOS capture
  can tell the harness that a tap focused a field and raised the keyboard. `expect.focused` is
  therefore Android/Maestro-only — `validate` warns on one in an `ios` recipe and the compiler
  writes `visible` instead (04 §10, issue #18). The `focused`/`enabled` fields `tree.ts` reads
  belong to the nested XCUITest-like shape and to Maestro's hierarchy, not to Argent.

## 3. Verified against https://code.claude.com/docs/en/skills

- Location `.claude/skills/<name>/SKILL.md`; `name` optional (display label; command comes from the
  directory), `description` recommended and used for auto-invocation (with optional `when_to_use`;
  combined cap 1,536 chars). `.claude/skills/app-nav/SKILL.md` uses `name` + `description` with the
  trigger words (simulator, emulator, app, screen, flow, recipe) and stays under 800 tokens.

## 4. Assumptions the CLI author must honour (tools/app-map-mcp)

| surface | assumed by | contract |
|---|---|---|
| `app-map summary --max-tokens N [--hook-json]` | session-start hook | plain text on stdout, exit 0. With `--hook-json` the CLI prints the whole 05 §3 envelope (`{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":…}}`) with the summary **and** the fixed preamble inside — that is what the hook uses, so the preamble exists in exactly one place. Without the flag the hook has no way to render the preamble itself (see D3). |
| ingest socket `app-map/.local/ingest.sock` | record hook | newline-delimited JSON, one hook payload per line, exactly as Claude Code sent it (`tool_response` or `tool_error`). **Close the connection after reading the line** so `nc -U` exits immediately (it has a 2 s idle cap otherwise). |
| `app-map record --stdin` | record hook fallback | reads one JSON line from stdin; exit code ignored. Must accept `PostToolUseFailure` payloads (`tool_error`, no `tool_response`). |
| `app-map export` (no `--force`) | stop hook | prints written file paths, one per line; non-zero + diff on the 03 §4 conflict. Output is relayed to stderr. A file whose steps came from an automated recompile (04 §8) is named on **stderr** as `machine recompile: <path> (<reason>)` — stdout stays a bare path list so the hook's parser is unaffected (issue #13). |
| `app-map validate`, `export --check`, `lint-ids`, `gen-configs --check`, `policy-check`, `intent-critical-diff <base-sha> --markdown`, `drift --platform P --router F --out F`, `maestro-export --platform P --status S --out D`, `run --all [--platform P] --status S --headless --report F`, `import-router F` | CI workflow | names/flags as in 06 §3; `policy-check` is the 06 R3 job and `intent-critical-diff` the 07 §7 one (neither is in the 03 §10 table). `drift` prints the 06 R4.4 table on stdout (the PR comment is `tee`'d from it) and exits non-zero only when a `ci_gate` screen is broken. `intent-critical-diff` exits **1** for "an element was downgraded" and other codes for usage/git failures — the workflow distinguishes them. |
| `scripts/app-map/ci-params.sh --platform P` | CI workflow | writes `app-map/.local/ci-params.<platform>.json` from `$APP_MAP_CI_PARAMS`, `app-map/ci-params.<platform>.json` or `instrumentation/<platform>/fixtures/ci-params.json`. `maestro-export` and `run --all` refuse to guess param values (architecture §7 decision 36), so this step must precede both. |
| `heal-report.json` | `scripts/app-map/open-heal-pr.sh` | as `app-map/schema/heal-report.schema.json`: `heals[]` = accepted (exported), `needs_human[]` = rejected, `runs[]` per recipe; each heal has `old_strategy`/`new_strategy`, optional `old_locator`/`new_locator {strategy, value, weight}`, `score`, `runner_up_score`, `reason` enum, `intent_critical`, `build`. The PR body renders exactly those. Contains ids and scores only (07 §2.4). |
| router export | `scripts/app-map/router-export.sh` | file appears at the path given by `-AppMapExport` (iOS) / the broadcast result `data="…"` (Android); JSON has `schema_version`. The script passes the checkout's sha (`SIMCTL_CHILD_APP_MAP_GIT_SHA` / `--es git_sha`) because `build.git_sha` must be 7–40 hex; the packages write the placeholder `0000000` when nothing is wired. |
| hook payload names | `app-map/schema/hook-payload.schema.json` vs the docs | the schema lists `error` and `source`; the current hooks reference names them **`tool_error`** (PostToolUseFailure) and **`matcher_value`** (SessionStart/PreCompact). `additionalProperties: true` keeps both valid — the server should read `tool_error ?? error` and `matcher_value ?? source`. |
| ingest socket path | server | `sun_path` is capped at 108 bytes on Linux/macOS; bind with a path relative to `APP_MAP_DIR` (or `chdir` first) so deep checkouts do not silently truncate. The record hook passes the absolute path to `nc`, which is fine for connecting only if the bind succeeded at the same absolute path. |
| `app-map merge-driver %O %A %B` | `.gitattributes` | 02 §9; opt-in per clone via `git config` (commands in `.gitattributes`). |

## 5. Deviations from the specs

- **D1 — PreCompact.** 05 §3 wires `app-map-session-start.sh` to `PreCompact` expecting it to re-inject
  the summary. The docs give PreCompact no `additionalContext`; re-injection actually happens because
  `SessionStart` fires again with `matcher_value: compact`. The PreCompact entry is kept for spec fidelity
  but the script detects `hook_event_name` and exits 0 silently for anything other than `SessionStart`.
- **D2 — hook timeouts.** 05 §3 sets `timeout: 5` only on the record hooks. The defaults are 600 s, so
  `.claude/settings.json` adds 30 s (SessionStart/PreCompact) and 60 s (Stop) to keep a stuck CLI from
  freezing a session. The scripts bound themselves tighter (`timeout`/watchdog) and always exit 0.
- **D3 — preamble.** The 05 §3 preamble ends with `Recipes: create_invoice, filter_invoices, …`, which the
  hook cannot parse reliably out of free text. The CLI therefore owns it: `summary --hook-json`
  (`src/format.ts formatSessionStartContext`) returns summary + preamble in the finished envelope, and the
  hook just prints it. An earlier version built its own preamble in shell, which duplicated the four rules
  inside `additionalContext` and cost ~60 % more tokens.
- **D3a — hooks export `APP_MAP_DIR`.** The CLI resolves the map from `APP_MAP_DIR`, else from its own
  CWD (`src/config.ts`), and a hook does not control its CWD. All three scripts therefore export
  `APP_MAP_DIR=${APP_MAP_DIR:-$CLAUDE_PROJECT_DIR/app-map}`. Without it an off-root session wrote
  observations into a stray `<cwd>/app-map/`, reported an empty map as "loaded", and exported nothing.
- **D4 — CI gating.** 06 §3 runs the mobile jobs on every PR. The drift/gate/heal/import jobs run only
  when the repository variable `APP_MAP_HAS_APP == 'true'` (skipped, not failed, otherwise) so the
  workflow is green before an app exists. `validate` and `ios-instrumentation` always run — the latter is
  the 01 §4 release proof (`swift test` + `swift test -c release` on the standalone SwiftPM package) and
  needs no app; gating it was what left the release gate unverified. `android-instrumentation` is an AGP
  library that needs the host app's Gradle build, so it stays behind the variable.
- **D5 — router-export.sh handles Android too** (`--platform android`, via the export broadcast) so the
  Android CI job mirrors iOS with one script.
- **D6 — AppMapDebugEndpoint is a UserDefaults probe, not an HTTP endpoint** (07 §3 leaves the transport
  open). Read with `xcrun simctl spawn <udid> defaults export <bundle_id> - | plutil -convert json -o - -`,
  falling back to `plutil -convert xml1 -o - "$(xcrun simctl get_app_container <udid> <bundle_id> data)/Library/Preferences/<bundle_id>.plist"`
  — on iOS 26 `defaults` no longer resolves a sandboxed app's domain, and `-convert json` refuses any
  domain holding a `Data` value (#11).
- **D8 — gen-ids naming rules.** 01 R2 says screens are `snake_case`; `app-map/schema/ids.schema.json` encodes that as `^[a-z][a-z0-9_]*$` and gates as `^gate\.[a-z0-9_]+$`. `gen-ids` and the deep-link parsers use exactly those patterns; the `<feature>.<name>.<kind>` three-segment rule for elements is a warning, not an error, because the schema does not require it.
- **D7 — Android deep link entry.** 01 R5 says the handler routes through the real router; the library
  cannot know the app's activity, so a debug-only transparent trampoline activity owns the `appmap://`
  intent filter and calls the router the app installs (`AppMapDeepLink.installRouter`).

## 6. Things to confirm on first real run

- Whether Argent reports the running build (03 §13) — otherwise set `APP_MAP_BUILD`. (Its tool names are confirmed: see §2.)
- Whether `PostToolUse` can rewrite the driver's tool output (05 §8) — the docs list `updatedInput` for
  PreToolUse only; rely on the driver's snapshot options.
- Maestro's install script honours `MAESTRO_VERSION` (pinned to 2.10.0 in the workflow; the package
  floor is `>=1.39.0`).
- `nc -U` on macOS exits promptly once the socket server closes; if not, add `-N` where supported.
