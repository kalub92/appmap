// Router export JSON shape (01 R6). The Debug branch checks the document against the spec example;
// the Release branch (`swift test -c release`) checks that the export path is inert.

import XCTest
@testable import AppMapKit

#if APP_MAP_DEBUG
final class AppMapRouterRegistryTests: XCTestCase {
    private struct InvoiceListView {}

    private func populated() -> AppMapRouterRegistry {
        let registry = AppMapRouterRegistry()
        registry.register(id: "invoice_new", route: "appmap://invoice_new", viewTypeName: "InvoiceNewView")
        registry.register(
            id: "invoice_list",
            route: "appmap://invoice_list",
            viewType: InvoiceListView.self,
            title: "Invoices",
            staticEdges: [.tap("invoice.add.button", to: "invoice_new")]
        )
        registry.registerGate(id: "gate.push_permission", dismiss: "gate.push_permission.deny")
        return registry
    }

    func testExportMatchesSpecShape() throws {
        let data = try populated().exportData(
            appID: "com.example.app",
            build: AppMapBuildInfo(version: "2026.9.1", buildNumber: "4412", gitSha: "a1b2c3d")
        )
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["schema_version"] as? Int, 1)
        XCTAssertEqual(json["app_id"] as? String, "com.example.app")
        XCTAssertEqual(json["platform"] as? String, "ios")

        let build = try XCTUnwrap(json["build"] as? [String: Any])
        XCTAssertEqual(build["version"] as? String, "2026.9.1")
        XCTAssertEqual(build["build_number"] as? String, "4412")
        XCTAssertEqual(build["git_sha"] as? String, "a1b2c3d")

        let screens = try XCTUnwrap(json["screens"] as? [[String: Any]])
        XCTAssertEqual(screens.map { $0["id"] as? String }, ["invoice_list", "invoice_new"], "sorted by id")
        let invoiceList = screens[0]
        XCTAssertEqual(invoiceList["route"] as? String, "appmap://invoice_list")
        XCTAssertEqual(invoiceList["view_type"] as? String, "InvoiceListView")
        XCTAssertEqual(invoiceList["title"] as? String, "Invoices")
        XCTAssertNil(screens[1]["title"], "nil title is omitted, not null")
        let edges = try XCTUnwrap(invoiceList["edges"] as? [[String: Any]])
        XCTAssertEqual(edges.count, 1)
        let action = try XCTUnwrap(edges[0]["action"] as? [String: Any])
        XCTAssertEqual(action["type"] as? String, "tap")
        XCTAssertEqual(action["element"] as? String, "invoice.add.button")
        XCTAssertEqual(edges[0]["to"] as? String, "invoice_new")
        XCTAssertEqual((screens[1]["edges"] as? [Any])?.count, 0)

        let gates = try XCTUnwrap(json["gates"] as? [[String: Any]])
        XCTAssertEqual(gates.count, 1)
        XCTAssertEqual(gates[0]["id"] as? String, "gate.push_permission")
        XCTAssertEqual(gates[0]["dismiss"] as? String, "gate.push_permission.deny")

        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("\\/"), "routes must not escape slashes")
    }

    func testExportIsDeterministic() throws {
        let build = AppMapBuildInfo(version: "1", buildNumber: "1", gitSha: "x")
        XCTAssertEqual(try populated().exportData(appID: "a", build: build), try populated().exportData(appID: "a", build: build))
    }

    func testExportIfRequestedWritesFileAndTerminates() throws {
        let path = FileManager.default.temporaryDirectory
            .appendingPathComponent("router-export-\(UUID().uuidString).json").path
        defer { try? FileManager.default.removeItem(atPath: path) }

        var exitCode: Int32?
        populated().exportIfRequested(arguments: ["App", "-AppMapExport", path]) { exitCode = $0 }

        XCTAssertEqual(exitCode, 0)
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        let json = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(json["schema_version"] as? Int, 1)
    }

    func testExportIfRequestedIgnoresUnrelatedArguments() {
        var terminated = false
        populated().exportIfRequested(arguments: ["App", "-SomethingElse", "1"]) { _ in terminated = true }
        populated().exportIfRequested(arguments: ["App", "-AppMapExport"]) { _ in terminated = true }
        XCTAssertFalse(terminated)
    }
}
#else
final class AppMapRouterRegistryReleaseTests: XCTestCase {
    func testExportPathIsInertInRelease() {
        var terminated = false
        let registry = AppMapRouterRegistry()
        registry.register(id: "invoice_list", route: "appmap://invoice_list", viewTypeName: "InvoiceListView")
        registry.exportIfRequested(arguments: ["App", "-AppMapExport", "/tmp/never-written.json"]) { _ in terminated = true }
        XCTAssertFalse(terminated, "Release builds must not honour -AppMapExport (01 §4)")
    }
}
#endif
