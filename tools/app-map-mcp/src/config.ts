/**
 * Environment configuration (03 §3, plus `APP_MAP_SIM_UDID` from 04 §10). Every variable has a
 * default; `.mcp.json` sets them for the server, hooks and CI inherit the shell environment.
 *
 * Layer: leaf (imports only errors).
 */
import { resolve } from 'node:path';
import { AppMapError, ERROR_CODES } from './errors.ts';

export const PLATFORMS = ['ios', 'android'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** What the automatic 04 §8 recompile is allowed to do to the map (issue #13). */
export const RECOMPILE_MODES = ['guarded', 'off'] as const;
export type RecompileMode = (typeof RECOMPILE_MODES)[number];

export interface AppMapConfig {
  /** `APP_MAP_DIR` — absolute root of YAML + `.local/` (default `./app-map`, resolved against cwd) */
  dir: string;
  /** `APP_MAP_PLATFORM` — which platform map to serve (default `ios`) */
  platform: Platform;
  /**
   * `APP_MAP_BUILD` — current build number, or `'auto'` (default): detect from the driver's
   * reported bundle when available, else from `manifest.yaml` (03 §3, 03 §13).
   */
  build: string;
  /** `APP_MAP_DRIVER` — driver tool-name prefix hooks match on (default `argent` → `mcp__argent__*`) */
  driver: string;
  /** `APP_MAP_MAESTRO_BIN` — executor binary for headless replay (default `maestro`) */
  maestroBin: string;
  /** `APP_MAP_LOG_LEVEL` (default `info`) */
  logLevel: LogLevel;
  /** `APP_MAP_MAX_CONTEXT_TOKENS` — cap for `summary` and `get_screen` outputs (default 600) */
  maxContextTokens: number;
  /** `APP_MAP_SIM_UDID` — booted simulator/emulator for headless runs; `undefined` = `booted` (04 §10) */
  simUdid: string | undefined;
  /** `APP_MAP_RETENTION_DAYS` — `.local` retention (default 14; 02 §7, 07 §2.4) */
  retentionDays: number;
  /**
   * `APP_MAP_RECOMPILE` — what the automatic 04 §8 recompile may do (default `guarded`).
   *
   * - `guarded`: rebuild from the latest successful trajectory, but write it over the reviewed
   *   recipe only when the rebuilt steps, `preconditions` and `entry` all cover the reviewed
   *   ones and the compile raised no incompleteness warning (`recipes/lifecycle.recompileFrom`);
   *   otherwise keep the reviewed recipe and report the refusal. An accepted write is stamped
   *   `provenance.machine_recompile: true` and labelled by `export`.
   * - `off`: replay is strictly read-only against the map. The demotion to `candidate` still
   *   happens — that is the 08 §5 signal, not a write to the recipe body — but the steps are
   *   never rebuilt; a human recompiles with `compile_recipe` + `mark`.
   *
   * There is deliberately no value that restores the pre-#13 unguarded write.
   */
  recompile: RecompileMode;
}

export const CONFIG_DEFAULTS: Readonly<Omit<AppMapConfig, 'dir'>> & { dir: string } = {
  dir: './app-map',
  platform: 'ios',
  build: 'auto',
  driver: 'argent',
  maestroBin: 'maestro',
  logLevel: 'info',
  maxContextTokens: 600,
  simUdid: undefined,
  retentionDays: 14,
  recompile: 'guarded',
};

export const ENV_VARS = {
  dir: 'APP_MAP_DIR',
  platform: 'APP_MAP_PLATFORM',
  build: 'APP_MAP_BUILD',
  driver: 'APP_MAP_DRIVER',
  maestroBin: 'APP_MAP_MAESTRO_BIN',
  logLevel: 'APP_MAP_LOG_LEVEL',
  maxContextTokens: 'APP_MAP_MAX_CONTEXT_TOKENS',
  simUdid: 'APP_MAP_SIM_UDID',
  retentionDays: 'APP_MAP_RETENTION_DAYS',
  recompile: 'APP_MAP_RECOMPILE',
} as const;

export function isPlatform(x: unknown): x is Platform {
  return typeof x === 'string' && (PLATFORMS as readonly string[]).includes(x);
}

/**
 * Build a config from an environment map (defaults to `process.env`). `dir` is made absolute
 * against `cwd`. Invalid values throw `AppMapError(bad_input)` so a misconfigured `.mcp.json`
 * fails fast with a hint instead of serving the wrong map.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): AppMapConfig {
  const get = (k: string): string | undefined => {
    const v = env[k];
    return v === undefined || v === '' ? undefined : v;
  };
  const platform = get(ENV_VARS.platform) ?? CONFIG_DEFAULTS.platform;
  if (!isPlatform(platform)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${ENV_VARS.platform}=${platform} is not one of ${PLATFORMS.join('|')}`, 'set APP_MAP_PLATFORM to ios or android');
  }
  const logLevel = get(ENV_VARS.logLevel) ?? CONFIG_DEFAULTS.logLevel;
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${ENV_VARS.logLevel}=${logLevel} is not one of ${LOG_LEVELS.join('|')}`, 'use debug|info|warn|error');
  }
  const recompile = get(ENV_VARS.recompile) ?? CONFIG_DEFAULTS.recompile;
  if (!(RECOMPILE_MODES as readonly string[]).includes(recompile)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${ENV_VARS.recompile}=${recompile} is not one of ${RECOMPILE_MODES.join('|')}`, 'use guarded (the default) or off to make replay read-only against the map (04 §8)');
  }
  const intOr = (k: string, dflt: number, min: number): number => {
    const raw = get(k);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new AppMapError(ERROR_CODES.BAD_INPUT, `${k}=${raw} must be an integer >= ${min}`, `unset ${k} to use the default (${dflt})`);
    return n;
  };
  return {
    dir: resolve(cwd, get(ENV_VARS.dir) ?? CONFIG_DEFAULTS.dir),
    platform,
    build: get(ENV_VARS.build) ?? CONFIG_DEFAULTS.build,
    driver: get(ENV_VARS.driver) ?? CONFIG_DEFAULTS.driver,
    maestroBin: get(ENV_VARS.maestroBin) ?? CONFIG_DEFAULTS.maestroBin,
    logLevel: logLevel as LogLevel,
    maxContextTokens: intOr(ENV_VARS.maxContextTokens, CONFIG_DEFAULTS.maxContextTokens, 50),
    simUdid: get(ENV_VARS.simUdid),
    retentionDays: intOr(ENV_VARS.retentionDays, CONFIG_DEFAULTS.retentionDays, 1),
    recompile: recompile as RecompileMode,
  };
}

/** Regex that matches driver tool names for this config, e.g. `/^mcp__argent__/` (05 §3). */
export function driverToolPattern(config: Pick<AppMapConfig, 'driver'>): RegExp {
  return new RegExp(`^mcp__${config.driver.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}__`);
}

/** Convert a config back to env form (used by `gen-configs` and the headless runner's child processes). */
export function configToEnv(config: AppMapConfig): Record<string, string> {
  const out: Record<string, string> = {
    [ENV_VARS.dir]: config.dir,
    [ENV_VARS.platform]: config.platform,
    [ENV_VARS.build]: config.build,
    [ENV_VARS.driver]: config.driver,
    [ENV_VARS.maestroBin]: config.maestroBin,
    [ENV_VARS.logLevel]: config.logLevel,
    [ENV_VARS.maxContextTokens]: String(config.maxContextTokens),
    [ENV_VARS.retentionDays]: String(config.retentionDays),
    [ENV_VARS.recompile]: config.recompile,
  };
  if (config.simUdid !== undefined) out[ENV_VARS.simUdid] = config.simUdid;
  return out;
}
