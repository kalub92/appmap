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
 * Layer: session (imports context, types, tree, scrub, signature, resolve, lifecycle, events).
 */
import type { AppMapContext } from './context.ts';
import type { AnyTree, BuildNumber, DriftReport, DriftScreenResult, LoadedMap, RouterExport, ScreenFile, ScreenId } from './types.ts';
import type { ExecFn, HierarchyProvider } from './recipes/headless.ts';
import { NotImplementedError } from './errors.ts';

export interface DriftOptions {
  build: BuildNumber;
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
}

export function driftTour(ctx: AppMapContext, opts: DriftOptions): Promise<DriftReport> {
  void ctx; void opts;
  throw new NotImplementedError('drift.driftTour');
}

/** Pure: one screen vs one scrubbed tree. */
export function compareScreen(map: LoadedMap, screen: ScreenFile, tree: AnyTree, opts: { ciGateScreens: ReadonlySet<ScreenId> }): DriftScreenResult {
  void map; void screen; void tree; void opts;
  throw new NotImplementedError('drift.compareScreen');
}

/** Pure: screens referenced by any `ci_gate` recipe. */
export function ciGateScreens(map: LoadedMap): Set<ScreenId> {
  void map;
  throw new NotImplementedError('drift.ciGateScreens');
}

/** Pure: `screen · status · missing ids · hash changed` markdown table for the PR comment (06 R4.4). */
export function formatDriftTable(report: DriftReport): string {
  void report;
  throw new NotImplementedError('drift.formatDriftTable');
}

/** Pure: `summary` from the per-screen results. */
export function summarize(screens: readonly DriftScreenResult[]): DriftReport['summary'] {
  void screens;
  throw new NotImplementedError('drift.summarize');
}
