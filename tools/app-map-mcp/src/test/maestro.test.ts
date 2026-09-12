/** [C3] recipes/maestro.ts — recipe → Maestro flow (04 §6.2), param resolution and `maestro-export` (03 §10, 06 R5). */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import type { LoadedMap, RecipeFile, ScreenFile } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { openContext } from '../context.ts';
import type { AppMapContext } from '../context.ts';
import { loadMap } from '../yaml/load.ts';
import { indexMap } from '../yaml/load.ts';
import { maestroExport, maestroSelectorFor, readParamsFile, recipeToMaestroFlow, resolveRecipeParams, stepForCommandIndex } from '../recipes/maestro.ts';
import { ciParamsFile, maestroFlowFile } from '../paths.ts';
import { loadCiParamsFixture, loadMaestroFlowFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

/** rebuild a LoadedMap with `overrides` replacing screens/recipes of the same id */
function remap(base: LoadedMap, overrides: { screens?: ScreenFile[]; recipes?: RecipeFile[] }): LoadedMap {
  const screens = new Map<string, ScreenFile>();
  for (const s of [...base.screens.values(), ...base.gates.values()]) screens.set(s.id, s);
  for (const s of overrides.screens ?? []) screens.set(s.id, s);
  const recipes = new Map<string, RecipeFile>();
  for (const r of base.recipes.values()) recipes.set(r.id, r);
  for (const r of overrides.recipes ?? []) recipes.set(r.id, r);
  return indexMap({ platform: base.platform, manifest: base.manifest, ids: base.ids, screens: [...screens.values()], recipes: [...recipes.values()], staticStrings: base.staticLabels });
}

const PARAMS = { amount: 50, client: 'Acme Corp' };

describe('recipeToMaestroFlow — the 04 §6.2 mapping table', () => {
  it('exports create_invoice byte-for-byte to the golden flow', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS);
    assert.equal(flow.eligible, true);
    assert.deepEqual(flow.ineligible_steps, []);
    assert.equal(flow.flow, loadMaestroFlowFixture('create_invoice'));
  });

  it('produces exactly the commands the mapping table prescribes (parsed YAML)', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS);
    const [header, body] = flow.flow.split('\n---\n');
    assert.equal(header, `appId: ${map.manifest.app_id}`);
    const cmds = parse(body as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds, [
      // entry: open_link + expect screen (04 §5 step 5, 04 §6.2 rows 1 and 7)
      { openLink: 'appmap://invoice_new?fixture=logged_in' },
      { extendedWaitUntil: { visible: { id: 'screen.invoice_new' }, timeout: 10000 } },
      // s1 tap + expect focused (04 §10: `focused: true` selector)
      { tapOn: { id: 'invoice.amount.field' } },
      { assertVisible: { id: 'invoice.amount.field', focused: true } },
      // s2 type = tapOn + inputText with `{amount}` substituted
      { tapOn: { id: 'invoice.amount.field' } },
      { inputText: '50' },
      // s3 tap + expect screen
      { tapOn: { id: 'invoice.client.picker' } },
      { extendedWaitUntil: { visible: { id: 'screen.client_picker' }, timeout: 10000 } },
      // s4 select = scrollUntilVisible + tapOn by text, `{client}` substituted
      { scrollUntilVisible: { element: { text: 'Acme Corp' } } },
      { tapOn: { text: 'Acme Corp' } },
      { extendedWaitUntil: { visible: { id: 'screen.invoice_new' }, timeout: 10000 } },
      // s5 tap + expect screen
      { tapOn: { id: 'invoice.save.button' } },
      { extendedWaitUntil: { visible: { id: 'screen.invoice_detail' }, timeout: 10000 } },
      // recipe verify: screen + each visible
      { extendedWaitUntil: { visible: { id: 'screen.invoice_detail' }, timeout: 10000 } },
      { assertVisible: { id: 'invoice.detail.amount.text' } },
    ]);
    assert.deepEqual(flow.command_index, { s0: 0, s1: 2, s2: 4, s3: 6, s4: 8, s5: 11 });
  });

  it('maps a failing command index back to its step (04 §6.1)', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS);
    assert.equal(stepForCommandIndex(flow, 0), 's0');
    assert.equal(stepForCommandIndex(flow, 1), 's0');
    assert.equal(stepForCommandIndex(flow, 6), 's3');
    assert.equal(stepForCommandIndex(flow, 7), 's3');
    assert.equal(stepForCommandIndex(flow, 13), 's5');
  });

  it('compiles expect.focused to a plain assertVisible when focusedSelector is false (04 §10)', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS, { focusedSelector: false });
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds[3], { assertVisible: { id: 'invoice.amount.field' } });
  });

  it('re-exports from step k without the entry (04 §6.1 retry after a heal)', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS, { fromStep: 's3' });
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds[0], { tapOn: { id: 'invoice.client.picker' } });
    assert.deepEqual(Object.keys(flow.command_index), ['s3', 's4', 's5']);
  });

  it('uses an override locator for the healed element (heal verify, 04 §7.2 rule 3)', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(map, recipe, PARAMS, {
      fromStep: 's5',
      overrides: { 'invoice.save.button': { strategy: 'role_label', value: { role: 'button', label: 'Save Invoice' }, weight: 0.6 } },
    });
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds[0], { tapOn: { text: 'Save Invoice' } });
  });
});

describe('recipeToMaestroFlow — gates (04 §6.2 dismiss_gate row)', () => {
  /** a recipe that acts on invoice_list, whose screen file lists `gate.push_permission` */
  const gateRecipe: RecipeFile = {
    id: 'open_new_invoice',
    version: 1,
    platform: 'ios',
    description: 'open the new invoice screen',
    matches: ['new invoice'],
    params: [],
    entry: { deep_link: 'appmap://invoice_list' },
    steps: [{ id: 's1', action: 'tap', element: 'invoice.add.button', expect: { screen: 'invoice_new' } }],
    verify: { screen: 'invoice_new' },
    status: 'candidate',
    provenance: { compiled_from: 'test', compiled_by: 'app-map-mcp@0.1.0' },
  };

  it('emits a runFlow guard before every step on a screen listing the gate', () => {
    const flow = recipeToMaestroFlow(map, gateRecipe, {});
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    // s0 (entry) is taken before the screen is known, so the guard lands on s1
    assert.deepEqual(cmds[2], {
      runFlow: {
        when: { visible: { id: '^(Allow|Don.t Allow)$' } },
        commands: [{ tapOn: { id: '^Don.t Allow$' } }],
      },
    });
    assert.deepEqual(cmds[3], { tapOn: { id: 'invoice.add.button' } });
    assert.equal(flow.command_index.s1, 2, 'command_index points at the guard so a failing guard maps to its step');
    assert.equal(flow.eligible, true);
  });

  it('emits an explicit dismiss_gate step as the same runFlow guard', () => {
    const recipe: RecipeFile = { ...gateRecipe, steps: [{ id: 's1', action: 'dismiss_gate', gate: 'gate.push_permission' }] };
    const flow = recipeToMaestroFlow(map, recipe, {});
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    const guards = cmds.filter((c) => 'runFlow' in c);
    assert.equal(guards.length, 2, 'one from the screen gates list, one from the explicit step');
  });
});

describe('recipeToMaestroFlow — headless eligibility (04 §6.2 last paragraph)', () => {
  it('rejects a recipe whose step element only has path/geometry locators', () => {
    const invoiceNew = map.screens.get('invoice_new');
    assert.ok(invoiceNew);
    const stripped: ScreenFile = structuredClone(invoiceNew);
    for (const el of stripped.elements) {
      if (el.id !== 'invoice.save.button') continue;
      el.locators = el.locators.filter((l) => l.strategy === 'path' || l.strategy === 'geometry');
      assert.ok(el.locators.length > 0, 'the pilot element has a path locator to keep');
    }
    const patched = remap(map, { screens: [stripped] });
    const recipe = patched.recipes.get('create_invoice');
    assert.ok(recipe);
    const flow = recipeToMaestroFlow(patched, recipe, PARAMS);
    assert.equal(flow.eligible, false);
    assert.deepEqual(flow.ineligible_steps, ['s5']);
  });

  it('rejects a recipe with no deep link and no usable fallback path', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const noEntry: RecipeFile = { ...recipe, entry: {} };
    const flow = recipeToMaestroFlow(map, noEntry, PARAMS);
    assert.equal(flow.eligible, false);
    assert.deepEqual(flow.ineligible_steps, ['s0']);
  });

  it('expands a fallback path into s0a… edge taps when there is no entry deep link', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const viaPath: RecipeFile = { ...recipe, entry: { fallback_path: ['invoice_list', 'invoice_new'] } };
    const flow = recipeToMaestroFlow(map, viaPath, PARAMS);
    assert.equal(flow.eligible, true);
    assert.equal(flow.command_index.s0, 0);
    assert.equal(typeof flow.command_index.s0a, 'number');
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds[0], { openLink: 'appmap://invoice_list' });
    // the gate guard for invoice_list is emitted before the s0a edge tap
    assert.ok(cmds.some((c) => 'runFlow' in c));
    assert.ok(cmds.some((c) => JSON.stringify(c) === JSON.stringify({ tapOn: { id: 'invoice.add.button' } })));
  });
});

describe('recipeToMaestroFlow — the mapping-table rows the pilot recipe does not exercise', () => {
  const kitchenSink: RecipeFile = {
    id: 'kitchen_sink',
    version: 1,
    platform: 'ios',
    description: 'every remaining 04 §6.2 row',
    matches: ['kitchen sink'],
    params: [],
    entry: { deep_link: 'appmap://invoice_new' },
    steps: [
      { id: 's1', action: 'swipe', direction: 'up', duration_ms: 400 },
      { id: 's2', action: 'swipe', direction: 'left' },
      { id: 's3', action: 'open_link', url: 'appmap://invoice_list' },
      { id: 's4', action: 'wait_for', timeout_ms: 2000, expect: { screen: 'invoice_list' } },
      { id: 's5', action: 'wait_for', expect: { visible: ['invoice.add.button'] } },
      { id: 's6', action: 'tap', element: 'invoice.add.button', expect: { not_visible: ['invoice.filter.button'], text_present: 'Invoices' } },
    ],
    verify: { screen: 'invoice_new' },
    status: 'candidate',
    provenance: { compiled_from: 'test', compiled_by: 'app-map-mcp@0.1.0' },
  };

  it('maps swipe, open_link, wait_for, not_visible and text_present', () => {
    const flow = recipeToMaestroFlow(map, kitchenSink, {});
    assert.equal(flow.eligible, true);
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    const at = (step: string, offset = 0): Record<string, unknown> => cmds[(flow.command_index[step] as number) + offset] as Record<string, unknown>;
    assert.deepEqual(at('s1'), { swipe: { direction: 'UP', duration: 400 } });
    assert.deepEqual(at('s2'), { swipe: { direction: 'LEFT' } }, 'duration is omitted when the step has none');
    assert.deepEqual(at('s3'), { openLink: 'appmap://invoice_list' });
    // wait_for carries its own timeout (04 §6.2 wait_for row)
    assert.deepEqual(at('s4'), { extendedWaitUntil: { visible: { id: 'screen.invoice_list' }, timeout: 2000 } });
    // and falls back to the 10 000 ms default, waiting on the element when there is no screen
    assert.deepEqual(at('s5', 1), { extendedWaitUntil: { visible: { id: 'invoice.add.button' }, timeout: 10000 } });
    const tail = cmds.slice(flow.command_index.s6 as number);
    assert.ok(tail.some((c) => JSON.stringify(c) === JSON.stringify({ assertNotVisible: { id: 'invoice.filter.button' } })));
    assert.ok(tail.some((c) => JSON.stringify(c) === JSON.stringify({ assertVisible: { text: 'Invoices' } })));
  });

  it('guards every step taken on a gated screen, not just the first (04 §6.2 dismiss_gate row)', () => {
    const flow = recipeToMaestroFlow(map, kitchenSink, {});
    const cmds = parse(flow.flow.split('\n---\n')[1] as string) as Array<Record<string, unknown>>;
    // s5 and s6 are both on invoice_list, which lists gate.push_permission
    for (const step of ['s5', 's6']) {
      assert.ok('runFlow' in (cmds[flow.command_index[step] as number] ?? {}), `${step} is not guarded`);
    }
    assert.equal(cmds.filter((c) => 'runFlow' in c).length, 2);
  });
});

describe('maestroSelectorFor — the locator cascade (04 §6.2)', () => {
  it('prefers a11y_id, falls back to role_label and text, and never exports path/geometry', () => {
    const byId = maestroSelectorFor({ id: 'a.b.c', role: 'button', status: 'verified', locators: [{ strategy: 'path', value: 'navigationBar/button[1]', weight: 0.25 }, { strategy: 'a11y_id', value: 'a.b.c', weight: 1 }] });
    assert.deepEqual(byId, { id: 'a.b.c' });
    const byLabel = maestroSelectorFor({ id: 'a.b.c', role: 'button', status: 'verified', locators: [{ strategy: 'role_label', value: { role: 'button', label: 'New Invoice' }, weight: 0.6 }] });
    assert.deepEqual(byLabel, { text: 'New Invoice' });
    const byRegex = maestroSelectorFor({ id: 'a.b.c', role: 'button', status: 'verified', locators: [{ strategy: 'role_label', value: { role: 'button', label_regex: '^Don.t Allow$' }, weight: 0.8 }] });
    assert.deepEqual(byRegex, { id: '^Don.t Allow$' });
    const byText = maestroSelectorFor({ id: 'a.b.c', role: 'button', status: 'verified', locators: [{ strategy: 'text', value: 'Filter', weight: 0.3 }] });
    assert.deepEqual(byText, { text: 'Filter' });
    const none = maestroSelectorFor({ id: 'a.b.c', role: 'button', status: 'verified', locators: [{ strategy: 'geometry', value: { x: 0.5, y: 0.5 }, weight: 0.1 }] });
    assert.equal(none, undefined);
  });
});

describe('params (04 §6.2, decision 36)', () => {
  it('resolves explicit → params file → enum default', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    const file = loadCiParamsFixture().create_invoice;
    assert.deepEqual(resolveRecipeParams(recipe, { explicit: { amount: 7 }, file }), { amount: 7, client: 'Acme Corp' });
    assert.deepEqual(resolveRecipeParams(recipe, { file }), { amount: 50, client: 'Acme Corp' });
    const withEnum: RecipeFile = { ...recipe, params: [{ name: 'currency', type: 'enum', required: true, values: ['USD', 'EUR'] }] };
    assert.deepEqual(resolveRecipeParams(withEnum, {}), { currency: 'USD' });
  });

  it('throws bad_input naming <recipe>.<param> when a required param has no value', () => {
    const recipe = map.recipes.get('create_invoice');
    assert.ok(recipe);
    assert.throws(
      () => resolveRecipeParams(recipe, {}),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && e.message.includes('create_invoice.amount') && e.message.includes('create_invoice.client'),
    );
  });

  it('readParamsFile returns {} when absent and optional, bad_input when required or malformed', () => {
    assert.deepEqual(readParamsFile(join(t.dir, 'nope.json')), {});
    assert.throws(() => readParamsFile(join(t.dir, 'nope.json'), { required: true }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    const bad = join(t.dir, '.local', 'bad-params.json');
    writeFileSync(bad, '{"create_invoice": {"amount": [1]}}');
    assert.throws(() => readParamsFile(bad), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    writeFileSync(bad, 'not json');
    assert.throws(() => readParamsFile(bad), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });

  it('reads the CI params file the helper installed', () => {
    assert.deepEqual(readParamsFile(ciParamsFile(t.config)), { create_invoice: { amount: 50, client: 'Acme Corp' } });
  });
});

describe('maestroExport (03 §10, 06 R5)', () => {
  let ctx: AppMapContext;
  let temp: TempAppMapDir;
  before(() => {
    temp = makeTempAppMapDir();
    ctx = openContext(temp.config, { logSink: 'none', skipRetention: true });
  });
  after(() => {
    ctx.close();
    temp.cleanup();
  });

  it('writes one flow per recipe into --out, using the installed params file', () => {
    const outDir = join(temp.dir, '.local', 'ci-maestro');
    const result = maestroExport(ctx, { all: true, outDir });
    assert.equal(result.out_dir, outDir);
    const entry = result.flows.find((f) => f.recipe === 'create_invoice');
    assert.ok(entry);
    assert.equal(entry.eligible, true);
    assert.equal(entry.path, maestroFlowFile(temp.config, 'create_invoice', outDir));
    assert.ok(existsSync(entry.path));
    assert.equal(readFileSync(entry.path, 'utf8'), loadMaestroFlowFixture('create_invoice'));
  });

  it('--status ci_gate exports nothing on the pilot (create_invoice is `verified`)', () => {
    const outDir = join(temp.dir, '.local', 'gate-maestro');
    const result = maestroExport(ctx, { statuses: ['ci_gate'], outDir });
    assert.deepEqual(result.flows, []);
  });

  it('fails with bad_input when a required param has no value anywhere', () => {
    const bare = makeTempAppMapDir({ withCiParams: false });
    const bareCtx = openContext(bare.config, { logSink: 'none', skipRetention: true });
    try {
      assert.throws(
        () => maestroExport(bareCtx, { all: true, outDir: join(bare.dir, '.local', 'maestro') }),
        (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && e.message.includes('create_invoice.amount'),
      );
    } finally {
      bareCtx.close();
      bare.cleanup();
    }
  });

  it('exports a ci_gate recipe once it is promoted (06 R5)', () => {
    const recipe = ctx.map.recipes.get('create_invoice');
    assert.ok(recipe);
    ctx.db.putRecipe({ ...recipe, status: 'ci_gate' }, { dirty: false });
    const outDir = join(temp.dir, '.local', 'gate2-maestro');
    const result = maestroExport(ctx, { statuses: ['ci_gate'], outDir });
    assert.deepEqual(result.flows.map((f) => f.recipe), ['create_invoice']);
    assert.ok(existsSync(result.flows[0]?.path as string));
    ctx.db.putRecipe(recipe, { dirty: false });
  });

  it('never writes an ineligible flow (06 R5 runs `maestro test <dir>` over everything)', () => {
    const recipe = ctx.map.recipes.get('create_invoice');
    assert.ok(recipe);
    ctx.db.putRecipe({ ...recipe, id: 'no_entry', entry: {} }, { dirty: false });
    const outDir = join(temp.dir, '.local', 'partial-maestro');
    const result = maestroExport(ctx, { recipes: ['no_entry'], outDir, params: { no_entry: { amount: 1, client: 'x' } } });
    assert.equal(result.flows[0]?.eligible, false);
    assert.deepEqual(result.flows[0]?.ineligible_steps, ['s0']);
    assert.equal(existsSync(result.flows[0]?.path as string), false);
  });

  it('not_found for an unknown recipe id', () => {
    assert.throws(() => maestroExport(ctx, { recipes: ['nope'] }), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND);
  });
});
