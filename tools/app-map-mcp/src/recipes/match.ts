/**
 * [C1] `match_recipe {instruction, platform?}` (03 §8, 04 §4).
 *
 * 1. Filter recipes by `platform` (default `map.platform`) and `status !== 'retired'`.
 * 2. For each recipe in id order, each `matches` regex (`new RegExp(src, 'i')`) in order;
 *    first hit wins with confidence 0.9.
 * 3. No hit → `{no_match, candidates}`: every eligible recipe as `id — description`, at most 8
 *    lines (format.ts formatMatchCandidates), so the LLM can call `run_recipe` directly.
 * 4. `params_needed`: required params the instruction did not obviously supply —
 *    `money`/`number`: no digit sequence in the instruction; `string`: no capitalised token or
 *    quoted string after the matched span; `bool`/`enum`: never inferred (always needed).
 *
 * The caller (server) also calls `observe.declareTask(ctx, session, instruction)` (04 §2).
 *
 * Layer: map (imports types + format). Pure.
 */
import type { Platform } from '../config.ts';
import type { LoadedMap, MatchRecipeResult, RecipeFile, RecipeParam, RecipeParams } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { MATCH_CANDIDATES_MAX_LINES, formatMatchCandidates } from '../format.ts';

export const MATCH_CONFIDENCE = 0.9;

/** money/number: `$1,234.56`, `50`, `12.5` — the first such run in the instruction (rule 4). */
const NUMBER_RE = /\$?\d[\d,]*(?:\.\d+)?/;
/** any digit at all — 04 §4.4 "no digit sequence in the instruction" */
const DIGIT_RE = /\d/;
/** `"…"` or `'…'` or `“…”` — an explicitly quoted string value (rule 4) */
const QUOTED_RE = /["'“]([^"'”“]{1,200})["'”]/;
/** a capitalised token: `Acme`, `O'Brien`, `ACME`, `Foo-Bar` (never a bare number) */
const CAPITALISED_TOKEN_RE = /^[A-Z][\p{L}\p{N}'&.\-]*$/u;

function asString(x: unknown, what: string, hint: string): string {
  if (typeof x !== 'string' || x.trim() === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${what} must be a non-empty string`, hint);
  }
  return x;
}

/** `new RegExp(src, 'i')`, or `undefined` when the source does not compile (never throws: 07 §4). */
function compileMatcher(source: string): RegExp | undefined {
  if (typeof source !== 'string' || source === '') return undefined;
  try {
    return new RegExp(source, 'i');
  } catch {
    return undefined;
  }
}

/** 04 §4.3: the recipes `match_recipe` may return — platform filter + `status !== 'retired'`, id order. */
export function eligibleRecipes(map: LoadedMap, platform?: Platform): RecipeFile[] {
  const want = platform ?? map.platform;
  return [...map.recipes.values()]
    .filter((r) => r.platform === want && r.status !== 'retired')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * End offset of the first `matches[]` hit, so rule 4 can look at "after the matched span" only.
 * `0` when nothing matched (the whole instruction is then "after the span").
 */
function matchedSpanEnd(recipe: { matches?: readonly string[] }, instruction: string): number {
  for (const source of recipe.matches ?? []) {
    const re = compileMatcher(source);
    if (re === undefined) continue;
    const m = re.exec(instruction);
    if (m !== null) return m.index + m[0].length;
  }
  return 0;
}

/** Maximal runs of consecutive capitalised words in `text`, longest (most words) first. */
function capitalisedRuns(text: string): string[] {
  const runs: string[] = [];
  let current: string[] = [];
  const flush = (): void => {
    if (current.length > 0) runs.push(current.join(' '));
    current = [];
  };
  for (const raw of text.split(/\s+/)) {
    // trailing sentence punctuation is not part of the value ("for Acme Corp." → "Acme Corp")
    const token = raw.replace(/^[^\p{L}\p{N}$]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
    if (token !== '' && CAPITALISED_TOKEN_RE.test(token)) current.push(token);
    else flush();
  }
  flush();
  // longest run wins; ties keep document order (stable sort)
  return runs.sort((a, b) => b.split(' ').length - a.split(' ').length);
}

/** Rule 4, per param type. `after` is the instruction text following the matched span. */
function suppliedBy(param: RecipeParam, instruction: string, after: string): boolean {
  switch (param.type) {
    // 04 §4.4: "`money`/`number`: no digit sequence in the instruction"
    case 'money': case 'number': return DIGIT_RE.test(instruction);
    // "`string`: no capitalised token or quoted string after the matched span"
    case 'string': return QUOTED_RE.test(after) || capitalisedRuns(after).length > 0;
    // "`bool`/`enum`: never inferred (always needed)"
    default: return false;
  }
}

export function paramsNeeded(recipe: RecipeFile, instruction: string): string[] {
  if (!recipe || !Array.isArray(recipe.params)) return [];
  const text = typeof instruction === 'string' ? instruction : '';
  const after = text.slice(matchedSpanEnd(recipe, text));
  return recipe.params.filter((p) => p.required === true && !suppliedBy(p, text, after)).map((p) => p.name);
}

export function inferParams(recipe: Pick<RecipeFile, 'params'>, instruction: string): Partial<RecipeParams> {
  const out: Partial<RecipeParams> = {};
  if (!recipe || !Array.isArray(recipe.params)) return out;
  const text = typeof instruction === 'string' ? instruction : '';
  const after = text.slice(matchedSpanEnd(recipe as { matches?: readonly string[] }, text));
  for (const param of recipe.params) {
    if (param.type === 'money' || param.type === 'number') {
      const m = NUMBER_RE.exec(text);
      if (m === null) continue;
      const n = Number(m[0].replace(/[$,]/g, ''));
      if (Number.isFinite(n)) out[param.name] = n;
      continue;
    }
    if (param.type !== 'string') continue; // bool/enum are never inferred (04 §4.4)
    const quoted = QUOTED_RE.exec(after);
    if (quoted?.[1] !== undefined) {
      out[param.name] = quoted[1];
      continue;
    }
    const run = capitalisedRuns(after)[0];
    if (run !== undefined) out[param.name] = run;
  }
  return out;
}

export function matchRecipe(map: LoadedMap, instruction: string, platform?: Platform): MatchRecipeResult {
  asString(instruction, 'instruction', 'pass the user\'s task text, e.g. "create an invoice for $50 for Acme"');
  const eligible = eligibleRecipes(map, platform);
  // 04 §4.1-2: recipes in id order, each recipe's `matches` in author order, first hit wins
  for (const recipe of eligible) {
    for (const source of recipe.matches ?? []) {
      const re = compileMatcher(source);
      if (re === undefined || !re.test(instruction)) continue;
      return {
        matched: true,
        recipe_id: recipe.id,
        version: recipe.version,
        confidence: MATCH_CONFIDENCE,
        params_needed: paramsNeeded(recipe, instruction),
        description: recipe.description,
      };
    }
  }
  // 04 §4.2: no hit → ≤8 `id — description` candidate lines so the LLM can pick one directly
  const candidates = eligible.slice(0, MATCH_CANDIDATES_MAX_LINES).map((r) => ({ id: r.id, description: r.description }));
  return { matched: false, no_match: true, candidates, text: formatMatchCandidates(candidates) };
}
