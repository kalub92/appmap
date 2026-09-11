// AppMapKit — screen markers and element identifiers (01 R3, R4).
//
// Markers ship in every build: accessibility identifiers are invisible to users and are the
// standard XCUITest mechanism (01 §2). Always pass generated constants (`AppMapID.Screen.*`,
// `AppMapID.Element.*`); `app-map lint-ids` rejects string literals (01 R8).

import SwiftUI

public extension View {
    /// Marks the root of a screen with `screen.<screen_id>` and keeps its children reachable in
    /// the accessibility tree. Exactly one marker is visible per full-screen state; sheets and
    /// modals carry their own (01 R3).
    ///
    ///     NavigationStack { … }
    ///         .appMapScreen(AppMapID.Screen.invoiceList)
    func appMapScreen(_ id: String) -> some View {
        self
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier(id)
    }

    /// Tags an interactive element or form label with its registry id (01 R4). List cells of the
    /// same kind share one id; index disambiguates at runtime.
    func appMapID(_ id: String) -> some View {
        accessibilityIdentifier(id)
    }
}

#if canImport(UIKit)
import UIKit

public extension UIView {
    /// UIKit equivalent of `View.appMapScreen(_:)`. Call from `viewDidLoad` on the root view.
    /// The container is a marker, not a control, so it stays a non-element and children remain
    /// hittable.
    func appMapScreen(_ id: String) {
        isAccessibilityElement = false
        accessibilityIdentifier = id
    }

    /// UIKit equivalent of `View.appMapID(_:)`.
    func appMapID(_ id: String) {
        accessibilityIdentifier = id
    }
}

public extension UIViewController {
    /// Marks `view` as the screen root (01 R3).
    func appMapScreen(_ id: String) {
        view.appMapScreen(id)
    }
}
#endif
