// AppMapWiring — router export registration (01 R6) and the debug probe (07 §3), called once from didFinishLaunching.
// register, registerGate and exportIfRequested compile to no-ops in Release, so only the probe needs the #if.

import UIKit
import AppMapKit

enum AppMapWiring {
    static func registerAll() {
        let registry = AppMapRouterRegistry.shared
        // id:, route: and to: take BARE screen ids: lint registers only the prefixed marker, so these literals are legal (01 R8).
        registry.register(id: "login", route: "appmap://login", viewType: LoginViewController.self, title: "Sign In",
                          staticEdges: [.tap(AppMapID.Element.loginSubmitButton, to: "invoice_list")])
        registry.register(id: "invoice_list", route: "appmap://invoice_list", viewType: InvoiceListViewController.self,
                          title: "Invoices", staticEdges: [.tap(AppMapID.Element.invoiceAddButton, to: "invoice_new")])
        registry.register(id: "invoice_new", route: "appmap://invoice_new", viewType: InvoiceNewViewController.self,
                          title: "New Invoice", staticEdges: [.tap(AppMapID.Element.invoiceClientPicker, to: "client_picker")])
        registry.register(id: "invoice_detail", route: "appmap://invoice_detail", viewType: InvoiceDetailViewController.self, title: "Invoice")
        registry.register(id: "client_picker", route: "none", viewType: ClientPickerViewController.self, title: "Choose Client")
        registry.registerGate(id: AppMapID.Gate.pushPermission, dismiss: AppMapID.Gate.Dismiss.pushPermissionDeny)
        registry.registerGate(id: AppMapID.Gate.biometricPrompt, dismiss: AppMapID.Gate.Dismiss.biometricPromptCancel)
        registry.exportIfRequested()                     // exits the process on -AppMapExport launches: nothing below runs then (01 R6)
        #if APP_MAP_DEBUG
        AppMapDebugEndpoint.publish()                    // after export; sandbox from APP_MAP_SANDBOX / Info.plist AppMapEnvironment (07 §3)
        #endif
    }
}
