/**
 * [B2] LLM-facing text formats (03 §8, 05 §3, 04 §5). Every output is capped with
 * `capTokens` (token.ts); formats are fixed and parse-stable — tests assert exact strings.
 *
 * `formatGetScreen` (≤400 tokens), exactly:
 * ```
 * screen invoice_list  conf 0.98  title "Invoices"  deep_link appmap://invoice_list
 * elements
 *   invoice.add.button     button  "New Invoice"  -> invoice_new
 *   invoice.list.table     list    [dynamic]
 *   invoice.list.cell      cell    [dynamic]      -> invoice_detail
 * gates  gate.push_permission
 * recipes  create_invoice, filter_invoices
 * ```
 * - header: `screen <id>  conf <0.00>  title "<title>"  deep_link <link|none>`; `conf` is the
 *   caller-supplied identification confidence (omit the `conf` segment when not supplied) —
 *   the server derives it per architecture §7 decision 44 (last observation's confidence when it
 *   identified this screen, else the 02 §8 decayed base);
 *   two spaces between segments; `title` segment omitted when the screen has none;
 * - element rows: two-space indent, id padded to the longest id + 2, role padded to the longest
 *   role + 2, then `"<label>"` or `[dynamic]` padded likewise, then `-> <to>` for the first
 *   non-retired edge whose action element is this element; rows sorted by id;
 * - `gates  <ids comma-joined>` only when non-empty; `recipes  <ids>` = recipes whose steps or
 *   `expect`/`verify` reference this screen, non-retired, comma+space joined, omitted when none.
 *
 * `formatSummary` (≤600 tokens, 03 §8 `summary`, 05 §3 SessionStart):
 * ```
 * app-map ios build 4412: 5 screens (5 verified), 2 gates, 1 recipes
 * screens: client_picker, invoice_detail, invoice_list, invoice_new, login
 * gates: gate.biometric_prompt, gate.push_permission
 * recipes:
 *   create_invoice (verified) — Create an invoice for a client with an amount and save it
 * ```
 * `sessionStartPreamble` is the fixed block from 05 §3 with `<platform>`, `<build>` and the
 * recipe list substituted; `formatSessionStartContext` = summary + blank line + preamble,
 * capped to `maxTokens`.
 *
 * `formatRunStep` (≤120 tokens): `step s3 tap invoice.client.picker via id "invoice.client.picker"
 * (a11y_id 1.00) expect screen client_picker` — one line; `type` adds `text "50"`; `select`
 * adds `match "Acme Corp"`; `open_link` gives the url; `dismiss_gate` names the gate and its
 * dismiss target; `intent_critical` steps append ` [intent_critical]`.
 *
 * Layer: map (imports types + token). Pure.
 */
import type { FallbackPayload, FindElementResult, LoadedMap, RunStep, ScreenId, SummaryResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export const GET_SCREEN_MAX_TOKENS = 400;
export const SUMMARY_MAX_TOKENS = 600;
export const STEP_MAX_TOKENS = 120;
export const MATCH_CANDIDATES_MAX_LINES = 8;

export function formatGetScreen(map: LoadedMap, screenId: ScreenId, opts: { confidence?: number; maxTokens?: number } = {}): string {
  void map; void screenId; void opts;
  throw new NotImplementedError('format.formatGetScreen');
}

export function formatSummary(map: LoadedMap, opts: { maxTokens?: number } = {}): SummaryResult {
  void map; void opts;
  throw new NotImplementedError('format.formatSummary');
}

/** The fixed 05 §3 preamble (rules 1–4 + `Recipes: …`). */
export function sessionStartPreamble(map: LoadedMap): string {
  void map;
  throw new NotImplementedError('format.sessionStartPreamble');
}

/** `additionalContext` for the SessionStart hook: summary + preamble, capped. */
export function formatSessionStartContext(map: LoadedMap, maxTokens: number): string {
  void map; void maxTokens;
  throw new NotImplementedError('format.formatSessionStartContext');
}

export function formatRunStep(step: RunStep): string {
  void step;
  throw new NotImplementedError('format.formatRunStep');
}

export function formatFindElement(result: FindElementResult): string {
  void result;
  throw new NotImplementedError('format.formatFindElement');
}

/** `<id> — <description>` lines, at most 8 (04 §4.2). */
export function formatMatchCandidates(candidates: ReadonlyArray<{ id: string; description: string }>): string {
  void candidates;
  throw new NotImplementedError('format.formatMatchCandidates');
}

/** `fallback at s4 (heal_rejected): screen_seen invoice_new; expected screen client_picker; candidates: …` */
export function formatFallback(fb: FallbackPayload): string {
  void fb;
  throw new NotImplementedError('format.formatFallback');
}
