# 07 — Security and Governance

Status: draft v0.1 · Cross-cutting; applied to 01–06

## 1. Purpose

The app is a financial product. The map is a machine-readable description of how to operate it, executed by agents, stored in a shared repo. This spec defines what may be stored, what may run, who may change it, and how the supply chain is controlled.

## 2. Data policy

### 2.1 Allowed in git (`app-map/**`)
Screen ids, element ids, roles, static UI copy that also exists in the app's string tables, locator cascades, structural hashes, routes, edges, recipe steps with parameter *slots*, provenance, status, build numbers.

### 2.2 Never in git, never in logs
Screenshots or image paths; text field values; list/cell/table content; names, emails, phone numbers, account or card numbers, amounts, addresses; auth tokens; device identifiers; anything captured from a non-fixture account.

### 2.3 Scrubber rules (03 §7 implements)
1. Drop every `value` attribute unconditionally.
2. Drop all text under any container marked `dynamic: true` in `ids.yaml`.
3. Keep `label` only if (a) the node has a registered id with `dynamic: false`, or (b) the label exactly matches an entry in the app's static string table snapshot (`app-map/.local/strings.<platform>.txt`, generated from the string catalogs at build time, git-ignored).
4. Regex deny list applied to every surviving string: email, E.164/US phone, 13–19 digit runs, currency patterns (`[$€£]\s?\d`), IBAN-like, SSN-like. Any hit → string replaced by `[redacted]` and the observation flagged `scrub_hit` for review of the rule set.
5. Fixture parameter values (e.g. the test client name) are treated as data, not copy: they are never stored as literals in recipes — the compiler parameterizes or fails (04 §3.4).
6. `app-map validate` rule 8 re-sweeps committed YAML as a backstop.

### 2.4 Retention
`.local/trajectories` and `.local/events.jsonl` older than 14 days are deleted on server start. `.local/` is in `.gitignore`. Nothing under `.local/` is uploaded as a CI artifact except `drift-report.json` and `heal-report.json`, which contain ids and scores only.

## 3. Execution policy

- Recipes run only against Debug builds on simulators/emulators using **fixture accounts** in a sandbox environment. The `appmap://` handler and fixtures do not exist in Release builds (01 §2).
- The server refuses to run a recipe if the connected app's bundle is a Release build or the environment is not the sandbox (checked via a debug endpoint the app exposes under `APP_MAP_DEBUG`).
- `intent_critical` steps in guided mode are announced to the user by the LLM before execution when the recipe status is `candidate`; `verified`/`ci_gate` recipes run them without prompting, which is why promotion requires review (§7).

## 4. Threat model (what the map could be abused for)

| threat | control |
|---|---|
| Malicious PR adds a recipe that performs a money-moving action | sandbox-only execution; CODEOWNERS review on `app-map/**`; `intent_critical` steps highlighted in PR diff by a bot comment |
| Malicious YAML crafted to crash or exploit the server | strict JSON Schema validation before load; no shell, no eval, no file paths in recipes; steps are a closed enum |
| Silent mis-heal taps the wrong control | postcondition verification; `intent_critical` exact-label rule; heals visible in git; nightly PR never auto-merges |
| Hook script exfiltrates tool payloads | hooks live in `.claude/hooks/` only, reviewed like code; R3 fails on outside references; hooks talk only to the local socket/CLI |
| Compromised MCP package (`npx`) runs with developer privileges | app-map server vendored in-repo with lockfile; Argent pinned exactly, vendoring tracked (§5); dependency scanning in CI |
| Map leaks app structure externally | it describes UI structure only; treat the repo's existing access controls as sufficient; no hosted copy (00 D8) |
| Trajectory logs capture real user data on a developer machine | scrubber at ingest (nothing raw touches disk); fixture-only accounts; 14-day retention |

## 5. Supply chain

1. `tools/app-map-mcp/` uses `npm ci` from a committed lockfile; `npm audit --audit-level=high` and a dependency scanner run in R1. No runtime `npx`.
2. Argent is pinned to an exact version in `.mcp.json`. Its native `simulator-server`/`ax-service` binaries are proprietary; obtain security-review sign-off for that version, record it in `app-map/policy/mcp-allowlist.yaml`, and re-review on bump. Evaluate Apple's first-party Xcode MCP as an alternative driver on the same interface (03 §3 `APP_MAP_DRIVER`).
3. Maestro is installed from a pinned release in CI and checked at server start (03 §13).
4. Hook scripts and the server have no network egress except the local socket; R3 and code review enforce it.
5. Renovate/Dependabot may open bump PRs; they go through the same review.

## 6. Governance

- `app-map/policy/mcp-allowlist.yaml` lists every permitted MCP server (name, source, version, reviewer, date). R3 enforces it. If the org enables `allowManagedMcpServersOnly`, request that `app-map` (in-repo, stdio) and the pinned Argent version be added to the managed allowlist before rollout; an in-repo stdio server is the easiest case to approve.
- No hosted component exists in this design. If 08 §6 triggers a hosted store, it must go through the org's service review with OAuth 2.1, least-privilege scopes, audit logging, and egress controls before any data leaves laptops.

## 7. Review policy

- `CODEOWNERS`: `app-map/**`, `.mcp.json`, `.claude/**`, `tools/app-map-mcp/**` → the platform team.
- Promotion to `ci_gate` requires a reviewer who is not the author and a green R5 run.
- Every heal PR (06 R6) must be approved by a human; a bot comment lists `intent_critical` elements touched, if any.
- `ids.yaml` changes that mark an element `intent_critical: false` where it was `true` require two approvals.

## 8. Acceptance criteria

- [ ] Scrubber fixtures (email, phone, card-like number, amount in a cell, a fixture client name) all come out redacted or dropped; a unit test asserts no raw tree is ever written to disk.
- [ ] R3 fails a PR that adds an unlisted MCP server or an unpinned `npx`.
- [ ] The server refuses `run_recipe` against a Release build (integration test with the debug endpoint absent).
- [ ] CODEOWNERS entries exist and a heal PR cannot merge without approval (branch protection).
- [ ] Argent's pinned version is recorded in the allowlist with a reviewer and date.

## 9. Open questions

- Whether the org's policy permits proprietary binaries in developer tooling at all; if not, the driver becomes Apple's Xcode MCP or mobile-mcp from the start.
- Whether static-string matching (2.3.3) is too strict for screens with computed labels ("3 invoices"); allow a per-element `label_regex` in `ids.yaml` for such cases.
