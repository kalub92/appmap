/**
 * [C1] Recipe AND screen status lifecycle (02 §6, 02 §8, 04 §8) with the 08 §5 thresholds AS CODE
 * — 06 §4 and 08 §8 require these numbers to live here and nowhere else (drift.ts and report.ts
 * import `THRESHOLDS`).
 *
 * ## Recipe transitions
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
 * ## Screen transitions (02 §8, issue #16)
 *
 * | transition                     | condition                                                                    |
 * |--------------------------------|------------------------------------------------------------------------------|
 * | — → candidate                  | `observe.nameScreen` (and `router-import`)                                   |
 * | candidate → verified           | ONE clean observation: marker + every `required_id` + a matching structural hash (`markVerified`, 08 §5 row 5) — NEVER while `elements[]` is empty (issue #12) |
 * | verified → candidate           | human `markScreen(candidate)` only — the only way back out, and what makes a `name_screen` re-learn possible |
 * | any → retired                  | dropped from the router export, or human `markScreen(retired)`; both cascade through `retireRecipesForScreen` |
 *
 * Promotion on a single observation is deliberate (a screen is cheap to re-verify), but it means
 * a screen learned from a slightly wrong tree self-certifies against that same wrong tree — hence
 * `markScreen`, and `nameScreen`'s `force`. Requiring ≥2 observations from distinct sessions would
 * close that window and is filed as a follow-up; nothing here depends on it being one.
 *
 * ## The recompile write guard (04 §8, issue #13)
 *
 * Row 4 above rebuilds the recipe from the latest successful trajectory. A rebuild can only ever
 * encode what the driver managed to do, so whatever it failed at is compiled out and the recipe
 * converges on the subset that always passes — silent test erosion, and the reported case was a
 * reviewed 3-step search recipe whose `type` step vanished and which then reported PASS while
 * testing nothing. `export`'s conflict check cannot see this: nobody edited the file on disk, so
 * from its point of view the rewrite is the normal write path.
 *
 * So `recompileFrom` writes only when ALL THREE hold, and otherwise keeps the reviewed recipe and
 * reports the refusal (`RecompileOutcome`, an `error` log line and a 08 §2 `compile` event with
 * `ok:false`) — the same shape as a heal on an `intent_critical` element, which is rejected for
 * a human rather than guessed (04 §7.2 `rejectHeal`):
 *
 * 1. **the compile raised no INCOMPLETENESS warning.** A `CompileRecipeResult.warnings` entry is
 *    one of two things, and only one of them is a defect report:
 *    - *incompleteness* — a driver call was dropped (04 §3.3), a call failed and left the slice
 *      (04 §3.1), the prose is a placeholder (04 §3.8). Each says the rebuild is not a faithful
 *      record of the run, so it never overwrites a reviewed file unattended. Note this blocks on
 *      dropped calls the reviewed recipe never had: the coverage rule below cannot see those,
 *      which is exactly why this gate exists beside it.
 *    - *normalisation* — the 04 §3.2 backtracking-collapse note and the 04 §3.3 secondary-attach
 *      note for a `type` whose target came from the tapped field rather than a reported focus
 *      (`compile.isNormalisationWarning`, the one predicate both sides share). Each is what the
 *      compiler does to EVERY trajectory by design, including the one the reviewer approved: the
 *      collapse removes an excursion the run did not need, and the attach note names the rule
 *      that chose a target which is still in the step. They are notes so a human can find the
 *      spot, not evidence of loss. Anything the collapse removed that the reviewed recipe needs
 *      is caught by name by rule 2. Blocking on either would refuse the pilot's own trajectory —
 *      and, since Argent reports no focus at all (issue #18), would refuse EVERY iOS recompile
 *      of a recipe containing a `type` — making the 04 §9 automatic recompile true only on
 *      paper. The notes still travel on `RecompileOutcome.warnings` and into the
 *      `recipe recompiled` log line.
 * 2. **the rebuilt step list COVERS the reviewed one** (`recompileCovers`).
 * 3. **the rebuilt `preconditions` and `entry` cover the reviewed ones** (`recompileCoversEntry`).
 *
 * ### Coverage
 *
 * `next` covers `previous` when the reviewed steps appear in the rebuilt list **in order, as a
 * subsequence**, matched on a step's IDENTITY — its `action` plus the single thing it acts on:
 *
 * | action              | identity                              |
 * |---------------------|---------------------------------------|
 * | `tap` / `type`      | `element`                             |
 * | `select`            | `list`                                |
 * | `dismiss_gate`      | `gate`                                |
 * | `open_link`         | `url`                                 |
 * | `swipe`             | `direction` + `element` (if any)      |
 * | `wait_for`          | `expect.screen`                       |
 *
 * A subsequence, not equality: EXTRA rebuilt steps between two reviewed ones are fine — that is
 * what makes an accepted rebuild a superset. Deliberately NOT part of a step's identity:
 *
 * - `id`: every compile renumbers `s1…sn` (`compile.renumber`), so ids carry no meaning across
 *   a rebuild.
 * - the data a step carries (`type.text`, `select.match.text`). A value that was `{amount}` in
 *   the reviewed recipe can come back as the literal `50`, or the reverse, purely because of
 *   which `values` the replayed run happened to carry (04 §3.4) — so a `{param}` slot and the
 *   literal it was compiled from ARE the same step here. Comparing them would report a removal
 *   that did not happen, and the erosion this guard exists to catch is a step DISAPPEARING, not
 *   a slot being re-resolved.
 *
 * Two further checks ride on the MATCHED PAIRS, because "still present" is not the same as
 * "still testing anything" — a step that kept its action but lost its postcondition is exactly
 * how a degraded recipe reports PASS:
 *
 * - a matched step must keep every assertion its reviewed `expect` made: `screen`, `focused` and
 *   `text_present` equal, `visible`/`not_visible` supersets. A rebuild may make a postcondition
 *   STRONGER, never weaker; a reviewed `expect` of `undefined` is covered by anything (02 §6).
 * - a matched step that was `intent_critical: true` must come back `intent_critical: true`
 *   (04 §3.7). `compile.markIntentCritical` recomputes it from ids.yaml, so this only fires when
 *   a human un-marked the element — a decision that belongs in `mark`, not in a replay.
 *
 * Matching is greedy: a reviewed step pairs with the FIRST rebuilt step of the same identity at
 * or after the previous match. On a recipe with two identical taps that can pair against the
 * weaker of two twins and refuse where a smarter pairing would accept; refusing is the safe
 * direction, so the simple rule stands.
 *
 * ### Preconditions and entry (`recompileCoversEntry`)
 *
 * Steps are not the only thing a rebuild can quietly drop. `compile` re-derives
 * `preconditions: [{auth: logged_in}]` and `entry` from the trajectory (04 §3.5), so a replay
 * whose slice starts AFTER the entry navigation rebuilds neither — the pilot's own recompile from
 * seqs 4-8 loses `preconditions: [{auth: logged_in}]` and the `?fixture=logged_in` on its deep
 * link, leaving a recipe that runs the same taps against a logged-OUT app. Same erosion, other
 * route, so the same rule:
 *
 * - every reviewed `preconditions` entry must come back (compared on `conditionKey`, order-free);
 *   an EXTRA one is a narrowing, not a loss;
 * - a reviewed `entry.deep_link` must come back and still cover (`deepLinkCovers`): same screen,
 *   and every query parameter it carried still present. Adding `?fixture=logged_in` is a
 *   strengthening and is fine; dropping it is `preconditions` loss in URL form;
 * - `entry.fallback_path` is checked ONLY when the reviewed recipe had no deep link, i.e. when
 *   navigation is the one way in. Otherwise `optimizeEntry` derives it from whatever leading
 *   navigation the slice happened to hold, so a shorter one says "this run entered by deep link",
 *   not "the route was deleted"; refusing on it would refuse nearly every healthy recompile over
 *   a signal carrying no information.
 *
 * OUT of scope by design: `params`, `verify`, `description`, `matches` — carried over from the
 * previous recipe by `compile.compileRecipe`, so they cannot weaken here.
 *
 * ### What an accepted rebuild carries
 *
 * `provenance.reviewed_by` is carried forward (issue #13 criterion 3): an accepted rebuild never
 * removes what the reviewer approved, and dropping the signature would make a machine-written
 * file read as merely unreviewed while destroying the 07 §7 record of who signed it. The recipe
 * is demoted to `candidate` either way, so a `ci_gate` recipe that gets recompiled keeps its
 * historical reviewer but loses its gate status until a human runs `mark(ci_gate)` again.
 *
 * Because that signature outlives the steps it was given for, an accepted rebuild also stamps
 * `provenance.machine_recompile: true` (issue #13 criterion 4, the in-file half). `compiled_from`
 * moving to the replay session already implies as much, but only to a reader who knows what that
 * implies; the marker says it outright, sits directly above `reviewed_by` in the canonical key
 * order so a PR diff reads "machine-built steps, historical signature", and is deleted by
 * `markRecipe` the moment a human signs the recipe again.
 *
 * `APP_MAP_RECOMPILE=off` (03 §3) skips the rebuild entirely — replay is then strictly read-only
 * against the map and only the status transition happens.
 *
 * Layer: session (imports context, types, config, store/db, store/export.unifiedDiff,
 * yaml/canonical, yaml/schemas, validate, events).
 */
import type { AppMapContext } from '../context.ts';
import type { RecipeStats } from '../store/db.ts';
import { RECOMPILE_DIRTY_PREFIX } from '../store/db.ts';
import type { BuildNumber, Condition, EdgeAction, ElementDef, ElementId, Expect, MarkRecipeInput, MarkRecipeResult, MarkScreenInput, MarkScreenResult, RecipeFile, RecipeId, RecipeStatus, RecipeStep, RunRecord, ScreenFile, ScreenId, ScreenStatus, StepId } from '../types.ts';
import { RECIPE_STATUSES, SCREEN_STATUSES, edgeElement, now, screenIdOfDeepLink, selectTarget, stepElement } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { schemaDir } from '../paths.ts';
import { crossReferenceIssues } from '../validate.ts';
import { unifiedDiff } from '../store/export.ts';
import type { ParsedYaml } from '../yaml/canonical.ts';
import { canonicalYaml, parseYamlDoc } from '../yaml/canonical.ts';
import { formatSchemaIssue, validateAgainstSchema } from '../yaml/schemas.ts';
import { compileRecipe, isNormalisationWarning } from './compile.ts';

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
  /**
   * … but only once the window holds a meaningful sample. 08 §5 row 3 reads "> 50 % of the last
   * 10 runs"; without a floor a single failure on a recipe with no run history is 1/1 = 100 %
   * and instantly demotes a freshly verified recipe.
   */
  recompile_min_runs: 3,
  /** heals pending review that force a recompile (04 §8) */
  recompile_pending_heals: 2,
  /** report alert: fallback rate per verified/ci_gate recipe on the current build (08 §4) */
  alert_fallback_rate: 0.2,
  /** report alert: pending-review heals (08 §4) */
  alert_pending_heals: 5,
  /** unknown-screen rate over a week that schedules exploration (08 §5 row 6) … */
  alert_unknown_rate: 0.1,
  /** … measured over this trailing window (`ReportMetrics.unknown_screen_rate_7d`) */
  alert_unknown_window_days: 7,
  /** stage-2 exit: brittleness index (08 §6) */
  target_brittleness_index: 0.15,
} as const;

/** Why a rebuilt recipe was NOT written over the reviewed one (04 §8 write guard, issue #13). */
export type RecompileRefusal =
  | 'disabled' | 'compile_failed' | 'warnings'
  | 'missing_steps' | 'weakened_steps'
  | 'missing_preconditions' | 'weakened_entry';

/**
 * What `recompileFrom` did. Reported on the `LifecycleDecision`, in the log, and — when it
 * refused — as a 08 §2 `compile` event with `ok:false`.
 */
export interface RecompileOutcome {
  /** true exactly when the rebuilt recipe replaced the previous one in the cache */
  written: boolean;
  /** empty exactly when `written`; EVERY reason that applied, so one report names them all */
  refusals: RecompileRefusal[];
  /** ids of reviewed steps the rebuild dropped (the reported case: a `type` step) */
  missing_steps: StepId[];
  /** ids of matched reviewed steps whose `expect` or `intent_critical` came back weaker */
  weakened_steps: StepId[];
  /** reviewed `preconditions` the rebuild dropped, rendered `auth=logged_in` (04 §8, issue #13) */
  missing_preconditions: string[];
  /** what the rebuilt `entry` lost: a deep link, one of its `?fixture=` params, a fallback screen */
  entry_loss: string[];
  /**
   * every compile warning (or the failure reason), blocking or not — `refusals` says whether any
   * of them stopped the write, and the 04 §3.2 collapse note never does (see the module header)
   */
  warnings: string[];
  /** unified diff reviewed → rebuilt, for the human who has to decide; empty when there is no draft */
  diff: string;
  /** the reviewed recipe carried `provenance.reviewed_by` (07 §7) — a refusal here is louder */
  was_reviewed: boolean;
}

export interface LifecycleDecision {
  recipe: RecipeId;
  from: RecipeStatus;
  to: RecipeStatus;
  reason: 'verified' | 'recompile_failures' | 'recompile_fallbacks' | 'recompile_heals' | 'retired_screen';
  /** for recompiles: the session/seq of the latest successful trajectory to compile from */
  recompile_from?: { session: string; seq: number };
  /** present only when a recompile was attempted (04 §8 row 4) — see `RecompileOutcome` */
  recompile?: RecompileOutcome;
}

/** Pure: the automatic transition (if any) implied by `stats`; never returns `ci_gate` (human only). */
export function decideTransition(recipe: RecipeFile, stats: RecipeStats): LifecycleDecision | null {
  if (!recipe || typeof recipe.id !== 'string' || !stats) return null;
  const from = recipe.status;
  // a retired recipe references a retired screen (02 §8): it is never revived automatically
  if (from === 'retired') return null;
  const base = { recipe: recipe.id, from } as const;

  // 04 §8 "any → candidate (recompile)" — checked before promotion so a failing recipe is
  // never promoted; reasons are tried in the order 04 §8 / 08 §5 list them
  if (failureRateExceeded(stats)) {
    return { ...base, to: 'candidate', reason: 'recompile_failures' };
  }
  if (stats.heals_pending >= THRESHOLDS.recompile_pending_heals) {
    return { ...base, to: 'candidate', reason: 'recompile_heals' };
  }
  if (stats.fallback_rate_current_build > THRESHOLDS.recompile_fallback_rate) {
    return { ...base, to: 'candidate', reason: 'recompile_fallbacks' };
  }

  // 04 §8 "candidate → verified": ≥3 successful replays across ≥2 sessions, no unresolved heals
  if (from === 'candidate'
    && stats.successes >= THRESHOLDS.verified_min_successes
    && stats.success_sessions >= THRESHOLDS.verified_min_sessions
    && stats.heals_pending === 0) {
    return { ...base, to: 'verified', reason: 'verified' };
  }
  // `verified → ci_gate` is human-only (04 §8, 07 §7): `eligibleForCiGate` reports it, this never does
  return null;
}

/** Pure: 08 §5 row 3 / 04 §8 — > 50 % failures over a window of at least `recompile_min_runs`. */
export function failureRateExceeded(stats: RecipeStats): boolean {
  const runs = stats.last_runs.length;
  if (runs < THRESHOLDS.recompile_min_runs) return false;
  return stats.last_runs.filter((ok) => !ok).length / runs > THRESHOLDS.recompile_failure_rate;
}

/** Pure: 08 §5 row 1 — success ≥ 95 % across ≥ 3 builds. */
export function eligibleForCiGate(stats: RecipeStats): boolean {
  if (!stats || !Array.isArray(stats.builds)) return false;
  if (stats.builds.length < THRESHOLDS.ci_gate_min_builds) return false;
  let runs = 0;
  let successes = 0;
  for (const b of stats.builds) {
    runs += b.runs;
    successes += b.successes;
  }
  if (runs === 0) return false;
  return successes / runs >= THRESHOLDS.ci_gate_min_success_rate;
}

/** Pure: 04 §8 "any → candidate" predicate. */
export function shouldRecompile(stats: RecipeStats): boolean {
  if (!stats) return false;
  return failureRateExceeded(stats)
    || stats.heals_pending >= THRESHOLDS.recompile_pending_heals
    || stats.fallback_rate_current_build > THRESHOLDS.recompile_fallback_rate;
}

/** the recipe as the session knows it: the cache first (heals/marks land there), then the map */
function currentRecipe(ctx: AppMapContext, id: RecipeId): RecipeFile | undefined {
  return ctx.db.getRecipe(id) ?? ctx.map.recipes.get(id);
}

/**
 * Pure: a step's identity for the 04 §8 coverage rule — its `action` plus the ONE thing it acts
 * on. The data the step carries (`type.text`, `select.match.text`) is deliberately excluded, so
 * a `{param}` slot and the literal it was compiled from are the same step; see the module header.
 */
export function stepIdentity(step: RecipeStep): string {
  switch (step.action) {
    case 'tap': return `tap:${step.element}`;
    case 'type': return `type:${step.element}`;
    // both `select` forms have one identity per element they address (issue #19): a step that
    // recompiles from `list` to `cell` is a DIFFERENT step, and 04 §8's guard must see that.
    case 'select': return `select:${selectTarget(step)}`;
    case 'swipe': return `swipe:${step.direction}:${step.element ?? '-'}`;
    case 'open_link': return `open_link:${step.url}`;
    case 'wait_for': return `wait_for:${step.expect.screen ?? '-'}`;
    case 'dismiss_gate': return `dismiss_gate:${step.gate}`;
  }
}

/**
 * Pure: does `b` still assert everything `a` asserted? A rebuild may strengthen a postcondition,
 * never weaken one — a step that kept its action but lost its `expect.screen` is exactly how a
 * degraded recipe reports PASS while landing somewhere else (issue #13).
 */
function expectCovers(a: Expect | undefined, b: Expect | undefined): boolean {
  if (a === undefined) return true; // the reviewed step asserted nothing; anything covers it
  if (b === undefined) return false; // every assertion was dropped
  if (a.screen !== undefined && b.screen !== a.screen) return false;
  if (a.focused !== undefined && b.focused !== a.focused) return false;
  if (a.text_present !== undefined && b.text_present !== a.text_present) return false;
  for (const id of a.visible ?? []) if (!(b.visible ?? []).includes(id)) return false;
  for (const id of a.not_visible ?? []) if (!(b.not_visible ?? []).includes(id)) return false;
  return true;
}

/**
 * Pure: does `next`'s step list cover `previous`'s? The 04 §8 recompile write guard — the rule
 * is stated in full in the module header. `missing` names reviewed steps the rebuild dropped,
 * `weakened` reviewed steps it kept but stripped of an assertion.
 */
export function recompileCovers(previous: RecipeFile, next: RecipeFile): { ok: boolean; missing: StepId[]; weakened: StepId[] } {
  const missing: StepId[] = [];
  const weakened: StepId[] = [];
  const rebuilt = next?.steps ?? [];
  // greedy two-pointer subsequence match: `cursor` never moves backwards, which is what makes
  // this "in order"; scanning continues past a miss so the report names EVERY dropped step
  let cursor = 0;
  for (const step of previous?.steps ?? []) {
    const want = stepIdentity(step);
    let found = -1;
    for (let k = cursor; k < rebuilt.length; k += 1) {
      if (stepIdentity(rebuilt[k] as RecipeStep) === want) { found = k; break; }
    }
    if (found < 0) { missing.push(step.id); continue; }
    const match = rebuilt[found] as RecipeStep;
    if (!expectCovers(step.expect, match.expect) || (step.intent_critical === true && match.intent_critical !== true)) {
      weakened.push(step.id);
    }
    cursor = found + 1;
  }
  return { ok: missing.length === 0 && weakened.length === 0, missing, weakened };
}

/** Pure: a `Condition` as one log-safe line (`auth=logged_in`, `flag=beta,value=true`); 02 §4.1 key order. */
export function conditionKey(c: Condition): string {
  const order: Array<keyof Condition> = ['auth', 'screen', 'flag', 'value', 'platform_version'];
  return order.filter((k) => c?.[k] !== undefined).map((k) => `${k}=${String(c[k])}`).join(',');
}

/**
 * Pure: split `appmap://invoice_new?fixture=logged_in` into its base and its query pairs.
 * Hand-rolled rather than `new URL`, which normalizes case and percent-encoding and would make
 * two links that differ on disk compare equal.
 */
function splitDeepLink(link: string): { base: string; query: Map<string, string> } {
  const q = link.indexOf('?');
  if (q < 0) return { base: link, query: new Map() };
  const query = new Map<string, string>();
  for (const part of link.slice(q + 1).split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    query.set(eq < 0 ? part : part.slice(0, eq), eq < 0 ? '' : part.slice(eq + 1));
  }
  return { base: link.slice(0, q), query };
}

/**
 * Pure: does deep link `b` still get you where `a` did? Same screen, and every query parameter
 * `a` carried still present with the same value. ADDING one is fine — `compile.optimizeEntry`
 * appends `?fixture=logged_in` when the trajectory shows a logged-in session (04 §3.5), which is
 * a strengthening — but dropping one is not: `?fixture=logged_in` is `preconditions: [{auth:
 * logged_in}]` in URL form, and a replay that enters without it exercises a different app state.
 */
export function deepLinkCovers(a: string, b: string | undefined): boolean {
  if (b === undefined) return false;
  const from = splitDeepLink(a);
  const to = splitDeepLink(b);
  if (from.base !== to.base) return false;
  for (const [k, v] of from.query) if (to.query.get(k) !== v) return false;
  return true;
}

/**
 * Pure: does `next` still say WHEN the recipe applies and HOW you get into it? The second half of
 * the 04 §8 write guard, beside `recompileCovers` — a rebuild that kept every step but lost
 * `preconditions: [{auth: logged_in}]` and the `?fixture=logged_in` on its deep link runs the
 * same taps against a logged-OUT app, which is the same silent erosion by another route (the
 * pilot's own recompile does exactly this when the replay slice starts after the entry).
 *
 * - every reviewed `preconditions` entry must come back (deep-equal, order-free); extra ones are
 *   a narrowing, which is not erosion;
 * - a reviewed `entry.deep_link` must come back and must still cover (see `deepLinkCovers`);
 * - `entry.fallback_path` is checked ONLY when the reviewed recipe had no deep link, i.e. when
 *   navigation is the one way in. Otherwise it is out of scope on purpose: `optimizeEntry`
 *   derives it from whatever leading navigation the slice happened to contain (04 §3.5), so a
 *   shorter one means "this run entered by deep link", not "the route was deleted", and refusing
 *   on it would refuse nearly every healthy recompile for a signal that carries no information.
 */
export function recompileCoversEntry(previous: RecipeFile, next: RecipeFile): { ok: boolean; missing_preconditions: string[]; entry_loss: string[] } {
  const missing_preconditions: string[] = [];
  const entry_loss: string[] = [];
  // `conditionKey` is total over 02 §4.1's five fields, so equal keys are equal conditions
  const rebuilt = (next?.preconditions ?? []).map(conditionKey);
  for (const c of previous?.preconditions ?? []) {
    const key = conditionKey(c);
    if (!rebuilt.includes(key)) missing_preconditions.push(key);
  }
  const before = previous?.entry ?? {};
  const after = next?.entry ?? {};
  if (before.deep_link !== undefined) {
    if (!deepLinkCovers(before.deep_link, after.deep_link)) {
      entry_loss.push(`deep_link ${before.deep_link} → ${after.deep_link ?? '(none)'}`);
    }
  } else {
    // no deep link on the reviewed recipe: the fallback path IS the entry, so it may not shrink
    let cursor = 0;
    for (const screen of before.fallback_path ?? []) {
      const found = (after.fallback_path ?? []).indexOf(screen, cursor);
      if (found < 0) entry_loss.push(`fallback_path dropped ${screen}`);
      else cursor = found + 1;
    }
  }
  return { ok: missing_preconditions.length === 0 && entry_loss.length === 0, missing_preconditions, entry_loss };
}

/** 04 §8: `version` increments on structural change only (steps, params, entry) — heals never bump it. */
function isStructuralChange(a: RecipeFile, b: RecipeFile): boolean {
  return JSON.stringify([a.steps, a.params, a.entry]) !== JSON.stringify([b.steps, b.params, b.entry]);
}

/**
 * After a run finishes (guided or headless): bump counters, emit the `recipe_run` event, then
 * `decideTransition`; apply it in the cache (dirty) and, for recompiles, call compile with the
 * latest successful trajectory producing `version + 1` (04 §8, 04 §9 last criterion).
 */
export function recordRunOutcome(ctx: AppMapContext, run: RunRecord, outcome: { ok: boolean; steps: number; steps_done: number; ms: number }): LifecycleDecision | null {
  if (!run || typeof run.recipe !== 'string') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'recordRunOutcome needs a RunRecord with a recipe id', 'pass the run row from db.getRun(run_id)');
  }
  const heals = Array.isArray(run.heals) ? run.heals.length : 0;
  const fallbacks = typeof run.fallbacks === 'number' ? run.fallbacks : 0;
  ctx.db.bumpCounter('recipe', run.recipe, 'runs');
  ctx.db.bumpCounter('recipe', run.recipe, run.mode === 'headless' ? 'headless_runs' : 'guided_runs');
  if (outcome.ok) ctx.db.bumpCounter('recipe', run.recipe, 'replay_success');
  if (fallbacks > 0) ctx.db.bumpCounter('recipe', run.recipe, 'fallbacks', fallbacks);

  // 08 §2 / architecture §6: a guided run that fell back is a `recipe_run` with ok:false and fallbacks ≥ 1
  ctx.events.append({
    kind: 'recipe_run', session: run.session, recipe: run.recipe, version: run.version, mode: run.mode,
    ok: outcome.ok, steps: outcome.steps, steps_done: outcome.steps_done, heals, fallbacks, ms: outcome.ms,
    build: run.build ?? ctx.build, run_id: run.run_id,
    ...(run.state === 'fallback' ? { fallback_step: run.current_step } : {}),
  });

  const recipe = currentRecipe(ctx, run.recipe);
  if (recipe === undefined) return null;
  const stats = ctx.db.recipeStats(run.recipe, { currentBuild: ctx.build, lastN: THRESHOLDS.recompile_window_runs });
  const decision = decideTransition(recipe, stats);
  if (decision === null) return null;
  let successful: RunRecord | undefined;

  if (decision.reason !== 'verified') {
    // 04 §8: recompile from the latest SUCCESSFUL trajectory, not from this (possibly failed) run
    const latest = ctx.db.listRuns({ recipe: run.recipe, limit: 50 }).find((r) => r.state === 'done');
    if (latest !== undefined) {
      decision.recompile_from = { session: latest.session, seq: latest.start_seq + 1 };
      successful = latest;
    }
  }

  if (recipe.status !== decision.to) {
    ctx.db.putRecipe({ ...recipe, status: decision.to }, { dirty: true, reason: `lifecycle:${decision.reason}` });
  }
  if (decision.reason !== 'verified' && successful !== undefined) {
    decision.recompile = recompileFrom(ctx, recipe, decision, successful);
  }
  ctx.log.info('lifecycle decision', { recipe: decision.recipe, from: decision.from, to: decision.to, reason: decision.reason });
  return decision;
}

/** the empty outcome every `recompileFrom` path starts from */
function noRecompile(over: Partial<RecompileOutcome> = {}): RecompileOutcome {
  return {
    written: false, refusals: [], missing_steps: [], weakened_steps: [],
    missing_preconditions: [], entry_loss: [], warnings: [], diff: '', was_reviewed: false, ...over,
  };
}

/** a recipe diff is ids, `{param}` slots and static copy only (07 §2.3.3), but keep the line bounded */
const REFUSAL_DIFF_MAX_CHARS = 4000;

/**
 * 04 §8 "the compiler produces a new `version` from the latest successful trajectory", behind the
 * issue #13 write guard: the rebuild replaces the reviewed recipe only when the compile raised no
 * incompleteness warning AND its steps cover the reviewed ones AND its `preconditions`/`entry`
 * do too (see the module header for the rule in full).
 *
 * Nothing here ever fails the run that triggered it — not a compile failure, not a refusal. A
 * refusal is not silent either: it is an `error` log line, a 08 §2 `compile` event with
 * `ok:false`, and a `RecompileOutcome` on the returned `LifecycleDecision`.
 */
function recompileFrom(ctx: AppMapContext, recipe: RecipeFile, decision: LifecycleDecision, successful: RunRecord): RecompileOutcome {
  const from = decision.recompile_from;
  if (from === undefined) return noRecompile();
  const wasReviewed = typeof recipe.provenance?.reviewed_by === 'string' && recipe.provenance.reviewed_by !== '';
  const base = (over: Partial<RecompileOutcome> = {}): RecompileOutcome => noRecompile({ was_reviewed: wasReviewed, ...over });

  // 03 §3 `APP_MAP_RECOMPILE=off`: replay is read-only against the map. Checked BEFORE compiling,
  // so "read-only" means nothing is even computed from the trajectory. The demotion already
  // happened in `recordRunOutcome` — that is the 08 §5 signal, not a write to the recipe body.
  if (ctx.config.recompile === 'off') {
    ctx.log.info('recompile skipped: APP_MAP_RECOMPILE=off', { recipe: recipe.id, trigger: decision.reason });
    return base({ refusals: ['disabled'] });
  }

  try {
    const session = ctx.db.getSession(from.session);
    // the successful run already carried the concrete values for every param (04 §3.4): they are
    // the only reliable `values` here, since the stored task text is PII-redacted (decision 13)
    const values: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(successful.params ?? {})) {
      if (typeof v === 'string' || typeof v === 'number') values[k] = v;
    }
    const result = compileRecipe(ctx, {
      session: from.session,
      task: session?.task ?? recipe.description,
      recipe_id: recipe.id,
      params: recipe.params,
      values,
      revision_of: recipe.version,
      from_seq: from.seq,
    });
    if (!result.ok) {
      ctx.log.warn('recompile produced no draft', { recipe: recipe.id, reason: result.reason });
      return base({ refusals: ['compile_failed'], warnings: [`${result.reason}: ${result.message}`] });
    }
    // a revision of an already-reviewed recipe keeps the reviewed prose (04 §8: only the
    // structure is recompiled) and lands dirty so the diff shows up in the next PR
    const next: RecipeFile = {
      ...result.recipe,
      description: recipe.description,
      matches: recipe.matches,
      verify: recipe.verify,
      status: 'candidate',
      provenance: {
        ...result.recipe.provenance,
        // issue #13 criterion 3: the reviewer's signature survives a revision. An accepted
        // rebuild is a warning-free superset, so it never removes what was approved; dropping
        // `reviewed_by` would make a machine-written file read as merely unreviewed and would
        // destroy the 07 §7 record of who signed it.
        ...(wasReviewed ? { reviewed_by: recipe.provenance.reviewed_by as string } : {}),
      },
    };
    // 04 §8: `version` increments on STRUCTURAL change only. A recompile that reproduces the
    // same steps/params/entry (the common case — the failures were environmental) is a status
    // change, not a new revision, so it must not bump the version.
    if (!isStructuralChange(recipe, next)) {
      next.version = recipe.version;
      delete next.provenance.revision_of;
    }

    // ---- the issue #13 write guard ------------------------------------------------------
    // Every gate is evaluated (not short-circuited) so one report names every reason.
    const refusals: RecompileRefusal[] = [];
    // 1. a warning that says the rebuild is INCOMPLETE — a dropped driver call, a failed call,
    //    placeholder prose — means it is not a faithful record of the run and must not overwrite
    //    a reviewed file unattended. The NORMALISATION notes are not those: see
    //    `compile.isNormalisationWarning` and the module header.
    const blocking = result.warnings.filter((w) => !isNormalisationWarning(w));
    if (blocking.length > 0) refusals.push('warnings');
    // 2. the rebuilt steps must cover the reviewed ones …
    const coverage = recompileCovers(recipe, next);
    if (coverage.missing.length > 0) refusals.push('missing_steps');
    if (coverage.weakened.length > 0) refusals.push('weakened_steps');
    // 3. … and so must the preconditions and entry that say when it applies and how to get in
    const reach = recompileCoversEntry(recipe, next);
    if (reach.missing_preconditions.length > 0) refusals.push('missing_preconditions');
    if (reach.entry_loss.length > 0) refusals.push('weakened_entry');

    if (refusals.length > 0) {
      const outcome = base({
        refusals,
        missing_steps: coverage.missing,
        weakened_steps: coverage.weakened,
        missing_preconditions: reach.missing_preconditions,
        entry_loss: reach.entry_loss,
        warnings: result.warnings,
        diff: unifiedDiff(canonicalYaml('recipe', recipe), canonicalYaml('recipe', next), `${ctx.map.platform}/recipes/${recipe.id}.yaml`),
      });
      reportRecompileRefusal(ctx, recipe, decision, from, next, outcome);
      return outcome;
    }

    // issue #13 criterion 4, the in-file half: the YAML itself says these steps came from a
    // machine. `compiled_from` moving to the replay session already implies it, but only to a
    // reader who knows what that means; this is the line a reviewer can act on, and it sits
    // directly above the carried-over `reviewed_by` (yaml/canonical KEY_ORDER) so the diff reads
    // "machine-built steps, historical signature". A human clears it by signing again.
    next.provenance.machine_recompile = true;
    // the body write carries its OWN dirty reason, distinct from the `lifecycle:<reason>` of the
    // status-only transition, so `export` can label it a machine recompile (issue #13 criterion 4)
    ctx.db.putRecipe(next, { dirty: true, reason: `${RECOMPILE_DIRTY_PREFIX}${decision.reason}` });
    ctx.log.info('recipe recompiled', {
      recipe: recipe.id, version: next.version, from_session: from.session, trigger: decision.reason,
      steps: next.steps.length, reviewed_by: next.provenance.reviewed_by,
      // the collapse notes did not block, but they are the reason a human might still want to look
      ...(result.warnings.length > 0 ? { notes: result.warnings } : {}),
    });
    return base({ written: true, warnings: result.warnings });
  } catch (e) {
    ctx.log.warn('recompile failed', { recipe: recipe.id, error: (e as Error).message });
    return base({ refusals: ['compile_failed'], warnings: [(e as Error).message] });
  }
}

/**
 * Report a refused recompile. Mirrors `heal.rejectHeal` (04 §7.2), the precedent for "a machine
 * that cannot prove it is safe hands the decision to a human instead of guessing": the refusal
 * is logged, recorded as an event, and travels back to the caller with the evidence.
 *
 * It logs at `error` — a machine trying to shrink a reviewed recipe is the loudest thing this
 * module has to say — and appends the existing 08 §2 `compile` kind with `ok:false` and a
 * `recompile_refused_*` reason, so no new event kind is invented (`CompileEvent` already carries
 * `ok`/`reason`; `compile.fail` uses the same shape). Note this leaves TWO `compile` lines for
 * one rebuild: the `ok:true` one `compileRecipe` appends (the compile itself did succeed)
 * followed by this `ok:false` one (the write did not happen).
 *
 * The unified diff goes in the log MESSAGE, not a field: `log.sanitizeFields` drops keys named
 * `text`/`label`/`value`, so half a recipe diff would silently vanish from a structured field.
 * A recipe diff is ids, `{param}` slots and static copy only (07 §2.3.3) — the same content
 * `export` already prints to stderr for a 03 §4 conflict — but it is capped so the line stays
 * bounded.
 */
function reportRecompileRefusal(
  ctx: AppMapContext,
  recipe: RecipeFile,
  decision: LifecycleDecision,
  from: { session: string; seq: number },
  next: RecipeFile,
  outcome: RecompileOutcome,
): void {
  ctx.events.append({
    kind: 'compile', session: from.session, recipe: recipe.id, version: next.version,
    from_session: from.session, steps: next.steps.length,
    params: (recipe.params ?? []).map((p) => p.name),
    ok: false, reason: `recompile_refused_${outcome.refusals.join('+')}`,
  });
  ctx.log.error('recompile refused: the rebuilt recipe does not cover the reviewed one', {
    recipe: recipe.id,
    trigger: decision.reason,
    refusals: outcome.refusals,
    missing_steps: outcome.missing_steps,
    weakened_steps: outcome.weakened_steps,
    missing_preconditions: outcome.missing_preconditions,
    entry_loss: outcome.entry_loss,
    warnings: outcome.warnings,
    reviewed_by: outcome.was_reviewed ? recipe.provenance.reviewed_by : undefined,
    kept_version: recipe.version,
    rejected_version: next.version,
    from_session: from.session,
    hint: 'recompile by hand with compile_recipe + mark, or fix the trajectory and replay (04 §8)',
  });
  if (outcome.diff !== '') {
    ctx.log.warn(`recompile refused — rejected draft for ${recipe.id}:\n${outcome.diff.slice(0, REFUSAL_DIFF_MAX_CHARS)}`);
  }
}

/** Parse + schema-validate + cross-reference a draft handed to `mark` (04 §3.8, 07 §4). */
function checkedDraft(ctx: AppMapContext, draft: RecipeFile | string, recipeId: RecipeId): RecipeFile {
  // A YAML draft is parsed with its kind and keeps what the author literally typed for every
  // scalar YAML resolved to a number or boolean, so `description: 1.0` fails with the quoting
  // hint here too and not only on the load path (issue #20). A draft handed over as an object
  // arrived through JSON and never had a YAML spelling, so `yaml` stays undefined and the issue
  // keeps Ajv's plain wording — telling a JSON caller to "quote it in YAML" is advice for a file
  // they did not write.
  const yaml: ParsedYaml<RecipeFile> | undefined = typeof draft === 'string' ? parseYamlDoc<RecipeFile>(draft, `${recipeId}.yaml`, 'recipe') : undefined;
  const doc = yaml !== undefined ? yaml.doc : draft;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark: `recipe` is not a recipe document', 'pass the compiled draft (RecipeFile or its canonical YAML text)');
  }
  if (doc.id !== recipeId) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: draft id ${String(doc.id)} does not match recipe_id ${recipeId}`, 'the draft must carry the same id');
  }
  const schemaIssues = validateAgainstSchema(schemaDir(ctx.config), 'recipe', doc);
  if (schemaIssues.length > 0) {
    const detail = schemaIssues.map((i) => formatSchemaIssue(i, yaml?.doc, yaml?.scalarSources)).join('; ');
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `mark: draft fails recipe.schema.json: ${detail}`, 'fix the draft and call mark again (04 §3.8)');
  }
  // rules 2–6/8 against the loaded map (07 §4: a draft is user-authored content)
  const screens = new Map<string, ScreenFile>();
  for (const [id, s] of ctx.map.screens) screens.set(`${ctx.map.platform}/screens/${id}.yaml`, s);
  for (const [id, g] of ctx.map.gates) screens.set(`${ctx.map.platform}/screens/${id}.yaml`, g);
  const issues = crossReferenceIssues({
    platform: ctx.map.platform,
    ids: ctx.map.ids,
    screens,
    recipes: new Map([[`${ctx.map.platform}/recipes/${recipeId}.yaml`, doc]]),
    build: ctx.map.manifest.build.build_number,
  }).filter((i) => i.severity === 'error' && i.file.endsWith(`/recipes/${recipeId}.yaml`));
  if (issues.length > 0) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `mark: draft fails 02 §10 cross-reference rules: ${issues.map((i) => `rule ${i.rule} ${i.message}`).join('; ')}`, 'every referenced id must exist in ids.yaml and every screen must exist');
  }
  return doc;
}

/**
 * `mark {recipe_id, status, recipe?, reviewer?}` (03 §8, `MarkRecipeInput`): human-in-the-
 * loop promote/demote. `candidate` on a recipe that is not yet in the cache REQUIRES
 * `input.recipe` (the reviewed draft as `RecipeFile` or YAML text; parsed + schema-validated +
 * cross-referenced before write) — the only way a compiled draft becomes real (04 §3.8); the
 * server keeps no per-session draft. `ci_gate` requires `input.reviewer` (07 §7; stored in
 * `provenance.reviewed_by`) and `eligibleForCiGate` unless `input.force`. Marks the recipe
 * dirty; export writes it.
 */
export function markRecipe(ctx: AppMapContext, input: MarkRecipeInput): MarkRecipeResult {
  if (!input || typeof input.recipe_id !== 'string' || input.recipe_id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark needs a recipe_id', 'e.g. {recipe_id: "create_invoice", status: "candidate"}');
  }
  if (!(RECIPE_STATUSES as readonly string[]).includes(input.status)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: status ${String(input.status)} is not one of ${RECIPE_STATUSES.join('|')}`, 'see 02 §6');
  }
  const existing = currentRecipe(ctx, input.recipe_id);
  const from: RecipeStatus | null = existing?.status ?? null;

  // 04 §3.8: nothing is written without this call, and a draft the server has never seen must
  // travel with it (architecture §7 decision 35 — the server keeps no per-session draft)
  if (existing === undefined && input.recipe === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: ${input.recipe_id} is unknown and no draft was supplied`, 'pass the reviewed draft from compile_recipe as `recipe` (04 §3.8)');
  }

  let next: RecipeFile = input.recipe !== undefined
    ? checkedDraft(ctx, input.recipe, input.recipe_id)
    : { ...(existing as RecipeFile) };

  // 04 §8: a structural change over an existing recipe is a new version; heals never bump it
  if (existing !== undefined && input.recipe !== undefined && isStructuralChange(existing, next) && next.version <= existing.version) {
    next = { ...next, version: existing.version + 1 };
  }

  if (input.status === 'ci_gate') {
    // 07 §7: "a reviewer who is not the author". What this process can check is the two identities
    // it actually holds — `provenance.compiled_by` and any previous `reviewed_by`. The real control
    // is branch protection (a code-owner approval on the PR), because a local CLI cannot know who
    // is typing; this rejects the obvious self-sign so the recorded `reviewed_by` means something.
    if (typeof input.reviewer !== 'string' || input.reviewer.trim() === '') {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark: promoting to ci_gate requires `reviewer`', 'pass the reviewing human (07 §7); it is recorded in provenance.reviewed_by');
    }
    const reviewer = input.reviewer.trim();
    const author = typeof next.provenance?.compiled_by === 'string' ? next.provenance.compiled_by : undefined;
    if (author !== undefined && author.toLowerCase() === reviewer.toLowerCase()) {
      throw new AppMapError(
        ERROR_CODES.BAD_INPUT,
        `mark: ${reviewer} compiled ${input.recipe_id} and cannot also review it`,
        'promotion to ci_gate needs a reviewer who is not the author (07 §7)',
      );
    }
    if (input.force === true) {
      // the bypass skips the 08 §5 eligibility gate, so leave an audit line naming who took it
      ctx.log.warn('mark_recipe: ci_gate eligibility bypassed with --force', { recipe: input.recipe_id, reviewer });
    }
    if (input.force !== true) {
      const stats = ctx.db.recipeStats(input.recipe_id, { currentBuild: ctx.build, lastN: THRESHOLDS.recompile_window_runs });
      if (!eligibleForCiGate(stats)) {
        throw new AppMapError(
          ERROR_CODES.BAD_INPUT,
          `mark: ${input.recipe_id} is not eligible for ci_gate yet`,
          `08 §5 row 1: ≥${THRESHOLDS.ci_gate_min_success_rate * 100}% replay success across ≥${THRESHOLDS.ci_gate_min_builds} builds (seen ${stats.successes}/${stats.runs} over ${stats.builds.length} builds)`,
        );
      }
    }
    // the reviewer has now read these steps, so the issue #13 "a machine wrote this" marker is
    // spent: it exists to tell a reader that `reviewed_by` below it is historical, and here it
    // stops being historical. `delete` rather than `false` so the key leaves the YAML entirely.
    next = { ...next, provenance: { ...next.provenance, reviewed_by: reviewer } };
    delete next.provenance.machine_recompile;
  }

  next = { ...next, status: input.status };
  // the dirty reason (and the log event) stay `mark_recipe:` even though the TOOL is now `mark`:
  // they name the store-level operation, `db.test.ts`/`export.test.ts` pin them, and the screen
  // half needs a distinguishable `mark_screen:` beside it (03 §4)
  ctx.db.putRecipe(next, { dirty: true, reason: `mark_recipe:${input.status}` });
  ctx.log.info('mark_recipe', { recipe: next.id, from, to: next.status, version: next.version });
  return { recipe_id: next.id, from, to: next.status, written: true };
}

/**
 * `mark {screen_id, status, reviewer?, force?}` (03 §8, 02 §8, `MarkScreenInput`, issue #16): the
 * human half of the SCREEN lifecycle, and the only way back out of `verified`.
 *
 * A screen promotes ITSELF (02 §8 / 08 §5 row 5: marker + every `required_id` + a matching
 * structural hash, on ONE observation — `observe.ingestObservation`'s lazy re-verify). A screen
 * learned from a slightly wrong tree satisfies all three against that same wrong tree, so bad data
 * certifies itself on the very next observation, and the map used to have no way back: `mark`
 * spoke only recipes, a heal is rejected exactly when the stored locators are `ambiguous`
 * (04 §7.2), and the "reviewed edit" the old `name_screen` hint promised means hand-writing
 * `structural_hash` and per-element `fingerprint` blocks. This is that way back.
 *
 *  - `candidate` withdraws the verification, so `last_verified_build` is DELETED — leaving it
 *    would have `get_screen` reporting the decayed confidence (02 §8) of a verification a human
 *    has just taken back, and `name_screen` would re-learn the screen under a build stamp that
 *    certified the data it replaced;
 *  - `verified` is REFUSED without `force`: it is earned by observation, and a hand-signed
 *    `verified` is the self-certification this command exists to undo. Forced, it needs a
 *    `reviewer` (07 §7) and stamps `last_verified_build = ctx.build`;
 *  - `retired` cascades exactly like a router-export removal (02 §8): `retireRecipesForScreen`.
 *    It deliberately does NOT clear `last_verified_build` — `import-router --purge-retired` reads
 *    that field to implement "retired for one release, then deleted", and `isNewerBuild(b,
 *    undefined)` is `true`, so clearing it would delete the file on the very next CI import;
 *  - `reviewer` lands in `meta.reviewed_by` and CLEARS `meta.relearned_from`: the human has now
 *    signed the current data, so the forced-re-learn marker is spent — the issue #13 precedent,
 *    where `mark(ci_gate, reviewer)` deletes `provenance.machine_recompile`.
 *
 * Unlike `markVerified`, this writes (and dirties) even when the status is unchanged: the command
 * is an explicit human act and the point of it is to record the reviewer. Running it twice
 * re-exports a byte-identical file, which `export` skips as unchanged.
 *
 * Dirty reason `mark_screen:<status>` — the mirror of `mark_recipe:<status>`, and distinct from
 * the `verify` / `heal` / `name_screen` reasons so a PR reader can see that a human did this
 * (03 §4). NOTE (02 §8, issue #16 item 3): a demote is not a lock — the next clean observation
 * re-promotes the screen. Demote, then re-learn. Making it a lock (promote only on a second
 * observation, or on observations from distinct sessions/builds) belongs inside `markVerified`,
 * not at a caller: three call sites promote screens — `observe.ingestObservation` (lazy
 * re-verify), `guided.reportStep` and `headless.runHeadless` — so gating one leaves the other two.
 */
export function markScreen(ctx: AppMapContext, input: MarkScreenInput): MarkScreenResult {
  if (!input || typeof input.screen_id !== 'string' || input.screen_id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark needs a screen_id', 'e.g. {screen_id: "person_detail", status: "candidate"}');
  }
  if (!(SCREEN_STATUSES as readonly string[]).includes(input.status)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark: status ${String(input.status)} is not one of ${SCREEN_STATUSES.join('|')}`, 'see 02 §8');
  }
  // the cache first, then the loaded map — the same load order `markVerified` uses, so a screen
  // this session has already touched is marked in its current shape; gates are markable too
  const existing = ctx.db.getScreen(input.screen_id) ?? ctx.map.screens.get(input.screen_id) ?? ctx.map.gates.get(input.screen_id);
  if (existing === undefined) {
    throw new AppMapError(ERROR_CODES.NOT_FOUND, `mark: ${input.screen_id} is not a screen this map knows`, 'call summary for the screens it has, or name_screen to learn a new one (03 §8)');
  }
  const reviewer = typeof input.reviewer === 'string' && input.reviewer.trim() !== '' ? input.reviewer.trim() : undefined;
  if (input.status === 'verified' && input.force !== true) {
    throw new AppMapError(
      ERROR_CODES.BAD_INPUT,
      `mark: ${input.screen_id} cannot be marked verified by hand`,
      'a screen verifies itself on a clean observation (02 §8, 08 §5 row 5); pass force with a reviewer to sign it anyway',
    );
  }
  if (input.status === 'verified' && reviewer === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark: forcing verified requires `reviewer`', 'pass the reviewing human (07 §7); it is recorded in meta.reviewed_by');
  }

  const from: ScreenStatus = existing.meta.status;
  const next: ScreenFile = structuredClone(existing);
  next.meta = { ...next.meta, status: input.status };
  if (input.status === 'candidate') delete next.meta.last_verified_build;
  if (input.status === 'verified') next.meta.last_verified_build = ctx.build;
  if (reviewer !== undefined) {
    next.meta.reviewed_by = reviewer;
    delete next.meta.relearned_from;
  }

  ctx.db.putScreen(next, { dirty: true, reason: `mark_screen:${input.status}` });
  const retired_recipes = input.status === 'retired' ? retireRecipesForScreen(ctx, next.id) : [];
  ctx.log.info('mark_screen', { screen: next.id, from, to: input.status, ...(reviewer !== undefined ? { reviewer } : {}) });
  return { screen_id: next.id, from, to: input.status, written: true, retired_recipes };
}

/** What `markVerified` promotes; every list is optional. */
export interface VerifiedEntities {
  screens?: ScreenId[];
  /** `(screen, element)` pairs resolved by `a11y_id` (or an accepted heal's postcondition) */
  elements?: Array<{ screen: ScreenId; element: ElementId }>;
  /** edges whose postcondition was observed */
  edges?: Array<{ screen: ScreenId; action: EdgeAction; to: ScreenId }>;
  recipe?: RecipeId;
}

/** same action shape (02 §4.2): type + the element/url/gate/direction it names */
function sameAction(a: EdgeAction, b: EdgeAction): boolean {
  if (a.type !== b.type) return false;
  if (edgeElement(a) !== edgeElement(b)) return false;
  if (a.type === 'open_link' && b.type === 'open_link') return a.url === b.url;
  if (a.type === 'dismiss_gate' && b.type === 'dismiss_gate') return a.gate === b.gate;
  if (a.type === 'swipe' && b.type === 'swipe') return a.direction === b.direction;
  return true;
}

/**
 * 02 §8 / 08 §5 row 5: record a successful verification. For every named screen (`meta`),
 * element, edge and recipe: `last_verified_build = build`, `status: candidate → verified`
 * (elements in `healed_pending_review` stay — only a human review clears that, 04 §7.2), rows
 * marked dirty (reason `verify`) so `export` writes the new build number. Called from
 * `guided.reportStep` (each ok step / done), `headless.runHeadless` (success) and
 * `observe.ingestObservation` (marker + all required_ids + hash match = lazy re-verify).
 * Returns what actually changed (unchanged rows are not dirtied, so exports stay quiet).
 *
 * Two things it refuses to verify, both because the map has no evidence for the claim and both
 * because making the claim silently withdraws 02 §10 rule 2's carve-out and stops the map loading
 * (issue #12 — the guard lives HERE so all three callers get it from one change):
 *   - a screen whose `elements[]` is empty. 02 §8 verification is one CLEAN observation of the
 *     screen's required ids; a router seed (01 R6) has by definition never had one, and passing
 *     through it on a replay is not one either. `name_screen` — which is what fills `elements[]` —
 *     is the transition out of `candidate` for such a screen. Emptiness ALONE is the test, and the
 *     narrower "…and it carries an undeclared edge element" only defers the deadlock: a seed whose
 *     edges name no element yet (`open_link`, `dismiss_gate`, a bare `swipe`) has nothing for rule 2
 *     to relax today, but `import-router` appends the app's new edges on every later build, and a
 *     screen promoted in the meantime is then unrecoverable — rule 2 errors, `loadMap` throws
 *     `invalid_map`, and `ctx.loadError` short-circuits every tool but `export`, so nobody can even
 *     `mark` it back to `candidate` (router-import.test.ts pins exactly this sequence).
 *   - an edge whose `action.element` the screen does not declare. A `verified` edge asserts the tap
 *     happened on THIS screen; while rule 2 is only WARNING that the element is unlearned there,
 *     promoting the edge converts that warning into a hard error on the very next load.
 *
 * Accepted cost of the first guard: a screen that genuinely has no REGISTERED non-marker id —
 * `nameScreen` builds `elements[]` from `idsPresent(snapshot)` minus markers, so a splash or
 * interstitial gets `elements: []` from a real capture — stays `candidate` for ever and never
 * carries `meta.last_verified_build`. `identify`/`get_screen` then skip the 02 §8 decay for it
 * (both already treat a missing build as "no decay") and `report`'s deep-link coverage does not
 * count it. The second guard skips `edge.last_verified_build` the same way, which nothing reads.
 */
export function markVerified(ctx: AppMapContext, entities: VerifiedEntities, build: BuildNumber = ctx.build): { screens: ScreenId[]; elements: ElementId[]; edges: number; recipe?: RecipeId } {
  const out: { screens: ScreenId[]; elements: ElementId[]; edges: number; recipe?: RecipeId } = { screens: [], elements: [], edges: 0 };
  if (!entities) return out;
  // one copy per screen so a screen named by `screens`, `elements` and `edges` is written once
  const touched = new Map<ScreenId, { screen: ScreenFile; changed: boolean }>();
  const load = (id: ScreenId): { screen: ScreenFile; changed: boolean } | undefined => {
    const cached = touched.get(id);
    if (cached !== undefined) return cached;
    const found = ctx.db.getScreen(id) ?? ctx.map.screens.get(id) ?? ctx.map.gates.get(id);
    if (found === undefined) return undefined;
    const entry = { screen: structuredClone(found), changed: false };
    touched.set(id, entry);
    return entry;
  };

  for (const id of entities.screens ?? []) {
    const entry = load(id);
    if (entry === undefined) continue;
    // a screen with nothing learned on it was never verified — not its status, not its build
    if (entry.screen.elements.length === 0) continue;
    const meta = entry.screen.meta;
    // a retired screen is never revived by a replay (02 §8)
    if (meta.status === 'candidate') { meta.status = 'verified'; entry.changed = true; out.screens.push(id); }
    if (meta.status !== 'retired' && meta.last_verified_build !== build) {
      meta.last_verified_build = build;
      entry.changed = true;
      if (!out.screens.includes(id)) out.screens.push(id);
    }
  }

  for (const { screen, element } of entities.elements ?? []) {
    const entry = load(screen);
    const def: ElementDef | undefined = entry?.screen.elements.find((e) => e.id === element);
    if (entry === undefined || def === undefined) continue;
    // 04 §7.2: `healed_pending_review` is cleared by a human review only
    if (def.status === 'healed_pending_review') continue;
    let changed = false;
    if (def.status === 'candidate') { def.status = 'verified'; changed = true; }
    if (def.last_verified_build !== build) { def.last_verified_build = build; changed = true; }
    if (changed) { entry.changed = true; out.elements.push(element); }
  }

  for (const { screen, action, to } of entities.edges ?? []) {
    const entry = load(screen);
    const edge = entry?.screen.edges.find((e) => e.to === to && sameAction(e.action, action));
    if (entry === undefined || edge === undefined) continue;
    // an edge whose element this screen does not declare is one rule 2 is still only warning about
    const edgeEl = edgeElement(edge.action);
    if (edgeEl !== undefined && !entry.screen.elements.some((e) => e.id === edgeEl)) continue;
    let changed = false;
    if (edge.status === 'candidate') { edge.status = 'verified'; changed = true; }
    if (edge.status !== 'retired' && edge.last_verified_build !== build) { edge.last_verified_build = build; changed = true; }
    if (changed) { entry.changed = true; out.edges += 1; }
  }

  for (const { screen, changed } of touched.values()) {
    if (changed) ctx.db.putScreen(screen, { dirty: true, reason: 'verify' });
  }

  if (entities.recipe !== undefined) {
    const recipe = currentRecipe(ctx, entities.recipe);
    // 04 §8 owns the recipe STATUS transitions (≥3 replays across ≥2 sessions); a single
    // successful replay only stamps the build (02 §8) — see decideTransition/recordRunOutcome
    if (recipe !== undefined && recipe.status !== 'retired' && recipe.last_verified_build !== build) {
      ctx.db.putRecipe({ ...recipe, last_verified_build: build }, { dirty: true, reason: 'verify' });
      out.recipe = recipe.id;
    }
  }
  return out;
}

/** Pure: screens a recipe depends on (entry, fallback_path, expect.screen, verify.screen, element declarations). */
export function screensReferenced(recipe: RecipeFile): ScreenId[] {
  const out = new Set<ScreenId>();
  if (!recipe || typeof recipe !== 'object') return [];
  const addExpect = (e: Expect | undefined): void => {
    if (e?.screen !== undefined) out.add(e.screen);
  };
  const entryLink = recipe.entry?.deep_link;
  if (typeof entryLink === 'string') {
    const id = screenIdOfDeepLink(entryLink);
    if (id !== undefined) out.add(id);
  }
  for (const s of recipe.entry?.fallback_path ?? []) out.add(s);
  for (const c of recipe.preconditions ?? []) if (c.screen !== undefined) out.add(c.screen);
  for (const step of recipe.steps ?? []) {
    addExpect(step.expect);
    if (step.action === 'open_link') {
      const id = screenIdOfDeepLink(step.url);
      if (id !== undefined) out.add(id);
    }
  }
  addExpect(recipe.verify);
  return [...out].sort();
}

/** 02 §8 / 04 §8: retire every recipe whose steps, entry or verify reference `screenId`. */
export function retireRecipesForScreen(ctx: AppMapContext, screenId: ScreenId): RecipeId[] {
  if (typeof screenId !== 'string' || screenId === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'retireRecipesForScreen needs a screen id', 'e.g. retireRecipesForScreen(ctx, "client_picker")');
  }
  const retired: RecipeId[] = [];
  const known = new Map<RecipeId, RecipeFile>();
  for (const r of ctx.map.recipes.values()) known.set(r.id, r);
  for (const r of ctx.db.listRecipes()) known.set(r.id, r);
  for (const recipe of [...known.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (recipe.status === 'retired') continue;
    // the pure half (links, fallback_path, expect/verify screens) plus the screens on which the
    // steps' elements are declared — the map is the only source for the latter
    let referenced = screensReferenced(recipe).includes(screenId);
    if (!referenced) {
      for (const step of recipe.steps ?? []) {
        const el = stepElement(step);
        if (el === undefined) continue;
        if ((ctx.map.elements.get(el) ?? []).some((ref) => ref.screen === screenId)) { referenced = true; break; }
      }
    }
    if (!referenced) continue;
    ctx.db.putRecipe({ ...recipe, status: 'retired' }, { dirty: true, reason: 'retired_screen' });
    ctx.log.info('recipe retired', { recipe: recipe.id, screen: screenId, ts: now() });
    retired.push(recipe.id);
  }
  return retired;
}
