/**
 * [D2] `app-map policy-check` (06 R3, 07 §5, 07 §6). Parses `.mcp.json`, `.cursor/mcp.json`,
 * `.codex/config.toml` (minimal TOML reader for `[mcp_servers.*]` tables) and
 * `.claude/settings.json`; fails when:
 *  - `unlisted_server`: a server name is not in `app-map/policy/mcp-allowlist.yaml`, or its
 *    pinned version/package differs from the allowlist entry — an `npx` server matches on
 *    `<package>@<version>` (the allowlist schema requires `package` for `source: npm`), an
 *    in-repo server on `command` + `args`;
 *  - `unpinned_npx`: any `command` is `npx` (or args contain `npx`) without an exact
 *    `<pkg>@<x.y.z>` pin (`-y` allowed; `@latest`, ranges and bare names fail);
 *  - `secret_literal`: a value in `env`, `headers` or `url` that looks like a token/secret
 *    (`SECRET_PATTERNS`: AWS keys, `sk-…`, `ghp_…`, `xox[abp]-…`, JWT-shaped, 32+ hex/base64 runs,
 *    `Bearer …`, `password=`); `${VAR}` references are fine;
 *  - `hook_outside_dir`: a hook `command` in `.claude/settings.json` that does not resolve under
 *    `.claude/hooks/` (after `$CLAUDE_PROJECT_DIR` substitution).
 * Exit 1 with every violation listed (06 §4).
 *
 * Also home of `intentCriticalDiff` (07 §4, 07 §7): `app-map intent-critical-diff <base-ref>`
 * compares `app-map/ids.yaml` and every screen/recipe file between `<base-ref>` (`git show
 * <ref>:<path>`) and the working tree, reporting ids whose `intent_critical` was downgraded
 * `true → false` (two approvals required), upgraded, and every intent_critical element whose
 * screen element or recipe step changed — as data plus a markdown table for the bot comment.
 *
 * Layer: top (imports yaml/load.readAllowlist, types).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  AllowlistServer, ElementId, IdsRegistry, IntentCriticalDiffResult, McpAllowlist, PolicyCheckResult, RecipeFile, ScreenFile,
} from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import { readAllowlist } from './yaml/load.ts';
import { parseYamlText } from './yaml/canonical.ts';
import { parseMcpJson } from './gen-configs.ts';

export const SECRET_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bxox[abp]-[A-Za-z0-9-]{10,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._-]{16,}/i,
  /(?:password|passwd|secret|token)\s*=\s*[^$\s]{6,}/i,
  /\b[0-9a-f]{32,}\b/i,
];

export interface PolicyCheckOptions {
  /** default: `readAllowlist(config)` from `<repoRoot>/app-map` */
  allowlist?: McpAllowlist;
  /** files to parse, relative to repoRoot (defaults listed above; missing files are skipped) */
  files?: string[];
}

/** 06 R3: the four files the policy job parses. */
export const POLICY_FILES: readonly string[] = ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml', '.claude/settings.json'];

/** `.claude/hooks/` — the only directory a hook command may live in (06 R3, 07 §5.2). */
export const HOOKS_DIR = join('.claude', 'hooks');

/** exact `<pkg>@<x.y.z>` (optionally scoped, optionally a prerelease tag); ranges and `latest` fail */
const EXACT_NPX_SPEC = /^(@[a-z0-9~][a-z0-9-._~]*\/)?[a-z0-9~][a-z0-9-._~]*@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** `npx` flags that take a separate value; the token after them is still the package spec for `-p`/`--package`. */
const NPX_SPEC_FLAGS = new Set(['-p', '--package']);

type ParsedServer = { command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };

export function policyCheck(repoRoot: string, opts: PolicyCheckOptions = {}): PolicyCheckResult {
  const allowlist = opts.allowlist ?? readAllowlist({ dir: join(repoRoot, 'app-map') });
  const byName = new Map<string, AllowlistServer>(allowlist.servers.map((s) => [s.name, s]));
  const violations: PolicyCheckResult['violations'] = [];
  const add = (rule: PolicyCheckResult['violations'][number]['rule'], file: string, message: string): void => {
    violations.push({ rule, file, message });
  };

  for (const rel of opts.files ?? POLICY_FILES) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue; // missing generated/optional file is not a policy failure (gen-configs --check covers it)
    const text = readFileSync(abs, 'utf8');
    if (rel.endsWith('.claude/settings.json') || basename(rel) === 'settings.json') {
      for (const { command, event } of hookCommands(text, rel)) {
        if (!isInsideHooksDir(repoRoot, command)) {
          add('hook_outside_dir', rel, `hook ${event} runs \`${command}\`, which does not resolve under ${HOOKS_DIR}/`);
        }
      }
      continue;
    }
    let servers: Record<string, ParsedServer>;
    try {
      servers = rel.endsWith('.toml') ? parseCodexToml(text) : (parseMcpJson(text).mcpServers as Record<string, ParsedServer>);
    } catch (e) {
      // a malformed config is not one of the four 06 R3 rules; surface it as bad_input naming the file
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `${rel}: ${(e as Error).message}`, 'fix the file, then rerun app-map policy-check');
    }
    for (const [name, server] of Object.entries(servers)) {
      checkServer({ rel, name, server, byName, add });
    }
  }
  return { ok: violations.length === 0, violations };
}

function checkServer(input: {
  rel: string;
  name: string;
  server: ParsedServer;
  byName: ReadonlyMap<string, AllowlistServer>;
  add: (rule: PolicyCheckResult['violations'][number]['rule'], file: string, message: string) => void;
}): void {
  const { rel, name, server, byName, add } = input;
  const command = server.command ?? '';
  const args = server.args ?? [];

  // --- 06 R3.1 allowlist -------------------------------------------------------------------
  const entry = byName.get(name);
  if (entry === undefined) {
    add('unlisted_server', rel, `server "${name}" is not in app-map/policy/mcp-allowlist.yaml (07 §6)`);
  } else {
    const mismatch = allowlistMismatch(entry, command, args);
    if (mismatch !== undefined) add('unlisted_server', rel, `server "${name}" ${mismatch}`);
  }

  // --- 06 R3.2 npx pin ---------------------------------------------------------------------
  if (usesNpx(command, args) && !isPinnedNpx(command, args)) {
    add('unpinned_npx', rel, `server "${name}" runs npx without an exact <pkg>@<x.y.z> pin (07 §5.1)`);
  }

  // --- 06 R3.3 secrets ---------------------------------------------------------------------
  for (const [key, value] of Object.entries(server.env ?? {})) {
    if (looksLikeSecret(value)) add('secret_literal', rel, `server "${name}" env.${key} looks like a literal secret (use \${VAR}, 07 §2.3.5)`);
  }
  for (const [key, value] of Object.entries(server.headers ?? {})) {
    if (looksLikeSecret(value)) add('secret_literal', rel, `server "${name}" headers.${key} looks like a literal secret (use \${VAR}, 07 §2.3.5)`);
  }
  if (server.url !== undefined && looksLikeSecret(server.url)) {
    add('secret_literal', rel, `server "${name}" url carries a literal secret (07 §2.3.5)`);
  }
}

/**
 * Why a server does not match its allowlist entry, or `undefined` when it does. npm entries match
 * on `<package>@<version>` appearing in the invocation; in-repo/binary entries on `command` plus
 * `args` (after `${VAR}`/leading-`./` normalization, since `.mcp.json` prefixes
 * `${CLAUDE_PROJECT_DIR:-.}`).
 */
function allowlistMismatch(entry: AllowlistServer, command: string, args: readonly string[]): string | undefined {
  if (entry.source === 'npm') {
    if (entry.package === undefined) return undefined; // schema requires it; nothing to compare against
    const want = `${entry.package}@${entry.version}`;
    const tokens = [command, ...args].flatMap((a) => a.split(/\s+/));
    if (!tokens.includes(want)) return `does not run the approved package ${want} (07 §6)`;
    return undefined;
  }
  if (entry.command !== undefined && normalizeArg(entry.command) !== normalizeArg(command)) {
    return `runs "${command}" but the allowlist approved "${entry.command}"`;
  }
  if (entry.args !== undefined) {
    const want = entry.args.map(normalizeArg);
    const got = args.map(normalizeArg);
    if (want.length !== got.length || want.some((a, i) => a !== got[i])) {
      return `runs args ${JSON.stringify(args)} but the allowlist approved ${JSON.stringify(entry.args)}`;
    }
  }
  return undefined;
}

/** drop `${VAR}` / `${VAR:-default}` placeholders and leading `./`, so `${CLAUDE_PROJECT_DIR:-.}/x` === `x` */
function normalizeArg(arg: string): string {
  return arg.replace(/\$\{[^}]*\}/g, '').replace(/^[.\/]+/, '');
}

function usesNpx(command: string, args: readonly string[]): boolean {
  if (basename(command) === 'npx') return true;
  return args.some((a) => a.split(/\s+/).some((t) => basename(t) === 'npx'));
}

/**
 * Pure: is `args` an exactly pinned npx invocation (`@scope/pkg@1.2.3`)? Returns `true` when the
 * invocation is not an npx invocation at all (nothing to pin) so callers can guard with `usesNpx`.
 */
export function isPinnedNpx(command: string, args: readonly string[]): boolean {
  const tokens = npxTokens(command, args);
  if (tokens === undefined) return true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (NPX_SPEC_FLAGS.has(t)) {
      const spec = tokens[i + 1];
      return spec !== undefined && EXACT_NPX_SPEC.test(spec);
    }
    if (t.startsWith('-')) continue; // -y / --yes / -q …
    return EXACT_NPX_SPEC.test(t);
  }
  return false; // `npx` with no package spec at all
}

/** the tokens following the `npx` token, or `undefined` when npx is not invoked */
function npxTokens(command: string, args: readonly string[]): string[] | undefined {
  const flat = [...args].flatMap((a) => a.split(/\s+/)).filter((t) => t.length > 0);
  if (basename(command) === 'npx') return flat;
  const idx = flat.findIndex((t) => basename(t) === 'npx');
  return idx < 0 ? undefined : flat.slice(idx + 1);
}

/** Pure: does a config value look like a secret literal (not a `${VAR}` reference)? */
export function looksLikeSecret(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  // `${VAR}` / `${VAR:-default}` references are the approved way to pass a secret (05 §2)
  const withoutRefs = value.replace(/\$\{[^}]*\}/g, '').replace(/\$[A-Za-z_][A-Za-z0-9_]*/g, '');
  if (withoutRefs.trim().length === 0) return false;
  return SECRET_PATTERNS.some((re) => re.test(withoutRefs));
}

/** Pure: minimal TOML → `{ mcp_servers: { name: { command, args, env } } }` for the generated Codex file. */
export function parseCodexToml(text: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> {
  const out: Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> = {};
  let server: string | undefined;
  let section: 'root' | 'env' | 'other' = 'other';
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const parts = splitTomlKeyPath(header[1]!);
      if (parts.length >= 2 && parts[0] === 'mcp_servers') {
        server = parts[1]!;
        section = parts.length === 2 ? 'root' : parts[2] === 'env' ? 'env' : 'other';
        out[server] ??= {};
      } else {
        server = undefined;
        section = 'other';
      }
      continue;
    }
    if (server === undefined || section === 'other') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = unquoteTomlKey(line.slice(0, eq).trim());
    const value = line.slice(eq + 1).trim();
    const target = out[server]!;
    if (section === 'env') {
      const s = parseTomlScalar(value);
      if (s !== undefined) (target.env ??= {})[key] = s;
      continue;
    }
    if (key === 'command') {
      const s = parseTomlScalar(value);
      if (s !== undefined) target.command = s;
    } else if (key === 'url') {
      const s = parseTomlScalar(value);
      if (s !== undefined) target.url = s;
    } else if (key === 'args') {
      target.args = parseTomlArray(value);
    }
  }
  return out;
}

function splitTomlKeyPath(path: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < path.length; i++) {
    const c = path[i]!;
    if (c === '"') { inQuote = !inQuote; continue; }
    if (c === '.' && !inQuote) { parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter((p) => p.length > 0);
}

function unquoteTomlKey(key: string): string {
  return key.startsWith('"') && key.endsWith('"') && key.length >= 2 ? unescapeTomlString(key.slice(1, -1)) : key;
}

function parseTomlScalar(value: string): string | undefined {
  const m = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (m !== null) return unescapeTomlString(m[1]!);
  const single = /^'([^']*)'/.exec(value);
  if (single !== null) return single[1]!;
  return undefined;
}

function parseTomlArray(value: string): string[] {
  const inner = /^\[([\s\S]*)\]/.exec(value);
  if (inner === null) return [];
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(inner[1]!)) !== null) out.push(m[1] !== undefined ? unescapeTomlString(m[1]) : m[2]!);
  return out;
}

function unescapeTomlString(s: string): string {
  return s.replace(/\\(["\\nrt])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c));
}

// ---------------------------------------------------------------------------------------------
// .claude/settings.json hooks (06 R3.4, 07 §5.2)
// ---------------------------------------------------------------------------------------------

function hookCommands(text: string, file: string): Array<{ event: string; command: string }> {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `${file} is not valid JSON: ${(e as Error).message}`, 'fix the JSON syntax');
  }
  const hooks = (doc as { hooks?: unknown } | null)?.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) return [];
  const out: Array<{ event: string; command: string }> = [];
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const inner = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const hook of inner) {
        const h = hook as { type?: unknown; command?: unknown } | null;
        if (h === null || h.type !== 'command' || typeof h.command !== 'string') continue;
        out.push({ event, command: h.command });
      }
    }
  }
  return out;
}

/** `"$CLAUDE_PROJECT_DIR"/.claude/hooks/x.sh` → does the executable resolve under `<repoRoot>/.claude/hooks/`? */
function isInsideHooksDir(repoRoot: string, command: string): boolean {
  const substituted = command
    .replace(/\$\{CLAUDE_PROJECT_DIR(?::-[^}]*)?\}/g, repoRoot)
    .replace(/\$CLAUDE_PROJECT_DIR/g, repoRoot)
    .replace(/["']/g, '');
  const executable = substituted.trim().split(/\s+/)[0] ?? '';
  if (executable.length === 0) return false;
  const abs = isAbsolute(executable) ? resolve(executable) : resolve(repoRoot, executable);
  const rel = relative(resolve(repoRoot, HOOKS_DIR), abs);
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..');
}

// ---------------------------------------------------------------------------------------------
// intent-critical diff (07 §4, 07 §7)
// ---------------------------------------------------------------------------------------------

export interface IntentCriticalDiffOptions {
  /** `git show` runner (injectable for tests): returns the file text at `ref`, or `undefined` when absent */
  readAtRef?: (ref: string, relPath: string) => string | undefined;
  /** map dir relative to repoRoot (default `app-map`) */
  mapDir?: string;
}

/** 07 §4 / 07 §7 — see module doc. Never throws for a missing base file (treated as empty). */
export function intentCriticalDiff(repoRoot: string, baseRef: string, opts: IntentCriticalDiffOptions = {}): IntentCriticalDiffResult {
  const mapDir = opts.mapDir ?? 'app-map';
  const readAtRef = opts.readAtRef ?? gitShow(repoRoot);
  const idsRel = `${mapDir}/ids.yaml`;

  const baseIds = intentCriticalMap(safeParse<IdsRegistry>(readAtRef(baseRef, idsRel), idsRel));
  const headIds = intentCriticalMap(safeParse<IdsRegistry>(readIfExists(join(repoRoot, idsRel)), idsRel));

  const downgraded: ElementId[] = [];
  const upgraded: ElementId[] = [];
  for (const [id, head] of headIds) {
    const base = baseIds.get(id) === true;
    if (base && !head) downgraded.push(id);
    if (!base && head) upgraded.push(id);
  }
  downgraded.sort();
  upgraded.sort();

  // Every intent_critical element whose screen element or recipe step changed in this diff (07 §4).
  const critical = new Set<ElementId>([...headIds.entries()].filter(([, v]) => v).map(([k]) => k));
  for (const [id, v] of baseIds) if (v) critical.add(id);
  const touched: IntentCriticalDiffResult['touched'] = [];
  for (const rel of mapEntityFiles(repoRoot, mapDir)) {
    const headText = readIfExists(join(repoRoot, rel));
    const baseText = readAtRef(baseRef, rel);
    if (headText === baseText) continue;
    const headDoc = safeParse<ScreenFile | RecipeFile>(headText, rel);
    const baseDoc = safeParse<ScreenFile | RecipeFile>(baseText, rel);
    for (const id of entityIntentCriticalIds(headDoc, critical)) {
      if (JSON.stringify(entityFragment(headDoc, id)) === JSON.stringify(entityFragment(baseDoc, id))) continue;
      touched.push({ element: id, file: rel });
    }
  }
  touched.sort((a, b) => (a.file === b.file ? a.element.localeCompare(b.element) : a.file.localeCompare(b.file)));

  return { base_ref: baseRef, downgraded, upgraded, touched, markdown: intentCriticalMarkdown(baseRef, downgraded, upgraded, touched, idsRel) };
}

function intentCriticalMarkdown(baseRef: string, downgraded: ElementId[], upgraded: ElementId[], touched: IntentCriticalDiffResult['touched'], idsRel: string): string {
  const rows: string[] = [];
  for (const id of downgraded) rows.push(`| \`${id}\` | downgraded (\`intent_critical: true → false\`) | \`${idsRel}\` | two approvals (07 §7) |`);
  for (const id of upgraded) rows.push(`| \`${id}\` | upgraded (\`intent_critical: false → true\`) | \`${idsRel}\` | — |`);
  for (const t of touched) rows.push(`| \`${t.element}\` | touched | \`${t.file}\` | review the locator/step change (07 §4) |`);
  if (rows.length === 0) return `No \`intent_critical\` changes against \`${baseRef}\`.`;
  return [
    `### intent_critical changes against \`${baseRef}\``,
    '',
    '| element | change | file | action |',
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/** `git show <ref>:<path>`; `undefined` when the path does not exist at that ref (07 §4). */
function gitShow(repoRoot: string): (ref: string, relPath: string) => string | undefined {
  return (ref, relPath) => {
    const r = spawnSync('git', ['show', `${ref}:${relPath}`], { cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.error !== undefined || r.status !== 0) return undefined;
    return r.stdout;
  };
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function safeParse<T>(text: string | undefined, file: string): T | undefined {
  if (text === undefined) return undefined;
  try {
    return parseYamlText<T>(text, file);
  } catch {
    return undefined; // a malformed base file is treated as absent (never throws, per the JSDoc)
  }
}

/** registered id → `intent_critical` (absent means false, architecture decision 26) */
function intentCriticalMap(ids: IdsRegistry | undefined): Map<ElementId, boolean> {
  const out = new Map<ElementId, boolean>();
  for (const e of ids?.elements ?? []) {
    if (typeof e?.id === 'string') out.set(e.id, e.intent_critical === true);
  }
  return out;
}

/** every `<mapDir>/<platform>/{screens,recipes}/*.yaml` present in the working tree */
function mapEntityFiles(repoRoot: string, mapDir: string): string[] {
  const out: string[] = [];
  const root = join(repoRoot, mapDir);
  if (!existsSync(root)) return out;
  for (const platform of readdirSync(root, { withFileTypes: true })) {
    if (!platform.isDirectory() || platform.name === '.local' || platform.name === 'schema' || platform.name === 'policy') continue;
    for (const sub of ['screens', 'recipes']) {
      const dir = join(root, platform.name, sub);
      if (!existsSync(dir)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.yaml')) out.push(`${mapDir}/${platform.name}/${sub}/${f}`);
      }
    }
  }
  return out.sort();
}

/** intent_critical ids declared or referenced by a screen file or a recipe file */
function entityIntentCriticalIds(doc: ScreenFile | RecipeFile | undefined, registryCritical: ReadonlySet<ElementId>): ElementId[] {
  if (doc === undefined) return [];
  const out = new Set<ElementId>();
  if ('elements' in doc && Array.isArray(doc.elements)) {
    for (const el of doc.elements) {
      if (typeof el?.id !== 'string') continue;
      if (el.intent_critical === true || registryCritical.has(el.id)) out.add(el.id);
    }
  }
  if ('steps' in doc && Array.isArray(doc.steps)) {
    for (const step of doc.steps) {
      const id = (step as { element?: unknown; list?: unknown }).element ?? (step as { list?: unknown }).list;
      if (typeof id !== 'string') continue;
      if ((step as { intent_critical?: unknown }).intent_critical === true || registryCritical.has(id)) out.add(id);
    }
  }
  return [...out].sort();
}

/** the part of a screen/recipe file that concerns one element, for the "changed?" comparison */
function entityFragment(doc: ScreenFile | RecipeFile | undefined, id: ElementId): unknown {
  if (doc === undefined) return undefined;
  const parts: unknown[] = [];
  if ('elements' in doc && Array.isArray(doc.elements)) parts.push(...doc.elements.filter((e) => e?.id === id));
  if ('steps' in doc && Array.isArray(doc.steps)) {
    parts.push(...doc.steps.filter((s) => (s as { element?: unknown }).element === id || (s as { list?: unknown }).list === id));
  }
  return parts.length > 0 ? parts : undefined;
}
