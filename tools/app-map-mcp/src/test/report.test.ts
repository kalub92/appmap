/**
 * [D2] `app-map report` (08 §3, 08 §4, 08 §5, decision 46). Input: `fixtures/events/
 * sample.events.jsonl` (every 08 §2 kind) plus synthetic events for the alert thresholds.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Event, EventKind, ReportMetrics } from '../types.ts';
import { openContext } from '../context.ts';
import { loadMap } from '../yaml/load.ts';
import { THRESHOLDS } from '../recipes/lifecycle.ts';
import { DEFAULT_WINDOW_DAYS, computeMetrics, formatReport, parseSince, report } from '../report.ts';
import { loadDriftReportFixture, loadEventsFixture, loadHealReportFixture, loadRouterExportFixture, makeTempAppMapDir, readFixture } from './helpers.ts';

const SINCE = '2026-09-01T00:00:00Z';
const UNTIL = '2026-09-08T00:00:00Z';
const WINDOW = { platform: 'ios' as const, since: SINCE, until: UNTIL };
const close = (actual: number, expected: number, what: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: expected ${expected}, got ${actual}`);
};

describe('08 §4 metrics over the sample events', () => {
  const m = computeMetrics(loadEventsFixture(), WINDOW);

  it('the fixture carries every 08 §2 event kind', () => {
    const kinds = new Set<EventKind>(loadEventsFixture().map((e) => e.kind));
    assert.deepEqual([...kinds].sort(), ['compile', 'drift', 'heal', 'identify', 'recipe_run', 'task']);
  });

  it('replay_rate = runs with no fallback ÷ all runs (3 of 5)', () => {
    close(m.replay_rate, 3 / 5, 'replay_rate');
  });

  it('fallback_rate_per_recipe is scoped to the current build (create_invoice on 4413 = 1)', () => {
    assert.deepEqual(Object.keys(m.fallback_rate_per_recipe), ['create_invoice']);
    close(m.fallback_rate_per_recipe.create_invoice!, 1, 'fallback_rate create_invoice');
  });

  it('heal_rate_per_100_runs = heals × 100 ÷ runs (2 × 100 ÷ 5 = 40)', () => {
    close(m.heal_rate_per_100_runs, 40, 'heal_rate_per_100_runs');
  });

  it('intent_critical_rejections counts rejected intent_critical heals (1)', () => {
    assert.equal(m.intent_critical_rejections, 1);
    assert.equal(m.pending_review_heals, 0, 'no db was passed');
  });

  it('brittleness_index covers the first run of each build after the baseline (4411/4412/4413 → 2 of 3)', () => {
    close(m.brittleness_index, 2 / 3, 'brittleness_index');
  });

  it('unknown_screen_rate = unknown identifies ÷ identifies for this platform (1 of 3)', () => {
    close(m.unknown_screen_rate, 1 / 3, 'unknown_screen_rate');
    close(m.unknown_screen_rate_7d, 1 / 3, 'unknown_screen_rate_7d over 09-01…09-08');
  });

  it('convergence is the cumulative success rate, oldest → newest', () => {
    const curve = m.convergence.create_invoice!;
    assert.equal(curve.length, 5);
    close(curve[0]!, 1, 'run 1');
    close(curve[1]!, 1, 'run 2');
    close(curve[2]!, 2 / 3, 'run 3');
    close(curve[3]!, 3 / 4, 'run 4');
    close(curve[4]!, 3 / 5, 'run 5');
  });

  it('tasks are the 08 §3 baseline means of the two task events', () => {
    assert.equal(m.tasks.count, 2);
    close(m.tasks.success_rate, 1, 'success_rate');
    close(m.tasks.driver_calls_mean, 10, 'driver_calls_mean');
    close(m.tasks.screenshots_mean, 0.5, 'screenshots_mean');
    close(m.tasks.perception_bytes_mean, (61200 + 18400) / 2, 'perception_bytes_mean');
    close(m.tasks.ms_mean, (92000 + 41000) / 2, 'ms_mean');
  });

  it('alerts fire for the fallback rate, the intent_critical rejection and the 7-day unknown rate', () => {
    assert.equal(m.alerts.length, 3, m.alerts.join('\n'));
    assert.ok(m.alerts.some((a) => a.includes('fallback_rate') && a.includes('create_invoice') && a.includes('4413')));
    assert.ok(m.alerts.some((a) => a.includes('intent_critical')));
    assert.ok(m.alerts.some((a) => a.includes('unknown_screen_rate_7d')));
  });

  it('another platform sees only its own events', () => {
    const android = computeMetrics(loadEventsFixture(), { ...WINDOW, platform: 'android' });
    assert.equal(android.tasks.count, 0);
    close(android.unknown_screen_rate, 0, 'android has one identify event, none unknown');
    assert.deepEqual(android.alerts, []);
  });

  it('a window that excludes everything yields zeros and no alerts', () => {
    const empty = computeMetrics(loadEventsFixture(), { ...WINDOW, since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' });
    assert.deepEqual(empty.fallback_rate_per_recipe, {});
    assert.deepEqual(empty.convergence, {});
    close(empty.replay_rate, 0, 'replay_rate');
    close(empty.brittleness_index, 0, 'brittleness_index');
    assert.deepEqual(empty.alerts, []);
    assert.equal(empty.tasks.count, 0);
  });

  it('`until` is exclusive so consecutive windows never double count', () => {
    const first = computeMetrics(loadEventsFixture(), { ...WINDOW, until: '2026-09-05T00:00:00Z' });
    const second = computeMetrics(loadEventsFixture(), { ...WINDOW, since: '2026-09-05T00:00:00Z' });
    // 3 runs before 09-05 and 2 after; the union is the 5 runs of the whole window
    assert.equal(first.convergence.create_invoice!.length + second.convergence.create_invoice!.length, 5);
  });
});

describe('08 §5 alert thresholds', () => {
  const runs = (n: number, fallbacks: number): Event[] => Array.from({ length: n }, (_, i) => ({
    kind: 'recipe_run', ts: `2026-09-0${i + 1}T00:00:00Z`, platform: 'ios', recipe: 'create_invoice', version: 1,
    mode: 'headless', ok: fallbacks === 0, steps: 3, steps_done: 3, heals: 0, fallbacks, ms: 100, build: '4412',
  } as Event));

  it('a fallback rate exactly at the threshold does not alert; above it does', () => {
    const at = computeMetrics([...runs(4, 0), { ...(runs(1, 1)[0] as Event) }], { ...WINDOW, since: '2026-08-01T00:00:00Z', until: '2026-09-30T00:00:00Z' });
    close(at.fallback_rate_per_recipe.create_invoice!, THRESHOLDS.alert_fallback_rate, 'exactly 20%');
    assert.deepEqual(at.alerts, [], '08 §4 alerts "> 20%", not ">= 20%"');
    const above = computeMetrics(runs(5, 1), { ...WINDOW, since: '2026-08-01T00:00:00Z', until: '2026-09-30T00:00:00Z' });
    assert.ok(above.alerts.some((a) => a.startsWith('fallback_rate')));
  });

  it('a candidate recipe does not alert (08 §4: verified/ci_gate only)', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const withCandidate = { ...map, recipes: new Map([['create_invoice', { ...map.recipes.get('create_invoice')!, status: 'candidate' as const }]]) };
      const m = computeMetrics(runs(3, 1), { ...WINDOW, since: '2026-08-01T00:00:00Z', until: '2026-09-30T00:00:00Z', map: withCandidate });
      assert.deepEqual(m.alerts.filter((a) => a.startsWith('fallback_rate')), []);
      // the same runs against the verified pilot recipe do alert
      const verified = computeMetrics(runs(3, 1), { ...WINDOW, since: '2026-08-01T00:00:00Z', until: '2026-09-30T00:00:00Z', map });
      assert.equal(verified.alerts.filter((a) => a.startsWith('fallback_rate')).length, 1);
    } finally {
      t.cleanup();
    }
  });

  it('pending_review_heals alerts strictly above the threshold', () => {
    const base = { ...WINDOW, since: '2026-08-01T00:00:00Z', until: '2026-09-30T00:00:00Z' };
    assert.deepEqual(computeMetrics([], { ...base, pendingHeals: THRESHOLDS.alert_pending_heals }).alerts, []);
    const over = computeMetrics([], { ...base, pendingHeals: THRESHOLDS.alert_pending_heals + 1 });
    assert.equal(over.alerts.length, 1);
    assert.match(over.alerts[0]!, /pending_review_heals 6 > 5/);
  });

  it('the unknown-screen alert uses the trailing 7-day value, not the 30-day one (decision 46)', () => {
    const identify = (ts: string, screen: string): Event => ({ kind: 'identify', ts, platform: 'ios', screen, confidence: 1, signal: 'marker', build: '4412' } as Event);
    const events: Event[] = [
      identify('2026-08-05T00:00:00Z', 'unknown'),
      ...Array.from({ length: 20 }, (_, i) => identify(`2026-08-1${i % 10}T00:00:00Z`, 'invoice_list')),
      ...Array.from({ length: 9 }, (_, i) => identify(`2026-09-0${i + 1}T00:00:00Z`, 'invoice_list')),
    ];
    const m = computeMetrics(events, { platform: 'ios', since: '2026-08-01T00:00:00Z', until: '2026-09-10T00:00:00Z' });
    assert.ok(m.unknown_screen_rate > 0 && m.unknown_screen_rate < THRESHOLDS.alert_unknown_rate, `30-day rate ${m.unknown_screen_rate}`);
    close(m.unknown_screen_rate_7d, 0, 'nothing unknown in the trailing week');
    assert.deepEqual(m.alerts, []);
    // move the unknown into the trailing week
    const recent = computeMetrics([...events, identify('2026-09-09T00:00:00Z', 'unknown')], { platform: 'ios', since: '2026-08-01T00:00:00Z', until: '2026-09-10T00:00:00Z' });
    assert.ok(recent.unknown_screen_rate_7d > THRESHOLDS.alert_unknown_rate);
    assert.equal(recent.alerts.length, 1);
    assert.match(recent.alerts[0]!, /unknown_screen_rate_7d/);
    assert.equal(THRESHOLDS.alert_unknown_window_days, 7);
  });
});

describe('CI artifacts (08 §4, 08 §8)', () => {
  it('a blocking drift report and a heal report needing review each raise an alert', () => {
    const m = computeMetrics([], { ...WINDOW, artifacts: { drift: loadDriftReportFixture(), heal: loadHealReportFixture() } });
    assert.ok(m.alerts.some((a) => a.startsWith('drift-report:') && a.includes('ci_gate')), m.alerts.join('\n'));
    assert.ok(m.alerts.some((a) => a.startsWith('heal-report:')), m.alerts.join('\n'));
  });

  it('pending_review_heals falls back to the heal report when no db count is given', () => {
    const heal = loadHealReportFixture();
    assert.equal(computeMetrics([], { ...WINDOW, artifacts: { heal } }).pending_review_heals, heal.heals.length);
    assert.equal(computeMetrics([], { ...WINDOW, artifacts: { heal }, pendingHeals: 0 }).pending_review_heals, 0, 'the db count wins');
  });

  it('a non-blocking drift report raises no drift alert', () => {
    const drift = loadDriftReportFixture();
    const m = computeMetrics([], { ...WINDOW, artifacts: { drift: { ...drift, summary: { ...drift.summary, blocking: false } } } });
    assert.deepEqual(m.alerts.filter((a) => a.startsWith('drift-report:')), []);
  });
});

describe('map_coverage (08 §4 row 6)', () => {
  it('screens with a deep link and verified status ÷ screens in the router export', () => {
    const t = makeTempAppMapDir();
    try {
      const map = loadMap(t.config);
      const router = loadRouterExportFixture();
      const covered = [...map.screens.values()].filter((s) => s.deep_link !== undefined && s.deep_link !== 'none' && s.meta.status === 'verified').length;
      const m = computeMetrics([], { ...WINDOW, map, artifacts: { router } });
      close(m.map_coverage, covered / router.screens.length, 'map_coverage against the router export');
      assert.equal(router.screens.length, 6, 'the fixture export has one screen the map does not (settings)');
      // without an export the denominator is the map itself
      close(computeMetrics([], { ...WINDOW, map }).map_coverage, covered / map.screens.size, 'map_coverage without an export');
    } finally {
      t.cleanup();
    }
  });

  it('is 0 without a map', () => {
    close(computeMetrics([], WINDOW).map_coverage, 0, 'map_coverage');
  });
});

describe('formatReport (08 §4 text table)', () => {
  const text = formatReport(computeMetrics(loadEventsFixture(), WINDOW));

  it('prints every metric, one per line, plus the alerts section', () => {
    for (const key of ['replay_rate', 'heal_rate_per_100_runs', 'pending_review_heals', 'intent_critical_rejections',
      'brittleness_index', 'unknown_screen_rate', 'unknown_screen_rate_7d', 'map_coverage',
      'fallback_rate_per_recipe', 'convergence', 'tasks', 'alerts:']) {
      assert.ok(text.includes(key), `formatReport must mention ${key}`);
    }
    assert.match(text, /create_invoice\s+100\.0%/);
    assert.match(text, /100\.0% → 100\.0% → 66\.7% → 75\.0% → 60\.0%/);
    assert.match(text, /- fallback_rate create_invoice/);
    assert.ok(text.endsWith('\n'));
  });

  it('says `none` when there is nothing to alert on', () => {
    assert.match(formatReport(computeMetrics([], WINDOW)), /alerts:\n {2}none/);
  });
});

describe('report(ctx) reads .local/events.jsonl and the CI artifacts', () => {
  it('rolling window, events from disk, drift/heal/router artifacts', () => {
    const t = makeTempAppMapDir();
    try {
      writeFileSync(join(t.dir, '.local', 'events.jsonl'), readFixture(join('events', 'sample.events.jsonl')));
      writeFileSync(join(t.dir, '.local', 'router-export.json'), readFixture('router-export.ios.json'));
      const ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
      try {
        // the fixture events are dated 2026-09; a window wide enough to include them
        const m: ReportMetrics = report(ctx, { since: '36500d' });
        close(m.replay_rate, 3 / 5, 'replay_rate');
        assert.equal(m.intent_critical_rejections, 1);
        assert.equal(m.pending_review_heals, 0);
        assert.ok(m.map_coverage > 0, 'the router export next to the map is used as the denominator');
        assert.equal(m.platform, 'ios');
      } finally {
        ctx.close();
      }
    } finally {
      t.cleanup();
    }
  });

  it('a malformed artifact is ignored, not fatal', () => {
    const t = makeTempAppMapDir();
    try {
      writeFileSync(join(t.dir, '.local', 'drift-report.json'), '{ not json');
      const ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
      try {
        assert.equal(report(ctx).platform, 'ios');
      } finally {
        ctx.close();
      }
    } finally {
      t.cleanup();
    }
  });
});

describe('parseSince', () => {
  it('defaults to the rolling 30-day window (08 §4)', () => {
    const until = new Date('2026-09-30T00:00:00Z');
    assert.equal(DEFAULT_WINDOW_DAYS, 30);
    assert.equal(parseSince(undefined, until).toISOString(), '2026-08-31T00:00:00.000Z');
    assert.equal(parseSince('', until).toISOString(), '2026-08-31T00:00:00.000Z');
  });

  it('accepts `<n>d` and an ISO timestamp, and rejects anything else', () => {
    const until = new Date('2026-09-30T00:00:00Z');
    assert.equal(parseSince('7d', until).toISOString(), '2026-09-23T00:00:00.000Z');
    assert.equal(parseSince('2026-09-01T00:00:00Z', until).toISOString(), '2026-09-01T00:00:00.000Z');
    assert.throws(() => parseSince('last tuesday', until), /neither an ISO timestamp nor/);
  });
});
