/**
 * [A1] `app-map validate` — 02 §10 rules 1–8 (06 R1 blocks the PR on any error).
 *
 *  1. every file validates against its JSON Schema (yaml/schemas.ts); plus a safe-regex check
 *     on every user-authored regex source (`matches[]`, `label_regex`): ≤200 chars, no nested
 *     quantifiers (`(a+)+`, `(a*)*`, `(a|aa)+`-style) — `safeRegexIssue` (07 §4 malicious YAML)
 *  2. every element id, screen id, gate id exists in ids.yaml (gate dismiss controls count as
 *     registered via `gates[].dismiss`; screen markers via `screens[].id`); an edge
 *     `action.element` must also be DECLARED on its own screen — a WARNING instead of an error
 *     while that screen is `meta.status: candidate` with `elements: []` (a router-export seed
 *     exploration has not reached yet, 01 R6/03 §5, issue #12), an error everywhere else; an
 *     element missing from ids.yaml entirely stays an error on every screen; element ids in
 *     screen files match `ID_REGEX` (2+ segments; `ELEMENT_ID_REGEX` applies to ids.yaml only);
 *     when ids.yaml carries `title`/`deep_link` for a screen they must agree with the screen
 *     file's — `title` exactly, `deep_link` on `routeKey` (query stripped: the registry records
 *     the route, the screen file may add `?fixture=…`, 01 R5); `indexMap` serves the screen
 *     file's values (two sources of truth otherwise — `plan_path`, `routes`, drift); and a
 *     WARNING for a registered `kind: list` element that no screen file records as observed —
 *     a SwiftUI list container is not an accessibility element, so it never reaches the driver
 *     and a `select {list, match}` against it can never resolve (01 R4, issue #19)
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
 *     SSN-like (`scrub.ts` PII_PATTERNS); `{param}` slots are exempt. Also a WARNING when a
 *     `title` or element `label` is not in `.local/strings.<platform>.txt` while that file
 *     exists (07 §2.1: static copy must exist in the app's string tables); gates carry no
 *     `title` (architecture §7 decision 33)
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
import type { Condition, ElementId, Expect, IdsElement, IdsRegistry, RecipeFile, ScreenFile, ValidateResult, ValidationIssue } from './types.ts';
import { ID_REGEX, PREVIOUS_SCREEN, markerOfScreen, routeKey, stepElement, unlearnedEdgeElementMessage } from './types.ts';
import { AppMapError } from './errors.ts';
import { allowlistFile, idsFile, kindForPath, manifestFile, recipesDir, schemaDir, screensDir, stringsFile } from './paths.ts';
import type { YamlKind } from './paths.ts';
import { PII_PATTERNS } from './scrub.ts';
import { isCanonical, parseYamlText } from './yaml/canonical.ts';
import { validateAgainstSchema } from './yaml/schemas.ts';

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
    try {
      doc = parseYamlText(text, file);
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
      for (const si of schemaIssues) issues.push(issue(1, file, `${si.message}${si.params ? ' ' + JSON.stringify(si.params) : ''}`, si.path));
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
    const manifest = readChecked<{ platform: string }>(mPath, 'manifest');
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
      const input: CrossRefInput = { platform, ids, screens, recipes };
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
}

/**
 * Every element id some screen FILE records as present on that screen: `elements[]`,
 * `signature.required_ids`, `dynamic_regions` and each variant's `required_ids`. `observe`'s
 * `nameScreen` builds all four out of `idsPresent(snapshot)` — a real capture — so together they
 * are the map's committed, durable record of "a driver has seen this id in a tree", and the
 * SQLite cache adds nothing (its `hits` counter only counts elements a driver call TOUCHED, and
 * a container is never touched: you tap its cells). Edge `action.element` is excluded on purpose:
 * `import-router` seeds edges for elements exploration has never reached (01 R6, issue #12),
 * which is the absence of evidence rather than evidence.
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
  // gate dismiss controls are registered through gates[].dismiss (architecture §7 decision 2)
  for (const g of ids.gates) registry.set(g.dismiss, { id: g.dismiss, kind: 'button', intent_critical: false, dynamic: false });
  const idsScreenById = new Map(ids.screens.map((s) => [s.id, s]));
  // rule 8 over the registry itself (screen titles); validateMap dedupes it across platforms
  issues.push(...forbiddenContentIssues('ids.yaml', ids));

  // screen files by id (kind screen only — rule 3 targets are screens; gates are dismissed, never navigated to)
  const screenFilesById = new Set<string>();
  const gateFilesById = new Set<string>();
  for (const s of input.screens.values()) (s.kind === 'gate' ? gateFilesById : screenFilesById).add(s.id);
  const knownScreen = (id: string, allowPrevious: boolean): boolean => screenFilesById.has(id) || (allowPrevious && id === PREVIOUS_SCREEN);
  const critical = (id: string): boolean => registry.get(id)?.intent_critical === true; // absent = false (decision 26)

  const checkExpect = (file: string, x: Expect | undefined, loc: string): void => {
    if (!x) return;
    if (x.screen !== undefined && !knownScreen(x.screen, false)) issues.push(issue(3, file, `expect.screen ${x.screen}: no such screen file`, `${loc}/screen`));
    for (const id of [x.focused, ...(x.visible ?? []), ...(x.not_visible ?? [])]) {
      if (id !== undefined && !registry.has(id)) issues.push(issue(2, file, `element ${id} is not registered in ids.yaml`, loc));
    }
  };
  const checkConditions = (file: string, cs: Condition[] | undefined, loc: string, allowPrevious: boolean): void => {
    (cs ?? []).forEach((c, i) => {
      if (c.screen !== undefined && !knownScreen(c.screen, allowPrevious)) issues.push(issue(3, file, `condition screen ${c.screen}: no such screen file`, `${loc}/${i}/screen`));
    });
  };

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
    // 02 §10 rule 2 carve-out (issue #12): a screen the router export seeded carries the app's
    // edges and nothing else — `elements: []` is by design until exploration learns them, and
    // erroring makes the seed unloadable before exploration can start. The moment ONE element is
    // known the screen HAS been observed, so a still-undeclared edge element is a real gap again;
    // and a screen past `candidate` is past the point where "not learned yet" explains anything.
    // Both conditions, not either. `meta` is schema-required, so no optional chaining.
    const unexplored = doc.elements.length === 0 && doc.meta.status === 'candidate';
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
      if ('element' in a && a.element !== undefined) {
        if (!registry.has(a.element)) issues.push(issue(2, file, `edge element ${a.element} is not registered in ids.yaml`, `${loc}/action/element`));
        else if (!declared.has(a.element)) {
          // registered in ids.yaml but absent from this screen's `elements[]`: a warning only on an
          // unexplored candidate (above), an error everywhere else. The "not registered in ids.yaml"
          // branch above is NEVER relaxed — that is a typo, not a gap (issue #12 criterion 4).
          issues.push(unexplored
            ? issue(2, file, unlearnedEdgeElementMessage(a.element), `${loc}/action/element`, 'warning')
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
  const observed = observedElementIds(input.screens.values());
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
      if (st.action === 'dismiss_gate' && !gateIds.has(st.gate)) issues.push(issue(2, file, `${st.id}: gate ${st.gate} is not registered in ids.yaml gates[]`, `${loc}/gate`));
      checkExpect(file, st.expect, `${loc}/expect`);
    });
    checkExpect(file, doc.verify, '/verify');
    issues.push(...forbiddenContentIssues(file, doc));
  }

  return issues;
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
  });
  sweep(doc.verify.text_present, '/verify/text_present', 'verify text_present');
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
