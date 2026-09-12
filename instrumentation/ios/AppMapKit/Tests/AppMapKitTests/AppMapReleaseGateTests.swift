// 01 §4: "Release builds contain no appmap:// handler and no export path (verified by a unit test
// that asserts the handler is absent when the flag is off)."
//
// Approach. A missing type cannot be referenced from a test without breaking compilation, so the
// handler is an `@objc(AppMapDeepLinkHandler)` class with a fixed runtime name, declared only under
// `#if APP_MAP_DEBUG`. Its presence is then observable at runtime through the Objective-C runtime
// without a compile-time symbol reference. `AppMapBuild.debugSurfacesCompiled` cross-checks that
// the test target and the library agree on the flag.
//
//   swift test              → Debug: handler must exist
//   swift test -c release   → Release: handler must be absent (this is the CI gate)

import Foundation
import XCTest
@testable import AppMapKit

final class AppMapReleaseGateTests: XCTestCase {
    private let handlerClassName = "AppMapDeepLinkHandler"

    func testDeepLinkHandlerPresenceMatchesBuildFlag() {
        #if APP_MAP_DEBUG
        XCTAssertTrue(AppMapBuild.debugSurfacesCompiled)
        XCTAssertNotNil(NSClassFromString(handlerClassName), "handler must exist when APP_MAP_DEBUG is defined")
        #else
        XCTAssertFalse(AppMapBuild.debugSurfacesCompiled)
        XCTAssertNil(
            NSClassFromString(handlerClassName),
            "appmap:// handler is present in a build without APP_MAP_DEBUG — a debug surface leaked (01 §4)"
        )
        #endif
    }
}
