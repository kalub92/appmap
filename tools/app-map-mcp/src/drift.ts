/**
 * [C3] Drift tour (06 R4, 03 §10 `drift --build B [--router path] [--out path]`, 08 §5).
 *
 * For every `kind: screen` with `deep_link !== 'none'` (skipped otherwise, `status: skipped`):
 *  1. `open(deep_link)` (default: `xcrun simctl openurl <udid|booted> <link>` / `adb shell am
 *     start …`, injectable), wait for the marker (`extendedWaitUntil`-style polling of
 *     `hierarchy()` up to `opts.timeoutMs`);
 *  2. `hierarchy()` → scrub → `compareScreen`:
 *     - `marker_present`: `findMarkerNodes` contains `screen.<id>`;
 *     - `required_present` / `missing_ids`: `requiredIdsFraction(tree, signature.required_ids)`;
 *     - `hash_changed`: `structuralHash(tree, dynamic_regions) !== signature.structural_hash`
 *       (and no variant hash matches);
 *     - `unresolvable_elements`: elements whose `resolve` is a miss OR whose hit is not by
 *       `a11y_id`;
 *     - status: `broken` when marker missing or any required id missing; `degraded` when
 *       hash changed or any element unresolvable; else `ok`;
 *     - `ci_gate_referenced`: the screen is referenced by a `ci_gate` recipe
 *       (lifecycle.screensReferenced);
 *  3. emit a `drift` event per screen (08 §2).
 * `summary.blocking` = any `broken` screen with `ci_gate_referenced` (06 R4.5, 08 §5). Screens
 * whose hash changed keep `last_verified_build` as-is so decay applies (06 R4 last paragraph) —
 * the tour never writes to the map. Output validates against `drift-report.schema.json`.
 *
 * `reason` is the closed `DriftReason` enum (07 §2.4). Variant facts for identification come from
 * `probeConditions(ctx.probe)` when a probe ran (optional for drift).
 *
 * Layer: session (imports context, types, tree, scrub, signature, resolve, lifecycle, events).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppMapContext } from './context.ts';
import type { AnyTree, BuildNumber, DriftReason, DriftReport, DriftScreenResult, DriftStatus, ElementId, LoadedMap, RouterExport, ScreenFile, ScreenId } from './types.ts';
import { DEEP_LINK_REGEX, stepElement } from './types.ts';
import type { ExecFn, HierarchyProvider } from './recipes/headless.ts';
import { defaultExec, defaultHierarchy } from './recipes/headless.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { findByA11yId, normalizeTree } from './tree.ts';
import { buildScrubPolicy, scrub } from './scrub.ts';
import { requiredIdsFraction, structuralHash } from './signature.ts';
import { resolve as resolveElement } from './resolve.ts';

export interface DriftOptions {
  /** defaults to `router.build.build_number` when `router` is given, else `ctx.build` (06 §3 invokes `drift` without `--build`) */
  build?: BuildNumber;
  /** router export for the same build (01 R6); when given, screens missing from it are reported `skipped` with `reason: 'not_in_router_export'` */
  router?: RouterExport;
  exec?: ExecFn;
  hierarchy?: HierarchyProvider;
  /** open a deep link on the device (default: simctl/adb through `exec`) */
  open?: (deepLink: string, opts: { exec: ExecFn; udid?: string }) => Promise<void>;
  /** marker wait per screen (default 10 000) */
  timeoutMs?: number;
  /** write the report here when set */
  outPath?: string;
  now?: () => Date;
  /** hierarchy poll interval while waiting for the marker (default 500 ms) */
  pollMs?: number;
}

/** 06 R4.2 `extendedWaitUntil`; same default as the Maestro mapping table (04 §6.2). */
export const DEFAULT_MARKER_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_MS = 500;

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `xcrun simctl openurl <udid|booted> <link>` / `adb shell am start -a …VIEW -d <link>` (06 R4.2). */
function makeDefaultOpen(platform: 'ios' | 'android'): NonNullable<DriftOptions['open']> {
  return async (deepLink, opts) => {
    const [cmd, args] = platform === 'ios'
      ? ['xcrun', ['simctl', 'openurl', opts.udid ?? 'booted', deepLink]]
      : ['adb', [...(opts.udid ? ['-s', opts.udid] : []), 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', deepLink]];
    const r = await opts.exec(cmd as string, args as string[], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new AppMapError(ERROR_CODES.INTERNAL, `${cmd} exited ${r.code}`, 'is the simulator/emulator booted and the app installed? (06 R4.1)');
  };
}

/** Pure: screens referenced by any `ci_gate` recipe. */
export function ciGateScreens(map: LoadedMap): Set<ScreenId> {
  const out = new Set<ScreenId>();
  for (const recipe of map.recipes.values()) {
    if (recipe.status !== 'ci_gate') continue;
    // Same set as `lifecycle.screensReferenced`: entry (deep link AND fallback path), every
    // `expect.screen`, `verify.screen` and the screens declaring the elements the steps touch.
    // The fallback path counts because 06 §5 requires `invoice_list: broken — missing
    // invoice.add.button` to BLOCK once `create_invoice` is `ci_gate`, and `invoice_list`
    // reaches that recipe only through `entry.fallback_path`.
    const entry = DEEP_LINK_REGEX.exec(recipe.entry?.deep_link ?? '')?.[1];
    if (entry) out.add(entry);
    for (const s of recipe.entry?.fallback_path ?? []) if (map.screens.has(s)) out.add(s);
    for (const step of recipe.steps ?? []) {
      if (step.expect?.screen) out.add(step.expect.screen);
      const elementId = stepElement(step);
      if (elementId) for (const ref of map.elements.get(elementId) ?? []) if (map.screens.has(ref.screen)) out.add(ref.screen);
    }
    if (recipe.verify?.screen) out.add(recipe.verify.screen);
  }
  return out;
}

/** Pure: one screen vs one scrubbed tree. */
export function compareScreen(map: LoadedMap, screen: ScreenFile, tree: AnyTree, opts: { ciGateScreens: ReadonlySet<ScreenId> }): DriftScreenResult {
  const sig = screen.signature ?? { marker: 'none' };
  const marker = sig.marker;
  // a gate signature has `marker: none`; nothing to look for, so it never counts as missing
  const marker_present = marker === 'none' || marker === undefined ? true : findByA11yId(tree, marker).length > 0;
  const required = requiredIdsFraction(tree, sig.required_ids ?? []);
  const hash = structuralHash(tree, screen.dynamic_regions ?? []);
  const variantMatch = (screen.variants ?? []).some((v) => v.structural_hash === hash);
  const hash_changed = sig.structural_hash !== undefined && sig.structural_hash !== hash && !variantMatch;
  const unresolvable: ElementId[] = [];
  for (const element of screen.elements ?? []) {
    const r = resolveElement(map, element, tree);
    // 06 R4.3 "Elements resolvable by `a11y_id`?" — a hit through a weaker strategy is drift too
    if (r.status !== 'hit' || r.strategy !== 'a11y_id') unresolvable.push(element.id);
  }
  const status: DriftStatus = !marker_present || required.missing.length > 0
    ? 'broken'
    : hash_changed || unresolvable.length > 0
      ? 'degraded'
      : 'ok';
  return {
    screen: screen.id,
    status,
    marker_present,
    required_present: round4(required.fraction),
    missing_ids: required.missing,
    hash_changed,
    unresolvable_elements: unresolvable,
    ci_gate_referenced: opts.ciGateScreens.has(screen.id),
  };
}

/** a screen that was never reached: every required id counts as missing, nothing resolved */
function unreachable(screen: ScreenFile, status: DriftStatus, reason: DriftReason, ciGate: ReadonlySet<ScreenId>): DriftScreenResult {
  return {
    screen: screen.id,
    status,
    marker_present: false,
    required_present: 0,
    missing_ids: status === 'skipped' ? [] : [...(screen.signature?.required_ids ?? [])],
    hash_changed: false,
    unresolvable_elements: [],
    ci_gate_referenced: ciGate.has(screen.id),
    reason,
  };
}

export async function driftTour(ctx: AppMapContext, opts: DriftOptions): Promise<DriftReport> {
  const map = ctx.map;
  const exec = opts.exec ?? defaultExec;
  const hierarchy = opts.hierarchy ?? defaultHierarchy;
  const open = opts.open ?? makeDefaultOpen(ctx.config.platform);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_MARKER_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  // 03 §10 / architecture decision 37: `--build` is optional.
  const build = opts.build ?? opts.router?.build?.build_number ?? ctx.build;
  const ciGate = ciGateScreens(map);
  const routerIds = opts.router ? new Set(opts.router.screens.map((s) => s.id)) : undefined;
  const policy = buildScrubPolicy(map.ids, map.staticLabels);
  const udid = ctx.config.simUdid;

  const results: DriftScreenResult[] = [];
  const screens = Array.from(map.screens.values()).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const screen of screens) {
    if (routerIds && !routerIds.has(screen.id)) {
      results.push(unreachable(screen, 'skipped', 'not_in_router_export', ciGate));
      continue;
    }
    const link = screen.deep_link;
    if (!link || link === 'none') {
      // 01 R5 / decision 9: a screen without a deep link costs navigation steps; the tour skips it
      results.push(unreachable(screen, 'skipped', 'no_deep_link', ciGate));
      continue;
    }
    try {
      await open(link, { exec, ...(udid ? { udid } : {}) });
    } catch (e) {
      ctx.log.warn('drift: could not open the deep link', { screen: screen.id, error: (e as Error).message });
      results.push(unreachable(screen, 'broken', 'open_failed', ciGate));
      continue;
    }

    // 06 R4.2: wait for the marker, then dump the hierarchy
    const marker = screen.signature?.marker;
    let tree: AnyTree | undefined;
    let sawMarker = false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const raw = await hierarchy({ exec, ...(udid ? { udid } : {}), bin: ctx.config.maestroBin, platform: ctx.config.platform });
      if (raw) {
        // the raw tree dies here: only the scrubbed form is compared, logged or reported (07 §2)
        tree = scrub(normalizeTree(raw, { platform: ctx.config.platform, source: 'maestro' }), policy);
        sawMarker = marker === undefined || marker === 'none' || findByA11yId(tree, marker).length > 0;
        if (sawMarker) break;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    }

    let result: DriftScreenResult;
    if (!tree) {
      result = unreachable(screen, 'broken', 'marker_timeout', ciGate);
    } else {
      result = compareScreen(map, screen, tree, { ciGateScreens: ciGate });
      if (!sawMarker) result.reason = 'marker_timeout';
    }
    results.push(result);
  }

  for (const r of results) {
    ctx.events.append({
      kind: 'drift',
      screen: r.screen,
      status: r.status,
      missing_ids: r.missing_ids,
      hash_changed: r.hash_changed,
      build,
      ci_gate_referenced: r.ci_gate_referenced,
    });
  }

  const generated = (opts.now ? opts.now() : new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const report: DriftReport = {
    schema_version: 1,
    platform: ctx.config.platform,
    build,
    generated_at: generated,
    screens: results,
    summary: summarize(results),
  };
  if (opts.outPath) {
    // ids and scores only (07 §2.4) — safe to upload as a CI artifact
    mkdirSync(dirname(opts.outPath), { recursive: true });
    writeFileSync(opts.outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  return report;
}

/** Pure: `screen · status · missing ids · hash changed` markdown table for the PR comment (06 R4.4). */
export function formatDriftTable(report: DriftReport): string {
  const lines: string[] = [];
  lines.push(`### app-map drift — build ${report.build} (${report.platform})`);
  lines.push('');
  lines.push('| screen | status | missing ids | hash changed |');
  lines.push('| --- | --- | --- | --- |');
  for (const s of report.screens) {
    const missing = s.missing_ids.length > 0 ? s.missing_ids.join(', ') : '—';
    const note = s.reason ? ` (${s.reason})` : '';
    lines.push(`| ${s.screen} | ${s.status}${note} | ${missing} | ${s.hash_changed ? 'yes' : 'no'} |`);
  }
  lines.push('');
  const { ok, degraded, broken, skipped, blocking } = report.summary;
  lines.push(`${ok} ok · ${degraded} degraded · ${broken} broken · ${skipped} skipped`);
  if (blocking) {
    // 06 §5: "fails R4 with `invoice_list: broken — missing invoice.add.button`"
    for (const s of report.screens) {
      if (s.status !== 'broken' || !s.ci_gate_referenced) continue;
      const why = s.missing_ids.length > 0 ? `missing ${s.missing_ids.join(', ')}` : s.reason ?? 'marker missing';
      lines.push(`${s.screen}: broken — ${why}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Pure: `summary` from the per-screen results. */
export function summarize(screens: readonly DriftScreenResult[]): DriftReport['summary'] {
  let ok = 0;
  let degraded = 0;
  let broken = 0;
  let skipped = 0;
  let blocking = false;
  for (const s of screens) {
    if (s.status === 'ok') ok++;
    else if (s.status === 'degraded') degraded++;
    else if (s.status === 'skipped') skipped++;
    else {
      broken++;
      // 06 R4.5 / 08 §5: only a ci_gate-referenced broken screen blocks the PR
      if (s.ci_gate_referenced) blocking = true;
    }
  }
  return { ok, degraded, broken, skipped, blocking };
}
