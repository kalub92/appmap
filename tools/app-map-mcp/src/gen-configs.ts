/**
 * [D2] `app-map gen-configs [--check]` (05 §2, 06 R2): derive `.cursor/mcp.json` and
 * `.codex/config.toml` from the committed `.mcp.json`.
 *
 * - `.cursor/mcp.json`: the same JSON object (`mcpServers` key), pretty-printed 2 spaces + LF.
 * - `.codex/config.toml`: one `[mcp_servers.<name>]` table per server with `command`, `args`
 *   (TOML array) and `[mcp_servers.<name>.env]` for `env`; `${VAR:-default}` placeholders are
 *   copied verbatim (Codex expands them the same way); servers in name order; LF.
 * - `--check`: regenerate to memory and compare byte-for-byte; `stale` lists mismatches and the
 *   CLI exits 1 (06 R2).
 * Never writes secrets: `.mcp.json` must contain only `${VAR}` references (policy-check.ts).
 *
 * Layer: top (imports errors/types only).
 */
import type { GenConfigsResult } from './types.ts';
import { NotImplementedError } from './errors.ts';

export interface McpJson {
  mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> }>;
}

export const GENERATED_FILES = { cursor: '.cursor/mcp.json', codex: '.codex/config.toml' } as const;

export function genConfigs(repoRoot: string, opts: { check?: boolean; mcpJsonPath?: string } = {}): GenConfigsResult {
  void repoRoot; void opts;
  throw new NotImplementedError('gen-configs.genConfigs');
}

/** Pure. */
export function cursorConfigFromMcp(mcp: McpJson): string {
  void mcp;
  throw new NotImplementedError('gen-configs.cursorConfigFromMcp');
}

/** Pure. */
export function codexTomlFromMcp(mcp: McpJson): string {
  void mcp;
  throw new NotImplementedError('gen-configs.codexTomlFromMcp');
}

/** Pure: parse + shape-check `.mcp.json` (throws `bad_input`). */
export function parseMcpJson(text: string): McpJson {
  void text;
  throw new NotImplementedError('gen-configs.parseMcpJson');
}
