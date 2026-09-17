// AppRouter — the coordinator: owns the tab bar, the navigation stacks, the session and the in-memory store.
// Screens ask it to navigate; the debug deep-link mapping reaches screens only through these methods (01 R5).

import UIKit
import LocalAuthentication
import UserNotifications
import AppMapKit

@MainActor
final class AppRouter {
    static let shared = AppRouter()

    private let loginNavigation = UINavigationController(rootViewController: LoginViewController())
    private let invoicesNavigation = UINavigationController(rootViewController: InvoiceListViewController())
    private let clientsNavigation = UINavigationController(rootViewController: AppRouter.placeholder(title: "Clients"))
    private let settingsNavigation = UINavigationController(rootViewController: AppRouter.placeholder(title: "Settings"))
    private lazy var tabBarController = makeTabBarController()

    private(set) var isSignedIn = false
    private(set) var invoices: [Invoice] = []
    private(set) var clients: [Client] = []

    private init() {}

    /// The window's root: the sign-in stack until a session exists, then the tab bar. Containers carry no marker (§9 rule 5).
    var rootViewController: UIViewController {
        isSignedIn ? tabBarController : loginNavigation
    }

    // MARK: Navigation

    func showInvoices() {
        guard isSignedIn else { signOut(); return }
        tabBarController.dismiss(animated: false)
        tabBarController.selectedViewController = invoicesNavigation
        invoicesNavigation.popToRootViewController(animated: false)
    }

    func showInvoiceNew() {
        showInvoices()
        guard isSignedIn else { return }
        let navigation = UINavigationController(rootViewController: InvoiceNewViewController())   // a container gets nothing; the form marks itself (01 R3)
        navigation.modalPresentationStyle = .formSheet
        tabBarController.present(navigation, animated: true)
    }

    func showInvoice(id: String) {
        guard let invoice = invoice(withID: id) else { return }
        showInvoiceDetail(invoice)
    }

    func showInvoiceDetail(_ invoice: Invoice) {
        showInvoices()
        guard isSignedIn else { return }
        let detail = InvoiceDetailViewController()
        detail.configure(invoice: invoice)   // identity arrives after init, which is why the detail VC re-marks in viewWillAppear (design §2.3)
        invoicesNavigation.pushViewController(detail, animated: true)
    }

    /// Production URL handling (universal links). Debug deep links never reach it: the handler answers them first (01 R5).
    @discardableResult
    func handle(_ url: URL) -> Bool {
        let components = url.pathComponents.dropFirst()
        guard components.first == "invoices" else { return false }
        if let id = components.dropFirst().first { showInvoice(id: id) } else { showInvoices() }
        return true
    }

    // MARK: Session

    func signIn(email: String, password: String) throws {
        guard !email.isEmpty, !password.isEmpty else { throw SignInError.missingCredentials }
        completeSignIn()   // the sample has no backend; a real app awaits its session here
    }

    /// The Face ID / Touch ID prompt is an OS dialog: the map records its label signature as the biometric gate, nothing here can carry an id (01 R7).
    func signInWithBiometrics() {
        let context = LAContext()
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Sign in to your invoices") { success, _ in
            guard success else { return }
            Task { @MainActor in self.completeSignIn() }
        }
    }

    func signOut() {
        isSignedIn = false
        tabBarController.dismiss(animated: false)
        loginNavigation.popToRootViewController(animated: false)
        swapRoot(to: loginNavigation)
    }

    private func completeSignIn() {
        isSignedIn = true
        swapRoot(to: tabBarController)
        // The push-permission prompt is an OS dialog too: a gate with a label signature in the map, nothing to id in code (01 R7).
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }

    // MARK: Store

    func add(_ invoice: Invoice) {
        invoices.append(invoice)
    }

    func update(_ invoice: Invoice) {
        guard let index = invoices.firstIndex(where: { $0.id == invoice.id }) else { return }
        invoices[index] = invoice
    }

    func invoice(withID id: String) -> Invoice? {
        invoices.first { $0.id == id }
    }

    // MARK: Assembly

    /// Built once. Tab items are id'd HERE, at the assembly site: a child's viewDidLoad runs only when its tab is first
    /// selected, so an id set there is missing until then (design §2.3).
    private func makeTabBarController() -> UITabBarController {
        invoicesNavigation.tabBarItem = UITabBarItem(title: "Invoices", image: UIImage(systemName: "doc.text"), tag: 0)
        invoicesNavigation.tabBarItem.accessibilityIdentifier = AppMapID.Element.navInvoicesTab   // UITabBarItem is not a UIView: assign the constant directly (01 R8)
        clientsNavigation.tabBarItem = UITabBarItem(title: "Clients", image: UIImage(systemName: "person.2"), tag: 1)
        clientsNavigation.tabBarItem.accessibilityIdentifier = AppMapID.Element.navClientsTab
        settingsNavigation.tabBarItem = UITabBarItem(title: "Settings", image: UIImage(systemName: "gearshape"), tag: 2)
        settingsNavigation.tabBarItem.accessibilityIdentifier = AppMapID.Element.navSettingsTab
        let controller = UITabBarController()
        controller.setViewControllers([invoicesNavigation, clientsNavigation, settingsNavigation], animated: false)   // containers: no marker on the tab bar or the nav controllers (issue #15)
        return controller
    }

    /// Tab roots outside the pilot slice; a real root is a screen VC that marks itself in its own viewDidLoad (01 R3).
    private static func placeholder(title: String) -> UIViewController {
        let controller = UIViewController()
        controller.title = title
        return controller
    }

    private func swapRoot(to controller: UIViewController) {
        guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return }
        window.rootViewController = controller
        UIView.transition(with: window, duration: 0.25, options: .transitionCrossDissolve, animations: nil)
    }
}

// MARK: - Model

struct Invoice: Hashable, Identifiable {
    enum Status: String {
        case draft
        case sent
    }

    let id: String
    var client: String
    var amount: Decimal
    var due: Date
    var note: String
    var status: Status
    var items: [InvoiceItem]
}

struct InvoiceItem: Hashable, Identifiable {
    let id: String
    var title: String
    var amount: Decimal
}

struct Client: Hashable, Identifiable {
    let id: String
    var name: String
}

enum SignInError: LocalizedError {
    case missingCredentials

    var errorDescription: String? {
        "Enter your email and password."
    }
}
