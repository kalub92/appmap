/**
 * [C2] Guided replay state machine (04 §5, 03 §8 `run_recipe` mode guided + `report_step`,
 * 07 §3 execution policy). State lives in the db (`runs`, `run_steps`) so `report_step` works
 * across separate tool calls, server restarts and a fresh `openContext` between calls.
 *
 * `startGuidedRun`:
 *  1. recipe must exist, be non-retired and match the platform (`recipe_unavailable`);
 *  2. required params present (`bad_input` listing the missing names);
 *  3. `opts.probe(config, app_id)` (07 §3): `build_type !== 'debug'` or `sandbox !== true` or
 *     probe `null` (endpoint absent = Release) → `release_build_refused`. A successful probe is
 *     cached with `ctx.setProbe(probe)` so identification can evaluate variants
 *     (`probeConditions`, 02 §4.3). Tests inject a fake probe; the default probe tries, in order
 *     (iOS): `xcrun simctl spawn <udid|booted> defaults export <app_id> - | plutil -convert json
 *     -o - -`, then — because iOS 26's `defaults` no longer resolves a sandboxed app's domain
 *     through `cfprefsd` and prints `{}` — the same record straight out of the app's data
 *     container (`simctl get_app_container … data` + `plutil -convert xml1`, read by
 *     `parseXmlPlist` so a `Data` value elsewhere in the domain cannot hide the probe);
 *     Android (best-effort): `adb shell run-as <app_id> cat files/app_map_debug_probe.json`.
 *     Every strategy reads the app's OWN record, so a Release build still comes back `null`;
 *  4. session: `input.session` ?? the newest observation's session; none → `no_observation`
 *     (a run needs a session to verify against, 03 §2 — many instances share the cache);
 *     `start_seq = last_seq = db.getSession(session)?.last_seq ?? 0`;
 *  5. expand steps: `s0` = `open_link entry.deep_link` with `expect {screen: <first step's
 *     screen>}` when the recipe has a deep link, else the `fallback_path` as a series of edge
 *     taps (plan.shortestEdgePath) numbered `s0a…` (RUN_STEP_ID_REGEX); then the recipe steps;
 *  6. insert the `RunRecord` (`state: active`, `current_step: s0`), return `{run_id, step}` where
 *     `step` is `toRunStep(s0)` (≤120 tokens; `announce: true` on intent_critical steps when the
 *     recipe is `candidate`, 07 §3).
 *
 * `reportStep(run_id, step_id, ok, note?, snapshot?)` — the server never trusts `ok` alone:
 *  1. run must be `active` and `step_id === current_step` (`run_not_active` / `bad_input`);
 *  2. observation = newest of `db.listObservations(run.session, {fromSeq: run.last_seq + 1})`
 *     (or `snapshot` normalized + scrubbed when supplied); none → fallback `no_observation`;
 *     `run.last_seq` advances to its seq;
 *  3. gates: if `identify.gates_present` is non-empty and the gate is not what the step expects →
 *     `{status:'gate', step: dismiss_gate <gate>, retry: step_id}`; at most
 *     `GUIDED_LIMITS.gate_dismissals_per_step` per step, then fallback `gate_limit`;
 *  4. verify `expect` (`checkExpect`): `screen` via identify, `focused`/`visible`/`not_visible`
 *     via resolve on the scrubbed tree, `text_present` via labelOf equality; a step without
 *     `expect` inherits "screen unchanged";
 *     4a. if `run.pending_heal` is set for this step: `expect` held → `heal.applyHeal(ctx,
 *     {pending, recipe})` (element written, `heals[]` gets the summary, `pending_heal` cleared);
 *     `expect` failed → `heal.rejectHeal(…, 'postcondition_failed', …)` and fallback
 *     `heal_rejected` (04 §7.2 rule 3);
 *     4b. on `ok` for a step with `expect.screen` or a marker hit whose `required_ids` are all
 *     present → `lifecycle.markVerified(ctx, {screens:[screen], elements:[…step element…],
 *     edges:[…]})` (02 §8 lazy re-verify);
 *  5. ok → advance: if no more steps, check recipe `verify` → `{status:'done', verified, heals}`,
 *     `lifecycle.markVerified(ctx, {recipe})` when verified and `lifecycle.recordRunOutcome`;
 *     else resolve the next step's element against the observation (resolve.ts):
 *     hit → `{status:'ok', step}`; degraded/miss → `heal.proposeHeal` at most
 *     `GUIDED_LIMITS.heals_per_step` per step: candidate → hand it out as the step target
 *     (`RunStep.target` from `candidate.proposed_locator`, `RunStep.healing: true`), persist
 *     `run.pending_heal = heal.toPendingHeal(...)`, return `{status:'ok', step}` — the
 *     `healed` summary is only reported on the following call once 4a accepted it; rejected →
 *     `heal.rejectHeal` + `{status:'fallback'}` with `reason` `heal_rejected` (or
 *     `intent_critical_label_changed`), `screen_seen`, top-3 candidates;
 *  6. expect failed → `{status:'fallback', reason:'expect_failed'}`; the run is marked
 *     `fallback`, a `recipe_run` event with `fallbacks: 1` is logged (04 §5 "guided_fallback"),
 *     and the trajectory from this seq is compilable into a revision (compile `from_seq`).
 *
 * Layer: session (imports context, types, observe, identify, resolve, heal, plan, format,
 * lifecycle, events).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AppMapConfig } from '../config.ts';
import type { AppMapContext } from '../context.ts';
import type {
  AnyTree, BuildProbeResult, EdgeAction, ElementDef, ElementId, Expect, FallbackPayload, FallbackReason, GateId,
  HealCandidate, HealInput, HealSummary, IdentifySignalKind, LoadedMap, Locator, Observation, RecipeFile, RecipeParams, RecipeStep,
  ReportStepInput, ReportStepResult, RunRecipeResult, RunRecord, RunStep, ScreenId, SessionId, StepId, TreeNode,
} from '../types.ts';
import { CANONICAL_DEEP_LINK_SCHEME, DEEP_LINK_SCHEME_REGEX, GUIDED_LIMITS, UNKNOWN_SCREEN, emitDeepLink, now, probeConditions, routeKey, selectTarget } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { identify } from '../identify.ts';
import { gateDialogRoot, resolve as resolveElement } from '../resolve.ts';
import { labelOf, walk } from '../tree.ts';
import { shortestEdgePath } from '../plan.ts';
import { indexMap } from '../yaml/load.ts';
import { finishTask, recordObservation } from '../observe.ts';
import { applyHeal, proposeHeal, rejectHeal, toPendingHeal } from '../heal.ts';
import { markVerified, recordRunOutcome } from './lifecycle.ts';
import { substituteParams, valueChecksOfExpect } from './values.ts';
import type { SettleOptions } from '../settle.ts';
import { settleFor } from '../settle.ts';

/** Injectable build/environment probe (07 §3). `null` = endpoint absent (treated as Release). */
export type BuildInfoProbe = (config: AppMapConfig, appId: string) => Promise<BuildProbeResult | null>;

export interface StartGuidedRunInput {
  recipe_id: string;
  params: RecipeParams;
  /** defaults to the newest observation's session (see module doc, step 4) */
  session?: SessionId;
}
export interface GuidedRunOptions {
  probe?: BuildInfoProbe;
  /** issue #25 deep-link scheme collision probe (default: `defaultSchemeOwnerProbe`) */
  schemeOwners?: SchemeOwnerProbe;
  /** skip the 07 §3 probe entirely (tests of the state machine only) */
  skipBuildCheck?: boolean;
  now?: () => Date;
  /** run id generator (default: `run_<timestamp>_<random>`) */
  runId?: () => string;
}

/** entry steps are `s0` (deep link) or `s0a`, `s0b`, … (fallback path) — architecture §7 decision 17 */
const ENTRY_STEP_ID = 's0';
const ENTRY_SUFFIXES = 'abcdefghijklmnopqrstuvwxyz';
/** ≤3 heal candidates travel with a fallback (04 §7.2) */
const FALLBACK_CANDIDATES_MAX = 3;

// ---------------------------------------------------------------------------------------------
// map / element helpers
// ---------------------------------------------------------------------------------------------

/**
 * The map as this session knows it: the cache first, so an element healed earlier in the run (or
 * a screen named by `name_screen`) is resolved with its new locators. `indexMap` is pure.
 */
function sessionMap(ctx: AppMapContext): LoadedMap {
  const screens = ctx.db.listScreens();
  if (screens.length === 0) return ctx.map;
  return indexMap({
    platform: ctx.map.platform, manifest: ctx.map.manifest, ids: ctx.map.ids, screens,
    recipes: ctx.db.listRecipes(), staticStrings: ctx.map.staticLabels, build: ctx.build,
    files: ctx.map.files, ...(ctx.map.treeHash !== undefined ? { treeHash: ctx.map.treeHash } : {}),
  });
}

/**
 * the element a step acts on (`element`; the `list` or repeated `cell` of a `select` — both forms,
 * issue #19; or the gate's dismiss control)
 */
function stepElement(map: LoadedMap, step: RecipeStep): ElementId | undefined {
  switch (step.action) {
    case 'tap':
    case 'type':
      return step.element;
    case 'select':
      return selectTarget(step);
    case 'swipe':
      return step.element;
    case 'dismiss_gate':
      return map.ids.gates.find((g) => g.id === step.gate)?.dismiss;
    // issue #24: the control the step NAMES, never the gate's dismiss — that is the whole point
    case 'tap_gate':
      return step.control;
    default:
      return undefined;
  }
}

/** the definition of `id`, preferring the declaration on `screen` (02 §4.1: ids repeat across screens) */
function elementDefOn(map: LoadedMap, screen: ScreenId | undefined, id: ElementId): ElementDef | undefined {
  const refs = map.elements.get(id) ?? [];
  if (screen !== undefined) {
    const onScreen = refs.find((r) => r.screen === screen);
    if (onScreen !== undefined) return onScreen.element;
  }
  return refs[0]?.element;
}

/** 02 §10.6 / architecture §7 decision 26: absent means false, in the step, the element and ids.yaml */
function isIntentCritical(map: LoadedMap, step: RecipeStep | undefined, def: ElementDef | undefined): boolean {
  if (step?.intent_critical === true) return true;
  if (def?.intent_critical === true) return true;
  return def !== undefined && map.elementRegistry.get(def.id)?.intent_critical === true;
}

/** a `DriverTarget` for a locator with no live node (the pending-heal candidate, 04 §7.2.3) */
function targetForLocator(locator: Locator): RunStep['target'] | undefined {
  switch (locator.strategy) {
    case 'a11y_id':
      return { by: 'id', id: locator.value };
    case 'role_label':
      return locator.value.label !== undefined ? { by: 'role_label', role: locator.value.role, label: locator.value.label } : undefined;
    case 'text':
      return { by: 'text', text: locator.value };
    case 'geometry':
      return { by: 'point', x: locator.value.x, y: locator.value.y };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// 07 §3 build probe
// ---------------------------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

/** The UserDefaults key (iOS) / file stem (Android) the instrumentation publishes the probe under (07 §3). */
export const BUILD_PROBE_KEY = 'app_map_debug_probe';

/** How a strategy encodes what it prints: a JSON object, or an XML property list (`plutil -convert xml1`). */
export type ProbeFormat = 'json' | 'xml1';

/** One way to read the probe: a `/bin/sh -c` command line plus the encoding of its stdout. */
export interface ProbeStrategy {
  readonly command: string;
  readonly format: ProbeFormat;
}

/** Runs one `/bin/sh -c` command and resolves its stdout; rejects when the command fails. */
export type ProbeExec = (command: string) => Promise<string>;

/** POSIX single-quoting for a value interpolated into a `/bin/sh -c` string (07 §4: no shell injection). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The ordered list of shell commands that can produce the app's 07 §3 probe record.
 *
 * iOS has two, tried in order:
 *  1. `defaults export` through `cfprefsd` — the historical read, still correct on older runtimes;
 *  2. the same record read straight out of the app's data container. On iOS 26 simulators
 *     `defaults` no longer resolves a sandboxed app's domain, so (1) prints `{}` for a Debug build
 *     that published the probe correctly and every recipe was refused as a Release build (#11).
 *
 * (2) converts to `xml1`, not `json`: `plutil -convert json` — and `plutil -extract … json`, which
 * validates the whole file first — refuses a domain holding ANY `Data` value, and one ordinary
 * `JSONEncoder` blob saved by the app is enough to break the read halfway through a session.
 * `xml1` is lossless, so it always prints, and `parseXmlPlist` drops `<data>` payloads instead of
 * choking on them. `plutil` ships with macOS and strategy (1) already depends on it, so the
 * fallback adds no new runtime dependency (07 §5); an interpreter such as `python3` would, and is
 * not guaranteed to be present on a machine that only has Xcode.app.
 *
 * Both strategies read the app's OWN record, so a Release build — which has no debug endpoint and
 * therefore publishes nothing — still yields no record and `assertDebugSandbox` refuses (07 §3).
 */
export function buildProbeStrategies(config: AppMapConfig, appId: string, key: string): ProbeStrategy[] {
  if (config.platform !== 'ios') {
    // Android: the debug-only file the instrumentation writes, already JSON.
    const target = config.simUdid !== undefined ? `-s ${shQuote(config.simUdid)} ` : '';
    return [{ command: `adb ${target}shell run-as ${shQuote(appId)} cat files/${key}.json`, format: 'json' }];
  }
  const udid = shQuote(config.simUdid ?? 'booted');
  // 07 §4: `"$( … )"` keeps a container path containing spaces a single word, and the trailing
  // segment is a SEPARATE single-quoted word concatenated onto it (adjacent quoted words are still
  // one argument), so `appId` never lands inside those double quotes — where `$( )` or a backtick
  // in a bundle id would be executed. `-o -` is mandatory: `plutil -convert` without it rewrites
  // the app's own preferences file in place.
  const containerPlist =
    `"$(xcrun simctl get_app_container ${udid} ${shQuote(appId)} data)"/Library/Preferences/${shQuote(`${appId}.plist`)}`;
  return [
    { command: `xcrun simctl spawn ${udid} defaults export ${shQuote(appId)} - | plutil -convert json -o - -`, format: 'json' },
    { command: `plutil -convert xml1 -o - ${containerPlist}`, format: 'xml1' },
  ];
}

/** What an XML property list can hold once `<data>` payloads are dropped (see `parseXmlPlist`). */
type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const MAX_CODE_POINT = 0x10ffff;

/** `&amp;`-style entities; an out-of-range numeric one is left alone (`String.fromCodePoint` throws). */
function decodeXmlText(text: string): string {
  return text.replace(/&(#[Xx]?[0-9A-Fa-f]+|[A-Za-z]+);/g, (whole: string, body: string): string => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isInteger(code) || code < 0 || code > MAX_CODE_POINT) return whole;
      return String.fromCodePoint(code);
    }
    return XML_ENTITIES[body] ?? whole;
  });
}

/** one `<tag …>`, `</tag>` or `<tag/>` found by the scanner; `end` is the index just past `>` */
interface XmlTag {
  name: string;
  closing: boolean;
  selfClosing: boolean;
  end: number;
}

/**
 * Minimal XML property-list reader — enough for a UserDefaults domain as `plutil -convert xml1`
 * prints it, with no XML dependency (07 §5). `<data>` becomes `null`: the 07 §3 record is never
 * binary, and dropping the payload is exactly what lets a domain that `plutil -convert json`
 * refuses still give up the probe (#11). Malformed input returns `null` rather than throwing, so
 * a half-written plist or a `plutil` error printed on stdout just makes the strategy fall through.
 */
export function parseXmlPlist(xml: string): unknown {
  const text = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '');
  const tags = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b[^>]*?(\/?)>/g;
  // One cursor for the whole parse, kept here rather than in `tags.lastIndex`: `exec` RESETS
  // `lastIndex` to 0 when it finds nothing, which would restart the scan and never terminate.
  let cursor = 0;
  let exhausted = false;
  const scan = (): RegExpExecArray | null => {
    if (exhausted) return null;
    tags.lastIndex = cursor;
    const m = tags.exec(text);
    if (m === null) { exhausted = true; return null; }
    cursor = tags.lastIndex;
    return m;
  };

  const nextTag = (): XmlTag | null => {
    const m = scan();
    if (m === null) return null;
    return { name: m[2] ?? '', closing: m[1] === '/', selfClosing: m[3] === '/', end: cursor };
  };
  /** the raw text of a leaf element, cursor left past its close tag; `null` when it is not closed as expected */
  const contentOf = (open: XmlTag): string | null => {
    const m = scan();
    if (m === null || m[1] !== '/' || m[2] !== open.name) return null;
    return text.slice(open.end, m.index);
  };
  /** consume an element we do not model, nesting included */
  const skipElement = (): void => {
    for (let depth = 1; depth > 0;) {
      const t = nextTag();
      if (t === null) return;
      if (t.selfClosing) continue;
      depth += t.closing ? -1 : 1;
    }
  };
  const parseValue = (open: XmlTag): PlistValue => {
    if (open.selfClosing) {
      switch (open.name) {
        case 'true': return true;
        case 'false': return false;
        case 'array': return [];
        case 'dict': return {};
        case 'string': return '';
        default: return null;
      }
    }
    switch (open.name) {
      case 'dict': return parseDict();
      case 'array': return parseArray();
      case 'true': skipElement(); return true;
      case 'false': skipElement(); return false;
      case 'string':
      case 'date': {
        const raw = contentOf(open);
        return raw === null ? null : decodeXmlText(raw);
      }
      case 'integer':
      case 'real': {
        const raw = contentOf(open);
        if (raw === null) return null;
        const n = Number(raw.trim());
        return Number.isFinite(n) ? n : null;
      }
      case 'data':
        // the payload is consumed and dropped — see the header doc
        contentOf(open);
        return null;
      default:
        skipElement();
        return null;
    }
  };
  const parseDict = (): PlistValue => {
    const out: { [key: string]: PlistValue } = {};
    for (;;) {
      const t = nextTag();
      if (t === null || t.closing) return out; // `</dict>`, or truncated input: keep what we have
      if (t.name !== 'key') { parseValue(t); continue; } // a value with no key: skip it
      const name = t.selfClosing ? '' : decodeXmlText(contentOf(t) ?? '');
      const value = nextTag();
      if (value === null || value.closing) return out;
      out[name] = parseValue(value);
    }
  };
  const parseArray = (): PlistValue[] => {
    const out: PlistValue[] = [];
    for (;;) {
      const t = nextTag();
      if (t === null || t.closing) return out;
      out.push(parseValue(t));
    }
  };

  try {
    for (;;) {
      const t = nextTag();
      if (t === null) return null;
      if (t.closing) continue;
      if (t.name === 'plist') {
        if (t.selfClosing) return null;
        continue;
      }
      return parseValue(t);
    }
  } catch {
    // deliberately total: a parse failure means "this strategy found nothing", never a crash
    return null;
  }
}

/**
 * Pure: turn one strategy's stdout into a probe record (07 §3). Both shapes parse — the whole
 * exported domain (what `defaults export` and `plutil -convert xml1` print, with the record under
 * `key`) and a bare record — so a strategy may print either.
 */
export function parseProbeOutput(text: string, key: string, format: ProbeFormat): BuildProbeResult | null {
  if (format === 'json') {
    try {
      return probeFromValue(JSON.parse(text), key);
    } catch {
      return null;
    }
  }
  return probeFromValue(parseXmlPlist(text), key);
}

/** the domain-or-record unwrap plus field coercion shared by every strategy */
function probeFromValue(value: unknown, key: string): BuildProbeResult | null {
  let found: unknown = value;
  if (typeof found === 'object' && found !== null && key in (found as Record<string, unknown>)) {
    found = (found as Record<string, unknown>)[key];
  }
  if (typeof found !== 'object' || found === null) return null;
  const record = found as Record<string, unknown>;
  if (typeof record.build_type !== 'string') return null;
  return {
    schema_version: 1,
    build_type: record.build_type === 'debug' ? 'debug' : 'release',
    sandbox: record.sandbox === true || record.sandbox === 1 || record.sandbox === 'true',
    app_id: String(record.app_id ?? ''),
    version: String(record.version ?? ''),
    build_number: String(record.build_number ?? ''),
    git_sha: String(record.git_sha ?? ''),
    ...(typeof record.flags === 'object' && record.flags !== null ? { flags: record.flags as BuildProbeResult['flags'] } : {}),
    ...(record.auth === 'logged_in' || record.auth === 'logged_out' || record.auth === 'any' ? { auth: record.auth } : {}),
    ...(typeof record.platform_version === 'string' ? { platform_version: record.platform_version } : {}),
    ...(typeof record.written_at === 'string' ? { written_at: record.written_at } : {}),
  };
}

/**
 * Try each strategy in order and return the first probe record one of them produces.
 *
 * A strategy that fails (no toolchain, no container, a `plutil` that refuses the file) or that
 * comes back without a record (iOS 26's empty `defaults export` domain, #11) is not an answer yet
 * — the next one is tried. 07 §3: when no strategy finds a record, that absence IS the answer,
 * because the debug endpoint does not exist in Release builds; `assertDebugSandbox(null)` refuses.
 */
export async function readBuildProbe(
  strategies: readonly ProbeStrategy[],
  key: string,
  exec: ProbeExec,
): Promise<BuildProbeResult | null> {
  for (const strategy of strategies) {
    let stdout: string;
    try {
      stdout = await exec(strategy.command);
    } catch {
      continue;
    }
    const probe = parseProbeOutput(stdout, key, strategy.format);
    if (probe !== null) return probe;
  }
  return null;
}

/** Default probe: shells out to `xcrun simctl` / `adb` (best-effort; see `buildProbeStrategies`). */
export const defaultBuildProbe: BuildInfoProbe = async (config, appId) => {
  if (typeof appId !== 'string' || appId === '') return null;
  const exec: ProbeExec = async (command) =>
    (await execFileAsync('/bin/sh', ['-c', command], { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout;
  return readBuildProbe(buildProbeStrategies(config, appId, BUILD_PROBE_KEY), BUILD_PROBE_KEY, exec);
};

/**
 * Which installed bundles register `scheme` (issue #25). `null` means "could not tell" — no
 * device, an unknown platform, a tool that is not installed — which is never treated as evidence
 * of anything; only a positive answer naming a foreign bundle refuses a run.
 */
export type SchemeOwnerProbe = (config: AppMapConfig, scheme: string) => Promise<string[] | null>;

/**
 * The shell command that lists the bundles registering a custom URL scheme.
 *
 * iOS: `simctl listapps` prints an OpenStep plist keyed by bundle id; `plutil -convert xml1` makes
 * it readable by `parseXmlPlist` (the same reader the build probe already needs, 07 §5 — no new
 * dependency). Each app's `CFBundleURLTypes[].CFBundleURLSchemes[]` is scanned for the scheme.
 *
 * Android: the platform answers the question directly — `pm query-activities` on a VIEW intent for
 * the scheme lists the components that would receive it, which IS the collision.
 */
export function schemeOwnerCommand(config: AppMapConfig, scheme: string): string | undefined {
  if (!DEEP_LINK_SCHEME_REGEX.test(scheme)) return undefined; // 07 §4: never interpolate an unvetted scheme
  if (config.platform === 'ios') {
    const udid = shQuote(config.simUdid ?? 'booted');
    return `xcrun simctl listapps ${udid} | plutil -convert xml1 -o - -`;
  }
  const target = config.simUdid !== undefined ? `-s ${shQuote(config.simUdid)} ` : '';
  return `adb ${target}shell cmd package query-activities --brief -a android.intent.action.VIEW -d ${shQuote(`${scheme}://probe`)}`;
}

/** iOS: bundle ids in a `simctl listapps` plist whose `CFBundleURLTypes` claim `scheme`. */
export function parseSchemeOwnersPlist(xml: string, scheme: string): string[] {
  const doc = parseXmlPlist(xml);
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const owners: string[] = [];
  for (const [bundleId, app] of Object.entries(doc as Record<string, unknown>)) {
    if (app === null || typeof app !== 'object' || Array.isArray(app)) continue;
    const types = (app as Record<string, unknown>).CFBundleURLTypes;
    if (!Array.isArray(types)) continue;
    const claims = types.some((t) => {
      if (t === null || typeof t !== 'object' || Array.isArray(t)) return false;
      const schemes = (t as Record<string, unknown>).CFBundleURLSchemes;
      return Array.isArray(schemes) && schemes.some((x) => typeof x === 'string' && x.toLowerCase() === scheme.toLowerCase());
    });
    if (claims) owners.push(bundleId);
  }
  return owners.sort();
}

/**
 * Android: `pm query-activities --brief` prints one `package/component` per matching activity
 * (plus a header/summary line); the package is everything before the first `/`.
 */
export function parseSchemeOwnersPm(stdout: string): string[] {
  const owners = new Set<string>();
  for (const line of stdout.split('\n')) {
    const m = /^\s*(?:priority=[^\s]*\s+)?([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+)\/[^\s]+/.exec(line);
    if (m?.[1] !== undefined) owners.add(m[1]);
  }
  return Array.from(owners).sort();
}

/** Default owner probe: shells out like the build probe, and answers `null` on any failure. */
export const defaultSchemeOwnerProbe: SchemeOwnerProbe = async (config, scheme) => {
  const command = schemeOwnerCommand(config, scheme);
  if (command === undefined) return null;
  let stdout: string;
  try {
    stdout = (await execFileAsync('/bin/sh', ['-c', command], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
  return config.platform === 'ios' ? parseSchemeOwnersPlist(stdout, scheme) : parseSchemeOwnersPm(stdout);
};

/**
 * Throws `deep_link_scheme_collision` when a bundle OTHER than `appId` registers `scheme`
 * (issue #25). Two instrumented apps that both keep the default `appmap` are routed by the OS to
 * whichever it likes: the deep link — and the `?fixture=` it carries — reaches the wrong app,
 * while the app-scoped capture keeps describing the right one and times out. That reads like a
 * hung inspector, so it is worth one clear refusal here.
 *
 * `owners` of `null` (no device, no `simctl`/`adb`, a driver we cannot ask) is NOT evidence:
 * only a positive list naming a foreign bundle refuses. Pure.
 */
export function assertSchemeUnique(appId: string, scheme: string, owners: readonly string[] | null): void {
  if (owners === null || owners.length === 0) return;
  const suggestion = `appmap-${(appId.split('.').pop() ?? 'app').toLowerCase()}`;
  const foreign = owners.filter((id) => id !== appId);
  if (foreign.length === 0) return;
  // Two different faults, and they have OPPOSITE remedies, so they must not share a message.
  if (!owners.includes(appId)) {
    throw new AppMapError(
      ERROR_CODES.DEEP_LINK_SCHEME_COLLISION,
      `the manifest says this app registers ${scheme}://, but the installed ${appId} does not — ${foreign.join(', ')} does`,
      `fix the APP, not the manifest: add ${scheme} to the Debug target's CFBundleURLTypes (iOS) or the debug intent-filter (Android), 01 R5 / instrumentation README §5`,
    );
  }
  throw new AppMapError(
    ERROR_CODES.DEEP_LINK_SCHEME_COLLISION,
    `${foreign.join(', ')} also registers ${scheme}://, so the OS may deliver ${appId}'s deep links (and their ?fixture=) to another app`,
    `give this app its own scheme in app-map/<platform>/manifest.yaml (deep_link_scheme: ${suggestion}) and the matching CFBundleURLTypes / intent-filter, or uninstall ${foreign[0]} (01 R5, issue #25)`,
  );
}

/** Does replaying this recipe open a custom-scheme URL at all? (entry deep link or an `open_link` step) */
export function opensADeepLink(recipe: RecipeFile): boolean {
  const entry = recipe.entry?.deep_link;
  if (typeof entry === 'string' && entry !== '' && entry !== 'none') return true;
  return (recipe.steps ?? []).some((step) => step.action === 'open_link');
}

/** Throws `release_build_refused` unless `probe` is a sandbox Debug build. Pure. */
export function assertDebugSandbox(probe: BuildProbeResult | null): void {
  const refuse = (why: string): never => {
    throw new AppMapError(
      ERROR_CODES.RELEASE_BUILD_REFUSED,
      `refusing to run a recipe: ${why}`,
      'recipes run only against Debug builds with fixture accounts in the sandbox (07 §3); install the APP_MAP_DEBUG build on the simulator',
    );
  };
  if (probe === null || probe === undefined) refuse('the app exposes no APP_MAP_DEBUG probe (Release build)');
  else if (probe.build_type !== 'debug') refuse(`the connected app is a ${probe.build_type} build`);
  else if (probe.sandbox !== true) refuse('the connected app is not pointed at the sandbox environment');
}

// ---------------------------------------------------------------------------------------------
// step expansion (module doc, step 5)
// ---------------------------------------------------------------------------------------------

/**
 * Pure: `{amount}` → params.amount (String()); unknown slots left as-is. Lives in the leaf module
 * `values.ts` so `observe.ts` can substitute at ingest without importing the state machine
 * (issue #23); re-exported here because that is where every caller already looks for it.
 */
export { substituteParams } from './values.ts';

/** the screen a deep link points at (query stripped, 01 R5) */
function screenOfDeepLink(map: LoadedMap, url: string | undefined): ScreenId | undefined {
  if (typeof url !== 'string' || url === '' || url === 'none') return undefined;
  return map.routes.get(routeKey(url));
}

function deepLinkOfScreen(map: LoadedMap, screen: ScreenId): string | undefined {
  const link = map.screens.get(screen)?.deep_link;
  return typeof link === 'string' && link !== '' && link !== 'none' ? link : undefined;
}

/**
 * an entry edge (02 §4.2 action) as a recipe step; `type`/`select` edges degrade to a tap. A
 * `select` edge carries no match text — 02 §4.2 records the element, never the row that was
 * picked — so neither `select` form can be rebuilt from one (issue #19); the tap on the cell id
 * lands on whichever row is first, which is all an entry approximation can promise.
 *
 * `undefined` means "this edge cannot be expressed as a step" and the caller drops the leg. A
 * swipe edge with no `direction` is one of those: screen.schema.json REQUIRES `direction` on a
 * swipe edge, so only an unvalidated map can produce one, and substituting `up` would swipe the
 * wrong way through someone's entry path while looking like a plan that worked (same reasoning as
 * `compile.swipeDirection` — a direction is never invented, 04 §3.3).
 */
function edgeStepFor(id: StepId, action: { type: string; element?: ElementId; url?: string; gate?: GateId; direction?: 'up' | 'down' | 'left' | 'right' }, to: ScreenId): RecipeStep | undefined {
  const expect: Expect = { screen: to };
  switch (action.type) {
    case 'open_link':
      return action.url === undefined ? undefined : { id, action: 'open_link', url: action.url, expect };
    case 'dismiss_gate':
      return action.gate === undefined ? undefined : { id, action: 'dismiss_gate', gate: action.gate, expect };
    case 'swipe':
      return action.direction === undefined ? undefined : { id, action: 'swipe', direction: action.direction, ...(action.element !== undefined ? { element: action.element } : {}), expect };
    default:
      // tap, and the navigation-by-typing edges a guided entry can only approximate
      return action.element === undefined ? undefined : { id, action: 'tap', element: action.element, expect };
  }
}

/** Pure: entry steps (`s0`, or `s0a…` for the fallback path) + recipe steps, with the screen each is taken on. */
export function expandSteps(map: LoadedMap, recipe: RecipeFile): Array<{ step: RecipeStep; screen: ScreenId | undefined }> {
  const out: Array<{ step: RecipeStep; screen: ScreenId | undefined }> = [];
  const steps = Array.isArray(recipe?.steps) ? recipe.steps : [];
  const firstStepScreen = (): ScreenId | undefined => {
    const first = steps[0];
    if (first === undefined) return undefined;
    const id = stepElement(map, first);
    return id === undefined ? undefined : (map.elements.get(id) ?? [])[0]?.screen;
  };
  const deepLink = recipe?.entry?.deep_link;
  let current: ScreenId | undefined;
  if (typeof deepLink === 'string' && deepLink !== '' && deepLink !== 'none') {
    // s0 = open_link entry.deep_link, verified against the screen the first recipe step needs
    const target = screenOfDeepLink(map, deepLink) ?? firstStepScreen();
    out.push({
      step: { id: ENTRY_STEP_ID, action: 'open_link', url: deepLink, ...(target !== undefined ? { expect: { screen: target } } : {}) },
      screen: undefined,
    });
    current = target;
  } else {
    // no deep link: the `fallback_path` becomes a series of edge taps numbered s0a, s0b, …
    const path = Array.isArray(recipe?.entry?.fallback_path) ? recipe.entry.fallback_path : [];
    let n = 0;
    const nextId = (): StepId => `${ENTRY_STEP_ID}${ENTRY_SUFFIXES[n++] ?? 'z'}`;
    const start = path[0];
    if (start !== undefined) {
      const link = deepLinkOfScreen(map, start);
      if (link !== undefined) {
        out.push({ step: { id: nextId(), action: 'open_link', url: link, expect: { screen: start } }, screen: undefined });
        current = start;
      }
      for (let i = 1; i < path.length; i++) {
        const from = path[i - 1]!;
        const to = path[i]!;
        let legs: Array<{ from: ScreenId; action: EdgeAction; to: ScreenId }> = [];
        try {
          const plan = shortestEdgePath(map, from, to);
          if (plan.kind === 'edges') legs = plan.edges;
        } catch {
          continue;
        }
        for (const leg of legs) {
          const step = edgeStepFor(nextId(), leg.action, leg.to);
          if (step === undefined) { n--; continue; }
          out.push({ step, screen: leg.from });
          current = leg.to;
        }
      }
    }
    if (current === undefined) current = firstStepScreen();
  }

  for (const step of steps) {
    const screen = current ?? (() => {
      const id = stepElement(map, step);
      return id === undefined ? undefined : (map.elements.get(id) ?? [])[0]?.screen;
    })();
    out.push({ step, screen });
    if (step.expect?.screen !== undefined) current = step.expect.screen;
  }
  return out;
}

/** Pure: a `RecipeStep` → `RunStep` with params substituted and, when `tree` is given, the resolved target. */
export function toRunStep(map: LoadedMap, step: RecipeStep, params: RecipeParams, opts: { tree?: AnyTree; announce?: boolean; pending?: RunRecord['pending_heal']; settle?: SettleOptions } = {}): RunStep {
  const out: RunStep = { id: step.id, action: step.action };
  const element = stepElement(map, step);
  if (element !== undefined) out.element = element;
  switch (step.action) {
    case 'type':
      out.text = substituteParams(step.text, params);
      break;
    case 'select':
      out.match_text = substituteParams(step.match?.text ?? '', params);
      break;
    case 'swipe':
      out.direction = step.direction;
      break;
    case 'open_link':
      // the map writes every link `appmap://`; the driver must be handed the scheme the app
      // actually registers (issue #25)
      out.url = emitDeepLink(substituteParams(step.url, params), map.manifest?.deep_link_scheme);
      break;
    case 'dismiss_gate':
      out.gate = step.gate;
      break;
    case 'tap_gate':
      out.gate = step.gate;
      out.control = step.control;
      break;
    default:
      break;
  }
  if (step.expect !== undefined) out.expect = step.expect;
  if (step.intent_critical === true) out.intent_critical = true;
  // 07 §3: candidate recipes announce intent_critical steps before acting
  if (opts.announce === true && step.intent_critical === true) out.announce = true;

  const pending = opts.pending;
  if (pending !== undefined && pending.step === step.id) {
    // 04 §7.2.3: the heal candidate is the target; the postcondition settles on the next report_step
    const target = targetForLocator(pending.candidate.proposed_locator);
    if (target !== undefined) out.target = target;
    out.resolved = { strategy: pending.candidate.proposed_locator.strategy, confidence: pending.candidate.score, degraded: true };
    out.healing = true;
    // a healed step needs the settle MOST: its postcondition is what decides whether the heal is
    // accepted at all on the next report (04 §7.2 rule 3)
    const healingSettle = settleFor(map, step, opts.settle ?? {});
    if (healingSettle !== undefined) out.settle = healingSettle;
    return out;
  }
  if (opts.tree !== undefined && element !== undefined) {
    const def = elementDefOn(map, undefined, element);
    if (def !== undefined) {
      const hit = resolveElement(map, def, opts.tree);
      if (hit.status === 'hit') {
        out.target = hit.target;
        out.resolved = { strategy: hit.strategy, confidence: hit.confidence, degraded: hit.degraded };
      }
    }
  }
  // 04 §3.3 `select {cell, match}`: every row carries the SAME registered id (01 R4), so the
  // `{by: 'id'}` target resolved above cannot say WHICH row this step means — it only proves the
  // row id is on screen. The match text can, and it is exactly what the Maestro export taps
  // (04 §6.2). `resolved` deliberately keeps the a11y_id evidence while `target` addresses the
  // one row; the two disagreeing is the point, not a bug (issue #19).
  if (step.action === 'select' && 'cell' in step && out.match_text !== undefined && out.match_text !== '') {
    out.target = { by: 'text', text: out.match_text };
  }
  // 04 §5 / issue #26: how the driver knows this step has landed. Absent when the step declares
  // nothing pollable — which tells the driver to report at once rather than sleep "to be safe".
  const settle = settleFor(map, step, opts.settle ?? {});
  if (settle !== undefined) out.settle = settle;
  return out;
}

// ---------------------------------------------------------------------------------------------
// expectations (module doc, step 4)
// ---------------------------------------------------------------------------------------------

/** Pure: does `expect` hold on `tree`? `screenId` is the identified screen (or `unknown`). */
export function checkExpect(map: LoadedMap, expect: Expect | undefined, tree: AnyTree, screenId: ScreenId | 'unknown', opts: { previousScreen?: ScreenId | 'unknown'; valueChecks?: Record<string, boolean> } = {}): { ok: boolean; failed: string[] } {
  const failed: string[] = [];
  if (expect === undefined) {
    // 02 §6: a step without `expect` inherits "screen unchanged"
    if (opts.previousScreen !== undefined && screenId !== opts.previousScreen) failed.push(`screen:${opts.previousScreen}`);
    return { ok: failed.length === 0, failed };
  }
  if (expect.screen !== undefined && screenId !== expect.screen) failed.push(`screen:${expect.screen}`);
  const hitNode = (id: ElementId) => {
    const def = elementDefOn(map, screenId === UNKNOWN_SCREEN ? undefined : screenId, id);
    if (def === undefined) return undefined;
    const res = resolveElement(map, def, tree);
    return res.status === 'hit' ? res : undefined;
  };
  if (expect.focused !== undefined) {
    const hit = hitNode(expect.focused);
    if (hit === undefined || hit.node.focused !== true) failed.push(`focused:${expect.focused}`);
  }
  for (const id of expect.visible ?? []) {
    if (hitNode(id) === undefined) failed.push(`visible:${id}`);
  }
  for (const id of expect.not_visible ?? []) {
    if (hitNode(id) !== undefined) failed.push(`not_visible:${id}`);
  }
  if (expect.text_present !== undefined) {
    // architecture §7 decision 29: scrubbed trees carry no text other than `label`
    let seen = false;
    walk(tree, (node) => {
      if (seen) return false;
      if (labelOf(node) === expect.text_present) { seen = true; return false; }
      return undefined;
    });
    if (!seen) failed.push(`text_present:${expect.text_present}`);
  }
  // issue #23: `value` was decided at ingest, against the raw tree — the only place the typed
  // value existed (recipes/values.ts). All that reaches here is one boolean per assertion; an
  // assertion with no verdict was never decided, which is not the same as satisfied.
  for (const check of valueChecksOfExpect(expect)) {
    if (opts.valueChecks?.[check.key] !== true) failed.push(`value:${check.element}`);
  }
  return { ok: failed.length === 0, failed };
}

// ---------------------------------------------------------------------------------------------
// run state
// ---------------------------------------------------------------------------------------------

/** Resolve the session a run verifies against (module doc, step 4); throws `no_observation`. */
export function resolveRunSession(ctx: AppMapContext, session: SessionId | undefined): { session: SessionId; last_seq: number } {
  const chosen = typeof session === 'string' && session !== '' ? session : ctx.db.lastObservation()?.session;
  if (chosen === undefined || chosen === '') {
    throw new AppMapError(
      ERROR_CODES.NO_OBSERVATION,
      'no observation has been recorded yet, so a guided run has nothing to verify against',
      'drive the app once (the PostToolUse hook records it) or pass `session` explicitly (03 §2)',
    );
  }
  return { session: chosen, last_seq: ctx.db.getSession(chosen)?.last_seq ?? 0 };
}

function defaultRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function missingParams(recipe: RecipeFile, params: RecipeParams): string[] {
  const given = params ?? {};
  return (recipe.params ?? [])
    .filter((p) => p.required === true)
    .filter((p) => {
      const v = (given as Record<string, unknown>)[p.name];
      return v === undefined || v === null || v === '';
    })
    .map((p) => p.name);
}

/** the recipe as the session knows it (cache first: `mark` and lifecycle land there) */
function recipeOf(ctx: AppMapContext, id: string): RecipeFile | undefined {
  return ctx.db.getRecipe(id) ?? ctx.map.recipes.get(id);
}

export async function startGuidedRun(ctx: AppMapContext, input: StartGuidedRunInput, opts: GuidedRunOptions = {}): Promise<Extract<RunRecipeResult, { mode: 'guided' }>> {
  const recipeId = input?.recipe_id;
  const recipe = typeof recipeId === 'string' ? recipeOf(ctx, recipeId) : undefined;
  // 1. eligible? (unknown, retired or the wrong platform all read the same way to the caller)
  if (recipe === undefined) {
    throw new AppMapError(ERROR_CODES.RECIPE_UNAVAILABLE, `recipe ${String(recipeId)} is not in the map`, 'call match_recipe or summary for the recipes this platform has');
  }
  if (recipe.status === 'retired') {
    throw new AppMapError(ERROR_CODES.RECIPE_UNAVAILABLE, `recipe ${recipe.id} is retired`, 'recompile it from a fresh exploration (04 §8)');
  }
  if (recipe.platform !== ctx.map.platform) {
    throw new AppMapError(ERROR_CODES.RECIPE_UNAVAILABLE, `recipe ${recipe.id} targets ${recipe.platform}, not ${ctx.map.platform}`, 'set APP_MAP_PLATFORM to the platform you are driving');
  }
  // 2. params
  const params = input.params ?? {};
  const missing = missingParams(recipe, params);
  if (missing.length > 0) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `recipe ${recipe.id} needs ${missing.join(', ')}`, `pass {${missing.map((m) => `${m}: …`).join(', ')}} in run_recipe params`);
  }
  // 3. 07 §3 execution policy — Debug + sandbox, or nothing runs
  if (opts.skipBuildCheck !== true) {
    const probeFn = opts.probe ?? defaultBuildProbe;
    let probe: BuildProbeResult | null = null;
    try {
      probe = await probeFn(ctx.config, ctx.map.manifest.app_id);
    } catch (e) {
      ctx.log.warn('guided: build probe failed', { error: (e as Error).message });
      probe = null;
    }
    assertDebugSandbox(probe);
    // the probe is also the only source of 02 §4.3 variant facts
    ctx.setProbe(probe);
    // 3a. issue #25: a recipe that enters by deep link is routed by the OS, not by us. If another
    // installed bundle registers the same scheme the link — and its `?fixture=` — can land in the
    // wrong app, and all we would see is the app-scoped capture timing out. Best-effort: an
    // unanswerable probe changes nothing.
    if (opensADeepLink(recipe)) {
      const scheme = ctx.map.manifest.deep_link_scheme || CANONICAL_DEEP_LINK_SCHEME;
      let owners: string[] | null = null;
      try {
        owners = await (opts.schemeOwners ?? defaultSchemeOwnerProbe)(ctx.config, scheme);
      } catch (e) {
        ctx.log.warn('guided: deep-link scheme probe failed', { error: (e as Error).message });
      }
      assertSchemeUnique(ctx.map.manifest.app_id, scheme, owners);
    }
  }
  // 4. the session whose observations verify this run
  const { session, last_seq } = resolveRunSession(ctx, input.session);
  // 5. entry + recipe steps
  const map = sessionMap(ctx);
  const expanded = expandSteps(map, recipe);
  const first = expanded[0];
  if (first === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `recipe ${recipe.id} has no steps`, 'recompile the recipe (04 §3)');
  }
  const entryCount = expanded.length - (recipe.steps?.length ?? 0);
  // 6. the run
  const run: RunRecord = {
    run_id: (opts.runId ?? defaultRunId)(),
    recipe: recipe.id,
    version: recipe.version,
    mode: 'guided',
    session,
    params,
    state: 'active',
    current_step: first.step.id,
    step_index: 0 - entryCount,
    heals: [],
    fallbacks: 0,
    started_at: (opts.now?.() ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    build: ctx.build,
    start_seq: last_seq,
    last_seq,
  };
  ctx.db.insertRun(run);
  ctx.log.info('guided run started', { run_id: run.run_id, recipe: run.recipe, session, steps: expanded.length });
  const announce = recipe.status === 'candidate';
  const firstSettle: SettleOptions = {
    ...(first.screen !== undefined ? { screen: first.screen } : {}),
    ...(recipe.verify !== undefined ? { verify: recipe.verify } : {}),
    ...(expanded.length === 1 ? { isLast: true } : {}),
  };
  return { mode: 'guided', run_id: run.run_id, recipe: recipe.id, version: recipe.version, step: toRunStep(map, first.step, params, { announce, settle: firstSettle }) };
}

// ---------------------------------------------------------------------------------------------
// report_step
// ---------------------------------------------------------------------------------------------

/** per-step bookkeeping for the 2-gate / 1-heal limits (04 §5) */
function runStepCounts(ctx: AppMapContext, run: RunRecord, stepId: StepId): { attempt: number; gate_dismissals: number; heals: number } {
  const rec = ctx.db.getRunStep(run.run_id, stepId);
  return { attempt: rec?.attempt ?? 0, gate_dismissals: rec?.gate_dismissals ?? 0, heals: rec?.heals ?? 0 };
}
function writeRunStep(ctx: AppMapContext, run: RunRecord, stepId: StepId, counts: { attempt: number; gate_dismissals: number; heals: number }, extra: { ok?: boolean; result?: ReportStepResult }): void {
  ctx.db.insertRunStep({
    run_id: run.run_id, step_id: stepId, attempt: counts.attempt + 1,
    gate_dismissals: counts.gate_dismissals, heals: counts.heals,
    ...(extra.ok !== undefined ? { ok: extra.ok } : {}),
    ...(extra.result !== undefined ? { result: extra.result } : {}),
    ts: now(),
  });
}

function elapsedMs(run: RunRecord): number {
  const started = Date.parse(run.started_at);
  return Number.isFinite(started) ? Math.max(0, Date.now() - started) : 0;
}

/** compact one-liners for `FallbackPayload.candidates` (04 §5 "fallback … candidates") */
function candidateLines(candidates: readonly HealCandidate[]): string[] {
  return candidates.slice(0, FALLBACK_CANDIDATES_MAX).map((c) => {
    const name = c.a11y_id ?? c.label ?? c.path ?? '?';
    return `${name} (${c.role}${c.path ? ` at ${c.path}` : ''}, score ${c.score.toFixed(2)})`;
  });
}

interface FallbackArgs {
  step: StepId;
  reason: FallbackReason;
  screen_seen: ScreenId | typeof UNKNOWN_SCREEN;
  /** issue #24: which capture `screen_seen` came from, and what decided it */
  screen_seen_seq?: number;
  identified_by?: IdentifySignalKind;
  expected?: Expect;
  candidates?: string[];
  message: string;
  steps_done: number;
  steps: number;
}

/**
 * 04 §5: the run is marked `fallback`, a `recipe_run` event with `fallbacks: 1` is logged
 * ("guided_fallback") and the LLM takes over from this step in explore mode. The task stays open
 * — the trajectory from here is compilable into a revision (04 §8).
 */
function toFallback(ctx: AppMapContext, run: RunRecord, args: FallbackArgs): ReportStepResult {
  run.state = 'fallback';
  run.fallbacks += 1;
  run.current_step = args.step;
  run.finished_at = now();
  ctx.db.updateRun(run);
  const fallback: FallbackPayload = {
    step: args.step, reason: args.reason, screen_seen: args.screen_seen,
    ...(args.screen_seen_seq !== undefined ? { screen_seen_seq: args.screen_seen_seq } : {}),
    ...(args.identified_by !== undefined ? { identified_by: args.identified_by } : {}),
    ...(args.expected !== undefined ? { expected: args.expected } : {}),
    candidates: args.candidates ?? [], message: args.message,
  };
  recordRunOutcome(ctx, run, { ok: false, steps: args.steps, steps_done: args.steps_done, ms: elapsedMs(run) });
  ctx.log.info('guided fallback', { run_id: run.run_id, step: args.step, reason: args.reason });
  return { run_id: run.run_id, status: 'fallback', fallback };
}

/** module doc step 2: the observation this report is verified against — never another session's */
function observationFor(ctx: AppMapContext, run: RunRecord, input: ReportStepInput): Observation | undefined {
  if (input.snapshot !== undefined && input.snapshot !== null) {
    // 04 §5: without hooks, `report_step` must carry the snapshot (expensive; discouraged)
    const result = recordObservation(ctx, {
      session: run.session, tool: `mcp__${ctx.config.driver}__report_step`, input: {},
      snapshot: input.snapshot, ok: input.ok !== false,
    });
    return ctx.db.listObservations(run.session, { fromSeq: result.seq, toSeq: result.seq })[0];
  }
  const fresh = ctx.db.listObservations(run.session, { fromSeq: run.last_seq + 1 });
  return fresh[fresh.length - 1];
}

export async function reportStep(ctx: AppMapContext, input: ReportStepInput): Promise<ReportStepResult> {
  const run = typeof input?.run_id === 'string' ? ctx.db.getRun(input.run_id) : undefined;
  // 1. the run must be active and the report must be for the step that was handed out
  if (run === undefined) {
    throw new AppMapError(ERROR_CODES.RUN_NOT_ACTIVE, `run ${String(input?.run_id)} is unknown`, 'start one with run_recipe (03 §8)');
  }
  if (run.state !== 'active') {
    throw new AppMapError(ERROR_CODES.RUN_NOT_ACTIVE, `run ${run.run_id} is ${run.state}`, 'start a new run with run_recipe, or take over in explore mode');
  }
  if (input.step_id !== run.current_step) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `run ${run.run_id} is waiting for step ${run.current_step}, not ${String(input.step_id)}`, `report the step the server handed out (${run.current_step})`);
  }
  const recipe = recipeOf(ctx, run.recipe);
  if (recipe === undefined) {
    throw new AppMapError(ERROR_CODES.RECIPE_UNAVAILABLE, `recipe ${run.recipe} disappeared from the map`, 'reload the map and start a new run');
  }
  const map = sessionMap(ctx);
  const expanded = expandSteps(map, recipe);
  const entryCount = expanded.length - (recipe.steps?.length ?? 0);
  const index = run.step_index + entryCount;
  const current = expanded[index];
  if (current === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `run ${run.run_id} points at step ${run.current_step}, which the recipe no longer has`, 'the recipe changed under the run; start a new one');
  }
  const announce = recipe.status === 'candidate';
  const counts = runStepCounts(ctx, run, input.step_id);
  const steps = expanded.length;

  // 2. the observation (never trusting `ok`, 04 §5)
  const obs = observationFor(ctx, run, input);
  if (obs === undefined || obs.snapshot === null) {
    writeRunStep(ctx, run, input.step_id, counts, { ok: false });
    return toFallback(ctx, run, {
      step: input.step_id, reason: 'no_observation', screen_seen: UNKNOWN_SCREEN, steps, steps_done: index,
      message: 'no observation was recorded for this step; without the PostToolUse hook, report_step needs a `snapshot` argument (04 §5)',
    });
  }
  run.last_seq = Math.max(run.last_seq, obs.seq);
  const tree = obs.snapshot;

  // 3. identification, ONCE, against the session map (issue #24). `obs.screen_after` was decided
  // at ingest against `ctx.map`, while everything below resolves elements against `sessionMap` —
  // which holds elements healed earlier in this run and screens `name_screen` created. Reporting a
  // screen from one map and resolving its elements against another is how `screen_seen` came to
  // disagree with what `identify_screen` answers. One call, one map, one answer.
  const identified = identify(map, tree, {
    build: ctx.build,
    ...(obs.screen_before !== UNKNOWN_SCREEN ? { covered_screen: obs.screen_before } : {}),
    ...probeConditions(ctx.probe),
  });
  const screenSeen = identified.screen_id;
  // the WINNING signal, taken by score rather than by position: `signals` happens to be pushed in
  // descending order today, which is not a property anything guarantees
  const identifiedBy: IdentifySignalKind = identified.signals.length === 0
    ? 'none'
    : identified.signals.reduce((best, sig) => (sig.score > best.score ? sig : best)).kind;
  const seenAt = obs.seq;

  // gates (04 §5: at most 2 dismissals per step, then fallback)
  const gates: GateId[] = identified.gates_present;
  // issue #24: a `tap_gate` step expects its gate to be up — the runner must not press Cancel
  // immediately before the step meant to press Delete
  const expectedGate = current.step.action === 'dismiss_gate' || current.step.action === 'tap_gate' ? current.step.gate : undefined;
  const blocking = gates.filter((g) => g !== expectedGate);
  if (blocking.length > 0) {
    const gate = blocking[0]!;
    if (counts.gate_dismissals >= GUIDED_LIMITS.gate_dismissals_per_step) {
      writeRunStep(ctx, run, input.step_id, counts, { ok: false });
      return toFallback(ctx, run, {
        step: input.step_id, reason: 'gate_limit', screen_seen: screenSeen, screen_seen_seq: seenAt, identified_by: identifiedBy, steps, steps_done: index,
        ...(current.step.expect !== undefined ? { expected: current.step.expect } : {}),
        message: `${gate} is still present after ${GUIDED_LIMITS.gate_dismissals_per_step} dismissals`,
      });
    }
    const dismissal: RecipeStep = { id: input.step_id, action: 'dismiss_gate', gate };
    // issue #26: the dismissal settles on its own gate's dismiss control disappearing — the step
    // it interrupted is handed back with `retry` and has not been re-run, so that step's
    // postcondition is not yet what "done" means here (settle.ts priority 0)
    const step = toRunStep(map, dismissal, run.params, {
      tree, announce, settle: { ...(current.screen !== undefined ? { screen: current.screen } : {}) },
    });
    const next = { ...counts, gate_dismissals: counts.gate_dismissals + 1 };
    const result: ReportStepResult = { run_id: run.run_id, status: 'gate', step, retry: input.step_id };
    ctx.db.updateRun(run);
    writeRunStep(ctx, run, input.step_id, next, { result });
    return result;
  }

  // 4. the postcondition
  const verdict = checkExpect(map, current.step.expect, tree, screenSeen, { previousScreen: obs.screen_before, ...(obs.value_checks !== undefined ? { valueChecks: obs.value_checks } : {}) });

  // 4a. settle a heal handed out on the previous call (04 §7.2 rule 3)
  let healed: HealSummary | undefined;
  const pending = run.pending_heal;
  if (pending !== undefined && pending.step === current.step.id) {
    if (verdict.ok) {
      const result = applyHeal(ctx, { pending, recipe: recipe.id }, { run_id: run.run_id });
      healed = {
        step: pending.step, element: pending.element, old_strategy: result.record.old_strategy,
        new_strategy: result.record.new_strategy ?? pending.candidate.proposed_locator.strategy,
        score: result.record.score,
      };
      run.heals = [...run.heals, healed];
      delete run.pending_heal;
    } else {
      rejectHeal(ctx, { pending, recipe: recipe.id }, 'postcondition_failed', [], { run_id: run.run_id });
      delete run.pending_heal;
      writeRunStep(ctx, run, input.step_id, counts, { ok: false });
      return toFallback(ctx, run, {
        step: input.step_id, reason: 'heal_rejected', screen_seen: screenSeen, screen_seen_seq: seenAt, identified_by: identifiedBy, steps, steps_done: index,
        ...(current.step.expect !== undefined ? { expected: current.step.expect } : {}),
        message: `the healed locator for ${pending.element} did not satisfy the step's expectation (${verdict.failed.join(', ')})`,
      });
    }
  }

  if (!verdict.ok) {
    writeRunStep(ctx, run, input.step_id, counts, { ok: false });
    return toFallback(ctx, run, {
      step: input.step_id, reason: 'expect_failed', screen_seen: screenSeen, screen_seen_seq: seenAt, identified_by: identifiedBy, steps, steps_done: index,
      ...(current.step.expect !== undefined ? { expected: current.step.expect } : {}),
      message: `expectation not met: ${verdict.failed.join(', ')}`,
    });
  }

  // 4b. 02 §8 lazy re-verify of what this observation actually confirmed
  verifyObserved(ctx, map, run, current, obs, screenSeen, gates);
  writeRunStep(ctx, run, input.step_id, counts, { ok: true });

  // 5. advance
  const nextIndex = index + 1;
  if (nextIndex >= expanded.length) return finish(ctx, map, run, recipe, obs, steps, screenSeen);

  const next = expanded[nextIndex]!;
  run.step_index = nextIndex - entryCount;
  run.current_step = next.step.id;

  const handed = prepareNextStep(ctx, map, run, recipe, next, obs, { announce, steps, stepsDone: nextIndex, isLast: nextIndex === expanded.length - 1 });
  if (handed.fallback !== undefined) return handed.fallback;
  ctx.db.updateRun(run);
  return { run_id: run.run_id, status: 'ok', step: handed.step!, ...(healed !== undefined ? { healed } : {}) };
}

/** 02 §8 / 08 §5 row 5: stamp what the observation confirmed (screen, element, edge). */
function verifyObserved(
  ctx: AppMapContext, map: LoadedMap, run: RunRecord, current: { step: RecipeStep; screen: ScreenId | undefined },
  obs: Observation, screenSeen: ScreenId | typeof UNKNOWN_SCREEN, gates: readonly GateId[],
): void {
  // issue #24: a screen behind a modal was not CLEANLY observed. Its own marker is occluded, its
  // elements are under a subtree the OS hid, and the identification may be the remembered
  // `covered` answer rather than anything in the tree. 02 §8 verification is a claim about one
  // clean observation, so a capture with a gate up promotes nothing.
  if (gates.length > 0) return;
  // the SAME screen `checkExpect` just used (step 3): stamping verification against a screen the
  // postcondition was not checked against is how a run comes to verify one thing and assert another
  const seen = screenSeen;
  const screens = seen === UNKNOWN_SCREEN ? [] : [seen];
  const elementId = stepElement(map, current.step);
  const screen = current.screen;
  const elements = elementId !== undefined && screen !== undefined && elementDefOn(map, screen, elementId) !== undefined
    ? [{ screen, element: elementId }]
    : [];
  const edges: Array<{ screen: ScreenId; action: { type: 'tap'; element: ElementId }; to: ScreenId }> = [];
  if (screen !== undefined && current.step.action === 'tap' && seen !== UNKNOWN_SCREEN && seen !== screen) {
    edges.push({ screen, action: { type: 'tap', element: current.step.element }, to: seen });
  }
  markVerified(ctx, { screens, elements, edges }, run.build ?? ctx.build);
}

/**
 * issue #24: the two structural bounds a heal of a GATE control gets — the dialog it may look in,
 * and the sibling controls it may never propose. Empty for an ordinary screen element, which heals
 * exactly as before.
 *
 * The sibling exclusion is the load-bearing half. The alternative — trusting 04 §7.2's score
 * threshold to keep Cancel and Delete apart — does not hold: two buttons in one alert agree on
 * role, role path and parent role and sit close together, so the arithmetic already lands within
 * noise of the acceptance line. Nothing about "confirm a destructive action" should depend on that.
 */
function gateHealBounds(map: LoadedMap, step: RecipeStep, def: ElementDef, tree: AnyTree): Pick<HealInput, 'candidateRoot' | 'forbiddenNodes'> | undefined {
  const gateId = gateOfStep(map, step, def);
  if (gateId === undefined) return {}; // an ordinary screen element: heals exactly as before
  // FAIL CLOSED. Both bounds are best-effort by nature — the dialog has to be locatable and the
  // siblings have to resolve — and the situation where they are not is precisely a redesign of the
  // dialog, which is also precisely when a heal is attempted. An unbounded walk would then be free
  // to propose the button next to the one we lost, so refuse instead: no dialog located, no heal.
  const root = gateDialogRoot(map, tree, gateId);
  if (root === undefined) return undefined;
  const siblings = new Set<TreeNode>();
  const registered = map.ids.gates.find((g) => g.id === gateId);
  const others = [registered?.dismiss, ...(registered?.controls ?? []).map((c) => c.id)]
    .filter((id): id is ElementId => typeof id === 'string' && id !== '' && id !== def.id);
  for (const id of others) {
    const otherDef = map.gates.get(gateId)?.elements?.find((e) => e.id === id);
    if (otherDef === undefined) continue;
    const hit = resolveElement(map, otherDef, tree);
    if (hit.status === 'hit') siblings.add(hit.node);
    // a sibling that does NOT resolve is the dangerous case, not a benign one: its node is still
    // in the dialog and is now the best-scoring lookalike for the control we are healing. The
    // dialog scope keeps the search inside one alert; refusing here keeps it off the other button.
    else return undefined;
  }
  return { candidateRoot: root, ...(siblings.size > 0 ? { forbiddenNodes: siblings } : {}) };
}

/** The gate a step's element belongs to, if any (the step names it, or the element is declared on a gate file). */
function gateOfStep(map: LoadedMap, step: RecipeStep, def: ElementDef): GateId | undefined {
  if (step.action === 'dismiss_gate' || step.action === 'tap_gate') return step.gate;
  for (const [id, gate] of map.gates) {
    if ((gate.elements ?? []).some((e) => e.id === def.id)) return id;
  }
  return undefined;
}

/** 04 §5: the last step is done — the recipe's own `verify` decides `verified`. *//** 04 §5: the last step is done — the recipe's own `verify` decides `verified`. */
function finish(ctx: AppMapContext, map: LoadedMap, run: RunRecord, recipe: RecipeFile, obs: Observation, steps: number, screenSeen: ScreenId | typeof UNKNOWN_SCREEN): ReportStepResult {
  // `screenSeen`, not `obs.screen_after`: the caller re-identified against the SESSION map, and
  // deciding `verified` against a different screen than the steps were checked against is the
  // split-brain issue #24 found in `screen_seen` (guided fallbacks) in the first place
  const verdict = checkExpect(map, recipe.verify, obs.snapshot!, screenSeen, obs.value_checks !== undefined ? { valueChecks: obs.value_checks } : {});
  const verified = verdict.ok;
  run.state = verified ? 'done' : 'failed';
  run.finished_at = now();
  ctx.db.updateRun(run);
  if (verified) markVerified(ctx, { recipe: recipe.id }, run.build ?? ctx.build);
  recordRunOutcome(ctx, run, { ok: verified, steps, steps_done: steps, ms: elapsedMs(run) });
  // architecture §2.1: a task also closes on guided `done`
  finishTask(ctx, run.session, { ok: verified, mode_end: 'guided' });
  ctx.log.info('guided run finished', { run_id: run.run_id, verified, heals: run.heals.length });
  return { run_id: run.run_id, status: 'done', done: true, verified, heals: run.heals };
}

/**
 * Resolve the next step's element against the observation (03 §6). `hit` hands the step out as
 * it stands; `degraded`/`miss` goes through 04 §7 healing, at most once per step.
 */
function prepareNextStep(
  ctx: AppMapContext, map: LoadedMap, run: RunRecord, recipe: RecipeFile,
  next: { step: RecipeStep; screen: ScreenId | undefined }, obs: Observation,
  opts: { announce: boolean; steps: number; stepsDone: number; isLast?: boolean },
): { step?: RunStep; fallback?: ReportStepResult } {
  const tree = obs.snapshot!;
  const elementId = stepElement(map, next.step);
  const screen = obs.screen_after !== UNKNOWN_SCREEN ? obs.screen_after : next.screen;
  // issue #26: on the LAST step the recipe's own `verify` is what `finish` checks, so it is that
  // step's real postcondition when the step declares none of its own
  const settle: SettleOptions = {
    ...(next.screen !== undefined ? { screen: next.screen } : {}),
    ...(recipe.verify !== undefined ? { verify: recipe.verify } : {}),
    ...(opts.isLast === true ? { isLast: true } : {}),
  };
  const def = elementId === undefined ? undefined : elementDefOn(map, screen, elementId);
  if (elementId === undefined || def === undefined) {
    return { step: toRunStep(map, next.step, run.params, { tree, announce: opts.announce, settle }) };
  }
  const trigger = resolveElement(map, def, tree);
  if (trigger.status === 'hit' && !trigger.degraded) {
    return { step: toRunStep(map, next.step, run.params, { tree, announce: opts.announce, settle }) };
  }
  // 04 §5: max 1 heal per step
  const counts = runStepCounts(ctx, run, next.step.id);
  if (counts.heals >= GUIDED_LIMITS.heals_per_step) {
    return {
      fallback: toFallback(ctx, run, {
        step: next.step.id, reason: 'heal_limit', screen_seen: obs.screen_after, steps: opts.steps, steps_done: opts.stepsDone,
        ...(next.step.expect !== undefined ? { expected: next.step.expect } : {}),
        message: `already healed ${next.step.id} once in this run`,
      }),
    };
  }
  // issue #24: a gate control whose dialog (or whose sibling controls) cannot be located is not
  // healed at all — see `gateHealBounds`. Falling back is the safe answer: the LLM takes over and
  // a human decides which button to press.
  const bounds = gateHealBounds(map, next.step, def, tree);
  if (bounds === undefined) {
    return {
      fallback: toFallback(ctx, run, {
        step: next.step.id, reason: 'heal_rejected', screen_seen: obs.screen_after, steps: opts.steps, steps_done: opts.stepsDone,
        ...(next.step.expect !== undefined ? { expected: next.step.expect } : {}),
        message: `${def.id} is a gate control and its dialog could not be located in the capture, so healing it is refused — a replacement chosen outside the dialog could be the opposite button (04 §7.3, issue #24)`,
      }),
    };
  }
  const healInput: HealInput = {
    recipe: recipe.id, step: next.step, screen: screen ?? UNKNOWN_SCREEN, element: def,
    intent_critical: isIntentCritical(map, next.step, def), tree, trigger, build: run.build ?? ctx.build, run_id: run.run_id,
    ...(bounds ?? {}),
  };
  const proposal = proposeHeal(healInput);
  if (proposal.candidate !== undefined) {
    run.pending_heal = toPendingHeal(healInput, { ...proposal, candidate: proposal.candidate }, obs.seq);
    // the heal counter belongs to the step being handed out, not to the one just reported (04 §5)
    writeRunStep(ctx, run, next.step.id, { ...counts, heals: counts.heals + 1 }, {});
    return { step: toRunStep(map, next.step, run.params, { tree, announce: opts.announce, pending: run.pending_heal, settle }) };
  }
  const result = rejectHeal(ctx, { input: healInput }, proposal.reason as Exclude<typeof proposal.reason, 'accepted'>, proposal.candidates, {
    run_id: run.run_id, ...(proposal.runner_up !== undefined ? { runner_up_score: proposal.runner_up.score } : {}),
  });
  // 04 §7.2: an intent_critical rejection names itself so the LLM confirms with the user first
  const reason: FallbackReason = proposal.reason === 'intent_critical_label_changed' ? 'intent_critical_label_changed' : 'heal_rejected';
  return {
    fallback: toFallback(ctx, run, {
      step: next.step.id, reason, screen_seen: obs.screen_after, steps: opts.steps, steps_done: opts.stepsDone,
      ...(next.step.expect !== undefined ? { expected: next.step.expect } : {}),
      candidates: candidateLines(result.candidates),
      message: `could not resolve ${def.id} and the heal was rejected (${proposal.reason})`,
    }),
  };
}
