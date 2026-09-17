// AppRouter+AppMap — the debug deep-link mapping (01 R5): exists only under APP_MAP_DEBUG and reaches every screen
// through the coordinator's existing methods, so the state a link lands on is genuine.

import UIKit
import AppMapKit

#if APP_MAP_DEBUG
extension AppRouter {
    /// AppMapRoute.screenID is the URL host, the bare id: the cases are bare strings, never the marker constants,
    /// whose value carries a prefix the host never has (design §10.1). Bare ids are legal literals for lint (01 R8).
    func open(screenID: String, params: [String: String]) {
        switch screenID {
        case "login":
            signOut()                                            // the existing sign-out path shows the login root
        case "invoice_list":
            showInvoices()
        case "invoice_new":
            showInvoiceNew()
        case "invoice_detail":
            guard let id = params["invoice_id"] else { return }   // deep_link_needs.params: no id, no route
            showInvoice(id: id)
        default:
            break                                                // client_picker: deep_link none (needs invoice_new's state)
        }
    }
}
#endif
