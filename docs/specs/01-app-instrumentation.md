# 01 — App Instrumentation

Status: draft v0.1 · Depends on: — · Consumed by: 02, 03, 04, 06

## 1. Purpose

Make the app legible to the app-map with signals you control. This is the highest-leverage spec: stable ids collapse locator brittleness, screen markers collapse screen identification to one lookup, deep links collapse navigation to one action, and the router export seeds the map without spending exploration tokens.

## 2. Scope

iOS (SwiftUI + UIKit) and Android (Compose + Views). Shared id registry. Debug-only surfaces are gated by a compile-time flag `APP_MAP_DEBUG` (iOS: `#if APP_MAP_DEBUG` via `-D APP_MAP_DEBUG` in Debug configs; Android: `BuildConfig.APP_MAP_DEBUG`).

Out of scope: any change to production behavior. Accessibility identifiers ship in all builds; they are invisible to users and standard for XCUITest. Deep links and export ship only in debug builds.

## 3. Requirements

### R1 — Shared id registry

- `app-map/ids.yaml` is the single source of every screen id, element id, and gate id.
- `scripts/app-map/gen-ids` generates `AppMapID.swift` (enum with static strings) and `AppMapId.kt` (object with const vals). Generated files are committed; CI fails if they are out of sync (06 R2).
- App code MUST reference ids through the generated constants, never string literals.

```yaml
# app-map/ids.yaml
schema_version: 1
screens:
  - id: login
  - id: invoice_list
  - id: invoice_new
  - id: invoice_detail
  - id: client_picker
gates:
  - id: gate.push_permission
    dismiss: gate.push_permission.deny
  - id: gate.biometric_prompt
    dismiss: gate.biometric_prompt.cancel
elements:
  - id: invoice.add.button
    kind: button
    intent_critical: false
  - id: invoice.list.table
    kind: list
    dynamic: true
  - id: invoice.list.cell
    kind: cell
    dynamic: true
  - id: invoice.amount.field
    kind: field
  - id: invoice.client.picker
    kind: picker
  - id: invoice.save.button
    kind: button
    intent_critical: true
```

### R2 — Naming rules

- Regex: `^[a-z0-9]+(\.[a-z0-9_]+)+$`.
- Screens: `snake_case` noun phrase (`invoice_list`). Screen markers: `screen.<screen_id>`.
- Elements: `<feature>.<name>.<kind>`; `kind ∈ {button, field, list, cell, toggle, tab, picker, link, text, sheet}`.
- Gates: `gate.<name>`; their dismiss control: `gate.<name>.<verb>`.
- Ids MUST NOT contain copy text or localized strings. `invoice.save.button`, not `save_invoice_button_en`.
- Ids are never renamed casually; a rename is a map migration (02 §8).

### R3 — Screen markers

Every screen's root container carries `screen.<screen_id>` and is exposed in the accessibility tree.

SwiftUI:
```swift
struct InvoiceListView: View {
  var body: some View {
    NavigationStack { /* … */ }
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier(AppMapID.Screen.invoiceList)   // "screen.invoice_list"
  }
}
```
UIKit: `view.accessibilityIdentifier = AppMapID.Screen.invoiceList` in `viewDidLoad`.

Compose:
```kotlin
Box(Modifier
  .semantics { testTagsAsResourceId = true }   // exposes testTags as resource-id to UIAutomator/Maestro/Argent
  .testTag(AppMapId.Screen.INVOICE_LIST)) { /* … */ }
```
Views: `android:id` or `view.tag` plus contentDescription is not the mechanism — use resource ids.

Only one marker may be visible at a time for a full-screen state; sheets and modals carry their own marker (`screen.invoice_filter_sheet`). Tooling must not *rely* on that: on iOS a pushed screen leaves the covered screen's marker in the accessibility tree, so two markers are routinely present. Readers therefore **prefer the deepest marker** — deepest in the node hierarchy, ties broken by the greatest `y` (a flat driver capture has no hierarchy to compare) and then by document order — rather than giving up when there is more than one.

### R4 — Element identifiers

- Every interactive element (button, field, toggle, tab, picker, link, cell) and every form label carries an id from the registry.
- List cells of the same kind share one id (`invoice.list.cell`); index disambiguates at runtime.
- Containers whose content is data-driven are declared `dynamic: true` in the registry. The scrubber (07) drops their text; the signature (02) excludes them.

### R5 — Test-only deep links

- Scheme `appmap://<screen_id>[?k=v…]`, handled only under `APP_MAP_DEBUG`.
- The handler MUST route through the app's real router so the resulting state is genuine, not a bare view.
- Optional `fixture=<name>` seeds state (e.g. a logged-in test account, one draft invoice). Fixtures are defined in code, not in the map.
- Every screen in `ids.yaml` SHOULD have a working deep link. Screens without one are marked `deep_link: none` in the map and cost navigation steps.

Invocation:
```
xcrun simctl openurl booted "appmap://invoice_new?fixture=logged_in"
adb shell am start -a android.intent.action.VIEW -d "appmap://invoice_new?fixture=logged_in"
```

### R6 — Router export

A debug-only runtime registry dumps the navigation graph as JSON. Static analysis of SwiftUI navigation is unreliable; an explicit registry is not.

- Each screen registers `(id, route, viewType, staticEdges[])` at module load or first appearance.
- iOS: launch argument `-AppMapExport <path>` writes `router-export.json` and exits. Android: instrumentation runner or `adb shell am broadcast -a com.example.app.APPMAP_EXPORT`.
- CI runs the export on every build (06 R4); `app-map import-router` seeds or refreshes screens with `source: router_export`.

```json
{
  "schema_version": 1,
  "app_id": "com.example.app",
  "platform": "ios",
  "build": {"version": "2026.9.1", "build_number": "4412", "git_sha": "a1b2c3d"},
  "screens": [
    {"id": "invoice_list", "route": "appmap://invoice_list", "view_type": "InvoiceListView",
     "edges": [{"action": {"type": "tap", "element": "invoice.add.button"}, "to": "invoice_new"}]}
  ],
  "gates": [{"id": "gate.push_permission", "dismiss": "gate.push_permission.deny"}]
}
```

### R7 — Gates

Register every interrupter the agent may meet: OS permission prompts, paywalls, biometric prompts, rating prompts, "what's new" sheets, toasts that block taps. Each has a marker (or, for OS dialogs, a recognizable label pattern recorded in the map) and a dismiss action. OS-level dialogs cannot carry your ids; record their signature in the map instead (02 §4.2).

### R8 — Lint

`tools/app-map-mcp/bin/app-map lint-ids` runs in CI and pre-commit:

- every screen in `ids.yaml` has its marker constant referenced in iOS and Android source;
- every id matches R2; no orphan constants; no string-literal ids in UI code;
- generated constants match `ids.yaml`.

## 4. Acceptance criteria

- [ ] `ids.yaml` exists with every screen on the pilot flow (login → invoice_list → invoice_new → invoice_detail) on both platforms.
- [ ] `argent` (or `maestro hierarchy`) shows `screen.<id>` on the root of each pilot screen and the registered element ids on every interactive element.
- [ ] `appmap://invoice_new?fixture=logged_in` lands on the real screen with real state on simulator and emulator.
- [ ] `-AppMapExport` produces `router-export.json` that validates against `app-map/schema/router-export.schema.json`.
- [ ] `app-map lint-ids` passes in CI.
- [ ] Release builds contain no `appmap://` handler and no export path (verified by a unit test that asserts the handler is absent when the flag is off).

## 5. Open questions

- Verify that Argent surfaces Compose `testTag` values as resource ids when `testTagsAsResourceId` is set; if not, fall back to Views ids for the pilot.
- Confirm whether SwiftUI containers with `.accessibilityElement(children: .contain)` remain hittable for Argent's tap and don't swallow child taps.
- Decide whether fixtures live in the app target or a debug-only module; prefer a debug module to keep production binary size flat.
