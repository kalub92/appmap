/**
 * [B1] Per-app deep-link scheme (01 R5, issue #25).
 *
 * Two instrumented apps on one device both registered `appmap://`, so the OS delivered the link —
 * and the `?fixture=` it carries — to whichever it liked, while the app-scoped capture kept
 * describing the right app and timed out. From the driver's side that reads as a hung inspector on
 * the correct bundle id, with no hint another app exists.
 *
 * The fix keeps the committed map SCHEME-RELATIVE: every `deep_link`/`url` in the YAML stays
 * `appmap://`, `manifest.deep_link_scheme` is the single per-app fact, and the rewrite happens at
 * the boundary — out to a driver, and back in from anything the app produced. These tests pin both
 * directions and the collision refusal.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { writeFileSync } from 'node:fs';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { RouterExport } from '../types.ts';
import { CANONICAL_DEEP_LINK_SCHEME, DEEP_LINK_SCHEME_REGEX, canonicalDeepLink, emitDeepLink } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { manifestFile } from '../paths.ts';
import { planPath } from '../plan.ts';
import { formatGetScreen } from '../format.ts';
import { identify } from '../identify.ts';
import { importRouter } from '../router-import.ts';
import { recipeToMaestroFlow } from '../recipes/maestro.ts';
import { toRunStep } from '../recipes/guided.ts';
import {
  assertSchemeUnique, parseSchemeOwnersPlist, parseSchemeOwnersPm, schemeOwnerCommand,
} from '../recipes/guided.ts';
import { normalizeTree } from '../tree.ts';
import { loadFixtureTree, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SCHEME = 'appmap-pokedexteams';
const PARAMS = { amount: 50, client: 'Acme Corp' };

let t: TempAppMapDir;
let ctx: AppMapContext;

/** reopen the pilot map with a custom `deep_link_scheme` in the manifest */
function openWith(scheme: string): void {
  ctx?.close();
  const path = manifestFile(t.config, 'ios');
  const yaml = [
    'schema_version: 1',
    'app_id: com.example.app',
    'platform: ios',
    `deep_link_scheme: ${scheme}`,
    'build:',
    '  version: "2026.9.1"',
    '  build_number: "4412"',
    '  git_sha: "a1b2c3d"',
    'generated_at: 2026-09-10T00:00:00Z',
    'generator: app-map-mcp@0.1.0',
    '',
  ].join('\n');
  writeFileSync(path, yaml, 'utf8');
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
}

beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
afterEach(() => { ctx.close(); t.cleanup(); });

describe('the map stays scheme-relative; the rewrite happens at the boundary (issue #25)', () => {
  it('the committed YAML is untouched by the manifest — the same map serves either build', () => {
    openWith(SCHEME);
    assert.equal(ctx.map.screens.get('invoice_new')?.deep_link, 'appmap://invoice_new');
    assert.equal(ctx.map.screens.get('invoice_detail')?.deep_link, 'appmap://invoice_detail?fixture=one_draft_invoice');
    assert.equal(ctx.map.recipes.get('create_invoice')?.entry?.deep_link, 'appmap://invoice_new?fixture=logged_in');
    // and the route index stays keyed on the canonical form, so nothing has to be rebuilt
    assert.equal(ctx.map.routes.get('appmap://invoice_new'), 'invoice_new');
  });

  it('`plan_path` hands the LLM a URL the device will actually answer', () => {
    openWith(SCHEME);
    const plan = planPath(ctx.map, 'unknown', 'invoice_new');
    assert.equal(plan.kind, 'deep_link');
    assert.equal(plan.kind === 'deep_link' && plan.deep_link, `${SCHEME}://invoice_new`);
  });

  it('`get_screen` shows the app’s scheme, because the LLM is going to open it', () => {
    openWith(SCHEME);
    assert.match(formatGetScreen(ctx.map, 'invoice_new'), new RegExp(`deep_link ${SCHEME}://invoice_new`));
  });

  it('a guided `open_link` step is handed out in the app’s scheme', () => {
    openWith(SCHEME);
    const recipe = ctx.map.recipes.get('create_invoice')!;
    const step = toRunStep(ctx.map, { id: 's0', action: 'open_link', url: recipe.entry!.deep_link! }, PARAMS);
    assert.equal(step.url, `${SCHEME}://invoice_new?fixture=logged_in`);
  });

  it('the Maestro export opens the app’s scheme', () => {
    openWith(SCHEME);
    const recipe = ctx.map.recipes.get('create_invoice')!;
    const flow = recipeToMaestroFlow(ctx.map, recipe, PARAMS);
    assert.match(flow.flow, new RegExp(`openLink: ${SCHEME}://invoice_new`));
    assert.ok(!flow.flow.includes('openLink: appmap://'), 'nothing may still emit the canonical scheme');
  });

  it('identification still matches the route the driver reports back in the app’s scheme', () => {
    openWith(SCHEME);
    const tree = normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' });
    const result = identify(ctx.map, tree, { route: `${SCHEME}://invoice_new?fixture=logged_in` });
    assert.equal(result.screen_id, 'invoice_new');
  });

  it('a router export produced by the app is canonicalized on the way in', () => {
    openWith(SCHEME);
    const doc: RouterExport = {
      schema_version: 1, app_id: 'com.example.app', platform: 'ios',
      build: { version: '2026.9.1', build_number: '4412', git_sha: 'a1b2c3d' },
      screens: [{ id: 'invoice_new', route: `${SCHEME}://invoice_new`, view_type: 'InvoiceNewView', edges: [] }],
      gates: [],
    };
    importRouter(ctx, doc, { dryRun: false, retire: false });
    // the committed form never carries the app's scheme: otherwise renaming it would rewrite every
    // screen file in the map instead of one manifest line
    assert.equal(ctx.db.getScreen('invoice_new')?.deep_link, 'appmap://invoice_new');
    assert.equal(ctx.db.getScreen('invoice_new')?.signature?.route, 'appmap://invoice_new');
  });

  it('the default is `appmap`, so an existing single-app repo changes nothing', () => {
    assert.equal(ctx.map.manifest.deep_link_scheme, CANONICAL_DEEP_LINK_SCHEME);
    const plan = planPath(ctx.map, 'unknown', 'invoice_new');
    assert.equal(plan.kind === 'deep_link' && plan.deep_link, 'appmap://invoice_new');
  });
});

describe('emitDeepLink / canonicalDeepLink are exact inverses on real links', () => {
  it('round-trips every committed pilot link', () => {
    for (const screen of ctx.map.screens.values()) {
      const link = screen.deep_link;
      if (typeof link !== 'string' || link === 'none') continue;
      assert.equal(canonicalDeepLink(emitDeepLink(link, SCHEME), SCHEME), link);
    }
  });
  it('leaves `none`, a production URL and an already-converted link alone', () => {
    assert.equal(emitDeepLink('none', SCHEME), 'none');
    assert.equal(emitDeepLink('https://example.com/x', SCHEME), 'https://example.com/x');
    assert.equal(canonicalDeepLink('https://example.com/x', SCHEME), 'https://example.com/x');
    assert.equal(emitDeepLink(`${SCHEME}://invoice_new`, SCHEME), `${SCHEME}://invoice_new`);
  });
  it('is the identity when the app kept the default', () => {
    assert.equal(emitDeepLink('appmap://invoice_new', 'appmap'), 'appmap://invoice_new');
    assert.equal(emitDeepLink('appmap://invoice_new', undefined), 'appmap://invoice_new');
    assert.equal(canonicalDeepLink('appmap://invoice_new', 'appmap'), 'appmap://invoice_new');
  });
  it('keeps the query, which is where `?fixture=` lives', () => {
    assert.equal(emitDeepLink('appmap://invoice_new?fixture=logged_in', SCHEME), `${SCHEME}://invoice_new?fixture=logged_in`);
  });
});

describe('collision detection turns a mystifying timeout into one clear refusal', () => {
  const OURS = 'com.example.PokedexTeams';

  it('refuses when another installed bundle registers the same scheme', () => {
    assert.throws(
      () => assertSchemeUnique(OURS, 'appmap', [OURS, 'com.example.SWAPIExplorer']),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.DEEP_LINK_SCHEME_COLLISION
        && /SWAPIExplorer also registers appmap:\/\//.test(e.message)
        && /deep_link_scheme: appmap-pokedexteams/.test(e.hint),
    );
  });

  it('diagnoses the OPPOSITE fault separately: the app does not register the scheme at all', () => {
    // same probe shape, different remedy — fix the plist, not the manifest. Sharing one message
    // would tell the integrator to rename a scheme that is already correct.
    assert.throws(
      () => assertSchemeUnique(OURS, 'appmap-pokedexteams', ['com.example.SWAPIExplorer']),
      (e: unknown) => AppMapError.is(e) && /does not/.test(e.message) && /CFBundleURLTypes/.test(e.hint),
    );
  });

  it('an unanswerable probe is NOT evidence — no device, no simctl, no refusal', () => {
    assert.doesNotThrow(() => assertSchemeUnique(OURS, 'appmap', null));
    assert.doesNotThrow(() => assertSchemeUnique(OURS, 'appmap', []));
  });

  it('this app owning the scheme alone is the healthy case', () => {
    assert.doesNotThrow(() => assertSchemeUnique(OURS, 'appmap', [OURS]));
  });

  it('reads the iOS owners out of a `simctl listapps` plist', () => {
    const xml = `<?xml version="1.0"?><plist version="1.0"><dict>
      <key>com.example.PokedexTeams</key><dict>
        <key>CFBundleURLTypes</key><array><dict>
          <key>CFBundleURLSchemes</key><array><string>AppMap</string></array></dict></array></dict>
      <key>com.example.SWAPIExplorer</key><dict>
        <key>CFBundleURLTypes</key><array><dict>
          <key>CFBundleURLSchemes</key><array><string>appmap</string><string>swapi</string></array></dict></array></dict>
      <key>com.apple.Maps</key><dict>
        <key>CFBundleURLTypes</key><array><dict>
          <key>CFBundleURLSchemes</key><array><string>maps</string></array></dict></array></dict>
      <key>com.example.NoUrlTypes</key><dict><key>CFBundleIdentifier</key><string>x</string></dict>
    </dict></plist>`;
    // case-insensitive on the plist side, and system apps that claim other schemes are ignored
    assert.deepEqual(parseSchemeOwnersPlist(xml, 'appmap'), ['com.example.PokedexTeams', 'com.example.SWAPIExplorer']);
    assert.deepEqual(parseSchemeOwnersPlist(xml, 'appmap-pokedexteams'), []);
  });

  it('reads the Android owners out of `pm query-activities --brief`', () => {
    const out = [
      'Activity Resolver Table:',
      '  com.example.pokedexteams/com.example.appmap.AppMapDeepLinkActivity',
      '  priority=0 com.example.swapi/com.example.appmap.AppMapDeepLinkActivity',
      '',
      '1 activities found',
    ].join('\n');
    assert.deepEqual(parseSchemeOwnersPm(out), ['com.example.pokedexteams', 'com.example.swapi']);
  });

  it('never interpolates a scheme it has not vetted (07 §4)', () => {
    assert.equal(schemeOwnerCommand(t.config, 'appmap; rm -rf /'), undefined);
    assert.equal(schemeOwnerCommand(t.config, ''), undefined);
    assert.ok(schemeOwnerCommand(t.config, 'appmap-pokedexteams')?.includes('simctl listapps'));
  });
});

describe('the scheme is validated where it is declared', () => {
  it('accepts a per-app scheme and rejects a malformed one', () => {
    assert.ok(DEEP_LINK_SCHEME_REGEX.test('appmap'));
    assert.ok(DEEP_LINK_SCHEME_REGEX.test('appmap-pokedexteams'));
    assert.ok(!DEEP_LINK_SCHEME_REGEX.test('AppMap'), 'schemes are compared lower-cased');
    assert.ok(!DEEP_LINK_SCHEME_REGEX.test('1appmap'), 'a scheme starts with a letter');
    assert.ok(!DEEP_LINK_SCHEME_REGEX.test('app map'));
    assert.ok(!DEEP_LINK_SCHEME_REGEX.test('app/map'));
  });

  it('a manifest declaring a per-app scheme loads and validates', () => {
    openWith(SCHEME);
    assert.equal(ctx.map.manifest.deep_link_scheme, SCHEME);
  });
});
