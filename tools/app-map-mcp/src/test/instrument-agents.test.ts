/**
 * instrument-agents — the `app-instrument` skill, its three subagents (surveyor, swiftui, uikit),
 * their `reference/*.md` and the instrumented pilot fixtures under `fixtures/instrument/`, pinned
 * to the code they drive so prose and code cannot drift apart (the verbs.test.ts precedent):
 *  - frontmatter: tool grants, `model`, no MCP grants, the verbatim safety rules (01 R8, 05 §5.1);
 *  - API pin: every `AppMap*` / `appMap*` name the agents, skill, references and fixtures use is a
 *    public AppMapKit declaration (or a key the package defines), every `AppMapID.*` constant they
 *    name exists in the generated pilot file, and the registry selectors they quote are real;
 *  - the kind table, the plan schema and the golden plan; each fixture set lint-clean on its own,
 *    and the lint shown to have teeth against a mutated copy;
 *  - the two failure modes the agents exist to prevent: a "simplified" marker that never reaches
 *    the driver (issue #15) and an id on a SwiftUI `List` / `Section` / `ForEach` (issue #19).
 * Every file examined here is read lazily inside its `it`: the deliverables are drafted
 * concurrently, so a missing one fails as an assertion naming the path, never as a load-time throw.
 */
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { Ajv } from 'ajv';
import type { ValidateFunction } from 'ajv';
import formatsModule from 'ajv-formats';
import type { FormatsPlugin } from 'ajv-formats';
import { KIND_SYNONYMS, lintIds } from '../lint-ids.ts';
import type { LintIdsResult } from '../types.ts';
import { ELEMENT_ID_REGEX, ELEMENT_KINDS, GATE_DISMISS_REGEX, GATE_ID_REGEX, SCREEN_ID_REGEX } from '../types.ts';
import { readIds } from '../yaml/load.ts';
import { FIXTURES_DIR, PILOT_APP_MAP_DIR, REPO_ROOT } from './helpers.ts';

const PILOT_CONFIG = { dir: PILOT_APP_MAP_DIR };

// ---- the files under test -------------------------------------------------------------------
const AGENTS_DIR = join(REPO_ROOT, '.claude', 'agents');
const SKILL_DIR = join(REPO_ROOT, '.claude', 'skills', 'app-instrument');
const SKILL_FILE = join(SKILL_DIR, 'SKILL.md');
const REFERENCE_DIR = join(SKILL_DIR, 'reference');
/** design §1: the six reference files the skill names by path (amendment 3) */
const REFERENCE_FILES = ['survey-plan.md', 'id-rules.md', 'swiftui-patterns.md', 'uikit-patterns.md', 'debug-wiring.md', 'verify-and-report.md'];
const SURVEYOR = 'app-instrument-surveyor';
const SPECIALISTS = ['app-instrument-swiftui', 'app-instrument-uikit'] as const;
const AGENTS = [SURVEYOR, ...SPECIALISTS] as const;
const agentFile = (name: string): string => join(AGENTS_DIR, `${name}.md`);

const APPMAPKIT_SRC = join(REPO_ROOT, 'instrumentation', 'ios', 'AppMapKit', 'Sources', 'AppMapKit');
const GENERATED_SWIFT = join(APPMAPKIT_SRC, 'AppMapID.swift');
const ROUTER_REGISTRY_SWIFT = join(APPMAPKIT_SRC, 'AppMapRouterRegistry.swift');
const GEN_IDS_SCRIPT = join(REPO_ROOT, 'scripts', 'app-map', 'gen-ids');

const INSTRUMENT_FIXTURES = join(FIXTURES_DIR, 'instrument');
const SWIFTUI_SET = join(INSTRUMENT_FIXTURES, 'ios', 'swiftui');
const UIKIT_SET = join(INSTRUMENT_FIXTURES, 'ios', 'uikit');
const GOLDEN_PLAN = join(INSTRUMENT_FIXTURES, 'plan.pilot.json');
/** design §7.1: the five pilot screens as SwiftUI files, each carrying exactly one marker */
const SWIFTUI_SCREEN_FILES = ['LoginView.swift', 'InvoiceListView.swift', 'InvoiceNewView.swift', 'ClientPickerView.swift', 'InvoiceDetailView.swift'];

const SPEC_05 = join(REPO_ROOT, 'docs', 'specs', '05-harness-integration.md');
const HARNESS_NOTES = join(REPO_ROOT, 'docs', 'dev', 'harness-notes.md');
const INSTRUMENTATION_README = join(REPO_ROOT, 'instrumentation', 'README.md');
const README = join(REPO_ROOT, 'README.md');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

/** design §2.1 / brief §6: the surveyor reads, the specialists edit; nobody gets an MCP tool */
const SURVEYOR_TOOLS = 'tools: Read, Grep, Glob';
const SPECIALIST_TOOLS = 'tools: Read, Edit, Write, Grep, Glob, Bash';
const MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);
/** app-side names may start with `AppMap` only here (design §1); `AppMapId` is the Kotlin generated holder rule 7 names */
const APP_SIDE_ALLOWED = new Set(['AppMapID', 'AppMapKit', 'AppMapWiring', 'AppMapId']);
/** AppMapKit's module-internal types: never visible to an app, so never in agent prose or fixtures */
const MODULE_INTERNAL = ['AppMapLog', 'AppMapScreenMarkerView'];
/** the debug-only surface that must sit under `#if APP_MAP_DEBUG` in app code (01 R5, 01 §2) */
const DEBUG_SYMBOLS = /\b(AppMapDeepLinkHandler|AppMapDeepLink\.|AppMapFixtures|AppMapFixtureError|AppMapDebugEndpoint|AppMapRoute)\b/g;
/** raw-text forbids for fixtures (design §7.2): iOS 17 API, the shadowing `Environment.current`, the alert-view marker, marker literals */
const FIXTURE_FORBIDDEN = ['@Observable', '@Bindable', '@Environment(', 'Environment.current', 'alert.view', '"screen.'];
/** lint-ids `isTestFile`: a stem that ends this way is never scanned, so a fixture named like it would test nothing */
const TEST_STEM = /(^|[^A-Za-z])([Tt]ests?|[Ss]pec)$/;

/**
 * Design §9, rules 1–3, 6, 8, 10 and 12: verbatim in every specialist body and the surveyor body
 * (amendment 2). Compared after whitespace normalisation; a reworded rule is a failing test.
 */
const SAFETY_RULES: ReadonlyArray<{ n: number; text: string }> = [
  { n: 1, text: 'Ids only through `AppMapID.Screen`, `AppMapID.Element`, `AppMapID.Gate`, `AppMapID.Gate.Dismiss` and `AppMapID.Gate.Control` constants that the plan attaches as `constant`; never a string literal equal to a registered id, never a computed string, never a constant name you derived yourself (01 R8). An item with `constant: null` is refused.' },
  { n: 2, text: 'Never put `appMapID` or `accessibilityIdentifier` on a SwiftUI `List`, `Section`, `ForEach` or a layout container (`VStack`, `HStack`, `ZStack`, `Group`); the row or control carries the id (issue #19).' },
  { n: 3, text: 'Never change production behaviour: no new views or view loads, no reordered lifecycle calls, no refactor or view extraction, no edits to `accessibilityElements`, `isAccessibilityElement`, `accessibilityLabel`, `.accessibilityElement(children:)` or `.accessibilityHidden`, no custom back bar items, no `appMapScreen` on a `UIAlertController`\'s view (01 §2).' },
  { n: 6, text: 'Never rename or delete an existing id or identifier; conflicts, renames and `double_marked` go to the report and `migrate-id` is a human-approved step run by the skill.' },
  { n: 8, text: 'No copy text, localized keys, names, amounts, credentials or PII in ids, titles, fixtures, notes or the report; fixtures seed sandbox accounts only and unknown seeding is a `TODO(app-map fixture)` body, never an invented value.' },
  { n: 10, text: 'Edit only at an anchor whose snippet matches verbatim; otherwise mark the item `blocked` with the nearest match. Never touch a line the plan does not name. Never guess.' },
  { n: 12, text: 'Never add a second `AppMapDeepLinkHandler`, `.onOpenURL`, registry call site or `#if APP_MAP_DEBUG` wiring block when the plan says one exists (`already_wired`); never re-mark an `already_marked` item.' },
];

// ---------------------------------------------------------------------------------------------
// File access: every read is an assertion naming the path (the files are drafted concurrently)
// ---------------------------------------------------------------------------------------------

const rel = (p: string): string => relative(REPO_ROOT, p).split('\\').join('/');

function readText(file: string): string {
  assert.ok(existsSync(file), `missing file: ${rel(file)}`);
  return readFileSync(file, 'utf8');
}

/** every `<ext>` file directly under `dir`, sorted; an absent or empty dir is an assertion */
function listFiles(dir: string, ext: string): string[] {
  assert.ok(existsSync(dir) && statSync(dir).isDirectory(), `missing directory: ${rel(dir)}`);
  const out = readdirSync(dir).filter((f) => extname(f) === ext).sort().map((f) => join(dir, f));
  assert.ok(out.length > 0, `no ${ext} files in ${rel(dir)}`);
  return out;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;
const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// Frontmatter (harness-notes §2): the `---` block; `name:`, `description:`, `tools:`, `model:`
// ---------------------------------------------------------------------------------------------

interface Frontmatter {
  fields: Record<string, string>;
  /** the block's raw lines, for the verbatim `tools:` line */
  raw: string;
  /** the system prompt after the block */
  body: string;
}

function parseFrontmatter(file: string): Frontmatter {
  const text = readText(file);
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  assert.ok(m !== null, `${rel(file)}: no --- frontmatter block`);
  const raw = m[1]!;
  const lines = raw.split(/\r?\n/);
  const fields: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):(.*)$/.exec(lines[i]!);
    if (kv === null) continue;
    let value = kv[2]!.trim();
    if (value === '' || /^[>|][-+]?$/.test(value)) {
      // block scalar or YAML list: the indented continuation lines
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(' ');
    }
    fields[kv[1]!] = value;
  }
  return { fields, raw, body: m[2]! };
}

/** the `tools:` frontmatter line, verbatim (05 §5.1 quotes it; verbs.test.ts precedent) */
function toolsLine(name: string): string {
  const fm = parseFrontmatter(agentFile(name));
  const line = fm.raw.split(/\r?\n/).find((l) => l.startsWith('tools:'));
  assert.ok(line !== undefined, `${rel(agentFile(name))}: no \`tools:\` line`);
  return line;
}

// ---------------------------------------------------------------------------------------------
// Swift text tools: comment/string blanking (indices preserved), brace walker, `#if` walker
// ---------------------------------------------------------------------------------------------

/**
 * Blank comments and/or string literal contents to spaces, keeping every index and line break,
 * so a regex hit in the result maps back to the same line of the raw file. `"appmap://x"` is a
 * string, not a `//` comment; nested block comments and `"""` strings are handled.
 */
function blankSwift(src: string, what: { comments: boolean; strings: boolean }): string {
  const out = src.split('');
  const n = src.length;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? n : nl;
      if (what.comments) blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; } else j++;
      }
      if (what.comments) blank(i, j);
      i = j;
      continue;
    }
    if (c === '"') {
      const triple = src.startsWith('"""', i);
      const quote = triple ? 3 : 1;
      let j = i + quote;
      let terminated = false;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (triple ? src.startsWith('"""', j) : src[j] === '"') { terminated = true; break; }
        if (!triple && src[j] === '\n') break;
        j++;
      }
      if (what.strings) blank(i + quote, Math.min(j, n));
      i = terminated ? j + quote : j;
      continue;
    }
    i++;
  }
  return out.join('');
}
/** comments blanked, strings kept: for name/argument scans */
const code = (src: string): string => blankSwift(src, { comments: true, strings: false });
/** comments and string contents blanked: for brace walking */
const structure = (src: string): string => blankSwift(src, { comments: true, strings: true });

interface Block { open: number; close: number }

/** every `{ … }` pair of a structure-blanked text, by index */
function braceBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const stack: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') stack.push(i);
    else if (text[i] === '}') {
      const open = stack.pop();
      if (open !== undefined) blocks.push({ open, close: i });
    }
  }
  return blocks;
}

function innermostBlock(blocks: readonly Block[], index: number): Block | undefined {
  let best: Block | undefined;
  for (const b of blocks) {
    if (b.open < index && index < b.close && (best === undefined || b.close - b.open < best.close - best.open)) best = b;
  }
  return best;
}

/** the block opened by the first `{` at or after `from` */
function blockOpeningAfter(blocks: readonly Block[], text: string, from: number): Block | undefined {
  const open = text.indexOf('{', from);
  return open === -1 ? undefined : blocks.find((b) => b.open === open);
}

/** the body of every `func <name>(` — the `{` after the signature, brace-walked (viewDidLoad / viewWillAppear) */
function methodBodies(text: string, name: string): Block[] {
  const blocks = braceBlocks(text);
  const out: Block[] = [];
  for (const m of text.matchAll(new RegExp(`\\bfunc\\s+${name}\\s*\\(`, 'g'))) {
    const body = blockOpeningAfter(blocks, text, (m.index ?? 0) + m[0].length);
    if (body !== undefined) out.push(body);
  }
  return out;
}

const inside = (b: Block, index: number): boolean => b.open < index && index < b.close;

/**
 * Per line (1-based), is the line inside an `#if APP_MAP_DEBUG` branch? A stack of `#if` frames:
 * `#if APP_MAP_DEBUG` turns on, its `#else` turns off; `#if !APP_MAP_DEBUG` the reverse;
 * `#elseif` re-evaluates; unrelated `#if`s (`DEBUG`, `canImport(UIKit)`) inherit the enclosing state.
 */
function debugRegionLines(text: string): boolean[] {
  const kindOf = (cond: string): 'debug' | 'negated' | 'other' =>
    /!\s*APP_MAP_DEBUG\b/.test(cond) ? 'negated' : /\bAPP_MAP_DEBUG\b/.test(cond) ? 'debug' : 'other';
  const stack: Array<{ kind: 'debug' | 'negated' | 'other'; on: boolean }> = [];
  const perLine: boolean[] = [false]; // index 0 unused: lines are 1-based
  for (const line of text.split('\n')) {
    const t = line.trim();
    let m: RegExpExecArray | null;
    if ((m = /^#if\b(.*)$/.exec(t)) !== null) {
      const kind = kindOf(m[1]!);
      stack.push({ kind, on: kind === 'debug' });
    } else if ((m = /^#elseif\b(.*)$/.exec(t)) !== null) {
      const top = stack[stack.length - 1];
      if (top !== undefined) { top.kind = kindOf(m[1]!); top.on = top.kind === 'debug'; }
    } else if (/^#else\b/.test(t)) {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.on = top.kind === 'negated';
    } else if (/^#endif\b/.test(t)) {
      stack.pop();
    }
    perLine.push(stack.some((f) => f.on));
  }
  return perLine;
}

// ---------------------------------------------------------------------------------------------
// AppMapKit: the public surface (design §7.4 API pin) and the generated constants
// ---------------------------------------------------------------------------------------------

interface KitSurface {
  /** public declaration names, members of `public extension X { }`, cases of `public enum` */
  names: Set<string>;
  /** `AppMap*` string keys the package defines: the launch argument, Info.plist keys, the `@objc` name */
  keys: Set<string>;
}

/** Text parse of `AppMapKit/*.swift`, `#if` ignored (both branches are public API of some build). */
function appMapKitSurface(): KitSurface {
  const names = new Set<string>();
  const keys = new Set<string>();
  for (const file of listFiles(APPMAPKIT_SRC, '.swift')) {
    const raw = readText(file);
    const text = code(raw);
    const blocks = braceBlocks(structure(raw));
    for (const m of text.matchAll(/\bpublic\s+(?:final\s+)?(?:static\s+)?(?:func|var|let|enum|struct|class|protocol|typealias)\s+(\w+)/g)) names.add(m[1]!);
    // `public extension View { func appMapScreen … }`: members carry no `public` of their own
    for (const m of text.matchAll(/\bpublic\s+extension\s+\w+\s*\{/g)) {
      const block = blocks.find((b) => b.open === (m.index ?? 0) + m[0].length - 1);
      if (block === undefined) continue;
      for (const d of text.slice(block.open, block.close).matchAll(/\b(?:func|var|let)\s+(\w+)/g)) {
        if (innermostBlock(blocks, block.open + (d.index ?? 0) + 1) === block) names.add(d[1]!); // members, not locals
      }
    }
    // `case unknown(name:)` at the top level of a `public enum` (not a `switch` inside a method)
    for (const m of text.matchAll(/\bpublic\s+(?:indirect\s+)?enum\s+\w+[^{\n]*\{/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      const block = blocks.find((b) => b.open === open);
      if (block === undefined) continue;
      for (const c of text.slice(block.open, block.close).matchAll(/^\s*(?:indirect\s+)?case\s+([^\n]+)/gm)) {
        if (innermostBlock(blocks, block.open + (c.index ?? 0) + 1) !== block) continue;
        for (const part of c[1]!.split(',')) {
          const id = /^\s*(\w+)/.exec(part);
          if (id !== null) names.add(id[1]!);
        }
      }
    }
    for (const m of raw.matchAll(/["(]-?(AppMap[A-Z]\w*)[")]/g)) keys.add(m[1]!);
  }
  return { names, keys };
}

/**
 * `AppMapID.swift` → qualified names without the `AppMapID.` prefix: the namespaces (`Screen`,
 * `Gate.Dismiss`) and every constant (`Screen.invoiceList`, `Gate.Dismiss.pushPermissionDeny`).
 * Backticked keyword names are recorded bare, which is how a `.`-qualified reference spells them.
 */
function generatedConstants(): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [];
  for (const line of code(readText(GENERATED_SWIFT)).split('\n')) {
    const en = /\benum\s+(\w+)\s*\{/.exec(line);
    if (en !== null) {
      stack.push(en[1]!);
      if (stack.length > 1) out.add(stack.slice(1).join('.'));
      continue;
    }
    const st = /\bstatic\s+let\s+`?(\w+)`?/.exec(line);
    if (st !== null) out.add([...stack.slice(1), st[1]!].join('.'));
    if (/^\s*\}\s*$/.test(line)) stack.pop();
  }
  assert.ok(out.has('Screen.invoiceList'), `${rel(GENERATED_SWIFT)}: parser found no Screen.invoiceList`);
  return out;
}

/** `register(id:route:viewType:title:staticEdges:)` and friends, derived from the Swift signatures */
function registrySelectors(): Set<string> {
  const text = code(readText(ROUTER_REGISTRY_SWIFT));
  const out = new Set<string>();
  for (const m of text.matchAll(/\bpublic\s+func\s+(\w+)\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < text.length; close++) {
      if (text[close] === '(') depth++;
      else if (text[close] === ')' && --depth === 0) break;
    }
    const params = text.slice(open + 1, close);
    const labels: string[] = [];
    let nested = 0;
    let start = 0;
    for (let k = 0; k <= params.length; k++) {
      const ch = params[k];
      if (ch === '(' || ch === '[' || ch === '{') nested++;
      else if (ch === ')' || ch === ']' || ch === '}') nested--;
      else if ((ch === ',' && nested === 0) || k === params.length) {
        const p = params.slice(start, k).trim();
        if (p.length > 0) labels.push(/^([^\s:]+)/.exec(p)![1]!);
        start = k + 1;
      }
    }
    out.add(`${m[1]!}(${labels.map((l) => `${l}:`).join('')})`);
  }
  return out;
}

/** the files whose `AppMap*` vocabulary and `AppMapID.*` constants are pinned to the kit */
function agentSideFiles(): string[] {
  return [
    ...AGENTS.map(agentFile),
    SKILL_FILE,
    ...listFiles(REFERENCE_DIR, '.md'),
    ...listFiles(SWIFTUI_SET, '.swift'),
    ...listFiles(UIKIT_SET, '.swift'),
    GOLDEN_PLAN,
  ];
}

// ---------------------------------------------------------------------------------------------
// Registry, markdown tables, fenced JSON, the plan
// ---------------------------------------------------------------------------------------------

interface Registry { screens: Set<string>; gates: Set<string>; dismiss: Set<string>; controls: Set<string>; elements: Set<string>; literals: Set<string> }

/** the pilot `ids.yaml` as id sets; `literals` is every string lint-ids would flag (markers included) */
function pilotRegistry(): Registry {
  const ids = readIds(PILOT_CONFIG);
  const screens = new Set(ids.screens.map((s) => s.id));
  const gates = new Set(ids.gates.map((g) => g.id));
  const dismiss = new Set(ids.gates.map((g) => g.dismiss));
  const controls = new Set(ids.gates.flatMap((g) => (g.controls ?? []).map((c) => c.id)));
  const elements = new Set(ids.elements.map((e) => e.id));
  const literals = new Set([...[...screens].map((s) => `screen.${s}`), ...gates, ...dismiss, ...controls, ...elements]);
  return { screens, gates, dismiss, controls, elements, literals };
}

const KIND_TABLE_HEADER = '| Construct (SwiftUI) | Construct (UIKit) | kind |';

/** cells of one `| a | b | c |` row, backticks stripped, `\|` honoured */
function splitRow(line: string): string[] {
  return line.trim().replace(/\\\|/g, '\u0000').replace(/^\|/, '').replace(/\|$/, '').split('|')
    .map((c) => c.replace(/\u0000/g, '|').replace(/`/g, '').trim());
}

/** rows of the FIRST table whose header starts `KIND_TABLE_HEADER` (amendment 2) */
function parseKindTable(file: string): string[][] {
  const lines = readText(file).split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(KIND_TABLE_HEADER));
  assert.ok(start >= 0, `${rel(file)}: no table whose header starts "${KIND_TABLE_HEADER}"`);
  assert.match(lines[start + 1] ?? '', /^\s*\|\s*-+/, `${rel(file)}: kind table header is not followed by a separator row`);
  const rows: string[][] = [];
  for (let i = start + 2; i < lines.length && lines[i]!.trim().startsWith('|'); i++) rows.push(splitRow(lines[i]!));
  assert.ok(rows.length > 0, `${rel(file)}: kind table has no rows`);
  return rows;
}

/** the FIRST ```json fenced block of a markdown file, parsed (amendment 2) */
function firstJsonFence(file: string): unknown {
  const m = /```json[^\n]*\n([\s\S]*?)\n\s*```/.exec(readText(file));
  assert.ok(m !== null, `${rel(file)}: no \`\`\`json fenced block`);
  try {
    return JSON.parse(m[1]!);
  } catch (e) {
    return assert.fail(`${rel(file)}: the first json block is not valid JSON: ${(e as Error).message}`);
  }
}

// ajv-formats is CJS with `exports.default = formatsPlugin` (see src/yaml/schemas.ts)
const addFormats: FormatsPlugin = (formatsModule as unknown as { default?: FormatsPlugin }).default ?? (formatsModule as unknown as FormatsPlugin);

/** the plan schema from `reference/survey-plan.md`, compiled the way src/yaml/schemas.ts compiles the map schemas */
function compilePlanSchema(): { schema: Record<string, unknown>; validate: ValidateFunction } {
  const file = join(REFERENCE_DIR, 'survey-plan.md');
  const schema = firstJsonFence(file);
  assert.ok(typeof schema === 'object' && schema !== null && !Array.isArray(schema), `${rel(file)}: the first json block is not a schema object`);
  const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true });
  addFormats(ajv);
  try {
    return { schema: schema as Record<string, unknown>, validate: ajv.compile(schema as object) };
  } catch (e) {
    return assert.fail(`${rel(file)}: the plan schema does not compile under Ajv strict mode: ${(e as Error).message}`);
  }
}

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : undefined);

/** follow a local `$ref` (`#/definitions/x`, `#/$defs/x`) to its target */
function deref(schema: Json, node: unknown): unknown {
  const obj = asObject(node);
  const ref = obj?.['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let cursor: unknown = schema;
  for (const seg of ref.slice(2).split('/')) cursor = asObject(cursor)?.[seg.replace(/~1/g, '/').replace(/~0/g, '~')];
  return deref(schema, cursor);
}

/** `properties.decisions.items.properties.kind.enum`, through `$ref`s */
function decisionKindEnum(schema: Json): string[] | undefined {
  const props = asObject(deref(schema, schema['properties']));
  const decisions = asObject(deref(schema, props?.['decisions']));
  const item = asObject(deref(schema, decisions?.['items']));
  const itemProps = asObject(deref(schema, item?.['properties']));
  const kind = asObject(deref(schema, itemProps?.['kind']));
  const e = kind?.['enum'];
  return Array.isArray(e) ? (e as string[]) : undefined;
}

interface PlanItem {
  role?: string;
  proposed_id?: string | null;
  existing_id?: string | null;
  constant?: string | null;
  screen?: string | null;
  anchor?: { line?: number; snippet?: string } | null;
  gate?: { native?: boolean; dismiss?: string; controls?: Array<{ id?: string }> } | null;
  static_edges?: Array<{ element?: string; to?: string }> | null;
  risk?: string;
  status?: string;
}
interface PlanFile { path?: string; owner?: string; items?: PlanItem[] }
interface Plan {
  schema_version?: number;
  app?: { src_roots?: string[]; lifecycle?: string; wiring_placement?: string };
  files?: PlanFile[];
  decisions?: Array<{ kind?: string }>;
}

function readGoldenPlan(): Plan {
  try {
    return JSON.parse(readText(GOLDEN_PLAN)) as Plan;
  } catch (e) {
    if (e instanceof assert.AssertionError) throw e;
    return assert.fail(`${rel(GOLDEN_PLAN)} is not valid JSON: ${(e as Error).message}`);
  }
}

/** every `(file, item)` of the plan, with the item's effective id */
function planItems(plan: Plan): Array<{ file: string; item: PlanItem; id: string | null; where: string }> {
  const out: Array<{ file: string; item: PlanItem; id: string | null; where: string }> = [];
  for (const f of plan.files ?? []) {
    (f.items ?? []).forEach((item, i) => {
      out.push({ file: f.path ?? '?', item, id: item.proposed_id ?? item.existing_id ?? null, where: `${f.path ?? '?'} items[${i}] (${item.role ?? 'no role'})` });
    });
  }
  return out;
}

/** a plan `files[].path` on disk: relative to the repo, to a `src_roots[]` entry, or to the fixture set */
function resolvePlanPath(plan: Plan, path: string): string {
  const candidates = [
    join(REPO_ROOT, path),
    ...(plan.app?.src_roots ?? []).map((r) => join(REPO_ROOT, r, path)),
    join(SWIFTUI_SET, path),
    join(INSTRUMENT_FIXTURES, path),
  ];
  const hit = candidates.find((c) => existsSync(c));
  assert.ok(hit !== undefined, `${rel(GOLDEN_PLAN)}: files[].path "${path}" does not exist (tried repo root, src_roots, ${rel(SWIFTUI_SET)})`);
  return hit;
}

// ---------------------------------------------------------------------------------------------
// Fixture sets
// ---------------------------------------------------------------------------------------------

/** the lint the skill runs (design §6.1): the set as the only iOS source tree, instrumented, real gen-ids --check */
function lintSet(dir: string): LintIdsResult {
  listFiles(dir, '.swift'); // an absent dir would be "skipped" by lint-ids and pass vacuously
  return lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT, iosDirs: [rel(dir)], platforms: ['ios'], instrumentedPlatforms: ['ios'] });
}
const errorsOf = (r: LintIdsResult): LintIdsResult['issues'] => r.issues.filter((i) => i.severity === 'error');

/** a `<section heading>` … next `## ` slice of a markdown file */
function section(file: string, heading: RegExp): string {
  const lines = readText(file).split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  assert.ok(start >= 0, `${rel(file)}: no heading matching ${heading}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]!)) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** the `it`s both fixture sets share (design §7.2 "fixture rules") */
function fixtureSetSuite(dir: string): void {
  it('is lint-clean on its own with --instrumented ios: every marker referenced, no literal id, gen-ids in sync (01 R8)', () => {
    const r = lintSet(dir);
    assert.deepEqual(errorsOf(r), [], `${rel(dir)} lint errors:\n${JSON.stringify(errorsOf(r), null, 2)}`);
  });

  it('lints identically twice (the §6.2 loop and the idempotency acceptance rely on a stable check)', () => {
    assert.deepEqual(lintSet(dir).issues, lintSet(dir).issues);
  });

  it('never puts an id on List, Section or ForEach; the row carries it (issue #19)', () => {
    for (const file of listFiles(dir, '.swift')) {
      const lines = code(readText(file)).split('\n');
      lines.forEach((line, i) => {
        // design §7.4: the container-with-id shape on one line
        assert.doesNotMatch(line, /\b(List|Section|ForEach)\s*(\(|\{)[^\n]*\.appMapID\(/, `${rel(file)}:${i + 1}: id on a List/Section/ForEach`);
        // design §7.4: an id on the line right after a `Section(` / `Section {` header propagates to every row
        if (/\bSection\s*[({]/.test(line) && (lines[i + 1] ?? '').includes('.appMapID(')) {
          assert.fail(`${rel(file)}:${i + 2}: .appMapID( directly under a Section header (issue #19)`);
        }
      });
    }
  });

  it('every appMapScreen( argument is an AppMapID.Screen or AppMapID.Gate constant (01 R3, 01 R8)', () => {
    for (const file of listFiles(dir, '.swift')) {
      const text = code(readText(file));
      for (const m of text.matchAll(/\bappMapScreen\(\s*([^()]*?)\s*\)/g)) {
        assert.match(m[1]!, /^AppMapID\.(Screen|Gate)\./, `${rel(file)}:${lineOf(text, m.index ?? 0)}: appMapScreen(${m[1]!}) is not a marker or gate constant`);
      }
    }
  });

  it('every debug-only symbol sits inside an #if APP_MAP_DEBUG region (01 R5, 01 §2)', () => {
    for (const file of listFiles(dir, '.swift')) {
      const text = code(readText(file));
      const regions = debugRegionLines(text);
      for (const m of text.matchAll(DEBUG_SYMBOLS)) {
        const line = lineOf(text, m.index ?? 0);
        assert.ok(regions[line] === true, `${rel(file)}:${line}: ${m[1]!} outside #if APP_MAP_DEBUG`);
      }
    }
  });

  it('AppMapWiring.swift calls exportIfRequested() before AppMapDebugEndpoint.publish( (07 §3; design §3.6)', () => {
    const file = join(dir, 'AppMapWiring.swift');
    const text = code(readText(file));
    const exportAt = text.indexOf('exportIfRequested()');
    const publishAt = text.indexOf('AppMapDebugEndpoint.publish(');
    assert.ok(exportAt >= 0, `${rel(file)}: no exportIfRequested() call`);
    assert.ok(publishAt >= 0, `${rel(file)}: no AppMapDebugEndpoint.publish( call`);
    assert.ok(exportAt < publishAt, `${rel(file)}: publish( must come after exportIfRequested() (an export launch exits there)`);
  });

  it('DebugFixtures.swift keeps the AppMapFixtures contract: TODO bodies, unknown names throw .unknown (design §3.6)', () => {
    const file = join(dir, 'DebugFixtures.swift');
    const raw = readText(file);
    assert.ok(raw.includes('TODO(app-map fixture)'), `${rel(file)}: no TODO(app-map fixture) body (rule 8: never an invented value)`);
    assert.ok(code(raw).includes('AppMapFixtureError.unknown(name: name)'), `${rel(file)}: unknown names must throw AppMapFixtureError.unknown(name: name)`);
  });

  it('uses no iOS 17 API, no Environment.current, no alert.view, no marker literal and no registered id literal (design §7.2)', () => {
    const registry = pilotRegistry();
    for (const file of listFiles(dir, '.swift')) {
      const raw = readText(file); // raw on purpose: amendment 7 says comments never carry these either
      for (const needle of FIXTURE_FORBIDDEN) assert.ok(!raw.includes(needle), `${rel(file)} contains ${needle}`);
      for (const id of registry.literals) assert.ok(!raw.includes(`"${id}"`), `${rel(file)} contains the literal "${id}" (01 R8)`);
    }
  });

  it('no file stem reads as a test file to lint-ids (design §1 naming constraints)', () => {
    for (const file of listFiles(dir, '.swift')) {
      assert.doesNotMatch(basename(file, '.swift'), TEST_STEM, `${rel(file)} would be skipped by lint-ids`);
    }
  });

  it('AppRouter+AppMap.swift switches on bare pilot screen ids, never on AppMapID.Screen (design §10.1)', () => {
    const file = join(dir, 'AppRouter+AppMap.swift');
    const text = code(readText(file));
    const screens = pilotRegistry().screens;
    assert.ok(!/\bcase\s+AppMapID\.Screen\./.test(text), `${rel(file)}: AppMapRoute.screenID is the bare id, so case AppMapID.Screen.x never matches`);
    const seen: string[] = [];
    for (const m of text.matchAll(/\bcase\s+("[^"]*"(?:\s*,\s*"[^"]*")*)/g)) {
      for (const lit of m[1]!.matchAll(/"([^"]*)"/g)) {
        const id = lit[1]!;
        assert.match(id, SCREEN_ID_REGEX, `${rel(file)}: case "${id}" is not a bare screen id`);
        assert.ok(screens.has(id), `${rel(file)}: case "${id}" is not a pilot screen`);
        seen.push(id);
      }
    }
    assert.ok(seen.length > 0, `${rel(file)}: no case "<screen id>" in the router mapping`);
  });
}

// =============================================================================================

describe('agent frontmatter', () => {
  it('the three agent files exist and `name` equals the file stem (harness-notes §2)', () => {
    for (const name of AGENTS) {
      const fm = parseFrontmatter(agentFile(name));
      assert.equal(fm.fields['name'], name, `${rel(agentFile(name))}: name must equal the file stem`);
      assert.ok((fm.fields['description'] ?? '').length > 0, `${rel(agentFile(name))}: empty description`);
    }
  });

  it('the surveyor is read-only: `tools: Read, Grep, Glob` exactly (design §2.1)', () => {
    assert.equal(toolsLine(SURVEYOR), SURVEYOR_TOOLS);
  });

  it('each specialist edits source: `tools: Read, Edit, Write, Grep, Glob, Bash` exactly (brief §6, design §2.2–2.3)', () => {
    for (const name of SPECIALISTS) assert.equal(toolsLine(name), SPECIALIST_TOOLS, rel(agentFile(name)));
  });

  it('no agent is granted an MCP tool (brief §6: never mcp__argent__* or mcp__app-map__*)', () => {
    for (const name of AGENTS) {
      const tools = toolsLine(name).slice('tools:'.length).split(',').map((t) => t.trim());
      for (const t of tools) assert.ok(!t.startsWith('mcp__'), `${rel(agentFile(name))} grants ${t}`);
    }
  });

  it('`model:` is haiku|sonnet|opus|inherit, and all three inherit the session model (amendment 1, design §2.2)', () => {
    for (const name of AGENTS) {
      const model = parseFrontmatter(agentFile(name)).fields['model'];
      if (model !== undefined) assert.ok(MODELS.has(model), `${rel(agentFile(name))}: model "${model}"`);
      assert.equal(model, 'inherit', `${rel(agentFile(name))}: survey precision and source edits both get the session model`);
    }
  });

  it('no agent, skill or reference file names a model id (brief §6)', () => {
    for (const file of [...AGENTS.map(agentFile), SKILL_FILE, ...listFiles(REFERENCE_DIR, '.md')]) {
      assert.doesNotMatch(readText(file), /claude-[a-z0-9-]+/, `${rel(file)} names a model id`);
    }
  });

  it('each specialist has exactly one "Bash is for" line, naming lint-ids and git diff --stat (§9 rule 11; amendment 2)', () => {
    for (const name of SPECIALISTS) {
      const body = parseFrontmatter(agentFile(name)).body;
      // a list marker or bold prefix does not change what the line begins with
      const lines = body.split('\n').filter((l) => l.replace(/^\s*(?:[-*+]|\d+[.)])?\s*(?:\*\*)?\s*/, '').startsWith('Bash is for'));
      assert.equal(lines.length, 1, `${rel(agentFile(name))}: expected exactly one line beginning "Bash is for", found ${lines.length}`);
      assert.ok(lines[0]!.includes('lint-ids'), `${rel(agentFile(name))}: the Bash line must name lint-ids`);
      assert.ok(lines[0]!.includes('git diff --stat'), `${rel(agentFile(name))}: the Bash line must name git diff --stat`);
    }
  });

  it('specialists and the surveyor carry safety rules 1–3, 6, 8, 10 and 12 verbatim (design §9; amendment 2)', () => {
    for (const name of AGENTS) {
      const body = normalizeWs(parseFrontmatter(agentFile(name)).body);
      for (const rule of SAFETY_RULES) {
        assert.ok(body.includes(normalizeWs(rule.text)), `${rel(agentFile(name))}: safety rule ${rule.n} is missing or reworded: "${rule.text.slice(0, 70)}…"`);
      }
    }
  });
});

describe('skill', () => {
  it('SKILL.md name + description fit the 1,536-character cap (harness-notes §3)', () => {
    const fm = parseFrontmatter(SKILL_FILE);
    assert.equal(fm.fields['name'], 'app-instrument');
    const len = (fm.fields['name'] ?? '').length + (fm.fields['description'] ?? '').length;
    assert.ok(len <= 1536, `${rel(SKILL_FILE)}: name + description is ${len} chars`);
  });

  it('the skill body names the three agents (design §3.1)', () => {
    const body = parseFrontmatter(SKILL_FILE).body;
    for (const name of AGENTS) assert.ok(body.includes(name), `${rel(SKILL_FILE)} does not name ${name}`);
  });

  it('the skill names every reference file by path (amendment 3)', () => {
    const text = readText(SKILL_FILE);
    for (const ref of REFERENCE_FILES) assert.ok(text.includes(`reference/${ref}`), `${rel(SKILL_FILE)} does not name reference/${ref}`);
  });

  it('every reference/*.md the skill or an agent names exists (design §3.2–3.7)', () => {
    for (const file of [SKILL_FILE, ...AGENTS.map(agentFile)]) {
      for (const m of readText(file).matchAll(/reference\/([\w-]+\.md)/g)) {
        assert.ok(existsSync(join(REFERENCE_DIR, m[1]!)), `${rel(file)} names reference/${m[1]!}, which does not exist`);
      }
    }
  });
});

describe('api pin', () => {
  it('the AppMapKit parser finds the extension members, the @objc class, the enum case and the statics (self-check)', () => {
    const { names } = appMapKitSurface();
    for (const n of ['appMapScreen', 'appMapID', 'AppMapDeepLinkHandler', 'AppMapFixtureError', 'unknown', 'publish', 'isSandbox', 'exportIfRequested', 'registerGate', 'scheme']) {
      assert.ok(names.has(n), `parser missed ${n} in ${rel(APPMAPKIT_SRC)}`);
    }
    for (const n of MODULE_INTERNAL) assert.ok(!names.has(n), `${n} is module-internal and must not parse as public`);
  });

  it('every AppMap*/appMap* token in agents, skill, references and fixtures is a public AppMapKit name (design §7.4)', () => {
    const { names, keys } = appMapKitSurface();
    for (const file of agentSideFiles()) {
      const text = readText(file);
      for (const m of text.matchAll(/\b(AppMap[A-Z]\w*|appMap\w+)\b/g)) {
        const token = m[1]!;
        const line = lineOf(text, m.index ?? 0);
        assert.ok(!MODULE_INTERNAL.includes(token), `${rel(file)}:${line}: ${token} is AppMapKit-internal`);
        assert.ok(names.has(token) || keys.has(token) || APP_SIDE_ALLOWED.has(token), `${rel(file)}:${line}: ${token} is not a public AppMapKit name (app-side names never start with AppMap; only ${[...APP_SIDE_ALLOWED].join(', ')} are allowed)`);
      }
    }
  });

  it('every AppMapID.<ns>.<name> token in the same files exists in the generated pilot AppMapID.swift (01 R8)', () => {
    const constants = generatedConstants();
    const genIdsEmitsControl = readText(GEN_IDS_SCRIPT).includes('public enum Control');
    for (const file of agentSideFiles()) {
      const text = readText(file);
      for (const m of text.matchAll(/\bAppMapID\.(Screen|Element|Gate\.Dismiss|Gate\.Control|Gate)\.([A-Za-z_]\w*)/g)) {
        const [ns, name] = [m[1]!, m[2]!];
        const where = `${rel(file)}:${lineOf(text, m.index ?? 0)}`;
        if (ns === 'Gate' && (name === 'Dismiss' || name === 'Control')) {
          // a namespace mention (`AppMapID.Gate.Control.<name>` placeholder, rule 1's list)
          if (name === 'Control') assert.ok(genIdsEmitsControl, `${where}: gen-ids does not emit AppMapID.Gate.Control`);
          else assert.ok(constants.has('Gate.Dismiss'), `${where}: no Gate.Dismiss namespace in ${rel(GENERATED_SWIFT)}`);
          continue;
        }
        if (ns === 'Gate.Control') assert.ok(genIdsEmitsControl, `${where}: gen-ids does not emit AppMapID.Gate.Control`);
        assert.ok(constants.has(`${ns}.${name}`), `${where}: AppMapID.${ns}.${name} does not exist in ${rel(GENERATED_SWIFT)} (pilot ids only; placeholders go in angle brackets)`);
      }
    }
  });

  it('the AppMapRouterRegistry selectors the references quote are the Swift signatures (01 R6)', () => {
    const selectors = registrySelectors();
    for (const s of ['register(id:route:viewType:title:staticEdges:)', 'registerGate(id:dismiss:)']) {
      assert.ok(selectors.has(s), `parser did not derive ${s} from ${rel(ROUTER_REGISTRY_SWIFT)}: ${[...selectors].join(', ')}`);
    }
    for (const file of [...AGENTS.map(agentFile), SKILL_FILE, ...listFiles(REFERENCE_DIR, '.md')]) {
      const text = readText(file);
      for (const m of text.matchAll(/\b((?:register|registerGate|exportIfRequested)\((?:\w+:)+\))/g)) {
        assert.ok(selectors.has(m[1]!), `${rel(file)}:${lineOf(text, m.index ?? 0)}: ${m[1]!} is not a public AppMapRouterRegistry method`);
      }
    }
  });
});

describe('kind table', () => {
  it('reference/id-rules.md: the kind column is exactly ELEMENT_KINDS / KIND_SYNONYMS plus one `none` row for List, Section, ForEach (01 R2; design §5.3)', () => {
    const file = join(REFERENCE_DIR, 'id-rules.md');
    const rows = parseKindTable(file);
    const kinds = rows.map((r) => r[2] ?? '');
    const noneRows = rows.filter((r) => r[2] === 'none');
    assert.equal(noneRows.length, 1, `${rel(file)}: expected exactly one \`none\` row, found ${noneRows.length}`);
    for (const construct of ['List', 'Section', 'ForEach']) {
      assert.ok((noneRows[0]![0] ?? '').includes(construct), `${rel(file)}: the none row must name ${construct} (issue #19)`);
    }
    const table = [...new Set(kinds.filter((k) => k !== 'none'))].sort();
    assert.deepEqual(table, Object.keys(KIND_SYNONYMS).sort(), `${rel(file)}: kind column vs KIND_SYNONYMS`);
    assert.deepEqual(table, [...ELEMENT_KINDS].sort(), `${rel(file)}: kind column vs ELEMENT_KINDS`);
  });
});

describe('plan schema', () => {
  it('the first json block of reference/survey-plan.md compiles with Ajv and plan.pilot.json validates against it', () => {
    const { validate } = compilePlanSchema();
    const plan = readGoldenPlan();
    const ok = validate(plan);
    assert.ok(ok, `${rel(GOLDEN_PLAN)} does not validate:\n${JSON.stringify(validate.errors, null, 2)}`);
  });

  it('every id in plan.pilot.json has the shape of its role and is a registered pilot id (01 R2; design §7.3)', () => {
    const plan = readGoldenPlan();
    const registry = pilotRegistry();
    for (const { item, id, where } of planItems(plan)) {
      const role = item.role ?? '';
      if (id !== null) {
        if (role === 'screen') {
          assert.match(id, SCREEN_ID_REGEX, `${where}: ${id}`);
          assert.ok(registry.screens.has(id), `${where}: screen ${id} is not in the pilot ids.yaml`);
        } else if (role === 'element' || role === 'tab') {
          assert.match(id, ELEMENT_ID_REGEX, `${where}: ${id}`);
          assert.ok(registry.elements.has(id), `${where}: element ${id} is not in the pilot ids.yaml`);
        } else if (role === 'gate') {
          assert.match(id, GATE_ID_REGEX, `${where}: ${id}`);
          assert.ok(registry.gates.has(id), `${where}: gate ${id} is not in the pilot ids.yaml`);
        } else {
          assert.ok([SCREEN_ID_REGEX, ELEMENT_ID_REGEX, GATE_ID_REGEX, GATE_DISMISS_REGEX].some((re) => re.test(id)), `${where}: ${id} matches no id shape`);
        }
      }
      if (typeof item.screen === 'string') assert.ok(registry.screens.has(item.screen), `${where}: screen "${item.screen}" is not a pilot screen`);
      if (item.gate) {
        if (typeof item.gate.dismiss === 'string') {
          assert.match(item.gate.dismiss, GATE_DISMISS_REGEX, `${where}: dismiss ${item.gate.dismiss}`);
          assert.ok(registry.dismiss.has(item.gate.dismiss), `${where}: dismiss ${item.gate.dismiss} is not in the pilot ids.yaml`);
        }
        for (const c of item.gate.controls ?? []) {
          if (typeof c.id === 'string') assert.ok(registry.controls.has(c.id), `${where}: gate control ${c.id} is not in the pilot ids.yaml`);
        }
      }
      for (const e of item.static_edges ?? []) {
        if (typeof e.to === 'string') assert.ok(registry.screens.has(e.to), `${where}: static edge to "${e.to}" is not a pilot screen`);
        if (typeof e.element === 'string') assert.ok(registry.elements.has(e.element), `${where}: static edge element "${e.element}" is not a pilot element`);
      }
    }
  });

  it('every non-null `constant` in plan.pilot.json exists in the generated AppMapID.swift (design §3.1 constant fill)', () => {
    const constants = generatedConstants();
    let filled = 0;
    for (const { item, where } of planItems(readGoldenPlan())) {
      if (typeof item.constant !== 'string') continue;
      const m = /^AppMapID\.(.+)$/.exec(item.constant);
      assert.ok(m !== null, `${where}: constant "${item.constant}" is not an AppMapID.* name`);
      assert.ok(constants.has(m![1]!), `${where}: ${item.constant} does not exist in ${rel(GENERATED_SWIFT)}`);
      filled++;
    }
    assert.ok(filled > 0, `${rel(GOLDEN_PLAN)}: no item carries a constant`);
  });

  it('every decisions[].kind is in the schema enum (design §4)', () => {
    const { schema } = compilePlanSchema();
    const kinds = decisionKindEnum(schema);
    assert.ok(kinds !== undefined && kinds.length > 0, `${rel(join(REFERENCE_DIR, 'survey-plan.md'))}: the schema declares no enum for decisions[].kind`);
    for (const d of readGoldenPlan().decisions ?? []) assert.ok(kinds!.includes(d.kind ?? ''), `${rel(GOLDEN_PLAN)}: decision kind "${d.kind}" is not in the schema enum`);
  });

  it('every anchor snippet is a verbatim line of its fixture file within ±5 of anchor.line (amendment 4)', () => {
    const plan = readGoldenPlan();
    const cache = new Map<string, string[]>();
    let anchors = 0;
    for (const { file, item, where } of planItems(plan)) {
      if (!item.anchor || typeof item.anchor.snippet !== 'string') continue;
      anchors++;
      const abs = resolvePlanPath(plan, file);
      const lines = cache.get(abs) ?? readText(abs).split('\n').map((l) => l.trim());
      cache.set(abs, lines);
      const snippet = item.anchor.snippet.trim();
      const line = typeof item.anchor.line === 'number' ? item.anchor.line : 0;
      const hits = lines.map((l, i) => (l === snippet ? i + 1 : -1)).filter((i) => i > 0);
      assert.ok(hits.length > 0, `${where}: anchor snippet "${snippet}" is not a line of ${rel(abs)}`);
      assert.ok(hits.some((h) => Math.abs(h - line) <= 5), `${where}: anchor line ${line} but the snippet is at line(s) ${hits.join(', ')} of ${rel(abs)} (±5 allowed)`);
    }
    assert.ok(anchors > 0, `${rel(GOLDEN_PLAN)}: no item carries an anchor`);
  });

  it('the golden plan is the SwiftUI pilot: swiftui_app, new_files, five screens, three tabs, two native gates, one blocked a11y_hazard (design §7.3)', () => {
    const plan = readGoldenPlan();
    const registry = pilotRegistry();
    assert.equal(plan.schema_version, 1);
    assert.equal(plan.app?.lifecycle, 'swiftui_app');
    assert.equal(plan.app?.wiring_placement, 'new_files');
    const items = planItems(plan);
    const screens = items.filter((x) => x.item.role === 'screen').map((x) => x.id).sort();
    assert.deepEqual(screens, [...registry.screens].sort(), 'screen items must be exactly the five pilot screens');
    const tabs = items.filter((x) => x.item.role === 'tab').map((x) => x.id).sort();
    assert.deepEqual(tabs, [...registry.elements].filter((e) => /^nav\..*\.tab$/.test(e)).sort(), 'one tab item per pilot nav.*.tab');
    const gates = items.filter((x) => x.item.role === 'gate');
    assert.deepEqual(gates.map((x) => x.id).sort(), [...registry.gates].sort(), 'one gate item per pilot gate');
    for (const g of gates) assert.equal(g.item.gate?.native, true, `${g.where}: pilot gates are OS dialogs (native: true)`);
    assert.ok(items.some((x) => x.item.role === 'risk' && x.item.risk === 'a11y_hazard' && x.item.status === 'blocked'), 'expected one risk item {risk: a11y_hazard, status: blocked}');
  });
});

describe('swiftui fixtures', () => {
  fixtureSetSuite(SWIFTUI_SET);

  it('each screen file carries exactly one .appMapScreen( and RootView (a TabView) none (01 R3; issue #15)', () => {
    for (const name of SWIFTUI_SCREEN_FILES) {
      const file = join(SWIFTUI_SET, name);
      const count = code(readText(file)).split('.appMapScreen(').length - 1;
      assert.equal(count, 1, `${rel(file)}: expected exactly one .appMapScreen(, found ${count}`);
    }
    const root = join(SWIFTUI_SET, 'RootView.swift');
    assert.ok(!code(readText(root)).includes('appMapScreen('), `${rel(root)}: the TabView is never a screen; each tab child marks itself`);
  });

  it('the representable sets invoiceFilterButton on the wrapped UIKit control inside makeUIView, exactly once in the set (design §7.1)', () => {
    const constant = 'AppMapID.Element.invoiceFilterButton';
    const hits: string[] = [];
    for (const file of listFiles(SWIFTUI_SET, '.swift')) {
      const raw = readText(file);
      const text = code(raw);
      for (const m of text.matchAll(/AppMapID\.Element\.invoiceFilterButton\b/g)) {
        hits.push(`${rel(file)}:${lineOf(text, m.index ?? 0)}`);
        // design §7.1: the wrapper carries no id; the id goes on the UIButton in makeUIView
        assert.equal(basename(file), 'LegacyRepresentable.swift', `${hits[hits.length - 1]!}: ${constant} belongs in LegacyRepresentable.swift only`);
        assert.ok(methodBodies(structure(raw), 'makeUIView').some((b) => inside(b, m.index ?? 0)), `${hits[hits.length - 1]!}: ${constant} must be set inside makeUIView`);
      }
    }
    assert.equal(hits.length, 1, `${constant} must be set exactly once in the set, found: ${hits.join(', ') || 'none'}`);
  });
});

describe('uikit fixtures', () => {
  fixtureSetSuite(UIKIT_SET);

  it('every appMapScreen( call sits in a viewDidLoad or viewWillAppear body; InvoiceDetail marks in both (01 R3; design §2.3)', () => {
    let markers = 0;
    for (const file of listFiles(UIKIT_SET, '.swift')) {
      const raw = readText(file);
      const text = code(raw);
      const tree = structure(raw);
      const didLoad = methodBodies(tree, 'viewDidLoad');
      const willAppear = methodBodies(tree, 'viewWillAppear');
      const bodies = [...didLoad, ...willAppear];
      for (const m of text.matchAll(/\bappMapScreen\(/g)) {
        markers++;
        assert.ok(bodies.some((b) => inside(b, m.index ?? 0)), `${rel(file)}:${lineOf(text, m.index ?? 0)}: appMapScreen( outside viewDidLoad/viewWillAppear (never init: it loads the view early)`);
      }
      if (basename(file) === 'InvoiceDetailViewController.swift') {
        const marks = [...text.matchAll(/\bappMapScreen\(/g)].map((m) => m.index ?? 0);
        assert.ok(marks.some((i) => willAppear.some((b) => inside(b, i))), `${rel(file)}: the reused VC marks in viewWillAppear (identity is set after init)`);
        assert.ok(marks.some((i) => didLoad.some((b) => inside(b, i))), `${rel(file)}: and in viewDidLoad (appMapScreen is idempotent)`);
      }
    }
    assert.ok(markers >= 5, `${rel(UIKIT_SET)}: expected at least five appMapScreen( calls, found ${markers}`);
  });

  it('every dequeueReusableCell( / CellRegistration< block sets appMapID( on the cell (01 R4: dequeued cells are reused)', () => {
    let blocks = 0;
    for (const file of listFiles(UIKIT_SET, '.swift')) {
      const raw = readText(file);
      const text = code(raw);
      const tree = structure(raw);
      const pairs = braceBlocks(tree);
      for (const m of text.matchAll(/\bdequeueReusableCell\(/g)) {
        blocks++;
        const b = innermostBlock(pairs, m.index ?? 0);
        assert.ok(b !== undefined && text.slice(b.open, b.close).includes('appMapID('), `${rel(file)}:${lineOf(text, m.index ?? 0)}: the dequeue block sets no appMapID(`);
      }
      for (const m of text.matchAll(/\bCellRegistration</g)) {
        blocks++;
        const b = blockOpeningAfter(pairs, tree, m.index ?? 0);
        assert.ok(b !== undefined && text.slice(b.open, b.close).includes('appMapID('), `${rel(file)}:${lineOf(text, m.index ?? 0)}: the CellRegistration handler sets no appMapID(`);
      }
    }
    assert.ok(blocks >= 2, `${rel(UIKIT_SET)}: expected a table dequeue and a CellRegistration, found ${blocks} cell blocks`);
  });

  it('tab bar item ids are set at the assembly site, never in a child viewDidLoad (design §2.3: it runs only when the tab is first selected)', () => {
    let found = 0;
    for (const file of listFiles(UIKIT_SET, '.swift')) {
      const raw = readText(file);
      const text = code(raw);
      const didLoad = methodBodies(structure(raw), 'viewDidLoad');
      for (const m of text.matchAll(/\btabBarItem\s*\.\s*accessibilityIdentifier\b/g)) {
        found++;
        assert.ok(!didLoad.some((b) => inside(b, m.index ?? 0)), `${rel(file)}:${lineOf(text, m.index ?? 0)}: tabBarItem.accessibilityIdentifier inside viewDidLoad`);
      }
    }
    assert.ok(found >= 3, `${rel(UIKIT_SET)}: expected the three nav.*.tab assignments, found ${found}`);
  });

  it('InvoiceHostingBridge.swift never marks: a hosted SwiftUI screen is marked once, in SwiftUI (issue #15; §9 rule 5)', () => {
    const file = join(UIKIT_SET, 'InvoiceHostingBridge.swift');
    const text = code(readText(file));
    assert.ok(text.includes('UIHostingController'), `${rel(file)}: expected a UIHostingController subclass`);
    assert.ok(!text.includes('appMapScreen'), `${rel(file)}: a hosting controller never calls appMapScreen (double_marked)`);
  });
});

describe('lint teeth', () => {
  /** a scratch copy of the SwiftUI set under os.tmpdir(), never the repo (toolchain.md) */
  function withCopy(fn: (dir: string) => void): void {
    listFiles(SWIFTUI_SET, '.swift');
    const base = mkdtempSync(join(tmpdir(), 'app-map-instrument-'));
    try {
      const dir = join(base, 'swiftui');
      cpSync(SWIFTUI_SET, dir, { recursive: true });
      fn(dir);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
  const lintCopy = (dir: string): LintIdsResult => lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT, iosDirs: [dir], platforms: ['ios'], instrumentedPlatforms: ['ios'] });

  it('a marker "simplified" to the literal "screen.invoice_list" is a string_literal_id error (01 R8; issue #15)', () => {
    withCopy((dir) => {
      const file = join(dir, 'InvoiceListView.swift');
      const src = readText(file);
      assert.ok(src.includes('AppMapID.Screen.invoiceList'), `${rel(join(SWIFTUI_SET, 'InvoiceListView.swift'))}: no AppMapID.Screen.invoiceList to mutate`);
      writeFileSync(file, src.replaceAll('AppMapID.Screen.invoiceList', '"screen.invoice_list"'));
      const literal = errorsOf(lintCopy(dir)).filter((i) => i.rule === 'string_literal_id');
      assert.ok(literal.length >= 1, 'the literal marker must be a string_literal_id error');
      assert.ok(literal.some((i) => (i.file ?? '').endsWith('InvoiceListView.swift') && i.message.includes('screen.invoice_list')), JSON.stringify(literal));
    });
  });

  it('a screen whose marker constant is referenced nowhere is a marker_unreferenced error (01 R8; --instrumented ios)', () => {
    // The raw marker string also counts as a reference to lint-ids, so a literal alone cannot
    // show this rule: the constant is swapped for another screen's in every file of the copy.
    withCopy((dir) => {
      let swapped = 0;
      for (const file of listFiles(dir, '.swift')) {
        const src = readFileSync(file, 'utf8');
        if (!src.includes('AppMapID.Screen.invoiceList')) continue;
        swapped++;
        writeFileSync(file, src.replaceAll('AppMapID.Screen.invoiceList', 'AppMapID.Screen.invoiceNew'));
      }
      assert.ok(swapped >= 1, `${rel(SWIFTUI_SET)}: no file references AppMapID.Screen.invoiceList`);
      const unreferenced = errorsOf(lintCopy(dir)).filter((i) => i.rule === 'marker_unreferenced');
      const screens = unreferenced.map((i) => /screen "([a-z0-9_]+)"/.exec(i.message)?.[1]).sort();
      assert.deepEqual(screens, ['invoice_list'], JSON.stringify(unreferenced));
    });
  });
});

describe('docs', () => {
  it('05 §5.1 quotes each agent\'s `tools:` line verbatim, so spec and file cannot drift (verbs.test.ts precedent; issue #21)', () => {
    const text = section(SPEC_05, /^#{2,4}\s*5\.1\b/);
    for (const name of AGENTS) assert.ok(text.includes(toolsLine(name)), `${rel(SPEC_05)} §5.1 does not quote the current tools: line of ${name}`);
  });

  it('harness-notes §2 records that Bash cannot be scoped per command (design §8; §10.11)', () => {
    const text = section(HARNESS_NOTES, /^## 2\./);
    assert.match(text, /Bash[^\n]*cannot be scoped per command/, `${rel(HARNESS_NOTES)} §2 must say Bash … cannot be scoped per command`);
  });

  it('README.md "Repository layout" row for .claude/ names app-instrument (design §8)', () => {
    const row = readText(README).split('\n').find((l) => /^\|\s*`\.claude\/`\s*\|/.test(l));
    assert.ok(row !== undefined, `${rel(README)}: no layout row for \`.claude/\``);
    assert.ok(row.includes('app-instrument'), `${rel(README)}: the .claude/ row does not mention app-instrument`);
  });

  it('instrumentation/README.md has a §11 for letting the agents do §2–§8 (design §8)', () => {
    assert.match(readText(INSTRUMENTATION_README), /^## 11\./m, `${rel(INSTRUMENTATION_README)}: no "## 11." heading`);
  });

  it('CLAUDE.md summarises the app-instrument skill (design §8)', () => {
    assert.ok(readText(CLAUDE_MD).includes('app-instrument'), `${rel(CLAUDE_MD)} does not mention app-instrument`);
  });
});
