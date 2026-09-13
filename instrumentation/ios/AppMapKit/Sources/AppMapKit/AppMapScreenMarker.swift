// AppMapKit — screen markers and element identifiers (01 R3, R4).
//
// Markers ship in every build: accessibility identifiers are invisible to users and are the
// standard XCUITest mechanism (01 §2). Always pass generated constants (`AppMapID.Screen.*`,
// `AppMapID.Element.*`); `app-map lint-ids` rejects string literals (01 R8).
//
// A screen marker is TWO things, and both are load-bearing (issue #15):
//  - the screen root is an accessibility CONTAINER carrying `screen.<screen_id>`
//    (`.accessibilityElement(children: .contain)` on SwiftUI, `isAccessibilityElement = false`
//    plus an identifier on UIKit). VoiceOver groups by it, and readers that do list containers
//    find the id there;
//  - a 1 pt marker ELEMENT carries the same id inside that container. The iOS simulator's
//    accessibility service renders a FLAT tree and does not list containers at all, so a driver
//    reading it (`argent run native-describe-screen --json`) sees every element id and NO
//    `screen.<id>`. The marker element is what actually reaches the driver, and `marker` is the
//    only weight-1.0 identification signal there is (03 §5.2) — without it identification falls
//    back to the weaker `required_ids` / structural-hash cascade, which is ambiguous between
//    screens that share an element set.
//
// The marker is deliberately NOT `accessibilityHidden` / `accessibilityElementsHidden`: the
// driver reads the same accessibility tree VoiceOver does, so hiding it from VoiceOver hides it
// from the driver and defeats the whole point. It is made harmless instead — 1 × 1 pt of clear
// colour, no label, no traits, hit testing off — so it changes no layout, swallows no tap and
// announces nothing. The accepted cost is one extra unlabeled VoiceOver stop per screen.

import SwiftUI

public extension View {
    /// Marks the root of a screen with `screen.<screen_id>`: an accessibility container that
    /// keeps its children reachable, plus a 1 pt marker element carrying the same id so the
    /// marker survives the flat accessibility tree a driver reads (issue #15).
    ///
    ///     NavigationStack { … }
    ///         .appMapScreen(AppMapID.Screen.invoiceList)
    ///
    /// Do NOT "simplify" the overlay away. The container modifier alone produces no element in
    /// the simulator's flat tree, so `screen.<screen_id>` never reaches the driver and
    /// identification drops from `confidence: 1.0` on `marker` to the weaker `required_ids` /
    /// structural-hash cascade (03 §5). The overlay is applied first so the marker ends up
    /// INSIDE the container rather than beside it, and an overlay never affects the layout of
    /// the view it decorates.
    ///
    /// A pushed screen leaves the covered screen's marker in the tree, so two markers are
    /// routinely present; readers prefer the deepest (01 R3, issue #10).
    func appMapScreen(_ id: String) -> some View {
        overlay(alignment: .topLeading) {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement()          // an ELEMENT, not a container: only elements reach a flat tree
                .accessibilityIdentifier(id)
                .allowsHitTesting(false)         // never steal a tap meant for the content underneath
        }
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

/// The 1 pt marker element of `appMapScreen(_:)` on UIKit (issue #15).
///
/// A real subview rather than a bare `UIAccessibilityElement`, because handing the root an
/// `accessibilityElements` array REPLACES its default child enumeration and would hide every
/// control below it from the driver and from VoiceOver alike.
final class AppMapScreenMarkerView: UIView {
    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        backgroundColor = .clear
        isOpaque = false
        // `isHidden`, `alpha == 0` and `accessibilityElementsHidden` would each drop the view
        // from the accessibility tree, which is the one thing it exists to be in
        isHidden = false
        alpha = 1
        isUserInteractionEnabled = false
        isAccessibilityElement = true
        accessibilityLabel = nil        // unlabeled: VoiceOver reaches it but announces nothing
        accessibilityTraits = .none
    }

    /// Belt and braces with `isUserInteractionEnabled = false`: a host that flips that flag on
    /// the whole subtree still must not be able to make the marker take a touch.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        nil
    }
}

public extension UIView {
    /// UIKit equivalent of `View.appMapScreen(_:)`. Call from `viewDidLoad` on the root view.
    /// The root stays a non-element so its children remain hittable and individually reported,
    /// and a 1 pt `AppMapScreenMarkerView` carrying the same id is installed inside it — the
    /// container alone is invisible to the flat tree a driver reads (issue #15).
    ///
    /// Idempotent: a second call retargets the marker already installed instead of stacking
    /// another, so calling from both `viewDidLoad` and `viewWillAppear` is safe.
    ///
    /// Note that this adds one entry to `subviews`. Host code that indexes `subviews`
    /// positionally (`subviews.first`, `subviews.count`) will see it; there is no way to add a
    /// UIKit accessibility element without either a subview or clobbering `accessibilityElements`.
    func appMapScreen(_ id: String) {
        isAccessibilityElement = false
        accessibilityIdentifier = id
        let marker: AppMapScreenMarkerView
        if let installed = subviews.compactMap({ $0 as? AppMapScreenMarkerView }).first {
            marker = installed
        } else {
            marker = AppMapScreenMarkerView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
            // frame-positioned on purpose: no constraint of ours can conflict with the host's layout
            marker.translatesAutoresizingMaskIntoConstraints = true
            marker.autoresizingMask = []
            addSubview(marker)
        }
        marker.accessibilityIdentifier = id
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
