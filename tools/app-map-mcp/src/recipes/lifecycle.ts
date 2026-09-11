/**
 * [C1] Recipe status lifecycle (02 §6, 04 §8) with the 08 §5 thresholds AS CODE — 06 §4 and
 * 08 §8 require these numbers to live here and nowhere else (drift.ts and report.ts import
 * `THRESHOLDS`).
 *
 * | transition                     | condition (from `RecipeStats`)                                              |
 * |--------------------------------|------------------------------------------------------------------------------|
 * | — → candidate                  | `markRecipe(candidate)` after compile review                                 |
 * | candidate → verified           | successes ≥ 3 across ≥ 2 sessions, `heals_pending === 0`                    |
 * | verified → ci_gate             | human `markRecipe(ci_gate)` only; `eligibleForCiGate` = success ≥ 95 % across ≥ 3 builds |
 * | any → candidate (recompile)    | failures > 50 % of the last 10 runs, or heals_pending ≥ 2, or fallback rate on the current build > 20 % |
 * | any → retired                  | a referenced screen is retired (`retireRecipesForScreen`)                    |
 *
 * `version` increments on structural change only (steps/params/entry); heals never bump it.
 *
 * Layer: session (imports context, types, yaml/canonical, events).
 */
import type { AppMapContext } from '../context.ts';
import type { RecipeStats } from '../store/db.ts';
import type { MarkRecipeResult, RecipeFile, RecipeId, RecipeStatus, RunRecord, ScreenId } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

/** 08 §5 thresholds. */
export const THRESHOLDS = {
  /** candidate → verified: successful replays needed … */
  verified_min_successes: 3,
  /** … across this many distinct sessions */
  verified_min_sessions: 2,
  /** ci_gate eligibility: replay success rate … */
  ci_gate_min_success_rate: 0.95,
  /** … across this many builds */
  ci_gate_min_builds: 3,
  /** fallback rate on one build above this forces a recompile (08 §5 row 2) */
  recompile_fallback_rate: 0.2,
  /** failure rate over the last N runs above this auto-recompiles (08 §5 row 3, 04 §8) */
  recompile_failure_rate: 0.5,
  recompile_window_runs: 10,
  /** heals pending review that force a recompile (04 §8) */
  recompile_pending_heals: 2,
  /** report alert: fallback rate per verified/ci_gate recipe on the current build (08 §4) */
  alert_fallback_rate: 0.2,
  /** report alert: pending-review heals (08 §4) */
  alert_pending_heals: 5,
  /** unknown-screen rate over a week that schedules exploration (08 §5) */
  alert_unknown_rate: 0.1,
  /** stage-2 exit: brittleness index (08 §6) */
  target_brittleness_index: 0.15,
} as const;

export interface LifecycleDecision {
  recipe: RecipeId;
  from: RecipeStatus;
  to: RecipeStatus;
  reason: 'verified' | 'recompile_failures' | 'recompile_fallbacks' | 'recompile_heals' | 'retired_screen';
  /** for recompiles: the session/seq of the latest successful trajectory to compile from */
  recompile_from?: { session: string; seq: number };
}

/** Pure: the automatic transition (if any) implied by `stats`; never returns `ci_gate` (human only). */
export function decideTransition(recipe: RecipeFile, stats: RecipeStats): LifecycleDecision | null {
  void recipe; void stats;
  throw new NotImplementedError('recipes/lifecycle.decideTransition');
}

/** Pure: 08 §5 row 1 — success ≥ 95 % across ≥ 3 builds. */
export function eligibleForCiGate(stats: RecipeStats): boolean {
  void stats;
  throw new NotImplementedError('recipes/lifecycle.eligibleForCiGate');
}

/** Pure: 04 §8 "any → candidate" predicate. */
export function shouldRecompile(stats: RecipeStats): boolean {
  void stats;
  throw new NotImplementedError('recipes/lifecycle.shouldRecompile');
}

/**
 * After a run finishes (guided or headless): bump counters, emit the `recipe_run` event, then
 * `decideTransition`; apply it in the cache (dirty) and, for recompiles, call compile with the
 * latest successful trajectory producing `version + 1` (04 §8, 04 §9 last criterion).
 */
export function recordRunOutcome(ctx: AppMapContext, run: RunRecord, outcome: { ok: boolean; steps: number; steps_done: number; ms: number }): LifecycleDecision | null {
  void ctx; void run; void outcome;
  throw new NotImplementedError('recipes/lifecycle.recordRunOutcome');
}

/**
 * `mark_recipe {recipe_id, status}` (03 §8): human-in-the-loop promote/demote. `candidate` on a
 * recipe that is not yet in the cache writes the draft (`opts.recipe`) — the only way a compiled
 * draft becomes real (04 §3.8). `ci_gate` requires `opts.reviewer` (07 §7) and
 * `eligibleForCiGate` unless `opts.force`. Marks the recipe dirty; export writes it.
 */
export function markRecipe(ctx: AppMapContext, recipeId: RecipeId, status: RecipeStatus, opts: { recipe?: RecipeFile; reviewer?: string; force?: boolean } = {}): MarkRecipeResult {
  void ctx; void recipeId; void status; void opts;
  throw new NotImplementedError('recipes/lifecycle.markRecipe');
}

/** 02 §8 / 04 §8: retire every recipe whose steps, entry or verify reference `screenId`. */
export function retireRecipesForScreen(ctx: AppMapContext, screenId: ScreenId): RecipeId[] {
  void ctx; void screenId;
  throw new NotImplementedError('recipes/lifecycle.retireRecipesForScreen');
}

/** Pure: screens a recipe depends on (entry, fallback_path, expect.screen, verify.screen, element declarations). */
export function screensReferenced(recipe: RecipeFile): ScreenId[] {
  void recipe;
  throw new NotImplementedError('recipes/lifecycle.screensReferenced');
}
