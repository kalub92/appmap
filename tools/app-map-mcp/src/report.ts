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
 *  - unknown_screen_rate = identify events with `screen === 'unknown'` ÷ identify events;
 *    alert when > THRESHOLDS.alert_unknown_rate;
 *  - map_coverage = screens with deep_link and `verified` status ÷ screens in the latest router
 *    export (falls back to screens in the map when no export is available);
 *  - convergence[r] = success rate of successive runs of r (cumulative), oldest → newest;
 *  - tasks: 08 §3 baseline means from `task` events.
 * `formatReport` prints one metric per line plus an `alerts:` section (plain text; `--json`
 * prints `ReportMetrics`).
 *
 * Layer: top (imports context, events, types, lifecycle.THRESHOLDS).
 */
import type { AppMapContext } from './context.ts';
import type { Platform } from './config.ts';
import type { DriftReport, Event, HealReport, LoadedMap, ReportMetrics, RouterExport, Timestamp } from './types.ts';
import { NotImplementedError } from './errors.ts';

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
  void events; void opts;
  throw new NotImplementedError('report.computeMetrics');
}

/** Pure. */
export function formatReport(metrics: ReportMetrics): string {
  void metrics;
  throw new NotImplementedError('report.formatReport');
}

/** Read events (events.readEvents) + db + artifacts, then `computeMetrics`. `since` accepts ISO or `<n>d`. */
export function report(ctx: AppMapContext, opts: { since?: string; artifactsDir?: string } = {}): ReportMetrics {
  void ctx; void opts;
  throw new NotImplementedError('report.report');
}
