// Invoices — the tab shell. A TabView is never a screen (01 R3): each tab root marks itself, and the
// tab bar items carry `nav.<x>.tab` ids on their Labels (verify on device; harness-notes §2).

import SwiftUI
import AppMapKit

struct RootView: View {
    @EnvironmentObject var router: AppRouter

    var body: some View {
        TabView(selection: $router.tab) {                       // no marker here; InvoiceListView marks its own root
            InvoiceListView()
                .tabItem { Label("Invoices", systemImage: "doc.text").appMapID(AppMapID.Element.navInvoicesTab) }
                .tag(AppRouter.Tab.invoices)
            Text("Clients")                                     // tab roots the pilot registry does not list yet: a survey
                .tabItem { Label("Clients", systemImage: "person.2").appMapID(AppMapID.Element.navClientsTab) }
                .tag(AppRouter.Tab.clients)
            Text("Settings")                                    // registers them, then each marks itself (01 R3)
                .tabItem { Label("Settings", systemImage: "gearshape").appMapID(AppMapID.Element.navSettingsTab) }
                .tag(AppRouter.Tab.settings)
        }
        .fullScreenCover(isPresented: $router.needsLogin) {
            LoginView()                                         // a cover is a screen of its own: LoginView marks itself
        }
    }
}
