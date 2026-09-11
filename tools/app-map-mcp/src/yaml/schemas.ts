/**
 * [A1] JSON Schema validation (02 §2.5, 02 §10.1, 07 §4 "strict JSON Schema validation before
 * load"). Ajv 8 draft-07 + ajv-formats; schemas are read from `app-map/schema/<kind>.schema.json`
 * (paths.schemaFile) and compiled once per schema directory.
 *
 * Ajv options: `{ allErrors: true, strict: true, strictTypes: false, strictTuples: false,
 * allowUnionTypes: true }` (the schemas use `if/then` without `type`, which strictTypes rejects).
 *
 * Layer: yaml (imports types/paths/errors only).
 */
import type { SchemaKind } from '../paths.ts';
import { NotImplementedError } from '../errors.ts';

export interface SchemaIssue {
  /** JSON pointer inside the document (`/elements/3/locators/0/weight`), `/` for the root */
  path: string;
  keyword: string;
  message: string;
  params?: Record<string, unknown>;
}

export type SchemaValidator = (doc: unknown) => SchemaIssue[];

/**
 * Compile every `*.schema.json` in `schemaDir`. Cached by directory; call again after editing
 * a schema in tests with `{ reload: true }`. Throws `AppMapError(invalid_map)` when a schema
 * file is missing or does not compile.
 */
export function loadSchemas(schemaDir: string, opts: { reload?: boolean } = {}): ReadonlyMap<SchemaKind, SchemaValidator> {
  void schemaDir; void opts;
  throw new NotImplementedError('yaml/schemas.loadSchemas');
}

/** Validator for one kind; empty array = valid. */
export function getValidator(schemaDir: string, kind: SchemaKind): SchemaValidator {
  void schemaDir; void kind;
  throw new NotImplementedError('yaml/schemas.getValidator');
}

/** Convenience: `getValidator(schemaDir, kind)(doc)`. */
export function validateAgainstSchema(schemaDir: string, kind: SchemaKind, doc: unknown): SchemaIssue[] {
  void schemaDir; void kind; void doc;
  throw new NotImplementedError('yaml/schemas.validateAgainstSchema');
}

/**
 * Throw `AppMapError(invalid_map)` listing every issue (`file` is used in the message only) when
 * `doc` is invalid; otherwise narrow `doc` to `T`.
 */
export function assertValid<T>(schemaDir: string, kind: SchemaKind, doc: unknown, file?: string): asserts doc is T {
  void schemaDir; void kind; void doc; void file;
  throw new NotImplementedError('yaml/schemas.assertValid');
}

/** Validate one events.jsonl line (08 §2) — used by `events.ts` in debug mode and by `report`. */
export function validateEventLine(schemaDir: string, line: string): SchemaIssue[] {
  void schemaDir; void line;
  throw new NotImplementedError('yaml/schemas.validateEventLine');
}
