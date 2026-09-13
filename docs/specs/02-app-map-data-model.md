# 02 — App-Map Data Model

Status: draft v0.1 · Depends on: 01 (ids) · Consumed by: 03, 04, 05, 06

## 1. Purpose

Define exactly what is stored, where, in what shape, and how it survives a shared repo: many developers, many branches, many builds.

## 2. Principles

1. One file per entity: `screens/<screen_id>.yaml` (screen + its elements + outgoing edges), `recipes/<recipe_id>.yaml`. Two developers exploring different screens never touch the same file.
2. **Durable fields only in git.** Structure, locators, status, provenance, `last_verified_build`. Counters, timings, and per-session state live in `app-map/.local/cache.sqlite` (git-ignored). `app-map export` writes durable fields deterministically.
3. Deterministic serialization: fixed key order per schema, lists sorted by `id`, block style, 2-space indent, LF, no trailing timestamps except `manifest.generated_at`; string-typed scalars whose natural values read as numbers (`build.version`, `build.build_number`, `build.git_sha`) are always double-quoted. `app-map export` twice in a row produces no diff.
4. Structure only (07 §2). A YAML file never contains a screenshot path, a field value, cell text, or a user identifier.
5. Every file validates against `app-map/schema/<type>.schema.json`.

## 3. Manifest

```yaml
# app-map/ios/manifest.yaml
schema_version: 1
app_id: com.example.app
platform: ios                      # ios | android
deep_link_scheme: appmap
build:                             # last build the map was exported against
  version: "2026.9.1"              # quote all three: unquoted, 1.0 is a float and 0000000 is the integer 0
  build_number: "4412"
  git_sha: "a1b2c3d"
generated_at: 2026-09-10T00:00:00Z
generator: app-map-mcp@0.1.0
```

## 4. Screens

### 4.1 Schema

```yaml
# app-map/ios/screens/invoice_list.yaml
id: invoice_list
kind: screen                        # screen | gate
title: Invoices                     # static nav title; optional
deep_link: appmap://invoice_list    # or `none`
signature:
  marker: screen.invoice_list       # strongest signal (01 R3)
  route: appmap://invoice_list
  nav_class: InvoiceListView        # SwiftUI view / VC / Activity / Fragment
  required_ids: [invoice.list.table, invoice.add.button]
  structural_hash: sha1:9f2c1e…     # see §4.4
dynamic_regions: [invoice.list.table]
gates: [gate.push_permission]       # gates observed on entry to this screen
variants:
  - id: new_invoices_ui
    when: {flag: new_invoices_ui, value: true}
    required_ids: [invoice.list.collection, invoice.add.button]
    structural_hash: sha1:77ab0d…
elements:
  - id: invoice.add.button
    role: button
    label: New Invoice              # static UI copy only; never data
    intent: open_new_invoice
    intent_critical: false
    locators:                       # ranked; weights are defaults from §5.2
      - {strategy: a11y_id, value: invoice.add.button, weight: 1.0}
      - {strategy: role_label, value: {role: button, label: New Invoice}, weight: 0.6}
      - {strategy: text, value: New Invoice, weight: 0.3}
      - {strategy: path, value: navigationBar/button[1], weight: 0.25}
      - {strategy: geometry, value: {x: 0.92, y: 0.08}, weight: 0.1}   # normalized to screen size
    fingerprint: {role: button, label_norm: new invoice, parent_role: navigationBar, sibling_index: 1}
    status: verified                # candidate | verified | healed_pending_review
    last_verified_build: "4412"
  - id: invoice.list.table
    role: list
    dynamic: true
    locators:
      - {strategy: a11y_id, value: invoice.list.table, weight: 1.0}
    status: verified
    last_verified_build: "4412"
edges:
  - action: {type: tap, element: invoice.add.button}
    to: invoice_new
    preconditions: [{auth: logged_in}]
    postconditions: [{screen: invoice_new}]
    status: verified
    last_verified_build: "4412"
meta:
  sources: [router_export, exploration]
  status: verified
  last_verified_build: "4412"
```

### 4.2 Gates

A gate is a screen with `kind: gate`, a `dismiss` edge, and no deep link. OS dialogs that cannot carry your ids use a `role_label` signature:

```yaml
id: gate.push_permission
kind: gate
signature:
  marker: none
  required_labels: [{role: button, label_regex: "^(Allow|Don.t Allow)$"}]
elements:
  - id: gate.push_permission.deny
    role: button
    locators:
      - {strategy: role_label, value: {role: button, label_regex: "^Don.t Allow$"}, weight: 0.8}
edges:
  - action: {type: tap, element: gate.push_permission.deny}
    to: _previous                   # returns to whatever was underneath
```

### 4.3 Variants

Feature flags, A/B arms, auth state. A variant overrides `required_ids`/`structural_hash` when its `when` condition holds. Conditions the server can evaluate: `flag` (from fixture or a debug endpoint), `auth`, `platform_version`. Unknown conditions are treated as "any variant may match" and the best-scoring one wins.

### 4.4 Structural hash

`sha1` over the sorted list of `(role, a11y_id)` pairs for nodes that have an id, excluding anything under a `dynamic_regions` id. Text is never hashed. Two builds with the same ids in the same roles produce the same hash even if layout, copy, or data changed.

## 5. Elements and locators

### 5.1 Strategies

| strategy | value | iOS | Android | default weight |
|---|---|---|---|---|
| `a11y_id` | id string | accessibilityIdentifier | resource-id / testTag | 1.0 |
| `role_label` | `{role, label \| label_regex}` | traits + label | class + content-desc/text | 0.6 |
| `text` | visible text | label/value | text | 0.3 |
| `path` | `parentRole/childRole[i]/…` from screen root | yes | yes | 0.25 |
| `geometry` | normalized `{x, y}` | yes | yes | 0.1 |

`text` is the first thing to break under copy edits and localization; it exists only as a fallback and is never the sole locator on a committed element.

### 5.2 Resolution contract

The server tries strategies in order; the first **unique** match wins and its weight becomes the match confidence. A hit on a strategy with weight < 0.6 is a *degraded match* and triggers a heal proposal (04 §7) even though the step proceeds. No unique match on any strategy is a *miss*.

### 5.3 Fingerprint

Stored at verification time and used only for heal scoring: `role`, `label_norm` (lowercased, punctuation stripped), `parent_role`, `sibling_index`, `bbox_norm`. Never contains values.

## 6. Recipes

```yaml
# app-map/ios/recipes/create_invoice.yaml
id: create_invoice
version: 3
platform: ios
description: Create an invoice for a client with an amount and save it
matches:                             # case-insensitive regex, tried in order
  - "(create|new|make)( an?)? invoice"
  - "bill (a |the )?(client|customer)"
params:
  - {name: amount, type: money, required: true}
  - {name: client, type: string, required: true}
preconditions: [{auth: logged_in}]
entry:
  deep_link: appmap://invoice_new?fixture=logged_in
  fallback_path: [invoice_list, invoice_new]        # screen ids; edges resolved at run time
steps:
  - {id: s1, action: tap,   element: invoice.amount.field,  expect: {visible: [invoice.amount.field]}}
  - {id: s2, action: type,  element: invoice.amount.field,  text: "{amount}"}
  - {id: s3, action: tap,   element: invoice.client.picker, expect: {screen: client_picker}}
  - {id: s4, action: select, list: client.picker.list, match: {text: "{client}"}, expect: {screen: invoice_new}}
  # … or, where the list container is not an accessibility element (SwiftUI, 01 R4), name the row:
  # - {id: s4, action: select, cell: client.picker.cell, match: {text: "{client}"}, expect: {screen: invoice_new}}
  - {id: s5, action: tap,   element: invoice.save.button,   expect: {screen: invoice_detail}, intent_critical: true}
verify: {screen: invoice_detail, visible: [invoice.detail.amount.text]}
status: verified                     # candidate | verified | ci_gate | retired
provenance:
  compiled_from: traj_2026-09-01_0007
  compiled_by: app-map-mcp@0.1.0
  # machine_recompile: true          # set by the 04 §8 automatic recompile; see below
  reviewed_by: caleb
last_verified_build: "4412"
```

Step actions: `tap`, `type`, `select`, `swipe`, `open_link`, `wait_for`, `dismiss_gate`. `select` picks one row out of repeated content and has two forms carrying the same `match.text`: `{list, match}` names a container that is itself an accessibility element, and `{cell, match}` names the repeated row id every row shares — the only form a SwiftUI list can express, since its container never reaches the driver (01 R4). Exactly one of `list`/`cell` is present; a step carrying both matches no branch of the schema. `expect` conditions: `screen`, `focused`, `visible`, `not_visible`, `text_present` (static copy only). Every step with an `expect` is a verification point; steps without one inherit "screen unchanged". `focused` is **Android/Maestro-only**: the Maestro hierarchy carries a `focused` attribute, while Argent's iOS accessibility snapshot carries no focus flag at all, so an `expect.focused` on `platform: ios` can never be satisfied however well the tap worked — `validate` warns (rule 2 below, 04 §10) and the compiler writes `visible` there instead.

`provenance.machine_recompile: true` means this version's *steps* were rebuilt by the automatic recompile (04 §8), not authored or approved by a human. It sits directly above `reviewed_by` because that is what it qualifies: the signature is historical, carried over from the version the reviewer actually read. `mark(ci_gate, reviewer)` deletes the key (07 §7).

Status lifecycle (04 §8): `candidate` on compile → `verified` after ≥3 successful replays across ≥2 sessions → `ci_gate` after ≥95% replay success across ≥3 builds → `retired` when a screen it depends on is removed.

## 7. Local-only data

Never committed. Retention: 14 days, then deleted by the server on start.

```jsonl
// app-map/.local/trajectories/<session>.jsonl — one observation per driver tool call
{"ts":"2026-09-10T17:02:11Z","session":"…","seq":12,"task":"create invoice for $50 for Acme",
 "tool":"mcp__argent__gesture-tap","input":{"id":"invoice.add.button"},
 "screen_before":"invoice_list","screen_after":"invoice_new",
 "signature_after":{"marker":"screen.invoice_new","structural_hash":"sha1:…","required_present":1.0},
 "snapshot":{"…scrubbed compact tree…"},"ok":true,"latency_ms":420}
```

```jsonl
// app-map/.local/events.jsonl — metrics feed (08 §2)
{"ts":"…","kind":"recipe_run","recipe":"create_invoice","mode":"headless","ok":true,"steps":5,"heals":0,"ms":6100}
```

SQLite (`cache.sqlite`, WAL mode) holds the loaded map plus volatile counters: per-element `hits`, `misses`, `heals`; per-recipe `runs`, `replay_success`, `fallbacks`; per-screen `last_seen`. Schema is an implementation detail of 03, regenerable from YAML + logs.

## 8. Versioning, migration, decay

- `last_verified_build` is the build number of the last successful verification. On a new build, confidence decays: `confidence = base × 0.9^(builds_since_verified)`, floor 0.2. Decay is computed, not stored.
- A renamed id is a migration: `app-map migrate-id <old> <new>` rewrites every reference across screens, recipes, and `ids.yaml` in one commit.
- A screen removed from the router export is marked `status: retired` (not deleted) for one release, then deleted; recipes depending on it become `retired`.
- A screen with `elements: []` is **never** verified, whatever a replay reports: verification is a clean observation of the screen's required ids, and a router-export seed (01 R6) has by definition never had one — `name_screen`, which is what fills `elements[]`, is the way out of `candidate` for such a screen. Nor is an edge whose `action.element` its screen does not declare: a `verified` edge asserts the tap happened there, while §10 rule 2 is still only warning that the element has not been learned there. Promoting either would silently withdraw that carve-out and stop the map loading with no human edit in between. Emptiness **alone** is the test, even for a seed whose edges name no element yet: `import-router` appends the app's new edges on every later build, and a screen promoted in the meantime is unrecoverable — the map does not load, so every tool but `export` is short-circuited and nobody can `mark` it back to `candidate`. The narrower rule defers that deadlock rather than preventing it. The accepted cost: a screen that genuinely has no registered non-marker id (a splash, an interstitial) stays `candidate` and carries no `last_verified_build`, so the decay above is not applied to it and `report`'s deep-link coverage does not count it.
- A screen's `verified` is **earned by observation** (08 §5 row 5: marker + every `required_id` + a matching structural hash, on one observation) and **withdrawn only by a human**: `mark {screen_id, status: candidate}` / `app-map mark-screen <id> candidate`. The demote deletes `last_verified_build` — the confidence decay above must not report a verification that has been taken back — and records `meta.reviewed_by`. `verified` cannot be marked by hand without `force` plus a `reviewer`: a hand-signed verification is exactly the self-certification the demote exists to undo. Marking a screen `retired` by hand cascades to its recipes like a router-export removal, and KEEPS `last_verified_build`, which is what `import-router --purge-retired` reads to mean "retired for one release".
- `name_screen` with `force` re-learns a screen that is no longer `candidate` (the signature is rebuilt from the current observation), drops it back to `candidate`, and records `meta.relearned_from: <the overridden status>` so the override is visible in the PR diff. A human `mark` with a `reviewer` clears the marker — the same contract `provenance.machine_recompile` has for recipes (§6).
- A demote is not a lock: the next clean observation re-verifies the screen. Demote, then re-learn.
- `schema_version` bumps require a migration script under `tools/app-map-mcp/migrations/`.
- The schemas are part of the MAP, not of the package: `validate` compiles `<APP_MAP_DIR>/schema/*.schema.json`, the copy the consuming repo vendored. So an **additive** optional field (`meta.reviewed_by`, `meta.relearned_from`, `provenance.machine_recompile`) needs no `schema_version` bump — every existing file stays valid — but a consumer still has to re-copy `app-map/schema/` when it upgrades the package, because `meta` and `provenance` are `additionalProperties: false` and the first file a newer package writes then fails rule 1 (`must NOT have additional properties`), which cascades: a screen file that fails to load takes its recipes' `expect.screen` down with it (rule 3). A bump plus a migration is for the other kind of change — one that makes an EXISTING file invalid.

## 9. Merge rules

- Per-entity files make most merges trivial. When both sides edit the same screen file, the conflict is real and a human resolves it; `app-map validate` must pass before merge.
- Optional (phase 2): `.gitattributes` line `app-map/**/*.yaml merge=app-map-yaml` with a semantic 3-way merge driver (`app-map merge-driver`) that merges per key and per `id`-keyed list item and conflicts only on same-key changes. Requires a one-time `git config` per developer; GitHub's web merge ignores it, so CI validation remains the backstop.
- Never merge `.local/` — it is ignored.

## 10. Validation rules (`app-map validate`)

Rules produce **errors** and **warnings**. `app-map validate` exits non-zero on any error and the
server refuses to load a map that has one (`invalid_map`); warnings are printed, counted and carried
on the loaded map (`summary` names them), but never block either.

1. Every file validates against its JSON Schema.
2. Every element id, screen id, gate id exists in `ids.yaml`, and every edge `action.element` is
   also declared in its own screen's `elements[]`. The second half is a **warning, not an error**
   while exploration has not reached it. Three subjects can be unreached, and **any one** makes it
   a warning:
   - the **screen** — `meta.status: candidate` with `elements: []`, a router-export seed (01 R6)
     whose elements exploration has not learned yet (03 §5). Erroring would make the seed unloadable
     before exploration can start: the map would not load, so no observation could be ingested, so
     `name_screen` could never populate `elements[]`.
   - the **element** — a `status: candidate` edge whose element **no screen file records as present
     anywhere in the map** (no `elements[]`, `signature.required_ids`, `dynamic_regions` or variant
     `required_ids` entry), i.e. no capture has ever produced that id. This is what a build N+1
     `import-router` refresh appends to an already-explored screen, where the first condition cannot
     apply — `mergeRouterScreen` adds the new build's edges and touches neither `elements[]` nor
     `meta.status`.
   - the **capture** — a `status: candidate` edge on a screen whose `sources` include
     `router_export` and whose `meta.last_verified_build` is **older than the build
     `manifest.yaml` names**. `elements[]` is the id set the last `name_screen` captured, at that
     build; the refresh above appends the next build's edges to the same file and recaptures
     nothing, so the capture could not have contained an id the app registered since. This is the
     same refresh as the element condition, for the case where the new edge names **shared chrome**
     — a tab bar, a back button — that another screen already declares, so "no capture has produced
     it" is false. It self-heals: re-explore the screen and `name_screen` stamps the current build,
     after which an element that really is absent is an error again.

   None of the three subsumes another. The element condition alone would not cover first-run setup,
   because a seed's edges routinely name that same shared chrome while the screen has never been
   captured at all. The screen condition alone only survives the first import. The capture condition
   alone would let a fresh, current capture be contradicted for ever. An element recorded on another
   screen, on a screen whose capture is of this build, is a real gap rather than an unreached one
   and stays an error; so does a non-`candidate` edge, which asserts the tap already happened on
   this screen; and so does any undeclared element on a screen the router does not write, where
   nothing appends edges on its own and there is no cycle to break. An element missing from
   `ids.yaml` altogether is always an error — that is a typo, not a gap. §8 keeps the conditions
   honest: `markVerified` never promotes a screen whose `elements` is empty, nor an edge whose
   element that screen does not declare.

   Also a **warning** for an `expect.focused` on a platform whose driver reports no focus: Argent's
   iOS snapshot carries no focus flag, so the assertion can never be satisfied and every replay of
   the step falls back (04 §10).
3. Every edge `to`, every recipe `entry.fallback_path` entry, every `expect.screen` references an existing screen.
4. Every committed element has ≥2 locators and an `a11y_id` locator unless `role_label` is the only possible strategy (OS gates).
5. No `text` strategy stands alone.
6. `intent_critical` elements in `ids.yaml` and screen files agree.
7. Serialization is canonical (re-export produces no diff).
8. No forbidden content: regex sweep for emails, phone numbers, 16-digit numbers, currency values inside `elements[].label` or any `text` field; any hit fails validation.

## 11. Acceptance criteria

- [ ] JSON Schemas for manifest, screen, recipe, ids, router-export exist and are used by `app-map validate`.
- [ ] Hand-written pilot files (login, invoice_list, invoice_new, invoice_detail, client_picker, one gate, `create_invoice`) validate.
- [ ] `app-map export` is idempotent on the pilot files.
- [ ] A branch that adds `screens/client_picker.yaml` merges into a branch that edits `screens/invoice_list.yaml` with no conflict.
