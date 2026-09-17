// Invoices — router export registrations (01 R6), gates (01 R7) and the debug probe (07 §3).
// Called once from InvoicesApp.init. Registration and export compile to no-ops in Release, so only
// the probe needs the #if.

import SwiftUI
import AppMapKit

enum AppMapWiring {
    static func registerAll() {
        let registry = AppMapRouterRegistry.shared
        // `id:`, `route:` and `to:` take BARE screen ids: the export carries the id and the map derives the marker (01 R6)
        registry.register(id: "login", route: "appmap://login", viewType: LoginView.self, title: "Sign In",
                          staticEdges: [.tap(AppMapID.Element.loginSubmitButton, to: "invoice_list")])
        registry.register(id: "invoice_list", route: "appmap://invoice_list", viewType: InvoiceListView.self, title: "Invoices",
                          staticEdges: [.tap(AppMapID.Element.invoiceAddButton, to: "invoice_new"),
                                        .tap(AppMapID.Element.invoiceListCell, to: "invoice_detail")])
        registry.register(id: "invoice_new", route: "appmap://invoice_new", viewType: InvoiceNewView.self, title: "New Invoice",
                          staticEdges: [.tap(AppMapID.Element.invoiceClientPicker, to: "client_picker"),
                                        .tap(AppMapID.Element.invoiceSaveButton, to: "invoice_detail"),
                                        .tap(AppMapID.Element.invoiceCancelButton, to: "invoice_list")])
        registry.register(id: "client_picker", route: "none", viewType: ClientPickerView.self, title: "Choose Client",
                          staticEdges: [.tap(AppMapID.Element.clientPickerCancelButton, to: "invoice_new")])
        registry.register(id: "invoice_detail", route: "appmap://invoice_detail", viewType: InvoiceDetailView.self, title: "Invoice",
                          staticEdges: [.tap(AppMapID.Element.invoiceDetailBackButton, to: "invoice_list"),
                                        .tap(AppMapID.Element.invoiceDetailEditButton, to: "invoice_new")])
        // OS dialogs (01 R7): the Face ID sheet behind the biometric button and the notification prompt after sign-in.
        // They cannot carry ids; the registry names them and their safe escape, the map records a label signature.
        registry.registerGate(id: AppMapID.Gate.biometricPrompt, dismiss: AppMapID.Gate.Dismiss.biometricPromptCancel)
        registry.registerGate(id: AppMapID.Gate.pushPermission, dismiss: AppMapID.Gate.Dismiss.pushPermissionDeny)
        registry.exportIfRequested()                            // -AppMapExport <path> writes the JSON and exits here
        #if APP_MAP_DEBUG
        AppMapDebugEndpoint.publish()                           // after export; sandbox from APP_MAP_SANDBOX or Info.plist AppMapEnvironment
        #endif
    }
}
