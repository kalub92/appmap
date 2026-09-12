# Toolchain notes (for contributors and coding agents)

## Package: `tools/app-map-mcp`

- Node ≥ 22.13, ESM (`"type": "module"`), TypeScript 5.9 with `module: NodeNext`.
- **Imports between source files use the `.ts` extension** (`import { x } from './foo.ts'`).
  `rewriteRelativeImportExtensions` rewrites them to `.js` in `dist/`. `erasableSyntaxOnly`
  is on: no `enum`, no `namespace`, no parameter properties. Use `as const` objects + union types.
- `verbatimModuleSyntax` is on: use `import type { … }` for type-only imports.
- Run tests without building: `node --disable-warning=ExperimentalWarning --test "src/test/**/*.test.ts"`
  (Node type stripping). Test files live under `src/test/` and use `node:test` + `node:assert/strict`.
  Name them `<module>.test.ts`. Prefer fixtures under `tools/app-map-mcp/fixtures/`.
- Typecheck: `npx tsc -p tsconfig.json --noEmit`. Build: `npm run build` (→ `dist/`).
- Never `npx` a package at runtime (07 §5). Dependencies are pinned exactly in `package.json`.
- Scratch/temp files go outside the repo (`os.tmpdir()` in tests, never `app-map/.local` of the repo).

## SQLite

Use the built-in `node:sqlite` (`import { DatabaseSync } from 'node:sqlite'`). No native deps.
`db.exec('PRAGMA journal_mode=WAL')`, `db.prepare(sql).run/get/all`. The `ExperimentalWarning`
is suppressed with `--disable-warning=ExperimentalWarning` (already in `bin/app-map` and npm scripts).

## MCP SDK (`@modelcontextprotocol/sdk` 1.30.0, zod 4)

```ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'app-map', version: '0.1.0' });
server.registerTool('get_screen',
  { title: 'Get screen', description: '…', inputSchema: { screen_id: z.string() } },
  async ({ screen_id }) => ({ content: [{ type: 'text', text: '…' }] }));
server.registerResource('screen', new ResourceTemplate('app-map://{platform}/screens/{id}', { list: undefined }),
  { title: 'Screen YAML', mimeType: 'application/yaml' },
  async (uri, { platform, id }) => ({ contents: [{ uri: uri.href, mimeType: 'application/yaml', text: '…' }] }));
await server.connect(new StdioServerTransport());
```

- `inputSchema` is a zod *raw shape* (object of zod schemas), not `z.object(...)`.
- Tool errors: return `{ content: [{type:'text', text: JSON.stringify({error, hint})}], isError: true }` —
  never throw out of a tool handler (03 §11: the server never crashes the harness session).
- stdout is the MCP transport: **all logging goes to stderr or the log file**, never `console.log`.

## YAML

`yaml` 2.9: `parse`, `stringify`. Canonical form (02 §2.3) is produced by our own serializer in
`src/yaml/canonical.ts` (fixed key order, `id`-sorted lists, block style, 2-space indent, LF).

## Local git hooks

```sh
git config core.hooksPath scripts/app-map/githooks   # 01 R8: lint-ids + validate + gen-ids --check
git config merge.app-map-yaml.name   "app-map semantic YAML merge (02 §9)"
git config merge.app-map-yaml.driver "tools/app-map-mcp/bin/app-map merge-driver %O %A %B %P"
```

Both are opt-in per clone: git runs neither a hooks path nor a merge driver it has not been told
about. CI enforces the same checks (06 R1/R2), so a clone without them is never unsafe, only slower
to find out.

## JSON Schema

Ajv 8 (draft-07) + ajv-formats. Schemas live in `app-map/schema/*.schema.json` and are the
single source of truth for `app-map validate`; TypeScript types in `src/types.ts` mirror them.
