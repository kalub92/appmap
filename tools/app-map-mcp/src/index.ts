/**
 * [D1] stdio entry point launched by `.mcp.json` (05 §2): `node tools/app-map-mcp/dist/index.js`.
 *
 * `loadConfig(process.env)` → `startServer(config)`. Any startup failure is written as one
 * JSON line to stderr and the process exits 1 — never to stdout (the MCP transport).
 *
 * Layer: top.
 */
import { loadConfig } from './config.ts';
import { startServer } from './server.ts';
import type { RunningServer } from './server.ts';

/**
 * Start the server and resolve once it is serving. The returned promise stays resolved while
 * the stdio transport keeps the process alive; `close()` is wired to SIGINT/SIGTERM inside
 * `startServer` (03 §2: the ingest socket is removed on exit).
 */
export async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const running: RunningServer = await startServer(config);
  // nothing is printed on stdout: it is the MCP transport (docs/dev/toolchain.md)
  void running;
}

// Only auto-run when executed directly (not when imported by tests).
if (process.argv[1] && /(^|[/\\])index\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'app-map server failed to start', error: String(e) })}\n`);
    process.exit(1);
  });
}
