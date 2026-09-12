/**
 * Structured errors (03 §11): every tool/CLI error is `{error, hint}`; the server never crashes
 * the harness session. Stubs throw `NotImplementedError` until their owner implements them.
 *
 * Layer: leaf (no imports from other src modules).
 */

/** Closed set of error codes. Add here, never invent codes inline. */
export const ERROR_CODES = {
  /** map YAML failed schema or cross-reference validation (02 §10) */
  INVALID_MAP: 'invalid_map',
  /** a file/entity referenced by id does not exist */
  NOT_FOUND: 'not_found',
  /** tool/CLI input malformed */
  BAD_INPUT: 'bad_input',
  /** export refused: YAML blob changed since load (03 §4) */
  EXPORT_CONFLICT: 'export_conflict',
  /** `app-map export --check` found a non-canonical file (06 R1) */
  NOT_CANONICAL: 'not_canonical',
  /** no observation recorded for the session yet (03 §8 identify_screen / report_step) */
  NO_OBSERVATION: 'no_observation',
  /** screen could not be identified (not an error for identify_screen; used by run_recipe entry) */
  UNKNOWN_SCREEN: 'unknown_screen',
  /** recipe cannot be compiled (04 §3): reason in message */
  COMPILE_FAILED: 'compile_failed',
  /** 04 §3.4 */
  UNPARAMETERIZED_VALUE: 'unparameterized_value',
  /** guided run id unknown or already finished */
  RUN_NOT_ACTIVE: 'run_not_active',
  /** recipe is `retired` or wrong platform */
  RECIPE_UNAVAILABLE: 'recipe_unavailable',
  /** 07 §3: connected app is a Release build or not the sandbox */
  RELEASE_BUILD_REFUSED: 'release_build_refused',
  /** 04 §6.2: a step's only viable locator is path/geometry */
  NOT_HEADLESS_ELIGIBLE: 'not_headless_eligible',
  /** maestro binary missing / wrong version (03 §13) */
  MAESTRO_UNAVAILABLE: 'maestro_unavailable',
  /** ingest socket unavailable; caller should fall back to `record --stdin` (03 §2) */
  SOCKET_UNAVAILABLE: 'socket_unavailable',
  /** 06 R3 policy violation */
  POLICY_VIOLATION: 'policy_violation',
  /** 01 R8 lint failure */
  LINT_FAILED: 'lint_failed',
  /** merge driver produced a conflict (02 §9) */
  MERGE_CONFLICT: 'merge_conflict',
  /** SQLite / filesystem failure */
  STORAGE: 'storage',
  /** module not yet implemented (stub) */
  NOT_IMPLEMENTED: 'not_implemented',
  /** anything else */
  INTERNAL: 'internal',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** Wire shape of every error returned to a harness or printed by the CLI (03 §11). */
export interface ErrorJson {
  error: string;
  hint: string;
  code: ErrorCode;
}

export class AppMapError extends Error {
  readonly code: ErrorCode;
  readonly hint: string;

  constructor(code: ErrorCode, message: string, hint = '', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppMapError';
    this.code = code;
    this.hint = hint;
  }

  /** `{error, hint, code}` — `error` is the human message, `code` the machine key. */
  toJSON(): ErrorJson {
    return { error: this.message, hint: this.hint, code: this.code };
  }

  static is(e: unknown): e is AppMapError {
    return e instanceof AppMapError || (typeof e === 'object' && e !== null && (e as { name?: string }).name === 'AppMapError');
  }
}

/** Thrown by every stub body; owners replace the throw with the implementation. */
export class NotImplementedError extends AppMapError {
  constructor(module: string) {
    super(ERROR_CODES.NOT_IMPLEMENTED, `${module} is not implemented yet`, `see docs/dev/architecture.md for the owner of ${module}`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Coerce any thrown value into the `{error, hint, code}` wire shape. Tool handlers and the CLI
 * call this in their catch blocks so nothing but structured JSON ever escapes (03 §11).
 */
export function toErrorJson(e: unknown): ErrorJson {
  if (AppMapError.is(e)) return e.toJSON();
  if (e instanceof Error) return { error: e.message, hint: '', code: ERROR_CODES.INTERNAL };
  return { error: String(e), hint: '', code: ERROR_CODES.INTERNAL };
}
