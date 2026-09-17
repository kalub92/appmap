# UIKit patterns — where every marker and id goes (01 R3, 01 R4, 01 R7)

Read by `app-instrument-uikit` before its first edit. The plan (`reference/survey-plan.md`) names the file, the
`anchor` line and the `constant`; this file says which statement goes there and what stays untouched. Every shape
uses pilot ids only; a name the pilot lacks is an angle-bracket placeholder (`AppMapID.Gate.<name>`) that the plan's
`constant` replaces. Never write a name yourself.

Two calls, both from `AppMapKit`, both shipping in every build (01 §2):

- `appMapScreen(_:)` on a `UIViewController` marks `view`: the root becomes an accessibility container carrying
  `screen.<id>` (`isAccessibilityElement = false`) and a 1 pt, non-hit-testable marker subview carrying the same id is
  installed inside it — the flat tree a driver reads lists elements, not containers (issue #15). It is idempotent: a
  second call retargets the installed marker, so `viewDidLoad` plus `viewWillAppear` is safe. It adds one entry to
  `subviews` and sets the root's `isAccessibilityElement` to false; both are risks the surveyor flags.
- `appMapID(_:)` on a `UIView` sets `accessibilityIdentifier`. `UIBarButtonItem` and `UITabBarItem` are not views:
  assign `accessibilityIdentifier = <constant>` directly.

Where the id line lands: on the line after the anchor when the anchor is a statement (inside `viewDidLoad`, a setup
method, `awakeFromNib`, a cell handler). When the anchor is a stored-property declaration, the call goes into
`viewDidLoad` after the marker — a call cannot sit at type scope. Never move, reorder or extract the host's code
(rule 3).

## Pattern table

| Construct | Where the call goes | Never |
|---|---|---|
| Screen VC, `marker_site: viewDidLoad` | `appMapScreen(<constant>)` as the first statement after `super.viewDidLoad()` | `init`, `loadView`, `viewDidLayoutSubviews`; a second marker on the same VC |
| Reused VC with modes, `marker_site: viewWillAppear`, `mode_condition` | a `switch` after `super.viewWillAppear(animated)`, one constant per case; keep a `viewDidLoad` call too (idempotent) | a constant chosen by string building |
| Custom `loadView` | still `viewDidLoad` | `loadView` |
| `UINavigationController`, `UITabBarController`, `UISplitViewController`, `UIPageViewController`, hosting controller, `addChild` child, VC listed as `hosted_by` | nothing; the content VC or the SwiftUI root marks itself (`marker_site: none_hosted` items are confirmed, not edited) | `appMapScreen` on the container (issue #15) |
| Presented VC, any `modalPresentationStyle` (`.pageSheet`, `.formSheet`, `.fullScreen`, `.overFullScreen`, `.popover`) | its own `viewDidLoad`, like any screen; a wrapping `UINavigationController` gets nothing | anything on the presenting VC |
| Programmatic `UIButton`, `UITextField`, `UITextView`, `UISwitch`, `UILabel` bound to data | `control.appMapID(<constant>)` | `accessibilityLabel`, `isAccessibilityElement` edits |
| `UIBarButtonItem`, `UITabBarItem` | `item.accessibilityIdentifier = <constant>` | `appMapID` (not a view); a literal; a new item |
| Tab bar items | the assembly site (`setViewControllers`, coordinator) or the child's `init` | the child's `viewDidLoad` (runs only when the tab is first selected) |
| Back button | an identifier on an existing custom `backBarButtonItem` / `leftBarButtonItem` only | creating one (visible change) → `skipped`, note `back_button_label_matched` |
| `UISearchBar` | `searchBar.searchTextField.appMapID(<constant>)` | the bar itself; `UISearchController` internals |
| `UISegmentedControl`, `UIPickerView`, `UIDatePicker`, `UIStepper`, `UISlider`, `UIPageControl` | one id on the control (`kind: picker`); values are addressed at runtime | per-segment or per-row ids |
| `UITableView`, `UICollectionView` | `table.appMapID(<constant>)` (`kind: list`, `dynamic: true`) | ids on section headers or footers |
| Cells | `cell.appMapID(<constant>)` on **every** dequeue: `cellForRowAt`, the `UICollectionView.CellRegistration` handler, the diffable `cellProvider`; `awakeFromNib` or `init(style:reuseIdentifier:)` for a single-purpose cell class | a one-time set outside the dequeue path |
| Controls inside cells | their own four-segment id (`<feature>.<list>.<name>.<kind>`, id-rules §B), set with the cell's content on every dequeue | the cell's id on the control |
| `UIHostingConfiguration` cell | `cell.appMapID(<constant>)` on the cell only; the SwiftUI content is cell content | `appMapScreen` on the content (never a screen) |
| IB-backed VC (storyboard, XIB) | through existing `@IBOutlet`s in `viewDidLoad`; prototype cells in `awakeFromNib` | editing `.storyboard`/`.xib`; a control without an outlet → `blocked`, note `ib_outlet_missing` |
| Custom dialog VC (in-app gate, `gate.native: false`) | `appMapScreen(AppMapID.Gate.<name>)` in `viewDidLoad`; cancel `AppMapID.Gate.Dismiss.<name>`; other controls `AppMapID.Gate.Control.<name>` | anything on the presenter |
| `UIAlertController`, alert or action sheet (`gate.native: true`) | nothing: registry entry plus `registerGate(id:dismiss:)` in the wiring | `alert.view.appMapScreen(...)`; KVC on a `UIAlertAction` |
| Coordinator-derived static edges | the screen item's `static_edges[]` → `register(id:route:viewType:title:staticEdges:)` in `AppMapWiring` (bare ids; `reference/debug-wiring.md`) | edge code in the VC |
| `risk: subviews_indexing` | the marker after the indexing code path when it is in the same method, else `blocked` | reordering the host's statements |
| `risk: root_is_a11y_element` | `blocked` — the marker sets `view.isAccessibilityElement = false` in every build | flipping the flag |
| Objective-C (`.m`, `.h`) | out of scope: every item `skipped`, note `objc_file` | a bridging shim, an `@objc` wrapper |

## Code shapes

### Screen marker in `viewDidLoad` with programmatic controls

```swift
import UIKit
import AppMapKit

final class LoginViewController: UIViewController {
    private let emailField = UITextField()
    private let passwordField = UITextField()
    private let errorLabel = UILabel()
    private let submitButton = UIButton(type: .system)
    private let biometricButton = UIButton(type: .system)
    private let forgotButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.login)                          // 01 R3: first statement, exactly once
        emailField.appMapID(AppMapID.Element.loginEmailField)         // 01 R4: one call per control
        passwordField.appMapID(AppMapID.Element.loginPasswordField)
        errorLabel.appMapID(AppMapID.Element.loginErrorText)          // bound label: dynamic in ids.yaml, id set once
        submitButton.appMapID(AppMapID.Element.loginSubmitButton)
        biometricButton.appMapID(AppMapID.Element.loginBiometricButton)
        forgotButton.appMapID(AppMapID.Element.loginForgotLink)
        buildLayout()                                                 // the host's own code, untouched
    }
}
```

### Reused VC: `viewWillAppear` marker with `mode_condition`

The registry holds one screen per mode. Identity set after `init` (a coordinator's `configure(for:)`) means
`viewDidLoad` may run before the mode is known, so the switch lives in `viewWillAppear`; the `viewDidLoad` call keeps
the default constant referenced and is harmless because the marker retargets.

```swift
final class InvoiceViewController: UIViewController {
    enum Mode { case create, detail }
    private var mode: Mode = .create

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.invoiceNew)                     // default mode; retargeted below if it changed
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)                               // marker_site: viewWillAppear
        switch mode {                                                // mode_condition, one constant per case
        case .create: appMapScreen(AppMapID.Screen.invoiceNew)
        case .detail: appMapScreen(AppMapID.Screen.invoiceDetail)
        }
    }
}
```

### Containers, hosting controllers and `addChild` children get nothing

```swift
let picker = ClientPickerViewController()                            // marks itself in its own viewDidLoad
let nav = UINavigationController(rootViewController: picker)         // no marker: a container, not a screen
nav.modalPresentationStyle = .pageSheet                              // every presented VC is a screen, whatever the style
present(nav, animated: true)

final class InvoiceHostingController: UIHostingController<AnyView> { // no appMapScreen here:
}                                                                    // the SwiftUI root carries the marker once (issue #15)
```

A hosting VC that already calls `appMapScreen` is `blocked`, note `double_marked` — never delete a shipping identifier.

### Bar button items and tab bar items

```swift
// InvoiceListViewController.viewDidLoad
let addItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(addTapped))
addItem.accessibilityIdentifier = AppMapID.Element.invoiceAddButton        // not a UIView: assign the constant directly
let filterItem = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease.circle"),
                                 style: .plain, target: self, action: #selector(filterTapped))
filterItem.accessibilityIdentifier = AppMapID.Element.invoiceFilterButton
navigationItem.rightBarButtonItems = [addItem, filterItem]
```

Tab items belong to the assembly site — a child's `viewDidLoad` runs only when its tab is first selected, so a tab
id set there is missing until then:

```swift
@MainActor
final class AppRouter {
    static let shared = AppRouter()
    let tabBarController = UITabBarController()
    private let invoicesNav = UINavigationController(rootViewController: InvoiceListViewController())
    private let clientsNav = UINavigationController(rootViewController: ClientListViewController())
    private let settingsNav = UINavigationController(rootViewController: SettingsViewController())

    func start(in window: UIWindow) {
        invoicesNav.tabBarItem.accessibilityIdentifier = AppMapID.Element.navInvoicesTab   // assembly site
        clientsNav.tabBarItem.accessibilityIdentifier = AppMapID.Element.navClientsTab
        settingsNav.tabBarItem.accessibilityIdentifier = AppMapID.Element.navSettingsTab
        tabBarController.setViewControllers([invoicesNav, clientsNav, settingsNav], animated: false)
        window.rootViewController = tabBarController                 // no marker on the tab bar or the nav controllers
    }
}
```

### Back button: only an existing custom item

```swift
// InvoiceDetailViewController.viewDidLoad — the app already replaces the system back button:
navigationItem.leftBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "chevron.left"),
                                                   style: .plain, target: self, action: #selector(backTapped))
navigationItem.leftBarButtonItem?.accessibilityIdentifier = AppMapID.Element.invoiceDetailBackButton
```

With no custom item the system back button is matched by its label at run time; the item is `skipped`, note
`back_button_label_matched`. Creating a bar item is a visible change (rule 3).

### Search bar, pickers, segmented controls

```swift
searchBar.searchTextField.appMapID(AppMapID.Element.clientPickerSearchField)   // the text field is the element
dueDatePicker.appMapID(AppMapID.Element.invoiceDuePicker)                      // UIDatePicker: one id, value at runtime
clientButton.appMapID(AppMapID.Element.invoiceClientPicker)                    // a button that presents a picker: kind picker
statusControl.appMapID(AppMapID.Element.<name>)                                // UISegmentedControl: one id, never per segment
```

### Tables, collections and cells

The container is an element (`kind: list`, `dynamic: true`). Cells are reused, so the id is set on every dequeue —
inside `cellForRowAt`, the `CellRegistration` handler or the diffable `cellProvider`, never once at setup.

```swift
// UITableView + cellForRowAt (ClientPickerViewController)
override func viewDidLoad() {
    super.viewDidLoad()
    appMapScreen(AppMapID.Screen.clientPicker)
    tableView.appMapID(AppMapID.Element.clientPickerList)
}

func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = tableView.dequeueReusableCell(withIdentifier: "client", for: indexPath)
    cell.appMapID(AppMapID.Element.clientPickerCell)                 // every dequeue (01 R4)
    var content = cell.defaultContentConfiguration()
    content.text = clients[indexPath.row].name
    cell.contentConfiguration = content
    return cell
}
```

```swift
// UICollectionView + CellRegistration + diffable data source (InvoiceListViewController)
private lazy var cellRegistration = UICollectionView.CellRegistration<UICollectionViewListCell, Invoice> { cell, _, invoice in
    var content = cell.defaultContentConfiguration()
    content.text = invoice.number
    cell.contentConfiguration = content
    cell.appMapID(AppMapID.Element.invoiceListCell)                  // the handler runs on every dequeue
}

private lazy var dataSource = UICollectionViewDiffableDataSource<Int, Invoice.ID>(collectionView: collectionView) {
    [unowned self] collectionView, indexPath, id in
    collectionView.dequeueConfiguredReusableCell(using: cellRegistration, for: indexPath, item: store.invoice(id))
}

override func viewDidLoad() {
    super.viewDidLoad()
    appMapScreen(AppMapID.Screen.invoiceList)
    collectionView.appMapID(AppMapID.Element.invoiceListCollection)
}
```

```swift
// UITableViewDiffableDataSource: the provider is the dequeue path (InvoiceDetailViewController)
dataSource = UITableViewDiffableDataSource<Int, LineItem.ID>(tableView: itemsTable) { tableView, indexPath, _ in
    let cell = tableView.dequeueReusableCell(withIdentifier: "item", for: indexPath)
    cell.appMapID(AppMapID.Element.invoiceDetailItemCell)
    return cell
}
itemsTable.appMapID(AppMapID.Element.invoiceDetailItemsList)
```

A single-purpose cell class (one class, one registry id) may mark itself instead; a class shared by several lists is
id'd at the dequeue site:

```swift
final class ClientCell: UITableViewCell {
    override func awakeFromNib() {                                   // storyboard / XIB prototype
        super.awakeFromNib()
        appMapID(AppMapID.Element.clientPickerCell)
    }
    // programmatic cell class: the same call after super.init(style:reuseIdentifier:)
}
```

Controls inside a cell carry their own four-segment id (id-rules §B), set with the content on every dequeue:

```swift
let registration = UICollectionView.CellRegistration<ItemCell, LineItem> { cell, _, item in
    cell.appMapID(AppMapID.Element.invoiceDetailItemCell)
    cell.removeButton.appMapID(AppMapID.Element.<name>)              // <feature>.<list>.<name>.<kind>, never the cell's id
}
```

`UIHostingConfiguration` content is cell content, never a screen: the cell gets its id, the SwiftUI content gets no
`appMapScreen`; controls inside it are SwiftUI items (`reference/swiftui-patterns.md`).

```swift
let registration = UICollectionView.CellRegistration<UICollectionViewCell, Invoice> { cell, _, invoice in
    cell.contentConfiguration = UIHostingConfiguration { InvoiceRow(invoice: invoice) }
    cell.appMapID(AppMapID.Element.invoiceListCell)                  // on the cell only
}
```

### IB-backed view controllers: through outlets, never through the XML

`lint-ids` scans `.swift` and `.m`, never `.storyboard`/`.xib`, so an identifier typed in Interface Builder is
invisible to it and a marker set there does not count as a reference (01 R8). Set ids in code through the outlets the
VC already has:

```swift
final class LoginViewController: UIViewController {
    @IBOutlet private var emailField: UITextField!
    @IBOutlet private var passwordField: UITextField!
    @IBOutlet private var submitButton: UIButton!

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.login)
        emailField.appMapID(AppMapID.Element.loginEmailField)         // the outlet is the anchor; IB XML untouched
        passwordField.appMapID(AppMapID.Element.loginPasswordField)
        submitButton.appMapID(AppMapID.Element.loginSubmitButton)
    }

    @IBAction private func didTapSubmit(_ sender: UIButton) { signIn() }
}
```

A control with no outlet is `blocked`, note `ib_outlet_missing` (the human adds the outlet). An IB identifier that
already equals a registered id (`existing_literal`) is left alone and listed in the report (`ib_identifier`); a
storyboard scene's `customClass` is the VC you mark.

### In-app gate: a custom dialog VC

Presented `.overFullScreen`/`.overCurrentContext`/`.custom` with a backdrop that blocks taps. The marker is the gate
id on the dialog root, the cancel control is the dismiss id (the safe escape, 01 R7), every other control is a
`controls[]` entry with its own `intent_critical`. The presenting VC gets nothing.

```swift
final class RemovalConfirmationViewController: UIViewController {
    private let cancelButton = UIButton(type: .system)
    private let confirmButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Gate.<name>)                           // gate marker on the dialog root
        cancelButton.appMapID(AppMapID.Gate.Dismiss.<name>)          // gate.dismiss_constant
        confirmButton.appMapID(AppMapID.Gate.Control.<name>)         // gate.controls[].constant
    }
}
```

### Native gate: `UIAlertController` gets no code

An alert or action sheet is an OS dialog: the map stores its label signature (02 §4.2), recorded by a later
`name_screen`/`mark` session. The code side is the registry entry and the wiring's
`registerGate(id:dismiss:)` (`reference/debug-wiring.md`); the dialog itself is untouched.

```swift
let alert = UIAlertController(title: title, message: nil, preferredStyle: .actionSheet)
alert.addAction(UIAlertAction(title: cancelTitle, style: .cancel))
alert.addAction(UIAlertAction(title: deleteTitle, style: .destructive) { [weak self] _ in self?.deleteInvoice() })
present(alert, animated: true)
// never: alert.view.appMapScreen(AppMapID.Gate.<name>) — injects a subview into a system alert in every build (01 §2)
// never: alert.actions[0].setValue(..., forKey: "accessibilityIdentifier") — private KVC, no public API
```

### `risk: subviews_indexing`

The marker adds one entry to `view.subviews`. Code that indexes positionally (`subviews.first`, `subviews[0]`,
`subviews.count`) sees it, so the marker goes **after** that code path when both are in the same method; when the
indexing lives elsewhere (`viewDidLayoutSubviews`, a helper), the item is `blocked`, note `subviews_indexing`.

```swift
override func viewDidLoad() {
    super.viewDidLoad()
    let backdrop = view.subviews.first                               // positional: must run before the marker exists
    backdrop?.alpha = 0.5
    appMapScreen(AppMapID.Screen.invoiceDetail)                      // after the indexing path, not first
}
```

### `risk: root_is_a11y_element`

```swift
view.isAccessibilityElement = true                                   // anywhere in the VC → blocked, note root_is_a11y_element
```

`appMapScreen` sets it to `false` in every build so the children stay reachable; flipping the host's choice is a
production change (rule 3), so the item is reported, not edited.

### Objective-C files are out of scope

`AppMapID` is a Swift enum of static constants with no Objective-C representation, so a `.m`/`.h` file cannot reference
it and a literal there would be a `string_literal_id`. Every item on such a file is `skipped`, note `objc_file`; the
report carries the `objc_file` decision (a bridge is a human choice).
