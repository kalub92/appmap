/**
 * [D2] `app-map lint-ids` (01 R8; 06 R2). Runs in CI and pre-commit.
 *
 * Rules (each produces `LintIdsResult.issues[].rule`):
 *  - `marker_unreferenced`: a screen in `ids.yaml` whose marker constant (`AppMapID.Screen.<lowerCamel>`
 *    / `AppMapId.Screen.<UPPER_SNAKE>`, naming as in scripts/app-map/gen-ids) is referenced in
 *    neither the iOS nor the Android source trees;
 *  - `bad_id`: any id in `ids.yaml` violating 01 R2 (regexes in types.ts) or an element id with
 *    a `kind` segment that does not equal its `kind`;
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
import type { AppMapConfig } from './config.ts';
import type { LintIdsResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface LintIdsOptions {
  repoRoot: string;
  /** directories scanned for Swift/ObjC (default `instrumentation/ios`, `ios`) */
  iosDirs?: string[];
  /** directories scanned for Kotlin/Java (default `instrumentation/android`, `android`) */
  androidDirs?: string[];
  /** generated constant files (defaults as in scripts/app-map/gen-ids) */
  generated?: { swift: string; kotlin: string };
  /** path to scripts/app-map/gen-ids (default `<repoRoot>/scripts/app-map/gen-ids`) */
  genIdsScript?: string;
}

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
