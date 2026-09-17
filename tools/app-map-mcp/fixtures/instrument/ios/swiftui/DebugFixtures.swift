// Invoices — fixtures for app-map deep links (01 R5). Genuine state through the app's own APIs, sandbox
// accounts only; a seeding step nobody has written yet fails loudly instead of inventing data.

import SwiftUI
import AppMapKit

#if APP_MAP_DEBUG
final class DebugFixtures: AppMapFixtures {
    let names = ["logged_in", "one_draft_invoice"]

    func apply(name: String) async throws {
        switch name {
        case "logged_in":
            // TODO(app-map fixture): sign in with the sandbox test account through the app's real session API
            throw FixtureTodo(name: name)
        case "one_draft_invoice":
            // TODO(app-map fixture): after logged_in, create one draft invoice the detail link can address by invoice_id
            throw FixtureTodo(name: name)
        default:
            throw AppMapFixtureError.unknown(name: name)        // the protocol contract for a name not in `names`
        }
    }
}

/// A fixture whose seeding step is still a TODO: the link fails instead of routing into fake state.
private struct FixtureTodo: Error {
    let name: String
}
#endif
