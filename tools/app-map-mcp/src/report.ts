/**
 * [D2] `app-map report [--since]` (08 §4, 08 §8): every steady-state metric from
 * `.local/events.jsonl` plus the latest CI artifacts (`drift-report.json` / `heal-report.json`
 * next to the map or passed via `opts.artifacts`). Rolling 30 days by default, per platform.
 *
 * Definitions (08 §4), all over `recipe_run`/`heal`/`identify`/`task`/`drift` events in the window:
 *  - replay_rate = runs (guided+headless) with `fallbacks === 0` ÷ all runs;
 *  - fallback_rate_per_recipe[r] = runs of r with `fallbacks ≥ 1` ÷ runs of r (current build);
 *    alert when > THRESHOLDS.alert_fallback_rate for a `verified`/`ci_gate` recipe;
 *  - heal_rate_per_100_runs = heal events × 100 ÷ runs; pending_review_heals from
 *    `db.listPendingHeals()` (or 0 without a db); intent_critical_rejections = heal events with
 *    `accepted: false` and `reason: intent_critical_label_changed`; alert when pending >
 *    THRESHOLDS.alert_pending_heals or any intent_critical rejection;
 *  - brittleness_index = runs on a build that is new (first run of that build in the window)
 *    needing ≥1 heal or fallback ÷ such runs;
 *  - unknown_screen_rate = identify events with `screen === 'unknown'` ÷ identify events over
 *    the window, and unknown_screen_rate_7d over the trailing
 *    `THRESHOLDS.alert_unknown_window_days`; the alert fires on the 7-day value
 *    (08 §5 row 6 "> 10% for a week");
 *  - map_coverage = screens with deep_link and `verified` status ÷ screens in the latest router
 *    export (falls back to screens in the map when no export is available);
 *  - convergence[r] = success rate of successive runs of r (cumulative), oldest → newest;
 *  - tasks: 08 §3 baseline means from `task` events.
 * `formatReport` prints one metric per line plus an `alerts:` section (plain text; `--json`
 * prints `ReportMetrics`).
 *
 * Layer: top (imports context, events, types, lifecycle.THRESHOLDS).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppMapContext } from './context.ts';
import type { Platform } from './config.ts';
import type { DriftReport, Event, HealReport, LoadedMap, RecipeRunEvent, ReportMetrics, RouterExport, Timestamp } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { readEvents } from './events.ts';
import { localDir } from './paths.ts';
import { THRESHOLDS } from './recipes/lifecycle.ts';

/** 08 §4 "rolling 30-day" */
export const DEFAULT_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ComputeMetricsOptions {
  platform: Platform;
  since: Timestamp;
  until: Timestamp;
  map?: LoadedMap;
  pendingHeals?: number;
  artifacts?: { drift?: DriftReport; heal?: HealReport; router?: RouterExport };
}

/** Pure. */
export function computeMetrics(events: readonly Event[], opts: ComputeMetricsOptions): ReportMetrics {
  const since = epoch(opts.since) ?? 0;
  const until = epoch(opts.until) ?? Number.MAX_SAFE_INTEGER;
  // half-open [since, until) — the same window `events.readEvents` applies, so consecutive
  // report windows never double count a run.
  const inWindow = events
    .filter((e) => e.platform === undefined || e.platform === opts.platform)
    .filter((e) => {
      const t = epoch(e.ts);
      return t !== undefined && t >= since && t < until;
    })
    .slice()
    .sort((a, b) => (epoch(a.ts) ?? 0) - (epoch(b.ts) ?? 0));

  const runs = inWindow.filter((e): e is RecipeRunEvent => e.kind === 'recipe_run');
  const heals = inWindow.filter((e) => e.kind === 'heal');
  const identifies = inWindow.filter((e) => e.kind === 'identify');
  const tasks = inWindow.filter((e) => e.kind === 'task');

  const replay_rate = ratio(runs.filter((r) => r.fallbacks === 0).length, runs.length);

  // --- fallback rate per recipe on the current build (08 §4 row 2) ---------------------------
  const currentBuild = runs.length > 0 ? runs[runs.length - 1]!.build : undefined;
  const fallback_rate_per_recipe: Record<string, number> = {};
  if (currentBuild !== undefined) {
    const onBuild = runs.filter((r) => r.build === currentBuild);
    for (const recipe of [...new Set(onBuild.map((r) => r.recipe))].sort()) {
      const mine = onBuild.filter((r) => r.recipe === recipe);
      fallback_rate_per_recipe[recipe] = ratio(mine.filter((r) => r.fallbacks >= 1).length, mine.length);
    }
  }

  const heal_rate_per_100_runs = runs.length === 0 ? 0 : (heals.length * 100) / runs.length;
  // `db.listPendingHeals()` is authoritative; without a cache the latest CI heal report's
  // accepted heals are the pending-review ones (they land as `healed_pending_review`, 04 §9).
  const pending_review_heals = opts.pendingHeals ?? opts.artifacts?.heal?.heals.length ?? 0;
  const intent_critical_rejections = heals.filter((h) => h.kind === 'heal' && !h.accepted && h.reason === 'intent_critical_label_changed').length;

  // --- brittleness index (08 §4 row 4) ------------------------------------------------------
  // "runs on a *new* build": the first run seen on each build after the window's baseline build.
  // The earliest build in the window is the baseline — nothing says it was new when it ran.
  const firstRunPerBuild: RecipeRunEvent[] = [];
  const seenBuilds = new Set<string>();
  for (const r of runs) {
    if (seenBuilds.has(r.build)) continue;
    seenBuilds.add(r.build);
    firstRunPerBuild.push(r);
  }
  const newBuildRuns = firstRunPerBuild.slice(1);
  const brittleness_index = ratio(newBuildRuns.filter((r) => r.heals >= 1 || r.fallbacks >= 1).length, newBuildRuns.length);

  // --- unknown-screen rate (08 §4 row 5, 08 §5 row 6) ---------------------------------------
  const unknown_screen_rate = ratio(identifies.filter((e) => e.kind === 'identify' && e.screen === 'unknown').length, identifies.length);
  const sevenDayStart = Math.max(since, until - THRESHOLDS.alert_unknown_window_days * DAY_MS);
  const recent = identifies.filter((e) => (epoch(e.ts) ?? 0) >= sevenDayStart);
  const unknown_screen_rate_7d = ratio(recent.filter((e) => e.kind === 'identify' && e.screen === 'unknown').length, recent.length);

  // --- map coverage (08 §4 row 6) -----------------------------------------------------------
  const map_coverage = mapCoverage(opts.map, opts.artifacts?.router);

  // --- convergence (08 §4 row 7) ------------------------------------------------------------
  const convergence: Record<string, number[]> = {};
  for (const r of runs) {
    const curve = (convergence[r.recipe] ??= []);
    const previousSuccesses = curve.length === 0 ? 0 : curve[curve.length - 1]! * curve.length;
    curve.push((previousSuccesses + (r.ok ? 1 : 0)) / (curve.length + 1));
  }

  const metrics: ReportMetrics = {
    platform: opts.platform,
    since: opts.since,
    until: opts.until,
    replay_rate,
    fallback_rate_per_recipe,
    heal_rate_per_100_runs,
    pending_review_heals,
    intent_critical_rejections,
    brittleness_index,
    unknown_screen_rate,
    unknown_screen_rate_7d,
    map_coverage,
    convergence,
    alerts: [],
    tasks: {
      count: tasks.length,
      success_rate: ratio(tasks.filter((t) => t.kind === 'task' && t.ok).length, tasks.length),
      driver_calls_mean: mean(tasks.map((t) => (t.kind === 'task' ? t.driver_calls : 0))),
      perception_bytes_mean: mean(tasks.map((t) => (t.kind === 'task' ? t.perception_bytes : 0))),
      screenshots_mean: mean(tasks.map((t) => (t.kind === 'task' ? t.screenshots : 0))),
      ms_mean: mean(tasks.map((t) => (t.kind === 'task' ? t.ms : 0))),
    },
  };
  metrics.alerts = alertsFor(metrics, { map: opts.map, currentBuild, artifacts: opts.artifacts });
  return metrics;
}

/** 08 §4 / 08 §5 thresholds; every number comes from `THRESHOLDS`. */
function alertsFor(m: ReportMetrics, ctx: { map?: LoadedMap; currentBuild?: string; artifacts?: ComputeMetricsOptions['artifacts'] }): string[] {
  const alerts: string[] = [];
  for (const [recipe, rate] of Object.entries(m.fallback_rate_per_recipe)) {
    if (rate <= THRESHOLDS.alert_fallback_rate) continue;
    // 08 §4: only `verified`/`ci_gate` recipes alert. Without a map the status is unknown and
    // the alert is raised (silence would hide a regression).
    const status = ctx.map?.recipes.get(recipe)?.status;
    if (status !== undefined && status !== 'verified' && status !== 'ci_gate') continue;
    alerts.push(`fallback_rate ${recipe} ${pct(rate)} > ${pct(THRESHOLDS.alert_fallback_rate)}${ctx.currentBuild !== undefined ? ` on build ${ctx.currentBuild}` : ''} — recompile from the latest successful trajectory (08 §5)`);
  }
  if (m.pending_review_heals > THRESHOLDS.alert_pending_heals) {
    alerts.push(`pending_review_heals ${m.pending_review_heals} > ${THRESHOLDS.alert_pending_heals} — review the nightly heal PR (08 §4)`);
  }
  if (m.intent_critical_rejections > 0) {
    alerts.push(`intent_critical heal rejected ×${m.intent_critical_rejections} — human review before anyone re-runs that recipe (08 §5)`);
  }
  if (m.unknown_screen_rate_7d > THRESHOLDS.alert_unknown_rate) {
    alerts.push(`unknown_screen_rate_7d ${pct(m.unknown_screen_rate_7d)} > ${pct(THRESHOLDS.alert_unknown_rate)} over ${THRESHOLDS.alert_unknown_window_days}d — schedule an exploration session or check router import (08 §5)`);
  }
  // The CI artifacts carry the latest run's verdict, which the event window may predate (08 §8).
  const drift = ctx.artifacts?.drift;
  if (drift?.summary.blocking === true) {
    const broken = drift.screens.filter((s) => s.status === 'broken' && s.ci_gate_referenced).map((s) => s.screen);
    alerts.push(`drift-report: ci_gate screen(s) broken on build ${drift.build}: ${broken.join(', ') || '(see drift-report.json)'} (06 §4)`);
  }
  const needsHuman = ctx.artifacts?.heal?.needs_human ?? [];
  if (needsHuman.length > 0) {
    alerts.push(`heal-report: ${needsHuman.length} heal(s) need human review (${[...new Set(needsHuman.map((h) => h.reason))].join(', ')}) — 08 §5`);
  }
  return alerts;
}

/** screens with a deep link and `verified` status ÷ screens in the latest router export (08 §4). */
function mapCoverage(map: LoadedMap | undefined, router: RouterExport | undefined): number {
  if (map === undefined) return 0;
  const covered = [...map.screens.values()].filter((s) => typeof s.deep_link === 'string' && s.deep_link !== 'none' && s.meta.status === 'verified').length;
  const total = router !== undefined ? router.screens.length : map.screens.size;
  return ratio(covered, total);
}

/** Pure. */
export function formatReport(metrics: ReportMetrics): string {
  const lines: string[] = [
    `app-map report — ${metrics.platform} ${metrics.since} … ${metrics.until}`,
    '',
    `replay_rate                ${pct(metrics.replay_rate)}`,
    `heal_rate_per_100_runs     ${round(metrics.heal_rate_per_100_runs)}`,
    `pending_review_heals       ${metrics.pending_review_heals}`,
    `intent_critical_rejections ${metrics.intent_critical_rejections}`,
    `brittleness_index          ${pct(metrics.brittleness_index)}`,
    `unknown_screen_rate        ${pct(metrics.unknown_screen_rate)}`,
    `unknown_screen_rate_7d     ${pct(metrics.unknown_screen_rate_7d)}`,
    `map_coverage               ${pct(metrics.map_coverage)}`,
  ];
  const fallbackEntries = Object.entries(metrics.fallback_rate_per_recipe);
  lines.push('', 'fallback_rate_per_recipe (current build):');
  if (fallbackEntries.length === 0) lines.push('  (no runs in the window)');
  for (const [recipe, rate] of fallbackEntries) lines.push(`  ${recipe.padEnd(24)} ${pct(rate)}`);
  const convergenceEntries = Object.entries(metrics.convergence);
  lines.push('', 'convergence (cumulative success, oldest → newest):');
  if (convergenceEntries.length === 0) lines.push('  (no runs in the window)');
  for (const [recipe, curve] of convergenceEntries) lines.push(`  ${recipe.padEnd(24)} ${curve.map(pct).join(' → ')}`);
  lines.push(
    '',
    `tasks                      ${metrics.tasks.count} (success ${pct(metrics.tasks.success_rate)})`,
    `  driver_calls_mean        ${round(metrics.tasks.driver_calls_mean)}`,
    `  perception_bytes_mean    ${round(metrics.tasks.perception_bytes_mean)}`,
    `  screenshots_mean         ${round(metrics.tasks.screenshots_mean)}`,
    `  ms_mean                  ${round(metrics.tasks.ms_mean)}`,
    '',
    'alerts:',
  );
  if (metrics.alerts.length === 0) lines.push('  none');
  for (const a of metrics.alerts) lines.push(`  - ${a}`);
  return `${lines.join('\n')}\n`;
}

/** Read events (events.readEvents) + db + artifacts, then `computeMetrics`. `since` accepts ISO or `<n>d`. */
export function report(ctx: AppMapContext, opts: { since?: string; artifactsDir?: string } = {}): ReportMetrics {
  const until = new Date();
  const since = parseSince(opts.since, until);
  const sinceTs = iso(since);
  const untilTs = iso(until);
  const { events } = readEvents(ctx.config, { since: sinceTs, until: untilTs });
  const artifactsDir = opts.artifactsDir ?? localDir(ctx.config);
  return computeMetrics(events, {
    platform: ctx.config.platform,
    since: sinceTs,
    until: untilTs,
    map: ctx.map,
    pendingHeals: safePendingHeals(ctx),
    artifacts: {
      ...readArtifact<DriftReport>(join(artifactsDir, 'drift-report.json'), 'drift'),
      ...readArtifact<HealReport>(join(artifactsDir, 'heal-report.json'), 'heal'),
      ...readArtifact<RouterExport>(join(artifactsDir, 'router-export.json'), 'router'),
    },
  });
}

function safePendingHeals(ctx: AppMapContext): number {
  try {
    return ctx.db.listPendingHeals().length;
  } catch {
    return 0; // a report must never fail because the cache is unreadable (08 §8)
  }
}

function readArtifact<T>(path: string, key: 'drift' | 'heal' | 'router'): Record<string, T> {
  if (!existsSync(path)) return {};
  try {
    return { [key]: JSON.parse(readFileSync(path, 'utf8')) as T };
  } catch {
    return {}; // a malformed artifact is ignored, never fatal
  }
}

/** `--since` accepts an ISO timestamp or `<n>d` (default `30d`, 08 §4). */
export function parseSince(since: string | undefined, until: Date): Date {
  if (since === undefined || since.trim().length === 0) return new Date(until.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);
  const days = /^([0-9]+)d$/.exec(since.trim());
  if (days !== null) return new Date(until.getTime() - Number(days[1]) * DAY_MS);
  const t = Date.parse(since);
  if (Number.isNaN(t)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `--since ${since} is neither an ISO timestamp nor <n>d`, 'try --since 30d or --since 2026-09-01T00:00:00Z');
  }
  return new Date(t);
}

function iso(d: Date): Timestamp {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function epoch(ts: string): number | undefined {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? undefined : n;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function round(x: number): string {
  return Number.isInteger(x) ? String(x) : x.toFixed(2);
}
