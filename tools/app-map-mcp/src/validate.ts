/**
 * [A1] `app-map validate` — 02 §10 rules 1–9 (06 R1 blocks the PR on any error).
 *
 *  1. every file validates against its JSON Schema (yaml/schemas.ts); plus a safe-regex check
 *     on every user-authored regex source (`matches[]`, `label_regex`): ≤200 chars, no nested
 *     quantifiers (`(a+)+`, `(a*)*`, `(a|aa)+`-style) — `safeRegexIssue` (07 §4 malicious YAML)
 *  2. every element id, screen id, gate id exists in ids.yaml (gate dismiss controls count as
 *     registered via `gates[].dismiss`; screen markers via `screens[].id`); an edge
 *     `action.element` must also be DECLARED on its own screen — a WARNING instead of an error
 *     while exploration has not reached it, an error once it has. Three subjects count as
 *     unreached (issue #12): the SCREEN, `meta.status: candidate` with `elements: []` (an untouched
 *     router-export seed, 01 R6/03 §5); the ELEMENT, a still-`candidate` edge whose element no
 *     capture has produced on ANY screen (what a build N+1 `import-router` refresh appends to an
 *     already-explored screen when the app registered a new id); or the CAPTURE, a still-`candidate`
 *     edge on a router-written screen whose `elements[]` was captured on a build the manifest has
 *     moved past — or, for a `build_number` that does not compare numerically, any build other than
 *     the one it names (the same refresh naming SHARED CHROME another screen already declares). An
 *     element missing from ids.yaml entirely stays an error on every screen, and a non-`candidate`
 *     edge is a claim that the tap happened here; element ids in
 *     screen files match `ID_REGEX` (2+ segments; `ELEMENT_ID_REGEX` applies to ids.yaml only);
 *     when ids.yaml carries `title`/`deep_link` for a screen they must agree with the screen
 *     file's — `title` exactly, `deep_link` on `routeKey` (query stripped: the registry records
 *     the route, the screen file may add `?fixture=…`, 01 R5); `indexMap` serves the screen
 *     file's values (two sources of truth otherwise — `plan_path`, `routes`, drift); and a
 *     WARNING for a registered `kind: list` element that no screen file records as observed —
 *     a SwiftUI list container is not an accessibility element, so it never reaches the driver
 *     and a `select {list, match}` against it can never resolve (01 R4, issue #19); and a WARNING
 *     for an `expect.focused` on a platform whose driver reports no focus — Argent's iOS snapshot
 *     carries no focus flag of any kind, so the assertion can never be satisfied and every replay
 *     of the step falls back (`types.focusObservable`, 04 §10, issue #18)
 *  3. every edge `to`, `entry.fallback_path` entry, `expect.screen`, condition `screen` references
 *     an existing screen file (`_previous` allowed on gates)
 *  4. every committed element has ≥2 locators and an `a11y_id` locator, unless the file is a
 *     gate and all its locators are `role_label`/`path` (OS dialogs)
 *  5. no `text` strategy stands alone
 *  6. `intent_critical` agrees between ids.yaml and every screen element / recipe step that
 *     touches the element (absent = false)
 *  7. serialization is canonical (yaml/canonical.ts `isCanonical`) — this is where an unquoted
 *     `version: 1.0` / `git_sha: 0000000` in a manifest lands now that rule 1 reads them as the
 *     authored strings: `export --check` reports one re-quoting diff and the next write of the
 *     manifest fixes it, instead of `map failed to load` blocking every other command (issue #20)
 *  8. forbidden content sweep over `elements[].label`, `title`, every `text`/`text_present`/
 *     `match.text` and `description`: email, phone, 13–19 digit runs, currency, IBAN-like,
 *     SSN-like (`scrub.ts` PII_PATTERNS); `{param}` slots are exempt. Also a WARNING when a
 *     `title` or element `label` is not in `.local/strings.<platform>.txt` while that file
 *     exists (07 §2.1: static copy must exist in the app's string tables); gates carry no
 *     `title` (architecture §7 decision 33). Also an ERROR for a literal in an `expect.value`
 *     comparison (issue #23): only a `{param}` slot may appear there, which is strictly stronger
 *     than the PII sweep — `equals: "Acme Corp"` matches no pattern while being exactly the
 *     committed data value 07 §2.3.5 forbids
 *  9. every declared recipe param is ASSERTED on — an `expect.value`/`verify.value` slot, or a
 *     `select match.text` slot (the row is addressed by that text at replay, so the step really
 *     fails when nothing matches). A `type` step's slot does NOT count: typing is not observing,
 *     which is issue #23 entire. WARNING while `candidate`, ERROR at `verified`/`ci_gate`
 *
 * Also enforced: file name equals `id` (02 §2.1); recipe `platform` equals its directory;
 * dynamic elements carry no `label` (07 §2.3).
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/* + scrub).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { AppMapConfig, Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import type { BuildNumber, Condition, ElementId, Expect, IdsElement, IdsRegistry, Manifest, RecipeFile, RecipeParam, ScreenFile, UnlearnedEdgeElementReason, ValidateResult, ValidationIssue } from './types.ts';
import { CANONICAL_DEEP_LINK_SCHEME, ID_REGEX, PREVIOUS_SCREEN, focusObservable, gateControlEntries, isNewerBuild, markerOfScreen, routeKey, stepElement, unlearnedEdgeElementMessage } from './types.ts';
import { AppMapError } from './errors.ts';
import { allowlistFile, idsFile, kindForPath, manifestFile, recipesDir, schemaDir, screensDir, stringsFile } from './paths.ts';
import type { YamlKind } from './paths.ts';
import { PII_PATTERNS } from './scrub.ts';
import { assertionOp, observedParams, paramOfSlot } from './values.ts';
import { isCanonical, parseYamlDoc } from './yaml/canonical.ts';
import { schemaIssueDetail, validateAgainstSchema } from './yaml/schemas.ts';

export interface ValidateOptions {
  /** default: every platform directory that has a manifest */
  platforms?: Platform[];
  /** run rule 7 (default true; `loadMap` passes false) */
  canonical?: boolean;
  /**
   * 02 §11: router-export JSON files to check against `router-export.schema.json`
   * (`app-map validate --router <path>`). They are build artifacts that live outside the map, so
   * nothing under `config.dir` names them — without this the fifth schema is only reachable
   * through `import-router`, and `validate` cannot cover all five as 02 §11 asks.
   */
  routerExports?: string[];
}

type Rule = ValidationIssue['rule'];

/** Small builder so every rule reports the same shape. */
function issue(rule: Rule, file: string, message: string, location?: string, severity: 'error' | 'warning' = 'error'): ValidationIssue {
  const i: ValidationIssue = { rule, severity, file, message };
  if (location !== undefined) i.location = location;
  return i;
}

/** 07 §4: user-authored regex sources are bounded to this many characters (schemas agree). */
export const MAX_REGEX_SOURCE_LENGTH = 200;

/** Run every rule over `config.dir`. Never throws for map problems — they are `issues`. */
export function validateMap(config: AppMapConfig, opts: ValidateOptions = {}): ValidateResult {
  const issues: ValidationIssue[] = [];
  let filesChecked = 0;
  const sd = schemaDir(config);
  const rel = (p: string): string => relative(config.dir, p).split(sep).join('/');

  // rule 1 per file: parse + schema; returns the document when it is usable for the later rules
  const readChecked = <T>(path: string, kind: YamlKind): T | undefined => {
    const file = rel(path);
    filesChecked++;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (e) {
      issues.push(issue(1, file, `cannot read file: ${(e as Error).message}`));
      return undefined;
    }
    let doc: unknown;
    let scalarSources: ReadonlyMap<string, string>;
    try {
      // parsed WITH the kind, so rule 1 accepts exactly what `loadMap` accepts: a manifest whose
      // `version: 1.0` / `git_sha: 0000000` is read back as the authored string (issue #20)
      ({ doc, scalarSources } = parseYamlDoc(text, file, kind));
    } catch (e) {
      issues.push(issue(1, file, AppMapError.is(e) ? e.message : String(e)));
      return undefined;
    }
    let schemaIssues;
    try {
      schemaIssues = validateAgainstSchema(sd, kind, doc);
    } catch (e) {
      issues.push(issue(1, file, `schema unavailable: ${AppMapError.is(e) ? e.message : String(e)}`));
      return undefined;
    }
    if (schemaIssues.length) {
      for (const si of schemaIssues) issues.push(issue(1, file, schemaIssueDetail(si, doc, scalarSources), si.path));
      return undefined;
    }
    return doc as T;
  };

  if (!existsSync(config.dir)) {
    issues.push(issue(1, '.', `${config.dir} does not exist`));
    return { ok: false, issues, files_checked: 0 };
  }

  // ---- ids.yaml (01 R1) ----
  const idsPath = idsFile(config);
  const ids = existsSync(idsPath) ? readChecked<IdsRegistry>(idsPath, 'ids') : (issues.push(issue(1, 'ids.yaml', 'ids.yaml is missing (01 R1)')), undefined);
  if (ids) {
    ids.elements.forEach((e, i) => {
      if (e.label_regex !== undefined) {
        const bad = safeRegexIssue(e.label_regex);
        if (bad) issues.push(issue(1, 'ids.yaml', `label_regex ${bad}`, `/elements/${i}/label_regex`));
      }
    });
  }

  // ---- policy allowlist (07 §6) when present ----
  const allow = allowlistFile(config);
  if (existsSync(allow)) readChecked(allow, 'mcp-allowlist');

  // ---- platforms ----
  const platforms = opts.platforms ?? PLATFORMS.filter((p) => existsSync(manifestFile(config, p)));
  for (const platform of platforms) {
    const mPath = manifestFile(config, platform);
    if (!existsSync(mPath)) {
      issues.push(issue(1, rel(mPath), `manifest.yaml is missing for platform ${platform}`));
      continue;
    }
    const manifest = readChecked<Manifest>(mPath, 'manifest');
    if (manifest && manifest.platform !== platform) issues.push(issue(1, rel(mPath), `platform ${manifest.platform} must equal the directory name ${platform}`, '/platform'));

    const screens = new Map<string, ScreenFile>();
    for (const path of yamlFilesIn(screensDir(config, platform))) {
      const doc = readChecked<ScreenFile>(path, 'screen');
      if (!doc) continue;
      const file = rel(path);
      const name = basename(path).replace(/\.ya?ml$/, '');
      if (doc.id !== name) issues.push(issue(1, file, `id ${doc.id} must equal the file name ${name} (02 §2.1)`, '/id'));
      // rule 1 safe-regex on role_label label_regex sources
      doc.elements.forEach((el, ei) =>
        el.locators.forEach((loc, li) => {
          if (loc.strategy === 'role_label' && loc.value.label_regex !== undefined) {
            const bad = safeRegexIssue(loc.value.label_regex);
            if (bad) issues.push(issue(1, file, `label_regex ${bad}`, `/elements/${ei}/locators/${li}/value/label_regex`));
          }
        }));
      (doc.signature.required_labels ?? []).forEach((rl, i) => {
        if (rl.label_regex !== undefined) {
          const bad = safeRegexIssue(rl.label_regex);
          if (bad) issues.push(issue(1, file, `label_regex ${bad}`, `/signature/required_labels/${i}/label_regex`));
        }
      });
      screens.set(file, doc);
    }
    const recipes = new Map<string, RecipeFile>();
    for (const path of yamlFilesIn(recipesDir(config, platform))) {
      const doc = readChecked<RecipeFile>(path, 'recipe');
      if (!doc) continue;
      const file = rel(path);
      const name = basename(path).replace(/\.ya?ml$/, '');
      if (doc.id !== name) issues.push(issue(1, file, `id ${doc.id} must equal the file name ${name} (02 §2.1)`, '/id'));
      if (doc.platform !== platform) issues.push(issue(1, file, `platform ${doc.platform} must equal the platform directory ${platform}`, '/platform'));
      doc.matches.forEach((m, i) => {
        const bad = safeRegexIssue(m);
        if (bad) issues.push(issue(1, file, `matches[${i}] ${bad}`, `/matches/${i}`));
      });
      recipes.set(file, doc);
    }
    if (ids) {
      const strings = stringsFile(config, platform);
      // rule 2's stale-capture carve-out compares each screen against the build the manifest names
      // (issue #12); a manifest that failed rule 1 leaves it undefined and the carve-out stays off
      const input: CrossRefInput = { platform, ids, screens, recipes, build: manifest?.build.build_number, ...(manifest?.deep_link_scheme !== undefined ? { deepLinkScheme: manifest.deep_link_scheme } : {}) };
      if (existsSync(strings)) input.staticStrings = new Set(readFileSync(strings, 'utf8').split('\n').filter((l) => l.length > 0));
      issues.push(...crossReferenceIssues(input));
    }
  }

  // ---- stray YAML files (unrecognised location: rule 1) ----
  for (const path of walkYaml(config.dir)) {
    if (kindForPath(config, path) === undefined) issues.push(issue(1, rel(path), 'YAML file in an unrecognised location (02 §2.1 layout)'));
  }

  // ---- rule 7 ----
  if (opts.canonical !== false) {
    for (const file of nonCanonicalFiles(config)) issues.push(issue(7, file, 'not in canonical form — run `app-map export` (02 §2.3, 02 §10.7)'));
  }

  // ---- router exports (02 §11: the fifth schema) ----
  for (const path of opts.routerExports ?? []) {
    filesChecked++;
    const file = relative(config.dir, path).startsWith('..') ? path : rel(path);
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      issues.push(issue(1, file, `router export is unreadable or not JSON: ${(e as Error).message}`));
      continue;
    }
    try {
      for (const i of validateAgainstSchema(sd, 'router-export', doc)) {
        issues.push(issue(1, file, `router-export.schema.json: ${i.message}`, i.path));
      }
    } catch (e) {
      issues.push(issue(1, file, AppMapError.is(e) ? e.message : String(e)));
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), issues: sortIssues(issues), files_checked: filesChecked };
}

/** Stable sort by file then rule; drops exact duplicates (ids.yaml is swept once per platform). */
function sortIssues(issues: ValidationIssue[]): ValidationIssue[] {
  const seen = new Set<string>();
  return issues
    .filter((i) => {
      const k = `${i.rule}\0${i.severity}\0${i.file}\0${i.location ?? ''}\0${i.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((i, n) => ({ i, n }))
    .sort((a, b) => (a.i.file < b.i.file ? -1 : a.i.file > b.i.file ? 1 : a.i.rule - b.i.rule || a.n - b.n))
    .map((x) => x.i);
}

function yamlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => join(dir, f));
}

function* walkYaml(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.local' || name === '.git' || name === 'node_modules') continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkYaml(p);
    else if (name.endsWith('.yaml') || name.endsWith('.yml')) yield p;
  }
}

export interface CrossRefInput {
  platform: Platform;
  ids: IdsRegistry;
  /** relative path → file */
  screens: ReadonlyMap<string, ScreenFile>;
  recipes: ReadonlyMap<string, RecipeFile>;
  /**
   * `.local/strings.<platform>.txt` when it exists (07 §2.1): rule 8 warns about titles/labels
   * missing from it. Omit (not empty) when the file is absent — then nothing is warned.
   */
  staticStrings?: ReadonlySet<string>;
  /**
   * The build this platform's `manifest.yaml` names — what `import-router` stamps when it merges a
   * new export (02 §8). Rule 2's third carve-out subject compares it with each screen's
   * `meta.last_verified_build` to tell a stale capture from a contradiction (issue #12); omit it
   * and that subject simply never fires, so callers that have no manifest lose nothing else.
   */
  build?: BuildNumber;
  /**
   * The scheme this platform's `manifest.yaml` declares (01 R5). Rule 1 warns when it is not the
   * default, because that is a claim about the SHIPPED BINARY that no file in the repo can check
   * (issue #25); omit it and the warning simply never fires.
   */
  deepLinkScheme?: string;
}

/**
 * Every element id some screen FILE records as present on that screen: `elements[]`,
 * `signature.required_ids`, `dynamic_regions` and each variant's `required_ids`. `observe`'s
 * `nameScreen` builds all four out of `idsPresent(snapshot)` — a real capture — so together they
 * are the map's committed, durable record of "a driver has seen this id in a tree", and the
 * SQLite cache adds nothing (its `hits` counter only counts elements a driver call TOUCHED, and
 * a container is never touched: you tap its cells). Edge `action.element` is excluded on purpose:
 * `import-router` seeds edges for elements exploration has never reached (01 R6, issue #12),
 * which is the absence of evidence rather than evidence — and rule 2's carve-out reads this set to
 * decide exactly that, so counting edges here would make it answer its own question.
 */
function observedElementIds(screens: Iterable<ScreenFile>): Set<ElementId> {
  const out = new Set<ElementId>();
  for (const s of screens) {
    for (const e of s.elements) out.add(e.id);
    for (const id of s.signature.required_ids ?? []) out.add(id);
    for (const id of s.dynamic_regions ?? []) out.add(id);
    for (const v of s.variants ?? []) for (const id of v.required_ids ?? []) out.add(id);
  }
  return out;
}

/** Pure: rules 2–6 and 8 over already-parsed documents. */
export function crossReferenceIssues(input: CrossRefInput): ValidationIssue[] {
  const { ids } = input;
  const issues: ValidationIssue[] = [];
  const screenIds = new Set(ids.screens.map((s) => s.id));
  const gateIds = new Set(ids.gates.map((g) => g.id));
  const registry = new Map<string, IdsElement>();
  for (const e of ids.elements) registry.set(e.id, e);
  // gate controls are registered under the gate, never in elements[] (architecture §7 decision 2;
  // issue #24 widened it from the one dismiss to `dismiss` + `controls[]`)
  const gateControlIds = new Map<string, string>();
  for (const g of ids.gates) {
    for (const c of gateControlEntries(g)) {
      registry.set(c.id, c);
      gateControlIds.set(c.id, g.id);
    }
  }
  // 01 R5 / issue #25: the manifest is the only place the app's scheme is written down, and
  // nothing in the repo can prove the binary registers it — a mismatch surfaces as an inspector
  // timeout on the correct bundle id, which reads like anything but a routing problem. A WARNING,
  // because a non-default scheme is the RIGHT answer for a repo with two instrumented apps; it
  // just has to be matched in the app.
  if (input.deepLinkScheme !== undefined && input.deepLinkScheme !== CANONICAL_DEEP_LINK_SCHEME) {
    issues.push(issue(1, `${input.platform}/manifest.yaml`,
      `deep_link_scheme is ${input.deepLinkScheme}, not the default ${CANONICAL_DEEP_LINK_SCHEME} — the app must register exactly that scheme (${input.platform === 'ios' ? "the Debug target's CFBundleURLTypes" : 'the debug intent-filter'}), or every deep link times out with no indication why (01 R5, issue #25)`,
      '/deep_link_scheme', 'warning'));
  }
  const idsScreenById = new Map(ids.screens.map((s) => [s.id, s]));
  // rule 8 over the registry itself (screen titles); validateMap dedupes it across platforms
  issues.push(...forbiddenContentIssues('ids.yaml', ids));

  // screen files by id (kind screen only — rule 3 targets are screens; gates are dismissed, never navigated to)
  const screenFilesById = new Set<string>();
  const gateFilesById = new Set<string>();
  for (const s of input.screens.values()) (s.kind === 'gate' ? gateFilesById : screenFilesById).add(s.id);
  const knownScreen = (id: string, allowPrevious: boolean): boolean => screenFilesById.has(id) || (allowPrevious && id === PREVIOUS_SCREEN);
  const critical = (id: string): boolean => registry.get(id)?.intent_critical === true; // absent = false (decision 26)

  const checkExpect = (file: string, x: Expect | undefined, loc: string, where: string, params?: readonly RecipeParam[]): void => {
    if (!x) return;
    // issue #23: a value assertion names an element and a `{param}` SLOT. The schema pins the slot
    // shape (rule 1) and rule 8 rejects a literal; here we check the two references resolve.
    (x.value ?? []).forEach((v, vi) => {
      if (typeof v?.element === 'string' && !registry.has(v.element)) {
        issues.push(issue(2, file, `${where}: expect.value element ${v.element} is not registered in ids.yaml`, `${loc}/value/${vi}/element`));
      }
      const parsed = assertionOp(v);
      if (parsed === undefined) return;
      const name = paramOfSlot(parsed.slot);
      if (name === undefined) return; // rule 1/8 report the literal; do not double-report it here
      if (params !== undefined && !params.some((p) => p.name === name)) {
        issues.push(issue(2, file, `${where}: expect.value ${parsed.op} {${name}} names a parameter the recipe does not declare`, `${loc}/value/${vi}/${parsed.op}`));
      }
    });
    if (x.screen !== undefined && !knownScreen(x.screen, false)) issues.push(issue(3, file, `expect.screen ${x.screen}: no such screen file`, `${loc}/screen`));
    for (const id of [x.focused, ...(x.visible ?? []), ...(x.not_visible ?? [])]) {
      if (id !== undefined && !registry.has(id)) issues.push(issue(2, file, `element ${id} is not registered in ids.yaml`, loc));
    }
    // An assertion this platform's driver cannot report is not a verification, it is a guaranteed
    // fallback: the step's `expect` fails on every replay however well the action worked
    // (issue #18's `FALLBACK at s1 (expect_failed)` on a field that WAS focused). A WARNING, not
    // an error — the file is still well-formed and Maestro satisfies it, so 06 R1 must not block
    // the PR and recipe.schema.json must keep accepting the key (`focusObservable`, 04 §10).
    if (x.focused !== undefined && !focusObservable(input.platform)) {
      issues.push(issue(2, file,
        `${where}: expect.focused ${x.focused} can never be satisfied on ${input.platform} — its accessibility snapshot carries no focus flag, so every replay of this step falls back (04 §10, issue #18). Assert \`visible: [${x.focused}]\` instead; \`focused\` is Android/Maestro-only`,
        `${loc}/focused`, 'warning'));
    }
  };
  const checkConditions = (file: string, cs: Condition[] | undefined, loc: string, allowPrevious: boolean): void => {
    (cs ?? []).forEach((c, i) => {
      if (c.screen !== undefined && !knownScreen(c.screen, allowPrevious)) issues.push(issue(3, file, `condition screen ${c.screen}: no such screen file`, `${loc}/${i}/screen`));
    });
  };

  // Every element id SOME screen file records as present on a screen — the map's whole record of
  // "a capture has produced this id". Hoisted above the screen loop because two rules need it: the
  // rule 2 edge-element carve-out below (issue #12) and the `kind: list` sweep after it (issue #19).
  const observed = observedElementIds(input.screens.values());

  for (const [file, doc] of input.screens) {
    const isGate = doc.kind === 'gate';
    // ---- rule 2: registration ----
    if (isGate) {
      if (!gateIds.has(doc.id)) issues.push(issue(2, file, `gate ${doc.id} is not registered in ids.yaml gates[]`, '/id'));
    } else if (!screenIds.has(doc.id)) {
      issues.push(issue(2, file, `screen ${doc.id} is not registered in ids.yaml screens[]`, '/id'));
    }
    if (doc.signature.marker !== 'none') {
      if (doc.signature.marker !== markerOfScreen(doc.id)) issues.push(issue(2, file, `marker ${doc.signature.marker} must be ${markerOfScreen(doc.id)} (01 R3)`, '/signature/marker'));
    } else if (!isGate) {
      issues.push(issue(2, file, `screen ${doc.id} has no marker; only OS gates may use marker none (01 R3)`, '/signature/marker', 'warning'));
    }
    (doc.gates ?? []).forEach((g, i) => {
      if (!gateIds.has(g)) issues.push(issue(2, file, `gate ${g} is not registered in ids.yaml gates[]`, `/gates/${i}`));
    });
    (doc.signature.required_ids ?? []).forEach((id, i) => {
      if (!registry.has(id)) issues.push(issue(2, file, `required id ${id} is not registered in ids.yaml`, `/signature/required_ids/${i}`));
    });
    (doc.dynamic_regions ?? []).forEach((id, i) => {
      if (!registry.has(id)) issues.push(issue(2, file, `dynamic region ${id} is not registered in ids.yaml`, `/dynamic_regions/${i}`));
    });
    (doc.variants ?? []).forEach((v, vi) => {
      (v.required_ids ?? []).forEach((id, i) => {
        if (!registry.has(id)) issues.push(issue(2, file, `variant ${v.id} required id ${id} is not registered in ids.yaml`, `/variants/${vi}/required_ids/${i}`));
      });
      if (v.when.screen !== undefined && !knownScreen(v.when.screen, false)) issues.push(issue(3, file, `variant ${v.id} when.screen ${v.when.screen}: no such screen file`, `/variants/${vi}/when/screen`));
    });
    // ids.yaml ↔ screen file agreement (decision 34)
    if (!isGate) {
      const reg = idsScreenById.get(doc.id);
      if (reg?.title !== undefined && doc.title !== undefined && reg.title !== doc.title) {
        issues.push(issue(2, file, `title ${JSON.stringify(doc.title)} differs from ids.yaml ${JSON.stringify(reg.title)}`, '/title'));
      }
      if (reg?.deep_link !== undefined && doc.deep_link !== undefined && routeKey(reg.deep_link) !== routeKey(doc.deep_link)) {
        issues.push(issue(2, file, `deep_link ${doc.deep_link} differs from ids.yaml ${reg.deep_link} (route part, 01 R5)`, '/deep_link'));
      }
    }

    const declared = new Set(doc.elements.map((e) => e.id));
    // 02 §10 rule 2 carve-out (issue #12), subject 1 of 3: the SCREEN is untouched. A screen the
    // router export seeded carries the app's edges and nothing else — `elements: []` is by design
    // until exploration learns them, and erroring makes the seed unloadable before exploration can
    // start. The moment ONE element is known the screen HAS been observed; a screen past
    // `candidate` is past the point where "not learned yet" explains anything. Both halves of THIS
    // subject, not either. `meta` is schema-required, so no optional chaining.
    const unexploredScreen = doc.elements.length === 0 && doc.meta.status === 'candidate';
    // Subject 3 of 3: the screen's CAPTURE IS STALE. `elements[]` is the id set `name_screen`
    // captured at `meta.last_verified_build`; `mergeRouterScreen` appends the NEXT build's edges to
    // the same file and recaptures nothing. An edge naming an id that older capture could not have
    // contained is a refresh outrunning exploration, not a contradiction — and this is the only
    // shape the other two subjects both miss: SHARED CHROME (a tab bar, a back button) that another
    // screen already declares, so `observed` is true, landing on an explored screen, so
    // `unexploredScreen` is false. Build N+1 hard-errored there and `loadMap` threw `invalid_map`,
    // which is issue #12's cycle again. Scoped to screens the router writes, so a hand-authored map
    // keeps the hard error, and it self-heals: re-explore the screen and `name_screen` stamps this
    // build, after which an element that really is absent errors again.
    // "Stale" is NOT `isNewerBuild(manifest, captured)`: that comparison is numeric-only
    // (architecture decision 18), and both schemas let `build_number` be any
    // `^[0-9A-Za-z][0-9A-Za-z.\-]*$` — `1.2.3`, `4413-rc1`. For such an app every comparison is
    // `false`, so decision 18's "fall back to the conservative branch" would land on the hard error
    // here, and the build N+1 shared-chrome deadlock survives in full (measured: `import-router` at
    // `2026.9.13` appending a `nav.settings.tab` edge to the pilot's `invoice_detail` gives rule 2
    // as an ERROR and `openContext` returns `loadError = invalid_map`). The conservative branch of
    // a rule whose whole job is to keep the map loadable is the WARNING. So: the capture is not of
    // the build the manifest names, and is not demonstrably NEWER than it — which for two integers
    // is exactly `captured < manifest`, and for anything else is "they differ". Only ever turns an
    // error into a warning, never the reverse. The residual case, disclosed: a capture stamped at a
    // non-comparable build the manifest has NOT reached (a `--build` override running ahead of
    // `manifest.yaml`) reads as stale and warns.
    const staleCapture = doc.meta.last_verified_build !== undefined
      && doc.meta.sources.includes('router_export')
      && input.build !== undefined
      && input.build !== doc.meta.last_verified_build
      && !isNewerBuild(doc.meta.last_verified_build, input.build);
    doc.elements.forEach((el, ei) => {
      const loc = `/elements/${ei}`;
      if (!ID_REGEX.test(el.id)) issues.push(issue(2, file, `element id ${el.id} violates 01 R2 (${ID_REGEX.source})`, `${loc}/id`));
      const reg = registry.get(el.id);
      if (!reg) {
        issues.push(issue(2, file, `element ${el.id} is not registered in ids.yaml`, `${loc}/id`));
      } else {
        // ---- rule 6 ----
        if ((reg.intent_critical === true) !== (el.intent_critical === true)) {
          issues.push(issue(6, file, `element ${el.id}: intent_critical ${el.intent_critical === true} disagrees with ids.yaml (${reg.intent_critical === true})`, `${loc}/intent_critical`));
        }
        if (reg.dynamic === true && el.dynamic !== true) issues.push(issue(2, file, `element ${el.id} is dynamic in ids.yaml but not in the screen file`, `${loc}/dynamic`));
        if (reg.dynamic === true && el.label !== undefined) issues.push(issue(8, file, `dynamic element ${el.id} must not carry a label — it would be data (07 §2.3)`, `${loc}/label`));
      }
      // ---- rules 4 and 5 ----
      const strategies = el.locators.map((l) => l.strategy);
      const osGate = isGate && strategies.every((s) => s === 'role_label' || s === 'path');
      if (!osGate) {
        if (el.locators.length < 2) issues.push(issue(4, file, `element ${el.id} has ${el.locators.length} locator(s); committed elements need ≥2 (02 §10.4)`, `${loc}/locators`));
        if (!strategies.includes('a11y_id')) issues.push(issue(4, file, `element ${el.id} has no a11y_id locator (02 §10.4)`, `${loc}/locators`));
      }
      if (strategies.length === 1 && strategies[0] === 'text') issues.push(issue(5, file, `element ${el.id}: a text locator never stands alone (02 §10.5)`, `${loc}/locators`));
    });

    // ---- rule 3 + edge element registration ----
    doc.edges.forEach((e, i) => {
      const loc = `/edges/${i}`;
      if (!knownScreen(e.to, isGate)) {
        issues.push(issue(3, file, e.to === PREVIOUS_SCREEN ? `edge to _previous is only allowed on gates (02 §4.2)` : `edge to ${e.to}: no such screen file`, `${loc}/to`));
      }
      const a = e.action;
      // issue #24: same rule as a recipe step — a plain `tap` edge naming a gate control would be
      // expanded into a step the runner dismisses the gate before executing. A gate's OWN file is
      // the exception: `{tap <dismiss>} → _previous` is how a gate has always modelled its escape.
      if (!isGate && a.type === 'tap' && gateControlIds.has(a.element)) {
        issues.push(issue(2, file, `edge element ${a.element} is a control of ${gateControlIds.get(a.element)} — a gate is dismissed, never navigated through; model the interrupter on ${gateControlIds.get(a.element)} and let the runner handle it (01 R7, issue #24)`, `${loc}/action/element`));
      }
      if ('element' in a && a.element !== undefined) {
        if (!registry.has(a.element)) issues.push(issue(2, file, `edge element ${a.element} is not registered in ids.yaml`, `${loc}/action/element`));
        else if (!declared.has(a.element)) {
          // Registered in ids.yaml but absent from this screen's `elements[]`. A WARNING while
          // exploration has not reached it, an ERROR once it has. THREE subjects can be unreached
          // and any one of them explains the gap (issue #12):
          //   (1) the SCREEN — an untouched router seed (`unexploredScreen`, above);
          //   (2) the ELEMENT — a still-`candidate` edge whose element NO capture has produced on
          //       ANY screen (`observed`). That is what a build N+1 `import-router` refresh adds to
          //       an ALREADY-EXPLORED screen when the app registered a brand-new id;
          //   (3) the CAPTURE — a still-`candidate` edge on a router-written screen whose
          //       `elements[]` predates the manifest's build (`staleCapture`, above). Same refresh,
          //       but the id is shared chrome some other screen already declares, so (2) is false
          //       and (1) cannot apply either.
          // None subsumes another, so all three stand. (2) alone would re-open #12 on first-run
          // setup, because a seed's edges routinely name that same shared chrome while the screen
          // has never been captured at all; (1) alone is what shipped and only survived the first
          // import; (3) alone would let a fresh, current capture be contradicted for ever.
          // An edge past `candidate` gets none of them: a verified edge asserts the tap happened on
          // THIS screen, so an undeclared element is a contradiction, not a gap. The "not
          // registered in ids.yaml" branch above is NEVER relaxed — that is a typo, not a gap
          // (issue #12 criterion 4).
          const unlearned: UnlearnedEdgeElementReason | undefined = unexploredScreen ? 'screen'
            : e.status !== 'candidate' ? undefined
              : !observed.has(a.element) ? 'element'
                : staleCapture ? 'refresh'
                  : undefined;
          issues.push(unlearned !== undefined
            ? issue(2, file, unlearnedEdgeElementMessage(a.element, unlearned), `${loc}/action/element`, 'warning')
            : issue(2, file, `edge element ${a.element} is not declared on this screen`, `${loc}/action/element`));
        }
      }
      if (a.type === 'dismiss_gate' && !gateIds.has(a.gate)) issues.push(issue(2, file, `edge gate ${a.gate} is not registered in ids.yaml gates[]`, `${loc}/action/gate`));
      checkConditions(file, e.preconditions, `${loc}/preconditions`, false);
      checkConditions(file, e.postconditions, `${loc}/postconditions`, false);
    });

    // ---- rule 8 ----
    issues.push(...forbiddenContentIssues(file, doc));
    if (input.staticStrings) {
      if (!isGate && doc.title !== undefined && !input.staticStrings.has(doc.title)) {
        issues.push(issue(8, file, `title ${JSON.stringify(doc.title)} is not in the static string table (07 §2.1)`, '/title', 'warning'));
      }
      doc.elements.forEach((el, ei) => {
        if (el.label !== undefined && !input.staticStrings!.has(el.label)) {
          issues.push(issue(8, file, `label ${JSON.stringify(el.label)} of ${el.id} is not in the static string table (07 §2.1)`, `/elements/${ei}/label`, 'warning'));
        }
      });
    }
  }

  // ---- rule 2: a `kind: list` element no capture has ever produced (issue #19) ----
  // SwiftUI's `List`, `Section` and `ForEach` are not accessibility elements, so the container
  // never reaches the driver and a `select {list, match}` written against it can never resolve.
  // The first real integration registered five such ids off the pilot's `invoice.list.table`
  // pattern, saw none of them in any tree, and deleted them all again. A WARNING, not an error,
  // for decision 58's reason — on a young map exploration may simply not have reached the screen
  // yet — and scoped to `kind: list`, the containers 04 §3.3's `select` addresses. The message
  // names the platform because ids.yaml is shared while this runs once per platform, and
  // `sortIssues`' dedupe would otherwise collapse a genuine per-platform difference.
  // (`observed` is computed once above the screen loop — the rule 2 edge carve-out needs it too.)
  ids.elements.forEach((e, i) => {
    if (e.kind !== 'list' || observed.has(e.id)) return;
    issues.push(issue(2, 'ids.yaml',
      `${e.id} (kind: list) is declared on no ${input.platform} screen — no capture has contained it. A SwiftUI List/Section container is not an accessibility element and never reaches the driver (01 R4, issue #19): pick a row with \`select {cell, match}\` on the row id, or delete this id`,
      `/elements/${i}`, 'warning'));
  });

  for (const [file, doc] of input.recipes) {
    (doc.entry.fallback_path ?? []).forEach((s, i) => {
      if (!knownScreen(s, false)) issues.push(issue(3, file, `fallback_path ${s}: no such screen file`, `/entry/fallback_path/${i}`));
    });
    checkConditions(file, doc.preconditions, '/preconditions', false);
    doc.steps.forEach((st, si) => {
      const loc = `/steps/${si}`;
      const el = stepElement(st);
      if (el !== undefined) {
        if (!ID_REGEX.test(el)) issues.push(issue(2, file, `${st.id}: element id ${el} violates 01 R2`, loc));
        if (!registry.has(el)) issues.push(issue(2, file, `${st.id}: element ${el} is not registered in ids.yaml`, loc));
        else if (critical(el) !== (st.intent_critical === true)) {
          issues.push(issue(6, file, `${st.id}: intent_critical ${st.intent_critical === true} must mirror ids.yaml (${critical(el)}) for ${el} (04 §3.7)`, `${loc}/intent_critical`));
        }
      }
      // issue #24: a gate control now has its own actions, so a plain `tap` naming one is a
      // mistake with teeth — guided treats the gate as blocking and auto-dismisses it (pressing
      // the SAFE escape) immediately before the step meant to press the other button.
      if (st.action === 'tap' && gateControlIds.has(st.element)) {
        issues.push(issue(2, file, `${st.id}: ${st.element} is a control of ${gateControlIds.get(st.element)} — a plain tap on it is dismissed by the runner before it happens. Use \`action: dismiss_gate\` for the safe escape, or \`action: tap_gate\` with \`control:\` for any other control (issue #24)`, `${loc}/element`));
      }
      if (st.action === 'dismiss_gate' && !gateIds.has(st.gate)) issues.push(issue(2, file, `${st.id}: gate ${st.gate} is not registered in ids.yaml gates[]`, `${loc}/gate`));
      if (st.action === 'tap_gate') {
        const gate = ids.gates.find((g) => g.id === st.gate);
        if (gate === undefined) {
          issues.push(issue(2, file, `${st.id}: gate ${st.gate} is not registered in ids.yaml gates[]`, `${loc}/gate`));
        } else if (!(gate.controls ?? []).some((c) => c.id === st.control)) {
          // naming the dismiss here is the specific mistake worth its own message: it is the one
          // control that IS registered, and pressing it does the opposite of what the step means
          const isDismiss = gate.dismiss === st.control;
          issues.push(issue(2, file, isDismiss
            ? `${st.id}: ${st.control} is ${st.gate}'s dismiss control — the safe escape. Use action: dismiss_gate to press it; tap_gate names a control from gates[].controls[] (issue #24)`
            : `${st.id}: ${st.control} is not declared in ids.yaml gates[].controls[] for ${st.gate}`, `${loc}/control`));
        }
      }
      checkExpect(file, st.expect, `${loc}/expect`, st.id, doc.params);
    });
    checkExpect(file, doc.verify, '/verify', 'verify', doc.params);
    issues.push(...unobservedParamIssues(file, doc));
    issues.push(...forbiddenContentIssues(file, doc));
  }

  return issues;
}

/**
 * Rule 9 (issue #23): a recipe must ASSERT on every parameter it declares.
 *
 * Rule 8 polices what an assertion may contain; this polices whether one exists. Without it
 * `expect.value` is merely available, and the failure the issue describes stands: a `type` step
 * whose text never reached the field, a recipe that saves whatever was already in the box, and a
 * PASS. `lifecycle.recompile` promotes on successful replays, so such a recipe keeps passing, keeps
 * being promoted and keeps being trusted.
 *
 * What counts as observing a param is `values.observedParams`: an `expect.value`/`verify.value`
 * slot, or a `select {match.text}` slot — the latter because the row is addressed BY that text at
 * replay and the step genuinely fails when nothing matches. A `type` step's slot does NOT count:
 * typing is not observing.
 *
 * Severity by status: a WARNING while `candidate` (a draft under review, and 04 §3.8 puts the
 * assertions in at review time), an ERROR at `verified`/`ci_gate` — those are claims that CI is
 * gated on something real.
 */
function unobservedParamIssues(file: string, doc: RecipeFile): ValidationIssue[] {
  const declared = doc.params ?? [];
  if (declared.length === 0) return [];
  const observed = observedParams(doc);
  const severity = doc.status === 'verified' || doc.status === 'ci_gate' ? 'error' : 'warning';
  return declared
    .filter((p) => !observed.has(p.name))
    .map((p, i) => issue(9, file,
      `parameter {${p.name}} is never asserted on: no expect.value/verify.value names it and no select matches on it, so the recipe passes whatever the app did with it (02 §10.9, issue #23). Add \`value: [{element: <the element that shows it>, equals: "{${p.name}}"}]\` to a step's expect or to verify`,
      `/params/${declared.indexOf(p) === -1 ? i : declared.indexOf(p)}/name`, severity));
}

/** `{amount}`-style parameter slots are exempt from the sweep (07 §2.3.5: slots, never values). */
const PARAM_SLOT_ANY = /\{[a-z][a-z0-9_]*\}/g;

/**
 * Pure: every PII pattern index (into `PII_PATTERNS`) that hits `text` with slots removed. The
 * patterns overlap (a card number is also a "phone", an SSN too), so all hits are reported.
 */
export function forbiddenPatternIndexes(text: string): number[] {
  const stripped = text.replace(PARAM_SLOT_ANY, '');
  return PII_PATTERNS.map((p, i) => (p.test(stripped) ? i : -1)).filter((i) => i >= 0);
}

/** names of `PII_PATTERNS` in order (07 §2.3.4) */
const PII_NAMES = ['email', 'phone number', 'card-like digit run', 'currency value', 'IBAN-like', 'SSN-like'] as const;

/** Pure: rule 8 over one document; `file` is only echoed into issues. */
export function forbiddenContentIssues(file: string, doc: ScreenFile | RecipeFile | IdsRegistry): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const sweep = (text: string | undefined, loc: string, what: string): void => {
    if (text === undefined) return;
    const hits = forbiddenPatternIndexes(text);
    if (hits.length) issues.push(issue(8, file, `${what} contains forbidden content (${hits.map((i) => PII_NAMES[i] ?? `pattern ${i}`).join(', ')}) — structure only, never data (02 §10.8, 07 §2)`, loc));
  };
  /**
   * A regex-valued field (`matches[]`, `label_regex`): sweep the source AND the source with its
   * backslash escapes removed, so `jane\.doe@example\.com` is caught exactly like the plain
   * address it encodes.
   */
  const sweepRegex = (source: string | undefined, loc: string, what: string): void => {
    if (source === undefined) return;
    sweep(source, loc, what);
    const unescaped = source.replace(/\\(.)/g, '$1');
    if (unescaped !== source && forbiddenPatternIndexes(source).length === 0) sweep(unescaped, loc, what);
  };
  /**
   * issue #23: `expect.value` may only compare against a `{param}` SLOT. A literal there is a
   * committed data value — rule 8's own subject — and a STRICTLY stronger check than the sweep
   * above: the sweep only rejects strings that look like PII, so `equals: "Acme Corp"` would sail
   * through while being exactly what 07 §2.3.5 forbids. The map stores the reference; the value
   * lives in the run.
   */
  const literalValueAssertions = (x: Expect | undefined, loc: string, what: string): void => {
    (x?.value ?? []).forEach((v, vi) => {
      const parsed = assertionOp(v);
      if (parsed === undefined || paramOfSlot(parsed.slot) !== undefined) return;
      issues.push(issue(8, file, `${what}[${vi}] ${parsed.op} ${JSON.stringify(parsed.slot)} is a literal — a value assertion may only compare against a {param} slot, so the value lives in the run and never in the map (02 §10.8, 07 §2.3.5)`, `${loc}/value/${vi}/${parsed.op}`));
    });
  };
  if ('schema_version' in doc && 'screens' in doc) {
    doc.screens.forEach((s, i) => sweep(s.title, `/screens/${i}/title`, `title of ${s.id}`));
    // `label_regex` is author-written free text like any other label (07 §2.3 rule 6 backstop)
    doc.elements.forEach((el, i) => sweepRegex(el.label_regex, `/elements/${i}/label_regex`, `label_regex of ${el.id}`));
    return issues;
  }
  if ('kind' in doc) {
    sweep(doc.title, '/title', 'title');
    (doc.signature.required_labels ?? []).forEach((rl, i) => sweep(rl.label, `/signature/required_labels/${i}/label`, 'required label'));
    doc.elements.forEach((el, ei) => {
      sweep(el.label, `/elements/${ei}/label`, `label of ${el.id}`);
      el.locators.forEach((l, li) => {
        if (l.strategy === 'text') sweep(l.value, `/elements/${ei}/locators/${li}/value`, `text locator of ${el.id}`);
        if (l.strategy === 'role_label') sweep(l.value.label, `/elements/${ei}/locators/${li}/value/label`, `role_label of ${el.id}`);
      });
      if (el.fingerprint?.label_norm !== undefined) sweep(el.fingerprint.label_norm, `/elements/${ei}/fingerprint/label_norm`, `fingerprint of ${el.id}`);
    });
    return issues;
  }
  sweep(doc.description, '/description', 'description');
  // `matches` is the highest-risk recipe field: the compiler seeds it from the raw task text
  (doc.matches ?? []).forEach((m, i) => sweepRegex(m, `/matches/${i}`, `match pattern ${i}`));
  doc.steps.forEach((st, si) => {
    if (st.action === 'type') sweep(st.text, `/steps/${si}/text`, `${st.id} text`);
    if (st.action === 'select') sweep(st.match.text, `/steps/${si}/match/text`, `${st.id} match text`);
    sweep(st.expect?.text_present, `/steps/${si}/expect/text_present`, `${st.id} text_present`);
    literalValueAssertions(st.expect, `/steps/${si}/expect`, `${st.id} expect.value`);
  });
  sweep(doc.verify.text_present, '/verify/text_present', 'verify text_present');
  literalValueAssertions(doc.verify, '/verify', 'verify.value');
  return issues;
}

/** Rule 7 for every YAML under the map; returns the non-canonical relative paths. */
export function nonCanonicalFiles(config: Pick<AppMapConfig, 'dir'>): string[] {
  const out: string[] = [];
  for (const path of walkYaml(config.dir)) {
    const kind = kindForPath(config, path);
    if (!kind) continue; // unrecognised locations are a rule 1 problem
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    if (!isCanonical(kind, text)) out.push(relative(config.dir, path).split(sep).join('/'));
  }
  return out.sort();
}

/**
 * Pure: rule 1 safe-regex check; `undefined` when `source` is acceptable.
 *
 * Rejects (07 §4, architecture §7 decision 48): sources over `MAX_REGEX_SOURCE_LENGTH`, sources
 * that do not compile, and nested unbounded quantifiers — a group that contains an unbounded
 * quantifier (`+`, `*`, `{n,}`) and is itself unboundedly quantified (`(a+)+`, `(a*)*`,
 * `(a|b+){2,}`), or an unboundedly quantified alternation whose literal branches overlap
 * (`(a|aa)+`). Bounded quantifiers (`?`, `{n}`, `{n,m}`) never nest catastrophically on their own.
 */
export function safeRegexIssue(source: string): string | undefined {
  if (source.length > MAX_REGEX_SOURCE_LENGTH) return `is ${source.length} chars; the limit is ${MAX_REGEX_SOURCE_LENGTH} (07 §4)`;
  try {
    new RegExp(source);
  } catch (e) {
    return `does not compile: ${(e as Error).message}`;
  }
  interface Frame { start: number; unbounded: boolean; branches: string[]; current: string; literal: boolean }
  const stack: Frame[] = [{ start: 0, unbounded: false, branches: [], current: '', literal: true }];
  let inClass = false;
  const unboundedAt = (i: number): boolean => {
    const c = source[i];
    if (c === '+' || c === '*') return true;
    if (c === '{') {
      const m = /^\{(\d+),\}/.exec(source.slice(i));
      return m !== null;
    }
    return false;
  };
  const quantifierEnd = (i: number): number => {
    // index just past the quantifier starting at i (`+`, `*`, `?`, `{n}`, `{n,}`, `{n,m}`), plus a lazy `?`
    let j = i;
    if (source[j] === '{') {
      const m = /^\{\d+(,\d*)?\}/.exec(source.slice(j));
      if (!m) return i;
      j += m[0].length;
    } else j += 1;
    if (source[j] === '?') j += 1;
    return j;
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    const top = stack[stack.length - 1]!;
    if (c === '\\') {
      top.current += source.slice(i, i + 2);
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      top.literal = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      top.literal = false;
      continue;
    }
    if (c === '(') {
      stack.push({ start: i, unbounded: false, branches: [], current: '', literal: true });
      // skip group modifiers `(?:`, `(?=`, `(?!`, `(?<name>` … — they never count as content
      const mod = /^\(\?(?::|=|!|<=|<!|<[A-Za-z_][A-Za-z0-9_]*>)/.exec(source.slice(i));
      if (mod) i += mod[0].length - 1;
      continue;
    }
    if (c === '|') {
      top.branches.push(top.current);
      top.current = '';
      continue;
    }
    if (c === ')') {
      const closed = stack.pop();
      if (!closed) continue;
      closed.branches.push(closed.current);
      const parent = stack[stack.length - 1]!;
      parent.literal = false;
      const next = i + 1;
      if (next < source.length && unboundedAt(next)) {
        const groupSrc = source.slice(closed.start, next);
        if (closed.unbounded) return `nests unbounded quantifiers (${groupSrc}${source.slice(next, quantifierEnd(next))}) — catastrophic backtracking risk (07 §4)`;
        if (closed.literal && closed.branches.length > 1 && branchesOverlap(closed.branches)) {
          return `quantifies overlapping alternatives (${groupSrc}${source.slice(next, quantifierEnd(next))}) — catastrophic backtracking risk (07 §4)`;
        }
        parent.unbounded = true; // an unbounded quantifier now lives inside the parent
        i = quantifierEnd(next) - 1;
      }
      continue;
    }
    if (c === '+' || c === '*' || c === '{' || c === '?') {
      if (c === '{' && !/^\{\d+(,\d*)?\}/.test(source.slice(i))) {
        top.current += c;
        continue;
      }
      if (unboundedAt(i)) top.unbounded = true;
      top.literal = false;
      i = quantifierEnd(i) - 1;
      continue;
    }
    if (c === '.' || c === '^' || c === '$') top.literal = false;
    top.current += c;
  }
  return undefined;
}

/** `(a|aa)+`-style: one literal branch is a prefix of another (or they are equal). */
function branchesOverlap(branches: string[]): boolean {
  for (let i = 0; i < branches.length; i++) {
    for (let j = 0; j < branches.length; j++) {
      if (i === j) continue;
      const a = branches[i]!;
      const b = branches[j]!;
      if (a.length > 0 && b.startsWith(a)) return true;
    }
  }
  return false;
}

/** Human-readable, one issue per line: `<file>[:<location>] rule <n>: <message>` — CI output (06 §4). */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues
    .map((i) => `${i.file}${i.location ? `:${i.location}` : ''} rule ${i.rule}: ${i.severity === 'warning' ? 'warning: ' : ''}${i.message}`)
    .join('\n');
}
