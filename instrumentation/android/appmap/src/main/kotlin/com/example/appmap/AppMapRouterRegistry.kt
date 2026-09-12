// AppMapKit (Android) — debug-only router export (01 R6).
//
// Screens register (id, route, viewType, staticEdges) from Application.onCreate (so a
// manifest-declared receiver sees them even when no Activity is running). The debug-only
// AppMapExportReceiver writes exportJson() to a file on `<applicationId>.APPMAP_EXPORT`.
// Registration is a no-op in Release and exportJson() refuses to run there (01 §4).
package com.example.appmap

import android.content.Context
import android.os.Build
import android.util.Log

data class AppMapAction(val type: String, val element: String? = null) {
    companion object {
        fun tap(element: String) = AppMapAction("tap", element)
    }
}

data class AppMapEdge(val action: AppMapAction, val to: String) {
    companion object {
        fun tap(element: String, to: String) = AppMapEdge(AppMapAction.tap(element), to)
    }
}

data class AppMapBuildInfo(val version: String, val buildNumber: String, val gitSha: String) {
    companion object {
        /** Placeholder that still satisfies the schema's hex pattern when no sha was wired up. */
        const val UNKNOWN_GIT_SHA = "0000000"

        /** versionName / versionCode from PackageManager; git sha from [gitSha] or [AppMapRouterRegistry.gitSha]. */
        fun current(context: Context, gitSha: String? = null): AppMapBuildInfo {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
                @Suppress("DEPRECATION")
                info.versionCode.toLong()
            }
            return AppMapBuildInfo(info.versionName ?: "0", code.toString(), gitSha ?: AppMapRouterRegistry.gitSha)
        }
    }
}

object AppMapRouterRegistry {
    private class Screen(val id: String, val route: String, val viewType: String, val title: String?, val edges: List<AppMapEdge>)

    private val screens = sortedMapOf<String, Screen>()
    private val gates = sortedMapOf<String, String>()

    /** Set from the app's own BuildConfig (e.g. `AppMapRouterRegistry.gitSha = BuildConfig.GIT_SHA`). */
    @Volatile
    var gitSha: String = AppMapBuildInfo.UNKNOWN_GIT_SHA

    /** `route` is the screen's deep link (`appmap://<id>`) or `"none"`; `title` is the static nav title. */
    fun register(id: String, route: String, viewType: Class<*>, title: String? = null, staticEdges: List<AppMapEdge> = emptyList()) =
        register(id, route, viewType.simpleName, title, staticEdges)

    @Synchronized
    fun register(id: String, route: String, viewTypeName: String, title: String? = null, staticEdges: List<AppMapEdge> = emptyList()) {
        if (!BuildConfig.APP_MAP_DEBUG) return
        screens[id] = Screen(id, route, viewTypeName, title, staticEdges.toList())
    }

    /** Registers an interrupter and its dismiss control (01 R7). */
    @Synchronized
    fun registerGate(id: String, dismiss: String) {
        if (!BuildConfig.APP_MAP_DEBUG) return
        gates[id] = dismiss
    }

    /**
     * Placeholder that still satisfies the schema's `app_id` pattern
     * (`^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$`) when the caller has no application id.
     * Mirrors `AppMapRouterRegistry.unknownAppID` on iOS: an id that fails the pattern makes
     * `app-map import-router` reject the whole export with a schema error (01 R6).
     */
    const val UNKNOWN_APP_ID: String = "app.unknown"

    /** Pure: `appId` when it looks like a reverse-DNS application id, else [UNKNOWN_APP_ID]. */
    internal fun resolveAppId(appId: String?): String {
        val pattern = Regex("^[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z][A-Za-z0-9_]*)+$")
        if (appId != null && pattern.matches(appId)) return appId
        Log.e("AppMap", "application id $appId is not a valid app_id; writing $UNKNOWN_APP_ID (01 R6)")
        return UNKNOWN_APP_ID
    }

    /** The 01 R6 document. Screens and gates are sorted by id. Throws in Release builds. */
    @Synchronized
    fun exportJson(appId: String, build: AppMapBuildInfo): String {
        check(BuildConfig.APP_MAP_DEBUG) { "router export is not available in release builds (01 §4)" }
        val doc = linkedMapOf<String, Any?>(
            "schema_version" to 1,
            "app_id" to resolveAppId(appId),
            "platform" to "android",
            "build" to linkedMapOf(
                "version" to build.version,
                "build_number" to build.buildNumber,
                "git_sha" to build.gitSha,
            ),
            "screens" to screens.values.map { s ->
                linkedMapOf<String, Any?>(
                    "id" to s.id,
                    "route" to s.route,
                    "view_type" to s.viewType,
                ).also { m ->
                    s.title?.let { m["title"] = it }
                    m["edges"] = s.edges.map { e ->
                        linkedMapOf(
                            "action" to linkedMapOf<String, Any?>("type" to e.action.type).also { m ->
                                e.action.element?.let { m["element"] = it }
                            },
                            "to" to e.to,
                        )
                    }
                },
            },
            "gates" to gates.map { (id, dismiss) -> linkedMapOf("id" to id, "dismiss" to dismiss) },
        )
        return AppMapJson.render(doc)
    }

    @Synchronized
    internal fun clearForTests() {
        screens.clear()
        gates.clear()
        gitSha = AppMapBuildInfo.UNKNOWN_GIT_SHA
    }
}

/** Minimal JSON writer for the fixed export shape; no framework dependency so it runs on the JVM. */
internal object AppMapJson {
    fun render(value: Any?): String = StringBuilder().also { write(value, it, 0) }.append('\n').toString()

    private fun write(value: Any?, out: StringBuilder, indent: Int) {
        when (value) {
            null -> out.append("null")
            is String -> quote(value, out)
            is Boolean, is Number -> out.append(value.toString())
            is Map<*, *> -> {
                if (value.isEmpty()) { out.append("{}"); return }
                out.append("{\n")
                value.entries.forEachIndexed { i, (k, v) ->
                    pad(out, indent + 1); quote(k.toString(), out); out.append(": "); write(v, out, indent + 1)
                    if (i < value.size - 1) out.append(',')
                    out.append('\n')
                }
                pad(out, indent); out.append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) { out.append("[]"); return }
                out.append("[\n")
                value.forEachIndexed { i, v ->
                    pad(out, indent + 1); write(v, out, indent + 1)
                    if (i < value.size - 1) out.append(',')
                    out.append('\n')
                }
                pad(out, indent); out.append(']')
            }
            else -> quote(value.toString(), out)
        }
    }

    private fun pad(out: StringBuilder, indent: Int) { repeat(indent) { out.append("  ") } }

    private fun quote(s: String, out: StringBuilder) {
        out.append('"')
        for (c in s) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }
}
