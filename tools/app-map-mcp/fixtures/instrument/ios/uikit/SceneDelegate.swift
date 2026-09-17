// SceneDelegate — the URL entry points of the `uikit_scene` lifecycle (01 R5).
// One handler for the scene's lifetime; a cold-start URL arrives with the connection, a warm one in openURLContexts.

import UIKit
import AppMapKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    #if APP_MAP_DEBUG
    // Applies ?fixture= and hands the bare screen id to the real coordinator, so the state it lands on is genuine (01 R5).
    private lazy var debugLinks = AppMapDeepLinkHandler(fixtures: DebugFixtures()) { route in
        AppRouter.shared.open(screenID: route.screenID, params: route.params)
    }
    #endif

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = AppRouter.shared.rootViewController   // the app's existing root setup, unchanged
        self.window = window
        window.makeKeyAndVisible()
        // Cold start by URL: handled only now that the window is key, so the coordinator has a root to drive.
        #if APP_MAP_DEBUG
        if connectionOptions.urlContexts.contains(where: { debugLinks.handle($0.url) }) { return }
        #endif
        for context in connectionOptions.urlContexts { AppRouter.shared.handle(context.url) }   // production URLs, unchanged
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        #if APP_MAP_DEBUG
        if URLContexts.contains(where: { debugLinks.handle($0.url) }) { return }   // warm open; false means not an app-map link
        #endif
        for context in URLContexts { AppRouter.shared.handle(context.url) }   // production URLs, unchanged
    }
}
