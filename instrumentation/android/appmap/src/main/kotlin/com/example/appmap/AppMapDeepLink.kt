// AppMapKit (Android) — test-only deep links (01 R5).
//
// Scheme: appmap://<screen_id>[?fixture=<name>&k=v…]
// Parsing is pure Kotlin so it unit-tests on the JVM. Everything is gated on
// BuildConfig.APP_MAP_DEBUG; the intent filter itself exists only in src/debug/AndroidManifest.xml.
package com.example.appmap

import android.net.Uri
import android.util.Log
import java.net.URLDecoder

/** A parsed app-map deep link. [params] never contains `fixture`. */
data class AppMapRoute(
    val screenId: String,
    val fixture: String? = null,
    val params: Map<String, String> = emptyMap(),
)

object AppMapDeepLink {
    const val SCHEME = "appmap"
    private const val TAG = "app-map"

    /** Screen ids are bare snake_case names (01 R2; app-map/schema/ids.schema.json); the marker is `screen.<id>`. */
    private val SCREEN_ID = Regex("^[a-z][a-z0-9_]*$")

    /** The app's real router (01 R5). Installed from Application.onCreate in debug builds. */
    fun interface Router {
        fun route(route: AppMapRoute)
    }

    @Volatile
    private var router: Router? = null

    fun installRouter(router: Router) {
        if (!BuildConfig.APP_MAP_DEBUG) return
        this.router = router
    }

    /** Returns null in Release builds and for anything that is not a well-formed app-map link. */
    fun parse(uri: String): AppMapRoute? {
        if (!BuildConfig.APP_MAP_DEBUG) return null
        return parseUnchecked(uri)
    }

    fun parse(uri: Uri): AppMapRoute? = parse(uri.toString())

    /**
     * Applies the fixture (if any) via [AppMapFixtureRegistry], then hands the route to the
     * installed router. Returns false when disabled or no router is installed; fixture failures
     * propagate as [AppMapFixtureException].
     */
    fun dispatch(route: AppMapRoute): Boolean {
        if (!BuildConfig.APP_MAP_DEBUG) return false
        val target = router
        if (target == null) {
            Log.e(TAG, "appmap://${route.screenId} received but no router installed (AppMapDeepLink.installRouter)")
            return false
        }
        route.fixture?.let { AppMapFixtureRegistry.apply(it) }
        target.route(route)
        return true
    }

    // Not gated: exercised directly by unit tests of the grammar. Hand-rolled because
    // java.net.URI returns a null host for names containing '_'.
    internal fun parseUnchecked(raw: String): AppMapRoute? {
        val text = raw.trim()
        val prefix = "$SCHEME://"
        if (!text.regionMatches(0, prefix, 0, prefix.length, ignoreCase = true)) return null
        val rest = text.substring(prefix.length).substringBefore('#')

        val queryIndex = rest.indexOf('?')
        val hostPart = (if (queryIndex >= 0) rest.substring(0, queryIndex) else rest).trimEnd('/')
        val query = if (queryIndex >= 0) rest.substring(queryIndex + 1) else ""
        if (!SCREEN_ID.matches(hostPart)) return null

        val params = LinkedHashMap<String, String>()
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = decode(if (eq >= 0) pair.substring(0, eq) else pair)
            val value = decode(if (eq >= 0) pair.substring(eq + 1) else "")
            if (key.isNotEmpty()) params[key] = value
        }
        val fixture = params.remove("fixture")
        return AppMapRoute(hostPart, fixture, params)
    }

    private fun decode(s: String): String = URLDecoder.decode(s, "UTF-8")
}
