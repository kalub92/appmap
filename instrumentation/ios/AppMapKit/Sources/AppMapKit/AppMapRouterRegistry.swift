// AppMapKit — debug-only router export (01 R6).
//
// Screens register `(id, route, viewType, staticEdges)`; launching with `-AppMapExport <path>`
// writes `router-export.json` in the 01 R6 shape and exits. `app-map import-router` seeds the
// map from it (06 R7). Registration calls compile to no-ops in Release so app code needs no
// `#if`; the export path itself does not exist in Release (01 §4).

import Foundation

public struct AppMapAction: Codable, Equatable, Sendable {
    public let type: String
    public let element: String?

    public init(type: String, element: String? = nil) {
        self.type = type
        self.element = element
    }

    public static func tap(_ element: String) -> AppMapAction { AppMapAction(type: "tap", element: element) }
}

public struct AppMapEdge: Codable, Equatable, Sendable {
    public let action: AppMapAction
    public let to: String

    public init(action: AppMapAction, to: String) {
        self.action = action
        self.to = to
    }

    /// Convenience for the common case: tapping `element` leads to screen `to`.
    public static func tap(_ element: String, to: String) -> AppMapEdge {
        AppMapEdge(action: .tap(element), to: to)
    }
}

public final class AppMapRouterRegistry {
    public static let shared = AppMapRouterRegistry()

    #if APP_MAP_DEBUG
    private struct Screen {
        let id: String
        let route: String
        let viewType: String
        let title: String?
        let edges: [AppMapEdge]
    }

    private let lock = NSLock()
    private var screens: [String: Screen] = [:]
    private var gates: [String: String] = [:]
    #endif

    public init() {}

    /// Registers a screen. Call at module load or first appearance; re-registering replaces.
    /// `route` is the screen's deep link (`appmap://<id>`) or `"none"`; `title` is the static nav title.
    public func register(id: String, route: String, viewType: Any.Type, title: String? = nil, staticEdges: [AppMapEdge] = []) {
        register(id: id, route: route, viewTypeName: String(describing: viewType), title: title, staticEdges: staticEdges)
    }

    public func register(id: String, route: String, viewTypeName: String, title: String? = nil, staticEdges: [AppMapEdge] = []) {
        #if APP_MAP_DEBUG
        lock.lock()
        defer { lock.unlock() }
        screens[id] = Screen(id: id, route: route, viewType: viewTypeName, title: title, edges: staticEdges)
        #endif
    }

    /// Registers an interrupter and its dismiss control (01 R7).
    public func registerGate(id: String, dismiss: String) {
        #if APP_MAP_DEBUG
        lock.lock()
        defer { lock.unlock() }
        gates[id] = dismiss
        #endif
    }

    /// Honors `-AppMapExport <path>`: writes the export and terminates the process with 0
    /// (1 if writing failed). Call once at launch, after every screen has registered.
    /// No-op when the argument is absent and in Release builds.
    public func exportIfRequested(
        arguments: [String] = ProcessInfo.processInfo.arguments,
        terminate: (Int32) -> Void = { Foundation.exit($0) }
    ) {
        #if APP_MAP_DEBUG
        guard let index = arguments.firstIndex(of: "-AppMapExport"), index + 1 < arguments.count else { return }
        let path = arguments[index + 1]
        do {
            let data = try exportData()
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            AppMapLog.info("router export written to \(path)")
            terminate(0)
        } catch {
            AppMapLog.error("router export failed: \(error)")
            terminate(1)
        }
        #endif
    }

    #if APP_MAP_DEBUG
    /// The 01 R6 JSON document. Screens and gates are sorted by id; slashes are not escaped.
    public func exportData(appID: String? = nil, build: AppMapBuildInfo = .current()) throws -> Data {
        lock.lock()
        let screenList = screens.values
            .sorted { $0.id < $1.id }
            .map { AppMapRouterExport.Screen(id: $0.id, route: $0.route, viewType: $0.viewType, title: $0.title, edges: $0.edges) }
        let gateList = gates
            .sorted { $0.key < $1.key }
            .map { AppMapRouterExport.Gate(id: $0.key, dismiss: $0.value) }
        lock.unlock()

        let export = AppMapRouterExport(
            schemaVersion: 1,
            appId: appID ?? Bundle.main.bundleIdentifier ?? "unknown",
            platform: "ios",
            build: build,
            screens: screenList,
            gates: gateList
        )
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(export)
    }
    #endif
}

#if APP_MAP_DEBUG
public struct AppMapBuildInfo: Codable, Equatable, Sendable {
    public let version: String
    public let buildNumber: String
    public let gitSha: String

    public init(version: String, buildNumber: String, gitSha: String) {
        self.version = version
        self.buildNumber = buildNumber
        self.gitSha = gitSha
    }

    /// Placeholder that still satisfies the schema's hex pattern when no sha was wired up.
    public static let unknownGitSha = "0000000"

    /// `CFBundleShortVersionString` / `CFBundleVersion`, plus the git sha from the `APP_MAP_GIT_SHA`
    /// environment variable (scripts/app-map/router-export.sh passes it via `SIMCTL_CHILD_`) or the
    /// Info.plist key `AppMapGitSHA` set by the build script. Falls back to `unknownGitSha` with a log line.
    public static func current(
        bundle: Bundle = .main,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> AppMapBuildInfo {
        let info = bundle.infoDictionary ?? [:]
        let sha = environment["APP_MAP_GIT_SHA"] ?? info["AppMapGitSHA"] as? String
        if sha == nil { AppMapLog.error("git sha unknown; set APP_MAP_GIT_SHA or Info.plist AppMapGitSHA (01 R6)") }
        return AppMapBuildInfo(
            version: info["CFBundleShortVersionString"] as? String ?? "0",
            buildNumber: info["CFBundleVersion"] as? String ?? "0",
            gitSha: sha ?? unknownGitSha
        )
    }
}

/// Mirrors app-map/schema/router-export.schema.json (01 R6). Encoded with snake_case keys.
public struct AppMapRouterExport: Codable, Equatable {
    public struct Screen: Codable, Equatable {
        public let id: String
        public let route: String
        public let viewType: String
        public let title: String?      // omitted from JSON when nil
        public let edges: [AppMapEdge]
    }

    public struct Gate: Codable, Equatable {
        public let id: String
        public let dismiss: String
    }

    public let schemaVersion: Int
    public let appId: String
    public let platform: String
    public let build: AppMapBuildInfo
    public let screens: [Screen]
    public let gates: [Gate]
}
#endif
