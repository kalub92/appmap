// fixtures/lint/Bad.swift — lint-ids fixture (01 R8). Every violation is deliberate.
import SwiftUI

struct InvoiceListView: View {
  var body: some View {
    NavigationStack {
      List { Text("Invoices") }
        .accessibilityIdentifier("invoice.list.table")            // string_literal_id (must be AppMapID.Element.invoiceListTable)
      Button("New Invoice") {}
        .accessibilityIdentifier(AppMapID.Element.invoiceAddButton) // ok: generated constant
    }
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("screen.invoice_list")                 // string_literal_id (must be AppMapID.Screen.invoiceList)
  }
}

// Note: no view references AppMapID.Screen.clientPicker or AppMapID.Screen.invoiceDetail,
// so lint reports marker_unreferenced for client_picker and invoice_detail on ios when this
// file is the only iOS source scanned.
