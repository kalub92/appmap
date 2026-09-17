# SwiftUI patterns — where the marker and the ids go (01 R3, 01 R4, 01 R7)

Code shapes for `app-instrument-swiftui`. Four facts decide every edit:

- A screen root gets `.appMapScreen(AppMapID.Screen.<x>)` as the **last** modifier on the outermost expression of its
  `body`, after `.navigationTitle`, `.toolbar`, `.sheet`, `.navigationDestination`. It is a container plus a 1 pt marker
  element; never "simplify" it to a bare `.accessibilityIdentifier` (issue #15).
- A control or row gets `.appMapID(<constant>)` directly on itself, after its own modifiers.
- `List`, `Section` and `ForEach` never carry an id: the row does (issue #19). `kind: list` ids are UIKit-only.
- Every constant comes from the plan item (`constant`); a shape below with `<name>` is a placeholder the plan fills,
  never a name to derive.

The shapes are iOS 16 (`NavigationStack`, `navigationDestination(for:)`, `ObservableObject`, `@StateObject`,
`@EnvironmentObject`); no `@Observable`, `@Bindable` or `@Environment(Type.self)`. Only pilot ids appear.

## Pattern table

| Construct | The modifier goes on | Never gets an id |
|---|---|---|
| `WindowGroup { RootView() }` | nothing here; the one screen it shows marks its own `body`; a `TabView` root marks nothing, each tab child marks itself | `App`, `WindowGroup`, `Scene` |
| `NavigationStack` root of a screen | `.appMapScreen(<constant>)` last, on the outermost expression of `body` | the inner `List`/`VStack`, the `NavigationStack` mid-chain |
| `navigationDestination(for:)` / `NavigationLink(destination:)` target | the destination view's own `body` root | the destination closure, the link |
| `TabView` child | the marker inside the child's `body`; `.appMapID(<constant>)` (`nav.<x>.tab`) on the `Label` inside `.tabItem { }`, status `verify_on_device` | `TabView`, `.tabItem` itself, `.tag` |
| `.sheet(isPresented:) { inline content }` | `.appMapScreen(<constant>)` on the closure's top-level view, no extraction into a new view | the presenting view's `.sheet` |
| `.sheet(item:)` / `.sheet { DedicatedView() }` | the presented view's own `body` root (self-marking) | the presenting view, the `item` |
| `.fullScreenCover` | as `.sheet`: the cover content marks itself | the presenting view |
| `.popover` | as `.sheet` (a popover is a sheet) | the presenting view |
| `TextField`, `SecureField`, `TextEditor` | `.appMapID` on the control | placeholder text, the `Form`/`Section` around it |
| `Toggle` | `.appMapID` on the `Toggle` | its label view |
| `Picker`, `DatePicker`, `Stepper`, `Slider` | one `.appMapID` on the control; values are addressed at runtime | the option rows (`Text(…).tag(…)`) |
| `Button`, `ToolbarItem { Button }` | `.appMapID` on the `Button` | the `ToolbarItem`, the `Label`/`Text` inside the button |
| `.swipeActions { Button }` | `.appMapID` on that `Button` (4-segment id: a control inside a cell) | the row keeps its own cell id |
| `Menu { … } label: { … }` | `.appMapID` on the `Menu` root (`kind: button`) | the menu items (`system_element`) |
| `Link` | `.appMapID` on the `Link` | — |
| `NavigationLink` or row view inside `ForEach` | `.appMapID` on the `NavigationLink` (or the row view): one id per cell kind | `List`, `Section`, `ForEach` |
| `List`, `Section`, `ForEach` | nothing, ever | themselves; a `kind: list` id is a UIKit container id |
| `Text(model.x)` bound to data, error text | `.appMapID` on the `Text` (`dynamic: true`) | decorative static text |
| `.searchable` | nothing (`system_element`) | — |
| custom overlay gate (`ZStack` + tap-blocking backdrop) | `.appMapScreen(AppMapID.Gate.<name>)` on the dialog root; `.appMapID(AppMapID.Gate.Dismiss.<name>)` on the cancel; `.appMapID(AppMapID.Gate.Control.<name>)` on each other control | the backdrop, the screen underneath |
| `.alert`, `.confirmationDialog`, OS permission prompts, `LAContext`, `SKStoreReviewController` | no code: registry entry plus `registerGate(id:dismiss:)` in the wiring | alert and dialog buttons |
| `UIViewRepresentable` / `UIViewControllerRepresentable` | `.appMapID(<constant>)` on the wrapped UIKit control inside `makeUIView` / `makeUIViewController` | the representable struct, its use site |
| SwiftUI root inside a `UIHostingController` | the SwiftUI `body` root, once (`hosted_by` on the item) | the hosting controller |
| `.accessibilityElement(children: .combine)` ancestor | the combined element, only when the swallowed control is its sole action; else `blocked`, note `a11y_hazard` | the modifier is never edited |
| `.accessibilityHidden(true)` / `.accessibilityElement(children: .ignore)` ancestor | nothing reachable: `blocked`, note `a11y_hazard` | the modifier is never edited |

## Shapes

### Router context

The app's own router; shown so the shapes read. The debug router mapping and every wiring shape live in
`reference/debug-wiring.md`; neither is written here.

```swift
enum Route: Hashable { case invoiceNew, invoiceDetail(String) }

final class AppRouter: ObservableObject {
    enum Tab: Hashable { case invoices, clients, settings }
    @Published var tab: Tab = .invoices
    @Published var path = NavigationPath()
}
```

### RootView — `TabView`, tab item ids

```swift
struct RootView: View {
    @EnvironmentObject var router: AppRouter
    @EnvironmentObject var session: Session

    var body: some View {
        TabView(selection: $router.tab) {                       // no marker on the TabView: each tab root marks itself
            InvoiceListView()
                .tabItem { Label("Invoices", systemImage: "doc.text").appMapID(AppMapID.Element.navInvoicesTab) }
                .tag(AppRouter.Tab.invoices)                   // id on the Label: verify_on_device
            ClientListView()
                .tabItem { Label("Clients", systemImage: "person.2").appMapID(AppMapID.Element.navClientsTab) }
                .tag(AppRouter.Tab.clients)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gear").appMapID(AppMapID.Element.navSettingsTab) }
                .tag(AppRouter.Tab.settings)
        }
        .fullScreenCover(isPresented: $session.needsLogin) {
            LoginView()                                          // a cover is a screen: LoginView marks itself
        }
    }
}
```

### InvoiceListView — `NavigationStack` root, rows, toolbar, destination

```swift
struct InvoiceListView: View {
    @EnvironmentObject var router: AppRouter
    @StateObject private var model = InvoiceListModel()

    var body: some View {
        NavigationStack(path: $router.path) {
            List {
                Section {
                    ForEach(model.invoices) { invoice in
                        NavigationLink(value: Route.invoiceDetail(invoice.id)) {
                            InvoiceRow(invoice: invoice)
                        }
                        .appMapID(AppMapID.Element.invoiceListCell)      // the ROW: one id per cell kind (01 R4)
                    }
                }                                                       // nothing on Section, ForEach or List (issue #19)
            }
            .navigationTitle("Invoices")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { router.path.append(Route.invoiceNew) }) {
                        Label("New", systemImage: "plus")
                    }
                    .appMapID(AppMapID.Element.invoiceAddButton)        // on the Button, not the ToolbarItem
                }
                ToolbarItem(placement: .navigationBarLeading) {
                    FilterButtonRepresentable(action: model.toggleFilter) // id set inside makeUIView (below), nothing here
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .invoiceNew:               InvoiceNewView()                  // each destination marks itself
                case .invoiceDetail(let id):    InvoiceDetailView(invoiceID: id)
                }
            }
        }
        .appMapScreen(AppMapID.Screen.invoiceList)                       // LAST modifier on the outermost expression (01 R3)
    }
}
```

### InvoiceNewView — `Form` controls, picker row, `.sheet(item:)`, save/cancel

```swift
struct InvoiceNewView: View {
    enum Sheet: String, Identifiable { case clientPicker; var id: String { rawValue } }

    @EnvironmentObject var router: AppRouter
    @StateObject private var draft = InvoiceDraft()
    @State private var sheet: Sheet?

    var body: some View {
        Form {
            TextField("Amount", text: $draft.amount)
                .keyboardType(.decimalPad)
                .appMapID(AppMapID.Element.invoiceAmountField)
            Button(action: { sheet = .clientPicker }) {
                LabeledContent("Client", value: draft.clientName)
            }
            .appMapID(AppMapID.Element.invoiceClientPicker)            // kind picker: the row that opens the picker
            DatePicker("Due", selection: $draft.due, displayedComponents: .date)
                .appMapID(AppMapID.Element.invoiceDuePicker)
            TextField("Note", text: $draft.note)
                .appMapID(AppMapID.Element.invoiceNoteField)
        }
        .navigationTitle("New Invoice")
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("Cancel") { router.path.removeLast() }
                    .appMapID(AppMapID.Element.invoiceCancelButton)
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(action: save) { Text("Save") }
                    .appMapID(AppMapID.Element.invoiceSaveButton)       // intent_critical: never healed automatically
            }
        }
        .sheet(item: $sheet) { presented in
            switch presented {
            case .clientPicker: ClientPickerView(selection: $draft.client) { sheet = nil }   // the presented view marks itself
            }
        }
        .appMapScreen(AppMapID.Screen.invoiceNew)
    }

    private func save() { draft.save(); router.path.removeLast() }
}
```

### Inline sheet content — the closure's top-level view marks itself

When the sheet's content is composed inline, the marker goes on the closure's top-level view. Nothing is extracted into a
new view (rule 3).

```swift
.sheet(isPresented: $showClientPicker) {
    NavigationStack {                                            // the closure's top-level view carries the marker
        List(model.clients) { client in
            Button(action: { pick(client) }) { Text(client.name) }
                .appMapID(AppMapID.Element.clientPickerCell)    // the row; the List gets nothing
        }
        .searchable(text: $query)                                // system element: no id, decision system_element
        .navigationTitle("Choose Client")
    }
    .appMapScreen(AppMapID.Screen.clientPicker)
}
```

### ClientPickerView — a dedicated sheet root marks itself

```swift
struct ClientPickerView: View {
    @Binding var selection: Client?
    let dismiss: () -> Void
    @StateObject private var model = ClientPickerModel()
    @State private var query = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Search", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding()
                    .appMapID(AppMapID.Element.clientPickerSearchField)
                List(model.clients(matching: query)) { client in
                    Button(action: { selection = client; dismiss() }) {
                        Text(client.name)
                    }
                    .appMapID(AppMapID.Element.clientPickerCell)        // the row; the List gets nothing
                }
            }
            .navigationTitle("Choose Client")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: dismiss)
                        .appMapID(AppMapID.Element.clientPickerCancelButton)
                }
            }
        }
        .appMapScreen(AppMapID.Screen.clientPicker)                     // the sheet root; the presenting .sheet gets nothing
    }
}
```

### InvoiceDetailView — destination view, data-bound `Text`, item rows, native `.confirmationDialog`

```swift
struct InvoiceDetailView: View {
    @EnvironmentObject var router: AppRouter
    @StateObject private var model: InvoiceDetailModel
    @State private var confirmSend = false

    init(invoiceID: String) { _model = StateObject(wrappedValue: InvoiceDetailModel(id: invoiceID)) }

    var body: some View {
        List {
            Section {
                Text(model.amount).appMapID(AppMapID.Element.invoiceDetailAmountText)   // data-bound: dynamic true
                Text(model.client).appMapID(AppMapID.Element.invoiceDetailClientText)
                Text(model.status).appMapID(AppMapID.Element.invoiceDetailStatusText)
            }
            Section("Items") {
                ForEach(model.items) { item in
                    InvoiceItemRow(item: item)
                        .appMapID(AppMapID.Element.invoiceDetailItemCell)             // the row view; nothing on Section
                }
            }
        }
        .navigationTitle("Invoice")
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: { router.path.removeLast() }) { Label("Back", systemImage: "chevron.left") }
                    .appMapID(AppMapID.Element.invoiceDetailBackButton)                // an EXISTING custom back control; never add one
            }
            ToolbarItem(placement: .primaryAction) {
                Button(action: { confirmSend = true }) { Text("Send") }
                    .appMapID(AppMapID.Element.invoiceDetailSendButton)                // intent_critical
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(action: model.beginEdit) { Text("Edit") }
                    .appMapID(AppMapID.Element.invoiceDetailEditButton)
            }
        }
        .confirmationDialog("Send this invoice?", isPresented: $confirmSend, titleVisibility: .visible) {
            Button("Send", action: model.send)                   // native gate: no id here, ever (01 R7)
            Button("Cancel", role: .cancel) {}                   // registry + registerGate(id:dismiss:) in the wiring
        }
        .appMapScreen(AppMapID.Screen.invoiceDetail)
    }
}
```

### LoginView — fields, `Link`, error `Text`

```swift
struct LoginView: View {
    @StateObject private var model = LoginModel()

    var body: some View {
        VStack(spacing: 16) {
            TextField("Email", text: $model.email)
                .textContentType(.emailAddress)
                .appMapID(AppMapID.Element.loginEmailField)
            SecureField("Password", text: $model.password)
                .appMapID(AppMapID.Element.loginPasswordField)
            if let message = model.errorMessage {
                Text(message)
                    .foregroundColor(.red)
                    .appMapID(AppMapID.Element.loginErrorText)         // data-bound text: dynamic true
            }
            Button(action: model.submit) { Text("Sign In") }
                .buttonStyle(.borderedProminent)
                .appMapID(AppMapID.Element.loginSubmitButton)          // stays intent_critical false (pilot precedent)
            Button(action: model.signInWithBiometrics) { Label("Face ID", systemImage: "faceid") }
                .appMapID(AppMapID.Element.loginBiometricButton)       // the LAContext prompt it raises is a native gate: no code
            Link("Forgot password?", destination: model.resetURL)
                .appMapID(AppMapID.Element.loginForgotLink)
        }
        .padding()
        .navigationTitle("Sign In")
        .appMapScreen(AppMapID.Screen.login)
    }
}
```

### Representable — the id goes on the wrapped UIKit control

```swift
import SwiftUI
import UIKit
import AppMapKit

struct FilterButtonRepresentable: UIViewRepresentable {
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(action: action) }

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "line.3.horizontal.decrease.circle"), for: .normal)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        button.appMapID(AppMapID.Element.invoiceFilterButton)     // on the wrapped control, once; the wrapper gets nothing
        return button
    }

    func updateUIView(_ uiView: UIButton, context: Context) {}

    final class Coordinator: NSObject {
        let action: () -> Void
        init(action: @escaping () -> Void) { self.action = action }
        @objc func tapped() { action() }
    }
}
```

`makeUIViewController` is the same: `controller.view.appMapID(<constant>)` or the specific control, never the
representable and never `appMapScreen` (the hosting SwiftUI screen already carries the marker).

### Custom overlay gate — marker, dismiss, controls

A state-guarded `ZStack` overlay **with** a backdrop that blocks taps is an in-app gate (`gate.native: false`). The plan
attaches three constants: `constant` (`AppMapID.Gate.<name>`), `gate.dismiss_constant`
(`AppMapID.Gate.Dismiss.<name>`) and one `gate.controls[].constant` (`AppMapID.Gate.Control.<name>`) per other control.

```swift
struct PaywallOverlay: View {                          // already exists; shown by `if model.showPaywall { … }` in a ZStack
    @Binding var isPresented: Bool
    let subscribe: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.4).ignoresSafeArea()               // the tap-blocking backdrop is what makes it a gate
            VStack(spacing: 12) {
                Text("Go Pro")
                Button("Not now") { isPresented = false }
                    .appMapID(AppMapID.Gate.Dismiss.<name>)          // the SAFE escape: pressed unattended by replay
                Button("Subscribe", action: subscribe)
                    .appMapID(AppMapID.Gate.Control.<name>)          // every other control; intent_critical is explicit in the plan
            }
            .padding()
        }
        .appMapScreen(AppMapID.Gate.<name>)                           // the gate marker, on the dialog root
    }
}
```

An overlay without a tap-blocking backdrop is a screen, not a gate: it gets `AppMapID.Screen.<x>` and element ids.

### Native `.alert` / `.confirmationDialog` — no code

`.alert`, `.confirmationDialog` (always a gate: it renders as an action sheet), `UNUserNotificationCenter`,
`CLLocationManager`, `ATTrackingManager`, `AVCaptureDevice`, `PHPhotoLibrary`, `LAContext.evaluatePolicy` and
`SKStoreReviewController` prompts cannot carry ids. The item is `gate.native: true`: write nothing at its anchor, return
`skipped` with note `native_gate`. The gate exists in `ids.yaml` and in the wiring's `registerGate(id:dismiss:)` call;
its label signature is recorded by a later capture session. Never give an alert button `.appMapID`.

### Hazards — `.combine`, `.accessibilityHidden`

Never add, remove or move `.accessibilityElement(children:)`, `.accessibilityHidden`, `.accessibilityLabel` (rule 3).

```swift
// Sole action under a pre-existing .combine: the id moves to the combined element, placed AFTER the combine.
HStack {
    Image(systemName: "paperplane")
    Text("Send")
}
.accessibilityElement(children: .combine)                 // pre-existing; never removed
.onTapGesture(perform: model.send)
.appMapID(AppMapID.Element.invoiceDetailSendButton)       // status done, note moved_to_combined

// Two actions under one .combine: no id can reach either. Status blocked, note a11y_hazard; nothing edited.
HStack {
    Button(action: model.beginEdit) { Text("Edit") }      // invoiceDetailEditButton: blocked
    Button(action: model.send) { Text("Send") }           // invoiceDetailSendButton: blocked
}
.accessibilityElement(children: .combine)
```

`.accessibilityHidden(true)` or `.accessibilityElement(children: .ignore)` on an ancestor hides the whole subtree from
the driver: every proposed element under it is `blocked`, note `a11y_hazard`, and the hazard is listed in the report.

### Other controls — placeholders

Constructs without a pilot id; `<name>` is the constant the plan attaches.

```swift
Toggle("Remind me", isOn: $model.reminders)
    .appMapID(AppMapID.Element.<name>)                                       // toggle
Picker("Status", selection: $model.status) {
    ForEach(Status.allCases, id: \.self) { Text($0.title).tag($0) }         // option rows: nothing
}
.appMapID(AppMapID.Element.<name>)                                           // picker: one id on the control
Stepper("Quantity", value: $model.quantity, in: 1...99)
    .appMapID(AppMapID.Element.<name>)                                       // picker
Slider(value: $model.discount, in: 0...1)
    .appMapID(AppMapID.Element.<name>)                                       // picker
Menu {
    Button("Duplicate", action: model.duplicate)                             // menu items: system elements, nothing
    Button("Archive", action: model.archive)
} label: {
    Label("More", systemImage: "ellipsis.circle")
}
.appMapID(AppMapID.Element.<name>)                                           // button, on the Menu root
NavigationLink(value: Route.invoiceDetail(invoice.id)) { InvoiceRow(invoice: invoice) }
    .appMapID(AppMapID.Element.invoiceListCell)
    .swipeActions {
        Button(role: .destructive, action: { model.delete(invoice) }) { Label("Delete", systemImage: "trash") }
            .appMapID(AppMapID.Element.<name>)                               // 4-segment id: a control inside a cell
    }
.popover(isPresented: $showPicker) {
    ClientPickerView(selection: $draft.client) { showPicker = false }      // a popover is a sheet: the content marks itself
}
```
