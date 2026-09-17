// InvoiceHostingBridge — hosts a screen already rewritten in SwiftUI inside this UIKit stack; the coordinator pushes it
// like any other VC. No marker here (§9 rule 5, issue #15): the hosted SwiftUI root carries the marker modifier itself,
// and a second mark on the host would report two markers for one screen (double_marked). Bar items and the tab item
// may still be id'd on the host, since they belong to the navigation chrome, not to the hosted root.

import UIKit
import SwiftUI
import AppMapKit

final class InvoiceHostingController: UIHostingController<AnyView> {
    init<Content: View>(_ content: Content, title: String? = nil) {
        super.init(rootView: AnyView(content))
        self.title = title
    }

    @available(*, unavailable)
    required init?(coder aDecoder: NSCoder) {
        fatalError("init(coder:) is unavailable: this app builds its UI in code")
    }
}
