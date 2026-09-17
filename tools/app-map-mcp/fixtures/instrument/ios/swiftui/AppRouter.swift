// Invoices — production navigation state. Nothing app-map specific lives here; the debug-only
// deep-link mapping is the extension in AppRouter+AppMap.swift.

import SwiftUI
import AppMapKit

/// Pushed destinations of the invoices tab's NavigationStack.
enum Route: Hashable {
    case invoiceDetail(String)
}

final class AppRouter: ObservableObject {
    enum Tab: Hashable {
        case invoices, clients, settings
    }

    /// Modal sheets presented over the invoices tab.
    enum Sheet: String, Identifiable {
        case invoiceNew
        var id: String { rawValue }
    }

    @Published var tab: Tab = .invoices
    @Published var path = NavigationPath()
    @Published var sheet: Sheet?
    @Published var needsLogin = true

    func showInvoices() {
        sheet = nil
        tab = .invoices
        path = NavigationPath()
    }

    func showInvoiceDetail(_ invoiceID: String) {
        showInvoices()
        path.append(Route.invoiceDetail(invoiceID))
    }

    /// Production URL handling (universal links). App-map links never reach here: the debug handler consumes them first.
    func handle(_ url: URL) {
        let parts = url.pathComponents
        guard parts.count >= 3, parts[1] == "invoice" else { return }
        showInvoiceDetail(parts[2])
    }
}
