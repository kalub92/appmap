// ClientPickerViewController — the `client_picker` screen: presented as a sheet, so it marks itself; a UITableView with
// the cell id set on every dequeue and a UISearchBar id'd through its text field (01 R3, 01 R4).

import UIKit
import AppMapKit

final class ClientPickerViewController: UIViewController {
    private static let reuseIdentifier = "ClientCell"

    private let onSelect: (Client) -> Void
    private let searchBar = UISearchBar()
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private var clients: [Client] = []

    init(onSelect: @escaping (Client) -> Void) {
        self.onSelect = onSelect
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) is unavailable: this app builds its UI in code")
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        appMapScreen(AppMapID.Screen.clientPicker)   // 01 R3: a sheet is a screen of its own, marked on the presented VC, never on its UINavigationController
        title = "Choose Client"
        view.backgroundColor = .systemGroupedBackground
        clients = AppRouter.shared.clients

        navigationItem.leftBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
        navigationItem.leftBarButtonItem?.accessibilityIdentifier = AppMapID.Element.clientPickerCancelButton   // bar item: direct assignment (01 R8)

        searchBar.placeholder = "Search clients"
        searchBar.searchBarStyle = .minimal
        searchBar.delegate = self
        searchBar.searchTextField.appMapID(AppMapID.Element.clientPickerSearchField)   // the text field is the element the driver sees, not the bar (design §2.3)

        tableView.register(UITableViewCell.self, forCellReuseIdentifier: Self.reuseIdentifier)
        tableView.dataSource = self
        tableView.delegate = self
        tableView.appMapID(AppMapID.Element.clientPickerList)   // kind list, dynamic: a UITableView is an accessibility element (01 R4)

        let stack = UIStackView(arrangedSubviews: [searchBar, tableView])
        stack.axis = .vertical
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
    }

    @objc private func cancelTapped() {
        dismiss(animated: true)
    }
}

extension ClientPickerViewController: UITableViewDataSource, UITableViewDelegate {
    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        clients.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: Self.reuseIdentifier, for: indexPath)
        cell.appMapID(AppMapID.Element.clientPickerCell)   // on every dequeue: cells are reused (01 R4)
        var content = cell.defaultContentConfiguration()
        content.text = clients[indexPath.row].name
        cell.contentConfiguration = content
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        onSelect(clients[indexPath.row])
        dismiss(animated: true)
    }
}

extension ClientPickerViewController: UISearchBarDelegate {
    func searchBar(_ searchBar: UISearchBar, textDidChange searchText: String) {
        let all = AppRouter.shared.clients
        clients = searchText.isEmpty ? all : all.filter { $0.name.localizedCaseInsensitiveContains(searchText) }
        tableView.reloadData()
    }
}
