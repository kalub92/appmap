/**
 * [A1] Read the map from disk and build the in-memory index (03 §4 "Load", 02 §2).
 *
 * `loadMap(config)` must finish in <500 ms for 300 screens (03 §11): parse with `yaml.parse`,
 * validate each file against its schema (yaml/schemas.ts), run the cross-reference rules
 * (validate.ts) and index. Cross-reference ERRORS throw `AppMapError(invalid_map)` whose message
 * lists every one — the server reports it through `summary` rather than crashing (03 §11).
 * WARNINGS never block the load; they ride on `LoadedMap.validationWarnings` so `formatSummary`
 * can surface them (02 §10 rule 2's candidate carve-out, issue #12).
 *
 * Every reader parses with its YAML kind, so the manifest `build` scalars are read back as the
 * text the author wrote (`version: 1.0` stays `"1.0"`, `git_sha: 0000000` stays `"0000000"`,
 * 02 §3) and any remaining `must be string` schema error says how to quote it (issue #20).
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/schemas + validate).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import type { AppMapConfig, Platform } from '../config.ts';
import type { BuildNumber, IdsElement, IdsGate, IdsRegistry, IdsScreen, LoadedFile, LoadedMap, Manifest, McpAllowlist, RecipeFile, ScreenFile, ElementRef, ValidationIssue } from '../types.ts';
import { now, routeKey } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import type { YamlKind } from '../paths.ts';
import { allowlistFile, idsFile, manifestFile, recipesDir, schemaDir, screensDir, stringsFile } from '../paths.ts';
import { assertValid } from './schemas.ts';
import type { ParsedYaml } from './canonical.ts';
import { parseYamlDoc } from './canonical.ts';
import { crossReferenceIssues, formatIssues } from '../validate.ts';

/**
 * Content-addressed parse memo (git blob sha → parsed document). `yaml@2.9` costs ~3.5 ms per
 * pilot-sized screen file, which is the whole 03 §4 load budget at 300 screens; a reload after
 * one edit, or `validate` parsing a file for rule 1 and again for rule 7, must not pay it twice.
 * Entries are returned as `structuredClone`s (~0.06 ms) so callers can mutate freely.
 *
 * The key folds in `kind` because the parse is kind-dependent (`AUTHORED_STRING_SCALARS`,
 * issue #20): a byte-identical file read with no kind must not poison the coerced entry.
 */
const parseMemo = new Map<string, ParsedYaml<unknown>>();
const PARSE_MEMO_MAX = 4096;

/**
 * `parseYamlFile` plus the authored spellings of the scalars YAML resolved to numbers or booleans
 * (issue #20); passing `kind` also enables the documented-string coercion for that kind.
 */
export function parseYamlFileDoc<T = unknown>(path: string, kind?: YamlKind): ParsedYaml<T> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppMapError(ERROR_CODES.NOT_FOUND, `${path} does not exist`, 'check APP_MAP_DIR / APP_MAP_PLATFORM (03 §3)', { cause: e });
    throw new AppMapError(ERROR_CODES.STORAGE, `${path} cannot be read: ${(e as Error).message}`, 'check file permissions', { cause: e });
  }
  const key = `${blobSha(bytes)}\0${kind ?? ''}`;
  const hit = parseMemo.get(key);
  if (hit !== undefined) return structuredClone(hit) as ParsedYaml<T>;
  const parsed = parseYamlDoc<T>(bytes.toString('utf8'), path, kind);
  if (parseMemo.size >= PARSE_MEMO_MAX) parseMemo.clear();
  parseMemo.set(key, parsed);
  return structuredClone(parsed);
}

/** `yaml.parse` of a file; throws `AppMapError(invalid_map)` with file + line on parse errors. */
export function parseYamlFile<T = unknown>(path: string, kind?: YamlKind): T {
  return parseYamlFileDoc<T>(path, kind).doc;
}

/** `app-map/ids.yaml`, schema-validated. */
export function readIds(config: Pick<AppMapConfig, 'dir'>): IdsRegistry {
  const file = idsFile(config);
  const { doc, scalarSources } = parseYamlFileDoc(file, 'ids');
  assertValid<IdsRegistry>(schemaDir(config), 'ids', doc, relPath(config, file), scalarSources);
  return doc;
}

/** `app-map/<platform>/manifest.yaml`, schema-validated. */
export function readManifest(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Manifest {
  const p = platform ?? config.platform;
  const file = manifestFile(config, p);
  const { doc, scalarSources } = parseYamlFileDoc(file, 'manifest');
  const rel = relPath(config, file);
  assertValid<Manifest>(schemaDir(config), 'manifest', doc, rel, scalarSources);
  if (doc.platform !== p) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `${rel}: platform ${doc.platform} must equal the directory name ${p}`, 'each platform directory carries its own manifest (02 §3)');
  }
  return doc;
}

function yamlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => join(dir, f));
}

/** Every `screens/*.yaml` (screens and gates), schema-validated; `path` absolute. File name must equal `id`. */
export function readScreenFiles(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Array<{ path: string; screen: ScreenFile }> {
  const p = platform ?? config.platform;
  const sd = schemaDir(config);
  return yamlFilesIn(screensDir(config, p)).map((path) => {
    const { doc, scalarSources } = parseYamlFileDoc(path, 'screen');
    const rel = relPath(config, path);
    assertValid<ScreenFile>(sd, 'screen', doc, rel, scalarSources);
    assertFileNameIsId(rel, path, doc.id);
    return { path, screen: doc };
  });
}

/** Every `recipes/*.yaml`, schema-validated; file name must equal `id`, `platform` must match the directory. */
export function readRecipeFiles(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Array<{ path: string; recipe: RecipeFile }> {
  const p = platform ?? config.platform;
  const sd = schemaDir(config);
  return yamlFilesIn(recipesDir(config, p)).map((path) => {
    const { doc, scalarSources } = parseYamlFileDoc(path, 'recipe');
    const rel = relPath(config, path);
    assertValid<RecipeFile>(sd, 'recipe', doc, rel, scalarSources);
    assertFileNameIsId(rel, path, doc.id);
    if (doc.platform !== p) {
      throw new AppMapError(ERROR_CODES.INVALID_MAP, `${rel}: platform ${doc.platform} must equal the platform directory ${p}`, 'move the recipe under app-map/<platform>/recipes/ or fix `platform` (02 §6)');
    }
    return { path, recipe: doc };
  });
}

/** 02 §2.1: one file per entity, named after its id. */
function assertFileNameIsId(rel: string, path: string, id: string): void {
  const name = basename(path).replace(/\.ya?ml$/, '');
  if (name !== id) {
    throw new AppMapError(ERROR_CODES.INVALID_MAP, `${rel}: id ${id} must equal the file name ${name}`, 'rename the file or use `app-map migrate-id` (02 §2.1, 02 §8)');
  }
}

/** `app-map/policy/mcp-allowlist.yaml` (07 §6). */
export function readAllowlist(config: Pick<AppMapConfig, 'dir'>): McpAllowlist {
  const file = allowlistFile(config);
  const { doc, scalarSources } = parseYamlFileDoc(file, 'mcp-allowlist');
  assertValid<McpAllowlist>(schemaDir(config), 'mcp-allowlist', doc, relPath(config, file), scalarSources);
  return doc;
}

/**
 * Static string table snapshot `.local/strings.<platform>.txt` (07 §2.3.3): one string per line,
 * LF, UTF-8, no trimming beyond the line terminator. Empty set when the file is absent.
 */
export function readStaticStrings(config: Pick<AppMapConfig, 'dir' | 'platform'>, platform?: Platform): Set<string> {
  const file = stringsFile(config, platform ?? config.platform);
  if (!existsSync(file)) return new Set();
  // only the LF terminator is stripped; an empty line cannot be static copy and is skipped
  return new Set(readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0));
}

export interface IndexMapInput {
  platform: Platform;
  manifest: Manifest;
  ids: IdsRegistry;
  screens: ScreenFile[];
  recipes: RecipeFile[];
  /** from `readStaticStrings`; merged with labels/titles found in screen files */
  staticStrings?: ReadonlySet<string>;
  /** does `.local/strings.<platform>.txt` exist? (03 §5 step 1 / 03 §7 degrade without it) */
  stringTablePresent?: boolean;
  /** effective build; defaults to `manifest.build.build_number` */
  build?: BuildNumber;
  treeHash?: string;
  /** relative path → provenance (`loadMap` fills it from `readScreenFiles`/`readRecipeFiles` paths + `gitBlobHash`); empty map when absent */
  files?: ReadonlyMap<string, LoadedFile>;
  /** 02 §10 warnings that did not block the load (issue #12); `[]` when absent */
  validationWarnings?: ValidationIssue[];
}

/** The registry entry synthesized for a gate dismiss control (architecture §7 decision 2). */
export function dismissRegistryEntry(gate: IdsGate): IdsElement {
  return { id: gate.dismiss, kind: 'button', intent_critical: false, dynamic: false };
}

/**
 * Pure: build `LoadedMap` indexes (screens/gates split by `kind`, elements by id with every
 * declaration, markers, routes keyed by `routeKey(deep_link)`, elementRegistry including gate
 * dismiss controls synthesized as `{id, kind:'button', intent_critical:false, dynamic:false}`).
 * `staticLabels` = `staticStrings` ∪ element labels ∪ `kind: screen` titles (gate titles are
 * excluded, 07 §2.1). `routes` are keyed from the screen files; validate rule 2 guarantees they
 * agree with ids.yaml.
 */
export function indexMap(input: IndexMapInput): LoadedMap {
  const { ids } = input;
  const idsIndex = new Map<string, IdsElement | IdsGate | IdsScreen>();
  const elementRegistry = new Map<string, IdsElement>();
  for (const s of ids.screens) {
    idsIndex.set(s.id, s);
    idsIndex.set(`screen.${s.id}`, s);
  }
  for (const g of ids.gates) {
    idsIndex.set(g.id, g);
    const dismiss = dismissRegistryEntry(g);
    idsIndex.set(g.dismiss, dismiss);
    elementRegistry.set(g.dismiss, dismiss);
  }
  for (const e of ids.elements) {
    idsIndex.set(e.id, e);
    elementRegistry.set(e.id, e);
  }

  const screens = new Map<string, ScreenFile>();
  const gates = new Map<string, ScreenFile>();
  const elements = new Map<string, ElementRef[]>();
  const markers = new Map<string, string>();
  const routes = new Map<string, string>();
  const staticLabels = new Set<string>(input.staticStrings ?? []);
  for (const file of input.screens) {
    (file.kind === 'gate' ? gates : screens).set(file.id, file);
    for (const element of file.elements) {
      const refs = elements.get(element.id);
      if (refs) refs.push({ screen: file.id, element });
      else elements.set(element.id, [{ screen: file.id, element }]);
      if (element.label !== undefined) staticLabels.add(element.label);
    }
    if (file.signature.marker !== 'none') markers.set(file.signature.marker, file.id);
    if (file.kind === 'screen') {
      if (file.title !== undefined) staticLabels.add(file.title);
      if (file.deep_link !== undefined && file.deep_link !== 'none') routes.set(routeKey(file.deep_link), file.id);
      if (file.signature.route !== undefined && file.signature.route !== 'none') {
        const k = routeKey(file.signature.route);
        if (!routes.has(k)) routes.set(k, file.id);
      }
    }
  }
  const recipes = new Map<string, RecipeFile>();
  for (const r of input.recipes) recipes.set(r.id, r);

  const map: LoadedMap = {
    platform: input.platform,
    manifest: input.manifest,
    ids,
    files: input.files ?? new Map(),
    idsIndex,
    elementRegistry,
    screens,
    gates,
    recipes,
    elements,
    markers,
    routes,
    staticLabels,
    stringTablePresent: input.stringTablePresent === true,
    validationWarnings: [...(input.validationWarnings ?? [])],
    build: input.build ?? input.manifest.build.build_number,
    loadedAt: now(),
  };
  if (input.treeHash !== undefined) map.treeHash = input.treeHash;
  return map;
}

export interface LoadMapOptions {
  /** run 02 §10 rules 1–6 and 8 (default true); rule 7 (canonical) is `export --check`'s job */
  validate?: boolean;
  /** override `config.build` / manifest build */
  build?: BuildNumber;
  platform?: Platform;
}

/** path relative to `config.dir`, always with forward slashes (the `LoadedMap.files` key) */
export function relPath(config: Pick<AppMapConfig, 'dir'>, path: string): string {
  return relative(config.dir, path).split(sep).join('/');
}

/**
 * Read + validate + index. The one entry point the server, CLI and tests use. Fills
 * `LoadedMap.files` with one entry per file read (`ids.yaml`, `<platform>/manifest.yaml`,
 * `<platform>/screens/<id>.yaml`, `<platform>/recipes/<id>.yaml`) and its `gitBlobHash`.
 */
export function loadMap(config: AppMapConfig, opts: LoadMapOptions = {}): LoadedMap {
  const platform = opts.platform ?? config.platform;
  const cfg = { dir: config.dir, platform };
  const files = new Map<string, LoadedFile>();
  const record = (kind: LoadedFile['kind'], id: string, path: string): void => {
    const entry: LoadedFile = { kind, id };
    const sha = gitBlobHash(path);
    if (sha !== undefined) entry.blob_sha = sha;
    files.set(relPath(config, path), entry);
  };

  const ids = readIds(cfg);
  record('ids', 'ids', idsFile(cfg));
  const manifest = readManifest(cfg, platform);
  record('manifest', 'manifest', manifestFile(cfg, platform));
  const screenFiles = readScreenFiles(cfg, platform);
  const recipeFiles = readRecipeFiles(cfg, platform);
  const screenByRel = new Map<string, ScreenFile>();
  for (const { path, screen } of screenFiles) {
    record('screen', screen.id, path);
    screenByRel.set(relPath(config, path), screen);
  }
  const recipeByRel = new Map<string, RecipeFile>();
  for (const { path, recipe } of recipeFiles) {
    record('recipe', recipe.id, path);
    recipeByRel.set(relPath(config, path), recipe);
  }

  let validationWarnings: ValidationIssue[] = [];
  if (opts.validate !== false) {
    // rules 2–6 and 8 (rule 1 already ran per file above; rule 7 belongs to `export --check`)
    // `build` is the manifest's, not `opts.build`/`config.build`: rule 2's stale-capture carve-out
    // asks what build the MAP was written for (what `import-router` stamps), and taking a caller's
    // running-app override here would let a map load that `app-map validate` then rejects.
    const found = crossReferenceIssues({ platform, ids, screens: screenByRel, recipes: recipeByRel, build: manifest.build.build_number });
    const issues = found.filter((i) => i.severity === 'error');
    if (issues.length) {
      throw new AppMapError(ERROR_CODES.INVALID_MAP, `app-map has ${issues.length} validation error${issues.length === 1 ? '' : 's'} (02 §10):\n${formatIssues(issues)}`, 'run `app-map validate` and fix every listed issue before starting the server');
    }
    // 02 §10 rule 2's candidate carve-out means a map can now load WITH warnings (issue #12); keep
    // them so `formatSummary` can say so instead of reporting a healthy map.
    validationWarnings = found.filter((i) => i.severity === 'warning');
  }

  const build = opts.build ?? (config.build !== 'auto' && config.build !== '' ? config.build : manifest.build.build_number);
  const treeHash = gitTreeHash(config.dir);
  const input: IndexMapInput = {
    platform,
    manifest,
    ids,
    screens: screenFiles.map((s) => s.screen),
    recipes: recipeFiles.map((r) => r.recipe),
    staticStrings: readStaticStrings(cfg, platform),
    stringTablePresent: existsSync(stringsFile(cfg, platform)),
    build,
    files,
    validationWarnings,
  };
  if (treeHash !== undefined) input.treeHash = treeHash;
  return indexMap(input);
}

// ---- git hashing ----------------------------------------------------------------------------

/** git's blob object id: `sha1("blob <len>\0" + bytes)` — identical to `git hash-object <file>`. */
function blobSha(bytes: Buffer): string {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** per-directory memo: a git spawn costs ~10 ms and the answer only changes on `git init` (03 §4 load budget) */
const gitRepoMemo = new Map<string, boolean>();

function insideGitRepo(dir: string): boolean {
  const memo = gitRepoMemo.get(dir);
  if (memo === true) return true; // a repo never stops being one during a process; re-probe only negatives
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    const inside = out.trim() === 'true';
    gitRepoMemo.set(dir, inside);
    return inside;
  } catch {
    gitRepoMemo.set(dir, false);
    return false;
  }
}

function* walkFiles(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    if (name === '.local' || name === '.git' || name === 'node_modules') continue; // .local is git-ignored (07 §2.4)
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* walkFiles(p);
    else if (st.isFile()) yield p;
  }
}

/**
 * `git rev-parse HEAD:<relative app-map dir>` style tree hash of the map directory, computed
 * with `git ls-files -s` + `git hash-object` semantics over the *working tree* (uncommitted edits
 * count). `undefined` when not inside a git repo or git is unavailable. Used by context.ts to
 * decide whether to reload (03 §4).
 */
export function gitTreeHash(dir: string): string | undefined {
  if (!existsSync(dir) || !insideGitRepo(dir)) return undefined;
  // One entry per working-tree file (`.local` excluded, as git ignores it): "<mode> <blob> <path>",
  // hashed like a flattened `git ls-files -s` listing, so the value changes iff any file's content
  // or name changes — without spawning git once per file (03 §4 load budget).
  const h = createHash('sha1');
  for (const file of walkFiles(dir)) {
    const sha = gitBlobHash(file);
    if (sha === undefined) continue;
    h.update(`100644 ${sha} ${relative(dir, file).split(sep).join('/')}\n`);
  }
  return h.digest('hex');
}

/** Git blob sha of a file as currently on disk (`git hash-object`), for export conflict checks (03 §4). */
export function gitBlobHash(path: string): string | undefined {
  try {
    return blobSha(readFileSync(path));
  } catch {
    return undefined;
  }
}
