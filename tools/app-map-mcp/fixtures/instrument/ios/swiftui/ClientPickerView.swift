// Invoices — `client_picker` (01 R3): a sheet presented by InvoiceNewView. Its deep link is `none`: it only
// makes sense over the draft it fills in, so a replay reaches it through the picker row.

import SwiftUI
import AppMapKit

struct Client: Identifiable, Hashable {
    let id: String
    let name: String
}

final class ClientPickerModel: ObservableObject {
    @Published var clients: [Client] = []

    func clients(matching query: String) -> [Client] {
        query.isEmpty ? clients : clients.filter { $0.name.localizedCaseInsensitiveContains(query) }
    }
}

struct ClientPickerView: View {
    @Binding var selection: Client?
    let dismiss: () -> Void
    @StateObject private var model = ClientPickerModel()
    @State private var query = ""

    var body: some View {
        NavigationStack {                                                    // the sheet's top-level view carries the marker
            VStack(spacing: 0) {
                TextField("Search", text: $query)
                    .textFieldStyle(.roundedBorder)
                    .padding()
                    .appMapID(AppMapID.Element.clientPickerSearchField)     // a real TextField; .searchable would be a system element
                List(model.clients(matching: query)) { client in
                    Button(action: { selection = client; dismiss() }) {
                        Text(client.name)
                    }
                    .appMapID(AppMapID.Element.clientPickerCell)            // the row; the List gets nothing (issue #19)
                }
                .listStyle(.plain)
            }
            .navigationTitle("Choose Client")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: dismiss)
                        .appMapID(AppMapID.Element.clientPickerCancelButton)
                }
            }
        }
        .appMapScreen(AppMapID.Screen.clientPicker)                          // LAST modifier; the presenting .sheet gets nothing (01 R3)
    }
}
