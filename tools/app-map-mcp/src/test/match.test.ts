/** [C1] recipes/match.ts — `match_recipe` (03 §8, 04 §4): regex cascade, ≤8 candidates, params_needed. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { LoadedMap, RecipeFile } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { loadMap } from '../yaml/load.ts';
import { MATCH_CONFIDENCE, eligibleRecipes, inferParams, matchRecipe, paramsNeeded } from '../recipes/match.ts';
import { makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let map: LoadedMap;
before(() => {
  t = makeTempAppMapDir();
  map = loadMap(t.config);
});
after(() => t.cleanup());

/** a map copy with `recipes` replaced (matchRecipe is pure — it never touches the disk) */
function withRecipes(base: LoadedMap, recipes: RecipeFile[]): LoadedMap {
  return { ...base, recipes: new Map(recipes.map((r) => [r.id, r])) };
}
function clone(base: LoadedMap, id: string, fn: (r: RecipeFile) => void): RecipeFile {
  const r = structuredClone(base.recipes.get('create_invoice')!);
  r.id = id;
  fn(r);
  return r;
}

describe('matchRecipe — 04 §4.1 regex cascade', () => {
  it('"create an invoice for $50 for Acme" hits create_invoice at 0.9 with nothing needed', () => {
    const r = matchRecipe(map, 'create an invoice for $50 for Acme');
    assert.equal(r.matched, true);
    if (!r.matched) return;
    assert.equal(r.recipe_id, 'create_invoice');
    assert.equal(r.confidence, MATCH_CONFIDENCE);
    assert.equal(r.confidence, 0.9);
    assert.equal(r.version, map.recipes.get('create_invoice')!.version);
    assert.equal(r.description, map.recipes.get('create_invoice')!.description);
    assert.deepEqual(r.params_needed, []);
  });

  it('matching is case-insensitive and matches anywhere in the instruction', () => {
    for (const q of ['CREATE AN INVOICE', 'please Make Invoice now', 'bill the client', 'new invoice']) {
      const r = matchRecipe(map, q);
      assert.equal(r.matched, true, q);
      if (r.matched) assert.equal(r.recipe_id, 'create_invoice');
    }
  });

  it('the second `matches` pattern is tried when the first misses (author order)', () => {
    const r = matchRecipe(map, 'bill a customer');
    assert.equal(r.matched, true);
    if (r.matched) assert.equal(r.recipe_id, 'create_invoice');
  });

  it('first hit wins in recipe id order when two recipes match', () => {
    const a = clone(map, 'aaa_invoice', () => {});
    const z = clone(map, 'zzz_invoice', () => {});
    const r = matchRecipe(withRecipes(map, [z, a]), 'create an invoice');
    assert.equal(r.matched, true);
    if (r.matched) assert.equal(r.recipe_id, 'aaa_invoice');
  });

  it('an uncompilable `matches` source is skipped, never thrown', () => {
    const broken = clone(map, 'broken', (r) => { r.matches = ['(unclosed', 'create an invoice']; });
    const r = matchRecipe(withRecipes(map, [broken]), 'create an invoice');
    assert.equal(r.matched, true);
  });

  it('a missing instruction is bad_input, not a crash (03 §11)', () => {
    assert.throws(() => matchRecipe(map, ''), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    assert.throws(() => matchRecipe(map, undefined as unknown as string), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });
});

describe('matchRecipe — 04 §4.2 no_match', () => {
  it('"delete a client" returns no_match with the eligible recipes as candidates', () => {
    const r = matchRecipe(map, 'delete a client');
    assert.equal(r.matched, false);
    if (r.matched) return;
    assert.equal(r.no_match, true);
    assert.deepEqual(r.candidates.map((c) => c.id), ['create_invoice']);
    assert.equal(r.text, `create_invoice — ${map.recipes.get('create_invoice')!.description}`);
  });

  it('candidates are capped at 8 lines however many recipes exist', () => {
    const many = Array.from({ length: 12 }, (_, i) => clone(map, `recipe_${String(i).padStart(2, '0')}`, (r) => { r.matches = ['^never match this$']; }));
    const r = matchRecipe(withRecipes(map, many), 'delete a client');
    assert.equal(r.matched, false);
    if (r.matched) return;
    assert.equal(r.candidates.length, 8);
    assert.equal(r.text.split('\n').length, 8);
    assert.deepEqual(r.candidates.map((c) => c.id), many.slice(0, 8).map((x) => x.id));
  });
});

describe('eligibleRecipes — 04 §4.3 platform and status filters', () => {
  it('retired recipes are never returned or matched', () => {
    const retired = clone(map, 'create_invoice', (r) => { r.status = 'retired'; });
    const m = withRecipes(map, [retired]);
    assert.deepEqual(eligibleRecipes(m), []);
    const r = matchRecipe(m, 'create an invoice');
    assert.equal(r.matched, false);
    if (!r.matched) assert.deepEqual(r.candidates, []);
  });

  it('a recipe of another platform is filtered out (explicit platform and map default)', () => {
    const android = clone(map, 'create_invoice', (r) => { r.platform = 'android'; });
    const m = withRecipes(map, [android]);
    assert.deepEqual(eligibleRecipes(m).map((r) => r.id), []);
    assert.deepEqual(eligibleRecipes(m, 'android').map((r) => r.id), ['create_invoice']);
    assert.equal(matchRecipe(m, 'create an invoice').matched, false);
    assert.equal(matchRecipe(m, 'create an invoice', 'android').matched, true);
  });

  it('every other status stays eligible and results come back in id order', () => {
    const ids = ['b_recipe', 'a_recipe', 'c_recipe'];
    const statuses = ['candidate', 'verified', 'ci_gate'] as const;
    const recipes = ids.map((id, i) => clone(map, id, (r) => { r.status = statuses[i]!; }));
    assert.deepEqual(eligibleRecipes(withRecipes(map, recipes)).map((r) => r.id), ['a_recipe', 'b_recipe', 'c_recipe']);
  });
});

describe('paramsNeeded — 04 §4.4', () => {
  const recipe = (): RecipeFile => map.recipes.get('create_invoice')!;

  it('"make invoice" supplies neither param', () => {
    assert.deepEqual(paramsNeeded(recipe(), 'make invoice'), ['amount', 'client']);
    const r = matchRecipe(map, 'make invoice');
    assert.equal(r.matched, true);
    if (r.matched) assert.deepEqual(r.params_needed, ['amount', 'client']);
  });

  it('money/number need a digit anywhere in the instruction', () => {
    assert.deepEqual(paramsNeeded(recipe(), 'create an invoice for Acme'), ['amount']);
    assert.deepEqual(paramsNeeded(recipe(), 'create an invoice for 50 for Acme'), []);
  });

  it('string needs a capitalised token or a quoted string AFTER the matched span', () => {
    // "Create" is inside the matched span, so it does not count as the client name
    assert.deepEqual(paramsNeeded(recipe(), 'Create an invoice for $50'), ['client']);
    assert.deepEqual(paramsNeeded(recipe(), 'create an invoice for $50 for "acme corp"'), []);
    assert.deepEqual(paramsNeeded(recipe(), 'create an invoice for $50 for Acme'), []);
  });

  it('bool and enum are never inferred, and optional params are never needed', () => {
    const r = structuredClone(recipe());
    r.params = [
      { name: 'draft', type: 'bool', required: true },
      { name: 'currency', type: 'enum', required: true, values: ['usd', 'eur'] },
      { name: 'note', type: 'string', required: false },
    ];
    assert.deepEqual(paramsNeeded(r, 'create an invoice for $50 for Acme Corp in USD as a draft'), ['draft', 'currency']);
  });
});

describe('inferParams — 04 §3.4 fallback values for the compiler', () => {
  it('extracts amount and client from the pilot task text', () => {
    assert.deepEqual(inferParams(map.recipes.get('create_invoice')!, 'create an invoice for $50 for Acme Corp'), { amount: 50, client: 'Acme Corp' });
  });

  it('money accepts $, thousands separators and decimals', () => {
    const params = [{ name: 'amount', type: 'money' as const, required: true }];
    assert.deepEqual(inferParams({ params }, 'bill $1,234.56 today'), { amount: 1234.56 });
    assert.deepEqual(inferParams({ params }, 'bill 7 today'), { amount: 7 });
    assert.deepEqual(inferParams({ params }, 'bill nothing'), {});
  });

  it('a quoted string beats the capitalised run, and the longest run wins', () => {
    const params = [{ name: 'client', type: 'string' as const, required: true }];
    assert.deepEqual(inferParams({ params }, 'invoice "acme corp" now for Big Client'), { client: 'acme corp' });
    assert.deepEqual(inferParams({ params }, 'invoice Acme for Big Global Corp'), { client: 'Big Global Corp' });
  });

  it('bool and enum are never inferred (04 §4.4)', () => {
    const params = [{ name: 'draft', type: 'bool' as const, required: true }, { name: 'cur', type: 'enum' as const, required: true, values: ['usd'] }];
    assert.deepEqual(inferParams({ params }, 'a draft in USD'), {});
  });
});
