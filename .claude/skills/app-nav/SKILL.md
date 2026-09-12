---
name: app-nav
description: Drive the mobile app on the simulator/emulator through the app-map. Use whenever a task mentions the simulator, emulator, the app, a screen, a flow, a recipe, or tapping/typing in the app.
---
# app-nav — navigate the app through the map, 05 §4

## Four rules
1. **Recipe first.** `match_recipe` with the task text; on a match `run_recipe` in guided mode, or delegate to the `app-nav-replayer` subagent. Execute exactly the step returned, then `report_step`. Example: "create an invoice for $50 for Acme" → create_invoice {amount: 50, client: Acme}.
2. **Identify before you tap.** No match → `identify_screen`, then `get_screen` once per visit. Tap by the `a11y_id` it shows, e.g. invoice.add.button — never by coordinates or guessed text. Enter by `plan_path` deep link, e.g. appmap://invoice_new?fixture=logged_in; tapping through is the fallback.
3. **Tree over screenshots.** Screenshot only when the tree is empty or the task is visual. Never paste a tree into `record_observation` — the PostToolUse hook records every driver call already.
4. **Compile what worked.** When a new task succeeds, `compile_recipe`, review the draft — see reference/review-a-recipe.md — then `mark_recipe` with status candidate. Nothing is written without that call.

## The ladder
Start at the highest rung the recipe status allows; drop a rung only on fallback.
- **explore** — you drive Argent with the map as a prior, per rules 2–3; unknown screen → `name_screen`.
- **guided** — the server hands out one step at a time and verifies it from the recorded observation, dismissing gates and healing degraded locators. Cheap-model territory.
- **headless** — Maestro replays with no LLM calls; CI runs ci_gate recipes this way.

## Fallback protocol, 04 §5
`report_step` may return a fallback carrying step, reason, screen_seen and candidates. Stop replaying; take over from that step in explore mode, trying the candidates first; if the reason is intent_critical_label_changed, confirm with the user before acting; finish the task, then `compile_recipe` — the trajectory from the failed step becomes a revision. Budget: 2 gate dismissals and 1 heal per step.

Specs: docs/specs/03 tools, 04 recipes and healing, 05 harness.
