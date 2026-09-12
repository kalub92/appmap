# 06 — CI and Drift

Status: draft v0.1 · Depends on: 01–05 · Consumed by: 08

## 1. Purpose

Keep the committed map truthful on every PR, detect UI drift the moment a build changes, run promoted recipes as a regression gate, and turn heals into reviewable pull requests. CI is where "rigor of automation tests" is enforced without hand-written tests.

## 2. Jobs

| job | trigger | runner | time budget | blocks merge? |
|---|---|---|---|---|
| R1 `validate` | every PR | linux | <30 s | yes |
| R2 `lint-and-config-sync` | every PR | linux | <30 s | yes |
| R3 `mcp-policy` | every PR | linux | <10 s | yes |
| R4 `drift` | every PR that builds the app | macos (iOS) / linux+emulator (Android) | <10 min | yes for `ci_gate`-referenced screens; otherwise warn |
| R5 `gate-recipes` | every PR that builds the app | same | <15 min | yes |
| R6 `nightly-heal` | nightly, main | same | <45 min | no — opens a PR |
| R7 `router-import` | on main after merge | same | <10 min | no — opens a PR if the map changed |

### R1 validate
`app-map validate` (02 §10) on every platform directory. Also runs `app-map export --check`: reload YAML → export to temp → diff must be empty (canonical form).

### R2 lint and config sync
`app-map lint-ids` (01 R8); `scripts/app-map/gen-ids --check`; `app-map gen-configs --check` (05 §2). Any drift between `ids.yaml`, generated constants, `.mcp.json`, and generated harness configs fails.

### R3 MCP policy
Parse `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.claude/settings.json`. Fail if:
- a server is not on `app-map/policy/mcp-allowlist.yaml` (07 §6);
- any `command` uses `npx` without an exact version pin;
- any literal that looks like a token/secret appears in `env`, `headers`, or `url`;
- a hook script outside `.claude/hooks/` is referenced.

### R4 drift tour
For the build produced by the PR:
1. Boot simulator/emulator, install the app, run the router export (01 R6).
2. For every screen with a `deep_link`: open it, wait for its marker (`extendedWaitUntil`), dump the hierarchy (`maestro hierarchy`), scrub, compute the signature.
3. Compare with the committed screen: marker present? `required_ids` present (fraction)? `structural_hash` equal? Elements resolvable by `a11y_id`?
4. Emit `drift-report.json` and a PR comment table: screen · status (`ok | degraded | broken`) · missing ids · hash changed.
5. Fail if any screen referenced by a `ci_gate` recipe is `broken` (marker or any `required_id` missing). Warn on `degraded`.

The drift report also feeds decay: screens whose hash changed get `last_verified_build` left as-is so confidence decays until re-verified (02 §8).

### R5 gate recipes
`app-map maestro-export --status ci_gate --out .ci/maestro/` then `maestro test .ci/maestro/` against the PR build with the `logged_in` fixture. Non-zero exit fails the PR. Flows are generated per run, never committed. Test accounts are sandbox-only (07 §4).

### R6 nightly heal
On `main`, headless-run every `verified` and `ci_gate` recipe (04 §6). Heals that pass verification are exported (`app-map export`) and pushed to a branch `app-map/heal-<date>`; a PR is opened with the heal log (old locator → new locator, score, step, recipe) as the description. Reviewers in CODEOWNERS approve. Rejected heals (`intent_critical` or low score) are listed in the PR as "needs human", not applied. No auto-merge, ever.

### R7 router import
After merge to `main`, run the router export and `app-map import-router`; if screens or edges changed, open a PR `app-map/router-<sha>` with the diff. This keeps the map's skeleton in step with the code without exploration.

## 3. Workflow sketch

```yaml
# .github/workflows/app-map.yml
name: app-map
on:
  pull_request:
  schedule: [{cron: "0 6 * * *"}]   # nightly heal
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: {node-version: 22, cache: npm, cache-dependency-path: tools/app-map-mcp/package-lock.json}
      - run: npm ci --prefix tools/app-map-mcp
      - run: tools/app-map-mcp/bin/app-map validate
      - run: tools/app-map-mcp/bin/app-map export --check
      - run: tools/app-map-mcp/bin/app-map lint-ids
      - run: scripts/app-map/gen-ids --check
      - run: tools/app-map-mcp/bin/app-map gen-configs --check
      - run: tools/app-map-mcp/bin/app-map policy-check
  ios-drift-and-gate:
    if: github.event_name == 'pull_request'
    runs-on: macos-15
    needs: validate
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/build-app.sh --configuration Debug --sim
      - run: ./scripts/app-map/router-export.sh --out /tmp/router-export.json
      - run: tools/app-map-mcp/bin/app-map drift --platform ios --router /tmp/router-export.json --out drift-report.json
      - run: tools/app-map-mcp/bin/app-map maestro-export --platform ios --status ci_gate --out .ci/maestro
      - run: maestro test .ci/maestro
      - uses: actions/upload-artifact@v4
        with: {name: app-map-drift, path: drift-report.json}
  nightly-heal:
    if: github.event_name == 'schedule'
    runs-on: macos-15
    steps:
      - uses: actions/checkout@v4
      - run: ./scripts/build-app.sh --configuration Debug --sim
      - run: tools/app-map-mcp/bin/app-map run --all --status verified,ci_gate --headless --report heal-report.json
      - run: tools/app-map-mcp/bin/app-map export
      - run: ./scripts/app-map/open-heal-pr.sh heal-report.json   # gh pr create; never merges
```

Android mirrors the iOS job on `ubuntu-latest` with an emulator action; the map directory is `app-map/android/`.

## 4. Failure semantics

| condition | effect |
|---|---|
| schema/reference error | PR blocked |
| non-canonical YAML | PR blocked (author runs `app-map export`) |
| unapproved MCP server or unpinned `npx` | PR blocked |
| `ci_gate` screen broken | PR blocked with the missing ids named |
| `ci_gate` recipe fails after nightly-style heal attempt | PR blocked; failure includes the failing step and the last screen seen |
| non-gate screen degraded | warning comment only |
| heal pending review | not a CI status; surfaced in the nightly PR |

## 5. Acceptance criteria

- [ ] A PR that renames an id without `migrate-id` fails R1 with the dangling references listed.
- [ ] A PR that removes `invoice.add.button` from the app fails R4 with `invoice_list: broken — missing invoice.add.button` and fails R5 on `create_invoice`.
- [ ] A PR that changes only the label of `invoice.add.button` passes R4/R5 (id unchanged).
- [ ] The nightly job opens a PR containing a healed `role_label` locator with the heal log in its body and no other changes.
- [ ] R3 fails on a `.mcp.json` that adds an unlisted server.

## 6. Open questions

- Simulator boot + install time on hosted macOS runners may dominate R4; consider a prebuilt simulator image or self-hosted Mac runners if >6 min.
- Whether R7 should open a PR or push directly to a `map-updates` branch that developers rebase on; start with PRs.
