// AppMapKit — fixtures for test-only deep links (01 R5).
//
// Fixtures seed genuine app state (a logged-in test account, one draft invoice) before routing.
// They are defined in code — preferably a debug-only module (01 §5) — never in the map, and use
// sandbox fixture accounts only (07 §3). The protocol exists only under APP_MAP_DEBUG so a
// Release build cannot even declare one.

#if APP_MAP_DEBUG
public protocol AppMapFixtures: AnyObject {
    /// Names this implementation understands, e.g. `["logged_in", "one_draft_invoice"]`.
    var names: [String] { get }

    /// Applies the named fixture. Throw `AppMapFixtureError.unknown` for names not in `names`.
    /// Must leave the app in a state the real router can navigate from.
    func apply(name: String) async throws
}

public enum AppMapFixtureError: Error, Equatable {
    case unknown(name: String)
}
#endif
