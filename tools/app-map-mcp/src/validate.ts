/**
 * [A1] `app-map validate` — 02 §10 rules 1–8 (06 R1 blocks the PR on any error).
 *
 *  1. every file validates against its JSON Schema (yaml/schemas.ts)
 *  2. every element id, screen id, gate id exists in ids.yaml (gate dismiss controls count as
 *     registered via `gates[].dismiss`; screen markers via `screens[].id`)
 *  3. every edge `to`, `entry.fallback_path` entry, `expect.screen`, condition `screen` references
 *     an existing screen file (`_previous` allowed on gates)
 *  4. every committed element has ≥2 locators and an `a11y_id` locator, unless the file is a
 *     gate and all its locators are `role_label`/`path` (OS dialogs)
 *  5. no `text` strategy stands alone
 *  6. `intent_critical` agrees between ids.yaml and every screen element / recipe step that
 *     touches the element (absent = false)
 *  7. serialization is canonical (yaml/canonical.ts `isCanonical`)
 *  8. forbidden content sweep over `elements[].label`, `title`, every `text`/`text_present`/
 *     `match.text` and `description`: email, phone, 13–19 digit runs, currency, IBAN-like,
 *     SSN-like (`scrub.ts` PII_PATTERNS); `{param}` slots are exempt
 *
 * Also enforced: file name equals `id` (02 §2.1); recipe `platform` equals its directory;
 * dynamic elements carry no `label` (07 §2.3).
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/* + scrub).
 */
import type { AppMapConfig, Platform } from './config.ts';
import type { IdsRegistry, RecipeFile, ScreenFile, ValidateResult, ValidationIssue } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface ValidateOptions {
  /** default: every platform directory that has a manifest */
  platforms?: Platform[];
  /** run rule 7 (default true; `loadMap` passes false) */
  canonical?: boolean;
}

/** Run every rule over `config.dir`. Never throws for map problems — they are `issues`. */
export function validateMap(config: AppMapConfig, opts: ValidateOptions = {}): ValidateResult {
  void config; void opts;
  throw new NotImplementedError('validate.validateMap');
}

export interface CrossRefInput {
  platform: Platform;
  ids: IdsRegistry;
  /** relative path → file */
  screens: ReadonlyMap<string, ScreenFile>;
  recipes: ReadonlyMap<string, RecipeFile>;
}

/** Pure: rules 2–6 and 8 over already-parsed documents. */
export function crossReferenceIssues(input: CrossRefInput): ValidationIssue[] {
  void input;
  throw new NotImplementedError('validate.crossReferenceIssues');
}

/** Pure: rule 8 over one document; `file` is only echoed into issues. */
export function forbiddenContentIssues(file: string, doc: ScreenFile | RecipeFile | IdsRegistry): ValidationIssue[] {
  void file; void doc;
  throw new NotImplementedError('validate.forbiddenContentIssues');
}

/** Rule 7 for every YAML under the map; returns the non-canonical relative paths. */
export function nonCanonicalFiles(config: Pick<AppMapConfig, 'dir'>): string[] {
  void config;
  throw new NotImplementedError('validate.nonCanonicalFiles');
}

/** Human-readable, one issue per line: `<file>[:<location>] rule <n>: <message>` — CI output (06 §4). */
export function formatIssues(issues: ValidationIssue[]): string {
  void issues;
  throw new NotImplementedError('validate.formatIssues');
}
