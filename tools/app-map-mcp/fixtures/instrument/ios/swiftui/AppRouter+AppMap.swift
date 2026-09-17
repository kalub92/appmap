// Invoices — debug-only mapping from app-map deep links onto the real router (01 R5).
// The parsed route's screenID is the URL host: the BARE screen id, never the marker string.

import SwiftUI
import AppMapKit

#if APP_MAP_DEBUG
extension AppRouter {
    /// Reaches each screen through the same state the app uses; a `?fixture=` has already been applied.
    @MainActor func open(screenID: String, params: [String: String]) {
        switch screenID {
        case "login":
            needsLogin = true                                   // the login cover presents over whatever is up
        case "invoice_list":
            showInvoices()
        case "invoice_new":
            showInvoices()
            sheet = .invoiceNew
        case "invoice_detail":
            guard let invoiceID = params["invoice_id"] else { return }
            showInvoiceDetail(invoiceID)
        default:
            break                                               // client_picker: deep_link none, it needs the draft it fills in
        }
    }
}
#endif
