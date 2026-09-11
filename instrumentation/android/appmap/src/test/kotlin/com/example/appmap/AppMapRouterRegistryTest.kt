// Router export JSON shape (01 R6), parsed back with org.json to assert structure rather than text.
package com.example.appmap

import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class AppMapRouterRegistryTest {
    private val build = AppMapBuildInfo(version = "2026.9.1", buildNumber = "4412", gitSha = "a1b2c3d")

    @Before
    fun populate() {
        AppMapRouterRegistry.clearForTests()
        AppMapRouterRegistry.register("invoice_new", "appmap://invoice_new", "InvoiceNewScreen")
        AppMapRouterRegistry.register(
            "invoice_list", "appmap://invoice_list", InvoiceListScreen::class.java,
            title = "Invoices",
            staticEdges = listOf(AppMapEdge.tap("invoice.add.button", to = "invoice_new")),
        )
        AppMapRouterRegistry.registerGate("gate.push_permission", "gate.push_permission.deny")
    }

    @After
    fun reset() = AppMapRouterRegistry.clearForTests()

    @Test
    fun exportMatchesSpecShape() {
        assumeTrue("export exists only in debug builds", BuildConfig.APP_MAP_DEBUG)
        val json = JSONObject(AppMapRouterRegistry.exportJson("com.example.app", build))

        assertEquals(1, json.getInt("schema_version"))
        assertEquals("com.example.app", json.getString("app_id"))
        assertEquals("android", json.getString("platform"))

        val buildObj = json.getJSONObject("build")
        assertEquals("2026.9.1", buildObj.getString("version"))
        assertEquals("4412", buildObj.getString("build_number"))
        assertEquals("a1b2c3d", buildObj.getString("git_sha"))

        val screens = json.getJSONArray("screens")
        assertEquals(2, screens.length())
        val invoiceList = screens.getJSONObject(0)
        assertEquals("invoice_list", invoiceList.getString("id"))
        assertEquals("appmap://invoice_list", invoiceList.getString("route"))
        assertEquals("InvoiceListScreen", invoiceList.getString("view_type"))
        assertEquals("Invoices", invoiceList.getString("title"))
        assertFalse("nil title is omitted", screens.getJSONObject(1).has("title"))
        val edges = invoiceList.getJSONArray("edges")
        assertEquals(1, edges.length())
        val edge = edges.getJSONObject(0)
        assertEquals("tap", edge.getJSONObject("action").getString("type"))
        assertEquals("invoice.add.button", edge.getJSONObject("action").getString("element"))
        assertEquals("invoice_new", edge.getString("to"))
        assertEquals("invoice_new", screens.getJSONObject(1).getString("id"))
        assertEquals(0, screens.getJSONObject(1).getJSONArray("edges").length())

        val gates = json.getJSONArray("gates")
        assertEquals(1, gates.length())
        assertEquals("gate.push_permission", gates.getJSONObject(0).getString("id"))
        assertEquals("gate.push_permission.deny", gates.getJSONObject(0).getString("dismiss"))
    }

    @Test
    fun exportIsDeterministic() {
        assumeTrue(BuildConfig.APP_MAP_DEBUG)
        assertEquals(
            AppMapRouterRegistry.exportJson("com.example.app", build),
            AppMapRouterRegistry.exportJson("com.example.app", build),
        )
    }

    @Test
    fun jsonWriterEscapes() {
        val out = AppMapJson.render(linkedMapOf("k" to "a\"b\\c\nd", "n" to 1, "b" to true, "l" to emptyList<Any>()))
        assertTrue(out.contains("\"a\\\"b\\\\c\\nd\""))
        assertTrue(out.contains("\"l\": []"))
        assertFalse(out.contains("\\/"))
    }

    @Test
    fun exportRefusedInRelease() {
        assumeTrue("only meaningful for testReleaseUnitTest", !BuildConfig.APP_MAP_DEBUG)
        try {
            AppMapRouterRegistry.exportJson("com.example.app", build)
            throw AssertionError("exportJson must throw in release builds (01 §4)")
        } catch (expected: IllegalStateException) {
            // ok
        }
    }

    private class InvoiceListScreen
}
