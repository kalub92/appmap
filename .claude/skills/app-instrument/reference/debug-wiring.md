# Debug wiring — registration, deep links, fixtures, probe, scheme (01 R5, 01 R6, 07 §3)

Shapes for the `role: wiring` items of a plan (`wiring.kind`: `registry`, `handler`, `router_mapping`, `fixtures`,
`endpoint`, `scheme`). They travel in the batch that holds `app.entry_point.file`, and the specialist that owns that
file applies them: `app-instrument-swiftui` for `app.lifecycle: swiftui_app`, `app-instrument-uikit` for `uikit_scene`
and `uikit_appdelegate`. `app.wiring_placement: new_files` means `AppMapWiring.swift`, `DebugFixtures.swift` and the
router mapping are written at exactly the paths in each item's `wiring.new_files[]`; `inline` means the same
declarations go into the file the anchor names (a classic pbxproj compiles only files in its Sources phase, and nobody
edits pbxproj). The fixture sets under `tools/app-map-mcp/fixtures/instrument/ios/` are the canonical copies of every
shape here. Only pilot ids appear; `<…>` is a placeholder the plan fills, never a name to derive.

## Six facts that decide every wiring edit

1. `register`, `registerGate` and `exportIfRequested` compile to no-ops in Release, so they sit outside
   `#if APP_MAP_DEBUG`. Everything else on this page — `AppMapDeepLinkHandler`, `AppMapDeepLink.scheme`,
   `AppMapFixtures`, the router mapping, `AppMapDebugEndpoint` — does not exist in Release and lives only under
   `#if APP_MAP_DEBUG` (01 §2, 01 R5).
2. `id:`, `route:` and `to:` take **bare** screen ids: `"invoice_list"`, `"appmap://invoice_list"`, `"none"`. They are
   legal literals — lint registers the marker `screen.<id>`, and the bare id is not it — and they are the ids the export
   and the map compare. Never write `"screen.<id>"` there. Gate ids and their dismiss ids are constants
   (`AppMapID.Gate.<name>`, `AppMapID.Gate.Dismiss.<name>`) because those literals are registered (01 R8).
3. `AppMapRoute.screenID` is the URL host, the bare id. The router mapping switches on `"invoice_list"` and never on
   `AppMapID.Screen.invoiceList`, whose value is the marker and matches nothing (design §10.1).
4. `exportIfRequested()` writes the export and exits the process on a `-AppMapExport <path>` launch. It therefore runs
   after every `register` call and before any UI is built, and nothing placed after it runs on an export launch —
   including `AppMapDebugEndpoint.publish()`, which comes after it on purpose (07 §3).
5. `publish()` takes no argument unless the app has its own environment type; then `publish(sandbox: <expr>)` with the
   app's expression, and the source is decision D8. Bare `publish()` reads the `APP_MAP_SANDBOX` environment variable,
   then the Info.plist key `AppMapEnvironment` (`sandbox`). Never write `Environment.current`: it shadows SwiftUI's
   `Environment` and does not compile in a SwiftUI file.
6. `handle(_:)` returns `true` synchronously when the URL is an app-map link and applies the fixture and routes later,
   on the main actor; `false` means "not ours" and the caller falls through to its production URL handling, unchanged.

## `AppMapWiring.registerAll()` — `kind: registry` and `kind: endpoint`

One call site, run once at launch before the window exists (`App.init`, or `application(_:didFinishLaunchingWithOptions:)`).
`viewType:` is the marker owner (`InvoiceListViewController.self` in a UIKit app); `title:` is the static nav title, the
same string as the registry's `title`; `route:` is `appmap://<id>` or `"none"` exactly as `ids.yaml` says; `staticEdges`
name the element constant and the bare destination id.

```swift
import AppMapKit

enum AppMapWiring {
    static func registerAll() {
        let registry = AppMapRouterRegistry.shared
        registry.register(id: "login", route: "appmap://login", viewType: LoginView.self, title: "Sign In",
                          staticEdges: [.tap(AppMapID.Element.loginSubmitButton, to: "invoice_list")])
        registry.register(id: "invoice_list", route: "appmap://invoice_list", viewType: InvoiceListView.self,
                          title: "Invoices", staticEdges: [.tap(AppMapID.Element.invoiceAddButton, to: "invoice_new")])
        registry.register(id: "invoice_new", route: "appmap://invoice_new", viewType: InvoiceNewView.self,
                          title: "New Invoice", staticEdges: [.tap(AppMapID.Element.invoiceClientPicker, to: "client_picker")])
        registry.register(id: "invoice_detail", route: "appmap://invoice_detail", viewType: InvoiceDetailView.self, title: "Invoice")
        registry.register(id: "client_picker", route: "none", viewType: ClientPickerView.self, title: "Choose Client")
        registry.registerGate(id: AppMapID.Gate.pushPermission, dismiss: AppMapID.Gate.Dismiss.pushPermissionDeny)
        registry.registerGate(id: AppMapID.Gate.biometricPrompt, dismiss: AppMapID.Gate.Dismiss.biometricPromptCancel)
        registry.exportIfRequested()                     // exits the process on -AppMapExport launches (01 R6)
        #if APP_MAP_DEBUG
        AppMapDebugEndpoint.publish()                    // after export; sandbox from APP_MAP_SANDBOX / Info.plist AppMapEnvironment (07 §3)
        #endif
    }
}
```

An `already_wired: true` item (`app.wiring_existing.registry` or `.endpoint`) is skipped: never a second registry call
site, never a second `publish()` (rule 12). A screen the router cannot reach registers `route: "none"` and stays
`deep_link: none` in the registry, with a `no_deep_link` decision.

## Lifecycle shapes — `kind: handler`

The handler is one `AppMapDeepLinkHandler`, created once, kept for the app's lifetime, called from every URL entry
point the lifecycle has, and always followed by the app's own handling when it returns `false`. The property is named
`debugLinks` (app-side names never start with `AppMap`/`appMap`). Never a second handler, never a second `.onOpenURL`
(rule 12).

### `swiftui_app`

The `App` creates the router in `init`, hands the same instance to `@StateObject` through its backing storage and
captures it in the handler closure, so the deep link drives the router the view tree observes:

```swift
import SwiftUI
import AppMapKit

@main
struct InvoicesApp: App {
    @StateObject private var router: AppRouter
    #if APP_MAP_DEBUG
    private let debugLinks: AppMapDeepLinkHandler
    #endif

    init() {
        let router = AppRouter()
        _router = StateObject(wrappedValue: router)          // one instance: the handler and the views share it
        AppMapWiring.registerAll()                           // outside #if: no-op registration in Release; export exits here
        #if APP_MAP_DEBUG
        debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
            router.open(screenID: route.screenID, params: route.params)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(router)
                .onOpenURL { url in
                    #if APP_MAP_DEBUG
                    if debugLinks.handle(url) { return }     // an app-map link: handled; anything else falls through
                    #endif
                    router.handle(url)                       // the app's existing URL handling, unchanged
                }
        }
    }
}
```

When the app already exposes its router as `static let shared`, the closure calls `AppRouter.shared.open(...)` and
`init` captures nothing; never introduce a singleton, a new `init` or a `@StateObject` into an app that has none
(rule 3) — then the handler is a `private let` created in the existing `init`, or a `private static let` when there
is no `init` to extend. An app with no `.onOpenURL` gets one whose body is only the `#if` block.

### `uikit_scene`

Registration in the `AppDelegate`; the handler in the `SceneDelegate`, which sees a cold-start URL in
`connectionOptions.urlContexts` (after the window is key, so the router has a root to drive) and a warm one in
`scene(_:openURLContexts:)`:

```swift
import UIKit
import AppMapKit

final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppMapWiring.registerAll()                           // first statement: an -AppMapExport launch exits inside it
        return true
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    #if APP_MAP_DEBUG
    private lazy var debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
        AppRouter.shared.open(screenID: route.screenID, params: route.params)
    }
    #endif

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = AppRouter.shared.rootViewController   // the app's existing root setup, unchanged
        self.window = window
        window.makeKeyAndVisible()
        #if APP_MAP_DEBUG
        if connectionOptions.urlContexts.contains(where: { debugLinks.handle($0.url) }) { return }   // cold start
        #endif
        for context in connectionOptions.urlContexts { AppRouter.shared.handle(context.url) }        // existing handling, unchanged
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        #if APP_MAP_DEBUG
        if URLContexts.contains(where: { debugLinks.handle($0.url) }) { return }                     // warm
        #endif
        for context in URLContexts { AppRouter.shared.handle(context.url) }                          // existing handling, unchanged
    }
}
```

### `uikit_appdelegate`

No scenes: the same `AppDelegate` owns the window, the handler and both URL entry points. iOS calls
`application(_:open:options:)` after `didFinishLaunchingWithOptions` returns `true` for a cold start by URL as well
as for a warm open, so `handle` is called there once; `launchOptions?[.url]` is consulted only when the app's own
`didFinishLaunchingWithOptions` already consumes the launch URL itself (it then routes there, before that code,
with the same fall-through) — never in both places, or the fixture applies twice.

```swift
import UIKit
import AppMapKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    #if APP_MAP_DEBUG
    private lazy var debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
        AppRouter.shared.open(screenID: route.screenID, params: route.params)
    }
    #endif

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppMapWiring.registerAll()                           // first statement: an -AppMapExport launch exits inside it
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = AppRouter.shared.rootViewController   // the app's existing root setup, unchanged
        self.window = window
        window.makeKeyAndVisible()
        return true                                          // true: iOS delivers a launch URL to open:options: below
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        #if APP_MAP_DEBUG
        if debugLinks.handle(url) { return true }            // cold start by URL and warm open both arrive here
        #endif
        return AppRouter.shared.handle(url)                  // the app's existing URL handling, unchanged
    }
}
```

## Router mapping — `kind: router_mapping`

A `#if APP_MAP_DEBUG` extension on the app's real router, keyed on **bare** ids, reaching each screen only through
state and methods the router already has; the screen that appears is genuine, never `present(SomeVC())` with empty
state (01 R5). It is written to the path in the item's `wiring.new_files[]` (`AppRouter+AppMap.swift` in the fixtures)
or, inline, after the router type's closing brace at the anchor. A screen the mapping cannot reach is `deep_link: none`
plus a `no_deep_link` decision — the pilot's `client_picker` needs `invoice_new`'s state and stays in `default`.

```swift
import SwiftUI

#if APP_MAP_DEBUG
extension AppRouter {
    @MainActor func open(screenID: String, params: [String: String]) {
        switch screenID {
        case "login":          signOut()                                   // the existing sign-out path shows the login root
        case "invoice_list":   path = NavigationPath()
        case "invoice_new":    path = NavigationPath(); path.append(Route.invoiceNew)
        case "invoice_detail": guard let id = params["invoice_id"] else { return }
                               path = NavigationPath(); path.append(Route.invoiceDetail(id))
        default: break         // client_picker: deep_link none (needs invoice_new's state)
        }
    }
}
#endif
```

A coordinator-style router (UIKit) maps the same cases onto its existing methods (`showInvoices()`,
`showInvoice(id:)`); a `params` key the screen needs comes from `deep_link_needs.params[]`, and a missing one returns
without routing. An app with no router at all gets a minimal extension on whatever object owns navigation, with the
same rules; if nothing owns it, every screen is `deep_link: none` and the decision says so.

## `DebugFixtures` — `kind: fixtures`

`names` lists every `fixtures_needed[].name` from the plan; `apply` switches on the name. Each known name has its own
`case` whose body is the plan's `hint` as a `// TODO(app-map fixture): …` comment followed by `throw FixtureTodo(name: name)`;
only `default` throws `AppMapFixtureError.unknown(name: name)`, so the protocol contract holds (unknown names are
`.unknown`) and no sandbox credential or value is ever invented (rule 8, 07 §3). A named-but-unwritten fixture makes
the handler log `[app-map] error: fixture '…' failed` and not route — visible, never wrong state.

```swift
import AppMapKit

#if APP_MAP_DEBUG
/// Seeds genuine sandbox state before a debug deep link routes (01 R5, 07 §3). Bodies stay TODO until a human writes them.
final class DebugFixtures: AppMapFixtures {
    let names = ["logged_in", "one_draft_invoice"]           // every fixtures_needed[].name

    func apply(name: String) async throws {
        switch name {
        case "logged_in":
            // TODO(app-map fixture): Session.signIn(sandboxAccount)
            throw FixtureTodo(name: name)
        case "one_draft_invoice":
            // TODO(app-map fixture): logged_in, then Invoices.seedDraft()
            throw FixtureTodo(name: name)
        default:
            throw AppMapFixtureError.unknown(name: name)      // the contract: names not in `names` are .unknown
        }
    }
}

/// A fixture the plan named whose seeding is not written yet.
private struct FixtureTodo: Error { let name: String }
#endif
```

## Scheme — `kind: scheme`; three places move together (issue #25)

Only the preflight scheme decision (a second `appmap` scheme in the workspace, and the human's suffix) produces a
`scheme` item. The default is `appmap` and nothing is written. When a suffix is chosen, all three change in one run:

| Place | Who | What |
|---|---|---|
| `app-map/ios/manifest.yaml` | the skill (registry step) | `deep_link_scheme: appmap-<suffix>` — that key only; `build.*` fields stay quoted strings (issue #20); `validate` warns on a non-default scheme, which is expected |
| the lifecycle file | the specialist | `AppMapDeepLink.scheme = "appmap-<suffix>"` inside `#if APP_MAP_DEBUG`, once, before the handler is created — the parser answers only this scheme from then on |
| the Debug configuration's Info.plist | the human (D7) | the `CFBundleURLTypes` fragment below, Debug only: Release registers no scheme (01 §2) |

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>$(PRODUCT_BUNDLE_IDENTIFIER).app-map</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>appmap-<suffix></string>
    </array>
  </dict>
</array>
```

With the default scheme the same fragment carries `<string>appmap</string>` and is still a human step: the agents
never edit `Info.plist`, and a configurable parser behind a hard-coded URL type means the app never receives the link
at all, which is worse than the collision (01 R5). The map itself stays `appmap://` everywhere; the server rewrites on
the way to the device.

## `-D APP_MAP_DEBUG` per module (decision D0)

Every module that holds wiring, fixtures or the router mapping — the app target, a debug-only fixtures module, a
feature package that owns the router — needs the flag in its Debug configuration, or its `#if APP_MAP_DEBUG` blocks
compile to nothing, the handler class never exists and the link is silently ignored:

- Xcode target: `OTHER_SWIFT_FLAGS = $(inherited) -D APP_MAP_DEBUG` (or `SWIFT_ACTIVE_COMPILATION_CONDITIONS = $(inherited) APP_MAP_DEBUG`) in Debug only;
- SwiftPM module: `swiftSettings: [.define("APP_MAP_DEBUG", .when(configuration: .debug))]`.

The preflight greps for it per module and records `app.flags`; a missing flag is D0 in the report and is never
edited by an agent (`.pbxproj` and `.xcconfig` are off limits, rule 7).

## Preflight facts the skill records (`app.src_roots`, `app.layout`, `app.project_style`, `app.wiring_placement`, `app.flags`, `app.scheme`, `app.xcode`)

| Fact | How | Value |
|---|---|---|
| `src_roots` | user-given, else `find . -name '*.xcodeproj' -o -name 'Package.swift' -o -name 'project.yml'` (their directories) | `app.src_roots[]` |
| `layout` | `repo_root`; `app_src_dirs[]`; `generated_swift` = `instrumentation/ios/AppMapKit/Sources/AppMapKit/AppMapID.swift` unless `gen-ids --out-ios` differs; `kotlin_present` = `instrumentation/android/appmap/src/main/kotlin/com/example/appmap/AppMapId.kt` exists (then `gen-ids` runs for both platforms); `default_scan_dirs` = `instrumentation/ios`, `ios` (`lint-ids --src` extends them, never replaces them) | `app.layout` |
| `project_style` | `PBXFileSystemSynchronizedRootGroup` in `project.pbxproj` → `synchronized`; `project.yml`, `Project.swift` or a SwiftPM app → `generated`; else `classic` | decides placement |
| `wiring_placement` | `synchronized`/`generated` → `new_files`; `classic` → `inline` (a new file outside the Sources phase never compiles; adding it is D7 `pbxproj_add_files`) | `new_files` / `inline` |
| `flags` | grep `OTHER_SWIFT_FLAGS` / `SWIFT_ACTIVE_COMPILATION_CONDITIONS` in pbxproj and xcconfig, per module that will hold wiring or fixtures | `app_map_debug_defined`, `where`, `modules_missing[]` → D0 |
| `scheme` | grep the workspace for another `AppMapDeepLink.scheme =` or a `CFBundleURLSchemes` entry containing `appmap`; only a hit asks the human for a suffix now | `appmap` or `appmap-<suffix>` |
| `xcode` | `xcrun --find xcodebuild` succeeds | `true` / `false` |

## Verifying a link on a simulator

`handle` returns before anything happens: the fixture and the route run in a main-actor task. After

```sh
xcrun simctl openurl booted "appmap://<id>?fixture=<name>"      # the app's own scheme when it is not the default
```

poll for the marker for up to 10 s — `argent run await-ui-element --udid <udid> --condition visible --selector-json '{"identifier": "screen.<id>"}'`,
or `mcp__argent__await-ui-element` / `native-describe-screen` when the session has Argent, else a human step — and
never assume the screen is up when `openurl` returns. No marker after 10 s plus an `[app-map] error: fixture` line in
the simulator log is an unwritten fixture (D4); no marker and no log line is a mapping that returned without routing
or a scheme the app does not register (D7). The export is checked the same way, without a device state:
`xcrun simctl launch booted <bundle_id> -AppMapExport <path>` then `tools/app-map-mcp/bin/app-map validate --router <path>`.
