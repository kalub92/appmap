# app-map

**app-map** is a machine-readable map of a mobile app — screens, stable element ids, locator
cascades, navigation edges, gates and replayable recipes — that lets a coding agent (Claude Code
first; Cursor/Codex via generated config) operate the app on a simulator without re-discovering it
every session. The app is instrumented once with stable ids, screen markers, test-only deep links and
a router export (spec 01); an MCP server (spec 03) loads the map, identifies the current screen from
the accessibility tree, resolves elements by ranked locators, and records every driver call out of
band through harness hooks (spec 05). A successful exploration is compiled into a recipe (spec 04)
that replays guided (cheap model, one step at a time) or headless (Maestro, zero LLM calls), heals
locators when the UI drifts, and hands control back to the model only at the step that broke.

Everything durable lives in git as per-entity YAML under `app-map/` (spec 02) and is kept truthful by
CI: schema validation, id lint, drift tours against every PR build, gate recipes as a regression
suite, and nightly heal PRs that a human reviews (spec 06). Security is by construction (spec 07):
only UI structure is stored, values and PII are scrubbed at ingest, recipes run only against Debug
builds with sandbox fixtures, and the tool chain is vendored and pinned. Metrics and the rollout
plan are in spec 08.

## Repository layout

```
.mcp.json                   project-scoped MCP servers: app-map (in-repo, stdio) + Argent (pinned)   05 §2
.claude/
  settings.json             hooks: SessionStart, PostToolUse(argent), PostToolUseFailure, Stop, PreCompact   05 §3
  hooks/                    app-map-session-start.sh · app-map-record.sh · app-map-session-stop.sh
  skills/app-nav/SKILL.md   the four rules, the ladder, the fallback protocol                       05 §4
  agents/app-nav-replayer.md cheap-model replayer subagent                                          05 §5
app-map/                    the map: ids.yaml, schema/, ios/, android/, policy/ (+ git-ignored .local/)   02
tools/app-map-mcp/          MCP server + CLI (TypeScript, Node ≥ 22)                                  03
instrumentation/
  ios/AppMapKit/            Swift package: markers, deep links, router export, fixtures, debug probe  01
  android/appmap/           Gradle library module, same surfaces                                     01
  README.md                 how to adopt in the real app
scripts/
  app-map/gen-ids           ids.yaml → AppMapID.swift / AppMapId.kt (--check in CI)                  01 R1, 06 R2
  app-map/router-export.sh  run the app's router export on a simulator/emulator                      01 R6
  app-map/open-heal-pr.sh   nightly heal → reviewable PR, never merges                               06 R6
  app-map/strings-export.sh static string tables for the scrubber                                    07 §2.3
  build-app.sh              documented stub for the real app build                                   06 §3
.github/workflows/app-map.yml  validate · drift/gate (iOS, Android) · nightly-heal · router-import   06
CODEOWNERS · .gitattributes    review policy (07 §7) · semantic YAML merge driver (02 §9)
docs/specs/                 the eight specs (01–08)
docs/dev/                   toolchain.md · harness-notes.md · rollout.md · architecture.md
```

## Quick start

```sh
# 1. build the server + CLI (Node ≥ 22.13; deps are pinned, never npx'd at runtime)
npm ci --prefix tools/app-map-mcp && npm run build --prefix tools/app-map-mcp

# 2. open Claude Code in the repo root and approve the two project-scoped servers when prompted
claude
#    → the SessionStart hook injects `app-map summary` plus the navigation rules into the first turn

# 3. pilot flow: boot a simulator with a Debug build of the app, then ask for a task
#    "create an invoice for $50 for Acme"
#    match_recipe → run_recipe (guided) → report_step … ; every mcp__argent__* call is recorded by the
#    PostToolUse hook; the Stop hook exports dirty map changes to app-map/**/*.yaml for review.

# useful commands
tools/app-map-mcp/bin/app-map validate            # 02 §10
tools/app-map-mcp/bin/app-map export              # cache → canonical YAML
scripts/app-map/gen-ids                           # regenerate id constants after editing app-map/ids.yaml
tools/app-map-mcp/bin/app-map gen-configs         # .cursor/mcp.json + .codex/config.toml from .mcp.json
```

Optional, once per clone (02 §9): the semantic YAML merge driver — see the commands in `.gitattributes`.

## Documentation

- Specs: [01 instrumentation](docs/specs/01-app-instrumentation.md) · [02 data model](docs/specs/02-app-map-data-model.md) · [03 MCP server](docs/specs/03-app-map-mcp-server.md) · [04 recipes, replay, healing](docs/specs/04-recipes-replay-and-healing.md) · [05 harness](docs/specs/05-harness-integration.md) · [06 CI and drift](docs/specs/06-ci-and-drift.md) · [07 security and governance](docs/specs/07-security-and-governance.md) · [08 metrics and rollout](docs/specs/08-metrics-and-rollout.md)
- Developer notes: [toolchain](docs/dev/toolchain.md) · [harness notes (verified hook fields, CLI assumptions, deviations)](docs/dev/harness-notes.md) · [rollout, baseline and thresholds](docs/dev/rollout.md) · [architecture](docs/dev/architecture.md)
- Adopting in the app: [instrumentation/README.md](instrumentation/README.md)

## Status

| spec area | in this repo | needs the real app |
|---|---|---|
| 01 instrumentation | `gen-ids`, AppMapKit (Swift) and `appmap` (Kotlin) reference implementations with unit tests (not compiled here) | integrating the package/module, marking screens, fixtures, registering the URL scheme, `lint-ids` passing |
| 02 data model | schemas, `ids.yaml`, pilot YAML under `app-map/` (server author) | verifying the pilot files against real screens |
| 03 MCP server / CLI | `tools/app-map-mcp` (server author); CLI names used by hooks/CI are listed in `docs/dev/harness-notes.md` §4 | build number from the running app; Argent tool names |
| 04 recipes | compiler/replay/heal in the server | a recorded session to compile |
| 05 harness | `.mcp.json`, hooks, skill, replayer agent — verified against the current hooks/sub-agents/skills docs | approving the servers; `gen-configs` output for Cursor/Codex |
| 06 CI | `app-map.yml`: `validate` runs now; mobile jobs are gated on the repo variable `APP_MAP_HAS_APP=true` | `scripts/build-app.sh` (stub → real build), simulator/emulator jobs, Maestro |
| 07 security | CODEOWNERS (placeholder team), `.gitattributes`, `strings-export.sh`, policy checks in CI | setting the owning team, branch protection, allowlist sign-off for Argent 0.25.0 |
| 08 metrics | `docs/dev/rollout.md` templates and threshold cross-references | baseline runs on the pilot flow |
