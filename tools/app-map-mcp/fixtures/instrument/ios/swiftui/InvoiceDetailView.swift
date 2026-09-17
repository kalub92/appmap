// Invoices — `invoice_detail` (01 R3): a pushed destination of the list's NavigationStack. Data-bound texts and
// item rows carry ids; the native confirmation dialog is an OS-style gate and carries none.

import SwiftUI
import AppMapKit

struct InvoiceItem: Identifiable, Hashable {
    let id: String
    var title: String
    var amount: String
}

final class InvoiceDetailModel: ObservableObject {
    let invoiceID: String
    @Published var amount = ""
    @Published var client = ""
    @Published var status = ""
    @Published var items: [InvoiceItem] = []

    init(invoiceID: String) {
        self.invoiceID = invoiceID
    }

    func send() {
        status = "Sent"                                                      // the store sends it; the label reflects the result
    }
}

struct InvoiceDetailView: View {
    @EnvironmentObject var router: AppRouter
    @StateObject private var model: InvoiceDetailModel
    @State private var confirmSend = false

    init(invoiceID: String) {
        _model = StateObject(wrappedValue: InvoiceDetailModel(invoiceID: invoiceID))
    }

    var body: some View {
        List {
            Section {
                Text(model.amount)
                    .font(.title)
                    .appMapID(AppMapID.Element.invoiceDetailAmountText)     // data-bound: dynamic true, the scrubber drops the text
                Text(model.client)
                    .appMapID(AppMapID.Element.invoiceDetailClientText)
                Text(model.status)
                    .foregroundColor(.secondary)
                    .appMapID(AppMapID.Element.invoiceDetailStatusText)
            }
            Section("Items") {
                ForEach(model.items) { item in
                    InvoiceItemRow(item: item)
                        .appMapID(AppMapID.Element.invoiceDetailItemCell)   // the row view; Section and ForEach get nothing (issue #19)
                }
            }
        }
        .navigationTitle("Invoice")
        .navigationBarBackButtonHidden(true)                                 // the custom back control below pre-dates instrumentation
        .toolbar {
            ToolbarItem(placement: .navigationBarLeading) {
                Button(action: { router.path.removeLast() }) {
                    Label("Back", systemImage: "chevron.left")
                }
                .appMapID(AppMapID.Element.invoiceDetailBackButton)         // an EXISTING custom back control; never add one
            }
            ToolbarItem(placement: .primaryAction) {
                Button(action: { confirmSend = true }) {
                    Text("Send")
                }
                .appMapID(AppMapID.Element.invoiceDetailSendButton)         // intent_critical: never healed automatically
            }
            ToolbarItem(placement: .secondaryAction) {
                Button(action: { router.sheet = .invoiceNew }) {
                    Text("Edit")
                }
                .appMapID(AppMapID.Element.invoiceDetailEditButton)
            }
        }
        .confirmationDialog("Send this invoice?", isPresented: $confirmSend, titleVisibility: .visible) {
            Button("Send", action: model.send)                               // os_dialog gate: dialog buttons never carry ids (01 R7)
            Button("Cancel", role: .cancel) {}                               // the map records a label signature instead
        }
        .appMapScreen(AppMapID.Screen.invoiceDetail)                         // LAST modifier on the outermost expression (01 R3)
    }
}

private struct InvoiceItemRow: View {
    let item: InvoiceItem

    var body: some View {
        HStack {
            Text(item.title)
            Spacer()
            Text(item.amount)
        }
    }
}
