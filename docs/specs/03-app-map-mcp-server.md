# 03 — App-Map MCP Server

Status: draft v0.1 · Depends on: 02 · Consumed by: 04, 05, 06

## 1. Purpose

The single owner of the app-map. It loads YAML into a cache, identifies screens, resolves locators, ingests observations, plans paths, and exposes all of it to any MCP harness. It does not drive the simulator during exploration (Argent does); it drives it only for headless replay through Maestro (04).

## 2. Process model

- Local **stdio** MCP server launched by the harness from `.mcp.json` (05 §2). One instance per harness session; many instances may run concurrently on one machine (one per developer window) and share the cache safely (SQLite WAL, short transactions).
- Code lives at `tools/app-map-mcp/`, TypeScript on Node ≥ 22, dependencies pinned with a lockfile. Never fetched via `npx` at runtime (07 §5).
- Also exposes a **CLI** (`bin/app-map`) used by hooks, CI, and developers. The CLI and the server share one library; the CLI never talks to a running server — it reads/writes the cache and YAML directly.
- Also exposes a **local ingest socket** (unix socket at `app-map/.local/ingest.sock`) so hooks can post observations in <50 ms without spawning a Node process per tool call. The CLI `record` command falls back to direct SQLite writes if the socket is absent.

## 3. Configuration

Environment variables (set from `.mcp.json`, all with defaults):

| var | default | meaning |
|---|---|---|
| `APP_MAP_DIR` | `./app-map` | root of YAML + `.local/` |
| `APP_MAP_PLATFORM` | `ios` | which platform map to serve |
| `APP_MAP_BUILD` | auto | current build number; auto-detected when the driver reports it (the nested XCUITest-like snapshot carries `build_number`; Argent's `native-describe-screen` does not — issue #10), else from `manifest.yaml` |
| `APP_MAP_DRIVER` | `argent` | driver tool name prefix hooks match on |
| `APP_MAP_MAESTRO_BIN` | `maestro` | executor binary for headless replay |
| `APP_MAP_LOG_LEVEL` | `info` | |
| `APP_MAP_MAX_CONTEXT_TOKENS` | `600` | cap for `summary` and `get_screen` outputs |
| `APP_MAP_RECOMPILE` | `guarded` | what the automatic 04 §8 recompile may do: `guarded` writes a rebuilt recipe only when it passes the 04 §8 write guard (steps, `preconditions` and `entry` all covered, no incompleteness warning) and stamps it `provenance.machine_recompile: true`; `off` makes replay strictly read-only against the map (the status transition still happens) |

## 4. Storage layer

- **Load**: on start, parse `manifest.yaml`, `ids.yaml`, `screens/*.yaml`, `recipes/*.yaml` → validate (02 §10) → upsert into `cache.sqlite`. If YAML changed since the cache's recorded git tree hash, reload. Load must finish in <500 ms for 300 screens.
- **Write path**: the server only writes to SQLite during a session. Durable changes (new screen, new element, healed locator, recipe status change) are marked `dirty`. `app-map export` (run by the developer, a Stop hook, or CI) writes dirty durable fields to YAML canonically. Volatile counters never leave SQLite.
- **Conflict safety**: export refuses to overwrite a YAML file whose git blob changed since load; it prints the diff and asks for `--force` or a reload. This keeps two windows on the same machine from clobbering each other.

## 5. Screen identification

Input: a normalized accessibility tree. The driver shapes `tree.ts` normalizes are the real Argent flat capture (`argent run native-describe-screen --json`: `{screenFrame, elements[]}`, no nesting and no element type — roles come from `traits`/`viewClassName` plus the registry's kinds), the nested XCUITest-like snapshot, a Maestro hierarchy dump, and an already-normalized tree. Output: `{screen_id, variant?, confidence, signals, gates_present[]}`.

```
1. gates: for each kind:gate screen, test its signature; collect matches → gates_present
2. marker: the DEEPEST node with id matching ^screen\. → screen_id = suffix, confidence 1.0, done
   (a pushed screen leaves the covered screen's marker behind, 01 R3; deepest in the tree,
    ties by greatest y, then document order)
3. route: if the observation carries a known deep link/route → 0.9
4. required_ids: fraction f of a screen's required_ids present → 0.8 × f  (only if f ≥ 0.5)
5. structural_hash: exact match → 0.7
6. title: nav title equals screen.title → 0.4
score(screen) = max(signals) + 0.05 × (count of agreeing signals − 1), capped at 1.0
variants are scored the same way and the best (screen, variant) wins
if best score < 0.6 → screen_id = unknown, plus top-3 candidates
```

`unknown` is not an error. It is the signal that puts the session into `explore` mode and creates a `candidate` screen once the LLM names it (tool `name_screen`).

## 6. Locator resolution

`resolve(element, tree)` implements 02 §5.2:

```
for locator in element.locators (ranked):
  matches = query(tree, locator)
  if len(matches) == 1: return {node, strategy, confidence: locator.weight, degraded: weight < 0.6}
  if len(matches) > 1 and locator.strategy in (a11y_id, role_label):
     disambiguate by fingerprint.sibling_index / bbox proximity; if unique → return (confidence × 0.9)
return miss
```

A `miss` or `degraded` result is returned to the caller *and* recorded; the heal algorithm lives in 04 §7 because it needs a postcondition to verify against.

## 7. Scrubber

Applied to every tree before it is stored, hashed, or returned to the LLM. Rules are in 07 §2; the contract here:

- Keep: `role`, `a11y_id`, `bbox_norm`, `enabled`, `focused`, `selected`, and `label` **only** for nodes whose id is in `ids.yaml` with `dynamic: false`, or whose role is `button | tab | navigationBar | staticText` and whose text matches a registered static label.
- Drop: every `value`, all text under `dynamic` containers, all text of nodes without an id that fails the static-label check, any string matching PII regexes (07 §2.3).
- The scrubbed tree is the only form that exists past the ingest boundary. Raw trees are never written to disk.

## 8. MCP tools

Tool names appear to the harness as `mcp__app-map__<name>`. All outputs are compact text or small JSON; every output is capped by `APP_MAP_MAX_CONTEXT_TOKENS`.

| tool | input | output | notes |
|---|---|---|---|
| `summary` | `{}` | screens count, recipes list (id + description), current build, gates | ≤600 tokens; what SessionStart injects |
| `identify_screen` | `{snapshot?}` | §5 result | uses last recorded observation if `snapshot` omitted |
| `get_screen` | `{screen_id}` | compact block (below) | ≤400 tokens |
| `find_element` | `{screen_id?, element_id \| intent}` | resolved locator + confidence, or miss with top candidates | an omitted `screen_id` is the last observation's screen (§2) |
| `plan_path` | `{from?, to}` | `{deep_link}` or ordered edge list | prefers deep link (invariant 7); an omitted `from` is the last observation's screen, else `unknown` (§2) |
| `match_recipe` | `{instruction, platform?}` | `{recipe_id, confidence, params_needed[]}` or `{no_match, candidates[]}` | regex cascade; candidates ≤ 8 lines |
| `run_recipe` | `{recipe_id, params, mode: guided \| headless}` | guided: `{run_id, step}`; headless: run report | 04 §5–6 |
| `report_step` | `{run_id, step_id, ok, note?}` | next step, `done`, or `fallback: {step, reason}` | verifies against last observation |
| `record_observation` | `{tool, input, snapshot, ok}` | `{screen_before, screen_after}` | fallback when hooks are unavailable; costs tokens |
| `name_screen` | `{screen_id, title?, deep_link?, force?}` | candidate screen created from last observation | explore mode only; `force` re-learns a screen that is no longer `candidate` and records `meta.relearned_from` (02 §8) |
| `compile_recipe` | `{session, task, recipe_id, params[]}` | draft recipe YAML for review | 04 §3 |
| `mark` | `{recipe_id \| screen_id, status}` | | human-in-the-loop promote/demote; exactly one id key says which kind. A screen demote is the only way back out of `verified` (02 §8) |
| `export` | `{}` | list of files written | same as CLI `export` |

`get_screen` output format (fixed, parse-stable):

```
screen invoice_list  conf 0.98  title "Invoices"  deep_link appmap://invoice_list
elements
  invoice.add.button     button  "New Invoice"  -> invoice_new
  invoice.filter.button  button  "Filter"       -> invoice_filter_sheet
  invoice.list.table     list    [dynamic]
  invoice.list.cell      cell    [dynamic]      -> invoice_detail
gates  gate.push_permission
recipes  create_invoice, filter_invoices
```
`deep_link` is rendered in the scheme the APP registers (`manifest.deep_link_scheme`, 01 R5), not
the canonical `appmap://` the map stores — the caller is going to open it. `plan_path` does the
same; `name_screen` accepts either and stores the canonical form.


## 9. MCP resources

- `app-map://{platform}/summary` — same as `summary`.
- `app-map://{platform}/screens/{id}` — the YAML file verbatim.
- `app-map://{platform}/recipes/{id}` — the YAML file verbatim.

Resources exist for harnesses that prefer reading over tool calls; tools remain the primary interface.

## 10. CLI

| command | used by | does |
|---|---|---|
| `app-map validate` | CI, pre-commit | 02 §10 |
| `app-map export [--force]` | dev, Stop hook, CI | cache → canonical YAML |
| `app-map record --stdin` | PostToolUse hook | ingest one hook payload |
| `app-map summary --max-tokens N` | SessionStart hook | |
| `app-map identify-screen [--session S] [--snapshot f]` | scripts, CI | shares the §8 tool body; exit 1 when the screen is `unknown` |
| `app-map get-screen <screen_id>` | scripts, CI | shares the §8 tool body |
| `app-map find-element <element_id> [--screen S] [--intent I]` | scripts, CI | shares the §8 tool body; exit 1 on a miss |
| `app-map plan-path [FROM] TO` | scripts, CI | shares the §8 tool body; exit 1 on `kind: none` |
| `app-map name-screen <screen_id> [--title T] [--deep-link L] [--force]` | dev, bootstrap | shares the §8 tool body; writes the cache, then `export` |
| `app-map match-recipe "<instruction>"` | scripts | shares the §8 tool body; declares the task (04 §2); exit 1 on `no_match` |
| `app-map run-recipe R --params k=v… [--mode guided\|headless]` | scripts, CI | shares the §8 tool body — the same one `run --guided` uses |
| `app-map report-step --run-id R --step-id S --ok true\|false` | scripts, CI | shares the §8 tool body; exit 1 on a `fallback` |
| `app-map import-router <json>` | CI | seed/refresh screens from 01 R6 |
| `app-map compile --session S --task T --name R` | dev | 04 §3 |
| `app-map run R --params k=v… [--guided \| --headless]` | dev, CI | 04 §5-6; `--guided` is the explicit spelling of the default |
| `app-map maestro-export [R \| --all] --out DIR` | CI | 04 §6.2 |
| `app-map drift --build B` | CI | 06 R4 |
| `app-map report [--since]` | dev | 08 §4 |
| `app-map gen-configs` | CI, dev | `.mcp.json` → Cursor/Codex configs (05 §2) |
| `app-map lint-ids` | CI | 01 R8 |
| `app-map migrate-id OLD NEW` | dev | 02 §8 |
| `app-map mark R STATUS [--reviewer NAME] [--recipe-file path] [--force]` | dev | 04 §3.8 — the recipe half of the `mark` tool |
| `app-map mark-screen S STATUS [--reviewer NAME] [--force]` | dev | 02 §8 — the screen half; the only way back out of `verified` |
| `app-map merge-driver %O %A %B` | git | 02 §9 |

Every §8 tool that reads or drives the map has a CLI twin; both call the same function in
`src/tools.ts` and the twin's `--json` output IS the tool's `structuredContent`, so a script,
a CI job or a bootstrap run gets the same answer over either front end. The CLI never speaks
MCP. Exit codes follow the CLI's own contract — 0 ok, 1 the command failed or reported a
finding, 2 usage — so a shell driver can branch on `$?` without parsing the JSON.

## 11. Non-functional requirements

- `identify_screen` on a 2,000-node tree: <50 ms. `get_screen`: <10 ms. Server start to first tool: <700 ms.
- Any tool error returns a structured `{error, hint}`; the server never crashes the harness session.
- Structured JSON logs to `app-map/.local/server.log`, rotated at 20 MB; no tree content at `info` level.
- Unit tests: identification scoring, resolution, scrubber (with PII fixtures), canonical export. Integration test: load pilot YAML → identify from recorded fixture trees → resolve every element → export → no diff.

## 12. Acceptance criteria

- [ ] Server starts from `.mcp.json` in Claude Code and `summary` returns the pilot map in ≤600 tokens.
- [ ] `identify_screen` returns the right screen for recorded fixture trees of all pilot screens, including one with a gate present.
- [ ] `find_element` resolves every pilot element by `a11y_id`; with the id removed from the fixture, it resolves by `role_label` and reports `degraded`.
- [ ] Scrubber unit tests: a fixture containing an email, a phone number, and a dollar amount in a list cell produces a stored tree with none of them.
- [ ] Two concurrent server instances ingesting observations do not corrupt the cache (WAL stress test).

## 13. Open questions

- ~~Whether Argent exposes the running build number~~ — it does not: `native-describe-screen` answers `{status, screenFrame, elements[]}` and nothing else (issue #10), so `APP_MAP_BUILD` is set by the developer, read from the app via a debug endpoint, or taken from a driver whose snapshot carries `build_number`.
- Whether to bundle Maestro or require it on PATH; bundling pins the version, PATH is simpler. Lean: require on PATH, pin the expected version in `package.json` `engines`-style metadata and check at start.
