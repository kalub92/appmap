// AppMapKit — debug-only build/environment probe (07 §3).
//
// The app-map server refuses to run a recipe unless the connected app is a Debug build in the
// sandbox environment, "checked via a debug endpoint the app exposes under APP_MAP_DEBUG".
//
// Design choice: the probe is a UserDefaults record, not a local HTTP listener. It adds no
// network surface and no port to coordinate, and the host reads it with plain command-line tools:
//
//     xcrun simctl spawn <udid|booted> defaults export <bundle_id> - | plutil -convert json -o - -
//   and, on iOS 26 where `defaults` no longer resolves a sandboxed app's domain, out of the
//   container directly (instrumentation/README.md §8):
//     plutil -convert xml1 -o - "$(xcrun simctl get_app_container <udid|booted> <bundle_id> data)/Library/Preferences/<bundle_id>.plist"
//
// In Release this type does not exist, so the key is never written and the query fails —
// which is exactly the "endpoint absent" case 07 §8 tests for.

import Foundation

#if APP_MAP_DEBUG
public enum AppMapDebugEndpoint {
    /// UserDefaults key the server reads.
    public static let defaultsKey = "app_map_debug_probe"
    /// Info.plist key naming the backend environment; the app's Debug config sets it to `sandbox`.
    public static let infoPlistEnvironmentKey = "AppMapEnvironment"
    /// Environment variable override (`1`/`true`/`yes`), handy for launch arguments in CI.
    public static let environmentVariable = "APP_MAP_SANDBOX"

    /// True when the app is pointed at the sandbox backend (07 §3). Prefer passing an explicit
    /// value to `publish(sandbox:)` from the app's own environment configuration.
    public static func isSandbox(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Bool {
        if let value = environment[environmentVariable] {
            return ["1", "true", "yes"].contains(value.lowercased())
        }
        if let value = bundle.object(forInfoDictionaryKey: infoPlistEnvironmentKey) as? String {
            return value.lowercased() == "sandbox"
        }
        return false
    }

    /// The record the server sees. Contains build metadata only — never user data (07 §2).
    public static func probe(
        sandbox: Bool? = nil,
        bundle: Bundle = .main,
        build: AppMapBuildInfo = .current()
    ) -> [String: Any] {
        [
            "schema_version": 1,
            "build_type": "debug",
            "sandbox": sandbox ?? isSandbox(bundle: bundle),
            "app_id": bundle.bundleIdentifier ?? AppMapRouterRegistry.unknownAppID,
            "version": build.version,
            "build_number": build.buildNumber,
            "git_sha": build.gitSha,
            "written_at": ISO8601DateFormatter().string(from: Date()),
        ]
    }

    /// Writes the probe. Call once at launch, after `AppMapRouterRegistry.exportIfRequested()`.
    public static func publish(sandbox: Bool? = nil, defaults: UserDefaults = .standard, bundle: Bundle = .main) {
        defaults.set(probe(sandbox: sandbox, bundle: bundle), forKey: defaultsKey)
    }

    public static func clear(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: defaultsKey)
    }
}
#endif
