// Invoices — a UIKit control wrapped for SwiftUI. The id goes on the wrapped UIButton inside makeUIView, the
// element the driver actually sees; the representable struct and its use site carry nothing (01 R4).

import SwiftUI
import UIKit
import AppMapKit

struct FilterButtonRepresentable: UIViewRepresentable {
    @Binding var isOn: Bool

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        button.setImage(UIImage(systemName: "line.3.horizontal.decrease.circle"), for: .normal)
        button.addTarget(context.coordinator, action: #selector(Coordinator.toggle), for: .touchUpInside)
        button.appMapID(AppMapID.Element.invoiceFilterButton)                // set once, here, on the UIKit control
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        button.tintColor = isOn ? .systemBlue : .secondaryLabel
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(isOn: $isOn)
    }

    final class Coordinator: NSObject {
        private let isOn: Binding<Bool>

        init(isOn: Binding<Bool>) {
            self.isOn = isOn
        }

        @objc func toggle() {
            isOn.wrappedValue.toggle()
        }
    }
}
