// InvoiceDetailViewController — the `invoice_detail` screen; the coordinator sets the invoice after init, so the marker
// is asserted in viewDidLoad and again in viewWillAppear (idempotent); data-bound labels carry dynamic ids; the items
// table ids every dequeued cell; the pre-existing custom back item gets its id; the removal confirmation is a
// UIAlertController and gets no code (01 R3, 01 R4, 01 R7).

import UIKit
import AppMapKit

final class InvoiceDetailViewController: UIViewController {
    private static let reuseIdentifier = "ItemCell"

    private var invoice: Invoice?
    private let amountLabel = UILabel()
    private let clientLabel = UILabel()
    private let statusLabel = UILabel()
    private let itemsTable = UITableView(frame: .zero, style: .insetGrouped)

    /// Called by the coordinator between init and appearance, and again on updates.
    func configure(invoice: Invoice) {
        self.invoice = invoice
        if isViewLoaded { bind() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.invoiceDetail)   // 01 R3: first statement after super
        title = "Invoice"
        view.backgroundColor = .systemGroupedBackground

        // The app already replaces the system back button with its own item; the id goes on that EXISTING item only, since
        // creating one would be a visible change (§9 rule 3).
        navigationItem.leftBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "chevron.backward"), style: .plain,
                                                           target: self, action: #selector(backTapped))
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = AppMapID.Element.invoiceDetailBackButton
        let sendItem = UIBarButtonItem(title: "Send", style: .done, target: self, action: #selector(sendTapped))
        sendItem.accessibilityIdentifier = AppMapID.Element.invoiceDetailSendButton   // intent_critical in the registry: never healed automatically
        let editItem = UIBarButtonItem(barButtonSystemItem: .edit, target: self, action: #selector(editTapped))
        editItem.accessibilityIdentifier = AppMapID.Element.invoiceDetailEditButton
        navigationItem.rightBarButtonItems = [sendItem, editItem]

        amountLabel.font = .preferredFont(forTextStyle: .largeTitle)
        amountLabel.appMapID(AppMapID.Element.invoiceDetailAmountText)   // bound labels: dynamic in the registry, the scrubber drops their text (01 R4)
        clientLabel.appMapID(AppMapID.Element.invoiceDetailClientText)
        statusLabel.textColor = .secondaryLabel
        statusLabel.appMapID(AppMapID.Element.invoiceDetailStatusText)

        itemsTable.register(UITableViewCell.self, forCellReuseIdentifier: Self.reuseIdentifier)
        itemsTable.dataSource = self
        itemsTable.appMapID(AppMapID.Element.invoiceDetailItemsList)   // kind list, dynamic: the table is an element; its cells are id'd on dequeue below

        let header = UIStackView(arrangedSubviews: [amountLabel, clientLabel, statusLabel])
        header.axis = .vertical
        header.spacing = 4
        header.isLayoutMarginsRelativeArrangement = true
        let stack = UIStackView(arrangedSubviews: [header, itemsTable])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        bind()
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        appMapScreen(AppMapID.Screen.invoiceDetail)   // re-asserted: the coordinator configures this VC after init, so the identity is final only here; idempotent, and the site where a reused VC switches per-mode constants (design §2.3)
        bind()
    }

    private func bind() {
        guard let invoice else { return }
        amountLabel.text = invoice.amount.formatted(.currency(code: "USD"))
        clientLabel.text = invoice.client
        statusLabel.text = invoice.status.rawValue
        itemsTable.reloadData()
    }

    @objc private func backTapped() {
        navigationController?.popViewController(animated: true)
    }

    @objc private func sendTapped() {
        guard var sent = invoice else { return }
        sent.status = .sent
        AppRouter.shared.update(sent)
        configure(invoice: sent)
    }

    @objc private func editTapped() {
        itemsTable.setEditing(!itemsTable.isEditing, animated: true)
    }

    private func confirmRemoval(of item: InvoiceItem) {
        // OS-style gate (01 R7): UIAlertAction has no identifier API, and a marker on the alert controller's own view would
        // inject a subview into a system alert in every build, so the code side is nothing; the map records the label signature.
        let alert = UIAlertController(title: "Remove this item?", message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        alert.addAction(UIAlertAction(title: "Remove", style: .destructive) { [weak self] _ in self?.remove(item) })
        present(alert, animated: true)
    }

    private func remove(_ item: InvoiceItem) {
        guard var updated = invoice else { return }
        updated.items.removeAll { $0.id == item.id }
        AppRouter.shared.update(updated)
        configure(invoice: updated)
    }
}

extension InvoiceDetailViewController: UITableViewDataSource {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        invoice?.items.count ?? 0
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuseIdentifier, for: indexPath)
        cell.appMapID(AppMapID.Element.invoiceDetailItemCell)   // on every dequeue: cells are reused (01 R4)
        var content = cell.defaultContentConfiguration()
        if let item = invoice?.items[indexPath.row] {
            content.text = item.title
            content.secondaryText = item.amount.formatted(.currency(code: "USD"))
        }
        cell.contentConfiguration = content
        return cell
    }

    func tableView(_ tableView: UITableView, commit editingStyle: UITableViewCell.EditingStyle, forRowAt indexPath: IndexPath) {
        guard editingStyle == .delete, let item = invoice?.items[indexPath.row] else { return }
        confirmRemoval(of: item)
    }
}
