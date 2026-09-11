/**
 * [D1] stdio entry point launched by `.mcp.json` (05 §2): `node tools/app-map-mcp/dist/index.js`.
 *
 * `loadConfig(process.env)` → `startServer(config)`. Any startup failure is written as one
 * JSON line to stderr and the process exits 1 — never to stdout (the MCP transport).
 *
 * Layer: top.
 */
import { NotImplementedError } from './errors.ts';

export async function main(): Promise<void> {
  throw new NotImplementedError('index.main');
}

// Only auto-run when executed directly (not when imported by tests).
if (process.argv[1] && /(^|[/\\])index\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e: unknown) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'app-map server failed to start', error: String(e) })}\n`);
    process.exit(1);
  });
}
