/**
 * [A1] `app-map merge-driver %O %A %B` — semantic 3-way merge for app-map YAML (02 §9, phase 2;
 * wired by .gitattributes `merge=app-map-yaml`).
 *
 * Algorithm: parse all three; merge per key and per `id`-keyed list item (elements, variants,
 * screens, gates; edges keyed by `(action, to)`; steps keyed by `id`; locators keyed by
 * `strategy`); a key changed on one side only takes that side; changed on both sides to the
 * same value is fine; changed on both to different values is a conflict. Conflicts are
 * rendered as standard `<<<<<<< ours / ======= / >>>>>>> theirs` blocks around the *canonical
 * YAML of the conflicting subtree* and the driver exits 1 so git marks the file conflicted.
 * A clean merge is written canonically (yaml/canonical.ts) to `%A` and exits 0.
 *
 * Layer: yaml (imports types/paths/errors + yaml/*).
 */
import type { YamlKind } from './paths.ts';
import type { MergeResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

/** Pure: merge three YAML texts of the same kind. `merged` is canonical when `conflicts` is empty. */
export function mergeYamlDocuments(kind: YamlKind, base: string, ours: string, theirs: string): MergeResult {
  void kind; void base; void ours; void theirs;
  throw new NotImplementedError('merge-driver.mergeYamlDocuments');
}

/**
 * git entry point: reads the three temp files, infers the kind from `oursPath` (git passes the
 * real path in `%P`; when absent, infer from content: `steps` ⇒ recipe, `signature` ⇒ screen,
 * `elements` at root without `signature` ⇒ ids, `servers` ⇒ mcp-allowlist, `app_id` ⇒ manifest),
 * writes the result to `oursPath`, returns the process exit code (0 clean, 1 conflict, 2 error).
 */
export function runMergeDriver(basePath: string, oursPath: string, theirsPath: string, opts: { realPath?: string } = {}): number {
  void basePath; void oursPath; void theirsPath; void opts;
  throw new NotImplementedError('merge-driver.runMergeDriver');
}
