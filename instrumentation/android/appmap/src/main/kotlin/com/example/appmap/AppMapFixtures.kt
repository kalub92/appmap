// AppMapKit (Android) — fixtures for test-only deep links (01 R5).
//
// Fixtures seed genuine app state (logged-in test account, one draft invoice) before routing.
// They are defined in code — preferably a debug-only module (01 §5) — never in the map, and use
// sandbox fixture accounts only (07 §3). Registration is a no-op in Release builds.
package com.example.appmap

interface AppMapFixtures {
    /** Names this implementation understands, e.g. `listOf("logged_in", "one_draft_invoice")`. */
    val names: List<String>

    /**
     * Applies the named fixture synchronously on the calling (main) thread; keep it fast or
     * pre-seed state at process start. Throw [AppMapFixtureException] for unknown names.
     */
    @Throws(AppMapFixtureException::class)
    fun apply(name: String)
}

class AppMapFixtureException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

object AppMapFixtureRegistry {
    @Volatile
    private var provider: AppMapFixtures? = null

    fun install(fixtures: AppMapFixtures) {
        if (!BuildConfig.APP_MAP_DEBUG) return
        provider = fixtures
    }

    @Throws(AppMapFixtureException::class)
    fun apply(name: String) {
        if (!BuildConfig.APP_MAP_DEBUG) return
        val fixtures = provider ?: throw AppMapFixtureException("fixture '$name' requested but none installed")
        if (name !in fixtures.names) throw AppMapFixtureException("unknown fixture '$name' (known: ${fixtures.names})")
        fixtures.apply(name)
    }
}
