/**
 * [D2] `app-map lint-ids` (01 R8, 01 R2, 06 R2, architecture decisions 38–39).
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as yamlParse } from 'yaml';
import type { IdsRegistry, LintIdsResult, LintRule } from '../types.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { KIND_SYNONYMS, constantNames, findStringLiteralIds, lintIds } from '../lint-ids.ts';
import { FIXTURES_DIR, PILOT_APP_MAP_DIR, REPO_ROOT, loadLintFixture, makeTempAppMapDir } from './helpers.ts';

const PILOT_CONFIG = { dir: PILOT_APP_MAP_DIR };
/** the fixture dir holds Bad.swift and Bad.kt only; point both platform roots at it */
const LINT_FIXTURE_OPTS = {
  repoRoot: FIXTURES_DIR,
  iosDirs: ['lint'],
  androidDirs: ['lint'],
  generated: { swift: 'nowhere/AppMapID.swift', kotlin: 'nowhere/AppMapId.kt' },
  genIdsScript: 'nowhere/gen-ids',
};

const of = (r: LintIdsResult, rule: LintRule): LintIdsResult['issues'] => r.issues.filter((i) => i.rule === rule);
const errors = (r: LintIdsResult): LintIdsResult['issues'] => r.issues.filter((i) => i.severity === 'error');

describe('06 R2: lint-ids passes on the committed repo', () => {
  it('the pilot ids.yaml + instrumentation sources produce no errors', () => {
    const r = lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT });
    assert.deepEqual(r.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(r.issues, null, 2));
    assert.ok(r.ok);
    // 08 §6 Stage 0: the app source is not in this repo, so each platform says so out loud
    // instead of the rule quietly disabling itself (01 R8).
    assert.deepEqual(
      r.issues.map((i) => `${i.severity}:${i.rule}:${i.platform}`).sort(),
      ['warning:marker_unreferenced:android', 'warning:marker_unreferenced:ios'],
    );
  });

  it('a platform declared instrumented can never lose every marker silently (01 R8)', () => {
    const r = lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT, instrumentedPlatforms: ['ios'] });
    assert.equal(r.ok, false);
    const errors = r.issues.filter((i) => i.severity === 'error' && i.rule === 'marker_unreferenced');
    assert.equal(errors.length, 5, 'one per pilot screen');
    assert.ok(errors.every((i) => i.platform === 'ios'));
    // android is still undeclared, so it stays a warning
    assert.ok(r.issues.some((i) => i.severity === 'warning' && i.platform === 'android'));
  });

  it('`invoice.list.table` (kind: list) is not even a warning — decision 38 / KIND_SYNONYMS', () => {
    const r = lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT });
    assert.deepEqual(of(r, 'bad_id'), []);
    assert.ok(KIND_SYNONYMS.list.includes('table'));
    assert.ok(KIND_SYNONYMS.list.includes('collection'));
  });

  it('generated_out_of_sync stays quiet because scripts/app-map/gen-ids --check passes (06 R2)', () => {
    assert.deepEqual(of(lintIds(PILOT_CONFIG, { repoRoot: REPO_ROOT }), 'generated_out_of_sync'), []);
  });
});

describe('01 R8: string-literal ids in UI code', () => {
  it('Bad.swift reports both literals at their line numbers', () => {
    const r = lintIds(PILOT_CONFIG, LINT_FIXTURE_OPTS);
    const swift = of(r, 'string_literal_id').filter((i) => i.file === 'lint/Bad.swift');
    assert.equal(swift.length, 2, JSON.stringify(swift));
    assert.equal(swift[0]!.line, 8);
    assert.match(swift[0]!.message, /invoice\.list\.table/);
    assert.equal(swift[1]!.line, 13);
    assert.match(swift[1]!.message, /screen\.invoice_list/);
    for (const i of swift) assert.equal(i.severity, 'error');
  });

  it('Bad.kt reports both literals at their line numbers', () => {
    const r = lintIds(PILOT_CONFIG, LINT_FIXTURE_OPTS);
    const kt = of(r, 'string_literal_id').filter((i) => i.file === 'lint/Bad.kt');
    assert.equal(kt.length, 2, JSON.stringify(kt));
    assert.deepEqual(kt.map((i) => i.line), [12, 14]);
    assert.match(kt[1]!.message, /invoice\.save\.button/);
  });

  it('the generated constant reference is not a violation', () => {
    const r = lintIds(PILOT_CONFIG, LINT_FIXTURE_OPTS);
    for (const i of of(r, 'string_literal_id')) {
      assert.doesNotMatch(i.message, /invoice\.add\.button/, 'AppMapID.Element.invoiceAddButton is the correct form');
    }
  });

  it('findStringLiteralIds matches whole registered ids, never prefixes (01 R8)', () => {
    // the registry's own vocabulary, not feature prefixes: the rule is "this literal IS an id"
    const registered = new Set(['screen.invoice_list', 'gate.push_permission', 'invoice.list.table', 'invoice.save.button']);
    const hits = findStringLiteralIds(loadLintFixture('Bad.swift'), registered);
    assert.deepEqual(hits, [{ id: 'invoice.list.table', line: 8 }, { id: 'screen.invoice_list', line: 13 }]);
    assert.deepEqual(findStringLiteralIds('// "invoice.save.button" in a comment\n', registered), []);
    assert.deepEqual(findStringLiteralIds('/* a\n   "invoice.save.button" */\n', registered), []);
    assert.deepEqual(findStringLiteralIds('let x = "Save Invoice"\n', registered), []);
    assert.deepEqual(findStringLiteralIds('let x = "other.thing.button"\n', registered), []);
    assert.deepEqual(findStringLiteralIds('let u = "appmap://invoice_new"\n', registered), [], 'a deep link is not an id');
    assert.deepEqual(findStringLiteralIds('let x = "gate.push_permission"\n', registered), [{ id: 'gate.push_permission', line: 1 }]);
    // line numbers survive a multi-line comment
    assert.deepEqual(findStringLiteralIds('/*\n\n*/\nlet x = "invoice.save.button"\n', registered), [{ id: 'invoice.save.button', line: 4 }]);
    assert.deepEqual(findStringLiteralIds('let x = "invoice.3"\n', registered), [], 'a feature prefix is not a match (issue #14)');
    assert.deepEqual(findStringLiteralIds('Image(systemName: "invoice.list.table")\n', registered), [], 'an SF Symbol argument is never an id');
  });

  // issue #14: the rule used to match a literal's feature PREFIX, so a registered
  // `person.detail.name.text` claimed every SF Symbol under `person.`.
  it('a literal that only shares a feature prefix with a registered id is not a finding (01 R8; issue #14)', () => {
    withIdsAndSources((ids) => {
      ids.elements.push({ id: 'person.detail.name.text', kind: 'text' });
      ids.elements.push({ id: 'favorites.list.cell', kind: 'cell' });
      ids.elements.push({ id: 'star.rating.text', kind: 'text' });
    }, {
      'Tabs.swift': 'let a = Image(systemName: "person.3")\nlet b = "person.crop.circle"\nlet c = Image(systemName: "star.fill")\n',
      'Store.swift': 'private let key = "favorites.v1"\n',
    }, (r) => {
      assert.deepEqual(of(r, 'string_literal_id'), [], 'SF Symbol names and storage keys are not ids');
    });
  });

  it('a literal that equals a registered element id is still an error (01 R8)', () => {
    withIdsAndSources((ids) => {
      ids.elements.push({ id: 'person.detail.name.text', kind: 'text' });
    }, {
      'PersonDetail.swift': 'let a = "person.detail.name.text"\nlet b = "person.3"\n',
    }, (r) => {
      const hits = of(r, 'string_literal_id');
      assert.deepEqual(hits.map((i) => i.line), [1], JSON.stringify(hits));
      assert.match(hits[0]!.message, /person\.detail\.name\.text/);
      assert.equal(hits[0]!.severity, 'error');
      assert.equal(hits[0]!.platform, 'ios');
    });
  });

  it('screen.<known> and gate.<known> literals are still errors; an unregistered screen literal is not (01 R8)', () => {
    withIdsAndSources((ids) => {
      ids.screens.push({ id: 'people_list', title: 'Characters', deep_link: 'none' });
    }, {
      'Nav.swift': 'let a = "screen.people_list"\nlet b = "gate.push_permission"\nlet c = "gate.push_permission.deny"\nlet d = "screen.not_a_screen"\n',
    }, (r) => {
      // line 4 names no registered screen, so it is not a "use the constant" violation at all;
      // a made-up id surfaces through `bad_id`/`orphan_constant`, not through this rule.
      assert.deepEqual(of(r, 'string_literal_id').map((i) => i.line), [1, 2, 3], JSON.stringify(of(r, 'string_literal_id')));
    });
  });

  it('an Image(systemName:) / Label(systemImage:) argument is never an id, even when it equals a registered id (01 R8; issue #14)', () => {
    withIdsAndSources((ids) => {
      // a registered id deliberately spelled like an SF Symbol (it also earns a harmless kind-segment
      // `bad_id` warning — decision 38 — which the rule filter ignores)
      ids.elements.push({ id: 'person.crop.circle', kind: 'text' });
    }, {
      'Icon.swift': 'let a = Image(systemName: "person.crop.circle")\nlet b = Label("Sort", systemImage: "person.crop.circle")\nlet c = "person.crop.circle"\n',
    }, (r) => {
      assert.deepEqual(of(r, 'string_literal_id').map((i) => i.line), [3], JSON.stringify(of(r, 'string_literal_id')));
    });
  });
});

describe('01 R8 / decision 39: marker_unreferenced is per platform', () => {
  it('Bad.swift alone leaves the other iOS screen markers unreferenced', () => {
    const r = lintIds(PILOT_CONFIG, LINT_FIXTURE_OPTS);
    const ios = of(r, 'marker_unreferenced').filter((i) => i.platform === 'ios');
    const named = ios.map((i) => /screen "([a-z0-9_]+)"/.exec(i.message)?.[1]).sort();
    assert.deepEqual(named, ['client_picker', 'invoice_detail', 'invoice_new', 'login'],
      'invoice_list is referenced (as a literal); the others are not');
    assert.match(ios[0]!.message, /AppMapID\.Screen\.clientPicker/);
  });

  it('Bad.kt alone leaves login (and the rest) unreferenced on android', () => {
    const r = lintIds(PILOT_CONFIG, LINT_FIXTURE_OPTS);
    const android = of(r, 'marker_unreferenced').filter((i) => i.platform === 'android');
    const named = android.map((i) => /screen "([a-z0-9_]+)"/.exec(i.message)?.[1]);
    assert.ok(named.includes('login'), JSON.stringify(named));
    assert.match(android.find((i) => i.message.includes('"login"'))!.message, /AppMapId\.Screen\.LOGIN/);
  });

  it('--platform ios suppresses the android findings (08 §6 Stage 0)', () => {
    const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, platforms: ['ios'] });
    assert.equal(r.issues.filter((i) => i.platform === 'android').length, 0);
    assert.ok(r.issues.some((i) => i.platform === 'ios'));
  });

  it('a platform whose source dirs do not exist is skipped', () => {
    const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, iosDirs: ['does/not/exist'], androidDirs: ['does/not/exist'] });
    assert.deepEqual(r.issues, []);
    assert.ok(r.ok);
  });

  it('a qualified constant reference counts, a doc comment does not', () => {
    withSources({ 'App.swift': 'let a = AppMapID.Screen.clientPicker\n// AppMapID.Screen.login\n' }, (root) => {
      const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, repoRoot: root, iosDirs: ['src'], androidDirs: ['src'], platforms: ['ios'] });
      const named = of(r, 'marker_unreferenced').map((i) => /screen "([a-z0-9_]+)"/.exec(i.message)?.[1]).sort();
      assert.deepEqual(named, ['invoice_detail', 'invoice_list', 'invoice_new', 'login']);
    });
  });

  it('test sources are not scanned (neither for references nor for literals)', () => {
    withSources({ 'Tests/AppTests.swift': 'let a = AppMapID.Screen.clientPicker\nlet b = "invoice.save.button"\n' }, (root) => {
      const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, repoRoot: root, iosDirs: ['src'], androidDirs: ['src'], platforms: ['ios'] });
      assert.deepEqual(r.issues, [], JSON.stringify(r.issues));
    });
  });
});

describe('01 R2: bad_id', () => {
  it('a bad screen id, gate id, dismiss id and element id are all errors', () => {
    withTempIds((ids) => {
      ids.screens.push({ id: 'BadScreen', title: 'x', deep_link: 'none' });
      ids.gates.push({ id: 'notagate', dismiss: 'notagate.deny' });
      ids.elements.push({ id: 'twosegments', kind: 'button' });
      ids.elements.push({ id: 'screen.reserved.prefix', kind: 'button' });
    }, (r) => {
      const bad = of(r, 'bad_id').filter((i) => i.severity === 'error').map((i) => i.message).join('\n');
      assert.match(bad, /BadScreen/);
      assert.match(bad, /notagate/);
      assert.match(bad, /twosegments/);
      assert.match(bad, /screen\.reserved\.prefix/);
      assert.ok(!r.ok);
    });
  });

  it('a dismiss id that is not `<gate>.<verb>` is an error', () => {
    withTempIds((ids) => {
      ids.gates.push({ id: 'gate.other_prompt', dismiss: 'gate.somethingelse.deny' });
    }, (r) => {
      assert.match(of(r, 'bad_id').map((i) => i.message).join('\n'), /gate\.somethingelse\.deny/);
    });
  });

  it('a last segment that is not a kind synonym is a warning, not an error', () => {
    withTempIds((ids) => {
      ids.elements.push({ id: 'invoice.total.thing', kind: 'text' });
    }, (r) => {
      const warnings = of(r, 'bad_id').filter((i) => i.severity === 'warning');
      assert.equal(warnings.length, 1, JSON.stringify(of(r, 'bad_id')));
      assert.match(warnings[0]!.message, /invoice\.total\.thing/);
      assert.deepEqual(errors(r), [], 'a kind-segment convention miss never fails the command');
      assert.ok(r.ok);
    });
  });
});

// 01 R2 "Ids MUST NOT contain copy text or localized strings" — the regexes only fix the shape.
describe('01 R2: id content (copy / localized strings)', () => {
  /** the pilot map WITH its .local string table, so the copy vocabulary is populated */
  function withIds(mutate: (ids: IdsRegistry) => void, assertions: (r: LintIdsResult) => void): void {
    const t = makeTempAppMapDir();
    try {
      const file = join(t.dir, 'ids.yaml');
      const ids = yamlParse(readFileSync(file, 'utf8')) as IdsRegistry;
      mutate(ids);
      writeFileSync(file, canonicalYaml('ids', ids));
      assertions(lintIds({ dir: t.dir }, { ...LINT_FIXTURE_OPTS, iosDirs: ['does/not/exist'], androidDirs: ['does/not/exist'] }));
    } finally {
      t.cleanup();
    }
  }

  it('a locale suffix on any segment is a warning', () => {
    withIds((ids) => {
      ids.elements.push({ id: 'invoice.save_invoice_button_en.button', kind: 'button' });
      ids.elements.push({ id: 'invoice.total_pt_br.text', kind: 'text' });
    }, (r) => {
      const messages = of(r, 'bad_id').filter((i) => i.severity === 'warning').map((i) => i.message);
      assert.ok(messages.some((m) => /save_invoice_button_en.*locale suffix "_en"/.test(m)), messages.join('\n'));
      assert.ok(messages.some((m) => /total_pt_br.*locale suffix "_pt_br"/.test(m)), messages.join('\n'));
      assert.deepEqual(errors(r), [], 'a content heuristic never fails the command');
    });
  });

  it('an id segment that is verbatim app copy is a warning', () => {
    withIds((ids) => {
      // "New Invoice" is in the pilot's .local/strings.ios.txt
      ids.elements.push({ id: 'invoice.new_invoice.button', kind: 'button' });
    }, (r) => {
      const messages = of(r, 'bad_id').filter((i) => i.severity === 'warning').map((i) => i.message);
      assert.ok(messages.some((m) => /new_invoice.*verbatim app copy/.test(m)), messages.join('\n'));
    });
  });

  it('the committed pilot ids are structural: no content warning at all', () => {
    withIds(() => {}, (r) => {
      assert.deepEqual(of(r, 'bad_id').filter((i) => /01 R2\)$/.test(i.message)), []);
    });
  });
});

describe('01 R8: generated constants', () => {
  it('orphan_constant for an id in the generated file that ids.yaml does not have', () => {
    withSources({}, (root) => {
      const gen = join(root, 'gen', 'AppMapID.swift');
      mkdirSync(join(root, 'gen'), { recursive: true });
      writeFileSync(gen, 'public enum AppMapID {\n  public static let ghost = "invoice.ghost.button"\n}\n');
      const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, repoRoot: root, iosDirs: ['src'], androidDirs: ['src'], generated: { swift: 'gen/AppMapID.swift', kotlin: 'nowhere/AppMapId.kt' } });
      const orphans = of(r, 'orphan_constant');
      assert.equal(orphans.length, 1, JSON.stringify(r.issues));
      assert.match(orphans[0]!.message, /invoice\.ghost\.button/);
      assert.equal(orphans[0]!.platform, 'ios');
      assert.equal(orphans[0]!.line, 2);
    });
  });

  it('generated_out_of_sync when the generated file is missing registry ids (no gen-ids script)', () => {
    withSources({}, (root) => {
      mkdirSync(join(root, 'gen'), { recursive: true });
      writeFileSync(join(root, 'gen', 'AppMapID.swift'), 'let invoiceAddButton = "invoice.add.button"\n');
      const r = lintIds(PILOT_CONFIG, { ...LINT_FIXTURE_OPTS, repoRoot: root, iosDirs: ['src'], androidDirs: ['src'], generated: { swift: 'gen/AppMapID.swift', kotlin: 'nowhere/AppMapId.kt' } });
      const stale = of(r, 'generated_out_of_sync');
      assert.equal(stale.length, 1, JSON.stringify(r.issues));
      assert.match(stale[0]!.message, /missing \d+ id\(s\)/);
    });
  });

  it('generated_out_of_sync when gen-ids --check fails on a mutated registry (06 R2)', () => {
    const t = makeTempAppMapDir();
    try {
      const ids = yamlParse(readFileSync(join(t.dir, 'ids.yaml'), 'utf8')) as IdsRegistry;
      ids.elements.push({ id: 'invoice.extra.button', kind: 'button' });
      writeFileSync(join(t.dir, 'ids.yaml'), canonicalYaml('ids', ids));
      const r = lintIds({ dir: t.dir }, { repoRoot: REPO_ROOT });
      assert.ok(of(r, 'generated_out_of_sync').length === 1, JSON.stringify(r.issues, null, 2));
      assert.ok(!r.ok);
    } finally {
      t.cleanup();
    }
  });
});

describe('constantNames mirrors scripts/app-map/gen-ids', () => {
  it('elements, screens and gates', () => {
    assert.deepEqual(constantNames('invoice.save.button'), { swift: 'invoiceSaveButton', kotlin: 'INVOICE_SAVE_BUTTON' });
    assert.deepEqual(constantNames('screen.client_picker'), { swift: 'clientPicker', kotlin: 'CLIENT_PICKER' });
    assert.deepEqual(constantNames('gate.push_permission'), { swift: 'pushPermission', kotlin: 'PUSH_PERMISSION' });
    assert.deepEqual(constantNames('gate.push_permission.deny'), { swift: 'pushPermissionDeny', kotlin: 'PUSH_PERMISSION_DENY' });
    assert.deepEqual(constantNames('invoice.detail.amount.text'), { swift: 'invoiceDetailAmountText', kotlin: 'INVOICE_DETAIL_AMOUNT_TEXT' });
  });

  it('every constant in the committed generated files is reproduced exactly', () => {
    const swift = readFileSync(join(REPO_ROOT, 'instrumentation/ios/AppMapKit/Sources/AppMapKit/AppMapID.swift'), 'utf8');
    const kotlin = readFileSync(join(REPO_ROOT, 'instrumentation/android/appmap/src/main/kotlin/com/example/appmap/AppMapId.kt'), 'utf8');
    const ids = yamlParse(readFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), 'utf8')) as IdsRegistry;
    for (const e of ids.elements) {
      const n = constantNames(e.id);
      assert.ok(swift.includes(`let ${n.swift} = "${e.id}"`), `${n.swift} in AppMapID.swift`);
      assert.ok(kotlin.includes(`val ${n.kotlin} = "${e.id}"`), `${n.kotlin} in AppMapId.kt`);
    }
    for (const s of ids.screens) {
      const n = constantNames(`screen.${s.id}`);
      assert.ok(swift.includes(`let ${n.swift} = "screen.${s.id}"`), `${n.swift} in AppMapID.swift`);
      assert.ok(kotlin.includes(`val ${n.kotlin} = "screen.${s.id}"`), `${n.kotlin} in AppMapId.kt`);
    }
  });

  it('a leading digit is prefixed and a Swift keyword is backticked (gen-ids parity)', () => {
    assert.deepEqual(constantNames('a.2fa.field'), { swift: 'a2faField', kotlin: 'A_2FA_FIELD' });
    assert.equal(constantNames('2fa.code.field').swift, '_2faCodeField');
    assert.equal(constantNames('screen.class').swift, '`class`');
  });
});

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

/** a temp repo root with `src/<name>` sources (never the repo's own tree) */
function withSources(files: Record<string, string>, fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'app-map-lint-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      const abs = join(root, 'src', name);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, text);
    }
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * The pilot map with extra ids AND a temp `src/` source tree, linted together: `string_literal_id`
 * needs both halves — the registry supplies the ids, the source the literals. iOS only, so the
 * Android findings stay out of the assertions.
 */
function withIdsAndSources(mutate: (ids: IdsRegistry) => void, files: Record<string, string>, assertions: (r: LintIdsResult) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'app-map-lint-both-'));
  try {
    const dir = join(base, 'app-map');
    cpSync(PILOT_APP_MAP_DIR, dir, { recursive: true, filter: (src) => !src.split(/[/\\]/).includes('.local') });
    const ids = yamlParse(readFileSync(join(dir, 'ids.yaml'), 'utf8')) as IdsRegistry;
    mutate(ids);
    writeFileSync(join(dir, 'ids.yaml'), canonicalYaml('ids', ids));
    for (const [name, text] of Object.entries(files)) {
      const abs = join(base, 'src', name);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, text);
    }
    assertions(lintIds({ dir }, { ...LINT_FIXTURE_OPTS, repoRoot: base, iosDirs: ['src'], androidDirs: ['src'], platforms: ['ios'] }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** copy the pilot map to a temp dir, mutate ids.yaml, lint it with no sources at all */
function withTempIds(mutate: (ids: IdsRegistry) => void, assertions: (r: LintIdsResult) => void): void {
  const base = mkdtempSync(join(tmpdir(), 'app-map-lint-ids-'));
  try {
    const dir = join(base, 'app-map');
    cpSync(PILOT_APP_MAP_DIR, dir, { recursive: true, filter: (src) => !src.split(/[/\\]/).includes('.local') });
    const ids = yamlParse(readFileSync(join(dir, 'ids.yaml'), 'utf8')) as IdsRegistry;
    mutate(ids);
    // written raw (not canonically) so an intentionally bad id survives the sort/validate rules
    writeFileSync(join(dir, 'ids.yaml'), canonicalYaml('ids', ids));
    assertions(lintIds({ dir }, { ...LINT_FIXTURE_OPTS, iosDirs: ['does/not/exist'], androidDirs: ['does/not/exist'] }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
