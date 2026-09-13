#!/usr/bin/env node
// validate-pilot.mjs — schema-validate every YAML under app-map/ (by directory/kind) plus the
// JSON fixtures that carry a schema (router export, hook payloads, trajectory observations are
// checked structurally). Plain Node, no build step; uses ajv from tools/app-map-mcp/node_modules.
//
//   node tools/app-map-mcp/scripts/validate-pilot.mjs [--map <dir>] [--quiet]
//
// Exit 1 if any file is invalid. This is the pre-`app-map validate` backstop used while the CLI
// is a stub; `app-map validate` (02 §10) supersedes it with the cross-reference rules.

import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { parse: parseYaml } = require('yaml');

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(PKG, '..', '..');
const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
const mapIdx = args.indexOf('--map');
const MAP = mapIdx >= 0 ? resolve(args[mapIdx + 1]) : join(REPO, 'app-map');
const FIX = join(PKG, 'fixtures');
const SCHEMA_DIR = join(MAP, 'schema');

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true });
addFormats(ajv);
const validators = {};
for (const f of readdirSync(SCHEMA_DIR).filter((x) => x.endsWith('.schema.json'))) {
  const kind = f.replace('.schema.json', '');
  validators[kind] = ajv.compile(JSON.parse(readFileSync(join(SCHEMA_DIR, f), 'utf8')));
}

let failures = 0;
let checked = 0;
function report(file, ok, errors) {
  checked++;
  const rel = relative(REPO, file);
  if (ok) { if (!quiet) console.log(`ok       ${rel}`); return; }
  failures++;
  console.error(`INVALID  ${rel}`);
  for (const e of errors ?? []) console.error(`           ${e.instancePath || '/'} ${e.message} ${e.params ? JSON.stringify(e.params) : ''}`);
}
function check(kind, file, doc) {
  const v = validators[kind];
  if (!v) { report(file, false, [{ instancePath: '', message: `no schema for kind ${kind}` }]); return false; }
  const ok = v(doc);
  report(file, ok, v.errors);
  return ok;
}
function kindForYaml(file) {
  const rel = relative(MAP, file).split('/');
  if (rel.length === 1 && rel[0] === 'ids.yaml') return 'ids';
  if (rel[0] === 'policy' && rel[1] === 'mcp-allowlist.yaml') return 'mcp-allowlist';
  if (rel.length === 2 && rel[1] === 'manifest.yaml') return 'manifest';
  if (rel.length === 3 && rel[1] === 'screens') return 'screen';
  if (rel.length === 3 && rel[1] === 'recipes') return 'recipe';
  return null;
}
function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.local' || name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// 1. every YAML under app-map/
const platforms = [];
for (const file of walk(MAP)) {
  if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
  const kind = kindForYaml(file);
  if (!kind) { report(file, false, [{ instancePath: '', message: 'unrecognised location for a YAML file' }]); continue; }
  let doc;
  try { doc = parseYaml(readFileSync(file, 'utf8')); } catch (e) { report(file, false, [{ instancePath: '', message: `YAML parse error: ${e.message}` }]); continue; }
  const ok = check(kind, file, doc);
  // file name must equal the entity id (02 §2.1)
  if (ok && (kind === 'screen' || kind === 'recipe') && doc.id !== basename(file, '.yaml')) report(file, false, [{ instancePath: '/id', message: `must equal file name (${basename(file, '.yaml')})` }]);
  if (ok && kind === 'manifest') {
    platforms.push(doc.platform);
    if (doc.platform !== basename(dirname(file))) report(file, false, [{ instancePath: '/platform', message: `must equal directory name` }]);
  }
  if (ok && kind === 'recipe' && doc.platform !== relative(MAP, file).split('/')[0]) report(file, false, [{ instancePath: '/platform', message: 'must equal platform directory' }]);
}

// 2. cross-reference rules that need no server (subset of 02 §10: 2, 3, 4, 5, 6)
const ids = parseYaml(readFileSync(join(MAP, 'ids.yaml'), 'utf8'));
const screenIds = new Set(ids.screens.map((s) => s.id));
const gateIds = new Set(ids.gates.map((g) => g.id));
const elementIds = new Map(ids.elements.map((e) => [e.id, e]));
for (const g of ids.gates) elementIds.set(g.dismiss, { id: g.dismiss, kind: 'button', intent_critical: false, dynamic: false });
for (const platform of platforms) {
  const dir = join(MAP, platform);
  const screens = new Map();
  for (const f of readdirSync(join(dir, 'screens'))) screens.set(basename(f, '.yaml'), { file: join(dir, 'screens', f), doc: parseYaml(readFileSync(join(dir, 'screens', f), 'utf8')) });
  const recipes = existsSync(join(dir, 'recipes')) ? readdirSync(join(dir, 'recipes')).map((f) => ({ file: join(dir, 'recipes', f), doc: parseYaml(readFileSync(join(dir, 'recipes', f), 'utf8')) })) : [];
  const knownScreen = (id) => screens.has(id) || id === '_previous';
  for (const [id, { file, doc }] of screens) {
    const errs = [];
    if (doc.kind === 'screen' && !screenIds.has(id)) errs.push(`screen ${id} not in ids.yaml`);
    if (doc.kind === 'gate' && !gateIds.has(id)) errs.push(`gate ${id} not in ids.yaml`);
    for (const g of doc.gates ?? []) if (!gateIds.has(g)) errs.push(`gate ${g} not in ids.yaml`);
    for (const rid of [...(doc.signature.required_ids ?? []), ...(doc.dynamic_regions ?? [])]) if (!elementIds.has(rid)) errs.push(`${rid} not in ids.yaml`);
    for (const el of doc.elements) {
      const reg = elementIds.get(el.id);
      if (!reg) { errs.push(`element ${el.id} not in ids.yaml`); continue; }
      const strategies = el.locators.map((l) => l.strategy);
      const osGate = doc.kind === 'gate' && strategies.every((s) => s === 'role_label' || s === 'path');
      if (!osGate && (el.locators.length < 2 || !strategies.includes('a11y_id'))) errs.push(`element ${el.id}: needs >=2 locators incl. a11y_id (02 §10.4)`);
      if (strategies.length === 1 && strategies[0] === 'text') errs.push(`element ${el.id}: lone text locator (02 §10.5)`);
      if ((reg.intent_critical === true) !== (el.intent_critical === true)) errs.push(`element ${el.id}: intent_critical disagrees with ids.yaml (02 §10.6)`);
      if (reg.dynamic === true && el.label !== undefined) errs.push(`element ${el.id}: dynamic element must not carry a label (07 §2.3)`);
      if (reg.dynamic === true && el.dynamic !== true) errs.push(`element ${el.id}: dynamic in ids.yaml but not in screen`);
    }
    for (const e of doc.edges) {
      if (!knownScreen(e.to)) errs.push(`edge to ${e.to}: no such screen`);
      if (e.action.element && !elementIds.has(e.action.element)) errs.push(`edge element ${e.action.element} not in ids.yaml`);
      if (e.action.element && !doc.elements.some((el) => el.id === e.action.element)) errs.push(`edge element ${e.action.element} not declared on this screen`);
      for (const c of [...(e.preconditions ?? []), ...(e.postconditions ?? [])]) if (c.screen && !knownScreen(c.screen)) errs.push(`condition screen ${c.screen}: no such screen`);
    }
    if (errs.length) report(file, false, errs.map((m) => ({ instancePath: '', message: m }))); else checked++;
  }
  for (const { file, doc } of recipes) {
    const errs = [];
    for (const s of doc.entry.fallback_path ?? []) if (!knownScreen(s)) errs.push(`fallback_path ${s}: no such screen`);
    const checkExpect = (x, where) => {
      if (!x) return;
      if (x.screen && !knownScreen(x.screen)) errs.push(`${where}: expect.screen ${x.screen} unknown`);
      for (const id of [x.focused, ...(x.visible ?? []), ...(x.not_visible ?? [])].filter(Boolean)) if (!elementIds.has(id)) errs.push(`${where}: ${id} not in ids.yaml`);
    };
    for (const st of doc.steps) {
      // `list` and `cell` are the element keys of the two `select` forms (issue #19)
      for (const id of [st.element, st.list, st.cell].filter(Boolean)) if (!elementIds.has(id)) errs.push(`${st.id}: ${id} not in ids.yaml`);
      if (st.gate && !gateIds.has(st.gate)) errs.push(`${st.id}: gate ${st.gate} unknown`);
      const el = st.element ? elementIds.get(st.element) : undefined;
      if (el && (el.intent_critical === true) !== (st.intent_critical === true)) errs.push(`${st.id}: intent_critical must mirror ids.yaml for ${st.element}`);
      checkExpect(st.expect, st.id);
    }
    checkExpect(doc.verify, 'verify');
    if (errs.length) report(file, false, errs.map((m) => ({ instancePath: '', message: m }))); else checked++;
  }
}

// 2b. ids.yaml ↔ screen file agreement (validate rule 2 extension): title/deep_link must match when both present;
//     gate files carry no title (07 §2.1, architecture §7 decision 33)
for (const platform of platforms) {
  for (const f of readdirSync(join(MAP, platform, 'screens'))) {
    const file = join(MAP, platform, 'screens', f);
    const doc = parseYaml(readFileSync(file, 'utf8'));
    const errs = [];
    if (doc.kind === 'screen') {
      const reg = ids.screens.find((s) => s.id === doc.id);
      if (reg?.title !== undefined && doc.title !== undefined && reg.title !== doc.title) errs.push(`title ${JSON.stringify(doc.title)} differs from ids.yaml ${JSON.stringify(reg.title)}`);
      // agreement is on the route (query stripped): the screen file may add `?fixture=…` (01 R5), the registry records the route
      const routeKey = (u) => (u.includes('?') ? u.slice(0, u.indexOf('?')) : u);
      if (reg?.deep_link !== undefined && doc.deep_link !== undefined && routeKey(reg.deep_link) !== routeKey(doc.deep_link)) errs.push(`deep_link ${doc.deep_link} differs from ids.yaml ${reg.deep_link} (route part)`);
    } else if (doc.title !== undefined) errs.push('gate files must not carry a title (07 §2.1)');
    if (errs.length) report(file, false, errs.map((m) => ({ instancePath: '', message: m })));
  }
}

// 3. JSON fixtures
const jsonFixture = (kind, file) => existsSync(file) && check(kind, file, JSON.parse(readFileSync(file, 'utf8')));
jsonFixture('router-export', join(FIX, 'router-export.ios.json'));
if (existsSync(join(FIX, 'hooks'))) for (const f of readdirSync(join(FIX, 'hooks'))) if (f.endsWith('.json')) jsonFixture('hook-payload', join(FIX, 'hooks', f));
jsonFixture('drift-report', join(FIX, 'ci', 'drift-report.json'));
jsonFixture('heal-report', join(FIX, 'ci', 'heal-report.json'));

// 3b. events.jsonl fixture: every line validates against events.schema.json (08 §2)
const eventsFixture = join(FIX, 'events', 'sample.events.jsonl');
if (existsSync(eventsFixture)) {
  const errs = [];
  readFileSync(eventsFixture, 'utf8').split('\n').filter(Boolean).forEach((line, i) => {
    let o;
    try { o = JSON.parse(line); } catch (e) { errs.push(`line ${i + 1}: ${e.message}`); return; }
    if (!validators.events(o)) errs.push(`line ${i + 1}: ${validators.events.errors.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}`);
  });
  report(eventsFixture, errs.length === 0, errs.map((m) => ({ instancePath: '', message: m })));
}

// 3c. CI params fixture: `{recipe: {param: value}}` and every required param of a pilot recipe has a value
const paramsFixture = join(FIX, 'ci', 'params.json');
if (existsSync(paramsFixture)) {
  const params = JSON.parse(readFileSync(paramsFixture, 'utf8'));
  const errs = [];
  for (const platform of platforms) {
    const dir = join(MAP, platform, 'recipes');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      const doc = parseYaml(readFileSync(join(dir, f), 'utf8'));
      for (const p of doc.params) if (p.required && params[doc.id]?.[p.name] === undefined && !(p.values && p.values.length)) errs.push(`${doc.id}.${p.name}: no CI value (maestro-export would fail with bad_input)`);
    }
  }
  report(paramsFixture, errs.length === 0, errs.map((m) => ({ instancePath: '', message: m })));
}

// 4. trajectory lines: structural sanity (Observation shape, scrubbed snapshot, no `value` keys,
//    no label on or under a node whose id is `dynamic: true` in ids.yaml — 07 §2.3.2)
const dynamicIds = new Set(ids.elements.filter((e) => e.dynamic === true).map((e) => e.id));
const traj = join(FIX, 'trajectories', 'create_invoice.session.jsonl');
if (existsSync(traj)) {
  const errs = [];
  const lines = readFileSync(traj, 'utf8').split('\n').filter(Boolean);
  lines.forEach((line, i) => {
    const o = JSON.parse(line);
    const walkDyn = (n, under) => {
      const d = under || dynamicIds.has(n.a11y_id);
      if (d && n.label !== undefined) errs.push(`line ${i + 1}: label under dynamic id ${n.a11y_id ?? '(child)'} (07 §2.3.2)`);
      for (const c of n.children ?? []) walkDyn(c, d);
    };
    if (o.snapshot) walkDyn(o.snapshot.root, false);
    for (const k of ['ts', 'session', 'seq', 'tool', 'input', 'screen_before', 'screen_after', 'signature_after', 'snapshot', 'ok', 'latency_ms']) if (!(k in o)) errs.push(`line ${i + 1}: missing ${k}`);
    if (o.seq !== i + 1) errs.push(`line ${i + 1}: seq must be ${i + 1}`);
    if (o.snapshot && o.snapshot.scrubbed !== true) errs.push(`line ${i + 1}: snapshot not marked scrubbed`);
    if (/"value":/.test(JSON.stringify(o.snapshot))) errs.push(`line ${i + 1}: snapshot contains a value attribute (07 §2.3.1)`);
    if (/@|\$\s?\d/.test(JSON.stringify(o.snapshot))) errs.push(`line ${i + 1}: snapshot contains PII-looking text`);
  });
  report(traj, errs.length === 0, errs.map((m) => ({ instancePath: '', message: m })));
}

console.log(`${failures === 0 ? 'all valid' : `${failures} invalid`} (${checked} checks)`);
process.exit(failures ? 1 : 0);
