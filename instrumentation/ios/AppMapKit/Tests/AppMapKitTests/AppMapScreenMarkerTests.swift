// The UIKit half of `appMapScreen(_:)` (01 R3, issue #15): a 1 pt, non-hit-testable accessibility
// element carrying `screen.<screen_id>`, because the container form alone never reaches the flat
// accessibility tree a driver reads.
//
// The whole file is `#if canImport(UIKit)`, so it is empty on the macOS host the CI
// `ios-instrumentation` job runs `swift test` on; it only executes when AppMapKit is built for a
// simulator. The SwiftUI half cannot be unit-tested without a rendered host, so it is covered
// upstream instead — tools/app-map-mcp/src/test/tree.test.ts and identify.test.ts assert that a
// capture carrying a 1 pt marker identifies at `confidence: 1`.
//
// No `#if APP_MAP_DEBUG` guard, unlike the deep-link and router-export tests: markers are not a
// debug-only surface, they ship in every build (01 §2).

import XCTest
@testable import AppMapKit

#if canImport(UIKit)
import UIKit

final class AppMapScreenMarkerTests: XCTestCase {
    private func markers(of root: UIView) -> [AppMapScreenMarkerView] {
        root.subviews.compactMap { $0 as? AppMapScreenMarkerView }
    }

    func testInstallsOneMarkerElementCarryingTheId() {
        let root = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        root.appMapScreen("screen.marker_probe")

        // the root stays a container so its controls keep being reported individually
        XCTAssertFalse(root.isAccessibilityElement)
        XCTAssertEqual(root.accessibilityIdentifier, "screen.marker_probe")

        let installed = markers(of: root)
        XCTAssertEqual(installed.count, 1)
        guard let marker = installed.first else {
            XCTFail("appMapScreen installed no marker element")
            return
        }
        XCTAssertEqual(marker.accessibilityIdentifier, "screen.marker_probe")
        XCTAssertTrue(marker.isAccessibilityElement)
        // unlabeled and traitless: VoiceOver reaches it (it must — the driver reads the same
        // tree) but announces nothing
        XCTAssertNil(marker.accessibilityLabel)
        XCTAssertEqual(marker.accessibilityTraits, UIAccessibilityTraits.none)
        // 1 pt, and never hidden: `isHidden`/`alpha == 0` would drop it from the tree
        XCTAssertEqual(marker.bounds.size, CGSize(width: 1, height: 1))
        XCTAssertFalse(marker.isHidden)
        XCTAssertEqual(marker.alpha, 1)
    }

    func testRepeatCallsDoNotStackMarkers() {
        let root = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        root.appMapScreen("screen.marker_probe")
        root.appMapScreen("screen.marker_probe")
        XCTAssertEqual(markers(of: root).count, 1, "viewDidLoad + viewWillAppear must not stack markers")

        // retargeting (one root reused for two screens) moves the id rather than adding a marker
        root.appMapScreen("screen.marker_other")
        XCTAssertEqual(markers(of: root).count, 1)
        XCTAssertEqual(markers(of: root).first?.accessibilityIdentifier, "screen.marker_other")
        XCTAssertEqual(root.accessibilityIdentifier, "screen.marker_other")
    }

    func testMarkerTakesNoTouches() {
        let root = UIView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        root.appMapScreen("screen.marker_probe")
        let marker = markers(of: root).first

        XCTAssertNil(marker?.hitTest(CGPoint(x: 0.5, y: 0.5), with: nil))
        // the point the marker covers still belongs to the root, not to the marker
        XCTAssertTrue(root.hitTest(CGPoint(x: 0.5, y: 0.5), with: nil) === root)
    }
}
#endif
