/**
 * [contract] Test helpers shared by every `src/test/*.test.ts` (docs/dev/toolchain.md: node:test,
 * fixtures under tools/app-map-mcp/fixtures, temp dirs under os.tmpdir(), never the repo's
 * app-map/.local).
 *
 * Typical use:
 * ```ts
 * const t = makeTempAppMapDir({ copyPilot: true });
 * try { const map = loadMap(t.config); … } finally { t.cleanup(); }
 * ```
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppMapConfig, Platform } from '../config.ts';
import { CONFIG_DEFAULTS, loadConfig } from '../config.ts';
import type { AnyTree, DriftReport, Event, HealReport, HookPayload, Observation, RecipeParams, RouterExport, Tree } from '../types.ts';

/** tools/app-map-mcp */
export const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** repo root */
export const REPO_ROOT: string = resolve(PACKAGE_ROOT, '..', '..');
/** the committed pilot map */
export const PILOT_APP_MAP_DIR: string = join(REPO_ROOT, 'app-map');
/** tools/app-map-mcp/fixtures */
export const FIXTURES_DIR: string = join(PACKAGE_ROOT, 'fixtures');

export interface TempAppMapDir {
  /** the temporary `app-map/` root */
  dir: string;
  /** a config pointing at `dir` (defaults otherwise; `logLevel: 'error'`) */
  config: AppMapConfig;
  /** remove the directory (idempotent) */
  cleanup: () => void;
}

export interface MakeTempOptions {
  /** copy app-map/ (ids, schema, policy, ios/, android/) into the temp dir (default true) */
  copyPilot?: boolean;
  platform?: Platform;
  /** extra env applied on top of the defaults (e.g. `{ APP_MAP_BUILD: '4413' }`) */
  env?: NodeJS.ProcessEnv;
  /** also copy fixtures/strings.<platform>.txt to `.local/strings.<platform>.txt` (default true when copyPilot); skipped silently when the fixture is absent */
  withStrings?: boolean;
  /** also copy fixtures/ci/params.json to `.local/ci-params.<platform>.json` (default true when copyPilot) */
  withCiParams?: boolean;
}

/**
 * Create `os.tmpdir()/app-map-test-XXXXXX/app-map` and return a config for it. `.local/` is
 * never copied from the repo (it is git-ignored and must not exist there anyway).
 */
export function makeTempAppMapDir(opts: MakeTempOptions = {}): TempAppMapDir {
  const copyPilot = opts.copyPilot ?? true;
  const base = mkdtempSync(join(tmpdir(), 'app-map-test-'));
  const dir = join(base, 'app-map');
  if (copyPilot) {
    cpSync(PILOT_APP_MAP_DIR, dir, {
      recursive: true,
      filter: (src) => !src.split(/[/\\]/).includes('.local'),
    });
    const platform = opts.platform ?? CONFIG_DEFAULTS.platform;
    if (opts.withStrings ?? true) {
      const strings = join(FIXTURES_DIR, `strings.${platform}.txt`);
      if (existsSync(strings)) cpSync(strings, join(dir, '.local', `strings.${platform}.txt`));
    }
    if (opts.withCiParams ?? true) {
      const params = join(FIXTURES_DIR, 'ci', 'params.json');
      if (existsSync(params)) cpSync(params, join(dir, '.local', `ci-params.${platform}.json`));
    }
  } else {
    cpSync(join(PILOT_APP_MAP_DIR, 'schema'), join(dir, 'schema'), { recursive: true });
  }
  const env: NodeJS.ProcessEnv = {
    APP_MAP_DIR: dir,
    APP_MAP_PLATFORM: opts.platform ?? CONFIG_DEFAULTS.platform,
    APP_MAP_LOG_LEVEL: 'error',
    ...opts.env,
  };
  const config = loadConfig(env, base);
  let cleaned = false;
  return {
    dir,
    config,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

/** Read a fixture file as UTF-8 text; `path` is relative to tools/app-map-mcp/fixtures. */
export function readFixture(path: string): string {
  return readFileSync(join(FIXTURES_DIR, path), 'utf8');
}

/** Parse a JSON fixture. */
export function readJsonFixture<T = unknown>(path: string): T {
  return JSON.parse(readFixture(path)) as T;
}

/**
 * `fixtures/trees/<name>.normalized.json` → `Tree` (raw, unscrubbed). Accepts `invoice_list`,
 * `invoice_list.with_gate`, `pii`, `android/login`, … (the `.normalized.json` suffix is added).
 */
export function loadFixtureTree(name: string): Tree {
  const file = name.endsWith('.json') ? name : `${name}.normalized.json`;
  return readJsonFixture<Tree>(join('trees', file));
}

/** Names of every iOS fixture tree (without suffix), for table-driven tests. */
export const PILOT_SCREEN_TREES: readonly string[] = ['login', 'invoice_list', 'invoice_new', 'invoice_detail', 'client_picker'];

/** `fixtures/hooks/<name>.json` → HookPayload (`post-tool-use.tap`, `session-start`, `post-tool-use-failure.tap`, `stop`). */
export function loadHookFixture(name: string): HookPayload {
  return readJsonFixture<HookPayload>(join('hooks', `${name}.json`));
}

/** `fixtures/router-export.ios.json`. */
export function loadRouterExportFixture(): RouterExport {
  return readJsonFixture<RouterExport>('router-export.ios.json');
}

/** `fixtures/trajectories/<name>.jsonl` → observations in order (`create_invoice.session`). */
export function loadTrajectoryFixture(name: string): Observation[] {
  return readFixture(join('trajectories', `${name}.jsonl`))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Observation);
}

/** Static string table fixture as a Set (07 §2.3.3); `strings.<platform>.txt`. */
export function loadStaticStringsFixture(platform: Platform = 'ios'): Set<string> {
  return new Set(readFixture(`strings.${platform}.txt`).split('\n').filter((l) => l.length > 0));
}

/** `fixtures/events/sample.events.jsonl` → events in file order (08 §2; report.test.ts input). */
export function loadEventsFixture(name = 'sample'): Event[] {
  return readFixture(join('events', `${name}.events.jsonl`))
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Event);
}

/** `fixtures/ci/drift-report.json` (06 R4 artifact, validates against drift-report.schema.json). */
export function loadDriftReportFixture(): DriftReport {
  return readJsonFixture<DriftReport>(join('ci', 'drift-report.json'));
}

/** `fixtures/ci/heal-report.json` (06 R6 artifact, validates against heal-report.schema.json). */
export function loadHealReportFixture(): HealReport {
  return readJsonFixture<HealReport>(join('ci', 'heal-report.json'));
}

/** `fixtures/ci/params.json` — per-recipe CI param values (`{create_invoice: {amount: 50, client: 'Acme Corp'}}`). */
export function loadCiParamsFixture(): Record<string, RecipeParams> {
  return readJsonFixture<Record<string, RecipeParams>>(join('ci', 'params.json'));
}

/** `fixtures/maestro/<recipe>.flow.yaml` — golden Maestro flow (04 §6.2; maestro.test.ts). */
export function loadMaestroFlowFixture(recipe = 'create_invoice'): string {
  return readFixture(join('maestro', `${recipe}.flow.yaml`));
}

/** `fixtures/lint/<name>` — Swift/Kotlin snippets with lint violations (01 R8; lint-ids.test.ts). */
export function loadLintFixture(name: 'Bad.swift' | 'Bad.kt'): string {
  return readFixture(join('lint', name));
}

/**
 * The raw NESTED fixtures with the screen marker DOUBLED, which is what `appMapScreen(_:)` and
 * `AppMapScreenMarkerView` really emit (issue #15): `screen.<id>` sits on the
 * `children: .contain` CONTAINER and again on a 1 pt overlay ELEMENT inside it. The overlay is
 * the container's LAST child — SwiftUI applies the overlay after the content it decorates, UIKit
 * `addSubview`s the marker — and it is childless. `fromArgentScreen` discards the overlay's own
 * frame, so the FLAT shape never shows the pair; every capture that preserves nesting does
 * (`xcuitest`, and `maestro`, which drift.ts runs on BOTH platforms).
 */
export function doubledMarkerXcuiFixture(marker = 'screen.invoice_list'): unknown {
  const raw = readJsonFixture<{ root: Record<string, unknown> }>(join('raw', 'xcuitest-snapshot.invoice_list.json'));
  let found = false;
  const visit = (n: Record<string, unknown>): void => {
    const kids = Array.isArray(n['children']) ? n['children'] as Record<string, unknown>[] : [];
    if (n['identifier'] === marker) {
      const frame = (n['frame'] ?? {}) as Record<string, number>;
      kids.push({ type: 'Other', identifier: marker, frame: { x: frame['x'] ?? 0, y: frame['y'] ?? 0, width: 1, height: 1 }, children: [] });
      found = true;
      return;
    }
    for (const kid of kids) visit(kid);
  };
  visit(raw.root);
  if (!found) throw new Error(`xcuitest fixture carries no ${marker} container`);
  return raw;
}

/** `doubledMarkerXcuiFixture` for the `maestro hierarchy` shape (the marker keys on `resource-id`). */
export function doubledMarkerMaestroFixture(marker = 'screen.invoice_list'): unknown {
  const raw = readJsonFixture<{ elements: Record<string, unknown>[] }>(join('raw', 'maestro-hierarchy.invoice_list.json'));
  let found = false;
  const visit = (n: Record<string, unknown>): void => {
    const attrs = (n['attributes'] ?? {}) as Record<string, string>;
    const kids = Array.isArray(n['children']) ? n['children'] as Record<string, unknown>[] : [];
    if (attrs['resource-id'] === marker) {
      // the marker's top-leading corner, 1 px square — `[x1,y1][x2,y2]`, maestro's bounds format
      const x1 = Number(/\[(-?\d+),(-?\d+)\]/.exec(attrs['bounds'] ?? '')?.[1] ?? 0);
      const y1 = Number(/\[(-?\d+),(-?\d+)\]/.exec(attrs['bounds'] ?? '')?.[2] ?? 0);
      kids.push({
        attributes: { ...attrs, class: 'android.view.View', bounds: `[${x1},${y1}][${x1 + 1},${y1 + 1}]` },
        children: [],
      });
      found = true;
      return;
    }
    for (const kid of kids) visit(kid);
  };
  for (const el of raw.elements) visit(el);
  if (!found) throw new Error(`maestro fixture carries no ${marker} container`);
  return raw;
}

/** Deep clone a tree so a test can mutate it (drop ids, relabel) without touching the fixture. */
export function cloneTree<T extends AnyTree>(t: T): T {
  return structuredClone(t);
}
