/**
 * [A2] `app-map export [--force] [--check]` (02 §2.2–2.3, 03 §4 write path, 03 §8 `export`
 * tool, 05 §3 Stop hook, 06 R1).
 *
 * - Writes every `dirty` screen/recipe from the cache to its YAML file in canonical form
 *   (yaml/canonical.ts) and clears the dirty flag. Volatile counters never leave SQLite.
 * - Only durable fields are written: structure, locators, status, provenance,
 *   `last_verified_build`; `manifest.generated_at` is the only timestamp and is refreshed only
 *   when the manifest itself changes (build bump via import-router).
 * - Conflict safety: before overwriting, compare the file's current git blob hash
 *   (yaml/load.gitBlobHash) with the `blob_sha` recorded at load; if it differs, the file is
 *   listed in `conflicts` with a unified diff and NOT written unless `force`.
 * - `check`: reload every YAML, re-serialize canonically, report `non_canonical` paths; writes
 *   nothing (06 R1). Exit code for the CLI: 1 when `conflicts` or `non_canonical` is non-empty.
 * - Idempotent: a second export writes nothing (02 §11).
 *
 * Layer: store (imports context types + yaml/*).
 */
import type { AppMapContext } from '../context.ts';
import type { ExportResult, RecipeFile, ScreenFile } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

export interface ExportOptions {
  force?: boolean;
  check?: boolean;
  /** compute the result without touching disk */
  dryRun?: boolean;
}

export function exportMap(ctx: AppMapContext, opts: ExportOptions = {}): ExportResult {
  void ctx; void opts;
  throw new NotImplementedError('store/export.exportMap');
}

/** Pure: relative path → canonical text for the given entities (what `exportMap` would write). */
export function renderEntities(entities: { screens: ScreenFile[]; recipes: RecipeFile[] }): Map<string, string> {
  void entities;
  throw new NotImplementedError('store/export.renderEntities');
}

/** Minimal unified diff of two texts (for `conflicts[].diff`); pure. */
export function unifiedDiff(a: string, b: string, label: string): string {
  void a; void b; void label;
  throw new NotImplementedError('store/export.unifiedDiff');
}
