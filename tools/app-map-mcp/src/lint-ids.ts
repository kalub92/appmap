/**
 * [D2] `app-map lint-ids` (01 R8; 06 R2). Runs in CI and pre-commit.
 *
 * Rules (each produces `LintIdsResult.issues[].rule`; `severity: 'error'` unless noted):
 *  - `marker_unreferenced`: a screen in `ids.yaml` whose marker constant (`AppMapID.Screen.<lowerCamel>`
 *    / `AppMapId.Screen.<UPPER_SNAKE>`, naming as in scripts/app-map/gen-ids) is not referenced
 *    in a platform's source tree — reported PER PLATFORM (`platform: ios|android`, 01 R8 "in iOS
 *    and Android source"); `opts.platforms` scopes the check to the instrumented platforms
 *    (Stage 0 is iOS-only, 08 §6) and a platform whose source dirs do not exist is skipped. A
 *    platform whose sources reference NO marker is reported as one `warning` ("not instrumented
 *    yet") unless it is listed in `opts.instrumentedPlatforms`
 *    (`APP_MAP_INSTRUMENTED_PLATFORMS` / `--instrumented`), in which case every screen is an
 *    error — the rule must never disable itself by counting;
 *  - `bad_id`: any id in `ids.yaml` violating 01 R2 (`SCREEN_ID_REGEX`, `GATE_ID_REGEX`,
 *    `GATE_DISMISS_REGEX`, `ELEMENT_ID_REGEX` for `elements[]`) — error. The last segment is NOT
 *    required to equal the registry `kind` (01 R1's example is `invoice.list.table` with
 *    `kind: list`; the pilot has `table`/`collection` lists): a last segment that is neither the
 *    kind nor a known synonym (`KIND_SYNONYMS`) is a `warning` only. `lint-ids` MUST pass on
 *    the committed pilot ids.yaml (06 R2) — lint-ids.test.ts asserts it;
 *  - `orphan_constant`: a constant in the generated files with no `ids.yaml` entry;
 *  - `string_literal_id`: a string literal in UI code matching `ID_REGEX` with a `screen.`,
 *    `gate.` or registered-element prefix (`"invoice.save.button"`) outside the generated files,
 *    tests and `app-map/` — app code must use the constants;
 *  - `generated_out_of_sync`: generated constants differ from `ids.yaml` (delegates to
 *    `scripts/app-map/gen-ids --check` when present, else compares names).
 * Source roots default to `instrumentation/ios`, `instrumentation/android` plus any `--src`
 * globs; only `*.swift`, `*.kt`, `*.java`, `*.m` are scanned.
 *
 * Layer: top (imports config, paths, yaml/load, types).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AppMapConfig, Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import type { ElementKind, IdsElement, IdsGate, IdsRegistry, IdsScreen, LintIdsResult } from './types.ts';
import { ELEMENT_ID_REGEX, GATE_DISMISS_REGEX, GATE_ID_REGEX, ID_REGEX, SCREEN_ID_REGEX, markerOfScreen } from './types.ts';
import { idsFile, stringsFile } from './paths.ts';
import { parseYamlFile } from './yaml/load.ts';

export interface LintIdsOptions {
  repoRoot: string;
  /** platforms whose source trees must reference every marker (default: both; `--platform ios`) */
  platforms?: Platform[];
  /**
   * Platforms whose app source lives in THIS repo (`APP_MAP_INSTRUMENTED_PLATFORMS`, or
   * `--instrumented ios`). For an instrumented platform a source tree that references no marker
   * at all is an error like any other — the implicit "0 of N referenced ⇒ not instrumented"
   * shortcut is what let a refactor that deleted every reference turn the rule off silently.
   * Left unset, such a platform produces one `warning` naming the state instead (08 §6 Stage 0:
   * the pilot app is not in this repo).
   */
  instrumentedPlatforms?: Platform[];
  /** directories scanned for Swift/ObjC (default `instrumentation/ios`, `ios`) */
  iosDirs?: string[];
  /** directories scanned for Kotlin/Java (default `instrumentation/android`, `android`) */
  androidDirs?: string[];
  /** generated constant files (defaults as in scripts/app-map/gen-ids) */
  generated?: { swift: string; kotlin: string };
  /** path to scripts/app-map/gen-ids (default `<repoRoot>/scripts/app-map/gen-ids`) */
  genIdsScript?: string;
}

/** kind-segment synonyms accepted without a warning (01 R2 names the kind vocabulary, not the segment spelling) */
export const KIND_SYNONYMS: Readonly<Record<ElementKind, readonly string[]>> = {
  button: ['button', 'btn'], field: ['field', 'input', 'textfield'], list: ['list', 'table', 'collection', 'grid'],
  cell: ['cell', 'row', 'item'], toggle: ['toggle', 'switch', 'checkbox'], tab: ['tab'], picker: ['picker', 'select', 'dropdown'],
  link: ['link'], text: ['text', 'label', 'title'], sheet: ['sheet', 'modal', 'dialog'],
};

/** default Swift/ObjC source roots, relative to `opts.repoRoot` (the CLI extends them with `--src`) */
export const DEFAULT_IOS_DIRS: readonly string[] = ['instrumentation/ios', 'ios'];
/** default Kotlin/Java source roots, relative to `opts.repoRoot` */
export const DEFAULT_ANDROID_DIRS: readonly string[] = ['instrumentation/android', 'android'];
const DEFAULT_GENERATED = {
  swift: 'instrumentation/ios/AppMapKit/Sources/AppMapKit/AppMapID.swift',
  kotlin: 'instrumentation/android/appmap/src/main/kotlin/com/example/appmap/AppMapId.kt',
} as const;
const IOS_EXTENSIONS = new Set(['.swift', '.m']);
const ANDROID_EXTENSIONS = new Set(['.kt', '.java']);
/** never descended into: build output, vendored code, the map itself (module doc: "outside … `app-map/`") */
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'DerivedData', '.gradle', 'app-map', 'Pods', '.build']);
/** Swift keywords gen-ids wraps in backticks; mirrored so the generated name matches character for character */
const SWIFT_KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'fileprivate', 'func', 'import', 'init', 'inout',
  'internal', 'let', 'open', 'operator', 'private', 'precedencegroup', 'protocol', 'public', 'rethrows', 'static',
  'struct', 'subscript', 'typealias', 'var', 'break', 'case', 'catch', 'continue', 'default', 'defer', 'do', 'else',
  'fallthrough', 'for', 'guard', 'if', 'in', 'repeat', 'return', 'throw', 'switch', 'where', 'while', 'as', 'any',
  'false', 'is', 'nil', 'self', 'super', 'throws', 'true', 'try',
]);

interface ScannedSource {
  /** path relative to repoRoot (forward slashes) */
  rel: string;
  /** source with comments blanked out — a marker named only in a doc comment is not a reference */
  code: string;
  strings: Array<{ value: string; line: number }>;
}

export function lintIds(config: Pick<AppMapConfig, 'dir'>, opts: LintIdsOptions): LintIdsResult {
  const issues: LintIdsResult['issues'] = [];
  // Parsed WITHOUT the schema (`readIds` would throw `invalid_map` first): `bad_id` is lint-ids'
  // own 01 R2 rule and must be reported as an issue, not raised as an error (01 R8).
  const ids = readRegistryLeniently(config);
  const repoRoot = resolve(opts.repoRoot);

  // ---- 01 R2: every id matches its regex (bad_id) -----------------------------------------
  const registered = new Set<string>();
  for (const s of ids.screens ?? []) {
    const marker = markerOfScreen(s.id);
    if (!SCREEN_ID_REGEX.test(s.id)) issues.push(err('bad_id', `screen id "${s.id}" must be snake_case (${SCREEN_ID_REGEX.source}) — 01 R2`));
    else registered.add(marker);
  }
  for (const g of ids.gates ?? []) {
    if (!GATE_ID_REGEX.test(g.id)) issues.push(err('bad_id', `gate id "${g.id}" must be gate.<name> (${GATE_ID_REGEX.source}) — 01 R2`));
    else registered.add(g.id);
    if (typeof g.dismiss === 'string') {
      if (!GATE_DISMISS_REGEX.test(g.dismiss) || !g.dismiss.startsWith(`${g.id}.`)) {
        issues.push(err('bad_id', `gate "${g.id}" dismiss "${g.dismiss}" must be "${g.id}.<verb>" — 01 R2`));
      } else registered.add(g.dismiss);
    }
  }
  // 01 R2: "Ids MUST NOT contain copy text or localized strings." The regex only fixes the SHAPE,
  // so `invoice.save_invoice_button_en.button` passes it while being exactly what R2 forbids.
  const copy = copyVocabulary(config);
  const idContent = (id: string, what: string): void => {
    for (const reason of copyLikeSegments(id, copy)) {
      issues.push({ rule: 'bad_id', severity: 'warning', message: `${what} "${id}": ${reason} — ids carry structure, never copy or localized strings (01 R2)` });
    }
  };
  for (const s of ids.screens ?? []) if (SCREEN_ID_REGEX.test(s.id)) idContent(s.id, 'screen id');
  for (const g of ids.gates ?? []) if (GATE_ID_REGEX.test(g.id)) idContent(g.id, 'gate id');

  for (const e of ids.elements ?? []) {
    if (!ELEMENT_ID_REGEX.test(e.id)) {
      issues.push(err('bad_id', `element id "${e.id}" must be <feature>.<name>.<kind> (${ELEMENT_ID_REGEX.source}) — 01 R2`));
      continue;
    }
    registered.add(e.id);
    idContent(e.id, 'element id');
    // architecture decision 38: the last segment need not equal the registry kind (01 R1's own
    // example is `invoice.list.table` with `kind: list`), so a non-synonym is a warning only.
    const last = e.id.slice(e.id.lastIndexOf('.') + 1);
    const synonyms = KIND_SYNONYMS[e.kind];
    if (synonyms !== undefined && !synonyms.includes(last)) {
      issues.push({ rule: 'bad_id', severity: 'warning', message: `element "${e.id}" ends in "${last}" but its kind is "${e.kind}" (01 R2 convention; not an error — decision 38)` });
    }
  }

  // ---- source scan -------------------------------------------------------------------------
  const generated = {
    swift: absolutize(repoRoot, opts.generated?.swift ?? DEFAULT_GENERATED.swift),
    kotlin: absolutize(repoRoot, opts.generated?.kotlin ?? DEFAULT_GENERATED.kotlin),
  };
  const generatedPaths = new Set([generated.swift, generated.kotlin]);
  const platforms = opts.platforms ?? [...PLATFORMS];
  const dirsFor = (p: Platform): string[] => (p === 'ios' ? opts.iosDirs ?? [...DEFAULT_IOS_DIRS] : opts.androidDirs ?? [...DEFAULT_ANDROID_DIRS]);
  const extsFor = (p: Platform): ReadonlySet<string> => (p === 'ios' ? IOS_EXTENSIONS : ANDROID_EXTENSIONS);

  const instrumented = new Set<Platform>(opts.instrumentedPlatforms ?? []);

  const sources = new Map<Platform, ScannedSource[]>();
  for (const platform of platforms) {
    const files = collectFiles(repoRoot, dirsFor(platform), extsFor(platform), generatedPaths);
    sources.set(platform, files.map((abs) => scanSource(repoRoot, abs)));
  }

  // ---- 01 R8: no string-literal ids in UI code (string_literal_id) --------------------------
  const knownPrefixes = idPrefixes(registered);
  for (const platform of platforms) {
    for (const file of sources.get(platform) ?? []) {
      for (const hit of literalIdsIn(file.strings, knownPrefixes)) {
        issues.push({ rule: 'string_literal_id', severity: 'error', platform, file: file.rel, line: hit.line, message: `"${hit.id}" is a string-literal id; use the generated constant (01 R8)` });
      }
    }
  }

  // ---- 01 R8: every screen marker referenced, per platform (marker_unreferenced) ------------
  for (const platform of platforms) {
    const files = sources.get(platform) ?? [];
    if (files.length === 0) continue; // no source tree for this platform → skipped (module doc)
    const screens = (ids.screens ?? []).filter((s) => SCREEN_ID_REGEX.test(s.id));
    const unreferenced = screens.filter((s) => !markerReferenced(files, s.id, platform));
    // A platform whose sources reference NO marker at all is either (a) not instrumented yet —
    // 08 §6 Stage 0, the app source is not in this repo — or (b) an instrumented app someone just
    // stripped every constant out of, which is the exact regression 01 R8 exists to catch. The
    // two are only distinguishable by declaration, never by counting, so say which one it is.
    if (screens.length > 0 && unreferenced.length === screens.length && !instrumented.has(platform)) {
      issues.push({
        rule: 'marker_unreferenced', severity: 'warning', platform,
        message: `no ${platform} marker constant is referenced in ${dirsFor(platform).join(', ')} — treating ${platform} as not instrumented yet (08 §6). Set APP_MAP_INSTRUMENTED_PLATFORMS=${platform} (or --instrumented ${platform}) to make this an error`,
      });
      continue;
    }
    for (const s of unreferenced) {
      const name = constantNames(markerOfScreen(s.id))[platform === 'ios' ? 'swift' : 'kotlin'];
      const holder = platform === 'ios' ? `AppMapID.Screen.${name}` : `AppMapId.Screen.${name}`;
      issues.push({ rule: 'marker_unreferenced', severity: 'error', platform, message: `screen "${s.id}": ${holder} is never referenced in the ${platform} source (01 R8)` });
    }
  }

  // ---- 01 R8: generated constants ----------------------------------------------------------
  const generatedFiles: Array<{ path: string; platform: Platform }> = [
    { path: generated.swift, platform: 'ios' },
    { path: generated.kotlin, platform: 'android' },
  ].filter((g) => existsSync(g.path)) as Array<{ path: string; platform: Platform }>;

  for (const g of generatedFiles) {
    const scanned = scanSource(repoRoot, g.path);
    for (const s of scanned.strings) {
      if (!ID_REGEX.test(s.value) || registered.has(s.value)) continue;
      issues.push({ rule: 'orphan_constant', severity: 'error', platform: g.platform, file: scanned.rel, line: s.line, message: `constant "${s.value}" has no ids.yaml entry (01 R8); rerun scripts/app-map/gen-ids` });
    }
  }

  if (generatedFiles.length > 0) {
    const sync = checkGeneratedInSync(repoRoot, config, opts, generated, registered, generatedFiles);
    issues.push(...sync);
  }

  return { ok: issues.every((i) => i.severity !== 'error'), issues };
}

// ---------------------------------------------------------------------------------------------
// 01 R2 id content ("no copy text or localized strings")
// ---------------------------------------------------------------------------------------------

/**
 * A locale suffix on an id segment (`save_button_en`, `title_pt_BR`): the giveaway that an id was
 * generated from a localized resource name.
 */
// `id` (Indonesian) and `no` (Norwegian) are deliberately absent: in an element id a trailing
// `_id`/`_no` is almost always "identifier"/"number", so including them flags real ids
// (`invoice.client_id.field`) as localized copy.
const LOCALE_SUFFIX = /_(?:aa|ab|af|ar|az|be|bg|bn|bs|ca|cs|cy|da|de|el|en|es|et|eu|fa|fi|fr|ga|gl|he|hi|hr|hu|hy|is|it|iw|ja|ka|kk|km|ko|lt|lv|mk|ml|mn|ms|mt|nb|ne|nl|nn|pa|pl|pt|ro|ru|si|sk|sl|sq|sr|sv|sw|ta|te|th|tl|tr|uk|ur|uz|vi|zh)(?:_[a-z]{2})?$/;

/** lowercased app copy from `.local/strings.<platform>.txt` for both platforms (07 §2.3.3) */
function copyVocabulary(config: Pick<AppMapConfig, 'dir'>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const platform of PLATFORMS) {
    const file = stringsFile({ ...config, platform }, platform);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const normalized = normalizeCopy(line);
      // one- and two-character strings ("OK", "9:41") are not distinctive enough to accuse an id
      if (normalized.length > 2) out.add(normalized);
    }
  }
  return out;
}

/** lowercase, `_`/punctuation → single spaces, trimmed — the form ids and copy are compared in */
function normalizeCopy(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pure: the 01 R2 content problems of one id, as reasons; empty when the id is structural. */
export function copyLikeSegments(id: string, copy: ReadonlySet<string>): string[] {
  const reasons: string[] = [];
  const segments = id.split('.');
  for (const segment of segments) {
    const locale = LOCALE_SUFFIX.exec(segment);
    if (locale !== null) reasons.push(`segment "${segment}" ends in the locale suffix "${locale[0]}"`);
  }
  if (copy.size > 0) {
    // Only MULTI-WORD matches accuse an id: a single structural word (`client`, `cancel`,
    // `settings`) is ordinary vocabulary that happens to be a button label too, whereas
    // `new_invoice` reading exactly "New Invoice" is a label that was pasted into an id.
    const candidates = new Map<string, string>();
    for (const segment of segments) candidates.set(normalizeCopy(segment), `segment "${segment}"`);
    candidates.set(normalizeCopy(segments.slice(1).join(' ')), 'the id');
    candidates.set(normalizeCopy(id), 'the id');
    for (const [normalized, what] of candidates) {
      if (normalized.includes(' ') && copy.has(normalized)) reasons.push(`${what} is verbatim app copy in the static string table`);
    }
  }
  return reasons;
}

/**
 * `ids.yaml` parsed for linting: the YAML must parse (a syntax error is an `AppMapError` from
 * `parseYamlFile`), but no schema is applied, and entries of the wrong shape are dropped —
 * `app-map validate` is the schema gate (02 §10 rule 1).
 */
function readRegistryLeniently(config: Pick<AppMapConfig, 'dir'>): IdsRegistry {
  const doc = parseYamlFile<Partial<IdsRegistry> | null>(idsFile(config));
  const screens = (Array.isArray(doc?.screens) ? doc.screens : []).filter((s): s is IdsScreen => typeof (s as IdsScreen | null)?.id === 'string');
  const gates = (Array.isArray(doc?.gates) ? doc.gates : []).filter((g): g is IdsGate => typeof (g as IdsGate | null)?.id === 'string');
  const elements = (Array.isArray(doc?.elements) ? doc.elements : []).filter((e): e is IdsElement => typeof (e as IdsElement | null)?.id === 'string');
  return { schema_version: 1, screens, gates, elements };
}

function err(rule: LintIdsResult['issues'][number]['rule'], message: string): LintIdsResult['issues'][number] {
  return { rule, severity: 'error', message };
}

/**
 * `generated_out_of_sync` — delegate to `scripts/app-map/gen-ids --check` when it is present
 * (06 R2 runs the same script), else compare the ids declared by the generated files with the
 * registry.
 */
function checkGeneratedInSync(
  repoRoot: string,
  config: Pick<AppMapConfig, 'dir'>,
  opts: LintIdsOptions,
  generated: { swift: string; kotlin: string },
  registered: ReadonlySet<string>,
  generatedFiles: ReadonlyArray<{ path: string; platform: Platform }>,
): LintIdsResult['issues'] {
  const script = absolutize(repoRoot, opts.genIdsScript ?? join('scripts', 'app-map', 'gen-ids'));
  if (existsSync(script) && generatedFiles.length === 2) {
    const r = spawnSync(process.execPath, [script, '--check', '--quiet', '--ids', join(config.dir, 'ids.yaml'), '--out-ios', generated.swift, '--out-android', generated.kotlin], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    if (r.error !== undefined) {
      return [err('generated_out_of_sync', `could not run ${script}: ${r.error.message}`)];
    }
    if (r.status !== 0) {
      const detail = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n').slice(0, 20).join('\n');
      return [{ rule: 'generated_out_of_sync', severity: 'error', file: relOf(repoRoot, script), message: `gen-ids --check failed (06 R2):\n${detail}` }];
    }
    return [];
  }
  // fallback: the generated files must declare exactly the registered ids
  const issues: LintIdsResult['issues'] = [];
  for (const g of generatedFiles) {
    const declared = new Set(scanSource(repoRoot, g.path).strings.map((s) => s.value).filter((v) => ID_REGEX.test(v)));
    const missing = [...registered].filter((id) => !declared.has(id)).sort();
    if (missing.length > 0) {
      issues.push({ rule: 'generated_out_of_sync', severity: 'error', platform: g.platform, file: relOf(repoRoot, g.path), message: `generated constants are missing ${missing.length} id(s): ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''} — rerun scripts/app-map/gen-ids (06 R2)` });
    }
  }
  return issues;
}

/** Pure: constant names as gen-ids derives them (`invoice.save.button` → `invoiceSaveButton` / `INVOICE_SAVE_BUTTON`). */
export function constantNames(id: string): { swift: string; kotlin: string } {
  // gen-ids strips the `screen.`/`gate.` namespace prefix (the enum case already carries it)
  const base = id.startsWith('screen.') ? id.slice('screen.'.length) : id.startsWith('gate.') ? id.slice('gate.'.length) : id;
  const parts = base.split(/[._]/).filter((p) => p.length > 0);
  let swift = parts.map((p, i) => (i === 0 ? p : `${p.charAt(0).toUpperCase()}${p.slice(1)}`)).join('');
  if (/^[0-9]/.test(swift)) swift = `_${swift}`;
  if (SWIFT_KEYWORDS.has(swift)) swift = `\`${swift}\``;
  let kotlin = parts.join('_').toUpperCase();
  if (/^[0-9]/.test(kotlin)) kotlin = `_${kotlin}`;
  return { swift, kotlin };
}

/** Pure: string literals in a source text that look like registry ids (rule `string_literal_id`), with line numbers. */
export function findStringLiteralIds(source: string, knownPrefixes: ReadonlySet<string>): Array<{ id: string; line: number }> {
  return literalIdsIn(tokenize(source).strings, knownPrefixes);
}

function literalIdsIn(strings: ReadonlyArray<{ value: string; line: number }>, knownPrefixes: ReadonlySet<string>): Array<{ id: string; line: number }> {
  const prefixes = [...knownPrefixes];
  return strings
    .filter((s) => ID_REGEX.test(s.value) && prefixes.some((p) => s.value.startsWith(p)))
    .map((s) => ({ id: s.value, line: s.line }));
}

/** `screen.`, `gate.` and every registered element's feature prefix (`invoice.`, `nav.`, …) */
function idPrefixes(registered: ReadonlySet<string>): Set<string> {
  const out = new Set<string>(['screen.', 'gate.']);
  for (const id of registered) {
    if (id.startsWith('screen.') || id.startsWith('gate.')) continue;
    const dot = id.indexOf('.');
    if (dot > 0) out.add(id.slice(0, dot + 1));
  }
  return out;
}

/**
 * Is the screen's marker constant referenced by this platform's code? A reference is the
 * qualified constant (`AppMapID.Screen.invoiceList` / `AppMapId.Screen.INVOICE_LIST`) or the raw
 * marker string; comments are not references (the library's doc comments name the constants).
 */
function markerReferenced(files: readonly ScannedSource[], screenId: string, platform: Platform): boolean {
  const marker = markerOfScreen(screenId);
  const name = constantNames(marker)[platform === 'ios' ? 'swift' : 'kotlin'];
  const qualified = new RegExp(`(^|[^A-Za-z0-9_$])Screen\\s*\\.\\s*${escapeRegExp(name)}(?![A-Za-z0-9_])`);
  return files.some((f) => qualified.test(f.code) || f.strings.some((s) => s.value === marker));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------------------------
// Source collection and tokenization
// ---------------------------------------------------------------------------------------------

function absolutize(repoRoot: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(repoRoot, p);
}

function relOf(repoRoot: string, abs: string): string {
  const r = relative(repoRoot, abs);
  return (r.startsWith('..') ? abs : r).split('\\').join('/');
}

/** every `*.swift|kt|java|m` under `dirs`, minus generated constants and test sources */
function collectFiles(repoRoot: string, dirs: readonly string[], extensions: ReadonlySet<string>, generated: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name) || isTestSegment(entry.name)) continue;
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.has(extname(entry.name).toLowerCase())) continue;
      if (generated.has(resolve(abs))) continue; // the generated file declares ids; it never references them
      if (isTestFile(entry.name)) continue;
      out.push(resolve(abs));
    }
  };
  for (const dir of dirs) {
    const abs = absolutize(repoRoot, dir);
    try {
      if (!statSync(abs).isDirectory()) continue;
    } catch {
      continue; // "a platform whose source dirs do not exist is skipped"
    }
    walk(abs);
  }
  return [...new Set(out)].sort();
}

function isTestSegment(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'test' || n === 'tests' || n === 'androidtest' || n === '__tests__' || n === 'testing';
}

function isTestFile(name: string): boolean {
  const stem = basename(name, extname(name));
  return /(^|[^A-Za-z])([Tt]ests?|[Ss]pec)$/.test(stem);
}

function scanSource(repoRoot: string, abs: string): ScannedSource {
  let text = '';
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    text = '';
  }
  const { code, strings } = tokenize(text);
  return { rel: relOf(repoRoot, abs), code, strings };
}

/**
 * One pass over Swift/Kotlin/Java/ObjC source: blank out `//` and block comments (keeping line
 * breaks so line numbers survive) and collect every string literal with its line. Kotlin raw
 * strings (`"""…"""`) are collected whole.
 */
function tokenize(source: string): { code: string; strings: Array<{ value: string; line: number }> } {
  const strings: Array<{ value: string; line: number }> = [];
  let code = '';
  let line = 1;
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && source[i] !== '\n') { code += ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      code += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { code += '\n'; line++; } else code += ' ';
        i++;
      }
      if (i < n) { code += '  '; i += 2; }
      continue;
    }
    if (c === '"' && source.startsWith('"""', i)) {
      const start = i + 3;
      const end = source.indexOf('"""', start);
      const stop = end < 0 ? n : end;
      const value = source.slice(start, stop);
      strings.push({ value, line });
      const consumed = source.slice(i, end < 0 ? n : end + 3);
      for (const ch of consumed) { code += ch === '\n' ? '\n' : ' '; if (ch === '\n') line++; }
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (c === '"') {
      let value = '';
      let j = i + 1;
      code += ' ';
      while (j < n) {
        const cj = source[j]!;
        if (cj === '\\' && j + 1 < n) { value += source[j + 1]!; code += '  '; j += 2; continue; }
        if (cj === '"') { code += ' '; j++; break; }
        if (cj === '\n') break; // unterminated literal; give up on this one
        value += cj;
        code += ' ';
        j++;
      }
      strings.push({ value, line });
      i = j;
      continue;
    }
    if (c === '\n') line++;
    code += c;
    i++;
  }
  return { code, strings };
}
