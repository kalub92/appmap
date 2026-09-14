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
 * A `warning:` line follows the `gates:` line when `.local/strings.<platform>.txt` is missing
 * (07 §2.1) and/or when `map.validationWarnings` carries 02 §10 rule 2's carve-out — screens whose
 * edges point at elements exploration has not learned yet (issue #12).
 * Both are emitted only when they apply, so a clean map's summary is byte-identical.
 *
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
import type { DriverTarget, Expect, FallbackPayload, FindElementResult, LoadedMap, RecipeFile, RunStep, ScreenFile, ScreenId, SummaryResult } from './types.ts';
import { edgeElement, emitDeepLink, isUnlearnedEdgeElement, routeKey, screenIdOfDeepLink, stepElement } from './types.ts';
import { formatSettle } from './settle.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { capTokens } from './token.ts';

export const GET_SCREEN_MAX_TOKENS = 400;
export const SUMMARY_MAX_TOKENS = 600;
export const STEP_MAX_TOKENS = 120;
export const MATCH_CANDIDATES_MAX_LINES = 8;

/** `"…"` with inner quotes/newlines escaped so a row stays one parse-stable line */
function q(s: string): string {
  return JSON.stringify(String(s));
}

function fixed2(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function screenOrGate(map: LoadedMap, screenId: ScreenId): ScreenFile {
  const file = map.screens.get(screenId) ?? map.gates.get(screenId);
  if (file === undefined) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `screen ${JSON.stringify(screenId)} is not in the map`, 'call summary for the list of screens, or identify_screen to find the current one');
  }
  return file;
}

/** Every screen a recipe references: entry deep link/fallback path, step expects, verify, step elements' screens. */
function recipeScreens(map: LoadedMap, recipe: RecipeFile): Set<ScreenId> {
  const out = new Set<ScreenId>();
  const link = recipe.entry?.deep_link;
  if (typeof link === 'string') {
    const id = map.routes.get(routeKey(link)) ?? screenIdOfDeepLink(link);
    if (id !== undefined) out.add(id);
  }
  for (const id of recipe.entry?.fallback_path ?? []) out.add(id);
  const addExpect = (e: Expect | undefined): void => { if (e?.screen !== undefined) out.add(e.screen); };
  for (const step of recipe.steps ?? []) {
    addExpect(step.expect);
    const element = stepElement(step);
    // `map.elements` indexes gate files too, and `stepElement` answers a `tap_gate`'s control
    // (issue #24) — a gate is dismissed, never navigated to, so it is not a screen this recipe
    // visits. `drift.ciGateScreens` has carried the same guard all along.
    if (element !== undefined) for (const ref of map.elements.get(element) ?? []) if (map.screens.has(ref.screen)) out.add(ref.screen);
  }
  addExpect(recipe.verify);
  return out;
}

/** non-retired recipes referencing `screenId`, sorted by id */
function recipesForScreen(map: LoadedMap, screenId: ScreenId): RecipeFile[] {
  return Array.from(map.recipes.values())
    .filter((r) => r.status !== 'retired' && recipeScreens(map, r).has(screenId))
    .sort(byId);
}

export function formatGetScreen(map: LoadedMap, screenId: ScreenId, opts: { confidence?: number; maxTokens?: number } = {}): string {
  const screen = screenOrGate(map, screenId);
  const o = opts ?? {};
  // header (03 §8): two spaces between segments; conf/title only when available
  const header: string[] = [`screen ${screen.id}`];
  if (typeof o.confidence === 'number' && Number.isFinite(o.confidence)) header.push(`conf ${fixed2(o.confidence)}`);
  if (typeof screen.title === 'string' && screen.title !== '') header.push(`title ${q(screen.title)}`);
  // the map writes every link `appmap://`; the LLM is going to OPEN this one, so it must read in
  // the scheme the app registers (issue #25)
  const link = typeof screen.deep_link === 'string' && screen.deep_link !== '' ? emitDeepLink(screen.deep_link, map.manifest?.deep_link_scheme) : 'none';
  header.push(`deep_link ${link}`);
  const lines: string[] = [header.join('  '), 'elements'];

  // element rows, id-sorted; the third column is the static label, `[dynamic]`, or `-` (label-less gate controls)
  const elements = (Array.isArray(screen.elements) ? [...screen.elements] : []).sort(byId);
  const rows = elements.map((el) => {
    const desc = el.dynamic === true ? '[dynamic]' : typeof el.label === 'string' && el.label !== '' ? q(el.label) : '-';
    const edge = (Array.isArray(screen.edges) ? screen.edges : []).find((e) => e && e.status !== 'retired' && e.action && edgeElement(e.action) === el.id);
    return { id: el.id, role: String(el.role), desc, to: edge?.to };
  });
  const idW = Math.max(0, ...rows.map((r) => r.id.length)) + 2;
  const roleW = Math.max(0, ...rows.map((r) => r.role.length)) + 2;
  const descW = Math.max(0, ...rows.map((r) => r.desc.length)) + 2;
  for (const r of rows) {
    const row = `  ${pad(r.id, idW)}${pad(r.role, roleW)}${r.to !== undefined ? `${pad(r.desc, descW)}-> ${r.to}` : r.desc}`;
    lines.push(row.trimEnd());
  }
  const gates = Array.isArray(screen.gates) ? screen.gates.filter((g) => typeof g === 'string' && g !== '') : [];
  if (gates.length > 0) lines.push(`gates  ${[...gates].sort().join(', ')}`);
  const recipes = recipesForScreen(map, screen.id);
  if (recipes.length > 0) lines.push(`recipes  ${recipes.map((r) => r.id).join(', ')}`);
  return capTokens(lines.join('\n'), o.maxTokens ?? GET_SCREEN_MAX_TOKENS);
}

export function formatSummary(map: LoadedMap, opts: { maxTokens?: number } = {}): SummaryResult {
  const screens = Array.from(map.screens.values()).sort(byId);
  const verified = screens.filter((s) => s.meta?.status === 'verified').length;
  const gates = Array.from(map.gates.keys()).sort();
  const recipes = Array.from(map.recipes.values()).filter((r) => r.status !== 'retired').sort(byId);
  const lines: string[] = [
    `app-map ${map.platform} build ${map.build}: ${screens.length} screens (${verified} verified), ${gates.length} gates, ${recipes.length} recipes`,
    `screens: ${screens.length > 0 ? screens.map((s) => s.id).join(', ') : 'none'}`,
  ];
  if (gates.length > 0) lines.push(`gates: ${gates.join(', ')}`);
  // 03 §5 step 1 / 07 §2.3.3: without the string table the scrubber drops OS-dialog copy, so gate
  // detection stops working. Say so rather than reporting a healthy map.
  if (!map.stringTablePresent) {
    lines.push(`warning: .local/strings.${map.platform}.txt is missing — gate detection and label-based resolution are degraded; run scripts/app-map/strings-export.sh`);
  }
  // 02 §10 rule 2's "not reached yet" carve-out (issue #12): the map loaded, but some screen still
  // points an edge at an element nobody has captured — an untouched router seed, or a build N+1
  // edge on a screen that IS explored. A warning nobody reads is a warning that never turns into
  // exploration, so name the screens rather than only counting the edges.
  const unlearned = map.validationWarnings.filter(isUnlearnedEdgeElement);
  if (unlearned.length > 0) {
    const seeded = [...new Set(unlearned.map((w) => w.file.replace(/^.*\//, '').replace(/\.ya?ml$/, '')))].sort();
    lines.push(`warning: ${unlearned.length} edge(s) on ${seeded.join(', ')} reference elements not learned yet; explore each screen and call name_screen (02 §10 rule 2)`);
  }
  if (recipes.length > 0) {
    lines.push('recipes:');
    for (const r of recipes) lines.push(`  ${r.id} (${r.status}) — ${String(r.description ?? '').replace(/\s+/g, ' ').trim()}`);
  } else {
    lines.push('recipes: none');
  }
  const text = capTokens(lines.join('\n'), opts?.maxTokens ?? SUMMARY_MAX_TOKENS);
  return {
    platform: map.platform,
    build: map.build,
    screens: screens.length,
    screens_verified: verified,
    recipes: recipes.map((r) => ({ id: r.id, description: r.description, status: r.status })),
    gates,
    text,
  };
}

/** The fixed 05 §3 preamble (rules 1–4 + `Recipes: …`). */
export function sessionStartPreamble(map: LoadedMap): string {
  const recipes = Array.from(map.recipes.values()).filter((r) => r.status !== 'retired').map((r) => r.id).sort();
  return [
    `app-map is loaded for ${map.platform} build ${map.build}. Before driving the simulator:`,
    '1. call mcp__app-map__match_recipe with the task; if it matches, run_recipe (guided) and follow report_step.',
    '2. otherwise call identify_screen, then get_screen, before any tap. Prefer plan_path deep links.',
    '3. do not take screenshots unless the accessibility tree is empty.',
    '4. when a new task succeeds, call compile_recipe and review the draft.',
    `Recipes: ${recipes.length > 0 ? recipes.join(', ') : 'none'}`,
  ].join('\n');
}

/** `additionalContext` for the SessionStart hook: summary + preamble, capped. */
export function formatSessionStartContext(map: LoadedMap, maxTokens: number): string {
  const max = typeof maxTokens === 'number' && Number.isFinite(maxTokens) ? maxTokens : SUMMARY_MAX_TOKENS;
  // the summary keeps its own 600 budget so the preamble (the rules) is what an over-tight cap trims last
  const summary = formatSummary(map, { maxTokens: Math.min(SUMMARY_MAX_TOKENS, max) }).text;
  return capTokens(`${summary}\n\n${sessionStartPreamble(map)}`, max);
}

function formatTarget(t: DriverTarget): string {
  switch (t.by) {
    case 'id': return `id ${q(t.id)}`;
    case 'role_label': return `role_label ${t.role} ${q(t.label)}`;
    case 'text': return `text ${q(t.text)}`;
    case 'point': return `point ${t.x},${t.y}`;
    default: return 'unknown';
  }
}

function formatExpect(e: Expect | undefined): string | undefined {
  if (!e || typeof e !== 'object') return undefined;
  const parts: string[] = [];
  if (e.screen !== undefined) parts.push(`screen ${e.screen}`);
  if (e.focused !== undefined) parts.push(`focused ${e.focused}`);
  if (Array.isArray(e.visible) && e.visible.length > 0) parts.push(`visible ${e.visible.join(',')}`);
  if (Array.isArray(e.not_visible) && e.not_visible.length > 0) parts.push(`not_visible ${e.not_visible.join(',')}`);
  if (e.text_present !== undefined) parts.push(`text_present ${q(e.text_present)}`);
  // issue #23: the SLOT, never the value — this string reaches the LLM and the fallback line
  for (const v of e.value ?? []) {
    const op = typeof v?.equals === 'string' ? `= ${v.equals}` : typeof v?.contains === 'string' ? `~ ${v.contains}` : undefined;
    if (op !== undefined) parts.push(`value ${v.element} ${op}`);
  }
  return parts.length > 0 ? `expect ${parts.join(' ')}` : undefined;
}

export function formatRunStep(step: RunStep): string {
  if (!step || typeof step !== 'object') return capTokens('step ?', STEP_MAX_TOKENS);
  const parts: string[] = [`step ${step.id ?? '?'}`, String(step.action ?? '?')];
  switch (step.action) {
    case 'open_link':
      parts.push(String(step.url ?? ''));
      break;
    case 'dismiss_gate':
      // names the gate, then its dismiss control (the element/target, when resolved)
      parts.push(String(step.gate ?? ''));
      if (step.element !== undefined) parts.push(`tap ${step.element}`);
      break;
    case 'swipe':
      parts.push(String(step.direction ?? ''));
      if (step.element !== undefined) parts.push(`on ${step.element}`);
      break;
    case 'wait_for':
      break;
    default:
      if (step.element !== undefined) parts.push(step.element);
  }
  if (step.target !== undefined) parts.push(`via ${formatTarget(step.target)}`);
  if (step.resolved !== undefined) {
    parts.push(`(${step.resolved.strategy} ${fixed2(step.resolved.confidence)}${step.resolved.degraded ? ' degraded' : ''})`);
  }
  if (step.action === 'type' && step.text !== undefined) parts.push(`text ${q(step.text)}`);
  if (step.action === 'select' && step.match_text !== undefined) parts.push(`match ${q(step.match_text)}`);
  const expect = formatExpect(step.expect);
  if (expect !== undefined) parts.push(expect);
  const settle = formatSettle(step.settle);
  if (settle !== undefined) parts.push(settle);
  if (step.intent_critical === true) parts.push('[intent_critical]');
  if (step.announce === true) parts.push('[announce]');
  if (step.healing === true) parts.push('[healing]');
  return capTokens(parts.filter((p) => p !== '').join(' '), STEP_MAX_TOKENS);
}

export function formatFindElement(result: FindElementResult): string {
  if (!result || typeof result !== 'object') return capTokens('find_element: no result', STEP_MAX_TOKENS);
  const lines: string[] = [];
  if (result.found) {
    const h = result.hit;
    const flags = [h.disambiguated ? 'disambiguated' : '', h.degraded ? 'degraded' : ''].filter((f) => f !== '');
    let line = `element ${result.element} on ${result.screen_id}: ${h.strategy} ${fixed2(h.confidence)}${flags.length ? ` ${flags.join(' ')}` : ''} -> ${formatTarget(h.target)}`;
    if (typeof h.path === 'string' && h.path !== '') line += ` path ${h.path}`;
    lines.push(line);
  } else if (result.element !== undefined && result.miss !== undefined) {
    const tried = result.miss.tried.map((t) => `${t.strategy} ${t.matches}`).join(', ');
    lines.push(`element ${result.element} on ${result.screen_id}: miss (tried ${tried || 'nothing'})`);
    for (const c of result.miss.candidates) {
      lines.push(`  candidate ${c.path || '?'} ${c.role}${c.a11y_id !== undefined ? ` ${c.a11y_id}` : ''}${c.label !== undefined ? ` ${q(c.label)}` : ''}`);
    }
  } else {
    lines.push(result.element !== undefined ? `element ${result.element} not found on ${result.screen_id}` : `no matching element on ${result.screen_id}`);
    for (const c of result.candidates) {
      lines.push(`  ${c.id}${c.intent !== undefined ? ` — ${c.intent}` : ''}${c.label !== undefined ? ` ${q(c.label)}` : ''}`);
    }
  }
  return capTokens(lines.join('\n'), STEP_MAX_TOKENS);
}

/** `<id> — <description>` lines, at most 8 (04 §4.2). */
export function formatMatchCandidates(candidates: ReadonlyArray<{ id: string; description: string }>): string {
  if (!Array.isArray(candidates)) return '';
  return candidates
    .slice(0, MATCH_CANDIDATES_MAX_LINES)
    .map((c) => `${c.id} — ${String(c.description ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
}

/** `fallback at s4 (heal_rejected): screen_seen invoice_new; expected screen client_picker; candidates: …` */
export function formatFallback(fb: FallbackPayload): string {
  if (!fb || typeof fb !== 'object') return 'fallback';
  const seen = [fb.screen_seen_seq !== undefined ? `seq ${fb.screen_seen_seq}` : undefined, fb.identified_by]
    .filter((x): x is string => typeof x === 'string' && x !== '');
  const parts: string[] = [`fallback at ${fb.step} (${fb.reason}): screen_seen ${fb.screen_seen}${seen.length > 0 ? ` (${seen.join(', ')})` : ''}`];
  const expected = formatExpect(fb.expected);
  if (expected !== undefined) parts.push(expected.replace(/^expect /, 'expected '));
  if (Array.isArray(fb.candidates) && fb.candidates.length > 0) parts.push(`candidates: ${fb.candidates.join(', ')}`);
  if (typeof fb.message === 'string' && fb.message.trim() !== '') parts.push(fb.message.trim());
  return capTokens(parts.join('; '), STEP_MAX_TOKENS);
}
