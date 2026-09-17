// Invoices — `invoice_new` (01 R3): a modal sheet over the list. Its own NavigationStack carries the marker;
// the client picker it presents is a screen of its own and marks itself.

import SwiftUI
import AppMapKit

struct InvoiceNewView: View {
    @EnvironmentObject var router: AppRouter
    @State private var amount = ""
    @State private var note = ""
    @State private var due = Date()
    @State private var client: Client?
    @State private var showsClientPicker = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("Amount", text: $amount)
                    .keyboardType(.decimalPad)
                    .appMapID(AppMapID.Element.invoiceAmountField)
                Button(action: { showsClientPicker = true }) {
                    HStack {
                        Text("Client")
                        Spacer()
                        Text(client?.name ?? "Choose")
                            .foregroundColor(.secondary)
                    }
                }
                .appMapID(AppMapID.Element.invoiceClientPicker)             // kind picker: the row that opens the picker sheet
                DatePicker("Due", selection: $due, displayedComponents: .date)
                    .appMapID(AppMapID.Element.invoiceDuePicker)            // one id on the control; values are addressed at runtime
                TextField("Note", text: $note)
                    .appMapID(AppMapID.Element.invoiceNoteField)
            }
            .navigationTitle("New Invoice")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { router.sheet = nil }
                        .appMapID(AppMapID.Element.invoiceCancelButton)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: save)
                        .disabled(client == nil || amount.isEmpty)
                        .appMapID(AppMapID.Element.invoiceSaveButton)       // intent_critical: commits the draft, never healed automatically
                }
            }
            .sheet(isPresented: $showsClientPicker) {
                ClientPickerView(selection: $client) { showsClientPicker = false }   // the presented view marks itself
            }
        }
        .appMapScreen(AppMapID.Screen.invoiceNew)                            // LAST modifier on the outermost expression (01 R3)
    }

    private func save() {
        let invoiceID = UUID().uuidString                                    // the store assigns the real id when it persists the draft
        router.showInvoiceDetail(invoiceID)                                  // closes the sheet and pushes the new invoice
    }
}
