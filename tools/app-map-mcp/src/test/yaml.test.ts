/**
 * [A1] yaml layer: canonical serializer (02 §2.3, 02 §11 idempotency), schemas (02 §10.1),
 * loader + index (03 §4).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { kindForPath, schemaDir } from '../paths.ts';
import type { YamlKind } from '../paths.ts';
import type { IdsRegistry, RecipeFile, ScreenFile } from '../types.ts';
import { isUnlearnedEdgeElement } from '../types.ts';
import { KEY_ORDER, canonicalYaml, canonicalize, isCanonical, parseYamlText } from '../yaml/canonical.ts';
import { gitBlobHash, gitTreeHash, indexMap, loadMap, parseYamlFile, readAllowlist, readIds, readManifest, readRecipeFiles, readScreenFiles, readStaticStrings } from '../yaml/load.ts';
import { assertValid, loadSchemas, validateAgainstSchema, validateEventLine } from '../yaml/schemas.ts';
import { PILOT_APP_MAP_DIR, makeTempAppMapDir, readFixture } from './helpers.ts';

function* walkYaml(dir: string): Generator<string> {
  for (const name of readdirSync(dir).sort()) {
    if (name === '.local') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walkYaml(p);
    else if (name.endsWith('.yaml')) yield p;
  }
}
const pilotYamlFiles = (): Array<{ path: string; rel: string; kind: YamlKind }> =>
  [...walkYaml(PILOT_APP_MAP_DIR)].map((path) => {
    const kind = kindForPath({ dir: PILOT_APP_MAP_DIR }, path);
    assert.ok(kind, `pilot file in an unrecognised location: ${path}`);
    return { path, rel: relative(PILOT_APP_MAP_DIR, path), kind };
  });

describe('canonical serializer (02 §2.3)', () => {
  it('re-exports every committed pilot file byte-for-byte (02 §11 idempotency)', () => {
    const files = pilotYamlFiles();
    assert.ok(files.length >= 20, `expected the full pilot, got ${files.length} files`);
    for (const { path, rel, kind } of files) {
      const text = readFileSync(path, 'utf8');
      assert.equal(canonicalYaml(kind, parse(text)), text, `${rel} is not reproduced byte-for-byte`);
      assert.ok(isCanonical(kind, text), `${rel} is not canonical`);
    }
  });

  it('orders keys per KEY_ORDER and puts unknown keys after, sorted by code point', () => {
    const shuffled = { meta: { status: 'verified', sources: ['manual'] }, zeta: 1, alpha: 2, edges: [], elements: [], signature: { marker: 'screen.x' }, kind: 'screen', id: 'x', deep_link: 'none' };
    const out = canonicalize('screen', shuffled) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ['id', 'kind', 'deep_link', 'signature', 'elements', 'edges', 'meta', 'alpha', 'zeta']);
    assert.deepEqual(Object.keys(out['meta'] as object), ['sources', 'status']);
    // every KEY_ORDER type has a non-empty order list
    for (const [type, keys] of Object.entries(KEY_ORDER)) assert.ok(keys.length > 0, type);
  });

  // issue #16: `relearned_from` must land directly above `reviewed_by`, and both above the build
  // stamp, so a PR diff reads "re-learned over a verified screen / signed off by / last verified".
  it('meta puts the issue #16 review keys between status and last_verified_build', () => {
    const meta = canonicalize('meta', {
      last_verified_build: '4412', reviewed_by: 'dana', status: 'candidate',
      relearned_from: 'verified', sources: ['exploration'],
    }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(meta), ['sources', 'status', 'relearned_from', 'reviewed_by', 'last_verified_build']);
  });

  it('omits null/undefined and optional empty arrays, keeps required empty arrays', () => {
    const out = canonicalize('screen', { id: 'x', kind: 'screen', title: null, gates: [], variants: undefined, dynamic_regions: [], elements: [], edges: [], signature: { marker: 'none', required_ids: [] }, meta: { sources: ['manual'], status: 'candidate' } }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(out), ['id', 'kind', 'signature', 'elements', 'edges', 'meta']);
    assert.deepEqual(out['signature'], { marker: 'none' });
    const ids = canonicalize('ids', { schema_version: 1, screens: [], gates: [], elements: [] }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(ids), ['schema_version', 'screens', 'gates', 'elements']);
    const recipe = canonicalize('recipe', { id: 'r', params: [], steps: [], matches: [], preconditions: [] }) as Record<string, unknown>;
    assert.deepEqual(Object.keys(recipe), ['id', 'matches', 'params', 'steps']);
  });

  it('sorts id lists, edges, servers and string sets; never reorders steps/locators/matches', () => {
    const screen = canonicalize('screen', {
      id: 'x', kind: 'screen', deep_link: 'none', signature: { marker: 'screen.x', required_ids: ['b.b.b', 'a.a.a'] },
      dynamic_regions: ['z.z.z', 'a.a.a'], gates: ['gate.b', 'gate.a'],
      variants: [{ id: 'v2', when: { auth: 'any' } }, { id: 'v1', when: { auth: 'any' } }],
      elements: [
        { id: 'b.b.b', role: 'button', status: 'candidate', locators: [{ strategy: 'text', value: 'B', weight: 0.3 }, { strategy: 'a11y_id', value: 'b.b.b', weight: 1 }] },
        { id: 'a.a.a', role: 'button', status: 'candidate', locators: [] },
      ],
      edges: [
        { action: { type: 'tap', element: 'b.b.b' }, to: 'y', status: 'candidate' },
        { action: { type: 'swipe', direction: 'up' }, to: 'y', status: 'candidate' },
        { action: { type: 'tap', element: 'a.a.a' }, to: 'z', status: 'candidate' },
        { action: { type: 'tap', element: 'a.a.a' }, to: 'y', status: 'candidate' },
      ],
      meta: { sources: ['router_export', 'exploration'], status: 'candidate' },
    }) as ScreenFile;
    assert.deepEqual(screen.signature.required_ids, ['a.a.a', 'b.b.b']);
    assert.deepEqual(screen.dynamic_regions, ['a.a.a', 'z.z.z']);
    assert.deepEqual(screen.gates, ['gate.a', 'gate.b']);
    assert.deepEqual(screen.variants!.map((v) => v.id), ['v1', 'v2']);
    assert.deepEqual(screen.elements.map((e) => e.id), ['a.a.a', 'b.b.b']);
    assert.deepEqual(screen.elements[1]!.locators.map((l) => l.strategy), ['text', 'a11y_id'], 'locator rank is authored order');
    assert.deepEqual(screen.edges.map((e) => `${e.action.type}:${'element' in e.action ? e.action.element : ''}:${e.to}`), ['swipe::y', 'tap:a.a.a:y', 'tap:a.a.a:z', 'tap:b.b.b:y']);
    assert.deepEqual(screen.meta.sources, ['exploration', 'router_export']);
    const recipe = canonicalize('recipe', { id: 'r', matches: ['z', 'a'], params: [{ name: 'z', type: 'string', required: true }, { name: 'a', type: 'string', required: true }], steps: [{ id: 's2', action: 'tap', element: 'a.a.a' }, { id: 's10', action: 'tap', element: 'a.a.a' }, { id: 's1', action: 'tap', element: 'a.a.a' }], entry: { fallback_path: ['z', 'a'] }, verify: { visible: ['z.z.z', 'a.a.a'] } }) as RecipeFile;
    assert.deepEqual(recipe.matches, ['z', 'a']);
    assert.deepEqual(recipe.params.map((p) => p.name), ['z', 'a']);
    assert.deepEqual(recipe.steps.map((s) => s.id), ['s2', 's10', 's1']);
    assert.deepEqual(recipe.entry.fallback_path, ['z', 'a']);
    assert.deepEqual(recipe.verify.visible, ['a.a.a', 'z.z.z']);
    const allow = canonicalize('mcp-allowlist', { schema_version: 1, servers: [{ name: 'b', args: ['z', 'a'] }, { name: 'a' }] }) as { servers: Array<{ name: string; args?: string[] }> };
    assert.deepEqual(allow.servers.map((s) => s.name), ['a', 'b']);
    assert.deepEqual(allow.servers[1]!.args, ['z', 'a']);
  });

  it('types locator values by strategy and orders nested objects', () => {
    const el = canonicalize('element', { id: 'a.b.c', role: 'button', status: 'candidate', fingerprint: { bbox_norm: { h: 1, w: 1, y: 0, x: 0 }, sibling_index: 0, role: 'button' }, locators: [{ weight: 0.6, value: { label: 'L', role: 'button' }, strategy: 'role_label' }, { weight: 0.1, value: { y: 1, x: 0 }, strategy: 'geometry' }] }) as ScreenFile['elements'][number];
    assert.deepEqual(Object.keys(el.locators[0]!), ['strategy', 'value', 'weight']);
    assert.deepEqual(Object.keys(el.locators[0]!.value as object), ['role', 'label']);
    assert.deepEqual(Object.keys(el.locators[1]!.value as object), ['x', 'y']);
    assert.deepEqual(Object.keys(el.fingerprint!), ['role', 'sibling_index', 'bbox_norm']);
    assert.deepEqual(Object.keys(el.fingerprint!.bbox_norm!), ['x', 'y', 'w', 'h']);
  });

  it('serializes block style, LF, one trailing newline, JS numbers, quoted build numbers and slots', () => {
    const text = canonicalYaml('recipe', { id: 'r', version: 1, platform: 'ios', description: 'd', matches: ['x'], params: [], entry: {}, steps: [{ id: 's1', action: 'type', element: 'a.b.c', text: '{amount}' }], verify: { screen: 'x' }, status: 'candidate', provenance: { compiled_from: 't', compiled_by: 'app-map-mcp@0.1.0' }, last_verified_build: '4412' });
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
    assert.ok(!text.includes('\r'));
    assert.ok(!text.includes('{ ') && !text.includes('---'), 'block style, no document markers');
    assert.match(text, /^    text: "\{amount\}"$/m);
    assert.match(text, /^last_verified_build: "4412"$/m);
    assert.match(text, /^version: 1$/m);
    assert.equal(canonicalYaml('screen', { id: 'x', weight: 1.0 }), 'id: x\nweight: 1\n');
  });

  it('isCanonical rejects reordered keys, flow style and unparseable text', () => {
    assert.ok(isCanonical('ids', 'schema_version: 1\nscreens: []\ngates: []\nelements: []\n'));
    assert.ok(!isCanonical('ids', 'screens: []\nschema_version: 1\ngates: []\nelements: []\n'));
    assert.ok(!isCanonical('ids', 'schema_version: 1\nscreens: []\ngates: []\nelements: []\n\n'), 'two trailing newlines');
    assert.ok(!isCanonical('ids', '{schema_version: 1, screens: [], gates: [], elements: []}\n'));
    assert.ok(!isCanonical('ids', 'a: [\n'));
  });

  it('parseYamlText reports file and position on syntax errors and duplicate keys', () => {
    assert.throws(() => parseYamlText('a: 1\nb: [\n', 'x.yaml'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && /x\.yaml:\d+:\d+/.test(e.message));
    assert.throws(() => parseYamlText('a: 1\na: 2\n', 'dup.yaml'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && /dup\.yaml/.test(e.message));
    assert.deepEqual(parseYamlText('a: "4412"\nb: 2026.9.1\n', 'ok.yaml'), { a: '4412', b: '2026.9.1' });
  });
});

describe('JSON schemas (02 §10.1)', () => {
  const sd = schemaDir({ dir: PILOT_APP_MAP_DIR });

  it('compiles every schema kind once per directory', () => {
    const a = loadSchemas(sd);
    const b = loadSchemas(sd);
    assert.equal(a, b, 'cached by directory');
    assert.notEqual(loadSchemas(sd, { reload: true }), a);
    for (const kind of ['ids', 'manifest', 'screen', 'recipe', 'mcp-allowlist', 'router-export', 'drift-report', 'heal-report', 'events', 'hook-payload'] as const) assert.ok(a.get(kind), kind);
  });

  it('every pilot YAML validates against its schema', () => {
    for (const { path, rel, kind } of pilotYamlFiles()) {
      const issues = validateAgainstSchema(sd, kind, parse(readFileSync(path, 'utf8')));
      assert.deepEqual(issues, [], `${rel}: ${JSON.stringify(issues)}`);
    }
  });

  it('rejects an extra key, a bad enum and a malformed id with JSON-pointer paths', () => {
    const screen = parse(readFileSync(join(PILOT_APP_MAP_DIR, 'ios/screens/login.yaml'), 'utf8')) as ScreenFile & Record<string, unknown>;
    const extra = { ...screen, screenshot: '/tmp/x.png' };
    assert.ok(validateAgainstSchema(sd, 'screen', extra).some((i) => i.keyword === 'additionalProperties' && i.path === '/'));
    const badEnum = structuredClone(screen);
    (badEnum.elements[0] as { status: string }).status = 'bogus';
    const issues = validateAgainstSchema(sd, 'screen', badEnum);
    assert.ok(issues.some((i) => i.keyword === 'enum' && i.path === '/elements/0/status'), JSON.stringify(issues));
    const badId = structuredClone(screen);
    badId.elements[0]!.id = 'Login.Submit';
    assert.ok(validateAgainstSchema(sd, 'screen', badId).some((i) => i.path === '/elements/0/id'));
    assert.throws(() => assertValid(sd, 'screen', extra, 'ios/screens/login.yaml'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && e.message.includes('ios/screens/login.yaml'));
    assert.doesNotThrow(() => assertValid(sd, 'screen', screen));
  });

  it('bounds user-authored regex sources to 200 chars in the schema', () => {
    const ids = { schema_version: 1, screens: [], gates: [], elements: [{ id: 'a.b.c', kind: 'text', label_regex: 'x'.repeat(201) }] };
    assert.ok(validateAgainstSchema(sd, 'ids', ids).some((i) => i.keyword === 'maxLength'));
  });

  it('validateEventLine accepts the fixture lines and rejects bad JSON / unknown kinds', () => {
    for (const line of readFixture('events/sample.events.jsonl').split('\n').filter((l) => l.trim())) assert.deepEqual(validateEventLine(sd, line), [], line);
    assert.equal(validateEventLine(sd, '{not json')[0]?.keyword, 'parse');
    assert.ok(validateEventLine(sd, '{"ts":"2026-09-10T00:00:00Z","kind":"bogus"}').length > 0);
  });

  it('throws invalid_map for a missing schema directory', () => {
    assert.throws(() => loadSchemas(join(PILOT_APP_MAP_DIR, 'no-such-schema-dir'), { reload: true }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP);
  });
});

describe('loader and index (03 §4)', () => {
  it('loads the pilot map: 5 screens, 2 gates, 1 recipe, 34 registry ids, 10 files, <500 ms', () => {
    const t = makeTempAppMapDir();
    try {
      const started = performance.now();
      const map = loadMap(t.config);
      const ms = performance.now() - started;
      assert.ok(ms < 500, `loadMap took ${ms.toFixed(0)} ms`);
      assert.equal(map.platform, 'ios');
      assert.equal(map.screens.size, 5);
      assert.equal(map.gates.size, 2);
      assert.equal(map.recipes.size, 1);
      assert.equal(map.elementRegistry.size, map.ids.elements.length + map.ids.gates.length);
      assert.equal(map.elementRegistry.size, 34);
      assert.deepEqual(map.elementRegistry.get('gate.push_permission.deny'), { id: 'gate.push_permission.deny', kind: 'button', intent_critical: false, dynamic: false });
      assert.equal(map.files.size, 10);
      assert.deepEqual([...map.files.keys()].sort(), ['ids.yaml', 'ios/manifest.yaml', 'ios/recipes/create_invoice.yaml', 'ios/screens/client_picker.yaml', 'ios/screens/gate.biometric_prompt.yaml', 'ios/screens/gate.push_permission.yaml', 'ios/screens/invoice_detail.yaml', 'ios/screens/invoice_list.yaml', 'ios/screens/invoice_new.yaml', 'ios/screens/login.yaml']);
      assert.deepEqual(map.files.get('ios/screens/login.yaml')?.kind, 'screen');
      assert.deepEqual(map.files.get('ids.yaml')?.id, 'ids');
      for (const [rel, f] of map.files) assert.match(f.blob_sha ?? '', /^[0-9a-f]{40}$/, rel);
      assert.equal(map.markers.get('screen.invoice_list'), 'invoice_list');
      assert.equal(map.markers.size, 5, 'gates have marker none');
      assert.equal(map.routes.get('appmap://invoice_detail'), 'invoice_detail', 'query stripped');
      assert.ok(!map.routes.has('appmap://client_picker'), 'deep_link none is not a route');
      assert.deepEqual(map.elements.get('nav.invoices.tab')?.map((r) => r.screen), ['invoice_list'], 'every declaration of an id is indexed');
      assert.equal(map.elements.get('gate.push_permission.deny')?.[0]?.screen, 'gate.push_permission');
      assert.equal(map.build, '4412');
      assert.ok(map.staticLabels.has('New Invoice') && map.staticLabels.has('Invoices'));
      assert.ok(map.idsIndex.has('screen.login') && map.idsIndex.has('gate.push_permission') && map.idsIndex.has('invoice.add.button'));
      assert.equal(map.treeHash, undefined, 'a temp dir is not a git repo');
    } finally {
      t.cleanup();
    }
  });

  it('serves the android platform and honours build overrides', () => {
    const t = makeTempAppMapDir({ platform: 'android', env: { APP_MAP_BUILD: '4413' } });
    try {
      const map = loadMap(t.config);
      assert.equal(map.platform, 'android');
      assert.equal(map.build, '4413');
      assert.equal(loadMap(t.config, { build: '9' }).build, '9');
      assert.equal(loadMap(t.config, { platform: 'ios' }).manifest.platform, 'ios');
    } finally {
      t.cleanup();
    }
  });

  it('records git blob shas that equal `git hash-object` and a tree hash that tracks working-tree edits', () => {
    const idsPath = join(PILOT_APP_MAP_DIR, 'ids.yaml');
    const expected = execFileSync('git', ['hash-object', idsPath], { encoding: 'utf8' }).trim();
    assert.equal(gitBlobHash(idsPath), expected);
    assert.equal(gitBlobHash(join(PILOT_APP_MAP_DIR, 'nope.yaml')), undefined);
    const inRepo = gitTreeHash(PILOT_APP_MAP_DIR);
    assert.match(inRepo ?? '', /^[0-9a-f]{40}$/);
    const t = makeTempAppMapDir();
    try {
      assert.equal(gitTreeHash(t.dir), undefined, 'outside a git repo');
      execFileSync('git', ['init', '-q'], { cwd: t.dir });
      const h1 = gitTreeHash(t.dir);
      assert.match(h1 ?? '', /^[0-9a-f]{40}$/);
      assert.equal(gitTreeHash(t.dir), h1, 'stable');
      writeFileSync(join(t.dir, 'ios/screens/login.yaml'), readFileSync(join(t.dir, 'ios/screens/login.yaml'), 'utf8') + '# edited\n');
      assert.notEqual(gitTreeHash(t.dir), h1, 'uncommitted edits count');
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      const h2 = gitTreeHash(t.dir);
      writeFileSync(join(t.dir, '.local', 'server.log'), 'x');
      assert.equal(gitTreeHash(t.dir), h2, '.local is ignored');
    } finally {
      t.cleanup();
    }
  });

  it('reads individual files with schema validation and file-name/id agreement', () => {
    const t = makeTempAppMapDir();
    try {
      const ids = readIds(t.config);
      assert.equal(ids.schema_version, 1);
      assert.equal(readManifest(t.config).platform, 'ios');
      assert.equal(readManifest(t.config, 'android').platform, 'android');
      assert.equal(readScreenFiles(t.config).length, 7);
      assert.equal(readRecipeFiles(t.config)[0]?.recipe.id, 'create_invoice');
      assert.equal(readAllowlist(t.config).servers.length, 2);
      assert.ok(readStaticStrings(t.config).has('New Invoice'));
      assert.equal(readStaticStrings(t.config, 'android').size, 0, 'absent file → empty set');
      // 07 §2.3.3: one string per line, nothing trimmed beyond the LF, empty lines skipped
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      writeFileSync(join(t.dir, '.local/strings.android.txt'), 'Sign In \n\n  Padded\nLast');
      assert.deepEqual([...readStaticStrings(t.config, 'android')], ['Sign In ', '  Padded', 'Last']);
      // file name ≠ id
      writeFileSync(join(t.dir, 'ios/screens/renamed.yaml'), readFileSync(join(t.dir, 'ios/screens/login.yaml')));
      assert.throws(() => readScreenFiles(t.config), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && /renamed/.test(e.message));
      assert.throws(() => parseYamlFile(join(t.dir, 'missing.yaml')), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND);
    } finally {
      t.cleanup();
    }
  });

  it('loadMap throws invalid_map listing cross-reference issues, unless validate:false', () => {
    const t = makeTempAppMapDir();
    try {
      const p = join(t.dir, 'ios/screens/login.yaml');
      const doc = parse(readFileSync(p, 'utf8')) as ScreenFile;
      doc.elements[0]!.id = 'login.ghost.button';
      writeFileSync(p, canonicalYaml('screen', doc));
      assert.throws(() => loadMap(t.config), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.INVALID_MAP && /login\.ghost\.button/.test(e.message) && /rule 2/.test(e.message));
      assert.equal(loadMap(t.config, { validate: false }).screens.size, 5);
    } finally {
      t.cleanup();
    }
  });

  it('loadMap keeps rule 2 warnings on validationWarnings instead of throwing (issue #12)', () => {
    const t = makeTempAppMapDir();
    try {
      // the `import-router` shape: the app's edges, `elements: []`, nothing learned yet (01 R6)
      const idsPath = join(t.dir, 'ids.yaml');
      const ids = parse(readFileSync(idsPath, 'utf8')) as IdsRegistry;
      ids.screens.push({ id: 'settings', title: 'Settings', deep_link: 'appmap://settings' });
      ids.screens.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      writeFileSync(idsPath, canonicalYaml('ids', ids));
      const seed: ScreenFile = {
        id: 'settings', kind: 'screen', title: 'Settings', deep_link: 'appmap://settings',
        signature: { marker: 'screen.settings', route: 'appmap://settings', nav_class: 'SettingsView' },
        elements: [],
        edges: [
          { action: { type: 'tap', element: 'invoice.add.button' }, to: 'invoice_list', status: 'candidate' },
          { action: { type: 'tap', element: 'invoice.list.cell' }, to: 'invoice_detail', status: 'candidate' },
        ],
        meta: { sources: ['router_export'], status: 'candidate' },
      };
      writeFileSync(join(t.dir, 'ios/screens/settings.yaml'), canonicalYaml('screen', seed));
      const map = loadMap(t.config);
      assert.equal(map.screens.size, 6);
      assert.equal(map.validationWarnings.length, 2, JSON.stringify(map.validationWarnings));
      for (const w of map.validationWarnings) assert.equal(w.severity, 'warning');
      assert.equal(map.validationWarnings.filter(isUnlearnedEdgeElement).length, 2);
      assert.deepEqual(loadMap(t.config, { validate: false }).validationWarnings, [], 'nothing ran, so nothing is reported');
    } finally {
      t.cleanup();
    }
  });

  it('indexMap excludes gate titles from staticLabels and merges the string table', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const gate = structuredClone(map.gates.get('gate.push_permission')!);
      gate.title = 'Allow Notifications?';
      const idx = indexMap({ platform: 'ios', manifest: map.manifest, ids: map.ids, screens: [...map.screens.values(), gate], recipes: [], staticStrings: new Set(['From Table']) });
      assert.ok(!idx.staticLabels.has('Allow Notifications?'));
      assert.ok(idx.staticLabels.has('From Table'));
      assert.ok(idx.staticLabels.has('Sign In'), 'screen titles are static copy');
      assert.equal(idx.gates.size, 1);
      assert.equal(idx.build, '4412');
      assert.equal(idx.files.size, 0);
    } finally {
      t.cleanup();
    }
  });

  it('IdsRegistry read from the pilot has every gate dismiss registered only under gates[]', () => {
    const ids = parse(readFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), 'utf8')) as IdsRegistry;
    for (const g of ids.gates) assert.ok(!ids.elements.some((e) => e.id === g.dismiss), g.dismiss);
  });
});
