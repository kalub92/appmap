// AppMapKit (Android) — test-only deep links (01 R5).
//
// Scheme: <scheme>://<screen_id>[?fixture=<name>&k=v…], `appmap` by default and configurable per
// app via AppMapDeepLink.scheme (issue #25: two instrumented apps on one device otherwise collide).
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
    /**
     * The default scheme. Every app-map app used to register exactly this, which meant two
     * instrumented apps on one device both claimed it and the OS delivered `appmap://<screen>` —
     * and the `?fixture=` it carries — to whichever it liked, while the app-scoped capture kept
     * describing the other one and timed out (issue #25).
     *
     * Set [scheme] from Application.onCreate in debug builds when more than one app-map app can be
     * installed at once, and declare the SAME value as `deep_link_scheme` in
     * `app-map/android/manifest.yaml` and as the `android:scheme` of the debug intent-filter.
     * `appmap-<last component of the application id>` is the conventional choice.
     */
    const val DEFAULT_SCHEME = "appmap"

    @Volatile
    var scheme: String = DEFAULT_SCHEME
        set(value) {
            val trimmed = value.trim().lowercase()
            require(SCHEME_PATTERN.matches(trimmed)) { "app-map deep link scheme must match ${SCHEME_PATTERN.pattern}, got '$value'" }
            field = trimmed
        }

    /** Kept for source compatibility with integrations written before the scheme was configurable. */
    @Deprecated("read `scheme`; it is configurable per app (issue #25)", ReplaceWith("scheme"))
    const val SCHEME = DEFAULT_SCHEME

    /** RFC 3986 `scheme`, narrowed the same way the manifest schema narrows it. */
    private val SCHEME_PATTERN = Regex("^[a-z][a-z0-9+.-]{0,63}$")
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
            Log.e(TAG, "$scheme://${route.screenId} received but no router installed (AppMapDeepLink.installRouter)")
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
        val prefix = "$scheme://"
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
