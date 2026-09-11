// Debug-only trampoline for appmap:// links (01 R5). Declared in src/debug/AndroidManifest.xml.
// Parses the link, applies the fixture, hands the route to the app's installed router, finishes.
package com.example.appmap

import android.app.Activity
import android.os.Bundle
import android.util.Log

class AppMapDeepLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val data = intent?.data
        val route = data?.let { AppMapDeepLink.parse(it) }
        if (route == null) {
            Log.w(TAG, "ignoring non app-map intent: $data")
        } else {
            try {
                if (!AppMapDeepLink.dispatch(route)) Log.e(TAG, "route to '${route.screenId}' was not dispatched")
            } catch (e: AppMapFixtureException) {
                Log.e(TAG, "fixture failed for appmap://${route.screenId}", e)
            }
        }
        finish()
    }

    private companion object {
        const val TAG = "app-map"
    }
}
