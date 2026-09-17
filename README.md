# app-map

[![app-map](https://github.com/kalub92/appmap/actions/workflows/app-map.yml/badge.svg)](https://github.com/kalub92/appmap/actions/workflows/app-map.yml)

A coding agent driving a mobile app on a simulator starts every session blind. It screenshots the screen,
guesses which button is which, taps, screenshots again. It is slow, it spends its context on pixels, and
nothing it learns survives the session.

app-map gives the agent a durable map instead: every screen, its stable element ids, a ranked locator cascade
per element, the navigation edges between screens, the permission gates that cover them, and replayable
**recipes** for tasks it has done once before. The map lives in git as reviewable YAML. A local MCP server
serves it, identifies the current screen from the accessibility tree, and records what the agent does. When
the UI drifts, locators heal against a stored fingerprint — and a human reviews the diff. A task solved once
replays with no screenshots, and once compiled to a Maestro flow, with no model in the loop at all.

## How it works

1. **Instrument once** — stable accessibility ids, a `screen.<id>` marker per screen root, test-only deep
   links, a router export. Every id comes from one registry (`app-map/ids.yaml`) that generates the Swift
   and Kotlin constants, so app code never hard-codes an id string.
2. **Explore** — a `PostToolUse` hook records each driver call out of band: element tapped, screen landed
   on, screen signature. Values are scrubbed before anything touches disk.
3. **Compile** — a trajectory becomes a recipe: id-addressed steps, parameter slots, per-step
   postconditions. Drafts are born `candidate`; only a human marks one `verified`.
4. **Replay** — *guided* hands the agent one resolved step at a time; *headless* exports a Maestro flow and
   runs it with zero LLM calls.
5. **Heal** — a broken locator is re-scored against the element's fingerprint. A confident match is promoted
   and flagged for review; a match on an `intent_critical` element is rejected, not guessed.
6. **CI keeps it honest** — map validation, id lint and the instrumentation packages' release-gate tests on
   every PR; once the repo has a real app, a drift tour on every PR and nightly heal PRs that nobody
   auto-merges.

## Requirements

| | |
|---|---|
| Node | ≥ 22.18 (`tools/app-map-mcp/package.json`). No native deps — `node:sqlite` is built in |
| App build | a **Debug** build with the instrumentation package and sandbox fixtures. Recipes refuse to run against anything else |
| Device | an iOS Simulator or Android emulator |
| Headless replay | [Maestro](https://maestro.mobile.dev) on `PATH` |
| Driver | [Argent](https://github.com/software-mansion/argent) (pinned to `0.25.0`) or any MCP driver whose tools take element ids |
| Harness | Claude Code; Cursor and Codex configs are generated from `.mcp.json` |

Only Node is needed to read, validate or lint the map; that works on a bare clone with no app, device,
Maestro or driver.

`node:sqlite` is still flagged experimental on Node 22, so any invocation that opens the cache would print
`ExperimentalWarning: SQLite is an experimental feature` to **stderr**. `bin/app-map` passes
`--disable-warning=ExperimentalWarning` on both its branches — built `dist/` and TypeScript source — and so
do the `test` npm scripts, so neither the CLI below nor a test run emits it. That matters because hooks
relay CLI stderr into the session (`docs/dev/harness-notes.md` §4), so one warning per invocation would be
one warning per tool call in the model's context. The line survives in exactly one place, on purpose: the
`.mcp.json` server is a bare `node …/dist/index.js` whose argv is pinned for review in
`app-map/policy/mcp-allowlist.yaml`, so it lands once in that server's own stderr log and never on the
stdout MCP transport (issue #21, [toolchain](docs/dev/toolchain.md)).

## Quick start

```sh
# build the server + CLI (its own deps are lockfile-pinned and installed, never fetched at runtime)
npm ci --prefix tools/app-map-mcp && npm run build --prefix tools/app-map-mcp

# inspect and check the map in this repo — no app, no simulator required
tools/app-map-mcp/bin/app-map summary
tools/app-map-mcp/bin/app-map validate      # also: lint-ids, export --check, policy-check

# then open Claude Code in the repo root and approve the two project-scoped MCP servers
claude
```

The CLI is `tools/app-map-mcp/bin/app-map`; there is no `bin/` at the repository root. Optionally, once per
clone, install the semantic YAML merge driver from `.gitattributes` so two agents editing the same screen
file do not conflict.

## Using app-map in your own app repository

The above is for working **on** app-map. To use it **in** an app, install the package there and scaffold:

```sh
cd path/to/your-app
npm i -D @kalub92/app-map        # the MCP server, the CLI and the templates
npx app-map init                 # writes the map skeleton, skills, agents, hooks and MCP config
```

`init` writes a complete, already-canonical setup: `app-map/` (an empty `ids.yaml`, the vendored schemas, the
policy allowlist, a starter `manifest.yaml`), `.claude/skills/{app-nav,app-instrument}/`,
`.claude/agents/`, `.claude/hooks/`, `scripts/app-map/` and an `app-map.config.json` recording where your app's
source and generated constants live. `.mcp.json` and `.claude/settings.json` are **merged**, never replaced —
a server or hook you already declare is left exactly as it is. Re-running changes nothing, and a file you have
edited is reported as a conflict rather than overwritten (`--force` overrides, `--dry-run` shows the plan).

Everything it writes addresses the CLI as `npx app-map …`, which resolves the devDependency with no network.
The scaffolded repo passes `npx app-map validate`, `export --check`, `policy-check` and `lint-ids` immediately;
`src/test/init.test.ts` asserts exactly that, so the claim cannot rot.

Then, in a Claude Code session in your app repo, run the `app-instrument` skill: it surveys your source, fills
`ids.yaml`, generates the `AppMapID` constants and has the SwiftUI and UIKit agents add the markers and the
debug-only wiring. `init` prints the handful of steps it cannot do for you — adding
[AppMapKit](instrumentation/README.md) as a Swift package dependency, `-D APP_MAP_DEBUG` in the Debug
configuration, and the `appmap://` URL type in the Debug Info.plist.

Publishing a new version of the package is [docs/dev/release.md](docs/dev/release.md).

---

# Examples

Every block below is output this repository actually produced, on Linux, with no app, no simulator, no
Maestro and no Argent anywhere in the picture. Where a snippet needed one of those, it was replaced by a
committed fixture or a shell stub, and the italic line underneath the block says exactly which. `app-map` is
shorthand for `tools/app-map-mcp/bin/app-map`; `$` marks a shell command and `>>>` an MCP tool call; a `#`
comment or a `...` line inside a block is an annotation or an elision of mine, not output.

## 1. What the agent sees at session start

```console
$ tools/app-map-mcp/bin/app-map summary
app-map ios build 4412: 5 screens (5 verified), 2 gates, 1 recipes
screens: client_picker, invoice_detail, invoice_list, invoice_new, login
gates: gate.biometric_prompt, gate.push_permission
warning: .local/strings.ios.txt is missing — gate detection and label-based resolution are degraded; run scripts/app-map/strings-export.sh
recipes:
  create_invoice (verified) — Create an invoice for a client with an amount and save it

app-map is loaded for ios build 4412. Before driving the simulator:
1. call mcp__app-map__match_recipe with the task; if it matches, run_recipe (guided) and follow report_step.
2. otherwise call identify_screen, then get_screen, before any tap. Prefer plan_path deep links.
3. do not take screenshots unless the accessibility tree is empty.
4. when a new task succeeds, call compile_recipe and review the draft.
Recipes: create_invoice
```

Under 600 tokens, injected by the `SessionStart` hook before the model's first turn. The `warning:` is
genuine on a fresh clone — `app-map/.local/` is git-ignored, so the app's static string table is not there
until you export it, and the server says so rather than degrading silently. Note that
`scripts/app-map/strings-export.sh` reads string *catalogs* (`.xcstrings`, `.strings`, `.stringsdict`,
Android `values*/strings.xml`): a SwiftUI app whose copy is inline `Text("…")` literals has none, so the
table is legitimately hand-authored — one static string per line, sorted, unique, LF. Gate signatures need
that by hand regardless, because a gate matching OS dialog copy (`Open`, `Cancel`) is matching strings that
appear in no app catalog (issue #21).

The `invoice.list.table` row below is the UIKit/Compose case, where a `UITableView`/`LazyColumn` *is* an
accessibility element. A SwiftUI `List`, `Section` or `ForEach` is **not**, so it never appears in a capture
and must not be registered — address the row instead (`select {cell, match}`), and `validate` warns about a
registered `kind: list` element no screen file records (01 R4, issue #19).

Asking for one screen (`get_screen`) returns fixed-width text, not JSON — id, role, static label or
`[dynamic]` for text that changes per run, and where each element leads. Enough to act without a screenshot:

```
screen invoice_list  conf 1.00  title "Invoices"  deep_link appmap://invoice_list
elements                                       # three nav.* rows and the filter button elided
  invoice.add.button     button  "New Invoice"  -> invoice_new
  invoice.list.cell      cell    [dynamic]      -> invoice_detail
  invoice.list.table     list    [dynamic]
gates  gate.push_permission
recipes  create_invoice
```

## 2. A task, matched to a recipe, replayed step by step

```console
>>> match_recipe {"instruction":"create an invoice for Acme Corp for $50","session":"sess_readme"}
{"matched":true,"recipe_id":"create_invoice","version":3,"confidence":0.9,"params_needed":[],"description":"Create an invoice for a client with an amount and save it","session":"sess_readme"}

>>> run_recipe {"recipe_id":"create_invoice","params":{"amount":50,"client":"Acme Corp"},"mode":"guided","session":"sess_readme"}
{"mode":"guided","run_id":"run_mtygq68m_mknwab","recipe":"create_invoice","version":3,"step":{"id":"s0","action":"open_link","url":"appmap://invoice_new?fixture=logged_in","expect":{"screen":"invoice_new"},"settle":{"target":{"by":"id","id":"screen.invoice_new"},"condition":"visible","source":"expect.screen","timeout_ms":10000}},"text":"step s0 open_link appmap://invoice_new?fixture=logged_in expect screen invoice_new settle visible screen.invoice_new 10000ms"}

>>> report_step {"run_id":"run_mtygq68m_mknwab","step_id":"s0","ok":true}
{"run_id":"run_mtygq68m_mknwab","status":"ok","step":{"id":"s1","action":"tap","element":"invoice.amount.field","expect":{"visible":["invoice.amount.field"]},"target":{"by":"id","id":"invoice.amount.field"},"resolved":{"strategy":"a11y_id","confidence":1,"degraded":false},"settle":{"target":{"by":"id","id":"invoice.amount.field"},"condition":"visible","source":"expect.visible","timeout_ms":10000}},"text":"step s1 tap invoice.amount.field via id \"invoice.amount.field\" (a11y_id 1.00) expect visible invoice.amount.field settle visible invoice.amount.field 10000ms"}

... s1 tap, s2 type "50", s3 tap the picker, s4 select "Acme Corp" — then the step that matters ...

>>> report_step {"run_id":"run_mtygq68m_mknwab","step_id":"s4","ok":true}
{"run_id":"run_mtygq68m_mknwab","status":"ok","step":{"id":"s5","action":"tap","element":"invoice.save.button","expect":{"screen":"invoice_detail"},"intent_critical":true,"target":{"by":"id","id":"invoice.save.button"},"resolved":{"strategy":"a11y_id","confidence":1,"degraded":false},"settle":{"target":{"by":"id","id":"screen.invoice_detail"},"condition":"visible","source":"expect.screen","timeout_ms":10000}},"text":"step s5 tap invoice.save.button via id \"invoice.save.button\" (a11y_id 1.00) expect screen invoice_detail settle visible screen.invoice_detail 10000ms [intent_critical]"}

>>> report_step {"run_id":"run_mtygq68m_mknwab","step_id":"s5","ok":true}
{"run_id":"run_mtygq68m_mknwab","status":"done","done":true,"verified":true,"heals":[],"text":"done verified"}
```

> **Fixture-fed; nothing on a device was driven.** No simulator, no Argent, no real app: between steps each
> driver call is a `record_observation` of a committed accessibility-tree fixture, the technique
> `src/test/guided.test.ts` uses, and the 07 §3 build probe is a shell stub. Each step carries
> `settle` — the postcondition the driver polls for instead of sleeping (04 §5); `s2`, a `type`
> with no `expect`, carries none, which means "report at once".
> `verified: true` at the end is now a real claim about the DATA: the recipe's `verify` asserts
> `value: [{element: invoice.detail.amount.text, equals: "{amount}"}]`, so a run that saved the
> wrong amount would end `verified: false` (02 §6). Server, map, recipe, locator
> resolution and run state machine are real. `run_id` is minted per run, so yours will differ.

`s1` asserts `expect.visible`, not `expect.focused`: Argent's iOS `native-describe-screen` reports no
focus flag of any kind, so a focus postcondition can never be satisfied there however well the tap worked.
`validate` warns on an `expect.focused` in an `ios` recipe and the compiler writes `visible` instead; the key
stays in the schema because Maestro's Android hierarchy *does* carry `focused`, which is what the Android
pilot still asserts (04 §10, issue #18).

Six steps, no screenshots. Each reply carries the *next* step already resolved to a driver-ready `target`
plus the cascade rung that won, and a `text` rendering of it capped at 120 tokens. `verified: true` comes
from the recorded observations, not from the agent's own `ok: true` — reporting `ok` with no observation
behind it returns `{"status":"fallback","fallback":{"step":"s0","reason":"no_observation", …}}` instead, and
the run is closed.

## 3. The map itself

A recipe is a versioned, parameterised, status-bearing script (`app-map/ios/recipes/create_invoice.yaml`):

```yaml
id: create_invoice
version: 3
matches: ["(create|new|make)( an?)? invoice", "bill (a |the )?(client|customer)"]     # free-text triggers
params: [{ name: amount, type: money, required: true }, { name: client, type: string, required: true }]
entry: { deep_link: "appmap://invoice_new?fixture=logged_in", fallback_path: [invoice_list, invoice_new] }
steps:                                                                   # s1, s3 and s4 elided
  - { id: s2, action: type, element: invoice.amount.field, text: "{amount}" }
  - { id: s5, action: tap, element: invoice.save.button, expect: { screen: invoice_detail }, intent_critical: true }
verify: { screen: invoice_detail, visible: [invoice.detail.amount.text] }
status: verified
provenance: { compiled_from: traj_2026-09-01_0007, reviewed_by: caleb }
```

A screen file carries a signature (how to recognise the screen), every element with its locator cascade and
healing fingerprint, and the outgoing edges:

```yaml
signature: { marker: screen.invoice_list, required_ids: [invoice.add.button, invoice.list.table],
             structural_hash: sha1:262365d418093134bfe9b089192ab10fe3575007 }
elements:
  - id: invoice.add.button
    role: button
    label: New Invoice
    intent_critical: false
    locators:                                  # tried in order, first match wins
      - { strategy: a11y_id,    value: invoice.add.button,                   weight: 1 }
      - { strategy: role_label, value: { role: button, label: New Invoice }, weight: 0.6 }
      - { strategy: text,       value: New Invoice,                          weight: 0.3 }
      - { strategy: path,       value: navigationBar/button[1],              weight: 0.25 }
      - { strategy: geometry,   value: { x: 0.8461, y: 0.0818 },             weight: 0.1 }
    fingerprint: { role: button, label_norm: new invoice, parent_role: navigationBar, sibling_index: 1,
                   bbox_norm: { x: 0.7179, y: 0.0604, w: 0.2564, h: 0.0427 } }   # healing scores against this
    status: verified
edges:
  - { action: { type: tap, element: invoice.add.button }, to: invoice_new, postconditions: [{ screen: invoice_new }] }
```

*Both excerpts are folded to flow style; the committed files are block style. Keys and values shown are
verbatim, but keys are elided: the recipe also carries `platform`, `description`, `preconditions` and
`last_verified_build`, and the screen file also carries a `variants:` block, `dynamic_regions`, `gates`, six
more elements and a second edge.*

## 4. The CLI a developer runs

```console
$ tools/app-map-mcp/bin/app-map validate
ok — 20 file(s) checked
$ tools/app-map-mcp/bin/app-map export --check
ok — every file is canonical
$ tools/app-map-mcp/bin/app-map policy-check
ok — every MCP server is on the allowlist, pinned, secret-free and hooks stay in .claude/hooks/
```

`export --check` re-loads every committed file, re-serialises it canonically and reports any file that is not
already byte-identical; `export` itself writes the cache back the same way. That no-diff guarantee is what
makes the map reviewable in a pull request. Failures name the file, the JSON pointer into it, and the rule:

```console
# login.email.field was deleted from the registry while both platforms' screens still referenced it
$ app-map validate
android/screens/login.yaml:/signature/required_ids/0 rule 2: required id login.email.field is not registered in ids.yaml
android/screens/login.yaml:/elements/1/id rule 2: element login.email.field is not registered in ids.yaml
ios/screens/login.yaml:/signature/required_ids/0 rule 2: required id login.email.field is not registered in ids.yaml
ios/screens/login.yaml:/elements/1/id rule 2: element login.email.field is not registered in ids.yaml
FAILED — 20 file(s) checked                                                        # exit 1

# someone pasted a real address into a label
$ app-map validate
ios/screens/login.yaml:/elements/1/label rule 8: label of login.email.field contains forbidden content (email) — structure only, never data (02 §10.8, 07 §2)
FAILED — 20 file(s) checked

# app source hard-coded an id instead of the generated constant
$ app-map lint-ids --src app --platform ios
error: string_literal_id [ios] /tmp/app-demo/app/Sources/BadUsage.swift:6 — "invoice.save.button" is a string-literal id; use the generated constant (01 R8)
...                                          # a marker_unreferenced warning for the stand-in tree, elided
```

*Each failure came from corrupting a throwaway copy of `app-map/` under `/tmp` — a deleted `ids.yaml` entry,
an address pasted over a label, a fabricated `BadUsage.swift` in a stand-in `app/` source tree (there is no
real app here). The rules, messages and paths are what the CLI actually printed.*

| command | what it does |
|---|---|
| `validate` · `export [--check]` | the eight 02 §10 referential and safety rules · cache → canonical YAML, or assert no diff |
| `lint-ids` · `policy-check` | no string-literal ids in app source · servers allowlisted, pinned, secret-free |
| `gen-configs [--check]` | `.mcp.json` → `.cursor/mcp.json` + `.codex/config.toml` |
| `migrate-id OLD NEW [--dry-run]` | rename an id across the registry and both platforms' screens and recipes |
| `compile` · `mark` · `run` · `maestro-export` | trajectory → recipe → replay → flow file |
| `drift` · `report` | build-over-build diff · steady-state metrics, `--json` for CI thresholds |

`report` scores the map's health from the event log — replay rate, heal rate, per-recipe fallback rate and
convergence curve — and turns every threshold breach into an instruction:

```console
$ app-map report --since 30d
app-map report — ios 2026-08-13T14:16:31Z … 2026-09-12T14:16:31Z

replay_rate                60.0%
heal_rate_per_100_runs     40
pending_review_heals       0
intent_critical_rejections 1
brittleness_index          66.7%
unknown_screen_rate        33.3%
unknown_screen_rate_7d     0.0%
map_coverage               80.0%

fallback_rate_per_recipe (current build):
  create_invoice           100.0%

convergence (cumulative success, oldest → newest):
  create_invoice           100.0% → 100.0% → 66.7% → 75.0% → 60.0%

... task counters elided ...

alerts:
  - fallback_rate create_invoice 100.0% > 20.0% on build 4413 — recompile from the latest successful trajectory (08 §5)
  - intent_critical heal rejected ×1 — human review before anyone re-runs that recipe (08 §5)
```

*Synthetic: the 17 hand-written events of `tools/app-map-mcp/fixtures/events/sample.events.jsonl`, which
validate against `app-map/schema/events.schema.json`, copied into a throwaway `.local/events.jsonl`. No real
telemetry exists in this repo. The header timestamps are the `--since` window, so they move with the clock.*

## 5. Headless replay

```console
$ app-map run create_invoice --headless --json
{
  "recipe": "create_invoice",
  "version": 3,
  "mode": "headless",
  "ok": true,
  "steps": 6,
  "steps_done": 6,
  "heals": [],
  "retries": 0,
  "ms": 33,
  "build": "4412"
}

# and a failure, diagnosable without a screenshot:
{
  "recipe": "create_invoice",
  "version": 3,
  "mode": "headless",
  "ok": false,
  "steps": 6,
  "steps_done": 1,
  "heals": [],
  "retries": 0,
  "ms": 34,
  "build": "4412",
  "error_code": "hierarchy_unavailable",
  "fallback_step": "s1",
  "failed_command_index": 2
}
```

The flow's command list is parsed back to the recipe step that broke, and no on-screen text reaches the
report. With the stubs below taken off `PATH` — nothing faked at all — the run stops before it starts:
`"error_code": "release_build_refused"`, `steps_done: 0`, no debug probe, no execution. A run that opens a deep link is also refused with `deep_link_scheme_collision` when another installed bundle registers the app's `deep_link_scheme` (01 R5): the OS would deliver the link, and the `?fixture=` seeding state with it, to an app the run never meant to touch.

*Fake device; no simulator, no real Maestro, no app. Three shell stubs stand in for `maestro`, `xcrun` and
`plutil`, mirroring `makeFakeDevice()` in `src/test/cli.test.ts`, and the params came from
`fixtures/ci/params.json` copied to `.local/ci-params.ios.json` (without it the run exits 1 on
`missing required recipe params`). The failure was injected by making `maestro test` print a `[failed] tapOn
id=invoice.amount.field` line and exit 1. `build: "4412"` is read from `app-map/ios/manifest.yaml`, not from
the stub; `ms` is wall-clock and differs per run.*

`maestro-export` produces the artifact CI replays, with app-map out of the loop:

```yaml
appId: com.example.app
---
- openLink: appmap://invoice_new?fixture=logged_in
- extendedWaitUntil: { visible: { id: screen.invoice_new }, timeout: 10000 }
- tapOn: { id: invoice.amount.field }
- inputText: "50"
- scrollUntilVisible: { element: { text: Acme Corp } }
- tapOn: { id: invoice.save.button }
- extendedWaitUntil: { visible: { id: screen.invoice_detail }, timeout: 10000 }
- assertVisible: { id: invoice.detail.amount.text }
```

Every `expect` became an `extendedWaitUntil` on the target screen's marker id; `{amount}` and `{client}` came
from the CI params file. *Flow style here, block style in the emitted file; seven of the fifteen emitted
commands are elided.*

## 6. Healing

Three builds ship three changes to the same button. The map reacts three different ways.

The three JSON blocks below are excerpts: `resolve()` and `proposeHeal()` also return the matched node and
the full candidate list, which are cut here for width. Every key and number shown is verbatim.

**(a) The label changed, the id survived** — `"New Invoice"` → `"Add invoice"`:

```json
{ "status": "hit", "element": "invoice.add.button", "path": "navigationBar/button[1]",
  "strategy": "a11y_id", "confidence": 1, "degraded": false, "disambiguated": false }
```

Top rung of the cascade; healing is never entered. This is the case instrumentation exists for.

**(b) The id was dropped, the label survived:**

```json
{ "status": "hit", "element": "invoice.add.button", "path": "navigationBar/button[1]",
  "strategy": "role_label", "confidence": 0.6, "degraded": true, "disambiguated": false }

{ "reason": "accepted",
  "candidate": { "path": "navigationBar/button[1]", "label": "New Invoice", "score": 1,
    "features": { "role": 1, "label": 1, "path": 1, "bbox": 0.9999, "parent_sibling": 1 },
    "proposed_locator": { "strategy": "role_label", "value": { "role": "button", "label": "New Invoice" }, "weight": 0.6 } },
  "runner_up": { "path": "container/button[3]", "label": "Paid", "score": 0.6618,
    "features": { "role": 1, "label": 0.447, "path": 0.6667, "bbox": 0.7771, "parent_sibling": 0 } } }
```

Still found, one rung down — `degraded: true`, so a heal is proposed. The surviving node scores 1 overall
(0.9999 on bbox, 1 on role, label, path and parent/sibling) against a 0.6618 runner-up: a margin of 0.34, far
above the 0.10 gate. Accepted, and it lands in YAML as a diff a reviewer reads in seconds:

```diff
@@ -30,14 +30,14 @@
     intent: open_new_invoice
     intent_critical: false
     locators:
-      - strategy: a11y_id
-        value: invoice.add.button
-        weight: 1
       - strategy: role_label
         value:
           role: button
           label: New Invoice
         weight: 0.6
+      - strategy: a11y_id
+        value: invoice.add.button
+        weight: 1
       - strategy: text
         value: New Invoice
         weight: 0.3
@@ -59,7 +59,7 @@
         y: 0.0604
         w: 0.2564
         h: 0.0427
-    status: verified
+    status: healed_pending_review
     last_verified_build: "4412"
   - id: invoice.filter.button
     role: button
```

That is the whole diff of `ios/screens/invoice_list.yaml` after `applyHeal` + `app-map export --force`:
`role_label` moved to the top of the cascade, the broken `a11y_id` locator stays below it so the element
self-repairs the moment a build restores the id, and the status changed. Signature, `variants`, edges and the
screen's six other elements are untouched.

**(c) The same change on an `intent_critical` element.** `invoice.save.button` loses its id and its label
changes `"Save"` → `"Done"`:

```json
{ "reason": "intent_critical_label_changed",
  "candidates": [ { "path": "navigationBar/button[1]", "label": "Done",   "score": 0.85 },
                  { "path": "navigationBar/button[0]", "label": "Cancel", "score": 0.7333 },
                  { "path": "scrollView/button",                          "score": 0.45 } ] }

{ "accepted": false, "reason": "intent_critical_label_changed",
  "record": { "recipe": "create_invoice", "step": "s5", "element": "invoice.save.button",
    "old_strategy": "a11y_id", "old_locator": { "strategy": "a11y_id", "value": "invoice.save.button", "weight": 1 },
    "score": 0.85, "runner_up_score": 0.7333,
    "accepted": false, "reason": "intent_critical_label_changed", "intent_critical": true, "build": "4412" } }
```

The top candidate scored 0.85 — above the 0.75 acceptance gate, and clear of the runner-up by more than the
0.10 margin — and it is still rejected. A changed label on a Save button might mean a different button, and
the cost of being wrong is an invoice sent to the wrong client. The result carries no `updated_element`, so
export writes nothing; the stored element status stays `verified` and its `misses` counter goes to 1, and the
run falls back to the model. **Healing is allowed to be confident about navigation and never about intent.**

*No device, no app, no Argent: the trees are committed fixtures mutated in memory (relabel, delete
`a11y_id`) exactly as `src/test/heal.test.ts` does, driven through the real `resolve`, `proposeHeal`,
`applyHeal`, `rejectHeal` and `export`. The three candidates in (c) are all of them.*

## 7. Drift in CI

On every PR — once the repo has a real app and `APP_MAP_HAS_APP=true` — the drift job deep-links to each
screen the new build's router export declares, and diffs what it finds against the map:

```markdown
### app-map drift — build 4412 (ios)

| screen | status | missing ids | hash changed |
| --- | --- | --- | --- |
| client_picker | skipped (no_deep_link) | — | no |
| invoice_list | ok | — | no |
| invoice_new | broken (marker_timeout) | invoice.amount.field, invoice.client.picker, invoice.save.button | yes |
...                                            # invoice_detail and login rows elided

1 ok · 0 degraded · 3 broken · 1 skipped
```

`client_picker` is honestly `skipped`, not guessed at; the build number comes from the router export, not a
flag. The JSON behind the table carries only ids and scores, never UI copy:

```json
{ "screen": "invoice_list", "status": "degraded", "marker_present": true, "required_present": 1,
  "missing_ids": [], "hash_changed": true, "unresolvable_elements": ["invoice.filter.button"],
  "ci_gate_referenced": false }
{ "screen": "invoice_list", "status": "broken", "marker_present": true, "required_present": 0.5,
  "missing_ids": ["invoice.add.button"], "hash_changed": true,
  "unresolvable_elements": ["invoice.add.button"], "ci_gate_referenced": false }
```

**degraded** — nothing required is missing, but an element no longer resolves by id and the structural hash
moved: replay works through the cascade, the map needs attention. **broken** — a required id is gone, and
named. A broken screen fails the PR only when a `ci_gate` recipe depends on it; that is what
`ci_gate_referenced` decides.

*Fake device; no simulator and no real Maestro. `maestro hierarchy` is a shell stub that prints one committed
hierarchy fixture (`fixtures/raw/maestro-hierarchy.invoice_list.json`), so screens other than `invoice_list`
time out on their marker — which is what makes the contrast visible. The `invoice_detail` and `login` rows of
the table are elided. The two JSON rows are separate runs of that same stub with one `resource-id` blanked:
`invoice.filter.button` (not required → degraded) and `invoice.add.button` (required → broken).*

---

## Security model

- **Structure only.** The committed map holds ids, roles, static copy from the app's own string table,
  locators, hashes, routes and edges. No screenshots, field values, cell text or user identifiers.
  `validate` rule 8 fails the build on anything that looks like PII.
- **Scrubbed at ingest.** Raw trees die inside `scrub()`; the type system brands a tree as scrubbed and every
  disk, database and model-facing path asserts that brand. Measured on the committed hook payload
  `fixtures/hooks/post-tool-use.tap.json`: of the 29 human-readable strings in its normalized tree, 15
  survive `scrub()` and 14 do not — among them the date picker's rendered `Oct 10, 2026`.
- **Debug and sandbox only.** `run_recipe` reads the app's `APP_MAP_DEBUG` probe and refuses with
  `release_build_refused` against a Release build; `deep_link_scheme_collision` when another
  installed app claims the same deep-link scheme (01 R5).
- **Pinned supply chain.** Every MCP server must be in `app-map/policy/mcp-allowlist.yaml` at an exact version;
  `policy-check` fails on an unlisted server or an unpinned `npx`.
- **Human-reviewed heals.** An accepted heal is `healed_pending_review`, never `verified`. Nightly heals open
  a PR and never merge. `intent_critical` steps are never healed automatically.

## Repository layout

| path | what | spec |
|---|---|---|
| `app-map/` | the map: `ids.yaml`, `schema/`, `ios/`, `android/`, `policy/` (+ git-ignored `.local/`) | 02 |
| `tools/app-map-mcp/` | the MCP server and CLI (TypeScript, ESM) | 03 |
| `instrumentation/ios/AppMapKit/` · `android/appmap/` | Swift package and Gradle module: markers, deep links, router export, fixtures, debug probe | 01 |
| `scripts/app-map/` | `gen-ids`, `router-export.sh`, `strings-export.sh`, `open-heal-pr.sh`, `ci-params.sh` | 01, 06, 07 |
| `.mcp.json` | project-scoped MCP servers; the single source for the Cursor and Codex configs | 05 §2 |
| `.claude/` | hooks (SessionStart, PostToolUse, PostToolUseFailure, Stop, PreCompact), the `app-nav` skill, the replayer agent, the `app-instrument` skill and its three instrumentation agents | 05 |
| `.github/workflows/app-map.yml` | validate · ios/android-instrumentation · drift/gate (iOS, Android) · nightly-heal · router-import | 06 |
| `CODEOWNERS` · `.gitattributes` | review policy · semantic YAML merge driver | 07 §7, 02 §9 |
| `docs/specs/` · `docs/dev/` | the eight specs; toolchain, harness notes, rollout, architecture | — |

## Status

What is exercised in this repository, and what still needs the real app.

| spec area | in this repo | needs the real app |
|---|---|---|
| 01 instrumentation | `gen-ids`, AppMapKit (Swift) and `appmap` (Kotlin) reference implementations with unit tests; the Swift package's tests and release gate run in CI on macOS, not in a Linux checkout | integrating the package/module, marking screens, fixtures, registering the URL scheme, `lint-ids` passing against real app source |
| 02 data model | schemas, `ids.yaml`, pilot YAML under `app-map/` | verifying the pilot files against real screens |
| 03 MCP server / CLI | `tools/app-map-mcp`: 13 MCP tools, 17 CLI commands, 818 unit tests (`npm test --prefix tools/app-map-mcp`); CLI names used by hooks and CI are listed in `docs/dev/harness-notes.md` §4 | build number from the running app; Argent tool names |
| 04 recipes | compiler, replay and healing in the server, covered by tests against fixtures | a recorded session to compile |
| 05 harness | `.mcp.json`, hooks, skill, replayer agent — verified against current hooks/subagents/skills docs | approving the servers; `gen-configs` output for Cursor and Codex |
| 06 CI | `app-map.yml`: `validate` and `ios-instrumentation` run unconditionally; `android-instrumentation`, both drift/gate jobs, `nightly-heal` and `router-import` are gated on the repo variable `APP_MAP_HAS_APP=true` | `scripts/build-app.sh` (stub → real build), simulator/emulator jobs, Maestro |
| 07 security | CODEOWNERS (`@ORG/platform-team` placeholder), `.gitattributes`, `strings-export.sh`, policy checks in CI | setting the owning team, branch protection, re-reviewing the Argent pin on every bump |
| 08 metrics | `docs/dev/rollout.md` templates and threshold cross-references | baseline runs on the pilot flow |

## Further reading

**Specs** — [01 instrumentation](docs/specs/01-app-instrumentation.md) · [02 data model](docs/specs/02-app-map-data-model.md) ·
[03 MCP server](docs/specs/03-app-map-mcp-server.md) · [04 recipes, replay, healing](docs/specs/04-recipes-replay-and-healing.md) ·
[05 harness](docs/specs/05-harness-integration.md) · [06 CI and drift](docs/specs/06-ci-and-drift.md) ·
[07 security](docs/specs/07-security-and-governance.md) · [08 metrics and rollout](docs/specs/08-metrics-and-rollout.md)

**Developer notes** — [architecture](docs/dev/architecture.md) (module map, data flows, the contract between
modules) · [toolchain](docs/dev/toolchain.md) · [harness notes](docs/dev/harness-notes.md) (verified hook
fields, CLI assumptions, deviations) · [rollout and thresholds](docs/dev/rollout.md) · [adopting in your
app](instrumentation/README.md)
