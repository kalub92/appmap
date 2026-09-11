# app-map-mcp — architecture and implementation contract

Status: contract v0.1 (authored against specs 01–08; every section cites the spec it implements).
This document is the interface between the module owners listed below. Implementation agents
work in parallel from the stubs in `tools/app-map-mcp/src/**` and must not change an exported
signature without updating this file and every caller. Read `docs/dev/toolchain.md` first.

## 1. Module map and ownership

| tag | files | status | depends on |
|---|---|---|---|
| contract | `src/types.ts`, `src/config.ts`, `src/errors.ts`, `src/paths.ts`, `src/token.ts`, `src/lib.ts`, `src/test/helpers.ts` | **implemented** | — |
| A1 | `src/yaml/load.ts`, `src/yaml/canonical.ts`, `src/yaml/schemas.ts`, `src/validate.ts`, `src/migrate-id.ts`, `src/merge-driver.ts` | stub | contract, `scrub.ts` (rule 8 patterns) |
| A2 | `src/log.ts`, `src/store/db.ts`, `src/store/export.ts`, `src/events.ts`, `src/context.ts` | stub | contract, A1 |
| B1 | `src/tree.ts`, `src/scrub.ts`, `src/signature.ts` | stub | contract |
| B2 | `src/identify.ts`, `src/resolve.ts`, `src/plan.ts`, `src/format.ts` | stub | contract, B1 |
| C1 | `src/observe.ts`, `src/recipes/match.ts`, `src/recipes/compile.ts`, `src/recipes/lifecycle.ts` | stub | A2, B1, B2 |
| C2 | `src/heal.ts`, `src/recipes/guided.ts` | stub | A2, B1, B2, C1 (lifecycle, observe) |
| C3 | `src/recipes/maestro.ts`, `src/recipes/headless.ts`, `src/drift.ts`, `src/router-import.ts` | stub | A2, B1, B2, C1, C2 |
| D1 | `src/server.ts`, `src/ingest-socket.ts`, `src/index.ts` | stub | everything |
| D2 | `src/cli.ts`, `src/lint-ids.ts`, `src/gen-configs.ts`, `src/policy-check.ts`, `src/report.ts` | stub | everything |

Import layering (no cycles — enforced by review; `lib.ts` lists modules in this order):

```
types/config/errors/paths/token/log
  → yaml/*, tree, scrub, signature
    → store/*, context, identify, resolve, plan, format
      → observe, recipes/*, heal, drift, router-import
        → server, ingest-socket, cli, lint-ids, gen-configs, policy-check, report
```

Design rules (apply to every module):

- Pure functions over data wherever possible: `identify(map, tree, opts)`, `resolve(map, element,
  tree)`, `scrub(tree, policy)`, `canonicalYaml(kind, obj)`, `planPath(map, from, to)`,
  `matchRecipe(map, instruction)`, `compareScreen(map, screen, tree)`. They take `LoadedMap`
  and trees, never `AppMapContext`, and never touch disk.
- Side-effecting modules take `AppMapContext` (`{config, map, db, events, log, build, reload,
  close}`) and are the only ones that write (`db`, trajectories, events, YAML via export).
- External processes (Maestro, simctl, adb) go through injectable `ExecFn`/`HierarchyProvider`/
  `BuildInfoProbe` parameters so every module is testable without a device.
- Every error is an `AppMapError(code, message, hint)`; tool handlers and the CLI convert with
  `toErrorJson` (03 §11). Stubs throw `NotImplementedError('<module>.<fn>')`.
- Raw (unscrubbed) trees never reach disk, the db, events or the LLM (03 §7, 07 §2). The
  `ScrubbedTree` type is runtime-branded by `scrubbed: true`; `db.insertObservation` and the
  trajectory writer must assert it.
- stdout is the MCP transport; logs go to `.local/server.log` (server) or stderr (CLI).

## 2. Data flows

### 2.1 Observation ingest (03 §2, 03 §7, 04 §2, 05 §3)

```
Claude Code PostToolUse(mcp__argent__*)  ──stdin JSON──▶ .claude/hooks/app-map-record.sh
   │ tries unix socket app-map/.local/ingest.sock (one JSON line, one response line)
   │ falls back to `app-map record --stdin` (same code path, direct SQLite)
   ▼
ingest-socket.ts / cli.ts ─▶ observe.recordHookPayload(ctx, payload)
   1. isDriverTool → else {ok:true, ignored:true}
   2. tree.extractSnapshot(tool_response) → tree.normalizeTree → scrub.scrub(policy)   [raw tree dies here]
   3. identify.identify(map, scrubbed, {route: input.url, build}) → screen_after, gates_present
      screen_before = db.lastObservation(session)?.screen_after ?? 'unknown'
   4. element = input.id if registered, else resolve the tapped node on screen_before (best effort)
   5. seq = db.nextSeq(session); task = db.getSession(session)?.task
   6. append JSON line to .local/trajectories/<session>.jsonl; db.insertObservation;
      db.setScreenLastSeen; counters (screen.seen, element.hits/misses, session.driver_calls,
      session.perception_bytes += scrub.perceptionBytes(snapshot))
   7. events.append({kind:'identify', screen, confidence, signal, build})
   ▼
{screen_before, screen_after, seq, gates_present, scrub_hits}
```

Ingest socket wire protocol (ingest-socket.ts): newline-delimited JSON over a unix socket;
request = one `HookPayload` line; response = one line: `{"ok":true,…RecordResult}` |
`{"ok":true,"ignored":true}` | `{"ok":false,"error","hint","code"}`; one request per connection;
2 s idle timeout; 4 MiB max request; socket file mode 0600; a second server instance that finds
a live listener skips the socket (only one instance owns it; all share the cache via WAL).

### 2.2 Guided replay (04 §5)

```
LLM  run_recipe(create_invoice, {amount:50, client:"Acme Corp"}, mode:guided)
SRV  guided.startGuidedRun: recipe eligible? params ok? probe(07 §3) debug+sandbox?
     expandSteps → [s0 open_link entry.deep_link expect{screen:invoice_new}, s1…s5]
     db.insertRun(active, current_step s0, last_seq = newest seq)
     → {run_id, step: toRunStep(s0)}                                    (≤120 tokens, format.formatRunStep)
LLM  mcp__argent__open_url(...)            → hook records observation seq N+1
LLM  report_step(run_id, s0, ok:true)
SRV  guided.reportStep: obs = newest with seq > run.last_seq (else fallback no_observation)
     gates_present? → {status:'gate', step: dismiss_gate g, retry: s0}   (≤2 per step, then gate_limit)
     checkExpect(s0.expect, obs.snapshot, obs.screen_after)
       fail → {status:'fallback', reason:'expect_failed', screen_seen, candidates}; run.state=fallback;
              events recipe_run{fallbacks:1, fallback_step}
       ok   → next = s1; resolve(map, element(s1), obs.snapshot)
                hit                    → {status:'ok', step: s1 (with target/resolved)}
                degraded|miss          → heal.heal(ctx, input, verify)  (≤1 per step)
                   accepted            → {status:'ok', step: s1, healed}
                   rejected            → {status:'fallback', reason: heal_rejected | intent_critical_label_changed}
     last step ok → checkExpect(recipe.verify) → {status:'done', verified, heals}; lifecycle.recordRunOutcome
```

The heal `verify` callback in guided mode returns the next `report_step`'s postcondition check;
the runner therefore hands out the candidate as the step target, and the acceptance is recorded
only once the following observation satisfies `expect` (04 §7.2.3). In headless mode `verify`
re-exports the flow from step k and reruns it (04 §6.1).

### 2.3 Export (02 §2, 03 §4)

```
session writes → db (rows marked dirty with reason)          [server never writes YAML]
app-map export (Stop hook / dev / CI) → store/export.exportMap(ctx)
   for each dirty screen/recipe: text = canonicalYaml(kind, entity)
     gitBlobHash(path) !== blob_sha recorded at load and !force → conflicts[] (+ diff), skip
     else write, clear dirty
   --check: for every YAML: canonicalYaml(parse(text)) === text else non_canonical[]
```

## 3. Canonical YAML (02 §2.3) — exact rules

`src/yaml/canonical.ts` must reproduce every file under `app-map/` byte-for-byte (the pilot files
were generated by a reference implementation of these rules; `validate-pilot.mjs` and the A1
tests compare). The rules:

1. **Key order per type** (`KEY_ORDER`; unknown keys after, sorted by code point):

| type | order |
|---|---|
| ids | schema_version, screens, gates, elements |
| ids.screen | id, title, deep_link |
| ids.gate | id, dismiss |
| ids.element | id, kind, intent_critical, dynamic, label_regex |
| manifest | schema_version, app_id, platform, deep_link_scheme, build, generated_at, generator |
| build | version, build_number, git_sha |
| screen | id, kind, title, deep_link, signature, dynamic_regions, gates, variants, elements, edges, meta |
| signature | marker, route, nav_class, required_ids, required_labels, structural_hash |
| variant | id, when, required_ids, structural_hash |
| element | id, role, label, intent, intent_critical, dynamic, locators, fingerprint, status, last_verified_build |
| locator | strategy, value, weight — `value` is `role_label` (role, label, label_regex) or `point` (x, y) or a scalar |
| fingerprint | role, label_norm, parent_role, sibling_index, bbox_norm (x, y, w, h) |
| edge | action, to, preconditions, postconditions, status, last_verified_build |
| action | type, element, direction, url, gate |
| condition | auth, screen, flag, value, platform_version |
| meta | sources, status, last_verified_build |
| recipe | id, version, platform, description, matches, params, preconditions, entry, steps, verify, status, provenance, last_verified_build |
| param | name, type, required, values |
| entry | deep_link, fallback_path |
| step | id, action, element, list, match, text, direction, duration_ms, url, gate, timeout_ms, expect, intent_critical |
| match | text |
| expect | screen, focused, visible, not_visible, text_present |
| provenance | compiled_from, compiled_by, reviewed_by, revision_of |
| mcp-allowlist | schema_version, servers |
| server | name, source, transport, command, args, package, version, reviewer, reviewed_at, notes |

2. **Omission**: `undefined`/`null` keys omitted; optional empty arrays omitted; required arrays
   (`elements`, `edges`, `steps`, `params`, `screens`, `gates`, `elements` in ids, `servers`)
   kept even when empty.
3. **Sorting**: object lists `screens`, `gates`, `elements`, `variants` by `id`; `edges` by
   `(action.type, action.element ?? action.url ?? action.gate ?? '', action.direction ?? '', to)`;
   `servers` by `name`; string sets `required_ids`, `dynamic_regions`, `gates`, `sources`,
   `visible`, `not_visible` sorted; all comparisons by code point (`<`). **Never reordered**:
   `steps`, `locators`, `matches`, `params`, `fallback_path`, `preconditions`, `postconditions`,
   `required_labels`, `args`, `values`.
4. **Text**: `yaml@2.9.0 stringify(ordered, { indent: 2, lineWidth: 0, minContentWidth: 0,
   singleQuote: false, nullStr: 'null' })`; block style everywhere (the flow-style `{…}` in the
   spec examples is illustrative); default quoting (plain unless required — `"4412"`,
   `"{amount}"`, `"true"`, `"@swmansion/argent"` get double quotes); numbers as JS numbers (`1`,
   `0.6`); LF; exactly one trailing newline; no comments, no `---`.
5. `manifest.generated_at` is the only timestamp and changes only when the manifest changes.

## 4. Tree, path, hash, fingerprint conventions (B1)

- `TreeNode` (types.ts): `role`, `a11y_id?`, `label?`, `value?` (raw only), `text?` (raw only),
  `enabled?`, `focused?`, `selected?`, `bbox_norm {x,y,w,h}` in [0,1] (4 decimals), `children[]`
  in document order. `Tree` wraps it with `schema_version: 1`, `platform`, `source`, `viewport?`.
- **Structural hash** (02 §4.4): pairs `"<role>\t<a11y_id>"` for every node with an id, excluding
  descendants of any `dynamic_regions` node (the region node itself included); sort by code
  point (keep duplicates); join with `\n`; sha1 hex; prefix `sha1:`.
  `structuralHash(fixtures/trees/invoice_list.normalized.json, ['invoice.list.table'])` =
  `sha1:262365d418093134bfe9b089192ab10fe3575007` (see the pilot screen files for the others).
- **Path** (02 §5.1): from the screen root (the marker node when exactly one exists, else the
  tree root), exclusive, to the node; segment = `role` when the node is the only child with that
  role among its siblings, else `role[i]` with `i` the 0-based index among same-role siblings.
  `navigationBar/button[1]`, `list/cell[0]`, `tabBar/tab[2]`, `list`.
- **Fingerprint** (02 §5.3): `sibling_index` = index among *all* siblings (0-based);
  `label_norm` = `labelNorm(label)` = NFKC → lowercase → strip apostrophes → non-`[a-z0-9]` runs
  → single space → trim (`"Don’t Allow"` → `dont allow`).
- **Geometry locator value** = bbox centre, 4 decimals.
- Scrubber (03 §7, 07 §2.3): see `scrub.ts` header; keep `label` only for registered
  non-dynamic ids, `label_regex` matches, or exact static-table matches on
  `button|tab|navigationBar|staticText`; everything under a dynamic id loses all text; PII
  regexes replace with `[redacted]` and count `scrub_hits`.

## 5. SQLite schema (A2 creates; `store/db.ts` `DDL`)

WAL mode, `busy_timeout = 2000`, short `BEGIN IMMEDIATE` transactions. `meta.schema_version`
mismatch → drop and recreate (the cache is regenerable from YAML + logs, 02 §7).

| table | columns | purpose |
|---|---|---|
| meta | key PK, value | `schema_version`, `tree_hash`, `loaded_at`, `platform`, `build`, `last_retention_run` |
| screens | id PK, platform, kind, status, last_verified_build, blob_sha, json, dirty, last_seen | screens and gates (`json` = ScreenFile); `blob_sha` = git blob at load for export conflicts |
| elements | (screen_id, id) PK, role, status, intent_critical, json, dirty; index on id | denormalized for `find_element`, heal updates and pending-heal counts |
| recipes | id PK, platform, version, status, blob_sha, json, dirty | RecipeFile |
| runs | run_id PK, recipe_id, version, mode, session, state, current_step, step_index, ok, heals, fallbacks, build, started_at, finished_at, json | guided/headless run state (`json` = RunRecord) |
| run_steps | (run_id, step_id, attempt) PK, gate_dismissals, heals, ok, ts, json | per-step bookkeeping for the 2-gate/1-heal limits |
| observations | (session, seq) PK, ts, task, tool, element, screen_before, screen_after, ok, latency_ms, snapshot_bytes, json; index on ts | Observation incl. scrubbed snapshot (`json`) |
| sessions | session PK, task, task_seq, mode, started_at, last_seq, driver_calls, perception_bytes, screenshots | 04 §2 task association and 08 §2 `task` counters (added beyond the spec's table list) |
| counters | (kind, key, name) PK, value | volatile: element hits/misses/heals; recipe runs/replay_success/fallbacks; screen seen |
| dirty | (kind, key) PK, reason, ts | what `export` writes |

## 6. events.jsonl contract (08 §2)

One `Event` per line (`types.ts` `Event` union; schema `events.schema.json` validates a line).
`ts` RFC 3339 UTC (`types.now()`), `platform` defaults to the config platform, `session`
optional. Appended by `events.appendEvent` in one `appendFileSync` call; readers skip malformed
or truncated lines. Kinds and required fields:

| kind | fields |
|---|---|
| task | session, task, mode_start, mode_end, ok, driver_calls, perception_bytes, screenshots, ms (+build) |
| recipe_run | recipe, version, mode, ok, steps, steps_done, heals, fallbacks, ms, build (+run_id, fallback_step, fallback_reason) |
| heal | recipe, step, element, old_strategy, score, accepted, reason, build (+new_strategy, intent_critical, run_id) |
| identify | screen (`unknown` allowed), confidence, signal, build (+variant, gates_present, candidates) |
| drift | screen, status, missing_ids, hash_changed, build (+ci_gate_referenced) |
| compile | recipe, version, from_session, steps, params (+ok, reason) |

A guided run that falls back is a `recipe_run` with `mode: guided`, `ok: false`, `fallbacks ≥ 1`
and `fallback_step` (04 §5 "logged as guided_fallback"). Retention: 14 days (config
`retentionDays`), pruned on server start.

## 7. Decisions where the specs are silent or disagree

1. **Block vs flow style** — 02 §2.3 mandates block style while 02 §4/§6 examples use flow
   mappings; canonical form is block everywhere (§3 above).
2. **Gate dismiss controls live only in `ids.gates[].dismiss`** (01 R1 example; the sibling
   `scripts/app-map/gen-ids` rejects `gate.*` under `elements`). Validation rule 02 §10.2 treats
   them as registered; `LoadedMap.elementRegistry` synthesizes `{kind:'button'}` entries.
3. **Structural-hash encoding** (02 §4.4 gives the idea, not the bytes): §4 above. Region node
   included, descendants excluded, duplicates kept.
4. **Path index vs sibling_index** — the 02 §4.1 example has `navigationBar/button[1]` and
   `sibling_index: 1`; defined as same-role index (path) vs all-siblings index (fingerprint), and
   the pilot nav bar is laid out so both are 1 for `invoice.add.button`.
5. **Gates carry `meta` and edge `status`** although the 02 §4.2 sketch omits them — the screen
   schema requires `meta` and `edges[].status` for every file.
6. **Ordered lists are never id-sorted**: `steps` (s10 < s2 lexically would break replay),
   `locators` (rank), `matches` (tried in order), `params`, `fallback_path`.
7. **Weights serialize as JS numbers** (`1`, not `1.0`); the schema accepts both.
8. **Error JSON carries `code`** in addition to 03 §11's `{error, hint}`.
9. **`client_picker` has `deep_link: none`** (01 R5 "screens without one cost navigation
   steps") so `plan_path`, `fallback_path` and drift `skipped` have a real case.
10. **Drift status `skipped`** added to `ok|degraded|broken` (06 R4) for screens without deep
    link or absent from the router export; never blocks.
11. **`recipe_run` covers guided_fallback** (no separate event kind; §6).
12. **Driver shapes are best-effort**: Argent snapshot (`{type, identifier, label, value, frame,
    children}`), Maestro hierarchy (`{elements:[{attributes, children}]}`), the hook
    `tool_response` (`structuredContent.snapshot`) — fixtures carry a `_note`; `tree.ts`
    detects shapes and must stay tolerant.
13. **Trajectory `input` keeps typed text** (needed by the compiler, 04 §3.4); trajectories are
    local-only (07 §2.4) and snapshots are scrubbed. The fixture values (`50`, `Acme Corp`) are
    fixture data by definition.
14. **`invoice_list.no_ids` fixture drops every id including the marker**: identify → `unknown`
    with `invoice_list` as top candidate via `title` (0.4); `find_element` with an explicit
    `screen_id` resolves by `role_label` and reports `degraded` (03 §12).
15. **First observation of a session has `screen_before: 'unknown'`**.
16. **`sessions` table** added to the spec's list (02 §7 leaves the schema to 03).
17. **Entry steps in guided runs**: `s0` = `open_link entry.deep_link`; without a deep link the
    `fallback_path` expands to `s0a`, `s0b`, … edge taps (RunStep ids are not schema-validated).
18. **Decay** (02 §8) applies only when both build numbers parse as integers; otherwise no decay.
19. **Gates never win identification**; a tree that is only a gate is `unknown` +
    `gates_present`.
20. **07 §3 Release-build probe** = the iOS `UserDefaults` record `app_map_debug_probe`
    (instrumentation/ios AppMapDebugEndpoint) read via `simctl spawn … defaults read`; Android
    best-effort via `adb shell run-as`; both behind the injectable `BuildInfoProbe`.
21. **`APP_MAP_RETENTION_DAYS`** env added (default 14) so tests can shorten retention; not in
    the 03 §3 table.
22. **Android pilot trees are synthetic** (same layout as iOS, dp viewport); hashes coincide with
    iOS. Stage 2 (08 §6) regenerates them from the emulator.
23. **Scrubber drops Android `text` unconditionally** (treated like `value`); `label` is the
    only surviving string.
24. **`label_regex` on ids elements** (07 §9 open question) is in the schema and honored by the
    scrubber.
25. **`summary` text format is fixed** (03 §8 lists content, not layout) — see format.ts.
26. **`intent_critical` absent means false** for the agreement rule (02 §10.6), in ids, screen
    elements and recipe steps alike.
27. **`route` identification signal** comes from the `open_url` input of the observation (Argent
    does not report routes); `tree.route` is honored when a driver provides it.
28. **Role vocabulary** is the closed `ROLES` list (24 roles); platform types map onto it,
    unknown → `other`. `tab` is derived (button inside a tab bar).
29. **`text_present` expectation** compares against node `label` equality (scrubbed trees have
    no other text).
30. **Heal reason enum** (`accepted|low_score|ambiguous|intent_critical_label_changed|no_expect|
    postcondition_failed|no_candidates`) is closed in heal-report and `HealReason`; the `heal`
    event keeps `reason` as a free string for forward compatibility.

## 8. How to implement your module

Tests live in `src/test/<module>.test.ts` (node:test, `node --disable-warning=ExperimentalWarning
--test "src/test/**/*.test.ts"`); use `src/test/helpers.ts` (`makeTempAppMapDir`, `loadFixtureTree`,
`loadTrajectoryFixture`, `loadHookFixture`, `loadRouterExportFixture`, `loadStaticStringsFixture`).
Fixtures: `tools/app-map-mcp/fixtures/**`. Do not modify the pilot YAML or fixtures to make a
test pass — they are the contract; if one is wrong, say so in the PR.

### A1 — YAML layer
Fill: `canonical.ts` (`canonicalize`, `canonicalYaml`, `isCanonical`), `schemas.ts`
(`loadSchemas`, `getValidator`, `validateAgainstSchema`, `assertValid`, `validateEventLine`),
`load.ts` (`parseYamlFile`, `readIds`, `readManifest`, `readScreenFiles`, `readRecipeFiles`,
`readAllowlist`, `readStaticStrings`, `indexMap`, `loadMap`, `gitTreeHash`, `gitBlobHash`),
`validate.ts` (`validateMap`, `crossReferenceIssues`, `forbiddenContentIssues`,
`nonCanonicalFiles`, `formatIssues`), `migrate-id.ts`, `merge-driver.ts`.
Tests: `canonical.test.ts` — every file under app-map/ round-trips byte-for-byte; key-order and
sort rules; `schemas.test.ts` — pilot files valid, a mutated file (extra key, bad enum, lone
text locator) invalid; `load.test.ts` — `loadMap` on the temp pilot: 5 screens, 2 gates,
1 recipe, 34 registered element ids (32 + 2 dismiss), markers/routes indexed, <500 ms;
`validate.test.ts` — one failing case per rule 1–8 (rename an id without migrate-id → rule 2
lists the dangling references, 06 §5); `migrate-id.test.ts` — rename `invoice.add.button`,
zero dangling references, canonical output; `merge-driver.test.ts` — branch adding
`client_picker.yaml` vs branch editing `invoice_list.yaml` merges clean (02 §11); same-key edit
conflicts.

### A2 — store
Fill: `log.ts`, `store/db.ts` (every `AppMapDb` method + `DDL`), `store/export.ts`,
`events.ts`, `context.ts`.
Tests: `db.test.ts` — schema creation, `upsertMap` preserves dirty rows and counters, `nextSeq`
monotonic, `recipeStats` aggregates, WAL stress: two `AppMapDb` handles inserting 500
observations each concurrently (worker threads) → no corruption, all rows present (03 §12);
`export.test.ts` — export twice → no diff (02 §11), conflict when the file's blob changed,
`--check` flags a hand-edited non-canonical file; `events.test.ts` — append/read, truncated last
line tolerated, `pruneLocal` deletes 15-day-old trajectories and keeps 13-day-old;
`context.test.ts` — `openContext` on the temp pilot, reload when a screen file changes
(tree hash differs), `loadError` path when ids.yaml is broken; `log.test.ts` — rotation at the
limit, no `label`/`value`/`snapshot` fields at any level.

### B1 — trees
Fill: `tree.ts`, `scrub.ts`, `signature.ts`.
Tests: `tree.test.ts` — `normalizeTree` on `raw/argent-snapshot.invoice_list.json` and
`raw/maestro-hierarchy.invoice_list.json` yields the same roles/ids as
`trees/invoice_list.normalized.json` (bbox within 0.01); `pathOf` reproduces every `path`
locator in the pilot screens; `extractSnapshot(loadHookFixture('post-tool-use.tap').tool_response)`
finds the snapshot; `scrub.test.ts` — `trees/pii.normalized.json` through `scrub` with the
fixture policy contains no email, phone, 16-digit run, `$1,250.00`, `€`, `£`, IBAN, SSN,
`Acme Corp` or the search-field value; `scrub_hits > 0`; no `value` key anywhere; static labels
(`Invoices`, `New Invoice`, `Don’t Allow`) survive; `signature.test.ts` — `structuralHash` of
each pilot tree equals the committed `signature.structural_hash`; variant hash for
`new_invoices_ui`; `requiredIdsFraction`; `gateSignatureMatches` true for
`invoice_list.with_gate` × `gate.push_permission` and `login.with_gate` × `gate.biometric_prompt`,
false otherwise; `labelNorm` cases.

### B2 — identification and resolution
Fill: `identify.ts`, `resolve.ts`, `plan.ts`, `format.ts`.
Tests: `identify.test.ts` — every pilot tree → its screen with confidence 1.0 (03 §12);
`invoice_list.with_gate` → `invoice_list` + `gates_present: [gate.push_permission]`;
`invoice_list.no_ids` → `unknown` with `invoice_list` among the top-3; marker removed but ids kept
→ `required_ids` + `structural_hash` agree → ≥ 0.85; decay `0.9^n` floor 0.2; variant wins when
`flag` matches; 2,000-node synthetic tree < 50 ms; `resolve.test.ts` — every pilot element
resolves by `a11y_id` with confidence 1.0; on `invoice_list.no_ids` `invoice.add.button`
resolves by `role_label`, `degraded: true`, confidence 0.6; two cells share `invoice.list.cell` →
disambiguated by fingerprint (confidence 0.9); `plan.test.ts` — `plan_path(login, invoice_new)` →
deep link; `plan_path(invoice_new, client_picker)` → one edge; `format.test.ts` — exact
`get_screen` block for `invoice_list` (03 §8), summary ≤600 tokens and ≥ the recipe list,
`formatRunStep` ≤120 tokens.

### C1 — observations, matching, compile, lifecycle
Fill: `observe.ts`, `recipes/match.ts`, `recipes/compile.ts`, `recipes/lifecycle.ts`.
Tests: `observe.test.ts` — `recordHookPayload(hooks/post-tool-use.tap.json)` → `screen_after:
invoice_new`, a trajectory line written with a scrubbed snapshot, a `hits` counter bump, an
`identify` event; non-driver tool → `null`; failure payload recorded with `ok: false`;
`match.test.ts` — `"create an invoice for $50 for Acme"` → `create_invoice`, 0.9, `params_needed`
empty; `"make invoice"` → `params_needed: [amount, client]`; `"delete a client"` → no_match with
≤8 candidate lines; `compile.test.ts` — `trajectories/create_invoice.session.jsonl` compiles to a
recipe equal to `app-map/ios/recipes/create_invoice.yaml` modulo `matches`, `description`,
`status: candidate`, `version: 1`, `provenance` (the A→B→A loop at seq 2–3 collapses; `50` →
`{amount}`, `Acme Corp` → `{client}`); an unparameterized literal → `unparameterized_value`;
`lifecycle.test.ts` — `decideTransition` for each row of the table (3 successes / 2 sessions →
verified; 6 of last 10 failed → candidate, 04 §9; pending heals ≥2 → candidate; ci_gate never
automatic); `THRESHOLDS` equal the 08 §5 numbers.

### C2 — healing and guided replay
Fill: `heal.ts`, `recipes/guided.ts`.
Tests: `heal.test.ts` — remove `invoice.add.button`'s id from `invoice_list` (keep label) →
accepted via `role_label`, element `healed_pending_review`, new locator at rank 0 (04 §9);
change `invoice.save.button`'s label and remove its id → rejected `intent_critical_label_changed`
(04 §9); `no_expect` for a step without expect; `jaroWinkler`/`lcsLength` known values;
`guided.test.ts` — full happy path of `create_invoice` driving `reportStep` with fixture
observations inserted between calls (s0…s5 → done, verified); gate on s0 → `gate` then retry;
third gate → fallback `gate_limit`; expect failure → fallback + `recipe_run{fallbacks:1}`;
`skipBuildCheck:false` with a probe returning `null` or `build_type:'release'` →
`release_build_refused` (07 §8); state survives a new `openContext` between `run_recipe` and
`report_step`.

### C3 — Maestro, headless, drift, router import
Fill: `recipes/maestro.ts`, `recipes/headless.ts`, `drift.ts`, `router-import.ts`.
Tests: `maestro.test.ts` — the flow for `create_invoice` matches a golden string (04 §6.2
table order; `dismiss_gate` runFlow emitted before steps on screens listing the gate); an element
with only `path`/`geometry` → `eligible: false`; `headless.test.ts` — with a fake `exec` that
succeeds → report ok, `steps_done = 5`; fake exec failing at command k with a fake hierarchy →
heal attempted, ≤2 retries, `fallback_step`; missing maestro → `maestro_unavailable`;
`drift.test.ts` — pilot trees → all `ok`; tree without `invoice.add.button` → `invoice_list`
`broken` with `missing_ids: [invoice.add.button]` and `blocking` when `create_invoice` is
`ci_gate` (06 §5); label-only change → `ok`; report validates against
`drift-report.schema.json`; `router-import.test.ts` — `fixtures/router-export.ios.json` on the
pilot: `settings` created as candidate (must be in ids.yaml — the fixture expects `invalid_map`
until `settings` is registered; assert the error names it), existing screens unchanged, no
edges lost; a screen absent from the export → `retired` and its recipes retired.

### D1 — server and socket
Fill: `server.ts`, `ingest-socket.ts`, `index.ts`.
Tests: `server.test.ts` — in-memory MCP client (SDK `InMemoryTransport`) lists exactly the 13
tools and 3 resource templates; `summary` ≤600 tokens; `get_screen` block; every tool returns
`{error, hint, code}` with `isError` instead of throwing (feed a bad `screen_id`); resources
return the YAML verbatim; `ingest-socket.test.ts` — start on a temp socket, post
`hooks/post-tool-use.tap.json`, get `{ok:true, screen_after:'invoice_new'}`; oversized line →
`bad_input`; second instance → `listening: false`; client returns `null` when no socket.

### D2 — CLI and CI commands
Fill: `cli.ts`, `lint-ids.ts`, `gen-configs.ts`, `policy-check.ts`, `report.ts`.
Tests: `cli.test.ts` — `validate` exit 0 on the pilot, 1 on a broken copy; `record --stdin`
always exit 0 (even with garbage); `summary --hook-json` prints a `SessionStartHookOutput`;
`export --check` exit 1 on a non-canonical file; `gen-configs.test.ts` — `.mcp.json` →
`.cursor/mcp.json` / `.codex/config.toml` golden strings, `--check` stale detection;
`policy-check.test.ts` — unlisted server, `npx` without pin, secret literal, hook outside
`.claude/hooks/` each fail (06 §5, 07 §8); `lint-ids.test.ts` — string-literal id in a Swift
fixture flagged, unreferenced marker flagged; `report.test.ts` — synthetic events → each 08 §4
metric, alerts at the thresholds.

## 9. Repository layout touched by this package

```
app-map/
  ids.yaml                    shared registry (01 R1)
  schema/*.schema.json        10 schemas (draft-07)
  policy/mcp-allowlist.yaml   07 §6
  ios/{manifest.yaml, screens/*.yaml, recipes/*.yaml}
  android/{manifest.yaml, screens/*.yaml, recipes/*.yaml}
  .local/                     git-ignored runtime state (see paths.ts)
tools/app-map-mcp/
  src/**                      this package
  fixtures/**                 trees, raw driver dumps, hooks, router export, trajectory, strings
  scripts/validate-pilot.mjs  schema + cross-reference check without the CLI
```
