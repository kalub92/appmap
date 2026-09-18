/**
 * [D2] `app-map init` — scaffold an app repository so a Claude Code session there has the map,
 * the skills, the instrumentation agents, the hooks and the MCP servers (01 R1, 05 §2–§5.1).
 *
 * The package is installed in the app repo as a devDependency (`npm i -D @gurucaleb/app-map`), so
 * everything this writes addresses the CLI as `npx app-map …`, which resolves the local bin with
 * no network. Nothing it writes points back into the app-map repository.
 *
 * What it writes (all relative to `opts.target`):
 *  - `app-map/ids.yaml`, `app-map/schema/*.schema.json`, `app-map/policy/mcp-allowlist.yaml`,
 *    `app-map/<platform>/manifest.yaml` and empty `screens/`, `recipes/` — the map skeleton (02 §2).
 *    YAML is written through `canonicalYaml`, so the consumer's `export --check` passes at once.
 *  - `.claude/skills/{app-nav,app-instrument}/**`, `.claude/agents/*.md`, `.claude/hooks/*.sh` —
 *    copied from the package's templates with the path rewrites of `REWRITES` applied.
 *  - `.mcp.json` and `.claude/settings.json` — MERGED into an existing file, never replaced: a
 *    server or hook this repo already declares is left exactly as it is (`merged: false` in the
 *    result names it), so `init` is safe to re-run and safe on a repo that already has a harness.
 *  - `app-map.config.json` — the per-repo paths `lint-ids` cannot guess (app source roots, the
 *    generated constants file). Read by `repo-config.ts`.
 *  - `.gitignore` / `.gitattributes` lines, appended only when absent.
 *
 * Idempotent: a second run reports every file `unchanged` and writes nothing. `--force` overwrites
 * a file whose content differs; without it a differing file is reported `conflict` and skipped, so
 * a customised agent or hook is never silently reverted.
 *
 * Layer: top (imports config, paths, yaml/canonical, gen-configs, errors).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { PACKAGE_ROOT, SCHEMA_KINDS } from './paths.ts';
import { canonicalYaml } from './yaml/canonical.ts';
import { CONFIG_FILE, type RepoConfig } from './repo-config.ts';

/** The npm package name the scaffolded files refer to (`.mcp.json`, the hooks' npx fallback). */
export const PACKAGE_NAME = '@gurucaleb/app-map';
/** Where the installed server lives in the app repo, for `.mcp.json` and the allowlist. */
export const SERVER_ENTRY = `node_modules/${PACKAGE_NAME}/dist/index.js`;

export interface InitOptions {
  /** the app repository to scaffold (absolute) */
  target: string;
  /** which platform map to create (default `ios`) */
  platform?: Platform;
  /** app source roots for `lint-ids`, relative to `target` (default: detected, else `['.']`) */
  appSrcDirs?: string[];
  /** where `gen-ids` writes the Swift constants, relative to `target` */
  generatedSwift?: string;
  /** where `gen-ids` writes the Kotlin constants, relative to `target` */
  generatedKotlin?: string;
  /** the app's bundle identifier, for `manifest.yaml` */
  appId?: string;
  /** deep-link scheme (default `appmap`; a per-app scheme is 01 R5 / issue #25) */
  scheme?: string;
  /** overwrite a file whose content differs (default false: report a conflict and skip) */
  force?: boolean;
  /** compute everything, write nothing */
  dryRun?: boolean;
  /** the version recorded in the generated allowlist (default: this package's) */
  version?: string;
}

export type FileAction = 'created' | 'unchanged' | 'updated' | 'conflict' | 'merged' | 'skipped';

export interface InitFileResult {
  /** path relative to `target`, forward slashes */
  path: string;
  action: FileAction;
  /** why, for `conflict`, `skipped` and `merged` */
  note?: string;
}

export interface InitResult {
  target: string;
  platform: Platform;
  files: InitFileResult[];
  /** the steps `init` cannot do for you (01 R5 plist, SwiftPM dependency, build flag) */
  nextSteps: string[];
  /** true when nothing was written and nothing conflicts */
  ok: boolean;
}

/**
 * Path rewrites applied to every copied `.claude/**` template.
 *
 * The canonical skills and agents live in THIS repository and address its own tree
 * (`tools/app-map-mcp/bin/app-map`, `scripts/app-map/gen-ids`, the pilot's constants file). None of
 * those exist in an app repo, so an un-rewritten copy would send a specialist to a path that is not
 * there. `init.test.ts` asserts no scaffolded file still matches any `from` below.
 */
export const REWRITES: ReadonlyArray<{ from: RegExp; to: string }> = [
  // the CLI: `npx app-map` resolves the devDependency's bin with no network
  { from: /tools\/app-map-mcp\/bin\/app-map/g, to: 'npx app-map' },
  { from: /scripts\/app-map\/gen-ids/g, to: 'npx app-map gen-ids' },
  // the build/install hint in the session-start hook and the docs
  { from: /npm ci --prefix tools\/app-map-mcp && npm run build --prefix tools\/app-map-mcp/g, to: 'npm install' },
  { from: /npm (ci|test|run \w+) --prefix tools\/app-map-mcp/g, to: 'npm $1' },
  // Ajv ships with the installed package, so a consumer requires it from its own node_modules
  { from: /\.\/tools\/app-map-mcp\/node_modules\//g, to: './node_modules/' },
  { from: /tools\/app-map-mcp\/node_modules/g, to: 'node_modules' },
  // the fixtures and tests that pin all of this live upstream, not in the app repo
  { from: /tools\/app-map-mcp\/(fixtures|src\/test)\//g, to: 'https://github.com/kalub92/appmap/tree/main/tools/app-map-mcp/$1/' },
  { from: /anything under `app-map\/`, `instrumentation\/`, `node_modules\/`, /g, to: 'anything under `app-map/`, ' },
];

/** `AppMapID.swift`'s default location in THIS repo; rewritten to the app's own path. */
const PILOT_GENERATED_SWIFT = 'instrumentation/ios/AppMapKit/Sources/AppMapKit/AppMapID.swift';
const PILOT_GENERATED_KOTLIN = 'instrumentation/android/appmap/src/main/kotlin/com/example/appmap/AppMapId.kt';

/** Defaults for a repo that does not say otherwise. */
export const DEFAULT_GENERATED: Readonly<Record<Platform, string>> = {
  ios: 'AppMap/Generated/AppMapID.swift',
  android: 'appmap/src/main/kotlin/AppMapId.kt',
};

/**
 * Template sources, resolved from the packed `templates/` directory when installed and from this
 * repository's own tree when running from a checkout (`scripts/build-templates.mjs` copies the
 * second into the first at `prepack`). `templateRoots()` returns the first that exists.
 */
export function templateRoots(): { packed: string; repo: string } {
  return { packed: join(PACKAGE_ROOT, 'templates'), repo: resolve(PACKAGE_ROOT, '..', '..') };
}

/**
 * Resolve one template by its path relative to the repository root (e.g. `.claude/agents/x.md`).
 * Throws rather than scaffolding a repo with a file missing.
 */
export function templateFile(rel: string): string {
  const { packed, repo } = templateRoots();
  // `hooks/*` are authored for the consumer and live with the package, not in the repo's .claude/
  const roots = rel.startsWith('hooks/')
    ? [join(PACKAGE_ROOT, 'templates'), join(PACKAGE_ROOT, 'templates-src')]
    : [packed, repo];
  for (const root of roots) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  throw new AppMapError(
    ERROR_CODES.BAD_INPUT,
    `app-map template missing: ${rel}`,
    'the package was built without its templates; reinstall, or run scripts/build-templates.mjs in a checkout',
  );
}

/** Every `.claude/**` template `init` copies, as repository-relative paths. */
/** Shell scripts copied into the app repo's own `scripts/app-map/` (01 R6, 07 §2.3, 06 R5). */
export const CONSUMER_SCRIPTS: readonly string[] = ['router-export.sh', 'strings-export.sh', 'ci-params.sh'];

export const HOOK_SCRIPTS: readonly string[] = ['app-map-session-start.sh', 'app-map-record.sh', 'app-map-session-stop.sh'];

export function claudeTemplates(): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = templateFile(rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = `${rel}/${name}`;
      if (statSync(join(abs, name)).isDirectory()) walk(childRel);
      else out.push(childRel);
    }
  };
  walk('.claude/agents');
  walk('.claude/skills/app-nav');
  walk('.claude/skills/app-instrument');
  return out;
}

function applyRewrites(text: string, opts: Required<Pick<InitOptions, 'generatedSwift' | 'generatedKotlin'>>): string {
  let out = text;
  for (const { from, to } of REWRITES) out = out.replace(from, to);
  out = out.split(PILOT_GENERATED_SWIFT).join(opts.generatedSwift);
  out = out.split(PILOT_GENERATED_KOTLIN).join(opts.generatedKotlin);
  return out;
}

/** An empty registry that satisfies `ids.schema.json` and is already canonical (02 §2.3). */
export function emptyRegistry(): string {
  return canonicalYaml('ids', { schema_version: 1, screens: [], gates: [], elements: [] });
}

/** A manifest with placeholders the human fills; `build` fields stay quoted strings (issue #20). */
export function starterManifest(platform: Platform, appId: string, scheme: string, version: string): string {
  return canonicalYaml('manifest', {
    schema_version: 1,
    app_id: appId,
    platform,
    deep_link_scheme: scheme,
    build: { version: '0.0.0', build_number: '0', git_sha: '0000000' },
    generated_at: '1970-01-01T00:00:00Z',
    generator: `app-map-mcp@${version}`,
  });
}

/**
 * The allowlist for a scaffolded repo (07 §6). The app-map server is the installed package's entry
 * point, matched by `command` + `args`; argent keeps the pinned-npx form `policy-check` requires.
 * `reviewer` is deliberately the placeholder `unreviewed`: a human signs this off (07 §6), and
 * `init` must not forge an approval.
 */
export function starterAllowlist(version: string, today: string): string {
  return canonicalYaml('mcp-allowlist', {
    schema_version: 1,
    servers: [
      {
        name: 'app-map',
        source: 'in-repo',
        transport: 'stdio',
        command: 'node',
        args: [SERVER_ENTRY],
        version,
        reviewer: 'unreviewed',
        reviewed_at: today,
        notes: `Installed from ${PACKAGE_NAME}; version pinned by this repo's lockfile. Replace reviewer with the human who signed this off (07 §6).`,
      },
      {
        name: 'argent',
        source: 'npm',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@swmansion/argent@0.25.0'],
        package: '@swmansion/argent',
        version: '0.25.0',
        reviewer: 'unreviewed',
        reviewed_at: today,
        notes: 'Simulator driver. Proprietary binaries; record a security sign-off here and re-review on every bump (07 §5).',
      },
    ],
  });
}

/** The `.mcp.json` servers `init` adds. Existing entries of the same name are never touched. */
export function starterServers(platform: Platform): Record<string, unknown> {
  return {
    'app-map': {
      command: 'node',
      args: [`\${CLAUDE_PROJECT_DIR:-.}/${SERVER_ENTRY}`],
      env: {
        APP_MAP_DIR: '${CLAUDE_PROJECT_DIR:-.}/app-map',
        APP_MAP_PLATFORM: `\${APP_MAP_PLATFORM:-${platform}}`,
        APP_MAP_LOG_LEVEL: '${APP_MAP_LOG_LEVEL:-info}',
      },
    },
    argent: { command: 'npx', args: ['-y', '@swmansion/argent@0.25.0'] },
  };
}

/** The five hook entries of 05 §3, pointing at the scaffolded scripts. */
export function starterHooks(): Record<string, unknown> {
  const cmd = (script: string, timeout: number): unknown => ({
    hooks: [{ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/.claude/hooks/${script}`, timeout }],
  });
  const record = (matcher: string): unknown => ({ matcher, ...(cmd('app-map-record.sh', 5) as Record<string, unknown>) });
  return {
    SessionStart: [cmd('app-map-session-start.sh', 30)],
    PostToolUse: [record('mcp__argent__.*')],
    PostToolUseFailure: [record('mcp__argent__.*|mcp__app-map__.*')],
    Stop: [cmd('app-map-session-stop.sh', 60)],
    PreCompact: [cmd('app-map-session-start.sh', 30)],
  };
}

interface Writer {
  files: InitFileResult[];
  write(rel: string, content: string, mode?: number): void;
  appendLines(rel: string, lines: string[], header: string): void;
}

function makeWriter(target: string, force: boolean, dryRun: boolean): Writer {
  const files: InitFileResult[] = [];
  return {
    files,
    write(rel, content, mode) {
      const abs = join(target, rel);
      if (existsSync(abs)) {
        const current = readFileSync(abs, 'utf8');
        if (current === content) { files.push({ path: rel, action: 'unchanged' }); return; }
        if (!force) {
          files.push({ path: rel, action: 'conflict', note: 'differs from the template; re-run with --force to overwrite' });
          return;
        }
        if (!dryRun) writeFileSync(abs, content, mode === undefined ? undefined : { mode });
        files.push({ path: rel, action: 'updated' });
        return;
      }
      if (!dryRun) {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, mode === undefined ? undefined : { mode });
      }
      files.push({ path: rel, action: 'created' });
    },
    appendLines(rel, lines, header) {
      const abs = join(target, rel);
      const current = existsSync(abs) ? readFileSync(abs, 'utf8') : '';
      const missing = lines.filter((l) => !current.split('\n').some((c) => c.trim() === l.trim()));
      if (missing.length === 0) { files.push({ path: rel, action: 'unchanged' }); return; }
      const sep = current === '' || current.endsWith('\n') ? '' : '\n';
      const next = `${current}${sep}${current === '' ? '' : '\n'}${header}\n${missing.join('\n')}\n`;
      if (!dryRun) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, next); }
      files.push({ path: rel, action: current === '' ? 'created' : 'merged', note: `${missing.length} line(s) added` });
    },
  };
}

/** Merge `additions` into the JSON object at `rel`, never replacing a key that is already there. */
function mergeJson(
  target: string, rel: string, key: string, additions: Record<string, unknown>, writer: Writer, dryRun: boolean,
): void {
  const abs = join(target, rel);
  const existed = existsSync(abs);
  let doc: Record<string, unknown> = {};
  if (existed) {
    const text = readFileSync(abs, 'utf8');
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch (e) {
      writer.files.push({ path: rel, action: 'skipped', note: `not valid JSON (${(e as Error).message}); left untouched` });
      return;
    }
  }
  const section = (doc[key] ?? {}) as Record<string, unknown>;
  const added: string[] = [];
  const kept: string[] = [];
  for (const [name, value] of Object.entries(additions)) {
    if (section[name] === undefined) { section[name] = value; added.push(name); } else kept.push(name);
  }
  if (added.length === 0) {
    writer.files.push({ path: rel, action: 'unchanged', note: kept.length > 0 ? `already declares ${kept.join(', ')}` : undefined });
    return;
  }
  doc[key] = section;
  const next = `${JSON.stringify(doc, null, 2)}\n`;
  if (!dryRun) { mkdirSync(dirname(abs), { recursive: true }); writeFileSync(abs, next); }
  writer.files.push({
    path: rel,
    action: existed ? 'merged' : 'created',
    note: `added ${added.join(', ')}${kept.length > 0 ? `; kept existing ${kept.join(', ')}` : ''}`,
  });
}

/** Guess the app's source roots: the shallowest directories holding Swift or Kotlin sources. */
export function detectAppSrcDirs(target: string): string[] {
  const skip = new Set(['node_modules', '.git', 'build', '.build', 'dist', 'DerivedData', 'Pods', '.gradle', 'app-map', '.claude']);
  const found = new Set<string>();
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const abs = join(dir, name);
      let isDir: boolean;
      try { isDir = statSync(abs).isDirectory(); } catch { continue; }
      if (isDir) { walk(abs, depth + 1); continue; }
      if (/\.(swift|kt)$/.test(name)) {
        const rel = relative(target, dir).split('\\').join('/');
        if (rel !== '') found.add(rel);
      }
    }
  };
  walk(target, 0);
  // keep only the shallowest root of each tree
  const roots = [...found].sort();
  return roots.filter((r) => !roots.some((other) => other !== r && r.startsWith(`${other}/`)));
}

/** Scaffold `opts.target`. Pure apart from the writes, and writes nothing when `dryRun`. */
export function initRepo(opts: InitOptions): InitResult {
  const target = resolve(opts.target);
  if (!existsSync(target)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `target directory does not exist: ${target}`, 'create it, or pass --dir <path>');
  }
  const platform = opts.platform ?? 'ios';
  if (!PLATFORMS.includes(platform)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `--platform ${platform} is not one of ${PLATFORMS.join('|')}`, '');
  }
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;
  const version = opts.version ?? packageVersion();
  const generatedSwift = opts.generatedSwift ?? DEFAULT_GENERATED.ios;
  const generatedKotlin = opts.generatedKotlin ?? DEFAULT_GENERATED.android;
  const appSrcDirs = opts.appSrcDirs ?? (detectAppSrcDirs(target).length > 0 ? detectAppSrcDirs(target) : ['.']);
  const w = makeWriter(target, force, dryRun);

  // ---- the map skeleton (02 §2) --------------------------------------------------------------
  w.write('app-map/ids.yaml', emptyRegistry());
  for (const kind of SCHEMA_KINDS) {
    w.write(`app-map/schema/${kind}.schema.json`, readFileSync(templateFile(`app-map/schema/${kind}.schema.json`), 'utf8'));
  }
  w.write('app-map/policy/mcp-allowlist.yaml', starterAllowlist(version, '1970-01-01'));
  w.write(`app-map/${platform}/manifest.yaml`, starterManifest(platform, opts.appId ?? 'com.example.app', opts.scheme ?? 'appmap', version));
  w.write(`app-map/${platform}/screens/.gitkeep`, '');
  w.write(`app-map/${platform}/recipes/.gitkeep`, '');

  // ---- skills and agents (05 §4–§5.1), with the app-repo path rewrites -------------------------
  for (const rel of claudeTemplates()) {
    const text = applyRewrites(readFileSync(templateFile(rel), 'utf8'), { generatedSwift, generatedKotlin });
    w.write(rel, text);
  }
  // ---- the shell scripts a consuming repo runs itself (01 R6 router export, 07 §2.3 string
  // table, 06 R5 CI params). The references in the skills point at these paths.
  for (const name of CONSUMER_SCRIPTS) {
    w.write(`scripts/app-map/${name}`, readFileSync(templateFile(`scripts/app-map/${name}`), 'utf8'), 0o755);
  }
  // ---- hooks (05 §3): purpose-written for an installed package, not rewritten from this repo's
  // own scripts, which bootstrap a checkout (`npm ci --prefix`) that an app repo does not have.
  for (const name of HOOK_SCRIPTS) {
    w.write(`.claude/hooks/${name}`, readFileSync(templateFile(`hooks/${name}`), 'utf8'), 0o755);
  }

  // ---- harness configuration, merged never replaced -------------------------------------------
  mergeJson(target, '.mcp.json', 'mcpServers', starterServers(platform), w, dryRun);
  mergeJson(target, '.claude/settings.json', 'hooks', starterHooks(), w, dryRun);

  // ---- per-repo paths lint-ids cannot guess ---------------------------------------------------
  const config: RepoConfig = {
    platform,
    appSrcDirs,
    generated: { swift: generatedSwift, kotlin: generatedKotlin },
    instrumentedPlatforms: [platform],
  };
  w.write(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`);

  // ---- git hygiene -----------------------------------------------------------------------------
  w.appendLines('.gitignore', ['app-map/.local/', 'app-map/**/.local/', '.ci/maestro/'], '# app-map local state (never committed; 07 §2.4)');
  w.appendLines('.gitattributes', ['app-map/**/*.yaml   text eol=lf'], '# app-map canonical YAML is LF (02 §2.3)');

  const conflicts = w.files.filter((f) => f.action === 'conflict');
  return {
    target,
    platform,
    files: w.files,
    ok: conflicts.length === 0,
    nextSteps: nextSteps(platform, generatedSwift, appSrcDirs),
  };
}

function nextSteps(platform: Platform, generated: string, appSrcDirs: string[]): string[] {
  const steps = [
    `Install the package if you have not: npm i -D ${PACKAGE_NAME}`,
    'Fill app-map/<platform>/manifest.yaml: app_id is your bundle identifier (01 R6).',
    `Check app-map.config.json: appSrcDirs is ${JSON.stringify(appSrcDirs)} and the constants go to ${generated}.`,
    'Review app-map/policy/mcp-allowlist.yaml and replace reviewer: unreviewed with the human who signed it off (07 §6).',
    'Approve the two project-scoped MCP servers on your first Claude Code run in this repo (05 §2).',
  ];
  if (platform === 'ios') {
    steps.push(
      'Add AppMapKit to the app target as a Swift package dependency: https://github.com/kalub92/appmap at the tag matching this package version, product AppMapKit (01 §2).',
      'Add -D APP_MAP_DEBUG to the Debug configuration OTHER_SWIFT_FLAGS of every module that will hold app-map wiring or fixtures (01 §2).',
      'Register the appmap:// URL type in the Debug configuration Info.plist only (01 R5).',
    );
  }
  steps.push('Then run the app-instrument skill in a Claude Code session in this repo, or `npx app-map validate` to check the skeleton.');
  return steps;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Human-readable rendering of an `InitResult` for the CLI. */
export function formatInitResult(r: InitResult): string {
  const lines: string[] = [];
  const counts = new Map<FileAction, number>();
  for (const f of r.files) counts.set(f.action, (counts.get(f.action) ?? 0) + 1);
  for (const f of r.files) {
    if (f.action === 'unchanged') continue;
    lines.push(`  ${f.action.padEnd(9)} ${f.path}${f.note !== undefined ? `  — ${f.note}` : ''}`);
  }
  const summary = [...counts.entries()].map(([a, n]) => `${n} ${a}`).join(', ');
  const head = `app-map init — ${r.target} (${r.platform})\n${summary}`;
  const steps = r.nextSteps.map((s, i) => `  ${i + 1}. ${s}`).join('\n');
  const conflicts = r.files.filter((f) => f.action === 'conflict');
  const tail = conflicts.length > 0
    ? `\n\n${conflicts.length} file(s) differ from the template and were left alone; re-run with --force to overwrite them.`
    : '';
  return `${head}\n${lines.join('\n')}\n\nNext:\n${steps}${tail}`;
}
