/**
 * [A1] `app-map migrate-id <old> <new>` (02 §8): a rename is a migration that rewrites every
 * reference across `ids.yaml`, every platform's screens and recipes in one pass, then writes
 * the touched files canonically. Works for element ids, screen ids (also renames the file and
 * the `screen.<id>` marker) and gate ids (also the dismiss control prefix).
 *
 * Refuses (`AppMapError(bad_input)`) when `new` violates 01 R2, when `old` is unknown, or when
 * `new` already exists. Never touches `.local/`; the caller re-runs `export` afterwards.
 *
 * Layer: yaml (imports types/config/paths/errors + yaml/*).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { AppMapConfig, Platform } from './config.ts';
import { PLATFORMS } from './config.ts';
import type { IdsRegistry, MigrateIdResult } from './types.ts';
import { ELEMENT_ID_REGEX, GATE_DISMISS_REGEX, GATE_ID_REGEX, SCREEN_ID_REGEX, markerOfScreen } from './types.ts';
import { AppMapError, ERROR_CODES } from './errors.ts';
import type { YamlKind } from './paths.ts';
import { idsFile, kindForPath, manifestFile, recipesDir, screenFile, screensDir } from './paths.ts';
import { canonicalYaml, parseYamlText } from './yaml/canonical.ts';
import { readIds } from './yaml/load.ts';

export interface MigrateIdOptions {
  /** report what would change without writing */
  dryRun?: boolean;
}

type IdKind = 'screen' | 'gate' | 'element' | 'dismiss';

/** Which registry list `id` lives in (01 R1), or `undefined` when unregistered. */
function registryKind(ids: IdsRegistry, id: string): IdKind | undefined {
  if (ids.screens.some((s) => s.id === id)) return 'screen';
  if (ids.gates.some((g) => g.id === id)) return 'gate';
  if (ids.elements.some((e) => e.id === id)) return 'element';
  if (ids.gates.some((g) => g.dismiss === id)) return 'dismiss';
  return undefined;
}

/** 01 R2 shape check for the new id, per kind of the old one. */
function checkNewId(kind: IdKind, oldId: string, newId: string): void {
  const bad = (why: string, hint: string): never => {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `new id ${newId} ${why}`, hint);
  };
  switch (kind) {
    case 'screen':
      if (!SCREEN_ID_REGEX.test(newId)) bad('is not a snake_case screen id (01 R2)', 'screen ids match ^[a-z][a-z0-9_]*$, e.g. invoice_list');
      break;
    case 'gate':
      if (!GATE_ID_REGEX.test(newId)) bad('is not a gate id (01 R2)', 'gate ids are gate.<name>, e.g. gate.push_permission');
      break;
    case 'element':
      if (!ELEMENT_ID_REGEX.test(newId)) bad('is not an element id (01 R2)', 'element ids are <feature>.<name>.<kind> with three or more lowercase segments, never screen./gate.');
      break;
    case 'dismiss': {
      const gate = oldId.slice(0, oldId.lastIndexOf('.'));
      if (!GATE_DISMISS_REGEX.test(newId) || !newId.startsWith(`${gate}.`) || newId.slice(gate.length + 1).includes('.')) {
        bad(`is not a dismiss control of ${gate} (01 R2)`, `dismiss controls are ${gate}.<verb>; rename the gate itself with migrate-id ${gate} <new>`);
      }
      break;
    }
  }
}

function yamlFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort()
    .map((f) => join(dir, f));
}

export function migrateId(config: AppMapConfig, oldId: string, newId: string, opts: MigrateIdOptions = {}): MigrateIdResult {
  const ids = readIds(config);
  const kind = registryKind(ids, oldId);
  if (!kind) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `id ${oldId} is not registered in ids.yaml`, 'migrate-id renames registered screen, gate, element or dismiss-control ids (01 R1)');
  }
  if (newId === oldId) throw new AppMapError(ERROR_CODES.BAD_INPUT, `new id equals the old id ${oldId}`, 'nothing to migrate');
  checkNewId(kind, oldId, newId);
  if (registryKind(ids, newId)) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `id ${newId} already exists in ids.yaml`, 'pick an unused id; merging two ids is not a migration (02 §8)');
  }
  if (kind === 'gate' && ids.gates.some((g) => g.dismiss.startsWith(`${newId}.`))) {
    throw new AppMapError(ERROR_CODES.BAD_INPUT, `dismiss controls under ${newId}. already exist`, 'pick an unused gate name');
  }

  const platforms = PLATFORMS.filter((p) => existsSync(manifestFile(config, p)));
  // the screen/gate file itself moves with the id (02 §2.1: one file per entity, named after it)
  const renamesFile = kind === 'screen' || kind === 'gate';
  for (const p of platforms) {
    if (renamesFile && existsSync(screenFile(config, newId, p))) {
      throw new AppMapError(ERROR_CODES.BAD_INPUT, `${rel(config, screenFile(config, newId, p))} already exists`, 'pick an unused id or remove the stale file first');
    }
  }

  const jobs: Array<{ path: string; target: string; platform?: Platform }> = [{ path: idsFile(config), target: idsFile(config) }];
  for (const platform of platforms) {
    for (const path of yamlFilesIn(screensDir(config, platform))) {
      const name = basename(path).replace(/\.ya?ml$/, '');
      const target = renamesFile && name === oldId ? screenFile(config, newId, platform) : path;
      jobs.push({ path, target, platform });
    }
    for (const path of yamlFilesIn(recipesDir(config, platform))) jobs.push({ path, target: path, platform });
  }

  const filesChanged: string[] = [];
  let references = 0;
  const writes: Array<{ path: string; target: string; text: string }> = [];
  for (const job of jobs) {
    const fileRel = rel(config, job.path);
    const kindOfFile: YamlKind | undefined = kindForPath(config, job.path);
    if (!kindOfFile) continue;
    const doc = parseYamlText(readFileSync(job.path, 'utf8'), fileRel);
    const { doc: rewritten, count } = rewriteIdReferences(doc, oldId, newId);
    if (count === 0 && job.target === job.path) continue;
    references += count;
    writes.push({ path: job.path, target: job.target, text: canonicalYaml(kindOfFile, rewritten) });
    filesChanged.push(rel(config, job.target));
  }
  if (!opts.dryRun) {
    // every rewrite is computed before the first write, so a parse failure leaves the map untouched
    for (const w of writes) {
      mkdirSync(dirname(w.target), { recursive: true });
      writeFileSync(w.target, w.text, 'utf8');
      if (w.target !== w.path) rmSync(w.path, { force: true });
    }
  }
  return { old_id: oldId, new_id: newId, files_changed: filesChanged, references };
}

function rel(config: Pick<AppMapConfig, 'dir'>, path: string): string {
  return relative(config.dir, path).split(sep).join('/');
}

/** keys whose whole-string value is an id (element, screen or gate) */
const ID_KEYS: ReadonlySet<string> = new Set(['id', 'element', 'list', 'to', 'focused', 'dismiss', 'screen', 'gate']);
/** keys whose string items are ids */
const ID_LIST_KEYS: ReadonlySet<string> = new Set(['visible', 'not_visible', 'required_ids', 'dynamic_regions', 'gates', 'fallback_path']);
/** keys carrying `appmap://<screen_id>[?…]` */
const URL_KEYS: ReadonlySet<string> = new Set(['deep_link', 'route', 'url']);

/**
 * Pure: deep-rewrite every string equal to `oldId` (and markers/dismiss ids derived from it)
 * inside a parsed YAML document. Only whole-string matches on id-bearing keys (`id`, `element`,
 * `list`, `to`, `focused`, `visible[]`, `not_visible[]`, `required_ids[]`, `dynamic_regions[]`,
 * `gates[]`, `fallback_path[]`, `marker`, `dismiss`, locator `value` for `a11y_id`, `screen`
 * in conditions/expects, `deep_link`/`route`/`url` screen segment) are rewritten — never labels.
 */
export function rewriteIdReferences<T>(doc: T, oldId: string, newId: string): { doc: T; count: number } {
  const isScreen = SCREEN_ID_REGEX.test(oldId);
  const isGate = GATE_ID_REGEX.test(oldId);
  let count = 0;
  const id = (s: string): string => {
    if (s === oldId) {
      count++;
      return newId;
    }
    // renaming a gate renames its dismiss controls too (`gate.<name>.<verb>`, 01 R2)
    if (isGate && s.startsWith(`${oldId}.`)) {
      count++;
      return newId + s.slice(oldId.length);
    }
    return s;
  };
  const marker = (s: string): string => {
    if (isScreen && s === markerOfScreen(oldId)) {
      count++;
      return markerOfScreen(newId);
    }
    return s;
  };
  const url = (s: string): string => {
    if (!isScreen) return s;
    const prefix = `appmap://${oldId}`;
    if (s === prefix || s.startsWith(`${prefix}?`)) {
      count++;
      return `appmap://${newId}${s.slice(prefix.length)}`;
    }
    return s;
  };
  const visit = (node: unknown, key: string | undefined, parent: Record<string, unknown> | undefined): unknown => {
    if (Array.isArray(node)) {
      return node.map((item) => (typeof item === 'string' && key !== undefined && ID_LIST_KEYS.has(key) ? id(item) : visit(item, key, undefined)));
    }
    if (typeof node === 'object' && node !== null) {
      const obj = node as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') {
          if (k === 'value' && obj['strategy'] === 'a11y_id') out[k] = id(v);
          else if (ID_KEYS.has(k)) out[k] = id(v);
          else if (k === 'marker') out[k] = marker(v);
          else if (URL_KEYS.has(k)) out[k] = url(v);
          else out[k] = v; // labels, text, description … are never rewritten
        } else out[k] = visit(v, k, obj);
      }
      return out;
    }
    void parent;
    return node;
  };
  const rewritten = visit(structuredClone(doc), undefined, undefined) as T;
  return { doc: rewritten, count };
}
