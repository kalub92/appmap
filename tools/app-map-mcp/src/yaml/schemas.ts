/**
 * [A1] JSON Schema validation (02 §2.5, 02 §10.1, 07 §4 "strict JSON Schema validation before
 * load"). Ajv 8 draft-07 + ajv-formats; schemas are read from `app-map/schema/<kind>.schema.json`
 * (paths.schemaFile) and compiled once per schema directory.
 *
 * Ajv options: `{ allErrors: true, strict: true, strictTypes: false, strictTuples: false,
 * allowUnionTypes: true }` (the schemas use `if/then` without `type`, which strictTypes rejects).
 *
 * Issue reporting adds one thing Ajv does not: a `must be string` over a value YAML resolved to a
 * number or boolean is reported with the fix appended — `quote it in YAML ("1.0"), or 1.0 parses
 * as a number` (`schemaIssueHint`, issue #20).
 *
 * Layer: yaml (imports types/paths/errors only).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ajv } from 'ajv';
import type { ErrorObject, ValidateFunction } from 'ajv';
import formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import type { SchemaKind } from '../paths.ts';
import { SCHEMA_KINDS } from '../paths.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';

export interface SchemaIssue {
  /** JSON pointer inside the document (`/elements/3/locators/0/weight`), `/` for the root */
  path: string;
  keyword: string;
  message: string;
  params?: Record<string, unknown>;
}

export type SchemaValidator = (doc: unknown) => SchemaIssue[];

const cache = new Map<string, ReadonlyMap<SchemaKind, SchemaValidator>>();

// ajv-formats is CJS with `exports.default = formatsPlugin`; under NodeNext the default import is
// the module object in the types and the plugin function (with a `.default` self-reference) at
// runtime — unwrap once so both agree.
const addFormats: FormatsPlugin = (formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin);

function toIssue(e: ErrorObject): SchemaIssue {
  const issue: SchemaIssue = {
    path: e.instancePath === '' ? '/' : e.instancePath,
    keyword: e.keyword,
    message: e.message ?? e.keyword,
  };
  if (e.params && Object.keys(e.params).length) issue.params = e.params as Record<string, unknown>;
  return issue;
}

function wrap(fn: ValidateFunction): SchemaValidator {
  return (doc: unknown): SchemaIssue[] => {
    if (fn(doc)) return [];
    return (fn.errors ?? []).map(toIssue);
  };
}

/**
 * Compile every `*.schema.json` in `schemaDir`. Cached by directory; call again after editing
 * a schema in tests with `{ reload: true }`. Throws `AppMapError(invalid_map)` when a schema
 * file is missing or does not compile.
 */
export function loadSchemas(schemaDir: string, opts: { reload?: boolean } = {}): ReadonlyMap<SchemaKind, SchemaValidator> {
  const cached = cache.get(schemaDir);
  if (cached && !opts.reload) return cached;
  const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true });
  addFormats(ajv);
  const out = new Map<SchemaKind, SchemaValidator>();
  for (const kind of SCHEMA_KINDS) {
    const file = join(schemaDir, `${kind}.schema.json`);
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      throw new AppMapError(ERROR_CODES.INVALID_MAP, `schema ${kind} unreadable at ${file}: ${(e as Error).message}`, 'restore app-map/schema/ from git; every schema kind must exist (02 §2.5)', { cause: e });
    }
    // Every schema file is read (and must parse) up front; ajv code generation runs on first use
    // per kind — compiling all ten costs ~170 ms and loadMap only needs four (03 §4 <500 ms).
    let compiled: SchemaValidator | undefined;
    out.set(kind, (doc: unknown): SchemaIssue[] => {
      if (!compiled) {
        try {
          compiled = wrap(ajv.compile(schema as object));
        } catch (e) {
          throw new AppMapError(ERROR_CODES.INVALID_MAP, `schema ${kind} does not compile: ${(e as Error).message}`, 'fix app-map/schema/' + kind + '.schema.json (draft-07, ajv strict mode)', { cause: e });
        }
      }
      return compiled(doc);
    });
  }
  cache.set(schemaDir, out);
  return out;
}

/** Validator for one kind; empty array = valid. */
export function getValidator(schemaDir: string, kind: SchemaKind): SchemaValidator {
  const v = loadSchemas(schemaDir).get(kind);
  if (!v) throw new AppMapError(ERROR_CODES.INVALID_MAP, `no schema for kind ${kind}`, `add ${kind}.schema.json under ${schemaDir}`);
  return v;
}

/** Convenience: `getValidator(schemaDir, kind)(doc)`. */
export function validateAgainstSchema(schemaDir: string, kind: SchemaKind, doc: unknown): SchemaIssue[] {
  return getValidator(schemaDir, kind)(doc);
}

/** Resolve a JSON pointer (`/build/version`; `/` and `''` are the root) inside `doc`. */
function valueAtPointer(doc: unknown, pointer: string): unknown {
  if (pointer === '' || pointer === '/') return doc;
  let cursor: unknown = doc;
  for (const raw of pointer.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cursor)) cursor = cursor[Number(key)];
    else if (typeof cursor === 'object' && cursor !== null) cursor = (cursor as Record<string, unknown>)[key];
    else return undefined;
  }
  return cursor;
}

/**
 * The "quote it" suffix for a `must be string` issue on a value YAML resolved to a number or
 * boolean, `''` for every other issue (issue #20). A scalar the author meant as text —
 * `version: 1.0`, `git_sha: 0000000`, `flag: true` — reads back as a number or a boolean, and
 * Ajv's bare "must be string" never says so; it lands during first-run setup, where
 * `map failed to load` blocks every other command, so the message has to teach the fix.
 *
 * `scalarSources` (from `parseYamlDoc`) supplies the spelling the author used, because
 * `String(1.0)` is `"1"` and `String(0000000)` is `"0"` — echoing those back would teach the
 * wrong quoting.
 */
export function schemaIssueHint(issue: SchemaIssue, doc: unknown, scalarSources?: ReadonlyMap<string, string>): string {
  if (issue.keyword !== 'type' || issue.params?.['type'] !== 'string') return '';
  const value = valueAtPointer(doc, issue.path);
  if (typeof value !== 'number' && typeof value !== 'boolean') return '';
  // toIssue normalises the root to '/', but scalarSources (and Ajv's instancePath) spell it ''
  const authored = scalarSources?.get(issue.path === '/' ? '' : issue.path) ?? String(value);
  return ` — quote it in YAML ("${authored}"), or ${authored} parses as a ${typeof value}`;
}

/** The part of an issue after its path: `<message><hint>` or `<message> <params>`. */
export function schemaIssueDetail(i: SchemaIssue, doc?: unknown, scalarSources?: ReadonlyMap<string, string>): string {
  const hint = doc === undefined ? '' : schemaIssueHint(i, doc, scalarSources);
  // the hint already names the expected type in plain words, so the raw `{"type":"string"}` blob
  // after it would only be noise
  const params = hint === '' && i.params ? ` ${JSON.stringify(i.params)}` : '';
  return `${i.message}${hint}${params}`;
}

/**
 * One line per issue: `<path> <message> <params>` — shared by assertValid and validate rule 1.
 * Pass the document (and, when it came from `parseYamlDoc`, its `scalarSources`) to get the
 * issue #20 quoting hint on a `must be string` over a YAML number or boolean.
 */
export function formatSchemaIssue(i: SchemaIssue, doc?: unknown, scalarSources?: ReadonlyMap<string, string>): string {
  return `${i.path} ${schemaIssueDetail(i, doc, scalarSources)}`;
}

/**
 * Throw `AppMapError(invalid_map)` listing every issue (`file` is used in the message only) when
 * `doc` is invalid; otherwise narrow `doc` to `T`. `scalarSources` comes from `parseYamlDoc` and
 * only affects the wording of the issue #20 quoting hint.
 */
export function assertValid<T>(schemaDir: string, kind: SchemaKind, doc: unknown, file?: string, scalarSources?: ReadonlyMap<string, string>): asserts doc is T {
  const issues = validateAgainstSchema(schemaDir, kind, doc);
  if (issues.length === 0) return;
  const where = file ?? `<${kind}>`;
  const lines = issues.map((i) => `  ${where}:${formatSchemaIssue(i, doc, scalarSources)}`);
  throw new AppMapError(ERROR_CODES.INVALID_MAP, `${where} does not validate against ${kind}.schema.json (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n${lines.join('\n')}`, 'run `app-map validate` for the full report (02 §10 rule 1)');
}

/** Validate one events.jsonl line (08 §2) — used by `events.ts` in debug mode and by `report`. */
export function validateEventLine(schemaDir: string, line: string): SchemaIssue[] {
  let doc: unknown;
  try {
    doc = JSON.parse(line);
  } catch (e) {
    return [{ path: '/', keyword: 'parse', message: `not valid JSON: ${(e as Error).message}` }];
  }
  return validateAgainstSchema(schemaDir, 'events', doc);
}
