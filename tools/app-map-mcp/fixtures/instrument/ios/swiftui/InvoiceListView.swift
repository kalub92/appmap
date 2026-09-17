// Invoices — `invoice_list` (01 R3): the invoices tab root. The NavigationStack owns the router's path and the
// screen marker is its last modifier. Rows carry the cell id; List, Section and ForEach carry nothing (issue #19).

import SwiftUI
import AppMapKit

struct Invoice: Identifiable, Hashable {
    let id: String
    var client: String
    var amount: String
    var isPaid: Bool
}

final class InvoiceListModel: ObservableObject {
    @Published var invoices: [Invoice] = []
    @Published var showsUnpaidOnly = false

    var visibleInvoices: [Invoice] {
        showsUnpaidOnly ? invoices.filter { !$0.isPaid } : invoices
    }
}

struct InvoiceListView: View {
    @EnvironmentObject var router: AppRouter
    @StateObject private var model = InvoiceListModel()

    var body: some View {
        NavigationStack(path: $router.path) {
            List {
                Section("Recent") {
                    ForEach(model.visibleInvoices) { invoice in
                        NavigationLink(value: Route.invoiceDetail(invoice.id)) {
                            InvoiceRow(invoice: invoice)
                        }
                        .appMapID(AppMapID.Element.invoiceListCell)         // the ROW: one id per cell kind, the index picks the row (01 R4)
                    }
                }
            }
            .navigationTitle("Invoices")
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    FilterButtonRepresentable(isOn: $model.showsUnpaidOnly)   // its id is set on the UIButton inside makeUIView
                }
                ToolbarItem(placement: .primaryAction) {
                    Button(action: { router.sheet = .invoiceNew }) {
                        Label("New Invoice", systemImage: "plus")
                    }
                    .appMapID(AppMapID.Element.invoiceAddButton)            // on the Button, never on the ToolbarItem
                }
            }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .invoiceDetail(let invoiceID):
                    InvoiceDetailView(invoiceID: invoiceID)                  // a pushed destination marks itself
                }
            }
        }
        .sheet(item: $router.sheet) { sheet in
            switch sheet {
            case .invoiceNew:
                InvoiceNewView()                                             // a presented view marks itself; nothing here
            }
        }
        .appMapScreen(AppMapID.Screen.invoiceList)                           // LAST modifier on the outermost expression (01 R3)
    }
}

private struct InvoiceRow: View {
    let invoice: Invoice

    var body: some View {
        HStack {
            Text(invoice.client)
            Spacer()
            Text(invoice.amount)
                .foregroundColor(.secondary)
        }
    }
}
