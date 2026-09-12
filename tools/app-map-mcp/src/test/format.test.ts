/** [B2] format.ts — get_screen block (03 §8), summary (03 §8, decision 25), SessionStart preamble (05 §3), step/fallback/candidate lines (04 §4–5). */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { ElementDef, LoadedMap, RecipeFile, ScreenFile } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { loadMap } from '../yaml/load.ts';
import { TRUNCATION_MARKER, estimateTokens } from '../token.ts';
import {
  GET_SCREEN_MAX_TOKENS, MATCH_CANDIDATES_MAX_LINES, STEP_MAX_TOKENS, SUMMARY_MAX_TOKENS,
  formatFallback, formatFindElement, formatGetScreen, formatMatchCandidates, formatRunStep, formatSessionStartContext, formatSummary, sessionStartPreamble,
} from '../format.ts';
import { makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

function withScreen(base: LoadedMap, screen: ScreenFile): LoadedMap {
  const screens = new Map(base.screens);
  screens.set(screen.id, screen);
  return { ...base, screens };
}
function withRecipes(base: LoadedMap, recipes: RecipeFile[]): LoadedMap {
  return { ...base, recipes: new Map(recipes.map((r) => [r.id, r])) };
}

/** the 03 §8 example layout, instantiated on the pilot invoice_list data */
const INVOICE_LIST_BLOCK = [
  'screen invoice_list  conf 0.98  title "Invoices"  deep_link appmap://invoice_list',
  'elements',
  '  invoice.add.button     button  "New Invoice"  -> invoice_new',
  '  invoice.filter.button  button  "Filter"',
  '  invoice.list.cell      cell    [dynamic]      -> invoice_detail',
  '  invoice.list.table     list    [dynamic]',
  '  nav.clients.tab        tab     "Clients"',
  '  nav.invoices.tab       tab     "Invoices"',
  '  nav.settings.tab       tab     "Settings"',
  'gates  gate.push_permission',
  'recipes  create_invoice',
].join('\n');

describe('formatGetScreen (03 §8 fixed, parse-stable block)', () => {
  it('invoice_list equals the spec example layout on the pilot data', () => {
    assert.equal(formatGetScreen(map, 'invoice_list', { confidence: 0.98 }), INVOICE_LIST_BLOCK);
  });

  it('omits the conf segment when no confidence is supplied and the title when the screen has none', () => {
    const noConf = formatGetScreen(map, 'invoice_list');
    assert.equal(noConf.split('\n')[0], 'screen invoice_list  title "Invoices"  deep_link appmap://invoice_list');
    assert.equal(noConf.split('\n').slice(1).join('\n'), INVOICE_LIST_BLOCK.split('\n').slice(1).join('\n'));
    const gate = formatGetScreen(map, 'gate.push_permission', { confidence: 1 });
    assert.equal(gate, ['screen gate.push_permission  conf 1.00  deep_link none', 'elements', '  gate.push_permission.deny  button  -  -> _previous'].join('\n'));
  });

  it('client_picker: deep_link none, no gates line, recipes line via the fallback path/steps', () => {
    assert.equal(formatGetScreen(map, 'client_picker', { confidence: 0.729 }), [
      'screen client_picker  conf 0.73  title "Choose Client"  deep_link none',
      'elements',
      '  client.picker.cancel.button  button       "Cancel"          -> invoice_new',
      '  client.picker.cell           cell         [dynamic]         -> invoice_new',
      '  client.picker.list           list         [dynamic]',
      '  client.picker.search.field   searchField  "Search clients"',
      'recipes  create_invoice',
    ].join('\n'));
  });

  it('login: gates line without a recipes line (create_invoice never touches login)', () => {
    const block = formatGetScreen(map, 'login');
    assert.ok(block.includes('\ngates  gate.biometric_prompt'));
    assert.ok(!block.includes('recipes'));
    assert.ok(block.includes('  login.submit.button     button       "Sign In"               -> invoice_list'));
  });

  it('skips retired edges and retired recipes', () => {
    const screen = structuredClone(map.screens.get('invoice_list')!);
    screen.edges.find((e) => e.to === 'invoice_new')!.status = 'retired';
    const retiredRecipe = structuredClone(map.recipes.get('create_invoice')!);
    retiredRecipe.status = 'retired';
    const block = formatGetScreen(withRecipes(withScreen(map, screen), [retiredRecipe]), 'invoice_list');
    assert.ok(block.includes('  invoice.add.button     button  "New Invoice"\n'));
    assert.ok(!block.includes('recipes'));
  });

  it('every pilot screen fits the 400-token cap; an oversized screen is cut on a line boundary with the marker', () => {
    for (const id of map.screens.keys()) {
      const block = formatGetScreen(map, id, { confidence: 1 });
      assert.ok(estimateTokens(block) <= GET_SCREEN_MAX_TOKENS, id);
      assert.ok(!block.includes(TRUNCATION_MARKER), id);
    }
    const big = structuredClone(map.screens.get('invoice_list')!);
    const template = big.elements[0]!;
    for (let i = 0; i < 300; i++) {
      const el: ElementDef = structuredClone(template);
      el.id = `invoice.generated${String(i).padStart(3, '0')}.button`;
      el.label = `Generated ${i}`;
      big.elements.push(el);
    }
    const capped = formatGetScreen(withScreen(map, big), 'invoice_list');
    assert.ok(estimateTokens(capped) <= GET_SCREEN_MAX_TOKENS);
    assert.ok(capped.endsWith(`\n${TRUNCATION_MARKER}`));
    assert.equal(capped.split('\n')[0], 'screen invoice_list  title "Invoices"  deep_link appmap://invoice_list');
    const small = formatGetScreen(map, 'invoice_list', { maxTokens: 30 });
    assert.ok(estimateTokens(small) <= 30);
    assert.ok(small.endsWith(TRUNCATION_MARKER));
  });

  it('unknown screen → AppMapError(not_found)', () => {
    assert.throws(() => formatGetScreen(map, 'nowhere'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND);
  });
});

const SUMMARY_TEXT = [
  'app-map ios build 4412: 5 screens (5 verified), 2 gates, 1 recipes',
  'screens: client_picker, invoice_detail, invoice_list, invoice_new, login',
  'gates: gate.biometric_prompt, gate.push_permission',
  'recipes:',
  '  create_invoice (verified) — Create an invoice for a client with an amount and save it',
].join('\n');

describe('formatSummary (03 §8, decision 25)', () => {
  it('produces the fixed summary text and the structured fields', () => {
    const s = formatSummary(map);
    assert.equal(s.text, SUMMARY_TEXT);
    assert.equal(s.platform, 'ios');
    assert.equal(s.build, '4412');
    assert.equal(s.screens, 5);
    assert.equal(s.screens_verified, 5);
    assert.deepEqual(s.gates, ['gate.biometric_prompt', 'gate.push_permission']);
    assert.deepEqual(s.recipes, [{ id: 'create_invoice', description: 'Create an invoice for a client with an amount and save it', status: 'verified' }]);
  });

  it('lists every recipe and gate within 600 tokens', () => {
    const s = formatSummary(map);
    assert.ok(estimateTokens(s.text) <= SUMMARY_MAX_TOKENS);
    for (const r of s.recipes) assert.ok(s.text.includes(`${r.id} (${r.status}) — ${r.description}`));
    for (const g of s.gates) assert.ok(s.text.includes(g));
  });

  it('retired recipes are excluded; no recipes → "recipes: none"; the cap truncates long recipe lists', () => {
    const retired = structuredClone(map.recipes.get('create_invoice')!);
    retired.status = 'retired';
    const none = formatSummary(withRecipes(map, [retired]));
    assert.deepEqual(none.recipes, []);
    assert.ok(none.text.endsWith('\nrecipes: none'));
    assert.ok(none.text.startsWith('app-map ios build 4412: 5 screens (5 verified), 2 gates, 0 recipes'));
    const many: RecipeFile[] = [];
    for (let i = 0; i < 80; i++) {
      const r = structuredClone(map.recipes.get('create_invoice')!);
      r.id = `recipe_${String(i).padStart(2, '0')}`;
      r.description = `Recipe number ${i} does a long list of things across several screens of the app`;
      many.push(r);
    }
    const capped = formatSummary(withRecipes(map, many));
    assert.equal(capped.recipes.length, 80);
    assert.ok(estimateTokens(capped.text) <= SUMMARY_MAX_TOKENS);
    assert.ok(capped.text.endsWith(TRUNCATION_MARKER));
  });
});

const PREAMBLE = [
  'app-map is loaded for ios build 4412. Before driving the simulator:',
  '1. call mcp__app-map__match_recipe with the task; if it matches, run_recipe (guided) and follow report_step.',
  '2. otherwise call identify_screen, then get_screen, before any tap. Prefer plan_path deep links.',
  '3. do not take screenshots unless the accessibility tree is empty.',
  '4. when a new task succeeds, call compile_recipe and review the draft.',
  'Recipes: create_invoice',
].join('\n');

describe('formatSummary — a missing static string table is visible (03 §5 step 1, 07 §2.3.3)', () => {
  it('warns in the summary and leaves the map otherwise intact', () => {
    const t2 = makeTempAppMapDir();
    try {
      assert.equal(loadMap(t2.config).stringTablePresent, true);
      assert.doesNotMatch(formatSummary(loadMap(t2.config)).text, /strings\.ios\.txt is missing/);
      rmSync(join(t2.dir, '.local/strings.ios.txt'));
      const without = loadMap(t2.config);
      assert.equal(without.stringTablePresent, false);
      assert.match(formatSummary(without).text, /strings\.ios\.txt is missing/);
    } finally {
      t2.cleanup();
    }
  });
});

describe('sessionStartPreamble / formatSessionStartContext (05 §3)', () => {
  it('is the fixed 05 §3 block with platform, build and recipe ids substituted', () => {
    assert.equal(sessionStartPreamble(map), PREAMBLE);
    const retired = structuredClone(map.recipes.get('create_invoice')!);
    retired.status = 'retired';
    assert.ok(sessionStartPreamble(withRecipes(map, [retired])).endsWith('\nRecipes: none'));
  });

  it('additionalContext = summary + blank line + preamble, capped to maxTokens', () => {
    const ctx = formatSessionStartContext(map, 600);
    assert.equal(ctx, `${SUMMARY_TEXT}\n\n${PREAMBLE}`);
    assert.ok(estimateTokens(ctx) <= 600);
    const tight = formatSessionStartContext(map, 40);
    assert.ok(estimateTokens(tight) <= 40);
    assert.ok(tight.endsWith(TRUNCATION_MARKER));
    assert.ok(tight.startsWith('app-map ios build 4412'));
  });
});

describe('formatRunStep (04 §5, ≤120 tokens)', () => {
  it('formats the documented step shapes exactly', () => {
    assert.equal(
      formatRunStep({ id: 's3', action: 'tap', element: 'invoice.client.picker', target: { by: 'id', id: 'invoice.client.picker' }, resolved: { strategy: 'a11y_id', confidence: 1, degraded: false }, expect: { screen: 'client_picker' } }),
      'step s3 tap invoice.client.picker via id "invoice.client.picker" (a11y_id 1.00) expect screen client_picker',
    );
    assert.equal(
      formatRunStep({ id: 's2', action: 'type', element: 'invoice.amount.field', target: { by: 'id', id: 'invoice.amount.field' }, text: '50' }),
      'step s2 type invoice.amount.field via id "invoice.amount.field" text "50"',
    );
    assert.equal(
      formatRunStep({ id: 's4', action: 'select', element: 'client.picker.list', match_text: 'Acme Corp', expect: { screen: 'invoice_new' } }),
      'step s4 select client.picker.list match "Acme Corp" expect screen invoice_new',
    );
    assert.equal(
      formatRunStep({ id: 's0', action: 'open_link', url: 'appmap://invoice_new?fixture=logged_in', expect: { screen: 'invoice_new' } }),
      'step s0 open_link appmap://invoice_new?fixture=logged_in expect screen invoice_new',
    );
    assert.equal(
      formatRunStep({ id: 's0a', action: 'dismiss_gate', gate: 'gate.push_permission', element: 'gate.push_permission.deny', target: { by: 'role_label', role: 'button', label: 'Don’t Allow' } }),
      'step s0a dismiss_gate gate.push_permission tap gate.push_permission.deny via role_label button "Don’t Allow"',
    );
    assert.equal(
      formatRunStep({ id: 's5', action: 'tap', element: 'invoice.save.button', target: { by: 'id', id: 'invoice.save.button' }, resolved: { strategy: 'role_label', confidence: 0.54, degraded: true }, expect: { screen: 'invoice_detail' }, intent_critical: true }),
      'step s5 tap invoice.save.button via id "invoice.save.button" (role_label 0.54 degraded) expect screen invoice_detail [intent_critical]',
    );
    assert.equal(formatRunStep({ id: 's6', action: 'swipe', direction: 'up', element: 'invoice.list.table' }), 'step s6 swipe up on invoice.list.table');
    assert.equal(
      formatRunStep({ id: 's7', action: 'wait_for', expect: { focused: 'invoice.amount.field', visible: ['a.b.c', 'd.e.f'], not_visible: ['g.h.i'], text_present: 'Saved' } }),
      'step s7 wait_for expect focused invoice.amount.field visible a.b.c,d.e.f not_visible g.h.i text_present "Saved"',
    );
    assert.equal(formatRunStep({ id: 's1', action: 'tap', element: 'x.y.z', target: { by: 'point', x: 0.5, y: 0.25 }, healing: true }), 'step s1 tap x.y.z via point 0.5,0.25 [healing]');
  });

  it('is one line and ≤120 tokens even for long text', () => {
    const long = formatRunStep({ id: 's2', action: 'type', element: 'invoice.note.field', text: 'lorem ipsum '.repeat(120) });
    assert.ok(estimateTokens(long) <= STEP_MAX_TOKENS);
    assert.ok(long.startsWith('step s2 type invoice.note.field text'));
  });
});

describe('formatFindElement / formatMatchCandidates / formatFallback', () => {
  it('find_element hit, miss and not-found lines', () => {
    const hit = formatFindElement({
      found: true, screen_id: 'invoice_list', element: 'invoice.add.button', text: '',
      hit: { status: 'hit', element: 'invoice.add.button', path: 'navigationBar/button[1]', strategy: 'role_label', locator: { strategy: 'role_label', value: { role: 'button', label: 'New Invoice' }, weight: 0.6 }, confidence: 0.54, degraded: true, disambiguated: true, target: { by: 'role_label', role: 'button', label: 'New Invoice' } },
    });
    assert.equal(hit, 'element invoice.add.button on invoice_list: role_label 0.54 disambiguated degraded -> role_label button "New Invoice" path navigationBar/button[1]');
    const miss = formatFindElement({
      found: false, screen_id: 'invoice_list', element: 'invoice.list.table', candidates: [], text: '',
      miss: { status: 'miss', element: 'invoice.list.table', tried: [{ strategy: 'a11y_id', matches: 0 }, { strategy: 'path', matches: 2 }], candidates: [{ path: 'list', role: 'list', a11y_id: 'other.list' }] },
    });
    assert.equal(miss, 'element invoice.list.table on invoice_list: miss (tried a11y_id 0, path 2)\n  candidate list list other.list');
    const none = formatFindElement({ found: false, screen_id: 'invoice_list', candidates: [{ id: 'invoice.add.button', intent: 'open_new_invoice', label: 'New Invoice' }, { id: 'invoice.list.cell' }], text: '' });
    assert.equal(none, 'no matching element on invoice_list\n  invoice.add.button — open_new_invoice "New Invoice"\n  invoice.list.cell');
    assert.ok(estimateTokens(hit) <= STEP_MAX_TOKENS && estimateTokens(miss) <= STEP_MAX_TOKENS);
  });

  it('match candidates are `id — description` lines, at most 8 (04 §4.2)', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `recipe_${i}`, description: `Does thing ${i}` }));
    const text = formatMatchCandidates(many);
    assert.equal(text.split('\n').length, MATCH_CANDIDATES_MAX_LINES);
    assert.equal(text.split('\n')[0], 'recipe_0 — Does thing 0');
    assert.equal(formatMatchCandidates([]), '');
  });

  it('fallback line names step, reason, screen seen, expectation, candidates and message', () => {
    assert.equal(
      formatFallback({ step: 's4', reason: 'heal_rejected', screen_seen: 'invoice_new', expected: { screen: 'client_picker' }, candidates: ['client.picker.search.field', 'invoice.client.picker'], message: 'heal rejected: low_score' }),
      'fallback at s4 (heal_rejected): screen_seen invoice_new; expected screen client_picker; candidates: client.picker.search.field, invoice.client.picker; heal rejected: low_score',
    );
    assert.equal(formatFallback({ step: 's1', reason: 'unknown_screen', screen_seen: 'unknown', candidates: [], message: '' }), 'fallback at s1 (unknown_screen): screen_seen unknown');
  });
});
