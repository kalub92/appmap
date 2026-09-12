// Deep-link parsing and handler behaviour (01 R5). Compiled only with APP_MAP_DEBUG, i.e. `swift test`
// in the default Debug configuration.

import XCTest
@testable import AppMapKit

#if APP_MAP_DEBUG
final class AppMapDeepLinkTests: XCTestCase {
    func testParsesScreenOnly() {
        XCTAssertEqual(AppMapDeepLink.parse("appmap://invoice_list"), AppMapRoute(screenID: "invoice_list"))
    }

    func testParsesFixtureAndParams() throws {
        let url = try XCTUnwrap(URL(string: "appmap://invoice_new?fixture=logged_in&client=acme&empty"))
        let route = try XCTUnwrap(AppMapDeepLink.parse(url))
        XCTAssertEqual(route.screenID, "invoice_new")
        XCTAssertEqual(route.fixture, "logged_in")
        XCTAssertEqual(route.params, ["client": "acme", "empty": ""])
    }

    func testAcceptsTrailingSlashAndUppercaseScheme() {
        XCTAssertEqual(AppMapDeepLink.parse("appmap://login/")?.screenID, "login")
        XCTAssertEqual(AppMapDeepLink.parse("APPMAP://login")?.screenID, "login")
    }

    func testRejectsOtherSchemes() {
        XCTAssertNil(AppMapDeepLink.parse("https://invoice_new"))
        XCTAssertNil(AppMapDeepLink.parse("example://invoice_new?fixture=logged_in"))
    }

    func testRejectsIdsOutsideNamingRules() {
        XCTAssertNil(AppMapDeepLink.parse("appmap://Invoice-New"))
        XCTAssertNil(AppMapDeepLink.parse("appmap://invoice_new/extra"))
        XCTAssertNil(AppMapDeepLink.parse("appmap://screen.invoice_new"))
        XCTAssertNil(AppMapDeepLink.parse("appmap://"))
    }

    func testHandlerAppliesFixtureThenRoutes() throws {
        let fixtures = SpyFixtures()
        let routed = expectation(description: "routed")
        var received: AppMapRoute?
        let handler = AppMapDeepLinkHandler(fixtures: fixtures) { route in
            received = route
            routed.fulfill()
        }

        let url = try XCTUnwrap(URL(string: "appmap://invoice_new?fixture=logged_in"))
        XCTAssertTrue(handler.handle(url))
        wait(for: [routed], timeout: 2)

        XCTAssertEqual(fixtures.applied, ["logged_in"])
        XCTAssertEqual(received?.screenID, "invoice_new")
        XCTAssertNil(received?.fixture == nil ? nil : received?.params["fixture"])
    }

    func testHandlerDoesNotRouteWhenFixtureFails() throws {
        let fixtures = SpyFixtures()
        fixtures.failing = true
        let notRouted = expectation(description: "not routed")
        notRouted.isInverted = true
        let handler = AppMapDeepLinkHandler(fixtures: fixtures) { _ in notRouted.fulfill() }

        XCTAssertTrue(handler.handle(try XCTUnwrap(URL(string: "appmap://invoice_new?fixture=bogus"))))
        wait(for: [notRouted], timeout: 0.5)
    }

    func testHandlerIgnoresForeignURLs() throws {
        let handler = AppMapDeepLinkHandler { _ in XCTFail("must not route") }
        XCTAssertFalse(handler.handle(try XCTUnwrap(URL(string: "https://example.com/invoice_new"))))
    }
}

private final class SpyFixtures: AppMapFixtures {
    var applied: [String] = []
    var failing = false
    var names: [String] { ["logged_in"] }

    func apply(name: String) async throws {
        if failing { throw AppMapFixtureError.unknown(name: name) }
        applied.append(name)
    }
}
#endif
