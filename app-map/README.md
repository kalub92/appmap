# app-map

The durable map of the app's screens, elements and recipes that the `app-map` MCP server
(`tools/app-map-mcp/`) serves to coding agents. Everything here is structure only — ids, roles,
static copy, locators, hashes, routes, edges, recipe steps with parameter slots (07 §2.1). No
screenshots, values, cell text or user identifiers are ever committed (07 §2.2); `app-map
validate` sweeps for them (02 §10.8).

## Layout

```
ids.yaml                     shared id registry for both platforms (01 R1) — the source of every
                             screen, element and gate id; scripts/app-map/gen-ids derives the
                             Swift/Kotlin constants from it
schema/<kind>.schema.json    JSON Schemas (draft-07) every file below validates against (02 §2.5)
policy/mcp-allowlist.yaml    permitted MCP servers with pinned versions, reviewer, date (07 §6)
ios/manifest.yaml            app id, platform, deep-link scheme, last exported build (02 §3)
ios/screens/<screen_id>.yaml one file per screen or gate: signature, elements + locator
                             cascades, outgoing edges, provenance (02 §4)
ios/recipes/<recipe_id>.yaml one file per recipe: matches, params, entry, steps, verify (02 §6)
android/…                    same shape for Android; ids are shared, locators use testTag
                             resource ids (01 R3)
.local/                      git-ignored runtime state: cache.sqlite, ingest.sock,
                             trajectories/, events.jsonl, server.log, strings.<platform>.txt,
                             ci-params.<platform>.json (CI recipe param values, generated from
                             the app's fixtures at build time — 07 §2.3.5), maestro/ (02 §7, 07 §2.4)
```

Files are written in canonical form (fixed key order, id-sorted lists, block style, 2-space
indent, LF — 02 §2.3; exact rules in `docs/dev/architecture.md`). Edit them by hand if you
like, but run `tools/app-map-mcp/bin/app-map export --check` before committing; CI rejects
non-canonical files (06 R1). Session changes (new screens, heals, status changes) reach these
files only through `app-map export` (03 §4).

Pilot flow (08 §6 Stage 0): `login → invoice_list → invoice_new → client_picker → invoice_detail`,
gates `gate.push_permission` and `gate.biometric_prompt`, recipe `create_invoice`.

## Baseline (08 §3)

Five tasks on the pilot flow, each run 5× with the map disabled (fresh session, no hooks, no
summary) and 5× with the map at each rung as recipes become available. Fill the cells from
`app-map report` and the harness's cost output; targets are relative to the no-map column.

| metric | definition | target vs no-map | no-map | guided | headless |
|---|---|---|---|---|---|
| success rate | tasks ending `ok` without human intervention | ≥ +20 pts | | | |
| driver calls per task | mean `mcp__argent__*` calls | −50 % at guided, −100 % at headless | | | |
| perception bytes per task | mean scrubbed tree bytes returned by the driver | −70 % at guided | | | |
| screenshots per task | mean | → 0 on known screens | | | |
| wall-clock per task | mean | −50 % at headless | | | |
| harness-reported cost per task | from the harness's cost output | record; same shape as perception bytes | | | |

Stage 0 exit (08 §6): `guided` ≥ 50 % fewer driver calls; one recipe compiled from a real
session; two developers can pull the branch and replay it. Record the date and numbers here
when met: _pending_.
