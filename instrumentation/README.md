# Instrumenting the app for the app-map

Reference implementations of spec **01 — App Instrumentation** for iOS (`ios/AppMapKit`, a Swift
package) and Android (`android/appmap`, a Gradle library module). They give the map the signals it
relies on: stable ids, screen markers, test-only deep links, a router export and gates. Nothing here
changes production behaviour; every test-only surface is compiled out of Release builds.

> Neither package has been compiled in this repository (no Xcode / Android toolchain here). The code
> is small and idiomatic on purpose; expect to fix minor compiler complaints on first integration and
> keep the unit tests green (`swift test`, `swift test -c release`, `./gradlew :appmap:testDebugUnitTest
> :appmap:testReleaseUnitTest`).

## 1. Add the package / module

**iOS** — add `instrumentation/ios/AppMapKit` as a local Swift package dependency of the app target.
Define `APP_MAP_DEBUG` for the app's Debug configuration too (`OTHER_SWIFT_FLAGS = $(inherited) -D APP_MAP_DEBUG`),
so the app's own `#if APP_MAP_DEBUG` blocks line up with the package's (01 §2).

**Android** — in `settings.gradle.kts`:
```kotlin
include(":appmap")
project(":appmap").projectDir = file("../instrumentation/android/appmap") // adjust to your layout
```
and `implementation(project(":appmap"))` in the app module. The library's `debug` build type sets
`BuildConfig.APP_MAP_DEBUG = true`, `release` sets `false`; its `src/debug/AndroidManifest.xml` adds the
`appmap://` trampoline activity and the export receiver only to debug builds.

## 2. Generate and use the id constants (01 R1, R2, R8)

`app-map/ids.yaml` is the single registry. Generate the constants and commit them:

```sh
scripts/app-map/gen-ids            # writes AppMapID.swift and AppMapId.kt
scripts/app-map/gen-ids --check    # CI: fails with a diff when they are stale (06 R2)
```

Reference ids **only** through `AppMapID.Screen.invoiceList` / `AppMapId.Screen.INVOICE_LIST`,
`AppMapID.Element.invoiceAddButton` / `AppMapId.Element.INVOICE_ADD_BUTTON`, `AppMapID.Gate.*` and
`AppMapID.Gate.Dismiss.*`. Never write the string literal; `tools/app-map-mcp/bin/app-map lint-ids`
rejects literals, orphan constants and unreferenced screen markers in CI.

## 3. Mark screen roots (01 R3) and elements (01 R4)

```swift
// SwiftUI
NavigationStack { … }
    .appMapScreen(AppMapID.Screen.invoiceList)        // container + a 1pt marker element the driver can see (issue #15)
Button("New Invoice") { … }.appMapID(AppMapID.Element.invoiceAddButton)
// UIKit, in viewDidLoad
appMapScreen(AppMapID.Screen.invoiceList)
```
```kotlin
// Compose
Box(Modifier.appMapScreen(AppMapId.Screen.INVOICE_LIST)) { … }   // semantics { testTagsAsResourceId = true } + testTag
Button(onClick = …, modifier = Modifier.appMapId(AppMapId.Element.INVOICE_ADD_BUTTON)) { … }
// Views: android:id resource ids named after the registry id (dots → underscores)
```
A screen marker is **two** things, and both are load-bearing (issue #15). The screen root is an
accessibility *container* carrying `screen.<screen_id>` — VoiceOver groups by it, and readers that
list containers find the id there. Inside it, `appMapScreen` also pins a **1pt marker element**
carrying the same id: the iOS simulator's accessibility service renders a *flat* tree and does not
list containers at all, so a driver reading it (`argent run native-describe-screen --json`) sees
every element id and no `screen.<id>`. The marker element is what actually reaches the driver, and
`marker` is the only weight-1.0 identification signal there is (03 §5.2) — without it
identification falls back to the weaker `required_ids` / structural-hash cascade, which is
ambiguous between screens that share an element set.

The marker is 1 × 1 pt of clear colour with hit testing off, pinned to the root's top-leading
corner: it changes no layout, swallows no tap and announces nothing. It is deliberately **not**
`accessibilityHidden` / `accessibilityElementsHidden` — the driver reads the same accessibility
tree VoiceOver does, so hiding it from VoiceOver hides it from the driver. The accepted cost is one
extra unlabeled VoiceOver stop per screen. `overlay(alignment:)` needs iOS 15+/macOS 12+ (the
package targets iOS 16 / macOS 13). The UIKit call installs the equivalent 1pt
`AppMapScreenMarkerView` subview and is idempotent: calling it from both `viewDidLoad` and
`viewWillAppear` retargets the marker rather than stacking a second one.

Each full-screen state marks itself exactly once; sheets and modals carry their own. That is a rule
about what a screen publishes, not about what a capture contains — a pushed screen leaves the
covered screen's marker in the accessibility tree, so app-map prefers the **deepest** marker
(01 R3). Since every marker is now a 1pt box at its root's top-leading corner, two stacked screens
whose roots are both flush with the top (a `fullScreenCover`, a `TabView` swap) report markers with
an *identical* frame, so `tree.ts` never collapses two elements carrying different identifiers even
when the rest of their geometry, label and value match, and on an exact `y` tie the later element
in capture order — the screen just presented — wins.

Cells of one kind share an id (`invoice.list.cell`); containers with data-driven content are
`dynamic: true` in `ids.yaml` so the scrubber drops their text (07 §2.3).

**Do not give a SwiftUI `List`, `Section` or `ForEach` an id** (01 R4, issue #19). They are not
accessibility elements — the same reason the screen *container* alone was invisible above — so the
container never reaches the driver and an id registered for it is dead weight: it can never be
observed, never resolved, and a recipe step written against it can never run. `app-map validate`
warns about a registered `kind: list` element that no screen file has ever recorded, which is what
that mistake looks like from the map's side. `invoice.list.table` in the pilot is a UIKit/Compose
pattern (a `UITableView`/`LazyColumn` IS an element); on SwiftUI there is nothing to register.

Worse, `.appMapID` on a `Section` does not just fail to register the container — it **overwrites
the rows**. SwiftUI propagates `accessibilityIdentifier` from a container to each child, so every
row reports the section's id and the row id disappears from the tree:

```swift
Section("Characters (\(people.count))") {
    ForEach(people) { person in
        NavigationLink(value: person) { Text(person.name) }
            .appMapID(AppMapID.Element.filmDetailCharacterCell)    // the row id — put it HERE
    }
}
// .appMapID(AppMapID.Element.filmDetailCharactersList)            // ← never: it clobbers every row
```

To pick a row, a recipe names the ROW id and matches its label — `select {cell: film.detail.character.cell, match: {text: "{name}"}}` (04 §3.3) — which needs no container id at all.

## 4. Register routes for the router export (01 R6)

Register every screen once, at launch (iOS: `App.init` / `didFinishLaunching`; Android:
`Application.onCreate`, so a manifest receiver sees the registry even with no Activity running), then
honour the export request:

```swift
let registry = AppMapRouterRegistry.shared
registry.register(id: "invoice_list", route: "appmap://invoice_list", viewType: InvoiceListView.self,
                  title: "Invoices", staticEdges: [.tap(AppMapID.Element.invoiceAddButton, to: "invoice_new")])
registry.registerGate(id: AppMapID.Gate.pushPermission, dismiss: AppMapID.Gate.Dismiss.pushPermissionDeny)
registry.exportIfRequested()          // -AppMapExport <path> → writes router-export.json and exits; no-op in Release
```
```kotlin
AppMapRouterRegistry.gitSha = BuildConfig.GIT_SHA
AppMapRouterRegistry.register("invoice_list", "appmap://invoice_list", InvoiceListScreen::class.java,
    title = "Invoices", staticEdges = listOf(AppMapEdge.tap(AppMapId.Element.INVOICE_ADD_BUTTON, to = "invoice_new")))
AppMapRouterRegistry.registerGate(AppMapId.Gate.PUSH_PERMISSION, AppMapId.Gate.Dismiss.PUSH_PERMISSION_DENY)
```
Run the export:
```sh
# iOS — the app writes the file and exits
xcrun simctl launch booted com.example.app -AppMapExport /tmp/router-export.json
scripts/app-map/router-export.sh --platform ios --out /tmp/router-export.json        # same, with waiting/validation
# Android — the debug receiver writes the file and returns the path it used as result data
adb shell am broadcast -a com.example.app.APPMAP_EXPORT --es path /sdcard/router-export.json
scripts/app-map/router-export.sh --platform android --out /tmp/router-export.json
```
The JSON matches 01 R6 (`schema_version`, `app_id`, `platform`, `build{version,build_number,git_sha}`,
`screens[]`, `gates[]`) and validates against `app-map/schema/router-export.schema.json`; `app-map import-router`
seeds screens with `source: router_export`. `git_sha` must be 7–40 hex: `router-export.sh` passes the checkout's
sha (`SIMCTL_CHILD_APP_MAP_GIT_SHA` on iOS, `--es git_sha` on Android); for other launches set the Info.plist key
`AppMapGitSHA` on iOS and `AppMapRouterRegistry.gitSha = BuildConfig.GIT_SHA` on Android, otherwise the
placeholder `"0000000"` is written and a warning logged. It is a *string* of seven hex digits everywhere it
appears: in `manifest.yaml` write `git_sha: "0000000"` with the quotes, or YAML reads it as the number `0`.
The map still loads without them — the value is read back as the text you wrote — but `app-map export --check`
reports the file as non-canonical until the quotes are there; an unquoted `version: 1.0` behaves the same way
(issue #20). Add the quotes by hand: `app-map export` rewrites only the files the map itself changed, so it
leaves a merely non-canonical manifest alone.

## 5. Wire the deep link through the real router (01 R5)

The handler parses `appmap://<screen_id>[?fixture=name&k=v]` into a route; **your** router turns it
into genuine navigation state.

```swift
#if APP_MAP_DEBUG
let appMapLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
    AppRouter.shared.navigate(to: route.screenID, params: route.params)
}
#endif
// in the App / SceneDelegate URL entry point:
#if APP_MAP_DEBUG
if appMapLinks.handle(url) { return }
#endif
```
Register the `appmap` URL scheme in the Debug target's Info.plist only (`CFBundleURLTypes`).

```kotlin
// Application.onCreate, debug builds
if (BuildConfig.APP_MAP_DEBUG) {
    AppMapFixtureRegistry.install(DebugFixtures(this))
    AppMapDeepLink.installRouter { route ->
        startActivity(Intent(this, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            putExtra("app_map_route", route.screenId); putExtra("app_map_params", HashMap(route.params))
        })
    }
}
```
The debug-only `AppMapDeepLinkActivity` receives the intent, applies the fixture, calls your router and
finishes. Invoke:
```sh
xcrun simctl openurl booted "appmap://invoice_new?fixture=logged_in"
adb shell am start -a android.intent.action.VIEW -d "appmap://invoice_new?fixture=logged_in"
```
Every screen in `ids.yaml` should have a working deep link; screens without one are `deep_link: none`
in the map and cost navigation steps.

## 6. Define fixtures in a debug module (01 R5, §5)

Fixtures are code, not map data. Keep them in a debug-only module/target so Release binaries stay flat:

```swift
final class DebugFixtures: AppMapFixtures {
    let names = ["logged_in", "one_draft_invoice"]
    func apply(name: String) async throws {
        switch name {
        case "logged_in":         try await Session.shared.signIn(account: .sandboxFixture)
        case "one_draft_invoice": try await Session.shared.signIn(account: .sandboxFixture); try await Invoices.shared.seedDraft()
        default:                  throw AppMapFixtureError.unknown(name: name)
        }
    }
}
```
Fixture accounts are sandbox-only (07 §3, §4); their values are data and never end up in recipes.

## 7. Gates (01 R7)

Register each interrupter (permission prompts, paywalls, biometric prompts, rating prompts, "what's new"
sheets) in `ids.yaml` with a `dismiss` id, mark in-app gates with their marker, and register them in the
router registry. OS dialogs cannot carry your ids; the map stores their label signature (02 §4.2).

## 8. Debug probe for the server (07 §3)

iOS: call `AppMapDebugEndpoint.publish(sandbox: Environment.current == .sandbox)` at launch. It writes a
build/environment record to `UserDefaults` (no network listener). The server reads it first through
`cfprefsd`:

```sh
xcrun simctl spawn <udid|booted> defaults export com.example.app - | plutil -convert json -o - -
```

**On iOS 26 simulators that read comes back empty.** `defaults` no longer resolves a sandboxed app's
domain, so `defaults read com.example.app app_map_debug_probe` answers "does not exist" and
`defaults export` prints `{}` even for a Debug build that published the probe correctly. The server
therefore falls back to the same record in the app's own data container, which is also the command to
check by hand:

```sh
plutil -convert xml1 -o - \
  "$(xcrun simctl get_app_container <udid|booted> com.example.app data)/Library/Preferences/com.example.app.plist"
```

`plutil -p` on that file is fine for eyeballing, but **`plutil -convert json` and `plutil -extract … json`
are not**: they refuse the whole file ("invalid object in plist for destination format") as soon as the app
stores any `Data` in `UserDefaults` — one ordinary `JSONEncoder` blob is enough — which is why the server
reads `xml1`. The record is whatever `cfprefsd` has flushed, so publish at launch and do not expect a probe
taken in the same millisecond as the write. The `AppMapDebugEndpoint` type does not exist in Release, so the
key is never present there and the server refuses to run. Android: the export receiver exists only in debug
builds; a matching probe is a follow-up for the Android pilot.

## 9. Release proof (01 §4)

`swift test -c release` runs `AppMapReleaseGateTests`, which asserts via `NSClassFromString("AppMapDeepLinkHandler")`
that the handler class is absent when `APP_MAP_DEBUG` is off, and `AppMapRouterRegistryReleaseTests`,
which asserts `-AppMapExport` is inert. On Android, `testReleaseUnitTest` asserts `AppMapDeepLink.parse`
returns null and `exportJson` throws.

**These run in CI** — `.github/workflows/app-map.yml`, jobs `ios-instrumentation` and
`android-instrumentation`:

```sh
swift test --package-path instrumentation/ios/AppMapKit                      # Debug: surfaces present
swift test -c release --package-path instrumentation/ios/AppMapKit   -Xswiftc -enable-testing                                                   # Release: surfaces absent
./gradlew :appmap:testDebugUnitTest :appmap:testReleaseUnitTest
```

The iOS package is a standalone SwiftPM package, so its job runs on every PR with no app and no
simulator. The Android module is an AGP *library* included from the host app's Gradle build, which
supplies `settings.gradle.kts` and the wrapper — so its job is gated on `APP_MAP_HAS_APP` until that
app is in the repo. Wiring it up is a Stage 1 item; until then the Android release proof is unrun.

## 10. Local git hooks (01 R8 "lint-ids runs in CI **and pre-commit**")

Git never runs hooks from a path it has not been told about, so this is opt-in once per clone —
the same pattern as the 02 §9 merge driver in `.gitattributes`:

```sh
git config core.hooksPath scripts/app-map/githooks
```

`scripts/app-map/githooks/pre-commit` then runs `app-map lint-ids`, `app-map validate` and
`scripts/app-map/gen-ids --check` whenever a commit touches `app-map/`, `instrumentation/`, app
source or an MCP config, and refuses the commit on any error. Bypass one commit with
`APP_MAP_SKIP_PRECOMMIT=1 git commit` (or `git commit -n`). CI runs the same commands, so the hook
only moves the feedback earlier — it is never the only gate.

## Answered

- *Can a SwiftUI `List`/`Section` container carry an app-map id, so a recipe can `select` within
  it?* **No** (issue #19). The container is not an accessibility element, so no capture ever
  contains it and no `select {list, …}` written against it can resolve; five such ids were
  registered in the first real integration and deleted again unused. And an id applied to a
  `Section` propagates down and overwrites the row ids. Put ids on rows and select by row id plus
  match text (§3); `validate` now warns about a `kind: list` id no screen file has recorded.
- *Do SwiftUI containers with `.accessibilityElement(children: .contain)` reach the driver, and do
  they swallow child taps?* They do **not** swallow child taps — every element id is reported and
  tappable — but the container itself never reaches the driver (issue #15). The iOS simulator's
  accessibility service renders a flat tree in which containers are not elements at all, so the
  container form alone is never listed and `screen.<id>` was simply missing. `appMapScreen` now
  pins a 1pt marker element inside the container (§3); the container modifier stays for VoiceOver
  grouping and for readers that do list containers.

## Open questions (01 §5)

- Verify that Argent surfaces Compose `testTag` values as resource ids when `testTagsAsResourceId` is
  set; if not, fall back to Views ids for the pilot. Compose produces a resource-id on a semantics
  node rather than a container, so the iOS container problem above does not obviously apply — but
  nobody has checked it against a real Argent Android capture.
- Decide whether fixtures live in the app target or a debug-only module; prefer a debug module to keep
  production binary size flat.
