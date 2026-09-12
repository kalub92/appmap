// AppMapKit — build-flag introspection (01 §2).
//
// `APP_MAP_DEBUG` is passed as `-D APP_MAP_DEBUG` in Debug configurations (Package.swift does this
// for the package; the app target must do the same in its Debug build settings).

public enum AppMapBuild {
    /// True only when this module was compiled with `APP_MAP_DEBUG`. Used by tests to prove the
    /// debug-only surfaces are absent from Release (01 §4).
    #if APP_MAP_DEBUG
    public static let debugSurfacesCompiled = true
    #else
    public static let debugSurfacesCompiled = false
    #endif
}

enum AppMapLog {
    static func info(_ message: String) { NSLog("[app-map] %@", message) }
    static func error(_ message: String) { NSLog("[app-map] error: %@", message) }
}

import Foundation
