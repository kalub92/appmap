/**
 * [D2] `app-map policy-check` (06 R3, 07 §5, 07 §6). Parses `.mcp.json`, `.cursor/mcp.json`,
 * `.codex/config.toml` (minimal TOML reader for `[mcp_servers.*]` tables) and
 * `.claude/settings.json`; fails when:
 *  - `unlisted_server`: a server name is not in `app-map/policy/mcp-allowlist.yaml`, or its
 *    pinned version/package differs from the allowlist entry;
 *  - `unpinned_npx`: any `command` is `npx` (or args contain `npx`) without an exact
 *    `<pkg>@<x.y.z>` pin (`-y` allowed; `@latest`, ranges and bare names fail);
 *  - `secret_literal`: a value in `env`, `headers` or `url` that looks like a token/secret
 *    (`SECRET_PATTERNS`: AWS keys, `sk-…`, `ghp_…`, `xox[abp]-…`, JWT-shaped, 32+ hex/base64 runs,
 *    `Bearer …`, `password=`); `${VAR}` references are fine;
 *  - `hook_outside_dir`: a hook `command` in `.claude/settings.json` that does not resolve under
 *    `.claude/hooks/` (after `$CLAUDE_PROJECT_DIR` substitution).
 * Exit 1 with every violation listed (06 §4).
 *
 * Layer: top (imports yaml/load.readAllowlist, types).
 */
import type { McpAllowlist, PolicyCheckResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

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

export function policyCheck(repoRoot: string, opts: PolicyCheckOptions = {}): PolicyCheckResult {
  void repoRoot; void opts;
  throw new NotImplementedError('policy-check.policyCheck');
}

/** Pure: is `args` an exactly pinned npx invocation (`@scope/pkg@1.2.3`)? */
export function isPinnedNpx(command: string, args: readonly string[]): boolean {
  void command; void args;
  throw new NotImplementedError('policy-check.isPinnedNpx');
}

/** Pure: does a config value look like a secret literal (not a `${VAR}` reference)? */
export function looksLikeSecret(value: string): boolean {
  void value;
  throw new NotImplementedError('policy-check.looksLikeSecret');
}

/** Pure: minimal TOML → `{ mcp_servers: { name: { command, args, env } } }` for the generated Codex file. */
export function parseCodexToml(text: string): Record<string, { command?: string; args?: string[]; env?: Record<string, string>; url?: string }> {
  void text;
  throw new NotImplementedError('policy-check.parseCodexToml');
}
