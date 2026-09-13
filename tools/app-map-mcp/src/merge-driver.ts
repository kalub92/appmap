/**
 * [A1] `app-map merge-driver %O %A %B` — semantic 3-way merge for app-map YAML (02 §9, phase 2;
 * wired by .gitattributes `merge=app-map-yaml`).
 *
 * Algorithm: parse all three; merge per key and per `id`-keyed list item (elements, variants,
 * screens, gates; edges keyed by `(action, to)`; steps keyed by `id`; locators keyed by
 * `strategy`); a key changed on one side only takes that side; changed on both sides to the
 * same value is fine; changed on both to different values is a conflict. Conflicts are
 * rendered as standard `<<<<<<< ours / ======= / >>>>>>> theirs` blocks around the *canonical
 * YAML of the conflicting subtree* and the driver exits 1 so git marks the file conflicted.
 * A clean merge is written canonically (yaml/canonical.ts) to `%A` and exits 0.
 *
 * Layer: yaml (imports types/paths/errors + yaml/*).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { YamlKind } from './paths.ts';
import type { MergeResult } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import type { CanonicalType } from './yaml/canonical.ts';
import { ID_SORTED_LISTS, SORTED_STRING_SETS, canonicalYamlOf, canonicalize, childType, edgeSortKey, parseYamlText } from './yaml/canonical.ts';

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * Identity of a list item for the per-item merge: `id` (screens, gates, elements, variants,
 * steps), `name` (servers, params), `strategy` (locators), `(action, to)` for edges, the
 * string itself for string sets; anything else (conditions, required_labels) by its canonical
 * JSON — value identity, i.e. set semantics.
 */
function itemKey(listKey: string, itemType: CanonicalType | undefined, item: unknown): string {
  if (typeof item === 'string') return `s:${item}`;
  if (isObj(item)) {
    if (listKey === 'edges') return `e:${edgeSortKey(item).join(' ')}`;
    if (typeof item['id'] === 'string') return `id:${item['id']}`;
    if (typeof item['name'] === 'string') return `n:${item['name']}`;
    if (typeof item['strategy'] === 'string') return `st:${item['strategy']}`;
  }
  return `j:${JSON.stringify(itemType ? canonicalize(itemType, item) : item)}`;
}

/** lists whose order is semantics AND whose items carry a key (architecture §3.3) */
const ORDERED_KEYED_LISTS: ReadonlySet<string> = new Set(['steps', 'locators', 'params']);
/** lists of scalars whose order is semantics: no per-item merge, a both-sides change conflicts */
const ORDERED_SCALAR_LISTS: ReadonlySet<string> = new Set(['matches', 'fallback_path', 'args', 'values']);

const SENTINEL_PREFIX = '__APPMAP_CONFLICT_';
const sentinel = (n: number): string => `${SENTINEL_PREFIX}${n}__`;
const SENTINEL_LINE = /^(\s*)(- )?(?:([^\s:][^:]*): )?__APPMAP_CONFLICT_(\d+)__$/;

interface Conflict {
  path: string;
  base?: unknown;
  ours: unknown;
  theirs: unknown;
  /** type of the object holding `key` (a key conflict) */
  parentType: CanonicalType | undefined;
  key: string;
  /** true when the conflicting value is a list item (rendered with `- `) */
  inList: boolean;
  itemType: CanonicalType | undefined;
}

class Merger {
  readonly conflicts: Conflict[] = [];

  private conflict(c: Conflict): string {
    this.conflicts.push(c);
    return sentinel(this.conflicts.length);
  }

  /** The 3-way rule for any value; `type` is the canonical type of the value when known. */
  value(type: CanonicalType | undefined, parentType: CanonicalType | undefined, key: string, path: string, b: unknown, o: unknown, t: unknown, inList: boolean): unknown {
    if (deepEqual(o, t)) return o; // same on both sides (or both untouched)
    if (deepEqual(b, o)) return t; // only theirs changed
    if (deepEqual(b, t)) return o; // only ours changed
    if (isObj(o) && isObj(t) && (b === undefined || isObj(b))) return this.object(type, path, (b ?? {}) as Obj, o, t);
    if (Array.isArray(o) && Array.isArray(t) && (b === undefined || Array.isArray(b))) {
      const merged = this.list(parentType, key, path, (b ?? []) as unknown[], o, t);
      if (merged !== undefined) return merged;
    }
    const c: Conflict = { path, ours: o, theirs: t, parentType, key, inList, itemType: inList ? type : undefined };
    if (b !== undefined) c.base = b;
    return this.conflict(c);
  }

  private object(type: CanonicalType | undefined, path: string, b: Obj, o: Obj, t: Obj): Obj {
    const out: Obj = {};
    const keys = new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b)]);
    for (const k of keys) {
      // locator `value` is typed by `strategy`; strategy is the item key so ours/theirs agree
      const sub = type ? childType(type, k, o['strategy'] !== undefined ? o : t) : undefined;
      const v = this.value(sub, type, k, `${path}/${k}`, b[k], o[k], t[k], false);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }

  /** Keyed per-item merge; `undefined` means "no item identity — conflict on the whole list". */
  private list(parentType: CanonicalType | undefined, key: string, path: string, b: unknown[], o: unknown[], t: unknown[]): unknown[] | undefined {
    if (ORDERED_SCALAR_LISTS.has(key)) return undefined;
    const itemType = parentType ? childType(parentType, key) : undefined;
    const keyed = (arr: unknown[]): Map<string, unknown> | undefined => {
      const m = new Map<string, unknown>();
      for (const item of arr) {
        const k = itemKey(key, itemType, item);
        if (m.has(k)) return undefined; // duplicate keys: no identity
        m.set(k, item);
      }
      return m;
    };
    const bm = keyed(b);
    const om = keyed(o);
    const tm = keyed(t);
    if (!bm || !om || !tm) return undefined;
    const isSet = SORTED_STRING_SETS.has(key) || ID_SORTED_LISTS.has(key) || key === 'edges' || key === 'servers';
    const oursOrder = [...om.keys()];
    const theirsOrder = [...tm.keys()];
    const baseOrder = [...bm.keys()];
    const sameSeq = (x: string[], y: string[]): boolean => x.length === y.length && x.every((k, i) => k === y[i]);
    // did a side keep the base's relative order of the items both still have?
    const oursKept = sameSeq(oursOrder.filter((k) => bm.has(k)), baseOrder.filter((k) => om.has(k)));
    const theirsKept = sameSeq(theirsOrder.filter((k) => bm.has(k)), baseOrder.filter((k) => tm.has(k)));
    if (!isSet && ORDERED_KEYED_LISTS.has(key) && !oursKept && !theirsKept) return undefined; // both reordered differently
    // skeleton order: ours, unless ours kept base's order and theirs reordered (then theirs);
    // canonicalize re-sorts the set-like lists anyway
    const skeleton = !isSet && oursKept && !theirsKept ? theirsOrder : oursOrder;
    const order = [...skeleton];
    for (const k of skeleton === oursOrder ? theirsOrder : oursOrder) if (!order.includes(k)) order.push(k);
    for (const k of baseOrder) if (!order.includes(k)) order.push(k);
    const out: unknown[] = [];
    for (const k of order) {
      const v = this.value(itemType, parentType, key, `${path}/${k.replace(/^[a-z]+:/, '')}`, bm.get(k), om.get(k), tm.get(k), true);
      if (v !== undefined) out.push(v);
    }
    return out;
  }
}

/** Render one side of a conflict at the place its sentinel line occupies. */
function renderSide(c: Conflict, value: unknown, indent: string, dash: string): string[] {
  if (value === undefined) return [];
  // a list item renders its own type behind the sentinel's `- `; a key conflict renders `key: …`
  // ordered by the parent type (the sentinel line already carried the dash, if any)
  const text = c.inList
    ? canonicalYamlOf(c.itemType ?? 'condition', value)
    : canonicalYamlOf(c.parentType ?? 'condition', { [c.key]: value });
  const lines = text.replace(/\n$/, '').split('\n');
  const rest = indent + ' '.repeat(dash.length);
  return lines.map((l, i) => (i === 0 ? indent + dash : rest) + l);
}

/** Replace every sentinel line with a git-style conflict block (markers at column 0, like git). */
function renderConflicts(text: string, conflicts: Conflict[]): string {
  const out: string[] = [];
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const m = SENTINEL_LINE.exec(line);
    const c = m ? conflicts[Number(m[4]) - 1] : undefined;
    if (!m || !c) {
      out.push(line);
      continue;
    }
    const indent = m[1] ?? '';
    const dash = m[2] ?? '';
    out.push('<<<<<<< ours');
    out.push(...renderSide(c, c.ours, indent, dash));
    out.push('=======');
    out.push(...renderSide(c, c.theirs, indent, dash));
    out.push('>>>>>>> theirs');
  }
  return out.join('\n') + '\n';
}

/** Pure: merge three YAML texts of the same kind. `merged` is canonical when `conflicts` is empty. */
export function mergeYamlDocuments(kind: YamlKind, base: string, ours: string, theirs: string): MergeResult {
  const parseSide = (text: string, name: string): Obj | undefined => {
    // parsed WITH the kind so a three-way merge of a manifest coerces exactly like the loader and
    // the merged output stays canonical (issue #20)
    const doc: unknown = text.trim() === '' ? undefined : parseYamlText(text, name, kind);
    if (doc === undefined || doc === null) return undefined; // an empty side = the file did not exist (add/add)
    if (!isObj(doc)) throw new AppMapError(ERROR_CODES.BAD_INPUT, `${name} is not a YAML mapping`, 'app-map files are mappings (02 §2)');
    return doc;
  };
  const b = parseSide(base, 'base');
  const o = parseSide(ours, 'ours');
  const t = parseSide(theirs, 'theirs');
  const merger = new Merger();
  const merged = merger.value(kind, undefined, '', '', b, o ?? {}, t ?? {}, false);
  const text = canonicalYamlOf(kind, merged);
  if (merger.conflicts.length === 0) return { merged: text, conflicts: [] };
  return {
    merged: renderConflicts(text, merger.conflicts),
    conflicts: merger.conflicts.map((c) => {
      const out: MergeResult['conflicts'][number] = { path: c.path, ours: c.ours, theirs: c.theirs };
      if (c.base !== undefined) out.base = c.base;
      return out;
    }),
  };
}

/** Infer the YAML kind from a repository path (`app-map/ios/screens/x.yaml` -> `screen`). */
export function inferKindFromPath(path: string): YamlKind | undefined {
  const parts = path.split(/[/\\]/);
  const name = basename(path);
  const dir = parts[parts.length - 2];
  if (name === 'ids.yaml') return 'ids';
  if (name === 'mcp-allowlist.yaml' && dir === 'policy') return 'mcp-allowlist';
  if (name === 'manifest.yaml') return 'manifest';
  if (dir === 'screens') return 'screen';
  if (dir === 'recipes') return 'recipe';
  return undefined;
}

/** Infer the YAML kind from a parsed document's root keys (fallback when git gives no `%P`). */
export function inferKindFromContent(doc: unknown): YamlKind | undefined {
  if (!isObj(doc)) return undefined;
  if ('steps' in doc) return 'recipe';
  if ('signature' in doc) return 'screen';
  if ('servers' in doc) return 'mcp-allowlist';
  if ('app_id' in doc) return 'manifest';
  if ('elements' in doc) return 'ids';
  return undefined;
}

/**
 * git entry point: reads the three temp files, infers the kind from `oursPath` (git passes the
 * real path in `%P`; when absent, infer from content: `steps` ⇒ recipe, `signature` ⇒ screen,
 * `elements` at root without `signature` ⇒ ids, `servers` ⇒ mcp-allowlist, `app_id` ⇒ manifest),
 * writes the result to `oursPath`, returns the process exit code (0 clean, 1 conflict, 2 error).
 */
export function runMergeDriver(basePath: string, oursPath: string, theirsPath: string, opts: { realPath?: string } = {}): number {
  // %A and %B are read first and kept: every failure path below writes a whole-file conflict
  // into %A, which is only honest if both sides are actually in hand.
  let ours: string;
  let theirs: string;
  try {
    ours = readFileSync(oursPath, 'utf8');
    theirs = readFileSync(theirsPath, 'utf8');
  } catch (e) {
    process.stderr.write(`app-map merge-driver: cannot read the merge inputs: ${String(e)}\n`);
    return 2;
  }
  try {
    const base = readFileSync(basePath, 'utf8');
    let kind = inferKindFromPath(opts.realPath ?? oursPath);
    if (!kind) {
      for (const text of [ours, theirs, base]) {
        try {
          kind = inferKindFromContent(text.trim() === '' ? undefined : parseYamlText(text, 'merge input'));
        } catch {
          kind = undefined;
        }
        if (kind) break;
      }
    }
    if (!kind) {
      // git does NOT fall back to a textual merge when a driver fails: it marks the path unmerged
      // and leaves whatever is in %A, i.e. OURS with no conflict markers. Resolving with a plain
      // `git add` would then silently discard THEIRS, so write the unresolved state into the file.
      writeFileSync(oursPath, wholeFileConflict(ours, theirs), 'utf8');
      process.stderr.write(`app-map merge-driver: cannot infer the YAML kind of ${opts.realPath ?? oursPath}; wrote a whole-file conflict — resolve it by hand\n`);
      return 1;
    }
    const result = mergeYamlDocuments(kind, base, ours, theirs);
    writeFileSync(oursPath, result.merged, 'utf8');
    if (result.conflicts.length) {
      process.stderr.write(`app-map merge-driver: ${result.conflicts.length} conflict(s) in ${opts.realPath ?? oursPath}: ${result.conflicts.map((c) => c.path).join(', ')}\n`);
      return 1;
    }
    return 0;
  } catch (e) {
    process.stderr.write(`app-map merge-driver: ${AppMapError.is(e) ? `${e.message} (${e.hint})` : String(e)}\n`);
    // same reasoning as above: never leave OURS looking cleanly merged after a failure
    try {
      writeFileSync(oursPath, wholeFileConflict(ours, theirs), 'utf8');
      process.stderr.write(`app-map merge-driver: wrote a whole-file conflict into ${opts.realPath ?? oursPath} — resolve it by hand\n`);
      return 1;
    } catch {
      return 2;
    }
  }
}

/** `<<<<<<< ours` … `=======` … `>>>>>>> theirs`, so the unresolved state is visible in the file. */
export function wholeFileConflict(ours: string, theirs: string): string {
  const body = (text: string): string => (text === '' || text.endsWith('\n') ? text : `${text}\n`);
  return `<<<<<<< ours\n${body(ours)}=======\n${body(theirs)}>>>>>>> theirs\n`;
}
