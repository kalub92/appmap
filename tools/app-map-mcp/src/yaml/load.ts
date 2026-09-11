/**
 * [A1] Read the map from disk and build the in-memory index (03 §4 "Load", 02 §2).
 *
 * `loadMap(config)` must finish in <500 ms for 300 screens (03 §11): parse with `yaml.parse`,
 * validate each file against its schema (yaml/schemas.ts), run the cross-reference rules
 * (validate.ts) and index. Failures throw `AppMapError(invalid_map)` whose message lists every
 * issue — the server reports it through `summary` rather than crashing (03 §11).
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/schemas + validate).
 */
import type { AppMapConfig, Platform } from '../config.ts';
import type { BuildNumber, IdsRegistry, LoadedMap, Manifest, McpAllowlist, RecipeFile, ScreenFile } from '../types.ts';
import { NotImplementedError } from '../errors.ts';

/** `yaml.parse` of a file; throws `AppMapError(invalid_map)` with file + line on parse errors. */
export function parseYamlFile<T = unknown>(path: string): T {
  void path;
  throw new NotImplementedError('yaml/load.parseYamlFile');
}

/** `app-map/ids.yaml`, schema-validated. */
export function readIds(config: Pick<AppMapConfig, 'dir'>): IdsRegistry {
  void config;
  throw new NotImplementedError('yaml/load.readIds');
}

/** `app-map/<platform>/manifest.yaml`, schema-validated. */
export function readManifest(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Manifest {
  void config; void platform;
  throw new NotImplementedError('yaml/load.readManifest');
}

/** Every `screens/*.yaml` (screens and gates), schema-validated; `path` absolute. File name must equal `id`. */
export function readScreenFiles(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Array<{ path: string; screen: ScreenFile }> {
  void config; void platform;
  throw new NotImplementedError('yaml/load.readScreenFiles');
}

/** Every `recipes/*.yaml`, schema-validated; file name must equal `id`, `platform` must match the directory. */
export function readRecipeFiles(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Array<{ path: string; recipe: RecipeFile }> {
  void config; void platform;
  throw new NotImplementedError('yaml/load.readRecipeFiles');
}

/** `app-map/policy/mcp-allowlist.yaml` (07 §6). */
export function readAllowlist(config: Pick<AppMapConfig, 'dir'>): McpAllowlist {
  void config;
  throw new NotImplementedError('yaml/load.readAllowlist');
}

/**
 * Static string table snapshot `.local/strings.<platform>.txt` (07 §2.3.3): one string per line,
 * LF, UTF-8, no trimming beyond the line terminator. Empty set when the file is absent.
 */
export function readStaticStrings(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Set<string> {
  void config; void platform;
  throw new NotImplementedError('yaml/load.readStaticStrings');
}

export interface IndexMapInput {
  platform: Platform;
  manifest: Manifest;
  ids: IdsRegistry;
  screens: ScreenFile[];
  recipes: RecipeFile[];
  /** from `readStaticStrings`; merged with labels/titles found in screen files */
  staticStrings?: ReadonlySet<string>;
  /** effective build; defaults to `manifest.build.build_number` */
  build?: BuildNumber;
  treeHash?: string;
}

/**
 * Pure: build `LoadedMap` indexes (screens/gates split by `kind`, elements by id with every
 * declaration, markers, routes keyed by `routeKey(deep_link)`, elementRegistry including gate
 * dismiss controls synthesized as `{id, kind:'button', intent_critical:false, dynamic:false}`).
 */
export function indexMap(input: IndexMapInput): LoadedMap {
  void input;
  throw new NotImplementedError('yaml/load.indexMap');
}

export interface LoadMapOptions {
  /** run 02 §10 rules 1–6 and 8 (default true); rule 7 (canonical) is `export --check`'s job */
  validate?: boolean;
  /** override `config.build` / manifest build */
  build?: BuildNumber;
  platform?: Platform;
}

/** Read + validate + index. The one entry point the server, CLI and tests use. */
export function loadMap(config: AppMapConfig, opts: LoadMapOptions = {}): LoadedMap {
  void config; void opts;
  throw new NotImplementedError('yaml/load.loadMap');
}

/**
 * `git rev-parse HEAD:<relative app-map dir>` style tree hash of the map directory, computed
 * with `git ls-files -s` + `git hash-object` semantics over the *working tree* (uncommitted edits
 * count). `undefined` when not inside a git repo or git is unavailable. Used by context.ts to
 * decide whether to reload (03 §4).
 */
export function gitTreeHash(dir: string): string | undefined {
  void dir;
  throw new NotImplementedError('yaml/load.gitTreeHash');
}

/** Git blob sha of a file as currently on disk (`git hash-object`), for export conflict checks (03 §4). */
export function gitBlobHash(path: string): string | undefined {
  void path;
  throw new NotImplementedError('yaml/load.gitBlobHash');
}
