---
name: app-nav
description: Drive the mobile app on the simulator/emulator through the app-map. Use whenever a task mentions the simulator, emulator, the app, a screen, a flow, a recipe, or tapping/typing in the app.
---
# app-nav — navigate the app through the map (05 §4)

## Four rules
1. **Recipe first.** Call `mcp__app-map__match_recipe` with the task text. On a match, `run_recipe(mode: guided)` — or delegate to the `app-nav-replayer` subagent — execute exactly the step returned, then `report_step`. "create an invoice for $50 for Acme" → `create_invoice {amount: 50, client: Acme}`.
2. **Identify before you tap.** No match → `identify_screen`, then `get_screen(screen_id)` once per screen visit. Tap by the `a11y_id` shown there (`invoice.add.button`), never by coordinates or guessed text. Enter via `plan_path(from, to)` deep links (`appmap://invoice_new?fixture=logged_in`); tapping through is the fallback.
3. **Tree over screenshots.** Screenshot only when the accessibility tree is empty or the task is visual. Never paste trees into `record_observation`: the PostToolUse hook already records every `mcp__argent__*` call.
4. **Compile what worked.** After a new task succeeds, `compile_recipe(session, task, recipe_id, params)`, review the draft (below), then `mark_recipe(candidate)`. Nothing is written without that call.

## The ladder
- **explore** — you drive Argent with the map as a prior (rules 2–3). Unknown screen → `name_screen` creates a candidate.
- **guided** — the server hands you one step at a time (action, locator, expectation); you execute and `report_step`; it verifies from the recorded observation, dismisses gates, heals degraded locators. Cheap-model territory (`app-nav-replayer`).
- **headless** — `run_recipe(mode: headless)` / `app-map run R --headless`: Maestro replays with zero LLM calls; CI runs `ci_gate` recipes this way.
Start at the highest rung the recipe status allows; drop one rung only on fallback.

## Fallback protocol (04 §5)
`report_step` may return `fallback: {step, reason, screen_seen, candidates}`. Then: (1) stop replaying; (2) take over from that step in explore mode — `identify_screen`, `get_screen`, try `candidates` first; (3) if `reason` is `intent_critical_label_changed`, confirm with the user before acting; (4) finish the task, then `compile_recipe` — the trajectory from the failed step becomes a recipe revision. The server allows 2 gate dismissals and 1 heal per step.

## Reviewing a compiled recipe
Check: `matches` regexes cover natural phrasings and nothing else; each `params` entry has a type and `required`; typed values are `{param}` slots, never literals (fixture values are data, not copy); `entry.deep_link` is set when the first screen has one; every step has an `expect`; `intent_critical` steps are marked and genuinely required; `verify` names the final screen. Then `mark_recipe(candidate)`. Promotion to `verified`/`ci_gate` is a human decision after replays (04 §8).

Details: docs/specs/03 (tools), 04 (recipes, healing), 05 (harness).
