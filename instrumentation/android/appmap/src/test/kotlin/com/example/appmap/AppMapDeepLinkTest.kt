// Deep-link grammar (01 R5). `parseUnchecked` is tested in every variant; `parse` is gated on
// BuildConfig.APP_MAP_DEBUG so `testReleaseUnitTest` proves the handler is inert (01 §4).
package com.example.appmap

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class AppMapDeepLinkTest {
    @Test
    fun parsesScreenOnly() {
        assertEquals(AppMapRoute("invoice_list"), AppMapDeepLink.parseUnchecked("appmap://invoice_list"))
    }

    @Test
    fun parsesFixtureAndParams() {
        val route = AppMapDeepLink.parseUnchecked("appmap://invoice_new?fixture=logged_in&client=acme%20co&empty")
        assertNotNull(route)
        assertEquals("invoice_new", route!!.screenId)
        assertEquals("logged_in", route.fixture)
        assertEquals(mapOf("client" to "acme co", "empty" to ""), route.params)
    }

    @Test
    fun acceptsTrailingSlashUppercaseSchemeAndFragment() {
        assertEquals("login", AppMapDeepLink.parseUnchecked("appmap://login/")?.screenId)
        assertEquals("login", AppMapDeepLink.parseUnchecked("APPMAP://login")?.screenId)
        assertEquals("login", AppMapDeepLink.parseUnchecked("appmap://login#x")?.screenId)
    }

    @Test
    fun rejectsOtherSchemes() {
        assertNull(AppMapDeepLink.parseUnchecked("https://invoice_new"))
        assertNull(AppMapDeepLink.parseUnchecked("example://invoice_new?fixture=logged_in"))
    }

    @Test
    fun rejectsIdsOutsideNamingRules() {
        assertNull(AppMapDeepLink.parseUnchecked("appmap://Invoice-New"))
        assertNull(AppMapDeepLink.parseUnchecked("appmap://invoice_new/extra"))
        assertNull(AppMapDeepLink.parseUnchecked("appmap://screen.invoice_new"))
        assertNull(AppMapDeepLink.parseUnchecked("appmap://"))
    }

    @Test
    fun parseIsGatedOnBuildFlag() {
        val route = AppMapDeepLink.parse("appmap://invoice_new?fixture=logged_in")
        if (BuildConfig.APP_MAP_DEBUG) {
            assertEquals("invoice_new", route?.screenId)
        } else {
            assertNull("release builds must not parse appmap:// links (01 §4)", route)
        }
    }
}
