# Rollout, baseline and thresholds (08 §3, §5, §6)

Working copy of the numbers that decide whether the map pays for itself. 08 §3 says the baseline
table is published in `app-map/README.md`; that file is owned by the map directory — fill in the
template below and copy it there when Stage 0 exits.

## 1. Baseline experiment (08 §3)

Five tasks on the pilot flow (login → invoice_list → invoice_new → invoice_detail), each run 5×
with the map disabled (fresh session, no hooks, no summary) and 5× at each rung as recipes become
available. Values are means over the 5 runs; `success rate` is the fraction ending `ok` without
human intervention. Source: `app-map/.local/events.jsonl` (`task` events) plus the harness's own
cost reporting (`app-map report`).

| metric | definition | target vs no-map | no-map | explore | guided | headless |
|---|---|---|---|---|---|---|
| success rate | tasks ending `ok` without human intervention | ≥ +20 pts | | | | |
| driver calls per task | mean `driver_calls` (`mcp__argent__*` calls counted by the PostToolUse hook) | −50% at guided, −100% at headless | | | | |
| perception bytes per task | mean `perception_bytes` (scrubbed tree bytes returned by the driver) | −70% at guided | | | | |
| screenshots per task | mean `screenshots` | → 0 on known screens | | | | |
| wall-clock per task | mean `ms` | −50% at headless | | | | |
| harness-reported cost per task | from the harness's cost output | record; same shape as perception bytes | | | | |

Per-task sheet (repeat for tasks T1–T5; rung columns fill in as recipes appear):

| task | run | mode | ok | driver_calls | perception_bytes | screenshots | ms | cost |
|---|---|---|---|---|---|---|---|---|
| T1 create invoice ($50, Acme) | 1–5 | no-map | | | | | | |
| T1 | 1–5 | explore | | | | | | |
| T1 | 1–5 | guided | | | | | | |
| T1 | 1–5 | headless | | | | | | |
| T2 filter invoices (unpaid) | … | | | | | | | |
| T3 open invoice detail from list | … | | | | | | | |
| T4 pick a client on a new invoice | … | | | | | | | |
| T5 log in with the fixture account | … | | | | | | | |

**Stop rule (08 §3):** if `guided` does not cut driver calls by at least half on the pilot, stop and fix
identification/matching before building headless.

## 2. Stage checklist (08 §6)

### Stage 0 — Pilot (one flow, one platform, one developer)
Scope: 01 for the pilot screens; 02 hand-written pilot files; 03 with `summary`, `identify_screen`,
`get_screen`, `find_element`, `match_recipe`; 05 hooks. No headless.
- [ ] `ids.yaml` covers login, invoice_list, invoice_new, invoice_detail, client_picker; constants generated and committed
- [ ] markers and element ids visible in `argent` / `maestro hierarchy` on every pilot screen
- [ ] `appmap://invoice_new?fixture=logged_in` lands on the real screen with real state
- [ ] fresh clone → `claude` → approve servers → summary visible in the first turn (05 §7)
- [ ] baseline table: no-map and guided columns filled
- **Exit:** guided ≥ 50% fewer driver calls; one recipe compiled from a real session; two developers can pull the branch and replay it.

### Stage 1 — Compile and replay (team on `main`)
Scope: 04 in full; 06 R1–R3, R5; 07 scrubber + policy + CODEOWNERS; the replayer subagent.
- [ ] `CODEOWNERS`: replace every `@ORG/platform-team` with the real GitHub team, and give that team
      **write** access — GitHub silently ignores an owner it cannot resolve, so until this is done the
      file parses but matches nobody and the 07 §7 review control is inert. The `validate` job fails
      while the placeholder is present.
- [ ] branch protection on `main` (GitHub setting, not in this repo — 07 §8): "Require a pull request
      before merging", "Require review from Code Owners", **1** approval for an ordinary map change and
      a `ci_gate` promotion by someone other than the author, **2** approvals when
      `app-map intent-critical-diff` reports a `true → false` downgrade (07 §7); "Require status
      checks": `validate` (and the mobile jobs once `APP_MAP_HAS_APP=true`).
- [ ] `validate` job green on every PR (R1–R3); `APP_MAP_HAS_APP=true` set, R5 gate running
- [ ] scrubber fixtures (email, phone, card-like, amount, fixture client name) redacted or dropped (07 §8)
- [ ] `app-nav-replayer` completes `create_invoice` in guided mode on the cheap model
- **Exit:** ≥ 5 recipes `verified`; `create_invoice` promoted to `ci_gate` and blocking PRs; nightly heal PR opened and reviewed at least once.

### Stage 2 — Drift, router import, Android
Scope: 06 R4, R6, R7; `app-map/android/` seeded from the Navigation graph; shared `ids.yaml` driving both platforms.
- [ ] drift report posted on PRs; a PR removing `invoice.add.button` fails R4 and R5 (06 §5)
- [ ] router-import PR opened after a merge that adds a screen
- [ ] Android pilot screens marked, deep-linked, exported
- **Exit:** brittleness index < 15% over three consecutive builds on iOS; Android pilot flow replaying headless.

### Stage 3 — Harden
Scope: PreToolUse locator rewrite if measurement shows guessing on known screens (05 §6); merge driver (02 §9); Apple Xcode MCP evaluated as an alternative driver; drop Argent if the license review requires it.
- [ ] `unknown` rate and `driver_calls` trends reviewed monthly (`app-map report`)
- **Exit:** map coverage > 80% of router-exported screens; `unknown` rate < 5%.

### Hosting trigger (08 §6) — do **not** host until all three hold
1. the same locator is re-healed on ≥ 3 branches in one sprint because heals reach `main` too slowly;
2. per-entity files still produce frequent same-file conflicts despite 02 §9;
3. security has signed off on an internet-reachable service.

## 3. Thresholds and where code enforces them (08 §5)

08 §8 requires these numbers to live in the enforcing logic, not as duplicated prose. The table names
the module that must own each (paths under `tools/app-map-mcp/`); if a module moves, update this
table, not the numbers.

| signal | action | enforced in |
|---|---|---|
| recipe replay success ≥ 95% across ≥ 3 builds | eligible for `ci_gate` (human promotes via `mark`) | `src/recipes/lifecycle.ts` (04 §8 `verified → ci_gate` guard) |
| `candidate → verified` | ≥ 3 successful replays across ≥ 2 sessions, no unresolved heals | `src/recipes/lifecycle.ts` |
| recipe fallback rate > 20% on a build | force recompile from the latest successful trajectory | `src/recipes/lifecycle.ts` |
| recipe failure > 50% of last 10 runs, over a window of ≥ 3 runs (or ≥ 2 heals pending review) | auto-recompile; the `version` moves only if the recompiled structure differs (04 §8) | `src/recipes/lifecycle.ts` (`THRESHOLDS.recompile_min_runs`, `failureRateExceeded`) |
| heal acceptance: score ≥ 0.75, runner-up ≥ 0.10 lower, `intent_critical` label identical, postcondition holds | apply heal, else fallback | `src/heal.ts` (04 §7.2) |
| max 2 gate dismissals and 1 heal per step | fallback beyond that | `src/recipes/guided.ts` (`GUIDED_LIMITS`, 04 §5) and `src/recipes/headless.ts` |
| screen `required_ids` missing in drift | block PR if `ci_gate`-referenced (`broken`); else warn (`degraded`) | `src/drift.ts` (06 R4 step 5) → non-zero exit in `.github/workflows/app-map.yml` |
| screen hash changed, ids intact | auto-reverify lazily; confidence decays `base × 0.9^builds_since_verified`, floor 0.2 | `src/drift.ts` + `src/identify.ts` (`DECAY_FACTOR`/`DECAY_FLOOR`, 02 §8, 03 §5) |
| unknown-screen rate > 10% for a week | schedule an exploration session or check router import | `app-map report` (`src/report.ts`) — alert only, human acts |
| `intent_critical` heal rejected | human review before anyone re-runs that recipe | `src/heal.ts` sets `fallback.reason: intent_critical_label_changed`; `scripts/app-map/open-heal-pr.sh` lists it under "needs human" |
| identification `best score < 0.6` → `unknown` | enter explore mode | `src/identify.ts` (03 §5) |
| `summary` ≤ 600 tokens, `get_screen` ≤ 400, step ≤ 120 | output caps | `APP_MAP_MAX_CONTEXT_TOKENS` in `src/config.ts` (03 §3) |
