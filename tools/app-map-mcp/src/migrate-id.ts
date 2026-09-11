/**
 * [A1] `app-map migrate-id <old> <new>` (02 §8): a rename is a migration that rewrites every
 * reference across `ids.yaml`, every platform's screens and recipes in one pass, then writes
 * the touched files canonically. Works for element ids, screen ids (also renames the file and
 * the `screen.<id>` marker) and gate ids (also the dismiss control prefix).
 *
 * Refuses (`AppMapError(bad_input)`) when `new` violates 01 R2, when `old` is unknown, or when
 * `new` already exists. Never touches `.local/`; the caller re-runs `export` afterwards.
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/*).
 */
import type { AppMapConfig } from './config.ts';
import type { MigrateIdResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface MigrateIdOptions {
  /** report what would change without writing */
  dryRun?: boolean;
}

export function migrateId(config: AppMapConfig, oldId: string, newId: string, opts: MigrateIdOptions = {}): MigrateIdResult {
  void config; void oldId; void newId; void opts;
  throw new NotImplementedError('migrate-id.migrateId');
}

/**
 * Pure: deep-rewrite every string equal to `oldId` (and markers/dismiss ids derived from it)
 * inside a parsed YAML document. Only whole-string matches on id-bearing keys (`id`, `element`,
 * `list`, `to`, `focused`, `visible[]`, `not_visible[]`, `required_ids[]`, `dynamic_regions[]`,
 * `gates[]`, `fallback_path[]`, `marker`, `dismiss`, locator `value` for `a11y_id`, `screen`
 * in conditions/expects, `deep_link`/`route`/`url` screen segment) are rewritten — never labels.
 */
export function rewriteIdReferences<T>(doc: T, oldId: string, newId: string): { doc: T; count: number } {
  void doc; void oldId; void newId;
  throw new NotImplementedError('migrate-id.rewriteIdReferences');
}
