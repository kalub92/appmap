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
import type { LoadedMap, MatchRecipeResult, RecipeFile, RecipeParams } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

export const MATCH_CONFIDENCE = 0.9;

export function matchRecipe(map: LoadedMap, instruction: string, platform?: Platform): MatchRecipeResult {
  void map; void instruction; void platform;
  throw new NotImplementedError('recipes/match.matchRecipe');
}

/** Required param names the instruction does not obviously supply (rule 4). */
export function paramsNeeded(recipe: RecipeFile, instruction: string): string[] {
  void recipe; void instruction;
  throw new NotImplementedError('recipes/match.paramsNeeded');
}

/**
 * Best-effort param extraction from the instruction (money/number → first `$?digits[.digits]`,
 * string → first quoted string, else the longest run of capitalised words after the matched
 * span — `"for Acme Corp"` → `Acme Corp`; bool/enum → never). Used by `match_recipe` for
 * `params_needed` and by the compiler as the fallback for `CompileRecipeInput.values` (04 §3.4).
 */
export function inferParams(recipe: Pick<RecipeFile, 'params'>, instruction: string): Partial<RecipeParams> {
  void recipe; void instruction;
  throw new NotImplementedError('recipes/match.inferParams');
}

/** Eligible recipes (platform + non-retired) in id order. */
export function eligibleRecipes(map: LoadedMap, platform?: Platform): RecipeFile[] {
  void map; void platform;
  throw new NotImplementedError('recipes/match.eligibleRecipes');
}
