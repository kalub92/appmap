// AppMapKit — test-only deep links (01 R5).
//
// Scheme: <scheme>://<screen_id>[?fixture=<name>&k=v…], `appmap` by default and configurable per
// app via AppMapDeepLink.scheme (issue #25: two instrumented apps on one device otherwise collide).
// The parser produces an `AppMapRoute`; the app's *real* router consumes it so the resulting
// state is genuine, not a bare view. Nothing in this file exists outside APP_MAP_DEBUG: the
// `#if` leaves no symbol behind, which is what 01 §4 asks a Release unit test to verify
// (see Tests/AppMapKitTests/AppMapReleaseGateTests.swift).

import Foundation

#if APP_MAP_DEBUG
/// A parsed app-map deep link. `params` never contains `fixture`.
public struct AppMapRoute: Equatable, Sendable {
    public let screenID: String
    public let fixture: String?
    public let params: [String: String]

    public init(screenID: String, fixture: String? = nil, params: [String: String] = [:]) {
        self.screenID = screenID
        self.fixture = fixture
        self.params = params
    }
}

public enum AppMapDeepLink {
    /// The default scheme.
    ///
    /// Every app-map app used to register exactly this, which meant two instrumented apps on one
    /// device both claimed it and iOS delivered `appmap://<screen>` — and the `?fixture=` it
    /// carries — to whichever it liked, while the app-scoped capture kept describing the other one
    /// and timed out (issue #25).
    public static let defaultScheme = "appmap"

    /// The scheme THIS app registers. Set it once at launch in debug builds when more than one
    /// app-map app can be installed at once, and declare the SAME value as `deep_link_scheme` in
    /// `app-map/ios/manifest.yaml` and in the Debug target's `CFBundleURLTypes`.
    /// `appmap-<last component of the bundle id>` is the conventional choice.
    ///
    ///     AppMapDeepLink.scheme = "appmap-pokedexteams"
    ///
    /// Setting an invalid scheme is a programmer error and traps: an app that answers a scheme the
    /// map does not name is the failure this exists to prevent, and it is silent at runtime.
    public static var scheme: String {
        get { storedScheme }
        set {
            let normalized = newValue.trimmingCharacters(in: .whitespaces).lowercased()
            precondition(
                normalized.range(of: schemePattern, options: .regularExpression) != nil,
                "app-map deep link scheme must be a lowercase URL scheme, got '\(newValue)'"
            )
            storedScheme = normalized
        }
    }

    private static var storedScheme = defaultScheme
    /// RFC 3986 `scheme`, narrowed the same way `manifest.schema.json` narrows `deep_link_scheme`.
    private static let schemePattern = "^[a-z][a-z0-9+.-]{0,63}$"
    /// Screen ids are bare snake_case names (01 R2; app-map/schema/ids.schema.json); the marker is `screen.<id>`.
    private static let screenIDPattern = "^[a-z][a-z0-9_]*$"

    public static func parse(_ url: URL) -> AppMapRoute? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        return parse(components)
    }

    public static func parse(_ string: String) -> AppMapRoute? {
        guard let components = URLComponents(string: string) else { return nil }
        return parse(components)
    }

    private static func parse(_ components: URLComponents) -> AppMapRoute? {
        guard components.scheme?.lowercased() == storedScheme else { return nil }
        guard let host = components.host, !host.isEmpty else { return nil }
        guard components.path.isEmpty || components.path == "/" else { return nil }
        guard host.range(of: screenIDPattern, options: .regularExpression) != nil else { return nil }

        var params: [String: String] = [:]
        for item in components.queryItems ?? [] where !item.name.isEmpty {
            params[item.name] = item.value ?? ""
        }
        let fixture = params.removeValue(forKey: "fixture")
        return AppMapRoute(screenID: host, fixture: fixture, params: params)
    }
}

/// Applies the optional fixture, then hands the route to the app's real router.
///
/// Exposed to the Objective-C runtime under a fixed name so a Release build can be probed for
/// its absence without a compile-time reference: `NSClassFromString("AppMapDeepLinkHandler")`.
///
///     // Debug-only wiring in the App / SceneDelegate:
///     let handler = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
///         AppRouter.shared.navigate(to: route.screenID, params: route.params)
///     }
///     .onOpenURL { url in _ = handler.handle(url) }
@objc(AppMapDeepLinkHandler)
public final class AppMapDeepLinkHandler: NSObject {
    public typealias Router = @MainActor (AppMapRoute) -> Void

    private let fixtures: AppMapFixtures?
    private let route: Router

    public init(fixtures: AppMapFixtures? = nil, route: @escaping Router) {
        self.fixtures = fixtures
        self.route = route
        super.init()
    }

    /// Returns `false` when `url` is not an app-map link so the caller can fall through to its
    /// production URL handling. Fixture application and routing run asynchronously on the main
    /// actor; a failing fixture logs and does not route.
    @discardableResult
    public func handle(_ url: URL) -> Bool {
        guard let parsed = AppMapDeepLink.parse(url) else { return false }
        let fixtures = self.fixtures
        let route = self.route
        Task { @MainActor in
            if let name = parsed.fixture {
                guard let fixtures else {
                    AppMapLog.error("fixture '\(name)' requested but no AppMapFixtures installed")
                    return
                }
                do {
                    try await fixtures.apply(name: name)
                } catch {
                    AppMapLog.error("fixture '\(name)' failed: \(error)")
                    return
                }
            }
            route(parsed)
        }
        return true
    }
}
#endif
