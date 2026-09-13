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
| C1 | `src/observe.ts`, `src/recipes/match.ts`, `src/recipes/compile.ts`, `src/recipes/verbs.ts`, `src/recipes/lifecycle.ts` | stub | A2, B1, B2 |
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
- Side-effecting modules take `AppMapContext` (`{config, map, db, events, log, build, probe,
  loadError, reload, setBuild, setProbe, close}`) and are the only ones that write (`db`,
  trajectories, events, YAML via export).
- External processes (Maestro, simctl, adb) go through injectable `ExecFn`/`HierarchyProvider`/
  `BuildInfoProbe` parameters so every module is testable without a device.
- Every error is an `AppMapError(code, message, hint)`; tool handlers and the CLI convert with
  `toErrorJson` (03 §11). Stubs throw `NotImplementedError('<module>.<fn>')`.
- Raw (unscrubbed) trees never reach disk, the db, events or the LLM (03 §7, 07 §2). The
  `ScrubbedTree` type is branded twice: at compile time by a `declare`d unique symbol that only
  `scrub()` mints (one cast inside scrub.ts — `{...raw, scrubbed: true}` does not type-check),
  and at runtime by `scrubbed: true`. `db.insertObservation`, the trajectory writer and every
  event/tool output carrying a tree call `assertScrubbed` as a precondition (07 §8).
- Variant facts (02 §4.3) have exactly one source: the 07 §3 probe (`BuildProbeResult.flags /
  auth / platform_version`), cached on `ctx.probe` and passed to `identify` via
  `probeConditions(ctx.probe)` by observe/guided/headless/drift.
- stdout is the MCP transport; logs go to `.local/server.log` (server) or stderr (CLI).

## 2. Data flows

### 2.1 Observation ingest (03 §2, 03 §7, 04 §2, 05 §3)

```
Claude Code PostToolUse(mcp__argent__*)  ──stdin JSON──▶ .claude/hooks/app-map-record.sh
   │ tries unix socket app-map/.local/ingest.sock (one JSON line, one response line)
   │ falls back to `app-map record --stdin` (same code path, direct SQLite)
   ▼
ingest-socket.ts / cli.ts ─▶ observe.recordHookPayload(ctx, payload)
   0. hook_event_name Stop → observe.finishTask(session, inferTaskOutcome) → {ok:true, ignored:true}
   1. isDriverTool → else {ok:true, ignored:true}
   2. tree.extractSnapshot(tool_response) → tree.normalizeTree → scrub.scrub(policy)   [raw tree dies here]
      config.build === 'auto' && tree.build → ctx.setBuild(tree.build)                 (03 §3)
   3. identify.identify(map, scrubbed, {route: input.url, build, ...probeConditions(ctx.probe)})
      → screen_after, gates_present; screen_before = db.lastObservation(session)?.screen_after ?? 'unknown'
   4. element = input.id if registered, else resolve the tapped node on screen_before (best effort)
   5. seq = db.nextSeq(session); task = db.getSession(session)?.task;
      input.text and task pass through scrub.redactString (PII deny list) before persisting
   6. assertScrubbed(snapshot); append JSON line to .local/trajectories/<session>.jsonl;
      db.insertObservation; db.setScreenLastSeen; counters (screen.seen, element.hits/misses,
      session.driver_calls, session.perception_bytes += scrub.perceptionBytes(snapshot))
   7. events.append({kind:'identify', screen, confidence, signal, build})
   8. signal marker ∧ required_present 1 ∧ hash matches → lifecycle.markVerified({screens:[screen_after]})  (02 §8 lazy re-verify)
   ▼
{screen_before, screen_after, seq, gates_present, scrub_hits}
```

Task association (04 §2): `match_recipe` calls `observe.declareTask` on every call (matched or
`no_match` — there is no `name_task` tool); `compile_recipe` declares the task when the session
has none. A task closes (`observe.finishTask` → `task` event, `sessions.task_end_seq`) on
`compile_recipe` ok, on the Stop hook (routed through `record --stdin`/the socket, step 0 above,
outcome inferred by `inferTaskOutcome`) and on guided `done`.

Ingest socket wire protocol (ingest-socket.ts): newline-delimited JSON over a unix socket;
request = one `HookPayload` line; response = one line: `{"ok":true,…RecordResult}` |
`{"ok":true,"ignored":true}` | `{"ok":false,"error","hint","code"}`; one request per connection;
2 s idle timeout; 4 MiB max request; socket file mode 0600; a second server instance that finds
a live listener skips the socket (only one instance owns it; all share the cache via WAL).

### 2.2 Guided replay (04 §5)

```
LLM  run_recipe(create_invoice, {amount:50, client:"Acme Corp"}, mode:guided)
SRV  guided.startGuidedRun: recipe eligible? params ok? probe(07 §3) debug+sandbox? → ctx.setProbe
     session = input.session ?? newest observation's session (none → no_observation)
     expandSteps → [s0 open_link entry.deep_link expect{screen:invoice_new}, s1…s5]
     db.insertRun(active, session, current_step s0, start_seq = last_seq = session.last_seq)
     → {run_id, step: toRunStep(s0)}                                    (≤120 tokens, format.formatRunStep)
LLM  mcp__argent__open_url(...)            → hook records observation seq N+1
LLM  report_step(run_id, s0, ok:true)
SRV  guided.reportStep: obs = newest of db.listObservations(run.session, {fromSeq: run.last_seq+1})
     (never another session; none → fallback no_observation); run.last_seq = obs.seq
     gates_present? → {status:'gate', step: dismiss_gate g, retry: s0}   (≤2 per step, then gate_limit)
     checkExpect(step.expect, obs.snapshot, obs.screen_after)
       run.pending_heal for this step?
         held   → heal.applyHeal({pending, recipe}) → run.heals += summary; pending cleared
         failed → heal.rejectHeal(…, 'postcondition_failed') → {status:'fallback', reason:'heal_rejected'}
       fail → {status:'fallback', reason:'expect_failed', screen_seen, candidates}; run.state=fallback;
              events recipe_run{fallbacks:1, fallback_step}
       ok   → lifecycle.markVerified({screens, elements, edges}) for what the observation confirmed
              next = s1; resolve(map, element(s1), obs.snapshot)
                hit                    → {status:'ok', step: s1 (with target/resolved), healed?: summary of a heal accepted above}
                degraded|miss          → heal.proposeHeal(input)  (≤1 per step, then heal_limit)
                   candidate           → run.pending_heal = toPendingHeal(...); {status:'ok', step: s1 (target = candidate, healing:true)}
                   rejected            → heal.rejectHeal → {status:'fallback', reason: heal_rejected | intent_critical_label_changed}
     last step ok → checkExpect(recipe.verify) → {status:'done', verified, heals};
                    lifecycle.markVerified({recipe}); lifecycle.recordRunOutcome; observe.finishTask(session, {ok, mode_end:'guided'})
```

Healing is a three-stage API (heal.ts) because the postcondition (04 §7.2 rule 3) is only
observable later: `proposeHeal` (pure) → the runner acts on the candidate → `applyHeal` /
`rejectHeal` (write + `heal` event). Guided mode persists the candidate as
`RunRecord.pending_heal` (serializable: locator + fingerprint, no node) so the next
`report_step` — possibly in a new process after `openContext` — can settle it. Headless mode uses
the `heal()` wrapper whose `verify` re-exports the flow from step k and reruns it (04 §6.1).

### 2.3 Export (02 §2, 03 §4)

```
loadMap → LoadedMap.files: relPath → {kind, id, blob_sha = gitBlobHash(path)}   (03 §4 conflict baseline)
db.upsertMap copies blob_sha into screens/recipes/registry rows
session writes → db (rows marked dirty with reason; kinds screen | recipe | ids | manifest)   [server never writes YAML]
app-map export (Stop hook / dev / CI) → store/export.exportMap(ctx)
   for each dirty row: path from paths.ts (platform = ctx.config.platform); text = canonicalYaml(kind, entity)
     recorded blob_sha and gitBlobHash(path) differ and !force → conflicts[] (+ unifiedDiff), skip
     no recorded sha (new screen) and the file exists → conflicts[]
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
  regexes replace with `[redacted]` and count `scrub_hits` — applied to every label and to
  every UNREGISTERED `a11y_id` (registered ids, markers and gate dismiss ids are exempt).
- Argent wrapper fields: `build_number` → `Tree.build`, `bundle_id` → `Tree.app_id`; `udid` is
  dropped (07 §2.2).

## 5. SQLite schema (A2 creates; `store/db.ts` `DDL`)

WAL mode, `busy_timeout = 2000`, short `BEGIN IMMEDIATE` transactions. `meta.schema_version`
mismatch → drop and recreate (the cache is regenerable from YAML + logs, 02 §7).

| table | columns | purpose |
|---|---|---|
| meta | key PK, value | `schema_version`, `tree_hash`, `loaded_at`, `platform`, `build`, `last_retention_run` |
| screens | id PK, platform, kind, status, last_verified_build, blob_sha, json, dirty, last_seen | screens and gates (`json` = ScreenFile); `blob_sha` = git blob at load (`LoadedMap.files`) for export conflicts |
| registry | kind PK (`ids` \| `manifest`), blob_sha, json, dirty | ids.yaml and the platform manifest, so import-router can register screens / bump the build and `export` writes them |
| elements | (screen_id, id) PK, role, status, intent_critical, json, dirty; index on id | denormalized for `find_element`, heal updates and pending-heal counts |
| recipes | id PK, platform, version, status, blob_sha, json, dirty | RecipeFile |
| runs | run_id PK, recipe_id, version, mode, session NOT NULL, state, current_step, step_index, ok, heals, fallbacks, build, started_at, finished_at, json | guided/headless run state (`json` = RunRecord incl. `start_seq`, `last_seq`, `pending_heal`) |
| run_steps | (run_id, step_id, attempt) PK, gate_dismissals, heals, ok, ts, json | per-step bookkeeping for the 2-gate/1-heal limits |
| observations | (session, seq) PK, ts, task, tool, element, screen_before, screen_after, ok, latency_ms, snapshot_bytes, json; index on ts | Observation incl. scrubbed snapshot (`json`) |
| sessions | session PK, task, task_seq, task_end_seq, mode, started_at, last_seq, driver_calls, perception_bytes, screenshots | 04 §2 task association and 08 §2 `task` counters (added beyond the spec's table list); `task_end_seq` set by `finishTask` = the compiler's default slice end |
| counters | (kind, key, name) PK, value | volatile: element hits/misses/heals; recipe runs/replay_success/fallbacks; screen seen |
| dirty | (kind, key) PK, reason, ts | what `export` writes |

## 6. events.jsonl contract (08 §2)

One `Event` per line (`types.ts` `Event` union; schema `events.schema.json` validates a line).
`ts` RFC 3339 UTC (`types.now()`), `platform` defaults to the config platform, `session`
optional. Appended by `events.appendEvent` in one `appendFileSync` call; readers skip malformed
or truncated lines. Kinds and required fields:

| kind | fields |
|---|---|
| task | session, task (PII-redacted), mode_start, mode_end, ok, driver_calls, perception_bytes, screenshots, ms (+build) |
| recipe_run | recipe, version, mode, ok, steps, steps_done, heals, fallbacks, ms, build (+run_id, fallback_step, fallback_reason) |
| heal | recipe, step, element, old_strategy, score, accepted, reason, build (+new_strategy, intent_critical, run_id) |
| identify | screen (`unknown` allowed), confidence, signal, build (+variant, gates_present, candidates) |
| drift | screen, status, missing_ids, hash_changed, build (+ci_gate_referenced) |
| compile | recipe, version, from_session, steps, params (+ok, reason) |

A guided run that falls back is a `recipe_run` with `mode: guided`, `ok: false`, `fallbacks ≥ 1`
and `fallback_step` (04 §5 "logged as guided_fallback"). Step ids in events and reports match
`RUN_STEP_ID_REGEX` (`^s[0-9]+[a-z]?$`) so entry steps `s0a…` validate. `fixtures/events/
sample.events.jsonl` is a validated sample of every kind (report.test.ts input). Retention: 14 days (config
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
13. **Trajectory `input.text` and the task text are kept, PII-redacted** — a deliberate
    deviation from the letter of 07 §2.2/§4 ("nothing raw touches disk"): the compiler needs
    equality between what was typed and a declared param value (04 §3.4). Both strings pass
    through `redactString` (the 07 §2.3.4 deny list) before they reach the trajectory, the db or
    the `task` event; trajectories are local-only with 14-day retention (07 §2.4) and recipes run
    only against fixture accounts (07 §3), so the fixture values (`50`, `Acme Corp`) are fixture
    data by definition.
    `redactString` splices `[redacted]` over **each matched substring**, not over the whole
    string: blanking the lot destroyed exactly the structure this decision exists to keep (param
    inference and the 08 §2 `task` field), while 07 §2.2's requirement — the value never reaches
    disk — is met either way. The currency pattern spans the whole amount (`[$€£]\s?\d[\d.,]*`)
    so a splice never leaves digits behind. An amount written with **no** currency symbol
    (`1299.00`) is deliberately NOT on the deny list: a bare-number pattern would redact every
    build number, count and version in the map. Those strings only ever reach local-only
    trajectories with 14-day retention (07 §2.4), never a committed file — where validate rule 8
    is the backstop.
14. **`invoice_list.no_ids` fixture drops every id including the marker**: identify → `unknown`
    with `invoice_list` as top candidate via `title` (0.4); `find_element` with an explicit
    `screen_id` resolves by `role_label` and reports `degraded` (03 §12).
    **02 §5.2 vs 03 §12 / 04 §9 — resolved in favour of 03 §12**: 02 §5.2 defines a degraded
    match as `confidence < 0.6`, but every authored `role_label` locator sits at exactly 0.6, so
    a literal reading makes the canonical drift scenario (id removed, label kept) neither a miss
    nor degraded, and 04 §7 healing could never fire from a real replay. `resolve.hit()` therefore
    marks a hit degraded when `confidence < DEGRADED_THRESHOLD` **or** the locator's rank > 0 —
    i.e. the authored top locator missed and the cascade fell through. A rank-0 hit still follows
    02 §5.2 exactly, so the only behaviour change is on fall-through, which is precisely what
    03 §12 bullet 3 and 04 §9 bullet 4 require.
15. **First observation of a session has `screen_before: 'unknown'`**.
16. **`sessions` table** added to the spec's list (02 §7 leaves the schema to 03).
17. **Entry steps in guided runs**: `s0` = `open_link entry.deep_link`; without a deep link the
    `fallback_path` expands to `s0a`, `s0b`, … edge taps. Recipe YAML step ids stay
    `STEP_ID_REGEX` (`s[0-9]+`); events and heal reports accept `RUN_STEP_ID_REGEX`
    (`s[0-9]+[a-z]?`).
18. **Decay** (02 §8) applies only when both build numbers parse as integers; otherwise no decay.
19. **Gates never win identification**; a tree that is only a gate is `unknown` +
    `gates_present`.
20. **07 §3 Release-build probe** = the iOS `UserDefaults` record `app_map_debug_probe`
    (instrumentation/ios AppMapDebugEndpoint) read via `simctl spawn … defaults read`; Android
    best-effort via `adb shell run-as`; both behind the injectable `BuildInfoProbe`. The record
    also carries `flags`, `auth`, `platform_version` — the only source of 02 §4.3 variant facts;
    the last probe is cached on `ctx.probe` (`ctx.setProbe`) and passed to `identify` as
    `probeConditions(ctx.probe)`. Without a probe every variant "may match" (02 §4.3).
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
31. **No `name_task` / `report_task` tools** (04 §2, 04 §3.1 name them; 03 §8's 13-tool budget
    is full): `match_recipe` always declares the task, `compile_recipe` declares it when absent;
    a task ends on `compile_recipe` ok, on the Stop hook (`hook_event_name: Stop` through
    `record --stdin`/the socket → `finishTask` with `inferTaskOutcome`) or on guided `done`.
    `sessions.task_end_seq` is the compiler's default slice end; `compile_recipe {to_seq}`
    overrides it.
32. **Verification writes `last_verified_build`** (02 §8, 08 §5 row 5): `lifecycle.markVerified`
    promotes `candidate → verified` and stamps the build on screens, elements, edges and
    recipes; called from guided `report_step` (ok steps / done), headless success and the ingest
    lazy re-verify (marker + all required ids + hash match). `healed_pending_review` is never
    promoted automatically.
33. **Gates carry no `title`**: the OS dialog copy is not in the app's string tables (07 §2.1),
    so a gate title would widen `staticLabels`. `LoadedMap.staticLabels` excludes gate titles;
    validate rule 8 warns when a `title`/`label` is absent from `.local/strings.<platform>.txt`.
34. **ids.yaml `title`/`deep_link` must agree with the screen file** (validate rule 2): `title`
    exactly, `deep_link` on `routeKey` (the registry records the route; the screen file may add
    `?fixture=…`, 01 R5 — `invoice_detail` does). `indexMap` serves the screen file's values.
35. **`mark_recipe` carries the draft**: `{recipe_id, status, recipe?, reviewer?}`
    (`MarkRecipeInput`). The server keeps no per-session draft; `candidate` for an unknown
    recipe requires `recipe` (RecipeFile or YAML text, re-validated), `ci_gate` requires
    `reviewer` (07 §7). The CLI twin is `app-map mark`.
36. **CI param values live in `.local/ci-params.<platform>.json`** (`paths.ciParamsFile`), a
    build-time artifact generated from the app's fixture module like the string table (01 R5
    "fixtures are defined in code", 07 §2.3.5 "never stored as literals in recipes"), or an
    explicit `--params-file`. `maestro-export` / `run --all` resolve each param from explicit
    params → file → `values[0]` and fail with `bad_input` when a required param has no value
    (06 R5/R6 need `create_invoice.amount/client`). The reviewers' alternative (`ci_value` inside
    the recipe) was rejected because it contradicts 07 §2.3.5. The CI workflow must produce the
    file (or pass `--params-file`) before `maestro-export`; `fixtures/ci/params.json` is the test
    copy that `makeTempAppMapDir` installs.
37. **`drift --build` is optional** (06 §3 omits it): defaults to the router export's
    `build.build_number`, else `ctx.build`.
38. **`ELEMENT_ID_REGEX` (3+ segments, no `screen.`/`gate.`) applies to ids.yaml `elements[]`
    only**; screen-file and recipe element ids use `ID_REGEX` (01 R2, 2+ segments) so gate
    dismiss controls validate. The last id segment need not equal the registry `kind`
    (`invoice.list.table`, `kind: list` is 01 R1's own example): lint-ids warns only when it is
    not a `KIND_SYNONYMS` entry, and lint-ids must pass on the committed pilot (06 R2).
39. **lint-ids `marker_unreferenced` is per platform** (01 R8) with `--platform` scoping for
    partially instrumented stages (08 §6 Stage 0 is iOS-only).
40. **import-router registers unknown screens** (01 R6 "seeds", 06 R7 opens a PR anyway):
    appended to ids.yaml `screens[]` via the `registry` row (dirty `ids`) and reported in
    `unregistered`; `--strict` errors instead. `--purge-retired` deletes screens retired on an
    earlier build (02 §8 "retired for one release, then deleted"); the manifest build refresh is
    a dirty `manifest` row.
    **The purge is a cascade**, because 02 §8's "then deleted" has to leave a map that still
    passes 02 §10 rule 3: `db.deleteScreen(id, {dirty: true})` records a DELETE intent on the
    dirty row (`dirty.deleted`, plus the `blob_sha` the entity was last loaded/written at, since
    the row that normally carries it is gone), which `exportMap` honours by `unlink`ing the YAML
    behind the same conflict check as a write and reporting it in `ExportResult.deleted`. The
    same import also drops the screen from `ids.yaml`, strips every surviving screen's edges (and
    conditions) that point at it, and deletes the recipes that were retired with it
    (`purged_recipes`) — a retired recipe whose screen file is gone can never validate again.
41. **heal-report / drift-report carry closed codes only** (07 §2.4): `HeadlessReport.error_code`
    (`HEADLESS_ERROR_CODES`) + `failed_command_index` replace free-text `error` and `flow_path`;
    drift `reason` is `DRIFT_REASONS`. Maestro output goes to `.local/server.log` at `debug`.
42. **`deep_link_scheme` is the constant `appmap`** (01 R5 fixes it; every pattern hard-codes it).
43. **Maestro version check runs once in `startServer`** after `openContext`, non-fatal (`warn`),
    off the first-tool critical path (03 §11, 03 §13, 07 §5.3); headless runs re-check.
44. **`get_screen` `conf`** = the session's last observation `confidence` when its `screen_after`
    is the requested screen, else `decayConfidence(1, buildsSince(ctx.build,
    meta.last_verified_build))` (02 §8), else the segment is omitted.
45. **`compile_recipe {values?}`** (04 §3.4): the LLM/CLI (`--param name:type=value`) supplies
    the concrete values; `match.inferParams(task)` fills the rest; unmatched literals →
    `unparameterized_value`.
46. **Unknown-screen alert window** (08 §5 row 6): `ReportMetrics.unknown_screen_rate_7d` over
    `THRESHOLDS.alert_unknown_window_days = 7` drives the alert; the 30-day value is reported too.
47. **`app-map intent-critical-diff <base-ref>`** (`policy-check.intentCriticalDiff`) computes the
    07 §7 downgrade list (two approvals) and the 07 §4 "intent_critical elements touched" table
    for the bot comment; exit 1 on a downgrade so the workflow can require the second approval.
48. **User-authored regexes are bounded**: `matches[]` and `label_regex` ≤200 chars (schemas) and
    rejected by validate rule 1 when they nest quantifiers (`safeRegexIssue`, 07 §4).
49. **Migrations**: `tools/app-map-mcp/migrations/<from>-to-<to>.ts` (README there;
    `paths.migrationsDir`); none exists until schema_version 2.
50. **Tests run from source** (`npm test` = `node --test "src/test/**/*.test.ts"`, Node ≥ 22.18
    type stripping, docs/dev/toolchain.md); `src/test/**` is still type-checked and compiled into
    `dist/test` (harmless, `npm run test:dist` runs it) rather than excluded from the build.
51. **`report`'s default window is `min(30, retentionDays)`** — 08 §4 asks for a rolling 30 days,
    07 §2.4 deletes every `events.jsonl` line older than `retentionDays` (default 14) on server
    start, so a 30-day header over ≤14 days of data would misreport. An explicit `--since` is
    honoured verbatim. The two CI artifacts are looked for in `--artifacts-dir`, then
    `app-map/.local/`, then the repo root — the shipped workflow writes them at the root.
52. **`replay_rate`'s denominator is all `recipe_run` events.** 08 §4's "÷ all task runs" means
    the runs performed for tasks, not the number of `task` events: one task routinely takes
    several runs, so a `task`-event denominator would exceed 100 %. No code change; recorded
    here because the wording invites the other reading.
53. **`marker_unreferenced` never disables itself by counting** (01 R8): a platform with zero
    referenced markers is one `warning` ("not instrumented yet", 08 §6 Stage 0) unless the
    platform is declared in `APP_MAP_INSTRUMENTED_PLATFORMS` / `--instrumented`, in which case
    every screen is an error. `bad_id` additionally carries an R2 CONTENT heuristic (severity
    `warning`): a locale suffix on any segment, or a multi-word segment that is verbatim app copy
    in `.local/strings.<platform>.txt`. Single-word collisions (`client`, `cancel`) are ignored —
    they are ordinary structural vocabulary.

54. **The pilot deliberately ships no `ci_gate` recipe.** `app-map/ios/recipes/create_invoice.yaml`
    is `status: verified`. 07 §7 makes promotion a human act that needs a reviewer who is not the
    author **and** a green R5 run against the build — neither is possible without the real app, and
    `mark_recipe --force` would fake both. The consequence is that 06 R4's blocking rule
    (`summary.blocking` only on a broken screen a `ci_gate` recipe references) and 06 R5
    (`maestro-export --status ci_gate` → "(no recipes matched)", exit 0) are inert on the committed
    map; `src/test/drift.test.ts` promotes the recipe in a temp map to exercise 06 §5. Promoting it
    for real is a Stage 1 exit item (docs/dev/rollout.md §2).
55. **07 §7's "a reviewer who is not the author" is enforced in two places.** `markRecipe` rejects a
    reviewer equal to `provenance.compiled_by` — the only identity this process holds — and logs a
    `warn` naming the reviewer whenever `--force` bypasses the 08 §5 eligibility gate. Everything
    else (that the reviewer is a real person, that they approved the PR, the two approvals for an
    `intent_critical` downgrade) is branch protection, which has no representation in this repo;
    docs/dev/rollout.md §2 Stage 1 lists the exact settings.
56. **Driver verbs are a table, not a regex.** `recipes/verbs.ts` maps a normalized tool name
    (`mcp__<driver>__gesture-tap` → `gesture_tap`) to a `VerbKind` through a table keyed on
    `APP_MAP_DRIVER` (03 §3), with generic patterns for a driver that has none, so swapping
    drivers is a table entry rather than a regex edit. `classifyVerb` is total: perception and
    lifecycle calls (waits, launches, log dumps, `report_step`) are KNOWN non-steps and stay
    silent, while `batch` (`run-sequence`), `unsupported` (`button`, `tv-remote`) and `unknown`
    are dropped with a named warning. `translateSteps` therefore returns `{steps, warnings}` and
    `compileRecipe` folds them into `CompileRecipeResult.warnings` — a step that vanishes
    silently is the worst failure this system has (a recipe that passes while exercising
    nothing: `@swmansion/argent@0.25.0` types with `keyboard`, not `type_text`, issue #9).

57. **An automated recompile may only grow a recipe.** `recipes/lifecycle.recompileFrom` writes
    the rebuilt recipe over the previous one only when three gates pass, and otherwise keeps the
    reviewed recipe. (a) No *incompleteness* warning — a dropped or failed driver call,
    placeholder prose. The 04 §3.2 backtracking-collapse note is explicitly not one
    (`compile.isCollapseWarning`, the predicate the producer and the guard share): collapsing is
    what the compiler does to every trajectory by design, including the one the reviewer
    approved, and anything it removed that the reviewed recipe needs is named by gate (b).
    Treating it as a defect refused the pilot's own trajectory and left 04 §9's automatic
    recompile true only on paper. (b) The new step list covers the old one as an ordered
    subsequence (`recompileCovers`/`stepIdentity`, identity = action + the element/list/gate/url
    acted on; `expect` may strengthen, never weaken; `intent_critical` may not be dropped).
    (c) The rebuilt `preconditions` and `entry` cover the old ones (`recompileCoversEntry`):
    every condition still present, and a reviewed `entry.deep_link` back on the same screen with
    every query parameter intact — losing `?fixture=logged_in` is `auth: logged_in` loss in URL
    form, which the pilot's own recompile from a post-entry slice does. `entry.fallback_path` is
    checked only when there is no deep link, since 04 §3.5 derives it from whatever leading
    navigation the slice held. A refusal is loud: an `error` log line, the unified diff, and a
    `compile` event with `ok:false` and a `recompile_refused_*` reason — no new event kind, since
    `CompileEvent` already carries `ok`/`reason`. An accepted revision carries
    `provenance.reviewed_by` forward and stamps `provenance.machine_recompile: true` directly
    above it, so a PR diff reads "machine-built steps, historical signature"; `markRecipe` deletes
    the stamp when a human signs again. The body write uses the dirty reason `recompile:<trigger>`
    (`store/db.RECOMPILE_DIRTY_PREFIX`), which is what lets `export` report
    `written_from[].machine_recompile` and the CLI name it on stderr. Issue #13.

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
`readAllowlist`, `readStaticStrings`, `indexMap`, `loadMap` — fills `LoadedMap.files` with
`gitBlobHash` per file; `staticLabels` excludes gate titles, `gitTreeHash`, `gitBlobHash`),
`validate.ts` (`validateMap`, `crossReferenceIssues` incl. the ids↔screen `title`/`deep_link`
agreement (decision 34) and `ID_REGEX` for screen-file element ids, `forbiddenContentIssues`
+ the rule 8 string-table warning, `safeRegexIssue`, `nonCanonicalFiles`, `formatIssues`),
`migrate-id.ts`, `merge-driver.ts`.
Tests: `canonical.test.ts` — every file under app-map/ round-trips byte-for-byte; key-order and
sort rules; `schemas.test.ts` — pilot files valid, a mutated file (extra key, bad enum, lone
text locator) invalid; `load.test.ts` — `loadMap` on the temp pilot: 5 screens, 2 gates,
1 recipe, 34 registered element ids (32 + 2 dismiss), markers/routes indexed, <500 ms;
`validate.test.ts` — one failing case per rule 1–8 (rename an id without migrate-id → rule 2
lists the dangling references, 06 §5; a screen file whose `deep_link` route differs from
ids.yaml → rule 2; `matches: ["(a+)+"]` → rule 1 `safeRegexIssue`; a gate with `title` → rule 8
warning); `load.test.ts` also asserts `files` has 10 entries for the served platform on the
pilot (ids, manifest, 7 screens, 1 recipe) each with a `blob_sha` inside the git repo; `migrate-id.test.ts` — rename `invoice.add.button`,
zero dangling references, canonical output; `merge-driver.test.ts` — branch adding
`client_picker.yaml` vs branch editing `invoice_list.yaml` merges clean (02 §11); same-key edit
conflicts.

### A2 — store
Fill: `log.ts`, `store/db.ts` (every `AppMapDb` method + `DDL`, incl. the `registry` table,
`getBlobSha`, `getIds`/`putIds`, `getManifest`/`putManifest`, `deleteScreen`,
`listRunsForSession`), `store/export.ts` (`renderEntities(platform, …)`, dirty kinds
screen/recipe/ids/manifest, conflicts from `map.files`/`db.getBlobSha`), `events.ts`,
`context.ts` (`probe`/`setProbe`, `setBuild` persisted in `meta.build`).
Tests: `db.test.ts` — schema creation, `upsertMap` preserves dirty rows and counters and copies
`blob_sha` from `map.files`, `insertObservation` throws `bad_input` for an unscrubbed snapshot
(07 §8), `nextSeq` monotonic, `recipeStats` aggregates, WAL stress: two `AppMapDb` handles
inserting 500 observations each concurrently (worker threads) → no corruption, all rows present
(03 §12); `export.test.ts` — export twice → no diff (02 §11), conflict when the file's blob
changed, a dirty `ids` row writes `ids.yaml`, `--check` flags a hand-edited non-canonical file; `events.test.ts` — append/read, truncated last
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
(`Invoices`, `New Invoice`, `Don’t Allow`) survive; an unregistered `a11y_id`
`cell_billing@acme.example` is redacted while `invoice.list.cell` is kept; the result carries the
`ScrubbedTree` brand and `assertScrubbed` rejects the raw input; `tree.test.ts` — the Argent
wrapper's `build_number`/`bundle_id` land in `Tree.build`/`Tree.app_id`; Android fixtures use
`strings.android.txt` (`makeTempAppMapDir({platform:'android'})`); `signature.test.ts` — `structuralHash` of
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
`flags: {new_invoices_ui: true}` (from `probeConditions`) and loses when `false`; no flags →
either may match; 2,000-node synthetic tree < 50 ms; `resolve.test.ts` — every pilot element
resolves by `a11y_id` with confidence 1.0; on `invoice_list.no_ids` `invoice.add.button`
resolves by `role_label`, `degraded: true`, confidence 0.6; two cells share `invoice.list.cell` →
disambiguated by fingerprint (confidence 0.9); `plan.test.ts` — `plan_path(login, invoice_new)` →
deep link; `plan_path(invoice_new, client_picker)` → one edge; `format.test.ts` — exact
`get_screen` block for `invoice_list` (03 §8), summary ≤600 tokens and ≥ the recipe list,
`formatRunStep` ≤120 tokens.

### C1 — observations, matching, compile, lifecycle
Fill: `observe.ts` (incl. `nameScreen`, `finishTask`/`inferTaskOutcome`, Stop handling, the
lazy re-verify), `recipes/match.ts`, `recipes/compile.ts` (`values`, `to_seq`),
`recipes/lifecycle.ts` (`markRecipe(MarkRecipeInput)`, `markVerified`).
Tests: `observe.test.ts` — `recordHookPayload(hooks/post-tool-use.tap.json)` → `screen_after:
invoice_new`, a trajectory line written with a scrubbed snapshot, a `hits` counter bump, an
`identify` event, and `invoice_new.meta.last_verified_build` bumped to the build (lazy
re-verify); non-driver tool → `null`; failure payload recorded with `ok: false`;
`hooks/stop.json` after a declared task → a `task` event with the session counters and
`task_end_seq` set; `input.text` containing a card number is stored `[redacted]`;
`nameScreen` on an `unknown` observation builds a candidate screen with registered elements
only, `deep_link` from ids.yaml, and refuses an unregistered id (`invalid_map`);
`match.test.ts` — `"create an invoice for $50 for Acme"` → `create_invoice`, 0.9, `params_needed`
empty; `"make invoice"` → `params_needed: [amount, client]`; `"delete a client"` → no_match with
≤8 candidate lines; `compile.test.ts` — `trajectories/create_invoice.session.jsonl` compiles to a
recipe equal to `app-map/ios/recipes/create_invoice.yaml` modulo `matches`, `description`,
`status: candidate`, `version: 1`, `provenance` (the A→B→A loop at seq 2–3 collapses; `50` →
`{amount}`, `Acme Corp` → `{client}`) both with explicit `values` and via `inferParams`; an
unparameterized literal → `unparameterized_value`; `to_seq: 5` slices to s1–s2;
`verbs.test.ts` — every confirmed `@swmansion/argent@0.25.0` tool classifies to its `VerbKind`,
`open-url` == `open_url`, an untabled driver still resolves `type_text`/`tap` and an untabled tool
is `unknown`; `compile.test.ts` also proves a `mcp__argent__keyboard` `type` step survives the
compile and that an unknown verb lands in `warnings` instead of vanishing (issue #9);
`lifecycle.test.ts` — `decideTransition` for each row of the table (3 successes / 2 sessions →
verified; 6 of last 10 failed → candidate, 04 §9; pending heals ≥2 → candidate; ci_gate never
automatic); `markRecipe({status:'candidate'})` without `recipe` on an unknown id → `bad_input`,
with the compiled draft → written dirty; `ci_gate` without `reviewer` → `bad_input`;
`markVerified` stamps `last_verified_build`, promotes `candidate → verified`, leaves
`healed_pending_review` alone and dirties only changed rows; `THRESHOLDS` equal the 08 §5
numbers (incl. `alert_unknown_window_days: 7`).

### C2 — healing and guided replay
Fill: `heal.ts` (`scoreCandidates`, `proposeHeal`, `toPendingHeal`, `healedElement`,
`applyHeal`, `rejectHeal`, `heal`), `recipes/guided.ts` (`resolveRunSession`, pending-heal
settlement, `markVerified` calls, `finishTask` on done).
Tests: `heal.test.ts` — remove `invoice.add.button`'s id from `invoice_list` (keep label) →
`proposeHeal` candidate via `role_label`; `applyHeal` → element `healed_pending_review`, new
locator at rank 0, screen dirty, `heal` event accepted (04 §9); `applyHeal({pending})` from a
`toPendingHeal` record produces the same element; change `invoice.save.button`'s label and
remove its id → `intent_critical_label_changed`, `rejectHeal` logs it (04 §9); `no_expect` for
a step without expect; `jaroWinkler`/`lcsLength` known values;
`guided.test.ts` — full happy path of `create_invoice` driving `reportStep` with fixture
observations inserted between calls (s0…s5 → done, verified, `last_verified_build` stamped on
the recipe and the screens seen, a `task` event); observations of ANOTHER session inserted
between calls are ignored (run pinned to its session); gate on s0 → `gate` then retry; third
gate → fallback `gate_limit`; expect failure → fallback + `recipe_run{fallbacks:1}`; a degraded
resolution → the step is handed out with `healing: true` and `pending_heal` persisted; the next
`report_step` with `expect` held → `healed` summary + element written; with `expect` failed →
fallback `heal_rejected` and a `postcondition_failed` heal event; `skipBuildCheck:false` with a
probe returning `null` or `build_type:'release'` → `release_build_refused` (07 §8), a debug
probe → `ctx.probe` set; state (including `pending_heal`) survives a new `openContext` between
`run_recipe` and `report_step`.

### C3 — Maestro, headless, drift, router import
Fill: `recipes/maestro.ts`, `recipes/headless.ts`, `drift.ts`, `router-import.ts`.
Tests: `maestro.test.ts` — `recipeToMaestroFlow(create_invoice, {amount: 50, client: 'Acme
Corp'})` equals `fixtures/maestro/create_invoice.flow.yaml` byte-for-byte (04 §6.2 table order;
`dismiss_gate` runFlow emitted before steps on screens listing the gate — covered by a synthetic
recipe on `invoice_list`); an element with only `path`/`geometry` → `eligible: false`;
`resolveRecipeParams` takes explicit → `fixtures/ci/params.json` → `values[0]` and throws
`bad_input` naming `create_invoice.amount` when nothing supplies it; `maestroExport` on the
temp pilot (params file installed by the helper) writes `create_invoice.yaml`;
`headless.test.ts` — with a fake `exec` that succeeds → report ok, `steps_done = 6`, recipe
`last_verified_build` stamped; fake exec failing at command k with a fake hierarchy → heal
attempted, ≤2 retries, `fallback_step`, `error_code: maestro_failed`, `failed_command_index`;
missing maestro → `error_code: maestro_unavailable`; the report never contains Maestro
stdout/stderr text and validates against `heal-report.schema.json` (compare shape with
`fixtures/ci/heal-report.json`); `drift.test.ts` — pilot trees → all `ok`; tree without
`invoice.add.button` → `invoice_list` `broken` with `missing_ids: [invoice.add.button]` and
`blocking` when `create_invoice` is `ci_gate` (06 §5); label-only change → `ok`;
`client_picker` → `skipped`/`no_deep_link`; `build` omitted → taken from the router export;
report validates against `drift-report.schema.json` (cf. `fixtures/ci/drift-report.json`);
`router-import.test.ts` — `fixtures/router-export.ios.json` on the pilot: `settings` is created
as candidate AND appended to ids.yaml (`unregistered: ['settings']`, dirty `ids` row); with
`strict: true` → `invalid_map` naming `settings`; existing screens unchanged, no edges lost; a
screen absent from the export → `retired` and its recipes retired; `purgeRetired` on a second
import with a newer build deletes it.

### D1 — server and socket
Fill: `server.ts`, `ingest-socket.ts`, `index.ts`.
Tests: `server.test.ts` — in-memory MCP client (SDK `InMemoryTransport`) lists exactly the 13
tools and 3 resource templates; `summary` ≤600 tokens; `get_screen` block with `conf` from the
last observation and, for a screen never observed, the decayed value; `match_recipe` with
`"delete a client"` (no_match) still declares the task on the session; `mark_recipe
{status:'candidate'}` without `recipe` → `bad_input`; every tool returns `{error, hint, code}`
with `isError` instead of throwing (feed a bad `screen_id`); resources return the YAML verbatim;
`startServer` with a fake exec whose `maestro --version` fails still serves tools and logs a
`warn`; `ingest-socket.test.ts` — start on a temp socket, post
`hooks/post-tool-use.tap.json`, get `{ok:true, screen_after:'invoice_new'}`; oversized line →
`bad_input`; second instance → `listening: false`; client returns `null` when no socket.

### D2 — CLI and CI commands
Fill: `cli.ts` (incl. `intent-critical-diff`, `mark`, `--params-file`, `--param
name:type=value`, `--to-seq`, `drift` without `--build`, `import-router --strict/
--purge-retired`, `lint-ids --platform`), `lint-ids.ts` (`KIND_SYNONYMS`, per-platform markers),
`gen-configs.ts`, `policy-check.ts` (+ `intentCriticalDiff`), `report.ts`
(`unknown_screen_rate_7d`).
Tests: `cli.test.ts` — `validate` exit 0 on the pilot, 1 on a broken copy; `record --stdin`
always exit 0 (even with garbage); `record --stdin < hooks/stop.json` closes the task; `summary
--hook-json` prints a `SessionStartHookOutput`; `export --check` exit 1 on a non-canonical file;
`maestro-export --all --out` exit 1 with `bad_input` when neither `--params-file` nor
`.local/ci-params.ios.json` supplies `create_invoice.amount`; `drift --router
fixtures/router-export.ios.json` (no `--build`) uses `4412`; `gen-configs.test.ts` —
`.mcp.json` → `.cursor/mcp.json` / `.codex/config.toml` golden strings, `--check` stale
detection; `policy-check.test.ts` — unlisted server, `npx` without pin (and a pin whose
`package@version` differs from the allowlist), secret literal, hook outside `.claude/hooks/`
each fail (06 §5, 07 §8); `intentCriticalDiff` with an injected `readAtRef` that returns an
ids.yaml where `invoice.save.button` was `intent_critical: false` → `upgraded`; the reverse →
`downgraded` + markdown row; `lint-ids.test.ts` — the committed pilot ids.yaml + instrumentation
sources pass (06 R2; `invoice.list.table` is not an error); `fixtures/lint/Bad.swift` →
`string_literal_id` ×2 at the right lines and `marker_unreferenced {platform:'ios'}` for
`client_picker`/`invoice_detail` when it is the only iOS source; `fixtures/lint/Bad.kt` →
`string_literal_id` ×2 and `marker_unreferenced {platform:'android'}` for `login`; `--platform
ios` suppresses the Android findings; `report.test.ts` — `fixtures/events/sample.events.jsonl`
with `since: 2026-09-01`, `until: 2026-09-08` → replay_rate 3/5, fallback_rate_per_recipe
`create_invoice` on build 4413 = 1, heal_rate 40/100 runs, intent_critical_rejections 1,
unknown_screen_rate 1/5 and `unknown_screen_rate_7d` over 09-01…09-08, brittleness index over
builds 4411/4412/4413, alerts for the fallback rate and the intent_critical rejection; `tasks`
means from the two `task` events (driver_calls 10, screenshots 0.5).

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
  fixtures/trees/**           normalized iOS + android/ pilot trees (+ with_gate, no_ids, pii variants)
  fixtures/raw/**             Argent snapshot and Maestro hierarchy dumps (best-effort shapes)
  fixtures/hooks/**           PostToolUse, PostToolUseFailure, SessionStart, Stop payloads
  fixtures/trajectories/**    create_invoice.session.jsonl (8 scrubbed observations)
  fixtures/strings.{ios,android}.txt   static string tables (07 §2.3.3)
  fixtures/maestro/           golden Maestro flow for create_invoice (04 §6.2)
  fixtures/events/            sample.events.jsonl — every 08 §2 kind, schema-validated
  fixtures/ci/                drift-report.json, heal-report.json (schema-validated), params.json
  fixtures/lint/              Bad.swift, Bad.kt (01 R8 violations)
  fixtures/router-export.ios.json
  migrations/                 schema_version migration scripts (02 §8; README.md, none yet)
  scripts/validate-pilot.mjs  schema + cross-reference + fixture check without the CLI
```
