# 08 — Metrics and Rollout

Status: draft v0.1 · Depends on: 05 · Closes the series

## 1. Purpose

Decide, with numbers, whether the map is paying for itself, when a recipe is trustworthy, when the map has gone stale, and when the design should change (hosting). Everything here is computed from `app-map/.local/events.jsonl` and CI artifacts; nothing needs a hosted dashboard.

## 2. Event schema

One JSON line per event, written by the server or CI:

| kind | fields |
|---|---|
| `task` | `session, task, mode_start, mode_end, ok, driver_calls, perception_bytes, screenshots, ms` |
| `recipe_run` | `recipe, version, mode, ok, steps, steps_done, heals, fallbacks, ms, build` |
| `heal` | `recipe, step, element, old_strategy, new_strategy, score, accepted, reason, build` |
| `identify` | `screen, confidence, signal, build` |
| `drift` (CI) | `screen, status, missing_ids, hash_changed, build` |
| `compile` | `recipe, version, from_session, steps, params` |

`driver_calls` = number of `mcp__argent__*` calls in the task (counted by the PostToolUse hook). `perception_bytes` = total scrubbed tree bytes returned by the driver during the task — the proxy for perception tokens, since the server cannot see LLM token counts. Correlate with the harness's own cost reporting during the baseline (§3).

## 3. Baseline experiment (before anything is promoted)

Five tasks on the pilot flow, each run 5× with the map disabled (fresh session, no hooks, no summary) and 5× with the map at each rung as recipes become available:

| metric | definition | target vs no-map |
|---|---|---|
| success rate | tasks ending `ok` without human intervention | ≥ +20 pts |
| driver calls per task | mean | −50% at `guided`, −100% at `headless` |
| perception bytes per task | mean | −70% at `guided` |
| screenshots per task | mean | → 0 on known screens |
| wall-clock per task | mean | −50% at `headless` |
| harness-reported cost per task | from the harness's cost output | record; expect the same shape as perception bytes |

Publish the table in `app-map/README.md`. If `guided` does not cut driver calls by half on the pilot, stop and fix identification/matching before building headless.

## 4. Steady-state metrics (`app-map report`)

Rolling 30-day, per platform:

- **Replay rate** = headless + guided runs with no fallback ÷ all task runs. Goal: rising.
- **Fallback rate per recipe** = runs with ≥1 `fallback` ÷ runs. Alert > 20% for any `verified`/`ci_gate` recipe on the current build.
- **Heal rate** = heals per 100 recipe runs; and **pending-review heals** count. Alert if pending > 5 or any `intent_critical` rejection.
- **Brittleness index** = fraction of recipe runs on a *new* build that needed ≥1 heal or fallback. This is the number that says whether the design is beating XCUITest-style brittleness.
- **Unknown-screen rate** = `identify` events with `unknown` ÷ all. Rising means the map is behind the app.
- **Map coverage** = screens with `deep_link` and `verified` status ÷ screens in router export.
- **Convergence** = success rate over successive runs of the same recipe; should rise, never fall, as in the published SkillDroid result (87%→91%). A falling curve means heals are mis-firing.

## 5. Thresholds (the same numbers 04 §8 and 06 §4 enforce)

| signal | action |
|---|---|
| recipe replay success ≥ 95% across ≥ 3 builds | eligible for `ci_gate` (human promotes) |
| recipe fallback rate > 20% on a build | force recompile from the latest successful trajectory |
| recipe failure > 50% of last 10 runs | auto-recompile to a new version |
| screen `required_ids` missing in drift | block PR if `ci_gate`-referenced; else warn |
| screen hash changed, ids intact | auto-reverify lazily; decay applies until then |
| unknown-screen rate > 10% for a week | schedule an exploration session or check router import |
| `intent_critical` heal rejected | human review before anyone re-runs that recipe |

## 6. Rollout

### Stage 0 — Pilot (one flow, one platform, one developer)
Scope: 01 for the pilot screens; 02 hand-written pilot files; 03 with `summary`, `identify_screen`, `get_screen`, `find_element`, `match_recipe`; 05 hooks. No headless yet.
Exit: baseline table shows `guided` ≥ 50% fewer driver calls; one recipe compiled from a real session; two developers can pull the branch and replay it.

### Stage 1 — Compile and replay (team on `main`)
Scope: 04 in full; 06 R1–R3, R5; 07 scrubber + policy + CODEOWNERS; the replayer subagent.
Exit: ≥5 recipes `verified`; `create_invoice` promoted to `ci_gate` and blocking PRs; nightly heal PR opened and reviewed at least once.

### Stage 2 — Drift, router import, Android
Scope: 06 R4, R6, R7; `app-map/android/` seeded from the Navigation graph; shared `ids.yaml` driving both platforms.
Exit: brittleness index < 15% over three consecutive builds on iOS; Android pilot flow replaying headless.

### Stage 3 — Harden
Scope: PreToolUse locator rewrite if measurement shows guessing on known screens (05 §6); merge driver (02 §9); Apple Xcode MCP evaluated as an alternative driver; drop Argent if the license review requires it.
Exit: map coverage > 80% of router-exported screens; `unknown` rate < 5%.

Rough sequencing: Stage 0 is one to two weeks for one engineer with the app changes landing in parallel; Stage 1 two to three weeks; Stage 2 depends on Android team capacity; Stage 3 is ongoing.

### Hosting trigger (moves off "local + git")
Do **not** host until all three hold:
1. the same locator is re-healed on ≥3 branches in one sprint because heals reach `main` too slowly;
2. per-entity files still produce frequent same-file conflicts despite 02 §9;
3. security has signed off on an internet-reachable service.

Migration path when triggered: the storage layer already sits behind an interface (03 §4). Step one replaces the local SQLite cache with a synced embedded replica while YAML stays the reviewed source of truth — live reads, no new inbound service. Step two, only for shared writes, stands up a remote Streamable HTTP MCP with OAuth 2.1 behind the org's MCP gateway, keeps YAML as the per-build exported snapshot, and registers the server in managed settings. Rollback is `export` to YAML.

## 7. Risks

| risk | mitigation |
|---|---|
| Published savings (SkillDroid, GraphPilot, AutoDroid) came from benchmarks, not a feature-flagged fintech app | baseline experiment before promotion; thresholds tuned to measured numbers |
| Screen identification degrades on server-driven or heavily flagged UI | markers make identification independent of layout; variants model flags; `unknown` triggers exploration, not failure |
| Heals accepted that are wrong but pass a loose postcondition | require `screen` expectations, not just `visible`; nightly PR review; `intent_critical` exact-label rule |
| Hook/MCP surface changes in the harness break recording silently | R1 runs a hook smoke test against a recorded fixture; `unknown` and `driver_calls` metrics reveal a dead hook |
| Team stops reviewing heal PRs | PR body is a short table; CODEOWNERS; auto-close after 14 days with the heal reverted to `candidate` |
| Argent license or proprietary binaries fail review | driver is an interface; Apple Xcode MCP / mobile-mcp as fallback; nothing in the map depends on the driver |

## 8. Acceptance criteria

- [ ] `app-map report` prints every §4 metric from `events.jsonl` and the latest CI artifacts.
- [ ] Baseline table exists for the pilot flow with at least the no-map and `guided` columns filled.
- [ ] Stage 0 exit criteria met and recorded in `app-map/README.md`.
- [ ] Thresholds in §5 are implemented as the enforcing logic in 04 §8 and 06 §4, not duplicated as prose.
