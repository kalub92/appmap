// AppDelegate — app-map wiring for the `uikit_scene` lifecycle (01 R5, 01 R6).
// Registration runs here, once, before any window exists; URL handling lives in SceneDelegate.

import UIKit
import AppMapKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        AppMapWiring.registerAll()   // first statement: an -AppMapExport launch writes the export and exits inside it (01 R6)
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: nil, sessionRole: connectingSceneSession.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }

    // The `uikit_appdelegate` shape, for an app without scenes: iOS delivers every URL (a cold start by URL included) to this
    // one method, so `handle` runs exactly once per URL. An app keeps exactly one of the two shapes — with the SceneDelegate
    // above, UIKit never calls this method and the scene's handler is the live one (01 R5).
    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        #if APP_MAP_DEBUG
        if debugLinks.handle(url) { return true }   // an app-map link: the fixture and the route run later, on the main actor
        #endif
        return AppRouter.shared.handle(url)         // the app's own URL handling, unchanged
    }

    #if APP_MAP_DEBUG
    private lazy var debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
        AppRouter.shared.open(screenID: route.screenID, params: route.params)
    }
    #endif
}
