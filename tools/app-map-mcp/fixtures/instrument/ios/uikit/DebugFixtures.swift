// DebugFixtures — seeds genuine sandbox state before a debug deep link routes (01 R5, 07 §3).
// Exists only under APP_MAP_DEBUG; bodies stay TODO until a human writes them, never an invented value.

import UIKit
import AppMapKit

#if APP_MAP_DEBUG
final class DebugFixtures: AppMapFixtures {
    let names = ["logged_in", "one_draft_invoice"]           // every fixtures_needed[].name of the plan

    func apply(name: String) async throws {
        switch name {
        case "logged_in":
            // TODO(app-map fixture): AppRouter.shared.signIn(email:password:) with the sandbox fixture account
            throw FixtureTodo(name: name)
        case "one_draft_invoice":
            // TODO(app-map fixture): logged_in, then AppRouter.shared.add(_:) one draft invoice so invoice_detail has an invoice_id
            throw FixtureTodo(name: name)
        default:
            throw AppMapFixtureError.unknown(name: name)      // the contract: names not in `names` are .unknown
        }
    }
}

/// A fixture the plan named whose seeding is not written yet: the handler logs it and does not route.
private struct FixtureTodo: Error {
    let name: String
}
#endif
