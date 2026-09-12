# 04 — Recipes, Replay, and Healing

Status: draft v0.1 · Depends on: 03 · Consumed by: 05, 06, 08

## 1. Purpose

Turn one successful exploration into a recipe that replays without the LLM, keeps replaying when the UI drifts, and hands control back to the LLM only at the step that broke. This spec is the "compile once, replay, heal, fall back" loop.

## 2. Trajectory capture

- Every driver tool call (`mcp__argent__*`) in a session is recorded as an observation (02 §7) via the PostToolUse hook (05 §3) or, without hooks, `record_observation`.
- The current task text is attached from the `task` the LLM declares by calling `match_recipe` (or `name_task` if nothing matched). Observations before a task is declared are kept but not compilable.
- Each observation carries `screen_before`/`screen_after` from §5 of 03 and the resolved element id for the tapped node when one exists.

## 3. Compiler

`compile_recipe(session, task, recipe_id, params)` produces a **draft** recipe from the trajectory:

1. **Slice** observations from task start to the first observation where the LLM's `report_task(ok: true)` or a `verify`-satisfying screen appears.
2. **Collapse backtracking**: remove `A → B → A` loops where nothing was typed in `B`. Remove repeated identical taps.
3. **Translate** each observation to a step: tap on element id → `tap`; text entry → `type` on the focused element id; tap on a `dynamic` cell → `select` with `match.text` bound to the typed/selected value; `openLink` → `open_link`.
4. **Parameterize**: any typed or selected value that string-matches a declared `params` argument becomes `{param}`. Values that match nothing stay literal only if they are static copy; otherwise compilation fails with `unparameterized_value` and the LLM is asked to declare the param.
5. **Entry optimization**: if the first screen where a step is taken has a deep link, replace the leading navigation steps with `entry.deep_link` and keep the navigation as `fallback_path`.
6. **Postconditions**: each step's `expect` is `screen: <screen_after>` when the screen changed, else `focused`/`visible` inferred from the next observation.
7. **Mark** any step touching an `intent_critical` element.
8. Emit YAML with `status: candidate` and provenance; return it for LLM review. The LLM adds `matches`, `description`, checks params, and calls `mark_recipe(candidate)` to write it. Nothing is written without that call.

A recipe that cannot be compiled (loops that never converge, unparameterized values, missing postconditions) fails loudly with the reason; the trajectory stays for a human to inspect.

## 4. Matching

`match_recipe(instruction)`:

1. Regex over each recipe's `matches`, case-insensitive; first hit wins; confidence 0.9.
2. No hit → return `no_match` plus ≤8 candidates (`id — description`) so the LLM can pick by calling `run_recipe` directly. This keeps matching cheap without embedding infrastructure. Embedding-based matching is a later option, not a dependency.
3. Filter by `platform` and `status != retired`.
4. `params_needed` lists required params the instruction did not obviously supply; the LLM fills them in the `run_recipe` call.

## 5. Guided replay (rung `guided`)

Protocol between the LLM (or the `app-nav-replayer` subagent, 05 §5) and the server:

```
LLM   run_recipe(create_invoice, {amount: 50, client: Acme}, mode: guided)
SRV   → {run_id, step: {id: s0, action: open_link, url: appmap://invoice_new?fixture=logged_in,
                        expect: {screen: invoice_new}}}
LLM   argent.open_url(...)                     # PostToolUse hook records observation
LLM   report_step(run_id, s0, ok: true)
SRV   verifies last observation against expect:
        ok   → {step: s1 …}
        gate → {step: {action: dismiss_gate, gate: gate.push_permission}, then retry s0}
        miss → heal (§7); if healed → {step: s1, healed: {...}}
               else → {fallback: {step: s0, reason, screen_seen, candidates}}
…
SRV   → {done: true, verified: true, heals: []}
```

Rules:

- The server never trusts `ok: true` alone; it verifies from the recorded observation. Without hooks, `report_step` requires a `snapshot` argument (expensive; discouraged).
- Each step returned is ≤120 tokens: action, resolved locator (the strategy that will hit), expectation.
- On `fallback`, the LLM takes over from that step in `explore` mode with the map as a prior; the run is logged as `guided_fallback` and the trajectory from that point is compilable into a recipe **revision** (§8).
- Max 2 gate dismissals per step and 1 heal per step; beyond that, fallback.

## 6. Headless replay (rung `headless`)

### 6.1 Execution

`run_recipe(mode: headless)` or `app-map run R --headless`:

1. Export the recipe to a Maestro flow (§6.2) into `app-map/.local/maestro/<recipe>.yaml`.
2. Run `maestro test <flow>`; capture exit code and the failing command index.
3. On failure at step k: run `maestro hierarchy` (or read Argent if the harness is present), identify the screen, attempt gate dismissal, then heal (§7). If healed, re-export from step k and rerun. Max 2 retries.
4. Return `{ok, steps_done, heals[], fallback_step?, ms}`. On `fallback_step`, the caller may resume in guided mode from that step.

### 6.2 Recipe → Maestro mapping

| recipe step | Maestro |
|---|---|
| `open_link url` | `- openLink: <url>` |
| `tap element` | `- tapOn: { id: "<a11y_id>" }` (regex form when the locator is `role_label` with `label_regex`) |
| `type element text` | `- tapOn: { id }` then `- inputText: "<text>"` |
| `select list match.text` | `- scrollUntilVisible: { element: { text: "<text>" } }` then `- tapOn: { text: "<text>" }` |
| `swipe` | `- swipe: { direction, duration }` |
| `dismiss_gate g` | `- runFlow: { when: { visible: { id: "<gate marker or label regex>" } }, commands: [ - tapOn: { id: "<dismiss>" } ] }` — emitted before every step that lists `g` |
| `expect screen s` | `- extendedWaitUntil: { visible: { id: "screen.<s>" }, timeout: 10000 }` |
| `expect visible e` | `- assertVisible: { id: "<e>" }` |
| `wait_for` | `- extendedWaitUntil` |
| recipe `verify` | assertions for `screen` and each `visible` |

Locators export in cascade order as far as Maestro can express them: `a11y_id` → `id:`, `role_label` → `id:` regex or `text:`, `text` → `text:`. `path` and `geometry` are not exported; a step whose only viable locator is one of those is not headless-eligible and the recipe stays at `guided`.

Flows are generated, never committed; CI regenerates them (06 R5).

## 7. Healing

Triggered by a `miss` or `degraded` resolution (03 §6) during any replay.

### 7.1 Candidate scoring

Against the current scrubbed tree, for each node with a compatible role:

| feature | weight |
|---|---|
| role equality | 0.35 |
| `label_norm` similarity (Jaro-Winkler) | 0.30 |
| `path` similarity (LCS over role path) | 0.15 |
| `bbox_norm` proximity | 0.10 |
| parent role + sibling index match | 0.10 |

### 7.2 Acceptance

A candidate is accepted only if **all** hold:

1. score ≥ 0.75 and the runner-up is ≥ 0.10 lower;
2. if the element is `intent_critical`: `label_norm` is identical to the stored fingerprint (invariant 6);
3. the step's `expect` holds after acting on the candidate.

Then: the step proceeds; the element's locators are updated in the cache (new `a11y_id` if the candidate has one, else the winning strategy promoted); element `status: healed_pending_review`; a `heal` event is logged with old locator, new locator, score, and step. `app-map export` writes the change so it appears in the next PR diff.

Rejected → `fallback` to the LLM with the top-3 candidates listed. An `intent_critical` rejection additionally sets `fallback.reason: intent_critical_label_changed` so the LLM confirms with the user before acting.

### 7.3 What healing never does

- Never tries a `text` or `geometry` strategy alone on an `intent_critical` element.
- Never accepts a heal without a postcondition; steps without `expect` cannot heal and fall back.
- Never writes to YAML directly; export is the only path to git.

## 8. Status lifecycle and revisions

| transition | condition |
|---|---|
| — → `candidate` | `mark_recipe(candidate)` after compile review |
| `candidate` → `verified` | ≥3 successful replays (guided or headless) across ≥2 sessions, no unresolved heals |
| `verified` → `ci_gate` | ≥95% replay success across ≥3 builds; human `mark_recipe(ci_gate)`; CODEOWNERS review (07 §7) |
| any → `candidate` (recompile) | failure rate over the last 10 runs > 50%, or ≥2 heals pending review; the compiler produces a new `version` from the latest successful trajectory |
| any → `retired` | a referenced screen is retired |

Recipe `version` increments on every structural change (steps, params, entry). Locator heals do not bump the version.

## 9. Acceptance criteria

- [ ] One exploration session of "create an invoice" in Claude Code compiles to `create_invoice.yaml` that validates and reads correctly in review.
- [ ] Guided replay of that recipe completes with ≤5 LLM tool calls beyond `run_recipe`/`report_step` and no screenshots.
- [ ] Headless replay completes via Maestro with zero LLM calls on the same build.
- [ ] Renaming `invoice.add.button`'s label in the app (id unchanged) → replay unaffected. Removing the id but keeping the label → heal by `role_label`, step verified, element `healed_pending_review`, diff visible after export.
- [ ] Changing the label of `invoice.save.button` (`intent_critical`) and removing its id → heal rejected, `fallback` with `intent_critical_label_changed`.
- [ ] A recipe that fails 6 of its last 10 runs is recompiled to a new version automatically.

## 10. Open questions

- Maestro `focused` selectors: confirm support; otherwise `expect.focused` compiles to a `visible` assertion.
- Whether headless runs should share the simulator with an active Argent session; default no — headless runs use their own booted simulator UDID (`APP_MAP_SIM_UDID`).
