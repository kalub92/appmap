# Survey plan contract — `plan.json` and `plan_slice`

The plan is the only thing that passes between the `app-instrument` skill and its three agents. `app-instrument-surveyor`
reads one source directory and returns a **`plan_slice`** (JSON text, nothing else); the skill merges the slices into
`app-map/.local/instrument/plan.json` (git-ignored, regenerable), adds `app.layout`/`app.xcode`, edits `app-map/ids.yaml`,
runs `scripts/app-map/gen-ids`, and fills every `constant` from the generated `AppMapID.swift`; `app-instrument-swiftui` and
`app-instrument-uikit` then receive one file batch each and edit only at the `anchor` an item names, with only the
`constant` an item carries (01 R8). The surveyor never writes a constant (it always emits `null`); a specialist never
derives one (an item with `constant: null` is refused, status `blocked`, note `no_constant`). The schema below is the
contract; the test suite compiles it with Ajv and validates `tools/app-map-mcp/fixtures/instrument/plan.pilot.json`
against it, so a field that is not here does not exist.

`plan.pilot.json` is a worked example of a plan as the skill hands it to a specialist: a *pre-instrumentation* survey
of the pilot app, every item `status: todo` and `already_marked: false`. Its anchors were re-taken from the finished
fixtures under `tools/app-map-mcp/fixtures/instrument/ios/swiftui/`, which already carry every call the plan asks for,
so it is a shape to copy and never a plan to apply: run against those files it would double-mark them. A real survey
of an instrumented file sets `already_marked: true` with `existing_id`, and the specialist skips the item.

## Schema

Draft-07, `additionalProperties: false` on every object. The root is the full plan; `definitions/plan_slice` is what the
surveyor returns (same `files[]`, `registry_delta`, `fixtures_needed[]`, `coverage`, `decisions[]`; its `app` has no
`layout` and no `xcode`, and carries only the keys that slice's files establish).

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "https://app-map.local/schema/survey-plan.schema.json",
  "title": "app-map instrumentation plan",
  "description": "The root is the full plan the app-instrument skill keeps at app-map/.local/instrument/plan.json. definitions/plan_slice is what app-instrument-surveyor returns for one source directory: the same files[], registry_delta, fixtures_needed, coverage and decisions[], and an app object without the skill-filled layout and xcode.",
  "definitions": {
    "screen_id": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9_]*$",
      "description": "01 R2: bare snake_case screen id (invoice_list); the marker is screen.<id>"
    },
    "screen_id_or_null": {
      "type": ["string", "null"],
      "pattern": "^[a-z][a-z0-9_]*$"
    },
    "element_id": {
      "type": "string",
      "pattern": "^(?!screen\\.|gate\\.)[a-z0-9]+(\\.[a-z0-9_]+){2,}$",
      "description": "01 R2: <feature>.<name>.<kind>, three or more segments"
    },
    "element_id_or_null": {
      "type": ["string", "null"],
      "pattern": "^(?!screen\\.|gate\\.)[a-z0-9]+(\\.[a-z0-9_]+){2,}$"
    },
    "gate_id": {
      "type": "string",
      "pattern": "^gate\\.[a-z0-9_]+$",
      "description": "01 R2: gate.<name>"
    },
    "gate_id_or_null": {
      "type": ["string", "null"],
      "pattern": "^gate\\.[a-z0-9_]+$"
    },
    "gate_control_id": {
      "type": "string",
      "pattern": "^gate\\.[a-z0-9_]+\\.[a-z0-9_]+$",
      "description": "01 R2: gate.<name>.<verb> — the dismiss control or another control of the same dialog"
    },
    "any_id_or_null": {
      "type": ["string", "null"],
      "pattern": "^([a-z][a-z0-9_]*|[a-z0-9]+(\\.[a-z0-9_]+)+)$",
      "description": "a screen, element or gate id; the role conditionals below narrow it"
    },
    "constant_or_null": {
      "type": ["string", "null"],
      "pattern": "^AppMapID\\.(Screen|Element|Gate|Gate\\.Dismiss|Gate\\.Control)\\.`?[A-Za-z_][A-Za-z0-9_]*`?$",
      "description": "a generated constant name, read back from AppMapID.swift by the skill after gen-ids; the surveyor always emits null"
    },
    "element_kind": {
      "type": "string",
      "enum": ["button", "field", "list", "cell", "toggle", "tab", "picker", "link", "text", "sheet"]
    },
    "kind": {
      "type": "string",
      "enum": ["button", "field", "list", "cell", "toggle", "tab", "picker", "link", "text", "sheet", "none"],
      "description": "01 R2 element kind; none for screens, gates, wiring, hosts, risks and List/Section/ForEach containers (issue #19)"
    },
    "role": {
      "type": "string",
      "enum": ["screen", "element", "gate", "tab", "wiring", "host", "risk"]
    },
    "owner": {
      "type": "string",
      "enum": ["swiftui", "uikit", "objc", "ib", "none"],
      "description": "which specialist edits the file; objc and ib are reported, never dispatched"
    },
    "presentation": {
      "type": "string",
      "enum": ["root", "push", "sheet", "cover", "popover", "tab", "page", "modal", "alert", "native"]
    },
    "marker_site": {
      "type": "string",
      "enum": ["body", "viewDidLoad", "viewWillAppear", "none_hosted"]
    },
    "deep_link": {
      "type": "string",
      "enum": ["proposed", "none"]
    },
    "intent_reason": {
      "type": "string",
      "enum": ["commit_verb", "destructive_role", "none"]
    },
    "risk": {
      "type": "string",
      "enum": ["subviews_indexing", "root_is_a11y_element", "a11y_hazard", "objc_file", "ib_identifier", "double_marked", "scheme_collision", "multi_module"]
    },
    "status": {
      "type": "string",
      "enum": ["todo", "done", "skipped", "blocked", "verify_on_device"],
      "description": "the surveyor emits todo; specialists return done, skipped, blocked or verify_on_device with a note"
    },
    "name_source": {
      "type": "string",
      "pattern": "^(action_symbol|binding|nav_target|tab_case|role|role_word):[A-Za-z0-9_.]+$",
      "description": "id-rules §B: the first signal that produced the name, prefix:value"
    },
    "wiring_kind": {
      "type": "string",
      "enum": ["registry", "handler", "router_mapping", "fixtures", "endpoint", "scheme"]
    },
    "decision_kind": {
      "type": "string",
      "enum": ["intent_critical", "gate_control", "no_deep_link", "fixture_needed", "conflict", "rename", "retire", "double_marked", "subviews_indexing", "root_is_a11y_element", "a11y_hazard", "system_element", "ib_identifier", "ib_outlet_missing", "objc_file", "flags_missing", "plist", "pbxproj_add_files", "scheme", "sandbox_source", "multi_module", "verify_on_device", "not_a_screen", "reused_vc", "coverage"]
    },
    "anchor": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "line": { "type": "integer", "minimum": 1 },
        "snippet": { "type": "string", "minLength": 1, "description": "the source line, trimmed, verbatim; specialists edit only where it matches (line may drift by ±5)" }
      },
      "required": ["line", "snippet"]
    },
    "gate_control": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/definitions/gate_control_id" },
        "intent_critical": { "type": "boolean", "description": "01 R7: REQUIRED on every control" },
        "constant": { "$ref": "#/definitions/constant_or_null", "description": "AppMapID.Gate.Control.<name>, skill-filled; null from the surveyor" }
      },
      "required": ["id", "intent_critical"]
    },
    "gate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "native": { "type": "boolean", "description": "true: OS dialog or UIAlertController, no code; false: in-app dialog that gets a marker, a dismiss id and control ids" },
        "dismiss": { "$ref": "#/definitions/gate_control_id" },
        "dismiss_intent_critical": { "type": "boolean" },
        "dismiss_constant": { "$ref": "#/definitions/constant_or_null", "description": "AppMapID.Gate.Dismiss.<name>, skill-filled; null from the surveyor" },
        "controls": { "type": "array", "items": { "$ref": "#/definitions/gate_control" } }
      },
      "required": ["native", "dismiss", "controls"]
    },
    "static_edge": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "element": { "$ref": "#/definitions/element_id" },
        "to": { "$ref": "#/definitions/screen_id" }
      },
      "required": ["element", "to"]
    },
    "a11y_hazard": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "line": { "type": "integer", "minimum": 1 },
        "modifier": { "type": "string", "minLength": 1 },
        "impact": { "type": "string", "minLength": 1 }
      },
      "required": ["line", "modifier", "impact"]
    },
    "wiring": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kind": { "$ref": "#/definitions/wiring_kind" },
        "new_files": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "the only paths a specialist may Write; non-empty only when app.wiring_placement is new_files" }
      },
      "required": ["kind", "new_files"]
    },
    "item": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "role": { "$ref": "#/definitions/role" },
        "decl": { "type": "string", "minLength": 1, "description": "the enclosing declaration (view, view controller, App, delegate)" },
        "anchor": { "$ref": "#/definitions/anchor" },
        "screen": { "$ref": "#/definitions/screen_id_or_null", "description": "the screen this item belongs to; null for tabs, wiring and app-wide risks" },
        "proposed_id": { "$ref": "#/definitions/any_id_or_null", "description": "the id this item should carry (new or reused); null when already_marked or a conflict decision withholds one" },
        "existing_id": { "$ref": "#/definitions/any_id_or_null", "description": "the registered id the code already references through a generated constant" },
        "constant": { "$ref": "#/definitions/constant_or_null" },
        "kind": { "$ref": "#/definitions/kind" },
        "name_source": { "$ref": "#/definitions/name_source" },
        "dynamic": { "type": "boolean" },
        "intent_critical": { "type": "boolean" },
        "intent_reason": { "$ref": "#/definitions/intent_reason" },
        "construct": { "type": "string", "minLength": 1 },
        "presentation": { "$ref": "#/definitions/presentation" },
        "marker_owner": { "type": "string", "minLength": 1 },
        "marker_site": { "$ref": "#/definitions/marker_site" },
        "mode_condition": { "type": ["string", "null"] },
        "hosted_by": { "type": ["string", "null"] },
        "title": { "type": ["string", "null"], "description": "only a static .navigationTitle / navigationItem.title literal" },
        "deep_link": { "$ref": "#/definitions/deep_link" },
        "deep_link_needs": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "params": { "type": "array", "items": { "type": "string", "minLength": 1 } },
            "fixture": { "type": ["string", "null"] }
          },
          "required": ["params", "fixture"]
        },
        "route_case": { "type": ["string", "null"] },
        "static_edges": { "type": "array", "items": { "$ref": "#/definitions/static_edge" } },
        "gate": { "$ref": "#/definitions/gate" },
        "system_element": { "type": "boolean" },
        "existing_literal": { "type": ["string", "null"] },
        "a11y_hazards": { "type": "array", "items": { "$ref": "#/definitions/a11y_hazard" } },
        "already_marked": { "type": "boolean" },
        "already_wired": { "type": "boolean" },
        "wiring": { "$ref": "#/definitions/wiring" },
        "risk": { "$ref": "#/definitions/risk" },
        "status": { "$ref": "#/definitions/status" },
        "note": { "type": "string" }
      },
      "required": ["role", "decl", "anchor", "status"],
      "allOf": [
        {
          "if": { "properties": { "role": { "const": "screen" } }, "required": ["role"] },
          "then": {
            "properties": {
              "proposed_id": { "$ref": "#/definitions/screen_id_or_null" },
              "existing_id": { "$ref": "#/definitions/screen_id_or_null" },
              "constant": { "type": ["string", "null"], "pattern": "^AppMapID\\.Screen\\." },
              "marker_owner": { "type": "string", "minLength": 1 },
              "marker_site": { "$ref": "#/definitions/marker_site" },
              "presentation": { "$ref": "#/definitions/presentation" },
              "deep_link": { "$ref": "#/definitions/deep_link" }
            },
            "required": ["proposed_id", "constant", "marker_owner", "marker_site", "presentation", "deep_link"]
          }
        },
        {
          "if": { "properties": { "role": { "const": "element" } }, "required": ["role"] },
          "then": {
            "properties": {
              "screen": { "$ref": "#/definitions/screen_id" },
              "proposed_id": { "$ref": "#/definitions/element_id_or_null" },
              "existing_id": { "$ref": "#/definitions/element_id_or_null" },
              "constant": { "type": ["string", "null"], "pattern": "^AppMapID\\.Element\\." },
              "kind": { "$ref": "#/definitions/element_kind" },
              "dynamic": { "type": "boolean" },
              "intent_critical": { "type": "boolean" }
            },
            "required": ["screen", "proposed_id", "constant", "kind", "dynamic", "intent_critical"]
          }
        },
        {
          "if": { "properties": { "role": { "const": "tab" } }, "required": ["role"] },
          "then": {
            "properties": {
              "proposed_id": { "type": ["string", "null"], "pattern": "^nav\\.[a-z0-9_]+\\.tab$" },
              "existing_id": { "type": ["string", "null"], "pattern": "^nav\\.[a-z0-9_]+\\.tab$" },
              "constant": { "type": ["string", "null"], "pattern": "^AppMapID\\.Element\\." },
              "kind": { "type": "string", "const": "tab" }
            },
            "required": ["proposed_id", "constant", "kind"]
          }
        },
        {
          "if": { "properties": { "role": { "const": "gate" } }, "required": ["role"] },
          "then": {
            "properties": {
              "proposed_id": { "$ref": "#/definitions/gate_id_or_null" },
              "existing_id": { "$ref": "#/definitions/gate_id_or_null" },
              "constant": { "type": ["string", "null"], "pattern": "^AppMapID\\.Gate\\.(?!Dismiss\\.|Control\\.)" },
              "gate": { "$ref": "#/definitions/gate" },
              "presentation": { "$ref": "#/definitions/presentation" }
            },
            "required": ["proposed_id", "constant", "gate", "presentation"]
          }
        },
        {
          "if": { "properties": { "role": { "const": "wiring" } }, "required": ["role"] },
          "then": {
            "properties": {
              "wiring": { "$ref": "#/definitions/wiring" },
              "already_wired": { "type": "boolean" }
            },
            "required": ["wiring", "already_wired"]
          }
        },
        {
          "if": { "properties": { "role": { "const": "risk" } }, "required": ["role"] },
          "then": {
            "properties": {
              "risk": { "$ref": "#/definitions/risk" }
            },
            "required": ["risk"]
          }
        }
      ]
    },
    "file": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "path": { "type": "string", "minLength": 1, "description": "relative to the repo root" },
        "owner": { "$ref": "#/definitions/owner" },
        "lines": { "type": "array", "items": { "type": "integer", "minimum": 1 }, "minItems": 2, "maxItems": 2, "description": "[first, last] when one file yields two entries (a View and a VC)" },
        "hosts": {
          "type": "object",
          "additionalProperties": false,
          "properties": {
            "root_type": { "type": "string", "minLength": 1 },
            "file": { "type": "string", "minLength": 1 }
          },
          "required": ["root_type", "file"],
          "description": "a UIKit file whose hosting controller wraps this SwiftUI root; the marker lives in the root (issue #15)"
        },
        "items": { "type": "array", "items": { "$ref": "#/definitions/item" } }
      },
      "required": ["path", "owner", "items"]
    },
    "screen_add": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/definitions/screen_id" },
        "title": { "type": ["string", "null"] },
        "deep_link": { "type": "string", "pattern": "^(appmap://[a-z][a-z0-9_]*|none)$" }
      },
      "required": ["id", "deep_link"]
    },
    "gate_add": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/definitions/gate_id" },
        "dismiss": { "$ref": "#/definitions/gate_control_id" },
        "dismiss_intent_critical": { "type": "boolean" },
        "controls": {
          "type": "array",
          "items": {
            "type": "object",
            "additionalProperties": false,
            "properties": {
              "id": { "$ref": "#/definitions/gate_control_id" },
              "intent_critical": { "type": "boolean" }
            },
            "required": ["id", "intent_critical"]
          }
        }
      },
      "required": ["id", "dismiss"]
    },
    "element_add": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "$ref": "#/definitions/element_id" },
        "kind": { "$ref": "#/definitions/element_kind" },
        "intent_critical": { "type": "boolean" },
        "dynamic": { "type": "boolean" }
      },
      "required": ["id", "kind"]
    },
    "reuse": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "pattern": "^([a-z][a-z0-9_]*|[a-z0-9]+(\\.[a-z0-9_]+)+)$", "description": "the registered id kept" },
        "decl": { "type": "string", "minLength": 1 },
        "reason": { "type": "string", "enum": ["exact", "kind_synonym", "title"], "description": "id-rules §F ladder" }
      },
      "required": ["id", "decl", "reason"]
    },
    "rename_candidate": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "literal": { "type": "string", "minLength": 1, "description": "the pre-existing accessibilityIdentifier literal that does not satisfy 01 R2" },
        "id": { "$ref": "#/definitions/element_id" },
        "file": { "type": "string", "minLength": 1 },
        "line": { "type": "integer", "minimum": 1 },
        "xcuitest_impact": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "test files that reference the literal" }
      },
      "required": ["literal", "id", "file", "line", "xcuitest_impact"]
    },
    "conflict": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "id": { "type": ["string", "null"], "pattern": "^([a-z][a-z0-9_]*|[a-z0-9]+(\\.[a-z0-9_]+)+)$", "description": "null when no id could be proposed (icon-only control with no signal)" },
        "decl": { "type": "string", "minLength": 1 },
        "reason": { "type": "string", "enum": ["kind_mismatch", "flag_mismatch", "title_mismatch", "duplicate_name", "no_signal"] },
        "existing": { "type": ["string", "null"] },
        "proposed": { "type": ["string", "null"] }
      },
      "required": ["id", "decl", "reason"]
    },
    "registry_delta": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "screens_add": { "type": "array", "items": { "$ref": "#/definitions/screen_add" } },
        "gates_add": { "type": "array", "items": { "$ref": "#/definitions/gate_add" } },
        "elements_add": { "type": "array", "items": { "$ref": "#/definitions/element_add" } },
        "reuse": { "type": "array", "items": { "$ref": "#/definitions/reuse" } },
        "rename_candidates": { "type": "array", "items": { "$ref": "#/definitions/rename_candidate" } },
        "conflicts": { "type": "array", "items": { "$ref": "#/definitions/conflict" } }
      },
      "required": ["screens_add", "gates_add", "elements_add", "reuse", "rename_candidates", "conflicts"]
    },
    "fixture_needed": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "name": { "type": "string", "pattern": "^[a-z][a-z0-9_]*$" },
        "for_screens": { "type": "array", "items": { "$ref": "#/definitions/screen_id" }, "minItems": 1 },
        "hint": { "type": "string", "minLength": 1, "description": "what the fixture must seed, as a call shape; never a value" }
      },
      "required": ["name", "for_screens", "hint"]
    },
    "coverage": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "view_types_seen": { "type": "integer", "minimum": 0 },
        "unassigned_views": { "type": "array", "items": { "type": "string", "minLength": 1 }, "description": "every View or VC type the surveyor could not classify" }
      },
      "required": ["view_types_seen", "unassigned_views"]
    },
    "decision": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "kind": { "$ref": "#/definitions/decision_kind" },
        "ref": { "type": ["string", "null"], "description": "the id, type, file or literal the decision is about; null for app-wide decisions" },
        "text": { "type": "string", "minLength": 1 },
        "default": { "type": ["string", "null"], "description": "what the skill does when the human does not answer" }
      },
      "required": ["kind", "ref", "text", "default"]
    },
    "entry_point": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "file": { "type": "string", "minLength": 1 },
        "type": { "type": "string", "minLength": 1 }
      },
      "required": ["file", "type"]
    },
    "router": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "file": { "type": ["string", "null"] },
        "type": { "type": ["string", "null"] },
        "shape": { "type": "string", "enum": ["observable_path", "coordinator", "none"] },
        "route_enum": { "type": ["string", "null"] }
      },
      "required": ["file", "type", "shape", "route_enum"]
    },
    "flags": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "app_map_debug_defined": { "type": "boolean" },
        "where": { "type": "string", "enum": ["xcconfig", "pbxproj", "unknown"] },
        "modules_missing": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      },
      "required": ["app_map_debug_defined", "where", "modules_missing"]
    },
    "wiring_existing": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "handler": { "type": "boolean" },
        "registry": { "type": "boolean" },
        "endpoint": { "type": "boolean" },
        "scheme": { "type": "boolean" },
        "debug_block": { "type": "boolean" }
      },
      "required": ["handler", "registry", "endpoint", "scheme", "debug_block"]
    },
    "layout": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "repo_root": { "type": "string", "minLength": 1 },
        "generated_swift": { "type": "string", "minLength": 1 },
        "kotlin_present": { "type": "boolean" },
        "default_scan_dirs": { "type": "array", "items": { "type": "string", "minLength": 1 } }
      },
      "required": ["repo_root", "generated_swift", "kotlin_present", "default_scan_dirs"]
    },
    "app": {
      "type": "object",
      "additionalProperties": false,
      "properties": {
        "src_roots": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 },
        "bundle_id": { "type": ["string", "null"] },
        "module": { "type": "string", "minLength": 1 },
        "lifecycle": { "type": "string", "enum": ["swiftui_app", "uikit_scene", "uikit_appdelegate"] },
        "entry_point": { "$ref": "#/definitions/entry_point" },
        "url_entry_points": { "type": "array", "items": { "type": "string", "minLength": 1 } },
        "router": { "$ref": "#/definitions/router" },
        "flags": { "$ref": "#/definitions/flags" },
        "project_style": { "type": "string", "enum": ["synchronized", "generated", "classic"] },
        "wiring_placement": { "type": "string", "enum": ["inline", "new_files"] },
        "wiring_existing": { "$ref": "#/definitions/wiring_existing" },
        "scheme": { "type": "string", "pattern": "^[a-z][a-z0-9+.-]{0,63}$" },
        "layout": { "$ref": "#/definitions/layout" },
        "xcode": { "type": "boolean" }
      },
      "required": ["src_roots", "bundle_id", "module", "lifecycle", "entry_point", "url_entry_points", "router", "flags", "project_style", "wiring_placement", "wiring_existing", "scheme", "layout", "xcode"]
    },
    "app_slice": {
      "type": "object",
      "additionalProperties": false,
      "description": "the app facts one slice establishes or was given; a key the slice's files do not establish is omitted, never guessed. No layout, no xcode: the skill fills those.",
      "properties": {
        "src_roots": { "type": "array", "items": { "type": "string", "minLength": 1 }, "minItems": 1 },
        "bundle_id": { "type": ["string", "null"] },
        "module": { "type": "string", "minLength": 1 },
        "lifecycle": { "type": "string", "enum": ["swiftui_app", "uikit_scene", "uikit_appdelegate"] },
        "entry_point": { "$ref": "#/definitions/entry_point" },
        "url_entry_points": { "type": "array", "items": { "type": "string", "minLength": 1 } },
        "router": { "$ref": "#/definitions/router" },
        "flags": { "$ref": "#/definitions/flags" },
        "project_style": { "type": "string", "enum": ["synchronized", "generated", "classic"] },
        "wiring_placement": { "type": "string", "enum": ["inline", "new_files"] },
        "wiring_existing": { "$ref": "#/definitions/wiring_existing" },
        "scheme": { "type": "string", "pattern": "^[a-z][a-z0-9+.-]{0,63}$" }
      }
    },
    "plan_slice": {
      "type": "object",
      "additionalProperties": false,
      "description": "what app-instrument-surveyor returns, as JSON text and nothing else",
      "properties": {
        "schema_version": { "type": "integer", "const": 1 },
        "app": { "$ref": "#/definitions/app_slice" },
        "files": { "type": "array", "items": { "$ref": "#/definitions/file" } },
        "registry_delta": { "$ref": "#/definitions/registry_delta" },
        "fixtures_needed": { "type": "array", "items": { "$ref": "#/definitions/fixture_needed" } },
        "coverage": { "$ref": "#/definitions/coverage" },
        "decisions": { "type": "array", "items": { "$ref": "#/definitions/decision" } }
      },
      "required": ["schema_version", "app", "files", "registry_delta", "fixtures_needed", "coverage", "decisions"]
    }
  },
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "schema_version": { "type": "integer", "const": 1 },
    "app": { "$ref": "#/definitions/app" },
    "files": { "type": "array", "items": { "$ref": "#/definitions/file" } },
    "registry_delta": { "$ref": "#/definitions/registry_delta" },
    "fixtures_needed": { "type": "array", "items": { "$ref": "#/definitions/fixture_needed" } },
    "coverage": { "$ref": "#/definitions/coverage" },
    "decisions": { "type": "array", "items": { "$ref": "#/definitions/decision" } }
  },
  "required": ["schema_version", "app", "files", "registry_delta", "fixtures_needed", "coverage", "decisions"]
}
```

## Fields

Top level (`plan.json`):

| Field | Type | Example |
|---|---|---|
| `schema_version` | int | `1` |
| `app.src_roots` | string[] | `["App/"]` |
| `app.bundle_id` | string\|null | `"com.example.app"` |
| `app.module` | string | `"Invoices"` |
| `app.lifecycle` | `swiftui_app\|uikit_scene\|uikit_appdelegate` | `"swiftui_app"` |
| `app.entry_point` | `{file, type}` | `{"file":"App/InvoicesApp.swift","type":"InvoicesApp"}` |
| `app.url_entry_points` | string[] | `["SceneDelegate.scene(_:willConnectTo:options:)","SceneDelegate.scene(_:openURLContexts:)"]` |
| `app.router` | `{file, type, shape: observable_path\|coordinator\|none, route_enum}` | `{"file":"App/AppRouter.swift","type":"AppRouter","shape":"observable_path","route_enum":"Route"}` |
| `app.flags` | `{app_map_debug_defined: bool, where: xcconfig\|pbxproj\|unknown, modules_missing: string[]}` | `{"app_map_debug_defined":true,"where":"xcconfig","modules_missing":[]}` |
| `app.project_style` | `synchronized\|generated\|classic` | `"classic"` |
| `app.wiring_placement` | `inline\|new_files` | `"inline"` |
| `app.wiring_existing` | `{handler, registry, endpoint, scheme, debug_block: bool}` | all `false` |
| `app.scheme` | string | `"appmap"` |
| `app.layout` | `{repo_root, generated_swift, kotlin_present, default_scan_dirs}` (skill-filled) | `{"kotlin_present":true,…}` |
| `app.xcode` | bool (skill-filled) | `false` |
| `files[]` | see below | |
| `registry_delta` | `{screens_add[], gates_add[], elements_add[], reuse[], rename_candidates[], conflicts[]}` | |
| `fixtures_needed[]` | `{name, for_screens[], hint}` | `{"name":"logged_in","for_screens":["invoice_list"],"hint":"Session.signIn(sandboxAccount)"}` |
| `coverage` | `{view_types_seen: int, unassigned_views: string[]}` | |
| `decisions[]` | `{kind, ref, text, default}` | `{"kind":"intent_critical","ref":"invoice.save.button","text":"commit verb save","default":"true"}` |

`files[]` entry: `{ path: string, owner: swiftui|uikit|objc|ib|none, lines?: [int,int], hosts?: {root_type, file}, items: item[] }`.

`item` (one per declaration/element; `role` decides which optional fields apply):

| Field | Type | Example |
|---|---|---|
| `role` | `screen\|element\|gate\|tab\|wiring\|host\|risk` | `"element"` |
| `decl` | string | `"InvoiceNewView"` |
| `anchor` | `{line: int, snippet: string}` (verbatim source line, trimmed) | `{"line":41,"snippet":"Button(action: save) {"}` |
| `screen` | screen id this item belongs to | `"invoice_new"` |
| `proposed_id` / `existing_id` | string\|null | `"invoice.save.button"` / `null` |
| `constant` | string\|null (skill-filled) | `"AppMapID.Element.invoiceSaveButton"` |
| `kind` | ElementKind\|`none` | `"button"` |
| `name_source` | `action_symbol:<s>\|binding:<s>\|nav_target:<s>\|tab_case:<s>\|role:<s>\|role_word:<s>` | `"action_symbol:save"` |
| `dynamic`, `intent_critical` | bool | |
| `intent_reason` | `commit_verb\|destructive_role\|none` | |
| `construct` | string | `"ToolbarItem/Button"`, `"UIBarButtonItem"`, `"CellRegistration"` |
| `presentation` | `root\|push\|sheet\|cover\|popover\|tab\|page\|modal\|alert\|native` | |
| `marker_owner` | type name (screens) | `"InvoiceNewView"` |
| `marker_site` | `body\|viewDidLoad\|viewWillAppear\|none_hosted` | |
| `mode_condition` | string\|null | `"mode == .edit"` |
| `hosted_by` | type\|null | `"InvoiceListHostingController"` |
| `title` | string\|null (static nav title only) | `"New Invoice"` |
| `deep_link` | `proposed\|none` | |
| `deep_link_needs` | `{params[], fixture}` | `{"params":["invoice_id"],"fixture":"one_draft_invoice"}` |
| `route_case` | string\|null | `"Route.invoiceNew"` |
| `static_edges[]` | `{element, to}` | `{"element":"invoice.add.button","to":"invoice_new"}` |
| `gate` | `{native: bool, dismiss, dismiss_intent_critical?, controls: [{id, intent_critical}]}` | |
| `system_element` | bool | `.searchable`, `Menu` item, alert button |
| `existing_literal` | string\|null | `"loginEmail"` |
| `a11y_hazards[]` | `{line, modifier, impact}` | |
| `already_marked`, `already_wired` | bool | |
| `risk` | `subviews_indexing\|root_is_a11y_element\|a11y_hazard\|objc_file\|ib_identifier\|double_marked\|scheme_collision\|multi_module` | |
| `status` | `todo\|done\|skipped\|blocked\|verify_on_device` | |
| `note` | string | `"no_constant"`, `"anchor_not_found"`, `"back_button_label_matched"` |

`decisions[].kind` ∈ `intent_critical | gate_control | no_deep_link | fixture_needed | conflict | rename | retire |
double_marked | subviews_indexing | root_is_a11y_element | a11y_hazard | system_element | ib_identifier |
ib_outlet_missing | objc_file | flags_missing | plist | pbxproj_add_files | scheme | sandbox_source | multi_module |
verify_on_device | not_a_screen | reused_vc | coverage`.

Three fields the schema adds so that every id a specialist writes arrives as a constant (safety rule 1):

| Field | Type | Applies to |
|---|---|---|
| `wiring` | `{kind: registry\|handler\|router_mapping\|fixtures\|endpoint\|scheme, new_files: string[]}` | `role: wiring`; `new_files` are the only paths a specialist may `Write`, non-empty only when `app.wiring_placement` is `new_files` |
| `gate.dismiss_constant` | string\|null (skill-filled) | the in-app gate's cancel control, `AppMapID.Gate.Dismiss.<name>` |
| `gate.controls[].constant` | string\|null (skill-filled) | each other control, `AppMapID.Gate.Control.<name>` |

What each role must carry (the schema enforces it): every item has `role`, `decl`, `anchor`, `status`; **screen** adds
`proposed_id`, `constant`, `marker_owner`, `marker_site`, `presentation`, `deep_link`; **element** adds `screen`,
`proposed_id`, `constant`, `kind`, `dynamic`, `intent_critical`; **tab** adds `proposed_id` (`nav.<x>.tab`), `constant`,
`kind: tab`; **gate** adds `proposed_id`, `constant`, `gate`, `presentation`; **wiring** adds `wiring`, `already_wired`;
**risk** adds `risk`. `proposed_id` is the bare screen id for a screen (`invoice_list`), never the marker; `constant` is
the marker constant. `proposed_id` is `null` only when the item is `already_marked` (then `existing_id` is set) or a
`conflict` decision withholds an id. `existing_id` is the registered id the code already references through a generated
constant. `kind` is `none` (or omitted) on everything that is not an element or tab; `List`/`Section`/`ForEach` are
never items with an id (issue #19). `status` is `todo` from the surveyor; a specialist returns `done`, `skipped`,
`blocked` or `verify_on_device`, always with a `note` when it is not `done`.

## One item per role (pilot ids)

Screen — the `NavigationStack` root of `InvoiceListView`; the marker goes last in its modifier chain (01 R3):

```json
{ "role": "screen", "decl": "InvoiceListView",
  "anchor": { "line": 12, "snippet": "NavigationStack(path: $router.path) {" },
  "screen": "invoice_list", "proposed_id": "invoice_list", "existing_id": null,
  "constant": "AppMapID.Screen.invoiceList", "kind": "none", "construct": "NavigationStack",
  "presentation": "root", "marker_owner": "InvoiceListView", "marker_site": "body",
  "mode_condition": null, "hosted_by": null, "title": "Invoices", "deep_link": "proposed",
  "deep_link_needs": { "params": [], "fixture": "logged_in" }, "route_case": null,
  "static_edges": [{ "element": "invoice.add.button", "to": "invoice_new" }],
  "already_marked": false, "status": "todo" }
```

Element — a commit verb, so `intent_critical` is true and a decision (01 R4, id-rules §E):

```json
{ "role": "element", "decl": "InvoiceNewView",
  "anchor": { "line": 41, "snippet": "Button(action: save) {" },
  "screen": "invoice_new", "proposed_id": "invoice.save.button", "existing_id": null,
  "constant": "AppMapID.Element.invoiceSaveButton", "kind": "button",
  "name_source": "action_symbol:save", "dynamic": false, "intent_critical": true,
  "intent_reason": "commit_verb", "construct": "ToolbarItem/Button",
  "existing_literal": null, "already_marked": false, "status": "todo" }
```

Gate — native, so no code is written; the constants feed the `registerGate(id:dismiss:)` call in the wiring and the
label signature is recorded by a later capture session (01 R7):

```json
{ "role": "gate", "decl": "LoginView",
  "anchor": { "line": 58, "snippet": "let ok = try await context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)" },
  "screen": "login", "proposed_id": "gate.biometric_prompt", "existing_id": null,
  "constant": "AppMapID.Gate.biometricPrompt", "kind": "none", "construct": "LAContext.evaluatePolicy",
  "presentation": "native",
  "gate": { "native": true, "dismiss": "gate.biometric_prompt.cancel",
            "dismiss_constant": "AppMapID.Gate.Dismiss.biometricPromptCancel", "controls": [] },
  "status": "todo" }
```

Tab — the id goes on the `Label` inside `.tabItem`, never on the `TabView`; the specialist returns `verify_on_device`:

```json
{ "role": "tab", "decl": "RootView",
  "anchor": { "line": 17, "snippet": ".tabItem { Label(\"Invoices\", systemImage: \"doc.text\") }" },
  "screen": null, "proposed_id": "nav.invoices.tab", "existing_id": null,
  "constant": "AppMapID.Element.navInvoicesTab", "kind": "tab", "name_source": "tab_case:invoices",
  "dynamic": false, "intent_critical": false, "construct": ".tabItem/Label", "presentation": "tab",
  "already_marked": false, "status": "todo" }
```

Wiring — one item per piece (`registry`, `handler`, `router_mapping`, `fixtures`, `endpoint`, `scheme`), in the batch
that holds `app.entry_point.file`; `already_wired: true` means the surveyor saw the piece and the specialist skips it:

```json
{ "role": "wiring", "decl": "InvoicesApp",
  "anchor": { "line": 5, "snippet": "struct InvoicesApp: App {" },
  "screen": null, "wiring": { "kind": "registry", "new_files": ["App/AppMapWiring.swift"] },
  "already_wired": false, "status": "todo" }
```

Host — a hosting controller is never marked (issue #15); the specialist confirms it carries no `appMapScreen` and
returns `done`, or `blocked` with note `double_marked`:

```json
{ "role": "host", "decl": "InvoiceHostingController",
  "anchor": { "line": 6, "snippet": "final class InvoiceHostingController: UIHostingController<AnyView> {" },
  "screen": "invoice_list", "kind": "none", "construct": "UIHostingController",
  "marker_site": "none_hosted", "hosted_by": null, "already_marked": false,
  "status": "todo", "note": "marker lives in InvoiceListView" }
```

Risk — one item per hazard; the specialist never edits the accessibility modifier, it moves the id only when the
combined element is the sole action, otherwise returns `blocked`:

```json
{ "role": "risk", "decl": "InvoiceDetailView",
  "anchor": { "line": 33, "snippet": ".accessibilityElement(children: .combine)" },
  "screen": "invoice_detail", "risk": "a11y_hazard",
  "a11y_hazards": [{ "line": 33, "modifier": ".accessibilityElement(children: .combine)",
                     "impact": "hides invoice.detail.amount.text and invoice.detail.client.text from the tree" }],
  "status": "todo" }
```

## Validating a plan or a slice

Ajv is already installed under `tools/app-map-mcp/node_modules`; from the repo root, `plan` checks the root schema
and `slice` checks `definitions/plan_slice`:

```sh
node -e '
const fs = require("fs");
const Ajv = require("./tools/app-map-mcp/node_modules/ajv").default;
const addFormats = require("./tools/app-map-mcp/node_modules/ajv-formats").default;
const md = fs.readFileSync(".claude/skills/app-instrument/reference/survey-plan.md", "utf8");
const schema = JSON.parse(md.split("```json\n")[1].split("\n```")[0]);
const ajv = new Ajv({ allErrors: true, strict: true }); addFormats(ajv);
const [, which, file] = process.argv;
const v = which === "slice" ? (ajv.addSchema(schema), ajv.getSchema(schema.$id + "#/definitions/plan_slice")) : ajv.compile(schema);
const ok = v(JSON.parse(fs.readFileSync(file, "utf8")));
console.log(ok ? "valid" : JSON.stringify(v.errors, null, 1)); process.exit(ok ? 0 : 1);
' plan app-map/.local/instrument/plan.json
```

A slice that fails is re-requested from the surveyor with the error list; the skill never repairs a slice by hand.
