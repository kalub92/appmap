// InvoiceNewViewController — the `invoice_new` screen: text fields, a UIDatePicker, a button that presents the client
// picker as a sheet (a screen of its own), and save/cancel bar items (01 R3, 01 R4).

import UIKit
import AppMapKit

final class InvoiceNewViewController: UIViewController {
    private let amountField = UITextField()
    private let noteField = UITextField()
    private let clientButton = UIButton(type: .system)
    private let duePicker = UIDatePicker()
    private var selectedClient: Client?

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.invoiceNew)   // 01 R3: first statement after super; the sheet container presenting this VC gets nothing
        title = "New Invoice"
        view.backgroundColor = .systemGroupedBackground

        let cancelItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
        cancelItem.accessibilityIdentifier = AppMapID.Element.invoiceCancelButton   // bar items: direct assignment of the constant (01 R8)
        let saveItem = UIBarButtonItem(barButtonSystemItem: .save, target: self, action: #selector(saveTapped))
        saveItem.accessibilityIdentifier = AppMapID.Element.invoiceSaveButton   // intent_critical in the registry: never healed automatically
        navigationItem.leftBarButtonItem = cancelItem
        navigationItem.rightBarButtonItem = saveItem

        amountField.placeholder = "Amount"
        amountField.keyboardType = .decimalPad
        amountField.borderStyle = .roundedRect
        amountField.appMapID(AppMapID.Element.invoiceAmountField)   // 01 R4: one id per control

        noteField.placeholder = "Note"
        noteField.borderStyle = .roundedRect
        noteField.appMapID(AppMapID.Element.invoiceNoteField)

        clientButton.setTitle("Choose Client", for: .normal)
        clientButton.contentHorizontalAlignment = .leading
        clientButton.addTarget(self, action: #selector(clientTapped), for: .touchUpInside)
        clientButton.appMapID(AppMapID.Element.invoiceClientPicker)   // kind picker: the control that opens the sheet; the sheet marks itself as its own screen

        duePicker.datePickerMode = .date
        duePicker.preferredDatePickerStyle = .compact
        duePicker.appMapID(AppMapID.Element.invoiceDuePicker)   // one id on the control; the driver addresses values at runtime

        let form = UIStackView(arrangedSubviews: [amountField, noteField, clientButton, duePicker])
        form.axis = .vertical
        form.spacing = 12
        form.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(form)
        NSLayoutConstraint.activate([
            form.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 24),
            form.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            form.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    @objc private func clientTapped() {
        let picker = ClientPickerViewController { [weak self] client in
            self?.selectedClient = client
            self?.clientButton.setTitle(client.name, for: .normal)
        }
        let navigation = UINavigationController(rootViewController: picker)   // a container: no marker; the picker marks itself in its own viewDidLoad
        navigation.modalPresentationStyle = .pageSheet                          // every presented VC is a screen, whatever the style (01 R3)
        present(navigation, animated: true)
    }

    @objc private func saveTapped() {
        guard let client = selectedClient, let amount = Decimal(string: amountField.text ?? "") else { return }
        let invoice = Invoice(id: UUID().uuidString, client: client.name, amount: amount, due: duePicker.date,
                              note: noteField.text ?? "", status: .draft, items: [])
        AppRouter.shared.add(invoice)
        dismiss(animated: true)
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }
}
