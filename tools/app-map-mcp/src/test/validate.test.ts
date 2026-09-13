/**
 * [A1] `app-map validate` — 02 §10 rules 1–8, one positive and one negative case each, plus the
 * file-level checks (02 §2.1) and the 07 §2.1 string-table warning.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import type { ElementDef, IdsRegistry, RecipeFile, ScreenFile, ValidationIssue } from '../types.ts';
import { isUnlearnedEdgeElement } from '../types.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { loadMap } from '../yaml/load.ts';
import type { YamlKind } from '../paths.ts';
import { crossReferenceIssues, forbiddenContentIssues, formatIssues, nonCanonicalFiles, safeRegexIssue, validateMap } from '../validate.ts';
import { PILOT_APP_MAP_DIR, loadRouterExportFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

/** parse → mutate → write canonically (so rule 7 stays quiet unless the test wants it) */
function editYaml<T>(t: TempAppMapDir, rel: string, kind: YamlKind, fn: (doc: T) => void): void {
  const p = join(t.dir, rel);
  const doc = parse(readFileSync(p, 'utf8')) as T;
  fn(doc);
  writeFileSync(p, canonicalYaml(kind, doc));
}
const errors = (issues: ValidationIssue[], rule?: ValidationIssue['rule']): ValidationIssue[] => issues.filter((i) => i.severity === 'error' && (rule === undefined || i.rule === rule));
const rulesHit = (issues: ValidationIssue[]): number[] => [...new Set(errors(issues).map((i) => i.rule))].sort();

describe('validateMap on the pilot (positive cases)', () => {
  it('passes every rule with zero errors on both platforms', () => {
    const t = makeTempAppMapDir();
    try {
      const r = validateMap(t.config);
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
      assert.ok(r.ok);
      assert.equal(r.files_checked, 20, 'ids + allowlist + 2 × (manifest + 7 screens + 1 recipe)');
      // every warning is a rule 8 string-table warning (07 §2.1), never an error
      for (const w of r.issues) assert.equal(w.rule, 8, formatIssues([w]));
    } finally {
      t.cleanup();
    }
  });

  it('checks the committed repo copy too (read-only) and limits to one platform on request', () => {
    const config = { ...makeTempAppMapDir({ copyPilot: false }).config, dir: PILOT_APP_MAP_DIR };
    const r = validateMap(config, { platforms: ['android'] });
    assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
    assert.equal(r.files_checked, 11);
  });
});

describe('rule 2 — `expect.focused` on a platform whose driver reports no focus (issue #18)', () => {
  it('warns, naming the step, when a platform: ios recipe expects focus Argent never reports', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => { d.steps[0]!.expect = { focused: 'invoice.amount.field' }; });
      const r = validateMap(t.config, { platforms: ['ios'] });
      const warned = r.issues.filter((i) => i.rule === 2 && i.severity === 'warning' && i.message.includes('expect.focused'));
      assert.equal(warned.length, 1, formatIssues(r.issues));
      assert.equal(warned[0]!.file, 'ios/recipes/create_invoice.yaml');
      assert.equal(warned[0]!.location, '/steps/0/expect/focused');
      assert.match(warned[0]!.message, /^s1: /, 'the step the author has to go and fix');
      assert.match(warned[0]!.message, /can never be satisfied on ios/);
      assert.match(warned[0]!.message, /Android\/Maestro-only/);
      assert.match(warned[0]!.message, /visible: \[invoice\.amount\.field\]/, 'and what to write instead');
      // a warning, never an error: the file is well-formed and Maestro satisfies it, so 06 R1
      // must not block the PR and recipe.schema.json keeps accepting the key
      assert.ok(r.ok);
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('stays silent on android, where the Maestro hierarchy carries a `focused` attribute (04 §10)', () => {
    const t = makeTempAppMapDir({ platform: 'android' });
    try {
      // guard the premise: the android pilot legitimately keeps `focused`, so this test fails
      // loudly if someone strips it along with the ios one
      const android = parse(readFileSync(join(t.dir, 'android/recipes/create_invoice.yaml'), 'utf8')) as RecipeFile;
      assert.deepEqual(android.steps[0]!.expect, { focused: 'invoice.amount.field' });
      const r = validateMap(t.config, { platforms: ['android'] });
      assert.deepEqual(r.issues.filter((i) => i.message.includes('expect.focused')), [], formatIssues(r.issues));
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('the shipped ios pilot no longer teaches the pattern (issue #18 acceptance criterion 2)', () => {
    const t = makeTempAppMapDir({ copyPilot: false });
    try {
      const r = validateMap({ ...t.config, dir: PILOT_APP_MAP_DIR }, { platforms: ['ios'] });
      assert.deepEqual(r.issues.filter((i) => i.message.includes('expect.focused')), [], formatIssues(r.issues));
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 2 — a `kind: list` element no capture has ever produced (issue #19)', () => {
  it('warns on a registered kind: list element that no screen file declares', () => {
    const t = makeTempAppMapDir();
    try {
      // the five ids the first real SwiftUI integration registered and then deleted again: the
      // container is not an accessibility element, so no capture ever contained it
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.elements.push({ id: 'people.list.table', kind: 'list', dynamic: true }); });
      const r = validateMap(t.config, { platforms: ['ios'] });
      const warned = r.issues.filter((i) => i.rule === 2 && i.severity === 'warning' && i.message.includes('people.list.table'));
      assert.equal(warned.length, 1, formatIssues(r.issues));
      assert.equal(warned[0]!.file, 'ids.yaml');
      assert.match(warned[0]!.message, /never reaches the driver/);
      assert.match(warned[0]!.message, /select \{cell, match\}/);
      // a warning, never an error: on a young map exploration may just not have got there yet
      assert.ok(r.ok);
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('does not warn for a list a screen declares in elements[], nor for one only a variant requires', () => {
    const t = makeTempAppMapDir();
    try {
      // `invoice.list.table`, `client.picker.list` and `invoice.detail.items.list` are in
      // `elements[]`; `invoice.list.collection` appears ONLY in a variant's `required_ids`, and
      // that is a capture-derived section too, so it counts as observed
      const r = validateMap(t.config);
      assert.deepEqual(r.issues.filter((i) => i.rule === 2 && i.severity === 'warning'), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('the rule is about containers: an unobserved `kind: cell` id is not warned', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.elements.push({ id: 'people.list.cell', kind: 'cell', dynamic: true }); });
      const r = validateMap(t.config, { platforms: ['ios'] });
      assert.deepEqual(r.issues.filter((i) => i.rule === 2 && i.message.includes('people.list.cell')), [], formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('a `select {cell, match}` step validates and its cell is cross-referenced like any step element', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => {
        d.steps[3] = { id: 's4', action: 'select', cell: 'client.picker.cell', match: { text: '{client}' }, expect: { screen: 'invoice_new' } };
      });
      const ok = validateMap(t.config);
      assert.deepEqual(errors(ok.issues), [], formatIssues(ok.issues));
      assert.ok(ok.ok);
      // ... and an unregistered cell is the same rule 2 error the `list` form gets
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => { (d.steps[3] as { cell: string }).cell = 'client.picker.nope'; });
      const bad = validateMap(t.config);
      const hit = errors(bad.issues, 2).find((i) => i.message.includes('client.picker.nope'));
      assert.ok(hit, formatIssues(bad.issues));
      assert.match(hit.message, /^s4: /);
      assert.equal(hit.file, 'ios/recipes/create_invoice.yaml');
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 1 — schema + safe regex + file layout', () => {
  it('flags a schema violation with its JSON pointer', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { (d.elements[0] as { status: string }).status = 'bogus'; });
      const r = validateMap(t.config);
      assert.ok(!r.ok);
      const hit = errors(r.issues, 1).find((i) => i.file === 'ios/screens/login.yaml');
      assert.ok(hit, formatIssues(r.issues));
      assert.equal(hit.location, '/elements/0/status');
    } finally {
      t.cleanup();
    }
  });

  it('rejects nested quantifiers and over-long sources in matches[] and label_regex', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => { d.matches = ['(a+)+']; });
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.elements[0]!.label_regex = '(x*)*'; });
      editYaml<ScreenFile>(t, 'ios/screens/gate.push_permission.yaml', 'screen', (d) => { d.signature.required_labels![0]!.label_regex = '(a|aa)+'; });
      const r = validateMap(t.config);
      const files = errors(r.issues, 1).map((i) => `${i.file}:${i.location}`);
      assert.ok(files.includes('ios/recipes/create_invoice.yaml:/matches/0'), formatIssues(r.issues));
      assert.ok(files.includes('ids.yaml:/elements/0/label_regex'), formatIssues(r.issues));
      assert.ok(files.includes('ios/screens/gate.push_permission.yaml:/signature/required_labels/0/label_regex'), formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('safeRegexIssue accepts the pilot patterns and rejects the 07 §4 shapes', () => {
    for (const ok of ['(create|new|make)( an?)? invoice', 'bill (a |the )?(client|customer)', '^(Allow|Don.t Allow)$', '^Don.t Allow$', '^\\d+ invoices?$', '(?:ab)+c', '(\\d+ )?items', 'a{2,5}', '(a|b)+', '[a-z]+(\\.[a-z]+)?']) assert.equal(safeRegexIssue(ok), undefined, ok);
    // `(\.[a-z]+)*` is harmless in practice but is a nested unbounded quantifier by the 07 §4 rule — rejected on purpose
    for (const bad of ['(a+)+', '(a*)*', '(a|aa)+', '(a+){2,}', '((ab)*)+', '[a-z]+(\\.[a-z]+)*', 'x'.repeat(201), '(unclosed']) assert.ok(safeRegexIssue(bad), bad);
    assert.match(safeRegexIssue('x'.repeat(201))!, /200/);
    assert.match(safeRegexIssue('(unclosed')!, /compile/);
  });

  it('flags file name ≠ id, recipe platform ≠ directory, unparseable YAML and stray files', () => {
    const t = makeTempAppMapDir();
    try {
      writeFileSync(join(t.dir, 'ios/screens/copy_of_login.yaml'), readFileSync(join(t.dir, 'ios/screens/login.yaml')));
      editYaml<RecipeFile>(t, 'android/recipes/create_invoice.yaml', 'recipe', (d) => { d.platform = 'ios'; });
      writeFileSync(join(t.dir, 'ios/screens/invoice_new.yaml'), 'id: [\n');
      writeFileSync(join(t.dir, 'stray.yaml'), 'a: 1\n');
      const r = validateMap(t.config);
      const msgs = errors(r.issues, 1).map((i) => `${i.file} ${i.message}`).join('\n');
      assert.match(msgs, /copy_of_login\.yaml id login must equal the file name/);
      assert.match(msgs, /android\/recipes\/create_invoice\.yaml platform ios must equal/);
      assert.match(msgs, /invoice_new\.yaml .*not valid YAML/);
      assert.match(msgs, /stray\.yaml YAML file in an unrecognised location/);
      assert.equal(rulesHit(r.issues).includes(1), true);
    } finally {
      t.cleanup();
    }
  });

  it('never throws: a missing ids.yaml or map directory is an issue', () => {
    const t = makeTempAppMapDir();
    try {
      rmSync(join(t.dir, 'ids.yaml'));
      const r = validateMap(t.config);
      assert.ok(!r.ok && errors(r.issues, 1).some((i) => i.file === 'ids.yaml'));
      const gone = validateMap({ ...t.config, dir: join(t.dir, 'nope') });
      assert.ok(!gone.ok && gone.files_checked === 0);
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 2 — every id is registered in ids.yaml', () => {
  it('a renamed id without migrate-id lists every dangling reference (06 §5)', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.elements.find((e) => e.id === 'invoice.add.button')!.id = 'invoice.create.button'; });
      const r = validateMap(t.config);
      const dangling = errors(r.issues, 2).filter((i) => i.message.includes('invoice.add.button'));
      assert.ok(dangling.length >= 4, formatIssues(r.issues));
      assert.ok(dangling.some((i) => i.file === 'ios/screens/invoice_list.yaml' && i.location === '/elements/0/id'));
      assert.ok(dangling.some((i) => i.file === 'ios/screens/invoice_list.yaml' && i.location?.startsWith('/signature/required_ids/')));
      assert.ok(dangling.some((i) => i.file === 'android/screens/invoice_list.yaml'));
    } finally {
      t.cleanup();
    }
  });

  it('a screen file whose deep_link route or title differs from ids.yaml (decision 34), query allowed', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.deep_link = 'appmap://signin'; d.title = 'Log In'; });
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => { d.deep_link = 'appmap://invoice_list?fixture=many'; });
      const r = validateMap(t.config);
      const login = errors(r.issues, 2).filter((i) => i.file === 'ios/screens/login.yaml').map((i) => i.location);
      assert.ok(login.includes('/deep_link') && login.includes('/title'), formatIssues(r.issues));
      assert.ok(!errors(r.issues).some((i) => i.file === 'ios/screens/invoice_list.yaml'), 'query-only difference is fine (01 R5)');
    } finally {
      t.cleanup();
    }
  });

  it('a marker that is not screen.<own id>, and an element dynamic in ids.yaml but not in the screen file', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.signature.marker = 'screen.invoice_list'; });
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => { delete d.elements.find((e) => e.id === 'invoice.list.table')!.dynamic; });
      const r = validateMap(t.config);
      const m = errors(r.issues, 2).map((i) => `${i.file}:${i.location}`);
      assert.ok(m.includes('ios/screens/login.yaml:/signature/marker'), formatIssues(r.issues));
      assert.ok(m.some((x) => x.startsWith('ios/screens/invoice_list.yaml:/elements/') && x.endsWith('/dynamic')), formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('unregistered screen / gate / dismiss / dynamic-region ids, and a non-01 R2 element id (crossReferenceIssues)', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => { d.gates = ['gate.unknown']; d.dynamic_regions = ['invoice.ghost.list']; });
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.screens = d.screens.filter((s) => s.id !== 'client_picker'); d.gates = d.gates.filter((g) => g.id !== 'gate.biometric_prompt'); });
      const r = validateMap(t.config);
      const m = errors(r.issues, 2).map((i) => `${i.file}:${i.location}`);
      assert.ok(m.includes('ios/screens/invoice_list.yaml:/gates/0'), formatIssues(r.issues));
      assert.ok(m.includes('ios/screens/invoice_list.yaml:/dynamic_regions/0'));
      assert.ok(m.includes('ios/screens/client_picker.yaml:/id'));
      assert.ok(m.includes('ios/screens/gate.biometric_prompt.yaml:/id'));
      assert.ok(m.some((x) => x.startsWith('ios/screens/gate.biometric_prompt.yaml:/elements/')), 'the dismiss control of an unregistered gate is unregistered too');
    } finally {
      t.cleanup();
    }
    // ID_REGEX applies to screen-file ids (2+ segments); the schema shares the pattern so go through the pure API
    const ids: IdsRegistry = { schema_version: 1, screens: [{ id: 'x' }], gates: [], elements: [{ id: 'a.b.c', kind: 'button' }] };
    const screen: ScreenFile = { id: 'x', kind: 'screen', deep_link: 'none', signature: { marker: 'screen.x' }, elements: [{ id: 'Bad', role: 'button', status: 'candidate', locators: [{ strategy: 'a11y_id', value: 'Bad', weight: 1 }, { strategy: 'path', value: 'button', weight: 0.25 }] }], edges: [], meta: { sources: ['manual'], status: 'candidate' } };
    const issues = crossReferenceIssues({ platform: 'ios', ids, screens: new Map([['ios/screens/x.yaml', screen]]), recipes: new Map() });
    assert.ok(issues.some((i) => i.rule === 2 && /01 R2/.test(i.message)), formatIssues(issues));
  });
});

describe('rule 2 — a router-export seed warns until exploration learns its elements (02 §10 rule 2, issue #12)', () => {
  /** Exactly what `router-import.routerScreenToScreenFile` writes: the app's edges, nothing learned. */
  const seededScreen = (over: Partial<ScreenFile> = {}): ScreenFile => ({
    id: 'settings',
    kind: 'screen',
    title: 'Settings',
    deep_link: 'appmap://settings',
    signature: { marker: 'screen.settings', route: 'appmap://settings', nav_class: 'SettingsView' },
    elements: [],
    edges: [
      { action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list', status: 'candidate' },
      { action: { type: 'tap', element: 'invoice.list.cell' }, to: 'invoice_detail', status: 'candidate' },
    ],
    meta: { sources: ['router_export'], status: 'candidate' },
    ...over,
  });
  /** the pilot registry plus `settings`, so only the EDGE ELEMENTS are undeclared, never unregistered */
  const idsWithSettings = (): IdsRegistry => ({
    schema_version: 1,
    screens: [{ id: 'invoice_detail' }, { id: 'invoice_list' }, { id: 'settings', title: 'Settings', deep_link: 'appmap://settings' }],
    gates: [],
    elements: [{ id: 'invoice.add.button', kind: 'button' }, { id: 'invoice.list.cell', kind: 'cell', dynamic: true }],
  });
  /** an element as an already-explored neighbour declares it (role/dynamic taken from the registry) */
  const declaredAs = (id: string): ElementDef => {
    const reg = idsWithSettings().elements.find((e) => e.id === id)!;
    return {
      id,
      role: reg.kind as ElementDef['role'],
      ...(reg.dynamic === true ? { dynamic: true } : {}),
      status: 'verified',
      locators: [{ strategy: 'a11y_id', value: id, weight: 1 }, { strategy: 'path', value: `${reg.kind}[0]`, weight: 0.25 }],
    };
  };
  /**
   * A neighbouring screen. `declares` are the element ids it records as PRESENT, which is the set
   * rule 2's carve-out reads ("has any capture ever produced this id?"). It DEFAULTS TO NOTHING on
   * purpose: which neighbour declares what decides the severity of half the cases below, so every
   * test that depends on it says so at its own call site rather than inheriting it from here.
   */
  const stub = (id: string, declares: string[] = []): ScreenFile => ({
    id, kind: 'screen', deep_link: `appmap://${id}`, signature: { marker: `screen.${id}` },
    elements: declares.map(declaredAs), edges: [],
    meta: declares.length > 0 ? { sources: ['exploration'], status: 'verified' } : { sources: ['manual'], status: 'candidate' },
  });
  /**
   * `neighbours`: what the already-explored `invoice_list` next door declares (see `stub`).
   * `build`: the build `manifest.yaml` names, which rule 2's third subject compares against a
   * screen's `meta.last_verified_build`. Omitted, as the pilot's own manifest is not, it stays
   * undefined and that subject never fires.
   */
  const crossRef = (screen: ScreenFile, opts: { neighbours?: string[]; build?: string } = {}): ValidationIssue[] => crossReferenceIssues({
    platform: 'ios',
    ids: idsWithSettings(),
    screens: new Map([['ios/screens/settings.yaml', screen], ['ios/screens/invoice_list.yaml', stub('invoice_list', opts.neighbours ?? [])], ['ios/screens/invoice_detail.yaml', stub('invoice_detail')]]),
    recipes: new Map(),
    ...(opts.build !== undefined ? { build: opts.build } : {}),
  });
  const edgeElementIssues = (issues: ValidationIssue[]): ValidationIssue[] => issues.filter((i) => i.rule === 2 && i.location?.endsWith('/action/element') === true);
  /** the seed on disk in a pilot copy, registered in ids.yaml so the elements are the only gap */
  const writeSeed = (t: TempAppMapDir, screen: ScreenFile): void => {
    editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => {
      d.screens.push({ id: 'settings', title: 'Settings', deep_link: 'appmap://settings' });
      d.screens.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    });
    writeFileSync(join(t.dir, 'ios/screens/settings.yaml'), canonicalYaml('screen', screen));
  };

  it('a candidate screen with no elements warns instead of erroring, and the map still loads (issue #12 criterion 1)', () => {
    const t = makeTempAppMapDir();
    try {
      writeSeed(t, seededScreen());
      const r = validateMap(t.config, { platforms: ['ios'] });
      assert.deepEqual(errors(r.issues), [], formatIssues(r.issues));
      assert.ok(r.ok, 'a seed that has never been explored must not fail validate');
      const warned = edgeElementIssues(r.issues);
      assert.equal(warned.length, 2, formatIssues(r.issues));
      assert.deepEqual(warned.map((i) => i.location), ['/edges/0/action/element', '/edges/1/action/element']);
      for (const w of warned) assert.equal(w.severity, 'warning', formatIssues([w]));
      assert.ok(warned[0]!.message.includes('invoice.add.button') && warned[1]!.message.includes('invoice.list.cell'), formatIssues(warned));
      // and the loader agrees: it throws on errors only, and carries the warnings (issue #12)
      const map = loadMap(t.config);
      assert.ok(map.screens.has('settings'));
      assert.equal(map.validationWarnings.filter(isUnlearnedEdgeElement).length, 2);
    } finally {
      t.cleanup();
    }
  });

  /** the seed once ONE element is known, so the SCREEN subject (`elements: []`) no longer applies */
  const partlyLearned = (): ScreenFile => seededScreen({
    elements: [{ id: 'invoice.add.button', role: 'button', label: 'New Invoice', status: 'candidate', locators: [{ strategy: 'a11y_id', value: 'invoice.add.button', weight: 1 }, { strategy: 'path', value: 'button[0]', weight: 0.25 }] }],
  });

  it('errors again for the other edge element once ONE element is declared, when a capture HAS produced it elsewhere', () => {
    // Was "…once ONE element is declared" full stop, which is how the first #12 fix behaved: the
    // screen subject was the only one, so losing it meant a hard error whatever the element was.
    // It needs the neighbour to declare `invoice.list.cell` now — see the test below for the half
    // of this case that became hole (b) and is deliberately no longer an error.
    const issues = edgeElementIssues(crossRef(partlyLearned(), { neighbours: ['invoice.add.button', 'invoice.list.cell'] }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error');
    assert.equal(issues[0]!.location, '/edges/1/action/element');
    assert.equal(issues[0]!.message, 'edge element invoice.list.cell is not declared on this screen');
    assert.equal(isUnlearnedEdgeElement(issues[0]!), false, 'an observed screen is past "not learned yet"');
  });

  it('…but WARNS there when no capture has produced it anywhere — one learned element is not exploration reaching this one (issue #12 hole b)', () => {
    // The same screen and the same edge as above with ONE thing changed: nothing in the map
    // declares `invoice.list.cell`. `name_screen` learns a screen's ids one capture at a time and
    // `import-router` keeps appending the app's newer edges to it, so "this screen has SOME
    // element" never meant "exploration reached THIS element". Erroring here is #12's cycle.
    const issues = edgeElementIssues(crossRef(partlyLearned()));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'warning', formatIssues(issues));
    assert.equal(issues[0]!.location, '/edges/1/action/element');
    assert.ok(isUnlearnedEdgeElement(issues[0]!), formatIssues(issues));
    assert.match(issues[0]!.message, /no capture has produced this id on any screen/, issues[0]!.message);
  });

  it('a screen past candidate with elements: [] errors for an element some capture HAS produced', () => {
    // `verified` and `retired` are both past the point where the SCREEN subject explains anything;
    // with both edge elements observed next door, neither of the other two subjects applies either.
    for (const status of ['verified', 'retired'] as const) {
      const issues = edgeElementIssues(crossRef(seededScreen({ meta: { sources: ['router_export'], status } }), { neighbours: ['invoice.add.button', 'invoice.list.cell'] }));
      assert.equal(issues.length, 2, `${status}: ${formatIssues(issues)}`);
      for (const i of issues) assert.equal(i.severity, 'error', `${status}: ${formatIssues([i])}`);
    }
  });

  it('a screen past candidate with elements: [] still WARNS for an element no capture has produced (issue #12 hole b)', () => {
    // Where the old blanket claim — "verified and retired are both beyond not-learned-yet" — stopped
    // being true. The screen is past `candidate`, so the seed carve-out is off, but the ELEMENT is
    // still unreached and that is the subject rule 2 answers to.
    for (const status of ['verified', 'retired'] as const) {
      const issues = edgeElementIssues(crossRef(seededScreen({ meta: { sources: ['router_export'], status } })));
      assert.equal(issues.length, 2, `${status}: ${formatIssues(issues)}`);
      for (const i of issues) assert.ok(isUnlearnedEdgeElement(i), `${status}: ${formatIssues([i])}`);
    }
  });

  // ---- the carve-out's other two subjects: the element and the capture, not the screen ----
  // (issue #12 holes (b) and (c) — a build N+1 `import-router` refresh of an EXPLORED screen)

  /** an already-explored screen: `name_screen` learned `invoice.add.button` from a capture on 4412 */
  const exploredScreen = (edges: ScreenFile['edges'], over: Partial<ScreenFile> = {}): ScreenFile => seededScreen({
    elements: [{ id: 'invoice.add.button', role: 'button', label: 'New Invoice', status: 'verified', locators: [{ strategy: 'a11y_id', value: 'invoice.add.button', weight: 1 }, { strategy: 'path', value: 'button[0]', weight: 0.25 }] }],
    edges,
    meta: { sources: ['exploration', 'router_export'], status: 'verified', last_verified_build: '4412' },
    ...over,
  });
  const tapCell = (status: 'candidate' | 'verified'): ScreenFile['edges'][number] => ({ action: { type: 'tap', element: 'invoice.list.cell' }, to: 'invoice_detail', status });

  it('a new candidate edge on an ALREADY-EXPLORED screen warns when no capture has ever produced its element (issue #12 hole b)', () => {
    // Build N+1: `mergeRouterScreen` appends the new build's edge and never touches `elements[]`
    // or `meta.status`, so the screen is `verified` and non-empty — neither half of the original
    // carve-out applies and rule 2 hard-errored, on every app's SECOND build. The capture is
    // CURRENT here (4412 both sides), so the ELEMENT is the only subject that can be doing the work.
    const explored = exploredScreen([
      { action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list', status: 'verified' },
      tapCell('candidate'),
    ]);
    // `invoice.list.cell` is registered in ids.yaml and declared on NO screen in this map
    const issues = edgeElementIssues(crossRef(explored, { neighbours: ['invoice.add.button'], build: '4412' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'warning', formatIssues(issues));
    assert.equal(issues[0]!.location, '/edges/1/action/element');
    assert.ok(isUnlearnedEdgeElement(issues[0]!), formatIssues(issues));
    assert.match(issues[0]!.message, /no capture has produced this id on any screen/, issues[0]!.message);
  });

  it('an edge element observed on ANOTHER screen is an ERROR on a CURRENT capture — that is a gap, not an unreached element', () => {
    // same screen as above, but now `invoice_list` declares `invoice.list.cell` — a capture HAS
    // produced it — and this screen's own capture is of the build the manifest names, so neither
    // "no capture has produced it" nor "this capture is too old to have contained it" is available
    const issues = edgeElementIssues(crossRef(exploredScreen([tapCell('candidate')]), { neighbours: ['invoice.add.button', 'invoice.list.cell'], build: '4412' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error', formatIssues(issues));
    assert.equal(issues[0]!.message, 'edge element invoice.list.cell is not declared on this screen');
    assert.equal(isUnlearnedEdgeElement(issues[0]!), false);
  });

  it('…and a WARNING once the manifest has moved on and this screen has not been recaptured (issue #12 hole c: shared chrome)', () => {
    // The residual deadlock the element subject cannot reach. `import-router` on build 4413 appends
    // an edge for a tab bar / back button that some OTHER screen already declares, so `observed` is
    // true, onto a screen whose `elements[]` was captured on 4412 and which the merge does not
    // recapture. The 4412 capture could not have contained a 4413 id whatever it is.
    const issues = edgeElementIssues(crossRef(exploredScreen([tapCell('candidate')]), { neighbours: ['invoice.add.button', 'invoice.list.cell'], build: '4413' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'warning', formatIssues(issues));
    assert.ok(isUnlearnedEdgeElement(issues[0]!), formatIssues(issues));
    assert.match(issues[0]!.message, /the router added after this screen was last captured/, issues[0]!.message);
  });

  it('a stale capture only excuses a screen the ROUTER writes — a hand-authored one keeps the hard error', () => {
    // `sources` without `router_export`: nothing appends edges to this file on its own, so an
    // undeclared element is someone naming the wrong id and there is no cycle to break.
    const handAuthored = exploredScreen([tapCell('candidate')], { meta: { sources: ['exploration', 'manual'], status: 'verified', last_verified_build: '4412' } });
    const issues = edgeElementIssues(crossRef(handAuthored, { neighbours: ['invoice.add.button', 'invoice.list.cell'], build: '4413' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error', formatIssues(issues));
    assert.equal(isUnlearnedEdgeElement(issues[0]!), false);
  });

  it('a VERIFIED edge whose element no capture has produced is still an ERROR — it claims the tap happened here', () => {
    // and a stale capture does not excuse it either: `verified` says the tap was replayed HERE
    const issues = edgeElementIssues(crossRef(exploredScreen([tapCell('verified')]), { neighbours: ['invoice.add.button'], build: '4413' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error', formatIssues(issues));
    assert.equal(isUnlearnedEdgeElement(issues[0]!), false);
  });

  it('an edge element absent from ids.yaml is an ERROR even when no capture has produced it — a typo is not a gap', () => {
    const explored = exploredScreen([{ action: { type: 'tap', element: 'settings.ghost.button' }, to: 'invoice_list', status: 'candidate' }]);
    const issues = edgeElementIssues(crossRef(explored, { neighbours: ['invoice.add.button'], build: '4413' }));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error');
    assert.equal(issues[0]!.message, 'edge element settings.ghost.button is not registered in ids.yaml');
  });

  it('an edge element absent from ids.yaml is still an ERROR on a seeded screen — a typo is not a gap (issue #12 criterion 4)', () => {
    const issues = edgeElementIssues(crossRef(seededScreen({
      edges: [{ action: { type: 'tap', element: 'settings.ghost.button' }, to: 'invoice_list', status: 'candidate' }],
    })));
    assert.equal(issues.length, 1, formatIssues(issues));
    assert.equal(issues[0]!.severity, 'error');
    assert.equal(issues[0]!.message, 'edge element settings.ghost.button is not registered in ids.yaml');
    assert.equal(isUnlearnedEdgeElement(issues[0]!), false);
  });
});

describe('rule 3 — screen references resolve to screen files', () => {
  it('edge to, fallback_path, expect.screen, condition screen and _previous on a screen', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => {
        d.edges[0]!.to = 'nowhere';
        d.edges[1]!.to = '_previous';
        d.edges[1]!.postconditions = [{ screen: 'also_nowhere' }];
      });
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => {
        d.entry.fallback_path = ['invoice_list', 'ghost'];
        d.steps[2]!.expect = { screen: 'ghost_picker' };
        d.verify.screen = 'ghost_detail';
      });
      const r = validateMap(t.config);
      const m = errors(r.issues, 3).map((i) => `${i.file}:${i.location}`);
      for (const want of ['ios/screens/invoice_list.yaml:/edges/0/to', 'ios/screens/invoice_list.yaml:/edges/1/to', 'ios/screens/invoice_list.yaml:/edges/1/postconditions/0/screen', 'ios/recipes/create_invoice.yaml:/entry/fallback_path/1', 'ios/recipes/create_invoice.yaml:/steps/2/expect/screen', 'ios/recipes/create_invoice.yaml:/verify/screen']) {
        assert.ok(m.includes(want), `${want}\n${formatIssues(r.issues)}`);
      }
      assert.ok(!errors(r.issues, 3).some((i) => i.file.includes('gate.')), '_previous stays legal on gates');
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 4 — ≥2 locators incl. a11y_id (OS gates exempt)', () => {
  it('one locator, or two without a11y_id', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => {
        d.elements[0]!.locators = d.elements[0]!.locators.filter((l) => l.strategy === 'a11y_id');
        d.elements[1]!.locators = d.elements[1]!.locators.filter((l) => l.strategy !== 'a11y_id').slice(0, 2);
      });
      const r = validateMap(t.config);
      const m = errors(r.issues, 4).filter((i) => i.file === 'ios/screens/login.yaml');
      assert.ok(m.some((i) => i.location === '/elements/0/locators' && /≥2/.test(i.message)), formatIssues(r.issues));
      assert.ok(m.some((i) => i.location === '/elements/1/locators' && /a11y_id/.test(i.message)), formatIssues(r.issues));
      assert.ok(!errors(r.issues, 4).some((i) => i.file.includes('gate.push_permission')), 'role_label-only gate dismiss is exempt');
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 5 — no lone text locator', () => {
  it('a single text locator is rule 5 (and rule 4)', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.elements[0]!.locators = [{ strategy: 'text', value: 'Sign In', weight: 0.3 }]; });
      const r = validateMap(t.config);
      assert.ok(errors(r.issues, 5).some((i) => i.file === 'ios/screens/login.yaml' && i.location === '/elements/0/locators'), formatIssues(r.issues));
      assert.ok(errors(r.issues, 4).some((i) => i.file === 'ios/screens/login.yaml'));
      // text + a11y_id is fine for rule 5
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.elements[0]!.locators.push({ strategy: 'a11y_id', value: d.elements[0]!.id, weight: 1 }); });
      assert.deepEqual(errors(validateMap(t.config).issues, 5), []);
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 6 — intent_critical agreement (absent = false)', () => {
  it('screen element and recipe step disagreeing with ids.yaml', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/invoice_new.yaml', 'screen', (d) => { d.elements.find((e) => e.id === 'invoice.save.button')!.intent_critical = false; });
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => { delete d.steps[4]!.intent_critical; d.steps[0]!.intent_critical = true; });
      const r = validateMap(t.config);
      const m = errors(r.issues, 6).map((i) => `${i.file}:${i.location}`);
      assert.ok(m.some((x) => x.startsWith('ios/screens/invoice_new.yaml:/elements/')), formatIssues(r.issues));
      assert.ok(m.includes('ios/recipes/create_invoice.yaml:/steps/4/intent_critical'));
      assert.ok(m.includes('ios/recipes/create_invoice.yaml:/steps/0/intent_critical'));
      // absent on both sides agrees
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { delete d.elements.find((e) => e.id === 'invoice.add.button')!.intent_critical; });
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => { delete d.elements.find((e) => e.id === 'invoice.add.button')!.intent_critical; });
      assert.ok(!errors(validateMap(t.config).issues, 6).some((i) => i.message.includes('invoice.add.button')));
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 7 — canonical serialization', () => {
  it('a non-canonical file is rule 7; loadMap-style validation (canonical:false) skips it', () => {
    const t = makeTempAppMapDir();
    try {
      assert.deepEqual(nonCanonicalFiles(t.config), []);
      const p = join(t.dir, 'ios/screens/login.yaml');
      const text = readFileSync(p, 'utf8');
      writeFileSync(p, text.replace(/^id: login\nkind: screen\n/, 'kind: screen\nid: login\n'));
      writeFileSync(join(t.dir, 'ios/manifest.yaml'), readFileSync(join(t.dir, 'ios/manifest.yaml'), 'utf8') + '\n');
      assert.deepEqual(nonCanonicalFiles(t.config), ['ios/manifest.yaml', 'ios/screens/login.yaml']);
      const r = validateMap(t.config);
      assert.deepEqual(errors(r.issues, 7).map((i) => i.file), ['ios/manifest.yaml', 'ios/screens/login.yaml']);
      assert.deepEqual(errors(validateMap(t.config, { canonical: false }).issues, 7), []);
    } finally {
      t.cleanup();
    }
  });

  // issue #20: `version: 1.0` / `git_sha: 0000000` used to be a rule 1 schema error, which meant
  // `map failed to load` blocked every other command during first-run setup. Rule 1 now reads the
  // authored strings, so the file is merely non-canonical — a re-quoting diff, not a hard stop.
  it('an unquoted build scalar is a rule 7 diff, not a rule 1 schema error (issue #20)', () => {
    const t = makeTempAppMapDir();
    try {
      const p = join(t.dir, 'ios/manifest.yaml');
      writeFileSync(p, readFileSync(p, 'utf8').replace(/^build:\n(?:  .*\n)+/m, 'build:\n  version: 1.0\n  build_number: 1\n  git_sha: 0000000\n'));
      const r = validateMap(t.config);
      assert.deepEqual(errors(r.issues, 1).filter((i) => i.file === 'ios/manifest.yaml'), [], formatIssues(r.issues));
      assert.deepEqual(errors(r.issues, 7).map((i) => i.file), ['ios/manifest.yaml']);
      assert.ok(nonCanonicalFiles(t.config).includes('ios/manifest.yaml'));
    } finally {
      t.cleanup();
    }
  });
});

describe('rule 8 — forbidden content sweep (07 §2.3.4 backstop)', () => {
  it('an email in a label, a currency value in text_present, a phone in a title; slots exempt', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.elements[0]!.label = 'Contact caleb@example.com'; });
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => { d.verify.text_present = 'Total $50'; d.description = 'Call +1 (555) 010-9999 to bill a client'; });
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.screens[0]!.title = '4111 1111 1111 1111'; });
      const r = validateMap(t.config);
      const m = errors(r.issues, 8).map((i) => `${i.file}:${i.location}`);
      for (const want of ['ios/screens/login.yaml:/elements/0/label', 'ios/recipes/create_invoice.yaml:/verify/text_present', 'ios/recipes/create_invoice.yaml:/description', 'ids.yaml:/screens/0/title']) assert.ok(m.includes(want), `${want}\n${formatIssues(r.issues)}`);
      assert.ok(!m.includes('ios/recipes/create_invoice.yaml:/steps/1/text'), '"{amount}" slot is exempt');
    } finally {
      t.cleanup();
    }
    const recipe = parse(readFileSync(join(PILOT_APP_MAP_DIR, 'ios/recipes/create_invoice.yaml'), 'utf8')) as RecipeFile;
    assert.deepEqual(forbiddenContentIssues('r.yaml', recipe), []);
    (recipe.steps[1] as { text: string }).text = '$50';
    assert.equal(forbiddenContentIssues('r.yaml', recipe)[0]?.location, '/steps/1/text');
    (recipe.steps[3] as { match: { text: string } }).match.text = 'DE89 3704 0044 0532 0130 00';
    assert.ok(forbiddenContentIssues('r.yaml', recipe).some((i) => i.location === '/steps/3/match/text' && /IBAN/.test(i.message)));
    (recipe.steps[0] as { expect: { text_present: string } }).expect = { text_present: '123-45-6789' };
    assert.ok(forbiddenContentIssues('r.yaml', recipe).some((i) => i.location === '/steps/0/expect/text_present' && /SSN/.test(i.message)));
  });

  // 07 §2.3 rule 6: the backstop must cover the two author/compiler-written free-text fields the
  // sweep used to skip. `matches` is the worst to miss — compile.ts seeds it from the task text.
  it('sweeps recipe matches[] and ids.yaml label_regex', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<RecipeFile>(t, 'ios/recipes/create_invoice.yaml', 'recipe', (d) => {
        d.matches = [...d.matches, 'bill jane\\.doe@example\\.com for \\$1,299\\.00'];
      });
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => {
        const el = d.elements.find((e) => e.id === 'invoice.list.table')!;
        el.label_regex = '^jane\\.doe@example\\.com$';
      });
      const r = validateMap(t.config);
      assert.equal(r.ok, false);
      const m = errors(r.issues, 8).map((i) => `${i.file}:${i.location}`);
      assert.ok(m.includes('ios/recipes/create_invoice.yaml:/matches/2'), formatIssues(r.issues));
      assert.ok(m.some((x) => /^ids\.yaml:\/elements\/\d+\/label_regex$/.test(x)), formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });

  it('warns (never errors) when a title or label is missing from the string table, and on gate titles', () => {
    const t = makeTempAppMapDir();
    try {
      // the title must stay consistent across ids.yaml and both platforms (rule 2) — only the table check should fire
      editYaml<ScreenFile>(t, 'ios/screens/login.yaml', 'screen', (d) => { d.elements[0]!.label = 'Not In Table'; d.title = 'Nor This'; });
      editYaml<ScreenFile>(t, 'android/screens/login.yaml', 'screen', (d) => { d.title = 'Nor This'; });
      editYaml<IdsRegistry>(t, 'ids.yaml', 'ids', (d) => { d.screens.find((s) => s.id === 'login')!.title = 'Nor This'; });
      const r = validateMap(t.config);
      const warnings = r.issues.filter((i) => i.severity === 'warning' && i.file === 'ios/screens/login.yaml').map((i) => i.location);
      assert.ok(warnings.includes('/elements/0/label') && warnings.includes('/title'), formatIssues(r.issues));
      assert.ok(r.ok, 'warnings do not fail validation');
      // without a string table nothing is warned for labels
      rmSync(join(t.dir, '.local/strings.ios.txt'));
      assert.ok(!validateMap(t.config).issues.some((i) => i.severity === 'warning' && i.file === 'ios/screens/login.yaml'));
      // a gate with a title (decision 33)
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      writeFileSync(join(t.dir, '.local/strings.ios.txt'), 'x\n');
      const ids = parse(readFileSync(join(t.dir, 'ids.yaml'), 'utf8')) as IdsRegistry;
      const gate = parse(readFileSync(join(t.dir, 'ios/screens/gate.push_permission.yaml'), 'utf8')) as ScreenFile;
      gate.title = 'Allow Notifications?';
      const issues = crossReferenceIssues({ platform: 'ios', ids, screens: new Map([['ios/screens/gate.push_permission.yaml', gate]]), recipes: new Map(), staticStrings: new Set() });
      assert.ok(!issues.some((i) => i.location === '/title'), 'gate titles are never checked against the table (they are not app copy)');
      assert.ok(!existsSync(join(t.dir, 'ios/screens/gate.push_permission.yaml.bak')));
    } finally {
      t.cleanup();
    }
  });

  it('a label on a dynamic element is data (07 §2.3)', () => {
    const t = makeTempAppMapDir();
    try {
      editYaml<ScreenFile>(t, 'ios/screens/invoice_list.yaml', 'screen', (d) => { d.elements.find((e) => e.id === 'invoice.list.cell')!.label = 'Acme Corp'; });
      const r = validateMap(t.config);
      assert.ok(errors(r.issues, 8).some((i) => i.file === 'ios/screens/invoice_list.yaml' && /dynamic element invoice\.list\.cell/.test(i.message)), formatIssues(r.issues));
    } finally {
      t.cleanup();
    }
  });
});

describe('formatIssues', () => {
  it('prints one `<file>[:<location>] rule <n>: <message>` line per issue', () => {
    const text = formatIssues([
      { rule: 2, severity: 'error', file: 'ios/screens/x.yaml', location: '/elements/0/id', message: 'dangling' },
      { rule: 8, severity: 'warning', file: 'ids.yaml', message: 'not in table' },
    ]);
    assert.equal(text, 'ios/screens/x.yaml:/elements/0/id rule 2: dangling\nids.yaml rule 8: warning: not in table');
    assert.equal(formatIssues([]), '');
  });
});

// 02 §11: all five schemas are reachable from `app-map validate`; the router export is a build
// artifact outside the map, so it is named explicitly.
describe('router-export schema via --router (02 §11)', () => {
  it('accepts the fixture and rejects a bad app_id / missing build', () => {
    const t = makeTempAppMapDir();
    const dir = mkdtempSync(join(tmpdir(), 'app-map-router-'));
    try {
      const good = join(dir, 'router-export.json');
      const doc = loadRouterExportFixture() as unknown as Record<string, unknown>;
      writeFileSync(good, JSON.stringify(doc));
      const okResult = validateMap(t.config, { routerExports: [good] });
      assert.deepEqual(errors(okResult.issues), [], formatIssues(okResult.issues));

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ ...doc, app_id: 'unknown' }));
      const badResult = validateMap(t.config, { routerExports: [bad] });
      assert.equal(badResult.ok, false);
      assert.ok(errors(badResult.issues).some((i) => i.location === '/app_id'), formatIssues(badResult.issues));

      const noBuild = join(dir, 'nobuild.json');
      const { build: _build, ...withoutBuild } = doc;
      writeFileSync(noBuild, JSON.stringify(withoutBuild));
      assert.equal(validateMap(t.config, { routerExports: [noBuild] }).ok, false);

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, 'not json');
      const brokenResult = validateMap(t.config, { routerExports: [broken] });
      assert.equal(brokenResult.ok, false);
      assert.ok(errors(brokenResult.issues).some((i) => /not JSON/.test(i.message)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      t.cleanup();
    }
  });
});
