# Id rules — screens, elements, gates (01 R2, 01 R4, 01 R7)

The surveyor proposes ids with §A–§C and the kind table in §D; the skill applies §E–§G at the registry step, and it
alone edits `app-map/ids.yaml`. Every id is a structural name, never copy: no label text, no localized key, no name, no
amount (01 R2). The generated constant is lowerCamel of the segments after the prefix
(`invoice.detail.send.button` → `AppMapID.Element.invoiceDetailSendButton`, `client_picker` → `AppMapID.Screen.clientPicker`,
`gate.push_permission` → `AppMapID.Gate.pushPermission`, its dismiss → `AppMapID.Gate.Dismiss.pushPermissionDeny`);
Swift keywords come out backticked. App code references ids only through those constants (01 R8), so a proposed id is
never written into source — the plan carries the constant the skill filled after `gen-ids`.

## A. Screen id

Deterministic, from the type name of `marker_owner`:

1. Strip one trailing suffix, trying them longest first so `InvoiceListViewController` loses `ViewController`
   rather than `Controller`: `ViewController`, `Controller`, `Screen`, `View`, `Page`, `VC`.
2. Split CamelCase into lowercase tokens.
3. If the first token is one of `new, edit, create, add, choose, select, pick` and there are two or more tokens, move it
   to the end (`NewInvoice` → `invoice_new`, `EditClient` → `client_edit`). `Picker`, `Sheet` and `Filter` tokens stay
   where they are (`ClientPicker` → `client_picker`, `InvoiceFilterSheet` → `invoice_filter_sheet`).
4. Join with `_`. The result must match `^[a-z][a-z0-9_]*$`. A reused VC with modes yields one screen per mode,
   `<base>_<mode>`, with `mode_condition` on the item. A storyboard scene uses its `customClass`.
5. `title` is the static nav-title literal (`.navigationTitle("…")`, `navigationItem.title = "…"`) or omitted — never a
   computed or localized title. `deep_link` is `appmap://<id>` when the router can reach the screen with at most
   fixture-supplied params, else `none`.

| Type | Screen id | Marker constant |
|---|---|---|
| `LoginView`, `LoginViewController` | `login` | `AppMapID.Screen.login` |
| `InvoiceListView` | `invoice_list` | `AppMapID.Screen.invoiceList` |
| `NewInvoiceViewController`, `InvoiceNewView` | `invoice_new` | `AppMapID.Screen.invoiceNew` |
| `InvoiceDetailView` | `invoice_detail` | `AppMapID.Screen.invoiceDetail` |
| `ClientPickerView` | `client_picker` | `AppMapID.Screen.clientPicker` |

The bare id (`invoice_list`) is what the registry, the router mapping and `deep_link` use; the marker `screen.<id>`
exists only as the constant. Sheets, full-screen covers and popovers are screens with their own id (01 R3);
`TabView`, navigation and tab-bar containers, hosting controllers and `addChild` children are not.

## B. Element name and id (01 R4)

The **name** is the first signal available, in this order — stop at the first hit:

1. Action symbol: `Button(action: save)`, `#selector(saveTapped)`, `@IBAction func didTapSave` → `save`. Strip
   `didTap | on | handle | Tapped | Pressed | Action | Button | Field | TextField | Label`.
2. Binding, property or outlet name: `$amount`, `amountTextField` → `amount`.
3. Navigation target: `NavigationLink(value: client)`, `Route.clientPicker` → `client`.
4. Tab enum case or tag.
5. Role: `.destructive` → `delete`, `.cancel` / `cancellationAction` → `cancel`, `.done` → `done`.
6. A label string, only through the closed role-word table in §H.

Nothing else from copy ever enters an id. An icon-only control with no signal gets a `decisions[] {kind: conflict}` and
no id. `name_source` records which rung fired (`action_symbol:save`, `role_word:add`).

The **id** is `<feature>.<name>.<kind>`:

- `feature` is the first token of the screen id. If that id already exists for a different screen, use the screen id
  with `_` → `.` as the prefix: `invoice.add.button` on `invoice_list`, `invoice.detail.edit.button` on `invoice_detail`.
- Tabs are `nav.<case>.tab`. Cells are `<feature>.<list>.cell`, one id per cell kind, on the **row** (issue #19). UIKit
  containers are `<feature>.<list>.table | collection | list`; SwiftUI has no list element to register.
- Controls inside cells take four segments (`invoice.detail.item.button` shape). Numeric suffixes are forbidden.
- The last segment is the kind or one of its accepted synonyms (§H); the id must match
  `^(?!screen\.|gate\.)[a-z0-9]+(\.[a-z0-9_]+){2,}$`.

## C. Gate ids (01 R7)

- `gate.<name>` from the presenting handler or state (`showDeleteConfirmation` → `gate.delete_confirmation`,
  `requestAuthorization` for push → `gate.push_permission`).
- `dismiss` is the cancel-role action and the **safe escape**, `gate.<name>.<verb>` with the cancel-role word
  (`cancel`, `deny`, `not_now`): guided replay and the Maestro export press it unattended, so it must never commit
  anything. Pilot: `gate.push_permission.deny`, `gate.biometric_prompt.cancel`.
- Every other action is a `controls[]` entry (`gate.<name>.confirm | delete | allow`) with an explicit `intent_critical`,
  required there unlike anywhere else (issue #24).
- Native gates (`.alert`, `.confirmationDialog`, `UIAlertController`, OS permission prompts, `LAContext`,
  `SKStoreReviewController`) get a registry entry and a `registerGate(id:dismiss:)` call; no code touches the dialog and
  the label signature is recorded by a later `name_screen`/`mark` session. In-app gates carry the marker
  `AppMapID.Gate.<name>` on the dialog root, `AppMapID.Gate.Dismiss.<name>` on the cancel control and
  `AppMapID.Gate.Control.<name>` on each other control; `gen-ids` emits `Control` only when some gate has `controls[]`.

## D. Kind mapping

The detection list. The test pins the `kind` column to the registry's kinds plus one `none` row.

| Construct (SwiftUI) | Construct (UIKit) | kind | note |
|---|---|---|---|
| `Button`, `ToolbarItem { Button }`, `.swipeActions` button, `Menu` (root) | `UIButton`, `UIBarButtonItem` | `button` | `Menu` items are system elements (no id); a gesture-bearing plain `UIView`/`UIImageView` qualifies only where the source already sets `isAccessibilityElement = true` — otherwise no id and an `a11y_hazard` decision (the identifier would never reach the tree, and rule 3 forbids setting the flag) |
| `TextField`, `SecureField`, `TextEditor` | `UITextField`, `UITextView` (editable), `UISearchBar.searchTextField` | `field` | `.searchable` → no id, decision `system_element` |
| — | `UITableView`, `UICollectionView` | `list` | `dynamic: true`; SwiftUI has no list element |
| row content / `NavigationLink` inside `List`/`ForEach` | `UITableViewCell`, `UICollectionViewCell` | `cell` | `dynamic: true`; one id per cell kind |
| `Toggle` | `UISwitch` | `toggle` | |
| `.tabItem` (id on its `Label`) | `UITabBarItem` | `tab` | `nav.<x>.tab`; SwiftUI `verify_on_device` |
| `Picker`, `DatePicker`, `Stepper`, `Slider` | `UISegmentedControl`, `UIPickerView`, `UIDatePicker`, `UIStepper`, `UISlider`, `UIPageControl` | `picker` | one id on the control; values addressed at runtime |
| `Link`, `NavigationLink` outside a list | `UITextView` link, `SFSafariViewController` trigger | `link` | |
| `Text` bound to data, form label, error label | `UILabel` bound to data or form label | `text` | `dynamic: true` when bound |
| custom modal root that is not a screen and not a gate | custom presentation container view | `sheet` | rare; prefer a screen |
| `List`, `Section`, `ForEach` | — | `none` | never an id (issue #19) |

`UISegmentedControl`, `Stepper` and `UIStepper` are `picker` because they select among values; `Menu` is `button`
because the id lands on the tappable root. A `List`, `Section` or `ForEach` is not an accessibility element, so an id
on it never reaches the driver, and on a `Section` it propagates to every row and clobbers the row ids (issue #19).

## E. `intent_critical` and `dynamic`

- `intent_critical: true` when the name is one of `save, send, submit, pay, purchase, buy, checkout, delete, remove,
  confirm, approve, sign, transfer, publish, post, archive`, or the role is destructive — **and** the handler mutates
  persisted or remote state. `login.submit.button` stays `false` (pilot precedent: it commits nothing). Every `true` is
  a `decisions[] {kind: intent_critical}` with `intent_reason` `commit_verb` or `destructive_role`; the human confirms
  each one, and a heal never touches an `intent_critical` element.
- On a gate control `intent_critical` is required, true or false, never inferred (01 R7).
- `dynamic: true` on lists, cells, and `text` whose content is an interpolation or model binding (`Text(invoice.client)`,
  `label.text = model.x`): the scrubber drops their text and the signature excludes them (01 R4). A static form label is
  `text` without `dynamic`.

## F. Reuse

The skill matches each proposal against the registry, in order, and keeps the existing entry on a hit:

1. Exact id.
2. Same `(feature, name)` and a kind synonym (`invoice.list.table` ↔ `invoice.list.list`) → the existing id.
3. Same screen with an equal static `title`.

An existing entry is never re-kinded, re-flagged or re-titled (`validate` rule 2 ties `title` to the screen file); a
mismatch is a `registry_delta.conflicts[]` entry, not an edit. A pre-existing `accessibilityIdentifier` literal that
already satisfies 01 R2 is reused verbatim as the registry id (`existing_literal`); one that does not gets the proposed
id plus a `rename_candidates[]` entry listing the XCUITest files that reference the literal. An item that already calls
`appMapScreen`/`appMapID` with a generated constant is `already_marked` and is never re-marked.

## G. Conflicts and renames

- Conflict reasons: `kind_mismatch`, `flag_mismatch`, `title_mismatch`, `duplicate_name`, `no_signal`. Each becomes a
  `decisions[] {kind: conflict}`; no source is edited for a conflicting item.
- A rename is a map migration, never a casual edit (01 R2, 02 §8):
  `tools/app-map-mcp/bin/app-map migrate-id OLD NEW --dry-run` is shown, the human says yes, the skill runs it for real,
  then re-dispatches the affected files. Specialists never rename or delete an id or an identifier; `double_marked`
  goes to the report.
- Registry entries the app does not have (the pilot map on a real app) are `retire` decisions: never deleted by the skill,
  `marker_unreferenced` for them is an expected residual until the human answers, and removal also needs the screen file
  under `app-map/ios/screens/` removed — a map edit outside this run.

## H. Synonyms

Role words — the only label text that may name an element (§B rung 6):

| Label | name |
|---|---|
| New, Create, Add, + | `add` |
| Done, Save | `save` |
| Send, Submit | `submit` |
| Sign in, Log in, Login | `submit` |
| Back | `back` |
| Cancel, Close, Dismiss | `cancel` |
| Edit | `edit` |
| Forgot… | `forgot` |
| Filter | `filter` |
| Search | `search` |

Last-segment synonyms `lint-ids` accepts without a warning (the pilot uses `table` and `collection` for UIKit lists):

| kind | accepted last segment |
|---|---|
| `button` | `button`, `btn` |
| `field` | `field`, `input`, `textfield` |
| `list` | `list`, `table`, `collection`, `grid` |
| `cell` | `cell`, `row`, `item` |
| `toggle` | `toggle`, `switch`, `checkbox` |
| `tab` | `tab` |
| `picker` | `picker`, `select`, `dropdown` |
| `link` | `link` |
| `text` | `text`, `label`, `title` |
| `sheet` | `sheet`, `modal`, `dialog` |
