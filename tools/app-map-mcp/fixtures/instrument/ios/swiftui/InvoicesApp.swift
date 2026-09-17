// Invoices — app entry (01 R5, 01 R6, 07 §3).
// The router is created here so the debug deep-link handler routes through the SAME instance SwiftUI owns.

import SwiftUI
import AppMapKit

@main
struct InvoicesApp: App {
    @StateObject private var router: AppRouter
    #if APP_MAP_DEBUG
    private let debugLinks: AppMapDeepLinkHandler          // exists only in Debug builds (01 §2)
    #endif

    init() {
        let router = AppRouter()
        _router = StateObject(wrappedValue: router)        // capture the instance: the handler below must reach this router
        AppMapWiring.registerAll()                          // outside #if: registrations are no-ops in Release (01 R6)
        #if APP_MAP_DEBUG
        debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
            router.open(screenID: route.screenID, params: route.params)
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(router)
                .onOpenURL { url in
                    #if APP_MAP_DEBUG
                    if debugLinks.handle(url) { return }        // an app-map link: fixture applied, then routed (01 R5)
                    #endif
                    router.handle(url)                          // everything else is the app's own URL handling
                }
        }
    }
}
