// InvoiceListViewController — the `invoice_list` screen: a UICollectionView (itself an element, unlike a SwiftUI List)
// whose CellRegistration ids every dequeued cell, and bar items id'd by direct assignment (01 R3, 01 R4).

import UIKit
import AppMapKit

final class InvoiceListViewController: UIViewController {
    private enum Section {
        case invoices
    }

    private lazy var collectionView = UICollectionView(
        frame: .zero,
        collectionViewLayout: UICollectionViewCompositionalLayout.list(using: UICollectionLayoutListConfiguration(appearance: .insetGrouped))
    )
    private var dataSource: UICollectionViewDiffableDataSource<Section, Invoice>?
    private var showsDraftsOnly = false

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.invoiceList)   // 01 R3: first statement after super
        title = "Invoices"
        view.backgroundColor = .systemGroupedBackground

        let addItem = UIBarButtonItem(barButtonSystemItem: .add, target: self, action: #selector(addTapped))
        addItem.accessibilityIdentifier = AppMapID.Element.invoiceAddButton   // not a UIView: the constant is assigned directly (01 R8)
        let filterItem = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease.circle"), style: .plain,
                                         target: self, action: #selector(filterTapped))
        filterItem.accessibilityIdentifier = AppMapID.Element.invoiceFilterButton
        navigationItem.rightBarButtonItems = [addItem, filterItem]

        collectionView.delegate = self
        collectionView.translatesAutoresizingMaskIntoConstraints = false
        collectionView.appMapID(AppMapID.Element.invoiceListCollection)   // kind list, dynamic: a UICollectionView is an accessibility element (01 R4)
        view.addSubview(collectionView)
        NSLayoutConstraint.activate([
            collectionView.topAnchor.constraint(equalTo: view.topAnchor),
            collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        // Cells are reused: the id is set inside the registration handler, so every dequeue carries it (01 R4).
        let registration = UICollectionView.CellRegistration<UICollectionViewListCell, Invoice> { cell, _, invoice in
            var content = cell.defaultContentConfiguration()
            content.text = invoice.client
            content.secondaryText = invoice.status.rawValue
            cell.contentConfiguration = content
            cell.accessories = [.disclosureIndicator()]
            cell.appMapID(AppMapID.Element.invoiceListCell)
        }
        dataSource = UICollectionViewDiffableDataSource<Section, Invoice>(collectionView: collectionView) { collectionView, indexPath, invoice in
            collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: invoice)   // the handler above runs on every dequeue
        }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        applySnapshot()
    }

    private func applySnapshot() {
        let invoices = AppRouter.shared.invoices
        var snapshot = NSDiffableDataSourceSnapshot<Section, Invoice>()
        snapshot.appendSections([.invoices])
        snapshot.appendItems(showsDraftsOnly ? invoices.filter { $0.status == .draft } : invoices)
        dataSource?.apply(snapshot, animatingDifferences: false)
    }

    @objc private func addTapped() {
        AppRouter.shared.showInvoiceNew()
    }

    @objc private func filterTapped() {
        showsDraftsOnly.toggle()
        applySnapshot()
    }
}

extension InvoiceListViewController: UICollectionViewDelegate {
    func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
        collectionView.deselectItem(at: indexPath, animated: true)
        guard let invoice = dataSource?.itemIdentifier(for: indexPath) else { return }
        AppRouter.shared.showInvoiceDetail(invoice)
    }
}
