/**
 * Every filesystem path the map uses, derived from `AppMapConfig` (02 §2, 02 §7, 03 §2, 03 §11,
 * 04 §6.1, 07 §2.3). No other module builds a path under `app-map/` by hand.
 *
 * Layout:
 *   <dir>/ids.yaml
 *   <dir>/schema/<kind>.schema.json
 *   <dir>/policy/mcp-allowlist.yaml
 *   <dir>/<platform>/manifest.yaml
 *   <dir>/<platform>/screens/<screen_id>.yaml
 *   <dir>/<platform>/recipes/<recipe_id>.yaml
 *   <dir>/.local/                      git-ignored (07 §2.4)
 *   <dir>/.local/cache.sqlite          03 §4 (WAL)
 *   <dir>/.local/ingest.sock           03 §2
 *   <dir>/.local/trajectories/<session>.jsonl   02 §7
 *   <dir>/.local/events.jsonl          08 §2
 *   <dir>/.local/server.log            03 §11
 *   <dir>/.local/strings.<platform>.txt  07 §2.3.3
 *   <dir>/.local/ci-params.<platform>.json  CI param values per recipe (04 §6.2, 06 R5) — generated
 *                                      from the app's fixture module at build time like the string
 *                                      table; never committed (07 §2.3.5)
 *   <dir>/.local/maestro/<recipe>.yaml 04 §6.1
 *   tools/app-map-mcp/migrations/      schema_version migration scripts (02 §8) — package-relative
 *
 * Layer: leaf (imports only config types).
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppMapConfig, Platform } from './config.ts';

/** absolute path of tools/app-map-mcp (works from src/ and dist/) */
export const PACKAGE_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Cfg = Pick<AppMapConfig, 'dir' | 'platform'>;

export const YAML_KINDS = ['manifest', 'ids', 'screen', 'recipe', 'mcp-allowlist'] as const;
export const SCHEMA_KINDS = [...YAML_KINDS, 'router-export', 'drift-report', 'heal-report', 'events', 'hook-payload'] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];
export type YamlKind = (typeof YAML_KINDS)[number];

export function idsFile(cfg: Pick<Cfg, 'dir'>): string {
  return join(cfg.dir, 'ids.yaml');
}
export function schemaDir(cfg: Pick<Cfg, 'dir'>): string {
  return join(cfg.dir, 'schema');
}
export function schemaFile(cfg: Pick<Cfg, 'dir'>, kind: SchemaKind): string {
  return join(schemaDir(cfg), `${kind}.schema.json`);
}
export function policyDir(cfg: Pick<Cfg, 'dir'>): string {
  return join(cfg.dir, 'policy');
}
export function allowlistFile(cfg: Pick<Cfg, 'dir'>): string {
  return join(policyDir(cfg), 'mcp-allowlist.yaml');
}
export function platformDir(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(cfg.dir, platform);
}
export function manifestFile(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(platformDir(cfg, platform), 'manifest.yaml');
}
export function screensDir(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(platformDir(cfg, platform), 'screens');
}
export function screenFile(cfg: Cfg, screenId: string, platform: Platform = cfg.platform): string {
  return join(screensDir(cfg, platform), `${screenId}.yaml`);
}
export function recipesDir(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(platformDir(cfg, platform), 'recipes');
}
export function recipeFile(cfg: Cfg, recipeId: string, platform: Platform = cfg.platform): string {
  return join(recipesDir(cfg, platform), `${recipeId}.yaml`);
}

// ---- local, git-ignored -------------------------------------------------------------------
export function localDir(cfg: Pick<Cfg, 'dir'>): string {
  return join(cfg.dir, '.local');
}
export function cacheFile(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'cache.sqlite');
}
export function ingestSocket(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'ingest.sock');
}
export function trajectoriesDir(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'trajectories');
}
export function trajectoryFile(cfg: Pick<Cfg, 'dir'>, session: string): string {
  return join(trajectoriesDir(cfg), `${safeSegment(session)}.jsonl`);
}
export function eventsFile(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'events.jsonl');
}
export function serverLog(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'server.log');
}
export function stringsFile(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(localDir(cfg), `strings.${platform}.txt`);
}
/**
 * Per-recipe CI parameter values `{ "<recipe_id>": { "<param>": value } }` (04 §6.2, 06 R5/R6):
 * `maestro-export` and `run --all` read it unless `--params-file` is given. Generated at build
 * time from the app's fixture module (01 R5: fixtures live in code) into `.local/`, so fixture
 * data never lands in a recipe file (07 §2.3.5).
 */
export function ciParamsFile(cfg: Cfg, platform: Platform = cfg.platform): string {
  return join(localDir(cfg), `ci-params.${platform}.json`);
}
export function maestroOutDir(cfg: Pick<Cfg, 'dir'>): string {
  return join(localDir(cfg), 'maestro');
}
export function maestroFlowFile(cfg: Pick<Cfg, 'dir'>, recipeId: string, outDir: string = maestroOutDir(cfg)): string {
  return join(outDir, `${recipeId}.yaml`);
}

// ---- package-relative ---------------------------------------------------------------------
/**
 * `tools/app-map-mcp/migrations/` (02 §8: every `schema_version` bump ships a migration script
 * `<from>-to-<to>.ts` there; see migrations/README.md). Empty until schema_version 2.
 */
export function migrationsDir(): string {
  return join(PACKAGE_ROOT, 'migrations');
}
export function migrationFile(from: number, to: number): string {
  return join(migrationsDir(), `${from}-to-${to}.ts`);
}

/** Replace anything outside `[A-Za-z0-9_.-]` so a session id can never escape a directory. */
export function safeSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^\.+/, '_');
  return cleaned.length ? cleaned : '_';
}

/** Which schema validates a YAML file at `path` (relative to `cfg.dir`), or `undefined`. */
export function kindForPath(cfg: Pick<Cfg, 'dir'>, path: string): YamlKind | undefined {
  const rel = path.startsWith(cfg.dir) ? path.slice(cfg.dir.length).replace(/^[/\\]/, '') : path;
  const parts = rel.split(/[/\\]/);
  if (parts.length === 1 && parts[0] === 'ids.yaml') return 'ids';
  if (parts.length === 2 && parts[0] === 'policy' && parts[1] === 'mcp-allowlist.yaml') return 'mcp-allowlist';
  if (parts.length === 2 && parts[1] === 'manifest.yaml') return 'manifest';
  if (parts.length === 3 && parts[1] === 'screens') return 'screen';
  if (parts.length === 3 && parts[1] === 'recipes') return 'recipe';
  return undefined;
}
