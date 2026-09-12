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
import type { BuildNumber, EdgeAction, ElementDef, ElementId, Expect, MarkRecipeInput, MarkRecipeResult, RecipeFile, RecipeId, RecipeStatus, RunRecord, ScreenFile, ScreenId } from '../types.ts';
import { RECIPE_STATUSES, edgeElement, now, screenIdOfDeepLink, stepElement } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { schemaDir } from '../paths.ts';
import { crossReferenceIssues } from '../validate.ts';
import { parseYamlText } from '../yaml/canonical.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { compileRecipe } from './compile.ts';

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
  /** unknown-screen rate over a week that schedules exploration (08 §5 row 6) … */
  alert_unknown_rate: 0.1,
  /** … measured over this trailing window (`ReportMetrics.unknown_screen_rate_7d`) */
  alert_unknown_window_days: 7,
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
  if (!recipe || typeof recipe.id !== 'string' || !stats) return null;
  const from = recipe.status;
  // a retired recipe references a retired screen (02 §8): it is never revived automatically
  if (from === 'retired') return null;
  const base = { recipe: recipe.id, from } as const;

  // 04 §8 "any → candidate (recompile)" — checked before promotion so a failing recipe is
  // never promoted; reasons are tried in the order 04 §8 / 08 §5 list them
  const failures = stats.last_runs.filter((ok) => !ok).length;
  if (stats.last_runs.length > 0 && failures / stats.last_runs.length > THRESHOLDS.recompile_failure_rate) {
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
  const failures = stats.last_runs.filter((ok) => !ok).length;
  return (stats.last_runs.length > 0 && failures / stats.last_runs.length > THRESHOLDS.recompile_failure_rate)
    || stats.heals_pending >= THRESHOLDS.recompile_pending_heals
    || stats.fallback_rate_current_build > THRESHOLDS.recompile_fallback_rate;
}

/** the recipe as the session knows it: the cache first (heals/marks land there), then the map */
function currentRecipe(ctx: AppMapContext, id: RecipeId): RecipeFile | undefined {
  return ctx.db.getRecipe(id) ?? ctx.map.recipes.get(id);
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
    recompileFrom(ctx, recipe, decision, successful);
  }
  ctx.log.info('lifecycle decision', { recipe: decision.recipe, from: decision.from, to: decision.to, reason: decision.reason });
  return decision;
}

/**
 * 04 §8 "the compiler produces a new `version` from the latest successful trajectory". A compile
 * failure never fails the run that triggered it — it is logged and the recipe simply stays
 * `candidate` for a human to recompile.
 */
function recompileFrom(ctx: AppMapContext, recipe: RecipeFile, decision: LifecycleDecision, successful: RunRecord): void {
  const from = decision.recompile_from;
  if (from === undefined) return;
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
      return;
    }
    // a revision of an already-reviewed recipe keeps the reviewed prose (04 §8: only the
    // structure is recompiled) and lands dirty so the diff shows up in the next PR
    const next: RecipeFile = {
      ...result.recipe,
      description: recipe.description,
      matches: recipe.matches,
      verify: recipe.verify,
      status: 'candidate',
    };
    ctx.db.putRecipe(next, { dirty: true, reason: `lifecycle:${decision.reason}` });
    ctx.log.info('recipe recompiled', { recipe: recipe.id, version: next.version, from_session: from.session });
  } catch (e) {
    ctx.log.warn('recompile failed', { recipe: recipe.id, error: (e as Error).message });
  }
}

/** Parse + schema-validate + cross-reference a draft handed to `mark_recipe` (04 §3.8, 07 §4). */
function checkedDraft(ctx: AppMapContext, draft: RecipeFile | string, recipeId: RecipeId): RecipeFile {
  const doc = typeof draft === 'string' ? parseYamlText<RecipeFile>(draft, `${recipeId}.yaml`) : draft;
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark_recipe: `recipe` is not a recipe document', 'pass the compiled draft (RecipeFile or its canonical YAML text)');
  }
  if (doc.id !== recipeId) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark_recipe: draft id ${String(doc.id)} does not match recipe_id ${recipeId}`, 'the draft must carry the same id');
  }
  const schemaIssues = validateAgainstSchema(schemaDir(ctx.config), 'recipe', doc);
  if (schemaIssues.length > 0) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `mark_recipe: draft fails recipe.schema.json: ${schemaIssues.map((i) => `${i.path} ${i.message}`).join('; ')}`, 'fix the draft and call mark_recipe again (04 §3.8)');
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
  }).filter((i) => i.severity === 'error' && i.file.endsWith(`/recipes/${recipeId}.yaml`));
  if (issues.length > 0) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `mark_recipe: draft fails 02 §10 cross-reference rules: ${issues.map((i) => `rule ${i.rule} ${i.message}`).join('; ')}`, 'every referenced id must exist in ids.yaml and every screen must exist');
  }
  return doc;
}

/**
 * `mark_recipe {recipe_id, status, recipe?, reviewer?}` (03 §8, `MarkRecipeInput`): human-in-the-
 * loop promote/demote. `candidate` on a recipe that is not yet in the cache REQUIRES
 * `input.recipe` (the reviewed draft as `RecipeFile` or YAML text; parsed + schema-validated +
 * cross-referenced before write) — the only way a compiled draft becomes real (04 §3.8); the
 * server keeps no per-session draft. `ci_gate` requires `input.reviewer` (07 §7; stored in
 * `provenance.reviewed_by`) and `eligibleForCiGate` unless `input.force`. Marks the recipe
 * dirty; export writes it.
 */
export function markRecipe(ctx: AppMapContext, input: MarkRecipeInput): MarkRecipeResult {
  if (!input || typeof input.recipe_id !== 'string' || input.recipe_id === '') {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark_recipe needs a recipe_id', 'e.g. {recipe_id: "create_invoice", status: "candidate"}');
  }
  if (!(RECIPE_STATUSES as readonly string[]).includes(input.status)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark_recipe: status ${String(input.status)} is not one of ${RECIPE_STATUSES.join('|')}`, 'see 02 §6');
  }
  const existing = currentRecipe(ctx, input.recipe_id);
  const from: RecipeStatus | null = existing?.status ?? null;

  // 04 §3.8: nothing is written without this call, and a draft the server has never seen must
  // travel with it (architecture §7 decision 35 — the server keeps no per-session draft)
  if (existing === undefined && input.recipe === undefined) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `mark_recipe: ${input.recipe_id} is unknown and no draft was supplied`, 'pass the reviewed draft from compile_recipe as `recipe` (04 §3.8)');
  }

  let next: RecipeFile = input.recipe !== undefined
    ? checkedDraft(ctx, input.recipe, input.recipe_id)
    : { ...(existing as RecipeFile) };

  // 04 §8: a structural change over an existing recipe is a new version; heals never bump it
  if (existing !== undefined && input.recipe !== undefined && isStructuralChange(existing, next) && next.version <= existing.version) {
    next = { ...next, version: existing.version + 1 };
  }

  if (input.status === 'ci_gate') {
    // 07 §7: a reviewer who is not the author signs the promotion
    if (typeof input.reviewer !== 'string' || input.reviewer.trim() === '') {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, 'mark_recipe: promoting to ci_gate requires `reviewer`', 'pass the reviewing human (07 §7); it is recorded in provenance.reviewed_by');
    }
    if (input.force !== true) {
      const stats = ctx.db.recipeStats(input.recipe_id, { currentBuild: ctx.build, lastN: THRESHOLDS.recompile_window_runs });
      if (!eligibleForCiGate(stats)) {
        throw new AppMapError(
          ERROR_CODES.BAD_INPUT,
          `mark_recipe: ${input.recipe_id} is not eligible for ci_gate yet`,
          `08 §5 row 1: ≥${THRESHOLDS.ci_gate_min_success_rate * 100}% replay success across ≥${THRESHOLDS.ci_gate_min_builds} builds (seen ${stats.successes}/${stats.runs} over ${stats.builds.length} builds)`,
        );
      }
    }
    next = { ...next, provenance: { ...next.provenance, reviewed_by: input.reviewer.trim() } };
  }

  next = { ...next, status: input.status };
  ctx.db.putRecipe(next, { dirty: true, reason: `mark_recipe:${input.status}` });
  ctx.log.info('mark_recipe', { recipe: next.id, from, to: next.status, version: next.version });
  return { recipe_id: next.id, from, to: next.status, written: true };
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
