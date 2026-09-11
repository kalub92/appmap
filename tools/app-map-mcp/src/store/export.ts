/**
 * [A2] `app-map export [--force] [--check]` (02 §2.2–2.3, 03 §4 write path, 03 §8 `export`
 * tool, 05 §3 Stop hook, 06 R1).
 *
 * - Writes every `dirty` screen/recipe from the cache to its YAML file in canonical form
 *   (yaml/canonical.ts) and clears the dirty flag. Volatile counters never leave SQLite.
 * - Only durable fields are written: structure, locators, status, provenance,
 *   `last_verified_build`; `manifest.generated_at` is the only timestamp and is refreshed only
 *   when the manifest itself changes (build bump via import-router).
 * - Conflict safety: before overwriting, compare the file's current git blob hash
 *   (yaml/load.gitBlobHash) with the `blob_sha` recorded at load (`ctx.map.files`, mirrored in
 *   `db.getBlobSha`); if it differs, the file is listed in `conflicts` with a unified diff and
 *   NOT written unless `force`. A file that was never loaded (new screen) has no recorded sha
 *   and is written only if it does not exist on disk (else conflict).
 * - Dirty kinds: `screen`, `recipe`, `ids` (import-router registered screens, 06 R7) and
 *   `manifest` (build refresh). Paths come from paths.ts for `ctx.config.platform`.
 * - `check`: reload every YAML, re-serialize canonically, report `non_canonical` paths; writes
 *   nothing (06 R1). Exit code for the CLI: 1 when `conflicts` or `non_canonical` is non-empty.
 * - Idempotent: a second export writes nothing (02 §11).
 *
 * Layer: store (imports context types + yaml/*).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppMapContext } from '../context.ts';
import type { Platform } from '../config.ts';
import type { ExportResult, IdsRegistry, Manifest, RecipeFile, ScreenFile } from '../types.ts';
import { now } from '../types.ts';
import type { YamlKind } from '../paths.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { gitBlobHash } from '../yaml/load.ts';
import { nonCanonicalFiles } from '../validate.ts';
import type { DirtyKind, DirtyRow } from './db.ts';

export interface ExportOptions {
  force?: boolean;
  check?: boolean;
  /** compute the result without touching disk */
  dryRun?: boolean;
}

/** relative path (forward slashes, the `LoadedMap.files` key) of a dirty entity */
export function relPathFor(platform: Platform, kind: DirtyKind, key: string): string {
  switch (kind) {
    case 'screen': return `${platform}/screens/${key}.yaml`;
    case 'recipe': return `${platform}/recipes/${key}.yaml`;
    case 'manifest': return `${platform}/manifest.yaml`;
    case 'ids': return 'ids.yaml';
  }
}

/** git's blob id of the text we are about to write (`git hash-object --stdin`) */
function blobShaOfText(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** the cached entity behind a dirty row, or `undefined` when it was deleted since (purge) */
function loadEntity(ctx: AppMapContext, row: DirtyRow): { kind: YamlKind; entity: unknown } | undefined {
  switch (row.kind) {
    case 'screen': {
      const screen = ctx.db.getScreen(row.key);
      return screen ? { kind: 'screen', entity: screen } : undefined;
    }
    case 'recipe': {
      const recipe = ctx.db.getRecipe(row.key);
      return recipe ? { kind: 'recipe', entity: recipe } : undefined;
    }
    case 'ids': {
      const ids = ctx.db.getIds();
      return ids ? { kind: 'ids', entity: ids } : undefined;
    }
    case 'manifest': {
      const manifest = ctx.db.getManifest();
      return manifest ? { kind: 'manifest', entity: manifest } : undefined;
    }
  }
}

export function exportMap(ctx: AppMapContext, opts: ExportOptions = {}): ExportResult {
  const result: ExportResult = { written: [], unchanged: [], conflicts: [], non_canonical: [] };
  if (opts.check) {
    // 06 R1: every YAML must already be canonical; nothing is written in check mode
    result.non_canonical = nonCanonicalFiles(ctx.config);
    return result;
  }
  const platform = ctx.config.platform;
  const dryRun = opts.dryRun === true;
  for (const row of ctx.db.listDirty()) {
    const loaded = loadEntity(ctx, row);
    if (!loaded) {
      // the entity was deleted from the cache after being marked (purge); nothing to write
      if (!dryRun) ctx.db.clearDirty(row.kind, row.key);
      continue;
    }
    const rel = relPathFor(platform, row.kind, row.key);
    const abs = join(ctx.config.dir, rel);
    const current = gitBlobHash(abs); // undefined when the file does not exist
    let entity = loaded.entity;
    let text = canonicalYaml(loaded.kind, entity);

    if (current !== undefined && current === blobShaOfText(text)) {
      // disk already holds exactly what we would write — idempotent second export (02 §11)
      result.unchanged.push(rel);
      if (!dryRun) {
        ctx.db.clearDirty(row.kind, row.key);
        ctx.db.setBlobSha(row.kind, row.key, current);
      }
      continue;
    }

    if (row.kind === 'manifest') {
      // `generated_at` is the only timestamp in the map and moves only when the manifest itself
      // changes (02 §2.3, architecture §3 rule 5) — which is exactly the case here
      const stamped: Manifest = { ...(entity as Manifest), generated_at: now() };
      entity = stamped;
      text = canonicalYaml('manifest', stamped);
      if (current !== undefined && current === blobShaOfText(text)) {
        result.unchanged.push(rel);
        if (!dryRun) {
          ctx.db.clearDirty(row.kind, row.key);
          ctx.db.setBlobSha(row.kind, row.key, current);
        }
        continue;
      }
    }

    // 03 §4 conflict safety: the sha recorded at load (db row, else the in-memory map)
    const recorded = ctx.db.getBlobSha(row.kind, row.key) ?? ctx.map.files.get(rel)?.blob_sha;
    if (!opts.force) {
      let conflict: string | undefined;
      if (recorded === undefined && current !== undefined) conflict = `${rel} exists on disk but was never loaded by this process`;
      else if (recorded !== undefined && current === undefined) conflict = `${rel} was deleted on disk since it was loaded`;
      else if (recorded !== undefined && current !== undefined && recorded !== current) conflict = `${rel} changed on disk since it was loaded`;
      if (conflict !== undefined) {
        const onDisk = current === undefined ? '' : readFileSync(abs, 'utf8');
        result.conflicts.push({ path: rel, diff: `${conflict}\n${unifiedDiff(onDisk, text, rel)}` });
        continue;
      }
    }

    if (!dryRun) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text, 'utf8');
      if (row.kind === 'manifest') ctx.db.putManifest(entity as Manifest, { dirty: false }); // keep the cache equal to disk
      ctx.db.clearDirty(row.kind, row.key);
      ctx.db.setBlobSha(row.kind, row.key, blobShaOfText(text));
    }
    result.written.push(rel);
  }
  return result;
}

/**
 * Pure: relative path (`<platform>/screens/<id>.yaml`, `<platform>/recipes/<id>.yaml`,
 * `<platform>/manifest.yaml`, `ids.yaml`) → canonical text for the given entities (what
 * `exportMap` would write). `ScreenFile` carries no platform, hence the argument.
 */
export function renderEntities(platform: Platform, entities: { screens: ScreenFile[]; recipes: RecipeFile[]; manifest?: Manifest; ids?: IdsRegistry }): Map<string, string> {
  const out = new Map<string, string>();
  if (entities.ids) out.set(relPathFor(platform, 'ids', 'ids'), canonicalYaml('ids', entities.ids));
  if (entities.manifest) out.set(relPathFor(platform, 'manifest', 'manifest'), canonicalYaml('manifest', entities.manifest));
  for (const screen of [...entities.screens].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    out.set(relPathFor(platform, 'screen', screen.id), canonicalYaml('screen', screen));
  }
  for (const recipe of [...entities.recipes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    out.set(relPathFor(platform, 'recipe', recipe.id), canonicalYaml('recipe', recipe));
  }
  return out;
}

/** files above this many lines get a whole-file replacement diff instead of an O(n·m) LCS */
const DIFF_MAX_LINES = 4000;
const DIFF_CONTEXT = 3;

type DiffOp = { tag: ' ' | '-' | '+'; line: string };

/** line-level LCS edit script (a → b) */
function diffLines(a: string[], b: string[]): DiffOp[] {
  if (a.length > DIFF_MAX_LINES || b.length > DIFF_MAX_LINES) {
    return [...a.map((line) => ({ tag: '-' as const, line })), ...b.map((line) => ({ tag: '+' as const, line }))];
  }
  // trim the common prefix/suffix first so the DP only sees the changed middle
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;
  // lcs[i][j] = LCS length of midA[i..] and midB[j..]
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i += 1) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    const rowI = lcs[i] as Uint32Array;
    const rowNext = lcs[i + 1] as Uint32Array;
    for (let j = m - 1; j >= 0; j -= 1) {
      rowI[j] = midA[i] === midB[j] ? (rowNext[j + 1] as number) + 1 : Math.max(rowNext[j] as number, rowI[j + 1] as number);
    }
  }
  const ops: DiffOp[] = a.slice(0, start).map((line) => ({ tag: ' ' as const, line }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && midA[i] === midB[j]) {
      ops.push({ tag: ' ', line: midA[i] as string });
      i += 1;
      j += 1;
    } else if (i < n && (j >= m || ((lcs[i + 1] as Uint32Array)[j] as number) >= ((lcs[i] as Uint32Array)[j + 1] as number))) {
      // deletions before insertions, as `git diff` prints a replaced line
      ops.push({ tag: '-', line: midA[i] as string });
      i += 1;
    } else {
      ops.push({ tag: '+', line: midB[j] as string });
      j += 1;
    }
  }
  for (const line of a.slice(endA)) ops.push({ tag: ' ', line });
  return ops;
}

/** Minimal unified diff of two texts (for `conflicts[].diff`); pure. */
export function unifiedDiff(a: string, b: string, label: string): string {
  if (a === b) return '';
  const splitLines = (s: string): string[] => (s.length === 0 ? [] : s.replace(/\n$/, '').split('\n'));
  const ops = diffLines(splitLines(a), splitLines(b));
  const out: string[] = [`--- a/${label}`, `+++ b/${label}`];
  // group changes into hunks with DIFF_CONTEXT lines of context (git's default of 3)
  let idx = 0;
  let oldLine = 1;
  let newLine = 1;
  while (idx < ops.length) {
    // skip unchanged runs, advancing counters
    if ((ops[idx] as DiffOp).tag === ' ') {
      idx += 1;
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // hunk starts DIFF_CONTEXT lines before this change
    const hunkStart = Math.max(0, idx - DIFF_CONTEXT);
    let hunkEnd = idx;
    let sinceChange = 0;
    while (hunkEnd < ops.length && sinceChange <= DIFF_CONTEXT * 2) {
      if ((ops[hunkEnd] as DiffOp).tag === ' ') sinceChange += 1;
      else sinceChange = 0;
      hunkEnd += 1;
    }
    // trim trailing context beyond DIFF_CONTEXT
    let trailing = 0;
    while (trailing < hunkEnd - idx && (ops[hunkEnd - 1 - trailing] as DiffOp).tag === ' ') trailing += 1;
    hunkEnd -= Math.max(0, trailing - DIFF_CONTEXT);
    const lead = idx - hunkStart;
    const hunkOldStart = oldLine - lead;
    const hunkNewStart = newLine - lead;
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = hunkStart; k < hunkEnd; k += 1) {
      const op = ops[k] as DiffOp;
      if (op.tag !== '+') oldCount += 1;
      if (op.tag !== '-') newCount += 1;
      body.push(`${op.tag}${op.line}`);
    }
    out.push(`@@ -${hunkOldStart},${oldCount} +${hunkNewStart},${newCount} @@`, ...body);
    // advance counters over the consumed ops
    for (let k = idx; k < hunkEnd; k += 1) {
      const op = ops[k] as DiffOp;
      if (op.tag !== '+') oldLine += 1;
      if (op.tag !== '-') newLine += 1;
    }
    idx = hunkEnd;
  }
  return `${out.join('\n')}\n`;
}
