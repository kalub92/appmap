# Verify and report — commands, failure routing, bounds, exit criteria, report (01 R8, 06 R2)

The skill runs §1 from the repo root after every dispatch round and once at the end. A specialist's lint is a
self-check filtered to its own files; the run here is the authoritative one, and it is what the exit criteria read.

## 1. Commands

```sh
scripts/app-map/gen-ids --check                      # --platforms ios only when app.layout.kotlin_present is false
tools/app-map-mcp/bin/app-map lint-ids --platform ios --src <src_root…> --instrumented ios --json
tools/app-map-mcp/bin/app-map validate
tools/app-map-mcp/bin/app-map export --check
```

`--src` extends the default scan roots (`instrumentation/ios` and `ios` under the repo root); the report names every
root scanned. `--instrumented ios` makes a source tree that references NO marker at all fail per screen, instead of raising the single "not instrumented yet" warning; a tree that references some already errors per missing screen. It is a
warning. `--json` prints `{ ok, issues: [{ rule, severity, message, platform?, file?, line? }] }`; `file` is
repo-relative, and only `severity: error` counts against the exit criteria.

### Compiler substitute

No Swift toolchain runs here, so three checks stand in for the compiler on every batch. All three pass before
`xcodebuild` is tried, and the report says which of them ran.

1. Every `AppMapID` constant the app references exists in the generated file (a typo or an unregenerated constant is a
   compile error on a Mac and invisible to lint, which sees only literals):

```sh
node -e '
const fs = require("fs");
const gen = fs.readFileSync(process.argv[1], "utf8"); const stack = []; const have = new Set();
for (const line of gen.split("\n")) {
  const en = /\benum\s+(\w+)\s*\{/.exec(line); if (en) { stack.push(en[1]); continue; }
  const st = /\bstatic\s+let\s+`?(\w+)`?/.exec(line); if (st) have.add([...stack.slice(1), st[1]].join("."));
  if (/^\s*\}\s*$/.test(line)) stack.pop();
}
let missing = 0;
for (const file of process.argv.slice(2)) {
  const src = fs.readFileSync(file, "utf8").replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\/[^\n]*/g, "");
  for (const m of src.matchAll(/\bAppMapID\.((?:Screen|Element|Gate\.Dismiss|Gate\.Control|Gate)\.[A-Za-z_]\w*)/g)) {
    if (!have.has(m[1])) { missing++; console.log(`${file}: AppMapID.${m[1]} is not generated`); }
  }
}
process.exit(missing ? 1 : 0);
' instrumentation/ios/AppMapKit/Sources/AppMapKit/AppMapID.swift \
  $(find <src_root…> -name '*.swift' -not -path '*/.build/*' -not -path '*/DerivedData/*' -not -path '*/Pods/*')
```

2. Every `#if` is balanced (an unbalanced block is a compile error and hides everything after it from lint's comment
   blanking):

```sh
for f in $(find <src_root…> -name '*.swift' -not -path '*/.build/*' -not -path '*/DerivedData/*' -not -path '*/Pods/*'); do
  awk '/^[[:space:]]*#if[[:space:]]/ { d++ } /^[[:space:]]*#endif/ { d-- }
       END { if (d != 0) { print FILENAME ": unbalanced #if (" d ")"; exit 1 } }' "$f" || exit 1
done
```

3. No debug-only symbol outside an `#if APP_MAP_DEBUG` region (01 R5, 01 §2 — the type does not exist in Release,
   so a reference outside the region is a Release compile error):

```sh
for f in $(find <src_root…> -name '*.swift' -not -path '*/.build/*' -not -path '*/DerivedData/*' -not -path '*/Pods/*'); do
  awk '{ sub(/^[[:space:]]*\/\/.*$/, ""); sub(/[[:space:]]\/\/.*$/, "") }   # a comment, never the // of a URL
       /^[[:space:]]*#if[[:space:]]/     { s[++d] = ($0 ~ /APP_MAP_DEBUG/ && $0 !~ /!APP_MAP_DEBUG/) ? 1 : 0; next }
       /^[[:space:]]*#elseif[[:space:]]/ { s[d]   = ($0 ~ /APP_MAP_DEBUG/ && $0 !~ /!APP_MAP_DEBUG/) ? 1 : 0; next }
       /^[[:space:]]*#else/              { s[d] = 0; next }
       /^[[:space:]]*#endif/             { d--; next }
       /AppMapDeepLinkHandler|AppMapDeepLink\.|AppMapFixtures|AppMapFixtureError|AppMapDebugEndpoint|AppMapRoute([^A-Za-z0-9_]|$)/ {
         on = 0; for (i = 1; i <= d; i++) if (s[i]) on = 1
         if (!on) { print FILENAME ":" FNR ": debug symbol outside #if APP_MAP_DEBUG"; bad = 1 }
       }
       END { exit bad }' "$f" || exit 1
done
```

The walker in `tools/app-map-mcp/src/test/instrument-agents.test.ts` is the reference for check 3 (it also handles
`#if !APP_MAP_DEBUG … #else`); the awk covers the plain `#if APP_MAP_DEBUG … #endif` form the shapes use, and its
`AppMapRoute` alternative is bounded so `AppMapRouterRegistry` — correctly outside the region — never trips it.

### With Xcode (`app.xcode: true`)

```sh
xcodebuild build -scheme <scheme> -configuration Debug -destination 'generic/platform=iOS Simulator' -quiet
```

and, with a booted simulator:

```sh
xcrun simctl launch booted <bundle_id> -AppMapExport /tmp/router-export.json   # the app writes the export and exits (01 R6)
tools/app-map-mcp/bin/app-map validate --router /tmp/router-export.json         # against app-map/schema/router-export.schema.json
xcrun simctl openurl booted "appmap://<id>"                                       # one screen whose deep_link is not none
```

then poll for `screen.<id>` for up to 10 s — `mcp__argent__native-describe-screen` or `await-ui-element` when the
session has Argent, otherwise a human step under "commands to run on a Mac" — never assuming the screen is up when
`openurl` returns: `handle` returns before the fixture and the route run (`reference/debug-wiring.md`, last section).
`scripts/app-map/router-export.sh --platform ios --out <path>` does the launch, the wait and the `schema_version`
check in one step. Without Xcode the report states: "not compiled; constant-existence, `#if` balance and lint passed".

## 2. Failure routing

| Issue | Route |
|---|---|
| `string_literal_id` | owning specialist with file:line (a pre-existing literal → `rename_candidates`, not an edit) |
| `marker_unreferenced` | screen added this run: specialist places the marker or the skill removes the entry it added; pre-existing (pilot/retired) screen: `retire` decision, never removed |
| `orphan_constant` / `generated_out_of_sync` | skill reruns `gen-ids` (a generated constant with no registry entry; never a specialist action) |
| `bad_id` | skill: id-rules bug, fix the registry **before** any source references it |
| `validate` rule failure | skill (title mismatch → drop the proposed `title`; kind-list warning is expected pre-capture) |
| `blocked` items | report, with the note |
| compiler-substitute check 1 | skill: the constant was never generated (registry entry missing or `gen-ids` not rerun) — fix the registry, regenerate, re-fill `constant`, re-dispatch that file; never a hand-typed name |
| compiler-substitute check 2 or 3 | owning specialist with file:line: the wiring block is malformed or a debug symbol escaped its region |
| `xcodebuild` error | owning specialist with the first diagnostic's file:line; an error in a file no batch touched is reported, never chased |

A batch re-dispatch carries only the issues in its own files, the same slice and the same constants; no round adds
ids, so every round either shrinks the issue set or ends in `blocked`.

## 3. Bounds

3 rounds per batch, 2 full rounds (unplanned findings), then stop and report residuals. Each round only shrinks the
issue set a specialist may touch and never adds ids, so the loop converges.

## 4. Exit criteria (all required)

- `gen-ids --check` clean;
- `lint-ids --instrumented ios` has zero errors except `marker_unreferenced` for screens listed under `retire` decisions;
- `validate` has no errors;
- `export --check` clean;
- every plan item is `done`, `skipped`, `blocked` or `verify_on_device` with a note;
- the report is written.

## 5. Idempotency acceptance

A second run's survey reports every item `already_marked`/`already_wired`, the registry diff is empty, `gen-ids --check`
is untouched, and the report says "no changes". The fixture sets are the standing proof that the checks themselves are
stable: `instrument-agents.test.ts` lints each set twice and requires identical issue lists.

## 6. Human-decision report (chat + `app-map/.local/instrument/report.md`)

```
# app-map instrumentation report — <app module> — <date>
Summary: N screens (A new, R reused, T retire?), E elements, G gates; files edited (git diff --stat); compile: yes|no.
D0  Build flags: -D APP_MAP_DEBUG missing in <modules>            → add to Debug OTHER_SWIFT_FLAGS
D1  intent_critical proposals: <id> (<reason>) …                    → confirm each
D2  Gate controls and their intent_critical: <gate>: <control>=<bool> … (native gates need a label signature recorded by a later name_screen/mark session; this run never edits app-map/ios/screens)
D3  Screens with deep_link: none and why
D4  Fixtures needed: <name> for <screens> (stub at <path>, TODO bodies)
D5  rename_candidates (XCUITest impact): <literal> → <id>           → yes runs migrate-id
D6  retire (pilot/registry entries the app lacks)                    → remove entry + screen file, or keep
D7  Project steps: add files to target (classic pbxproj) / CFBundleURLTypes fragment / scheme in three places
D8  Sandbox source for AppMapDebugEndpoint.publish (env/plist default or app expression)
D9  Risks: subviews_indexing, root_is_a11y_element, a11y_hazards, double_marked, objc_file, ib_identifier/ib_outlet_missing, multi_module
D10 verify_on_device: nav.*.tab ids (fallback role_label locator; ids.yaml unchanged if it fails)
Residual lint issues; blocked items; commands to run on a Mac.
```

The report carries ids, paths, decision kinds and counts only — never label text, fixture values, account names or
anything else 07 §2 keeps out of git (rule 8). "Files edited" is the `git diff --stat` the specialists returned plus the
skill's own `ids.yaml`/`manifest.yaml` lines; the scanned roots and whether a compile ran are stated in the summary line.
