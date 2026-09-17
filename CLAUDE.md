# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

app-map gives a coding agent a durable, git-reviewed map of a mobile app (screens, element ids, locator
cascades, navigation edges, permission gates, replayable recipes) instead of screenshot-and-guess. Three
parts live here:

- `app-map/` — the map itself as canonical YAML plus the JSON Schemas it validates against. Structure only,
  never data (no screenshots, field values, cell text, PII); `validate` rule 8 fails on anything that looks like it.
- `tools/app-map-mcp/` — the MCP server and the `app-map` CLI (TypeScript, ESM, Node ≥ 22.18, `node:sqlite`,
  no native deps). This is where almost all code lives.
- `instrumentation/` — reference Swift package (`ios/AppMapKit`) and Gradle module (`android/appmap`) an app
  integrates. Neither compiles on Linux; CI builds them on macOS/Android runners.

There is no real app in this repo. Everything runs against committed fixtures and the pilot map
(`login → invoice_list → invoice_new → client_picker → invoice_detail`, recipe `create_invoice`).

Read `docs/dev/toolchain.md` first, then `docs/dev/architecture.md` (the module contract) and
`docs/dev/harness-notes.md` (verified hook/Argent facts). The eight specs in `docs/specs/` are cited
throughout code and docs as `NN §M` / `NN Rk` (e.g. `02 §10.8`, `01 R8`); resolve those references there.

## Commands

All package commands run from the repo root with `--prefix tools/app-map-mcp`. The CLI shim
`tools/app-map-mcp/bin/app-map` runs `dist/` if built, else the TypeScript source directly, so it works
on a fresh clone. `node_modules/` and `dist/` are git-ignored.

```sh
npm ci --prefix tools/app-map-mcp                 # install (lockfile-pinned; never npx at runtime)
npm run build --prefix tools/app-map-mcp          # tsc → dist/
npm run typecheck --prefix tools/app-map-mcp      # tsc --noEmit (this is also `npm run lint`)
npm test --prefix tools/app-map-mcp               # all unit tests (node:test, ~1100 tests, serial)
```

Single test file / single test (run from `tools/app-map-mcp/`; no build needed, Node strips types):

```sh
node --disable-warning=ExperimentalWarning --test src/test/heal.test.ts
node --disable-warning=ExperimentalWarning --test --test-name-pattern="intent_critical" src/test/heal.test.ts
```

The same checks the CI `validate` job runs, all offline and all expected to pass on `main`:

```sh
tools/app-map-mcp/bin/app-map validate            # 02 §10 referential + safety rules over app-map/
tools/app-map-mcp/bin/app-map export --check      # every committed YAML is byte-identical to canonical form
tools/app-map-mcp/bin/app-map lint-ids            # no string-literal ids in app source
scripts/app-map/gen-ids --check                   # AppMapID.swift / AppMapId.kt match ids.yaml
tools/app-map-mcp/bin/app-map gen-configs --check # .cursor/mcp.json + .codex/config.toml match .mcp.json
tools/app-map-mcp/bin/app-map policy-check        # MCP servers allowlisted, pinned, secret-free
```

Other CLI commands you will need: `summary` (what the SessionStart hook injects), `export` (write dirty
session changes back to YAML), `migrate-id OLD NEW [--dry-run]` (rename an id everywhere), `compile`,
`mark`, `run --headless`, `maestro-export`, `drift`, `report`, `intent-critical-diff <base-sha>`. The full
dispatch is the `switch` in `src/cli.ts`.

Optional per-clone git config (CI enforces the same things, so skipping it is safe, just slower):

```sh
git config core.hooksPath scripts/app-map/githooks     # pre-commit: lint-ids + validate + gen-ids --check
git config merge.app-map-yaml.driver "tools/app-map-mcp/bin/app-map merge-driver %O %A %B %P"
```

## Hard rules when editing

**Map YAML (`app-map/**`)**
- Files must stay canonical: fixed key order, id-sorted lists, block style, 2-space, LF, no comments.
  The exact rules are `docs/dev/architecture.md` §3 and `src/yaml/canonical.ts`. After hand-editing,
  run `export --check`; CI rejects non-canonical files.
- Every screen, element and gate id comes from `app-map/ids.yaml`. Adding or renaming one means:
  update `ids.yaml` (or use `migrate-id`), regenerate constants with `scripts/app-map/gen-ids`, and
  keep both platforms' screen/recipe files consistent. `validate` checks the cross-references.
- Schemas in `app-map/schema/*.schema.json` are the source of truth; `src/types.ts` mirrors them.
  A `schema_version` bump needs a script in `tools/app-map-mcp/migrations/` (see its README).
- Do not modify the pilot YAML or `tools/app-map-mcp/fixtures/` to make a test pass. They are the
  contract; if one is wrong, say so.
- `.mcp.json` is the single source for `.cursor/mcp.json` and `.codex/config.toml` (regenerate with
  `gen-configs`), and its server argv is pinned in `app-map/policy/mcp-allowlist.yaml`. Changing any of
  them is a security-reviewed change (07 §6).

**TypeScript (`tools/app-map-mcp/src`)**
- Imports between source files use the `.ts` extension; `import type` for type-only imports
  (`verbatimModuleSyntax`). `erasableSyntaxOnly` is on: no `enum`, `namespace` or parameter properties.
- Respect the import layering in `docs/dev/architecture.md` §1 (no cycles; `lib.ts` lists the order):
  `types/config/errors/paths/token/log → yaml/tree/scrub/signature → store/context/identify/resolve/plan/format
  → observe/recipes/heal/drift/router-import → tools → server/cli/...`.
- Pure functions take `LoadedMap` and trees, never `AppMapContext`, and never touch disk. Only
  side-effecting modules take `AppMapContext` and write (db, trajectories, events, YAML via export).
- External processes (Maestro, simctl, adb) go through injectable `ExecFn`/`HierarchyProvider`/
  `BuildInfoProbe` parameters so everything is testable without a device.
- Errors are `AppMapError(code, message, hint)`. MCP tool handlers never throw: return
  `{ content: [...], isError: true }` via `toErrorJson`. The server must never crash the harness.
- stdout is the MCP transport. Never `console.log` in the server; logs go to stderr or `.local/server.log`.
- Raw accessibility trees die inside `scrub()`. `ScrubbedTree` is a branded type only `scrub()` mints;
  every disk/db/event/model-facing path calls `assertScrubbed`. Never work around the brand.
- Tests: `src/test/<module>.test.ts`, `node:test` + `node:assert/strict`, helpers in `src/test/helpers.ts`
  (`makeTempAppMapDir` copies the pilot map into `os.tmpdir()`). Temp files never go in the repo's
  `app-map/.local/`.
- Argent driver tool names are hyphenated (`gesture-tap`, `keyboard`, `open-url`, `gesture-swipe`) and are
  pinned by `verbs.test.ts` to `ARGENT_VERBS` in `src/recipes/verbs.ts`; `.claude/agents/app-nav-replayer.md`
  must list the same spellings.

## How the pieces connect

- **Session flow (05):** `.claude/settings.json` wires hooks. SessionStart (and post-compaction) runs
  `app-map summary --hook-json` to inject a <600-token summary. Every `mcp__argent__*` call is recorded
  out of band by the PostToolUse hook via the unix socket `app-map/.local/ingest.sock` (fallback
  `app-map record --stdin`). Stop runs `app-map export` to write dirty changes back to YAML. Hooks
  always exit 0 and export `APP_MAP_DIR`.
- **Ingest → identify → replay → heal:** `observe.recordHookPayload` normalizes and scrubs the tree,
  `identify` matches it to a screen signature, observations land in SQLite (`store/db.ts`) and
  `.local/trajectories/`. `recipes/compile.ts` turns a trajectory into a recipe draft (`candidate`; only a
  human marks `verified`). `recipes/guided.ts` hands out one resolved step per `report_step` and verifies
  from recorded observations, not the agent's claim. `heal.ts` is three-stage (`proposeHeal` pure →
  act → `applyHeal`/`rejectHeal`); accepted heals become `healed_pending_review`, and `intent_critical`
  elements are never healed automatically. `recipes/headless.ts` + `maestro.ts` replay with no model.
- **Export (03 §4):** the server never writes YAML directly. Session writes mark db rows dirty;
  `store/export.ts` serializes canonically and refuses to overwrite a file whose git blob changed since
  load unless `--force`.
- **CI (`.github/workflows/app-map.yml`):** `validate` and the two instrumentation unit-test jobs always
  run. Drift/gate, nightly-heal and router-import are skipped until the repo variable
  `APP_MAP_HAS_APP=true`. Heal PRs are never auto-merged; an `ids.yaml` change that flips
  `intent_critical` true → false fails the check and needs two approvals.
- **Local runtime state** is `app-map/.local/` (cache.sqlite, ingest.sock, events.jsonl, strings.<platform>.txt,
  ci-params.<platform>.json). It is git-ignored and regenerable; the "static string table is missing"
  warning on a fresh clone is expected.

## Driving the app from a session

The `app-nav` skill (`.claude/skills/app-nav/SKILL.md`) is the operating procedure: `match_recipe` first,
`run_recipe` guided (or delegate to the `app-nav-replayer` subagent); otherwise `identify_screen` then
`get_screen` before any tap, tap by `a11y_id`, enter via `plan_path` deep links, no screenshots unless
the tree is empty, and `compile_recipe` when a new task succeeds. Never sleep between a step and its
`report_step`; poll the step's `settle` hint instead.

## Installing app-map in another repository

The package in `tools/app-map-mcp/` publishes as `@kalub92/app-map`. An app repo runs
`npm i -D @kalub92/app-map` then `npx app-map init`, which scaffolds the map skeleton, the skills, the
agents, the hooks, `.mcp.json`, `.claude/settings.json`, `scripts/app-map/` and `app-map.config.json`
(the per-repo paths `lint-ids` cannot guess: app source roots and the generated constants file, read by
`src/repo-config.ts`). `init` merges rather than replaces, and reports a conflict instead of overwriting a
file the consumer edited. Everything it writes addresses the CLI as `npx app-map`, never this repo's tree.

`templates/` and `scripts/gen-ids` inside the package are generated at `prepack` by
`scripts/build-templates.mjs` and git-ignored; npm cannot pack files from outside the package root, so the
canonical schemas, skills, agents and scripts are staged there for the tarball. `npm run check:templates`
fails when a source it names has moved. `src/test/init.test.ts` scaffolds a temp repo and asserts it passes
`validate`, `policy-check` and `lint-ids`. Releasing, including the git tag the SwiftPM dependency needs, is
`docs/dev/release.md`.

## Instrumenting an app

The `app-instrument` skill (`.claude/skills/app-instrument/SKILL.md`) instruments an iOS app's source for 01 R1–R8:
`app-instrument-surveyor` (read-only) returns a plan, `app-instrument-swiftui` and `app-instrument-uikit` apply it to
their files, and only the skill — never a subagent — edits `app-map/ids.yaml` (plus the `deep_link_scheme` key of
`app-map/ios/manifest.yaml`), runs `gen-ids`, `migrate-id` and `xcodebuild`, and verifies with `lint-ids`, `validate`
and `export --check`. `gen-ids` runs for both platforms unless `AppMapId.kt` is absent, because `lint-ids` checks both
outputs whenever both exist. The instrumented pilot under `tools/app-map-mcp/fixtures/instrument/ios/{swiftui,uikit}`
is what the agents must produce; `src/test/instrument-agents.test.ts` pins the agents, the skill's `reference/*.md`
and those fixtures to AppMapKit's public API, the generated constants and `lint-ids`, so prose and code cannot drift
(05 §5.1).
