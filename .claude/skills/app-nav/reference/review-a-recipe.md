# Reviewing a compiled recipe (04 §3.8, 04 §8)

`compile_recipe` returns a **draft**. Nothing is written until you call
`mark_recipe(recipe_id, status: candidate, recipe: <the yaml>)`.

Check, in order:

- **`description` and `matches`** — the compiler emits placeholders derived from the recipe id, so
  you must write both. `matches` regexes cover natural phrasings of the task and nothing else.
  Structure only: never a client name, an amount, an email or any other task data (02 §10.8, 07 §2)
  — `app-map validate` rule 8 rejects those.
- **`params`** — one entry per value the task varies, each with a `type` and `required`.
- **Typed values are `{param}` slots**, never literals. A fixture value is data, not copy.
- **`entry.deep_link`** is set when the first screen has one; `entry.fallback_path` otherwise.
- **Every step has an `expect`** the server can verify from an observation.
- **`intent_critical`** is marked on the steps that genuinely commit the user's intent (save, send,
  pay) and mirrors `ids.yaml` — validate rule 6 enforces the mirror.
- **`verify`** names the final screen, ideally with `visible` ids.

Promotion to `verified` is automatic after replays; `ci_gate` is a human decision with a reviewer
who is not the author (04 §8, 07 §7).
