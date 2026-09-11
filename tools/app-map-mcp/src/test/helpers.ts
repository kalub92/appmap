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
import type { AnyTree, HookPayload, Observation, RouterExport, Tree } from '../types.ts';

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
  /** also copy fixtures/strings.ios.txt to `.local/strings.<platform>.txt` (default true when copyPilot) */
  withStrings?: boolean;
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
    if (opts.withStrings ?? true) {
      const strings = join(FIXTURES_DIR, 'strings.ios.txt');
      if (existsSync(strings)) {
        const platform = opts.platform ?? CONFIG_DEFAULTS.platform;
        cpSync(strings, join(dir, '.local', `strings.${platform}.txt`));
      }
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

/** `fixtures/hooks/<name>.json` → HookPayload (`post-tool-use.tap`, `session-start`, `post-tool-use-failure.tap`). */
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

/** Static string table fixture as a Set (07 §2.3.3). */
export function loadStaticStringsFixture(): Set<string> {
  return new Set(readFixture('strings.ios.txt').split('\n').filter((l) => l.length > 0));
}

/** Deep clone a tree so a test can mutate it (drop ids, relabel) without touching the fixture. */
export function cloneTree<T extends AnyTree>(t: T): T {
  return structuredClone(t);
}
