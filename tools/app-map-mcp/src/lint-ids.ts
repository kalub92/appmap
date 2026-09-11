/**
 * [D2] `app-map lint-ids` (01 R8; 06 R2). Runs in CI and pre-commit.
 *
 * Rules (each produces `LintIdsResult.issues[].rule`; `severity: 'error'` unless noted):
 *  - `marker_unreferenced`: a screen in `ids.yaml` whose marker constant (`AppMapID.Screen.<lowerCamel>`
 *    / `AppMapId.Screen.<UPPER_SNAKE>`, naming as in scripts/app-map/gen-ids) is not referenced
 *    in a platform's source tree — reported PER PLATFORM (`platform: ios|android`, 01 R8 "in iOS
 *    and Android source"); `opts.platforms` scopes the check to the instrumented platforms
 *    (Stage 0 is iOS-only, 08 §6) and a platform whose source dirs do not exist is skipped;
 *  - `bad_id`: any id in `ids.yaml` violating 01 R2 (`SCREEN_ID_REGEX`, `GATE_ID_REGEX`,
 *    `GATE_DISMISS_REGEX`, `ELEMENT_ID_REGEX` for `elements[]`) — error. The last segment is NOT
 *    required to equal the registry `kind` (01 R1's example is `invoice.list.table` with
 *    `kind: list`; the pilot has `table`/`collection` lists): a last segment that is neither the
 *    kind nor a known synonym (`KIND_SYNONYMS`) is a `warning` only. `lint-ids` MUST pass on
 *    the committed pilot ids.yaml (06 R2) — lint-ids.test.ts asserts it;
 *  - `orphan_constant`: a constant in the generated files with no `ids.yaml` entry;
 *  - `string_literal_id`: a string literal in UI code matching `ID_REGEX` with a `screen.`,
 *    `gate.` or registered-element prefix (`"invoice.save.button"`) outside the generated files,
 *    tests and `app-map/` — app code must use the constants;
 *  - `generated_out_of_sync`: generated constants differ from `ids.yaml` (delegates to
 *    `scripts/app-map/gen-ids --check` when present, else compares names).
 * Source roots default to `instrumentation/ios`, `instrumentation/android` plus any `--src`
 * globs; only `*.swift`, `*.kt`, `*.java`, `*.m` are scanned.
 *
 * Layer: top (imports config, paths, yaml/load, types).
 */
import type { AppMapConfig, Platform } from './config.ts';
import type { ElementKind, LintIdsResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface LintIdsOptions {
  repoRoot: string;
  /** platforms whose source trees must reference every marker (default: both; `--platform ios`) */
  platforms?: Platform[];
  /** directories scanned for Swift/ObjC (default `instrumentation/ios`, `ios`) */
  iosDirs?: string[];
  /** directories scanned for Kotlin/Java (default `instrumentation/android`, `android`) */
  androidDirs?: string[];
  /** generated constant files (defaults as in scripts/app-map/gen-ids) */
  generated?: { swift: string; kotlin: string };
  /** path to scripts/app-map/gen-ids (default `<repoRoot>/scripts/app-map/gen-ids`) */
  genIdsScript?: string;
}

/** kind-segment synonyms accepted without a warning (01 R2 names the kind vocabulary, not the segment spelling) */
export const KIND_SYNONYMS: Readonly<Record<ElementKind, readonly string[]>> = {
  button: ['button', 'btn'], field: ['field', 'input', 'textfield'], list: ['list', 'table', 'collection', 'grid'],
  cell: ['cell', 'row', 'item'], toggle: ['toggle', 'switch', 'checkbox'], tab: ['tab'], picker: ['picker', 'select', 'dropdown'],
  link: ['link'], text: ['text', 'label', 'title'], sheet: ['sheet', 'modal', 'dialog'],
};

export function lintIds(config: Pick<AppMapConfig, 'dir'>, opts: LintIdsOptions): LintIdsResult {
  void config; void opts;
  throw new NotImplementedError('lint-ids.lintIds');
}

/** Pure: constant names as gen-ids derives them (`invoice.save.button` → `invoiceSaveButton` / `INVOICE_SAVE_BUTTON`). */
export function constantNames(id: string): { swift: string; kotlin: string } {
  void id;
  throw new NotImplementedError('lint-ids.constantNames');
}

/** Pure: string literals in a source text that look like registry ids (rule `string_literal_id`), with line numbers. */
export function findStringLiteralIds(source: string, knownPrefixes: ReadonlySet<string>): Array<{ id: string; line: number }> {
  void source; void knownPrefixes;
  throw new NotImplementedError('lint-ids.findStringLiteralIds');
}
