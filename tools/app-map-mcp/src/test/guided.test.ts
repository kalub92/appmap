/**
 * [C2] recipes/guided.ts — the 04 §5 guided protocol, 07 §3 execution policy and the 04 §7
 * pending-heal settlement across tool calls. Fixture trees are fed through `observe`
 * (`record_observation`) exactly as the PostToolUse hook would have recorded them, so the server
 * verifies from real observations and never from the reported `ok`.
 */
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { BuildProbeResult, RecipeFile, RecipeStep, ReportStepResult, RunStep, ScreenId, Tree, TreeNode } from '../types.ts';
import { GUIDED_LIMITS, UNKNOWN_SCREEN } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { readEvents } from '../events.ts';
import { schemaDir, stringsFile } from '../paths.ts';
import { validateEventLine } from '../yaml/schemas.ts';
import { STEP_MAX_TOKENS, formatRunStep } from '../format.ts';
import { estimateTokens } from '../token.ts';
import { normalizeTree, walk } from '../tree.ts';
import { declareTask, recordObservation } from '../observe.ts';
import type { BuildInfoProbe } from '../recipes/guided.ts';
import {
  BUILD_PROBE_KEY, assertDebugSandbox, buildProbeStrategies, checkExpect, defaultBuildProbe, expandSteps,
  parseProbeOutput, parseXmlPlist, readBuildProbe, reportStep, resolveRunSession, startGuidedRun,
  substituteParams, toRunStep,
} from '../recipes/guided.ts';
import { loadFixtureTree, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const SESSION = 'sess_2026-09-11_0001';
const OTHER_SESSION = 'sess_2026-09-11_0002';
const PARAMS = { amount: 50, client: 'Acme Corp' };
const isCode = (code: string) => (e: unknown): boolean => AppMapError.is(e) && e.code === code;

let t: TempAppMapDir;
let ctx: AppMapContext;

function open(env: NodeJS.ProcessEnv = {}): void {
  t = makeTempAppMapDir({ env });
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
}
beforeEach(() => { open(); });
afterEach(() => { ctx.close(); t.cleanup(); });

const debugProbe: BuildInfoProbe = async (_config, appId) => ({
  schema_version: 1, build_type: 'debug', sandbox: true, app_id: appId, version: '1.4.0',
  build_number: '4412', git_sha: 'deadbee', auth: 'logged_in',
});
const noHooks = { skipBuildCheck: true } as const;

function node(tree: Tree, pred: (n: TreeNode) => boolean): TreeNode {
  let found: TreeNode | undefined;
  walk(tree, (n) => { if (found === undefined && pred(n)) found = n; return undefined; });
  assert.ok(found !== undefined, 'node not found in the fixture tree');
  return found;
}
const byId = (id: string) => (n: TreeNode): boolean => n.a11y_id === id;

/** one driver call, recorded exactly as the PostToolUse hook would (05 §3, 03 §7) */
function drive(name: string, opts: { mutate?: (tree: Tree) => void; session?: string; url?: string } = {}): number {
  const tree = normalizeTree(loadFixtureTree(name), { platform: 'ios' });
  opts.mutate?.(tree);
  return recordObservation(ctx, {
    session: opts.session ?? SESSION,
    tool: opts.url !== undefined ? 'mcp__argent__open_url' : 'mcp__argent__tap',
    input: opts.url !== undefined ? { url: opts.url } : {},
    snapshot: tree, ok: true,
  }).seq;
}
/** static copy a new build introduced (07 §2.3.3) — the scrubber keeps a label only when the string table has it */
function withStaticLabel(label: string): void {
  appendFileSync(stringsFile(t.config), `${label}\n`, 'utf8');
  ctx.reload();
}
const events = (kind: string) => readEvents(t.config).events.filter((e) => e.kind === kind);
/** 08 §2: every line this module appends must validate against events.schema.json */
function assertEventsValid(): void {
  for (const event of readEvents(t.config).events) {
    const issues = validateEventLine(schemaDir(t.config), JSON.stringify(event));
    assert.deepEqual(issues, [], `${event.kind}: ${JSON.stringify(issues)}`);
  }
}
/** 04 §5: every step handed to the LLM stays inside the 120-token budget */
function assertStepBudget(step: RunStep): void {
  const text = formatRunStep(step);
  assert.ok(estimateTokens(text) <= STEP_MAX_TOKENS, `${step.id}: ${text}`);
}

// ---------------------------------------------------------------------------------------------
// pure halves
// ---------------------------------------------------------------------------------------------

describe('substituteParams (04 §3.4 slots)', () => {
  it('replaces known slots and leaves unknown ones alone', () => {
    assert.equal(substituteParams('{amount}', PARAMS), '50');
    assert.equal(substituteParams('{client}', PARAMS), 'Acme Corp');
    assert.equal(substituteParams('total {amount} for {client}', PARAMS), 'total 50 for Acme Corp');
    assert.equal(substituteParams('{unknown}', PARAMS), '{unknown}');
    assert.equal(substituteParams('no slots', PARAMS), 'no slots');
  });
});

describe('expandSteps (module doc step 5 / architecture §7 decision 17)', () => {
  it('prepends s0 = open_link entry.deep_link expecting the first step screen', () => {
    const recipe = ctx.map.recipes.get('create_invoice')!;
    const expanded = expandSteps(ctx.map, recipe);
    assert.equal(expanded.length, recipe.steps.length + 1);
    const entry = expanded[0]!.step;
    assert.equal(entry.id, 's0');
    assert.equal(entry.action, 'open_link');
    assert.equal(entry.action === 'open_link' && entry.url, 'appmap://invoice_new?fixture=logged_in');
    assert.deepEqual(entry.expect, { screen: 'invoice_new' });
    // the screen each recipe step is taken on follows the expectations
    assert.deepEqual(expanded.slice(1).map((e) => [e.step.id, e.screen]), [
      ['s1', 'invoice_new'], ['s2', 'invoice_new'], ['s3', 'invoice_new'],
      ['s4', 'client_picker'], ['s5', 'invoice_new'],
    ]);
  });

  it('without a deep link the fallback_path expands to s0a, s0b, … edge taps', () => {
    const recipe = ctx.map.recipes.get('create_invoice')!;
    const noLink: RecipeFile = { ...recipe, entry: { fallback_path: ['invoice_list', 'invoice_new'] } };
    const expanded = expandSteps(ctx.map, noLink);
    const entry = expanded.slice(0, expanded.length - recipe.steps.length);
    assert.deepEqual(entry.map((e) => e.step.id), ['s0a', 's0b']);
    assert.equal(entry[0]!.step.action, 'open_link');
    assert.equal(entry[1]!.step.action, 'tap');
    assert.equal(entry[1]!.step.action === 'tap' && entry[1]!.step.element, 'invoice.add.button');
    assert.deepEqual(entry[1]!.step.expect, { screen: 'invoice_new' });
    for (const e of entry) assert.match(e.step.id, /^s[0-9]+[a-z]?$/);
  });
});

describe('toRunStep (04 §5: ≤120 tokens; 07 §3 announce)', () => {
  const recipe = () => ctx.map.recipes.get('create_invoice')!;

  it('substitutes params and names the element a step acts on', () => {
    const steps = recipe().steps;
    const type = toRunStep(ctx.map, steps.find((s) => s.id === 's2')!, PARAMS);
    assert.equal(type.action, 'type');
    assert.equal(type.element, 'invoice.amount.field');
    assert.equal(type.text, '50');
    const select = toRunStep(ctx.map, steps.find((s) => s.id === 's4')!, PARAMS);
    assert.equal(select.element, 'client.picker.list');
    assert.equal(select.match_text, 'Acme Corp');
  });

  it('resolves the target against a tree when one is given', () => {
    const tree = normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' });
    const step = toRunStep(ctx.map, recipe().steps[0]!, PARAMS, { tree });
    assert.deepEqual(step.target, { by: 'id', id: 'invoice.amount.field' });
    assert.equal(step.resolved?.strategy, 'a11y_id');
    assert.equal(step.resolved?.degraded, false);
  });

  it('a `select` by cell is addressed by its match text — every row carries the same id (04 §3.3, issue #19)', () => {
    const tree = normalizeTree(loadFixtureTree('client_picker'), { platform: 'ios' });
    const step: RecipeStep = { id: 's4', action: 'select', cell: 'client.picker.cell', match: { text: '{client}' }, expect: { screen: 'invoice_new' } };
    const run = toRunStep(ctx.map, step, PARAMS, { tree });
    assert.equal(run.element, 'client.picker.cell');
    assert.equal(run.match_text, 'Acme Corp');
    // `resolved` is evidence the row id is on screen; `target` is how to address the ONE row the
    // step means, which an id shared by every row cannot do
    assert.deepEqual(run.target, { by: 'text', text: 'Acme Corp' });
    assert.equal(run.resolved?.strategy, 'a11y_id');
    assertStepBudget(run);
  });

  it('the list form keeps its `{by: id}` target — the cell form is additive (issue #19)', () => {
    const tree = normalizeTree(loadFixtureTree('client_picker'), { platform: 'ios' });
    const run = toRunStep(ctx.map, recipe().steps.find((s) => s.id === 's4')!, PARAMS, { tree });
    assert.equal(run.element, 'client.picker.list');
    assert.deepEqual(run.target, { by: 'id', id: 'client.picker.list' });
  });

  it('07 §3: intent_critical steps announce only when the caller says the recipe is a candidate', () => {
    const s5 = recipe().steps.find((s) => s.id === 's5')!;
    assert.equal(toRunStep(ctx.map, s5, PARAMS, { announce: true }).announce, true);
    assert.equal(toRunStep(ctx.map, s5, PARAMS, { announce: false }).announce, undefined);
    const s1 = recipe().steps[0]!;
    assert.equal(toRunStep(ctx.map, s1, PARAMS, { announce: true }).announce, undefined);
  });

  it('a dismiss_gate step names the gate and its registered dismiss control', () => {
    const step = toRunStep(ctx.map, { id: 's0', action: 'dismiss_gate', gate: 'gate.push_permission' }, {});
    assert.equal(step.gate, 'gate.push_permission');
    assert.equal(step.element, 'gate.push_permission.deny');
  });

  it('every step formats inside the 120-token budget', () => {
    const tree = normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' });
    for (const { step } of expandSteps(ctx.map, recipe())) {
      const text = formatRunStep(toRunStep(ctx.map, step, PARAMS, { tree, announce: true }));
      assert.ok(estimateTokens(text) <= STEP_MAX_TOKENS, `${step.id}: ${text}`);
    }
  });
});

describe('checkExpect', () => {
  const tree = () => normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' });
  const focused = () => normalizeTree(loadFixtureTree('invoice_new.amount_focused'), { platform: 'ios' });

  it('screen', () => {
    assert.deepEqual(checkExpect(ctx.map, { screen: 'invoice_new' }, tree(), 'invoice_new'), { ok: true, failed: [] });
    assert.deepEqual(checkExpect(ctx.map, { screen: 'invoice_detail' }, tree(), 'invoice_new'), { ok: false, failed: ['screen:invoice_detail'] });
  });

  it('focused / visible / not_visible', () => {
    assert.equal(checkExpect(ctx.map, { focused: 'invoice.amount.field' }, focused(), 'invoice_new').ok, true);
    assert.equal(checkExpect(ctx.map, { focused: 'invoice.amount.field' }, tree(), 'invoice_new').ok, false);
    assert.equal(checkExpect(ctx.map, { visible: ['invoice.save.button'] }, tree(), 'invoice_new').ok, true);
    assert.deepEqual(checkExpect(ctx.map, { visible: ['invoice.detail.amount.text'] }, tree(), 'invoice_new').failed, ['visible:invoice.detail.amount.text']);
    assert.equal(checkExpect(ctx.map, { not_visible: ['invoice.detail.amount.text'] }, tree(), 'invoice_new').ok, true);
    assert.deepEqual(checkExpect(ctx.map, { not_visible: ['invoice.save.button'] }, tree(), 'invoice_new').failed, ['not_visible:invoice.save.button']);
  });

  it('text_present compares against node labels (architecture §7 decision 29)', () => {
    assert.equal(checkExpect(ctx.map, { text_present: 'New Invoice' }, tree(), 'invoice_new').ok, true);
    assert.equal(checkExpect(ctx.map, { text_present: 'Nope' }, tree(), 'invoice_new').ok, false);
  });

  it('a step without expect inherits "screen unchanged" (02 §6)', () => {
    assert.equal(checkExpect(ctx.map, undefined, tree(), 'invoice_new', { previousScreen: 'invoice_new' }).ok, true);
    assert.equal(checkExpect(ctx.map, undefined, tree(), 'invoice_new', { previousScreen: 'invoice_list' }).ok, false);
    // nothing to compare against: the step passes rather than blocking the run
    assert.equal(checkExpect(ctx.map, undefined, tree(), 'invoice_new').ok, true);
  });
});

// ---------------------------------------------------------------------------------------------
// 07 §3 execution policy
// ---------------------------------------------------------------------------------------------

describe('07 §3: the server refuses to run against a Release build or outside the sandbox', () => {
  const probeOf = (over: Partial<BuildProbeResult>): BuildProbeResult => ({
    schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app',
    version: '1.0', build_number: '4412', git_sha: 'abc', ...over,
  });

  it('assertDebugSandbox accepts only a sandbox Debug build', () => {
    assert.doesNotThrow(() => assertDebugSandbox(probeOf({})));
    assert.throws(() => assertDebugSandbox(null), isCode(ERROR_CODES.RELEASE_BUILD_REFUSED));
    assert.throws(() => assertDebugSandbox(probeOf({ build_type: 'release' })), isCode(ERROR_CODES.RELEASE_BUILD_REFUSED));
    assert.throws(() => assertDebugSandbox(probeOf({ sandbox: false })), isCode(ERROR_CODES.RELEASE_BUILD_REFUSED));
  });

  it('a probe that finds no endpoint (Release) refuses the run', async () => {
    drive('invoice_list');
    await assert.rejects(
      () => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: async () => null }),
      isCode(ERROR_CODES.RELEASE_BUILD_REFUSED),
    );
    assert.equal(ctx.db.listRuns().length, 0);
  });

  it('a Release probe refuses the run', async () => {
    drive('invoice_list');
    await assert.rejects(
      () => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: async () => probeOf({ build_type: 'release' }) }),
      isCode(ERROR_CODES.RELEASE_BUILD_REFUSED),
    );
  });

  it('a probe that throws is treated as absent, not as a crash', async () => {
    drive('invoice_list');
    await assert.rejects(
      () => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: async () => { throw new Error('simctl missing'); } }),
      isCode(ERROR_CODES.RELEASE_BUILD_REFUSED),
    );
  });

  it('the default probe returns null instead of throwing when the toolchain is absent', async () => {
    // no simulator/emulator in the test environment: `xcrun`/`adb` fail and the answer is `null`
    assert.equal(await defaultBuildProbe(t.config, 'com.example.app'), null);
    assert.equal(await defaultBuildProbe(t.config, ''), null);
  });

  it('a Debug sandbox probe starts the run and is cached on ctx.probe (02 §4.3 variant facts)', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: debugProbe });
    assert.equal(started.mode, 'guided');
    assert.equal(ctx.probe?.build_type, 'debug');
    assert.equal(ctx.probe?.auth, 'logged_in');
  });
});

describe('07 §3 build probe: the iOS 26 defaults regression and the app container fallback', () => {
  /** a real `plutil -convert xml1` domain: the probe, and a `Data` value that breaks `-convert json` */
  const PROBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>favorites</key>
  <data>
  YnBsaXN0MDDUAQIDBAUIJihYJHZlcnNpb25ZJGFyY2hpdmVy
  </data>
  <key>app_map_debug_probe</key>
  <dict>
    <key>app_id</key>
    <string>com.example.app</string>
    <key>build_number</key>
    <string>1</string>
    <key>build_type</key>
    <string>debug</string>
    <key>git_sha</key>
    <string>0000000</string>
    <key>sandbox</key>
    <true/>
    <key>schema_version</key>
    <integer>1</integer>
    <key>version</key>
    <string>1.0</string>
    <key>written_at</key>
    <string>2026-09-13T01:21:29Z</string>
  </dict>
  <key>lastScreen</key>
  <string>invoice_list</string>
</dict>
</plist>
`;
  /** the Release case: the app ran and saved preferences, but published no record */
  const NO_PROBE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>favorites</key>
  <data>YnBsaXN0MDDUAQIDBAUIJihYJHZlcnNpb24=</data>
  <key>lastScreen</key>
  <string>invoice_list</string>
</dict>
</plist>
`;

  /**
   * A fake iOS toolchain (`xcrun` + `plutil`) on PATH for the duration of `run`, so the real
   * `defaultBuildProbe` is exercised end to end (POSIX sh; the CI matrix for this suite is
   * linux/macOS — same assumption `makeFakeDevice` in cli.test.ts already makes). PATH is restored
   * in a `finally`; the suite runs `--test-concurrency=1` and node:test runs a file serially, so
   * nothing else ever sees the fake binaries.
   */
  async function withFakeIosToolchain(
    opts: { defaultsExport: string; plistName?: string; plistXml?: string },
    run: () => Promise<void>,
  ): Promise<void> {
    const bin = join(t.dir, '.local', 'fakebin');
    // the space in the container path proves `"$( … )"` keeps it one word (07 §4)
    const container = join(t.dir, '.local', 'app container');
    mkdirSync(bin, { recursive: true });
    if (opts.plistName !== undefined && opts.plistXml !== undefined) {
      mkdirSync(join(container, 'Library', 'Preferences'), { recursive: true });
      writeFileSync(join(container, 'Library', 'Preferences', opts.plistName), opts.plistXml);
    }
    writeFileSync(join(bin, 'xcrun'), [
      '#!/bin/sh',
      'case "$2" in',
      `  spawn) printf '%s' ${JSON.stringify(opts.defaultsExport)} ;;`,
      `  get_app_container) printf '%s\\n' ${JSON.stringify(container)} ;;`,
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    // `-convert json -o - -` reads the pipe; `-convert xml1 -o - <file>` prints the file and exits
    // non-zero when it is absent — which is how a strategy fails instead of answering
    writeFileSync(join(bin, 'plutil'), [
      '#!/bin/sh',
      'case "$2" in',
      '  json) cat ;;',
      '  xml1) cat "$5" ;;',
      '  *) exit 1 ;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      await run();
    } finally {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  }

  it('buildProbeStrategies tries `defaults export` first and the app container plist second (07 §3)', () => {
    const [first, second, ...rest] = buildProbeStrategies(t.config, 'com.example.app', BUILD_PROBE_KEY);
    assert.equal(rest.length, 0);
    assert.equal(first?.format, 'json');
    assert.match(first?.command ?? '', /xcrun simctl spawn .* defaults export .* \| plutil -convert json -o - -$/);
    assert.equal(second?.format, 'xml1');
    assert.match(second?.command ?? '', /xcrun simctl get_app_container /);
    // `-o -` is what keeps `plutil -convert` from rewriting the app's own preferences in place
    assert.match(second?.command ?? '', /^plutil -convert xml1 -o - /);
    // Android keeps its single `run-as` read
    const android = buildProbeStrategies({ ...t.config, platform: 'android' }, 'com.example.app', BUILD_PROBE_KEY);
    assert.equal(android.length, 1);
    assert.equal(android[0]?.format, 'json');
    assert.match(android[0]?.command ?? '', /^adb shell run-as 'com\.example\.app' cat files\/app_map_debug_probe\.json$/);
  });

  it('buildProbeStrategies quotes app_id and the udid everywhere, including inside the $(…) container path (07 §4)', () => {
    const udid = "a'b;rm -rf /";
    const appId = "com.example.app'; touch pwned #";
    const [first, second] = buildProbeStrategies({ ...t.config, simUdid: udid }, appId, BUILD_PROBE_KEY);
    assert.equal(
      first?.command,
      `xcrun simctl spawn 'a'\\''b;rm -rf /' defaults export 'com.example.app'\\''; touch pwned #' - | plutil -convert json -o - -`,
    );
    // the container path is `"$( … )"` plus a SEPARATE quoted word — `appId` is never inside the
    // double quotes, where a `$( )` or backtick in a bundle id would be executed
    assert.equal(
      second?.command,
      `plutil -convert xml1 -o - "$(xcrun simctl get_app_container 'a'\\''b;rm -rf /' 'com.example.app'\\''; touch pwned #' data)"`
      + `/Library/Preferences/'com.example.app'\\''; touch pwned #.plist'`,
    );
  });

  it('readBuildProbe stops at the first strategy that finds a record and never runs the rest', async () => {
    const calls: string[] = [];
    const probe = await readBuildProbe(
      [{ command: 'defaults', format: 'json' }, { command: 'container', format: 'xml1' }],
      BUILD_PROBE_KEY,
      async (command) => {
        calls.push(command);
        return JSON.stringify({ [BUILD_PROBE_KEY]: { build_type: 'debug', sandbox: true, app_id: 'com.example.app' } });
      },
    );
    assert.equal(probe?.build_type, 'debug');
    assert.deepEqual(calls, ['defaults']);
  });

  it('readBuildProbe falls through a domain with no record (the iOS 26 `{}`) to the next strategy', async () => {
    const calls: string[] = [];
    const outputs = ['{}', PROBE_XML];
    const probe = await readBuildProbe(
      [{ command: 'defaults', format: 'json' }, { command: 'container', format: 'xml1' }],
      BUILD_PROBE_KEY,
      async (command) => { calls.push(command); return outputs[calls.length - 1] ?? ''; },
    );
    assert.equal(probe?.build_type, 'debug');
    assert.equal(probe?.sandbox, true);
    assert.deepEqual(calls, ['defaults', 'container']);
  });

  it('readBuildProbe treats a failing strategy as "keep looking", not as the answer', async () => {
    let calls = 0;
    const probe = await readBuildProbe(
      [{ command: 'defaults', format: 'json' }, { command: 'container', format: 'xml1' }],
      BUILD_PROBE_KEY,
      async () => {
        calls += 1;
        // what `plutil -convert json` does on a domain that holds any Data value
        if (calls === 1) throw new Error('invalid object in plist for destination format');
        return PROBE_XML;
      },
    );
    assert.equal(probe?.build_type, 'debug');
    assert.equal(calls, 2);
  });

  it('parseProbeOutput reads the exported domain, a bare record, and an xml1 domain whose other keys are Data', () => {
    const record = {
      schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app',
      version: '1.0', build_number: '1', git_sha: '0000000',
    };
    assert.equal(parseProbeOutput(JSON.stringify({ [BUILD_PROBE_KEY]: record }), BUILD_PROBE_KEY, 'json')?.build_type, 'debug');
    assert.equal(parseProbeOutput(JSON.stringify(record), BUILD_PROBE_KEY, 'json')?.build_type, 'debug');
    // the `<data>` sibling is exactly what makes `plutil -convert json` refuse the whole file
    const fromXml = parseProbeOutput(PROBE_XML, BUILD_PROBE_KEY, 'xml1');
    assert.equal(fromXml?.build_type, 'debug');
    assert.equal(fromXml?.sandbox, true);
    assert.equal(fromXml?.app_id, 'com.example.app');
    assert.equal(fromXml?.build_number, '1');
    assert.equal(fromXml?.written_at, '2026-09-13T01:21:29Z');
    // no record published, and output that is not a property list at all
    assert.equal(parseProbeOutput(NO_PROBE_XML, BUILD_PROBE_KEY, 'xml1'), null);
    assert.equal(parseProbeOutput('{}', BUILD_PROBE_KEY, 'json'), null);
    assert.equal(parseProbeOutput('plutil: invalid object in plist for destination format', BUILD_PROBE_KEY, 'xml1'), null);
    assert.equal(parseProbeOutput('not json at all', BUILD_PROBE_KEY, 'json'), null);
  });

  it('parseXmlPlist drops <data> payloads, decodes entities and never throws on a truncated plist', () => {
    const parsed = parseXmlPlist(PROBE_XML) as Record<string, unknown>;
    assert.equal(parsed.favorites, null, 'a Data value is dropped, not a parse failure');
    assert.equal(parsed.lastScreen, 'invoice_list');
    const entities = parseXmlPlist(
      '<plist version="1.0"><dict><key>a &amp; b</key><string>&lt;x&gt; &#65;&#x42;</string>'
      + '<key>n</key><array><integer>2</integer><real>1.5</real><false/></array></dict></plist>',
    ) as Record<string, unknown>;
    assert.deepEqual(entities, { 'a & b': '<x> AB', n: [2, 1.5, false] });
    // best effort, never a throw and never a spin: a half-written file keeps what it read, a
    // numeric entity outside the code-point range is left alone, junk is simply not a plist
    assert.deepEqual(parseXmlPlist('<plist><dict><key>a</key><dict><key>b</key>'), { a: {} });
    assert.deepEqual(parseXmlPlist('<plist><dict><key>a</key><string>&#xFFFFFFFF;</string></dict></plist>'), { a: '&#xFFFFFFFF;' });
    assert.equal(parseXmlPlist('not xml'), null);
    assert.equal(parseXmlPlist('plutil: <unterminated'), null);
  });

  it('iOS 26: `defaults export` prints {} and the probe is still read out of the app container (07 §3)', async () => {
    await withFakeIosToolchain(
      { defaultsExport: '{}', plistName: 'com.example.app.plist', plistXml: PROBE_XML },
      async () => {
        const probe = await defaultBuildProbe(t.config, 'com.example.app');
        assert.equal(probe?.build_type, 'debug');
        assert.equal(probe?.sandbox, true);
        assert.equal(probe?.build_number, '1');
        assert.doesNotThrow(() => assertDebugSandbox(probe));
      },
    );
  });

  it('a Release build publishes no record, so every strategy comes back empty and the run is still refused (07 §3)', async () => {
    await withFakeIosToolchain(
      { defaultsExport: '{}', plistName: 'com.example.app.plist', plistXml: NO_PROBE_XML },
      async () => {
        assert.equal(await defaultBuildProbe(t.config, 'com.example.app'), null);
        drive('invoice_list');
        await assert.rejects(
          () => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, {}),
          isCode(ERROR_CODES.RELEASE_BUILD_REFUSED),
        );
        assert.equal(ctx.db.listRuns().length, 0);
      },
    );
  });

  it('an app_id with shell metacharacters is read as a literal filename and executes nothing (07 §4)', async () => {
    const hostile = "com.example.app'; touch pwned #";
    await withFakeIosToolchain(
      { defaultsExport: '{}', plistName: `${hostile}.plist`, plistXml: PROBE_XML },
      async () => {
        // found under its hostile literal name: the quoting survived the `$( … )` nesting
        assert.equal((await defaultBuildProbe(t.config, hostile))?.build_type, 'debug');
      },
    );
    // and a bundle id carrying a command substitution never runs it — the reporter's patch, which
    // interpolated `${appId}` raw inside the double-quoted container path, would have
    const pwned = join(t.dir, '.local', 'pwned');
    assert.equal(await defaultBuildProbe(t.config, `com.example.app$(touch ${pwned})`), null);
    assert.equal(existsSync(pwned), false);
  });
});

// ---------------------------------------------------------------------------------------------
// run_recipe preconditions
// ---------------------------------------------------------------------------------------------

describe('startGuidedRun preconditions', () => {
  it('an unknown, retired or off-platform recipe is recipe_unavailable', async () => {
    drive('invoice_list');
    await assert.rejects(() => startGuidedRun(ctx, { recipe_id: 'nope', params: {} }, noHooks), isCode(ERROR_CODES.RECIPE_UNAVAILABLE));
    const recipe = ctx.map.recipes.get('create_invoice')!;
    ctx.db.putRecipe({ ...recipe, status: 'retired' }, { dirty: true, reason: 'test' });
    await assert.rejects(() => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks), isCode(ERROR_CODES.RECIPE_UNAVAILABLE));
    ctx.db.putRecipe({ ...recipe, platform: 'android' }, { dirty: true, reason: 'test' });
    await assert.rejects(() => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks), isCode(ERROR_CODES.RECIPE_UNAVAILABLE));
  });

  it('missing required params are bad_input naming them', async () => {
    drive('invoice_list');
    await assert.rejects(
      () => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: { amount: 50 } }, noHooks),
      (e: unknown) => isCode(ERROR_CODES.BAD_INPUT)(e) && /client/.test((e as Error).message),
    );
  });

  it('no observation at all is no_observation (a run needs a session to verify against)', async () => {
    await assert.rejects(() => startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks), isCode(ERROR_CODES.NO_OBSERVATION));
    assert.throws(() => resolveRunSession(ctx, undefined), isCode(ERROR_CODES.NO_OBSERVATION));
  });

  it('the run is pinned to the newest observation session and its last seq', async () => {
    drive('invoice_list');
    const seq = drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    const run = ctx.db.getRun(started.run_id)!;
    assert.equal(run.session, SESSION);
    assert.equal(run.start_seq, seq);
    assert.equal(run.last_seq, seq);
    assert.equal(run.state, 'active');
    assert.equal(run.current_step, 's0');
    assert.equal(run.step_index, -1);
    assert.deepEqual(resolveRunSession(ctx, SESSION), { session: SESSION, last_seq: seq });
  });
});

// ---------------------------------------------------------------------------------------------
// 04 §9: the whole create_invoice replay
// ---------------------------------------------------------------------------------------------

/** the trees the app shows after each create_invoice step, in order */
const HAPPY_PATH: ReadonlyArray<[string, string]> = [
  ['s0', 'invoice_new'],
  ['s1', 'invoice_new.amount_focused'],
  ['s2', 'invoice_new.amount_focused'],
  ['s3', 'client_picker'],
  ['s4', 'invoice_new'],
  ['s5', 'invoice_detail'],
];

describe('04 §9: guided replay of create_invoice completes with every step verified', () => {
  it('s0…s5 → done, verified, and the build is stamped on what was seen', async () => {
    ctx.close();
    t.cleanup();
    // a build the pilot has not been verified on, so the 02 §8 stamp is visible
    open({ APP_MAP_BUILD: '4413' });
    declareTask(ctx, SESSION, 'create an invoice for Acme Corp');
    drive('invoice_list');

    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, { probe: debugProbe });
    assert.equal(started.recipe, 'create_invoice');
    assert.equal(started.version, 3);
    assert.equal(started.step.id, 's0');
    assert.equal(started.step.action, 'open_link');
    assert.equal(started.step.url, 'appmap://invoice_new?fixture=logged_in');
    // 07 §3: a `verified` recipe runs intent_critical steps without announcing
    assert.equal(started.step.announce, undefined);

    let reportCalls = 0;
    let last: ReportStepResult | undefined;
    for (const [stepId, tree] of HAPPY_PATH) {
      drive(tree, stepId === 's0' ? { url: 'appmap://invoice_new?fixture=logged_in' } : {});
      last = await reportStep(ctx, { run_id: started.run_id, step_id: stepId, ok: true });
      reportCalls++;
      if (stepId !== 's5') {
        assert.equal(last.status, 'ok', `${stepId} → ${JSON.stringify(last)}`);
        assert.equal(last.status === 'ok' && last.healed, undefined);
      }
    }
    assert.equal(last?.status, 'done');
    assert.equal(last?.status === 'done' && last.verified, true);
    assert.deepEqual(last?.status === 'done' && last.heals, []);

    // 04 §9 "≤5 LLM tool calls beyond run_recipe/report_step and no screenshots": one report per
    // step, no retries, no perception calls in between
    assert.equal(reportCalls, HAPPY_PATH.length);
    assert.equal(ctx.db.getSession(SESSION)?.screenshots, 0);

    const run = ctx.db.getRun(started.run_id)!;
    assert.equal(run.state, 'done');
    assert.equal(run.fallbacks, 0);
    assert.ok(run.finished_at !== undefined);

    // 02 §8 / 08 §5 row 5: the recipe and the screens seen carry the new build
    assert.equal(ctx.db.getRecipe('create_invoice')?.last_verified_build, '4413');
    for (const screen of ['invoice_new', 'client_picker', 'invoice_detail']) {
      assert.equal(ctx.db.getScreen(screen)?.meta.last_verified_build, '4413', screen);
    }
    // 08 §2: one recipe_run (ok, no fallbacks) and the task closed on `done`
    const runs = events('recipe_run');
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.kind === 'recipe_run' && runs[0]!.ok, true);
    assert.equal(runs[0]!.kind === 'recipe_run' && runs[0]!.mode, 'guided');
    assert.equal(runs[0]!.kind === 'recipe_run' && runs[0]!.steps_done, 6);
    assert.equal(runs[0]!.kind === 'recipe_run' && runs[0]!.fallbacks, 0);
    const tasks = events('task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.kind === 'task' && tasks[0]!.mode_end, 'guided');
    assert.equal(tasks[0]!.kind === 'task' && tasks[0]!.ok, true);
    assertEventsValid();
  });

  it('a recipe whose `select` names the cell replays to done, addressing the row by text (issue #19)', async () => {
    const recipe = ctx.map.recipes.get('create_invoice')!;
    const cellForm: RecipeStep = { id: 's4', action: 'select', cell: 'client.picker.cell', match: { text: '{client}' }, expect: { screen: 'invoice_new' } };
    ctx.db.putRecipe({ ...recipe, steps: recipe.steps.map((st) => (st.id === 's4' ? cellForm : st)) }, { dirty: true, reason: 'test' });
    declareTask(ctx, SESSION, 'create an invoice for Acme Corp');
    drive('invoice_list');

    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    let last: ReportStepResult | undefined;
    let handedS4: RunStep | undefined;
    for (const [stepId, tree] of HAPPY_PATH) {
      drive(tree, stepId === 's0' ? { url: 'appmap://invoice_new?fixture=logged_in' } : {});
      last = await reportStep(ctx, { run_id: started.run_id, step_id: stepId, ok: true });
      if (stepId === 's3' && last.status === 'ok') handedS4 = last.step;
      if (stepId !== 's5') {
        assert.equal(last.status, 'ok', `${stepId} → ${JSON.stringify(last)}`);
        assert.equal(last.status === 'ok' && last.healed, undefined, 'the cell resolves; nothing is healed');
      }
    }
    // the step the LLM was handed for s4 addresses the row by its label, not by the shared id
    assert.equal(handedS4?.element, 'client.picker.cell');
    assert.deepEqual(handedS4?.target, { by: 'text', text: 'Acme Corp' });
    assert.equal(last?.status, 'done');
    assert.equal(last?.status === 'done' && last.verified, true);
    assert.deepEqual(last?.status === 'done' && last.heals, []);
  });

  it('reports out of order, for a finished run or for an unknown run are refused', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    await assert.rejects(() => reportStep(ctx, { run_id: started.run_id, step_id: 's3', ok: true }), isCode(ERROR_CODES.BAD_INPUT));
    await assert.rejects(() => reportStep(ctx, { run_id: 'run_nope', step_id: 's0', ok: true }), isCode(ERROR_CODES.RUN_NOT_ACTIVE));
    const run = ctx.db.getRun(started.run_id)!;
    ctx.db.updateRun({ ...run, state: 'done' });
    await assert.rejects(() => reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true }), isCode(ERROR_CODES.RUN_NOT_ACTIVE));
  });
});

describe('the run is pinned to its session (03 §2: many instances share one cache)', () => {
  it('observations recorded in another session are ignored', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    // another harness window drives the same app — its observation must not verify this run
    drive('invoice_new', { session: OTHER_SESSION });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'fallback');
    assert.equal(result.status === 'fallback' && result.fallback.reason, 'no_observation');
    assert.equal(result.status === 'fallback' && result.fallback.screen_seen, UNKNOWN_SCREEN);
  });

  it('`ok: true` alone is never trusted — without an observation the step falls back', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status === 'fallback' && result.fallback.reason, 'no_observation');
    assert.match(result.status === 'fallback' ? result.fallback.message : '', /snapshot/);
  });

  it('`ok: false` is not trusted either — the observation decides', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    drive('invoice_new', { url: 'appmap://invoice_new?fixture=logged_in' });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: false, note: 'the tap looked wrong' });
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' && result.step.id, 's1');
  });

  it('a consumed observation is never re-verified (run.last_seq advances)', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    drive('invoice_new', { url: 'appmap://invoice_new?fixture=logged_in' });
    assert.equal((await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true })).status, 'ok');
    // no new driver call happened, so the s0 observation must NOT verify s1
    const stale = await reportStep(ctx, { run_id: started.run_id, step_id: 's1', ok: true });
    assert.equal(stale.status === 'fallback' && stale.fallback.reason, 'no_observation');
  });

  it('without hooks, a `snapshot` argument is recorded and verified (04 §5)', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    const result = await reportStep(ctx, {
      run_id: started.run_id, step_id: 's0', ok: true,
      snapshot: normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' }),
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.status === 'ok' && result.step.id, 's1');
  });
});

// ---------------------------------------------------------------------------------------------
// gates (04 §5: max 2 dismissals per step)
// ---------------------------------------------------------------------------------------------

describe('gates interrupt a step and are dismissed at most twice', () => {
  async function runWithGate(): Promise<{ run_id: string }> {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    return { run_id: started.run_id };
  }

  it('a gate on s0 yields a dismiss_gate step and the step to retry', async () => {
    const { run_id } = await runWithGate();
    drive('invoice_list.with_gate');
    const gate = await reportStep(ctx, { run_id, step_id: 's0', ok: true });
    assert.equal(gate.status, 'gate');
    assert.equal(gate.status === 'gate' && gate.retry, 's0');
    const step = gate.status === 'gate' ? gate.step : ({} as RunStep);
    assert.equal(step.action, 'dismiss_gate');
    assert.equal(step.gate, 'gate.push_permission');
    assert.equal(step.element, 'gate.push_permission.deny');
    // the pilot alert carries no id on the dismiss control, so it resolves by role+label
    assert.deepEqual(step.target, { by: 'role_label', role: 'button', label: 'Don\u2019t Allow' });
    assertStepBudget(step);
    // the run still waits for s0
    assert.equal(ctx.db.getRun(run_id)?.current_step, 's0');
    assert.equal(ctx.db.getRun(run_id)?.state, 'active');

    // the retry lands on invoice_new: the step verifies and s1 is handed out
    drive('invoice_new');
    const ok = await reportStep(ctx, { run_id, step_id: 's0', ok: true });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.status === 'ok' && ok.step.id, 's1');
  });

  it('a third gate on the same step falls back with gate_limit', async () => {
    const { run_id } = await runWithGate();
    for (let i = 0; i < GUIDED_LIMITS.gate_dismissals_per_step; i++) {
      drive('invoice_list.with_gate');
      const r = await reportStep(ctx, { run_id, step_id: 's0', ok: true });
      assert.equal(r.status, 'gate', `dismissal ${i + 1}`);
    }
    drive('invoice_list.with_gate');
    const last = await reportStep(ctx, { run_id, step_id: 's0', ok: true });
    assert.equal(last.status, 'fallback');
    assert.equal(last.status === 'fallback' && last.fallback.reason, 'gate_limit');
    assert.equal(last.status === 'fallback' && last.fallback.step, 's0');
    assert.equal(ctx.db.getRun(run_id)?.state, 'fallback');
    assertEventsValid();
  });
});

// ---------------------------------------------------------------------------------------------
// expect failures (04 §5 → guided_fallback)
// ---------------------------------------------------------------------------------------------

describe('a failed expectation falls back and is logged as guided_fallback (04 §5, 08 §2)', () => {
  it('the deep link landing on the wrong screen ends the run in fallback', async () => {
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: 'create_invoice', params: PARAMS }, noHooks);
    drive('login');
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'fallback');
    assert.equal(result.status === 'fallback' && result.fallback.reason, 'expect_failed');
    assert.equal(result.status === 'fallback' && result.fallback.screen_seen, 'login');
    assert.deepEqual(result.status === 'fallback' ? result.fallback.expected : undefined, { screen: 'invoice_new' });

    const run = ctx.db.getRun(started.run_id)!;
    assert.equal(run.state, 'fallback');
    assert.equal(run.fallbacks, 1);
    const ev = events('recipe_run')[0]!;
    assert.equal(ev.kind === 'recipe_run' && ev.ok, false);
    assert.equal(ev.kind === 'recipe_run' && ev.fallbacks, 1);
    assert.equal(ev.kind === 'recipe_run' && ev.fallback_step, 's0');
    assert.equal(ev.kind === 'recipe_run' && ev.mode, 'guided');
  });
});

// ---------------------------------------------------------------------------------------------
// healing inside a guided run (04 §7.2 rule 3 across tool calls)
// ---------------------------------------------------------------------------------------------

/** a two-step recipe on `invoice_list` whose only step taps a NON intent_critical button */
const OPEN_NEW: RecipeFile = {
  id: 'open_new_invoice', version: 1, platform: 'ios',
  description: 'Open the new-invoice screen from the list',
  matches: ['open the new invoice screen'], params: [],
  entry: { deep_link: 'appmap://invoice_list' },
  steps: [{ id: 's1', action: 'tap', element: 'invoice.add.button', expect: { screen: 'invoice_new' } }],
  verify: { screen: 'invoice_new', visible: ['invoice.save.button'] },
  status: 'verified', provenance: { compiled_from: 'traj_test', compiled_by: 'app-map-mcp@0.1.0' },
};

describe('a degraded resolution heals the next step and settles on the following report', () => {
  /** the add button lost its id and was relabelled in the new build */
  const renamed = (tree: Tree): void => {
    const n = node(tree, byId('invoice.add.button'));
    delete n.a11y_id;
    n.label = 'Add invoice';
  };

  async function startHealRun(): Promise<{ run_id: string; healing: RunStep }> {
    withStaticLabel('Add invoice');
    ctx.db.putRecipe(OPEN_NEW, { dirty: true, reason: 'test' });
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: OPEN_NEW.id, params: {} }, noHooks);
    assert.equal(started.step.id, 's0');
    drive('invoice_list', { mutate: renamed, url: 'appmap://invoice_list' });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'ok');
    const step = result.status === 'ok' ? result.step : ({} as RunStep);
    return { run_id: started.run_id, healing: step };
  }

  it('hands the candidate out as the target with healing:true and persists pending_heal', async () => {
    const { run_id, healing } = await startHealRun();
    assert.equal(healing.id, 's1');
    assert.equal(healing.healing, true);
    assert.deepEqual(healing.target, { by: 'role_label', role: 'button', label: 'Add invoice' });
    assertStepBudget(healing);
    const pending = ctx.db.getRun(run_id)?.pending_heal;
    assert.ok(pending !== undefined);
    assert.equal(pending.step, 's1');
    assert.equal(pending.element, 'invoice.add.button');
    assert.equal(pending.old_strategy, 'a11y_id');
    assert.equal(pending.candidate.proposed_locator.strategy, 'role_label');
    assert.ok(pending.candidate.score >= 0.75);
    // 04 §7.2 rule 3: nothing is written until the postcondition holds
    assert.equal(ctx.db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'verified');
    assert.deepEqual(events('heal'), []);
  });

  it('the postcondition holding applies the heal, reports `healed` and writes the element', async () => {
    const { run_id } = await startHealRun();
    drive('invoice_new');
    const done = await reportStep(ctx, { run_id, step_id: 's1', ok: true });
    assert.equal(done.status, 'done');
    assert.equal(done.status === 'done' && done.verified, true);
    const heals = done.status === 'done' ? done.heals : [];
    assert.equal(heals.length, 1);
    assert.deepEqual({ ...heals[0]!, score: 0 }, { step: 's1', element: 'invoice.add.button', old_strategy: 'a11y_id', new_strategy: 'role_label', score: 0 });
    assert.ok(heals[0]!.score >= 0.75);

    const stored = ctx.db.getScreen('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    assert.equal(stored.status, 'healed_pending_review');
    assert.deepEqual(stored.locators[0], { strategy: 'role_label', value: { role: 'button', label: 'Add invoice' }, weight: 0.6 });
    assert.deepEqual(ctx.db.listPendingHeals(), [{ screen: 'invoice_list', element: 'invoice.add.button' }]);
    assert.equal(ctx.db.getRun(run_id)?.pending_heal, undefined);
    const ev = events('heal')[0]!;
    assert.equal(ev.kind === 'heal' && ev.accepted, true);
    assert.equal(ev.kind === 'heal' && ev.run_id, run_id);
    assert.equal(ev.kind === 'heal' && ev.step, 's1');
  });

  // 04 §9 bullet 4 / 03 §12 bullet 3: the id is REMOVED but the label is kept. The role_label
  // fall-through sits exactly at DEGRADED_THRESHOLD, so it is degraded only because the authored
  // top locator missed — without that the canonical drift scenario never triggers 04 §7 healing.
  it('04 §9: removing the id while keeping the label heals by role_label and marks the element healed_pending_review', async () => {
    const idRemovedLabelKept = (tree: Tree): void => { delete node(tree, byId('invoice.add.button')).a11y_id; };
    ctx.db.putRecipe(OPEN_NEW, { dirty: true, reason: 'test' });
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: OPEN_NEW.id, params: {} }, noHooks);
    drive('invoice_list', { mutate: idRemovedLabelKept, url: 'appmap://invoice_list' });
    const handed = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(handed.status, 'ok');
    const step = handed.status === 'ok' ? handed.step : ({} as RunStep);
    assert.equal(step.id, 's1');
    assert.equal(step.healing, true, 'a fall-through to role_label is degraded and must propose a heal');
    assert.deepEqual(step.target, { by: 'role_label', role: 'button', label: 'New Invoice' });

    drive('invoice_new');
    const done = await reportStep(ctx, { run_id: started.run_id, step_id: 's1', ok: true });
    assert.equal(done.status, 'done');
    assert.equal(done.status === 'done' && done.verified, true);
    assert.equal(done.status === 'done' ? done.heals.length : 0, 1);
    const stored = ctx.db.getScreen('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    assert.equal(stored.status, 'healed_pending_review');
    assert.equal(stored.locators[0]?.strategy, 'role_label', 'the surviving locator is promoted to rank 0');
    // 04 §9: the diff must be visible after export
    assert.ok(ctx.db.listDirty().some((d) => d.kind === 'screen' && d.key === 'invoice_list'));
  });

  it('the postcondition failing rejects the heal (postcondition_failed) and falls back', async () => {
    const { run_id } = await startHealRun();
    // the tap did nothing: still on the list
    drive('invoice_list', { mutate: renamed });
    const result = await reportStep(ctx, { run_id, step_id: 's1', ok: true });
    assert.equal(result.status, 'fallback');
    assert.equal(result.status === 'fallback' && result.fallback.reason, 'heal_rejected');
    assert.equal(result.status === 'fallback' && result.fallback.step, 's1');
    const ev = events('heal')[0]!;
    assert.equal(ev.kind === 'heal' && ev.accepted, false);
    assert.equal(ev.kind === 'heal' && ev.reason, 'postcondition_failed');
    // nothing written, and the pending heal is cleared
    assert.equal(ctx.db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'verified');
    assert.equal(ctx.db.getRun(run_id)?.pending_heal, undefined);
  });

  it('the run state (including pending_heal) survives a fresh context between tool calls', async () => {
    const { run_id } = await startHealRun();
    const config = t.config;
    // simulate the next `report_step` arriving in a new process: a brand-new openContext
    ctx.close();
    const fresh = openContext(config, { logSink: 'none', skipRetention: true });
    try {
      const reloaded = fresh.db.getRun(run_id)!;
      assert.equal(reloaded.state, 'active');
      assert.equal(reloaded.current_step, 's1');
      assert.equal(reloaded.pending_heal?.candidate.proposed_locator.strategy, 'role_label');
      recordObservation(fresh, {
        session: SESSION, tool: 'mcp__argent__tap', input: {},
        snapshot: normalizeTree(loadFixtureTree('invoice_new'), { platform: 'ios' }), ok: true,
      });
      const done = await reportStep(fresh, { run_id, step_id: 's1', ok: true });
      assert.equal(done.status, 'done');
      assert.equal(done.status === 'done' && done.heals.length, 1);
      assert.equal(fresh.db.getScreen('invoice_list')?.elements.find((e) => e.id === 'invoice.add.button')?.status, 'healed_pending_review');
    } finally {
      fresh.close();
      // the afterEach hook closes `ctx`, which is already closed (close is idempotent)
    }
  });

  it('04 §5: only one heal per step — a second attempt falls back with heal_limit', async () => {
    withStaticLabel('Add invoice');
    ctx.db.putRecipe(OPEN_NEW, { dirty: true, reason: 'test' });
    drive('invoice_list');
    const started = await startGuidedRun(ctx, { recipe_id: OPEN_NEW.id, params: {} }, noHooks);
    // s1 has already used its single heal earlier in this run
    ctx.db.insertRunStep({ run_id: started.run_id, step_id: 's1', attempt: 1, gate_dismissals: 0, heals: GUIDED_LIMITS.heals_per_step, ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
    drive('invoice_list', { mutate: renamed, url: 'appmap://invoice_list' });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'fallback');
    assert.equal(result.status === 'fallback' && result.fallback.reason, 'heal_limit');
    assert.equal(result.status === 'fallback' && result.fallback.step, 's1');
    assert.deepEqual(events('heal'), []);
  });

  it('04 §7.3: a heal never writes YAML — only the cache and the dirty row', async () => {
    const screenFile = join(t.dir, 'ios', 'screens', 'invoice_list.yaml');
    const before = readFileSync(screenFile, 'utf8');
    const { run_id } = await startHealRun();
    drive('invoice_new');
    assert.equal((await reportStep(ctx, { run_id, step_id: 's1', ok: true })).status, 'done');
    assert.equal(readFileSync(screenFile, 'utf8'), before);
    assert.deepEqual(
      ctx.db.listDirty().filter((d) => d.kind === 'screen' && d.key === 'invoice_list').map((d) => d.reason),
      ['heal'],
    );
    assertEventsValid();
  });

  it('07 §3: a candidate recipe announces its intent_critical step before it is acted on', async () => {
    const recipe: RecipeFile = {
      ...OPEN_NEW, id: 'save_invoice_candidate', matches: ['save the invoice'], status: 'candidate',
      entry: { deep_link: 'appmap://invoice_new' },
      steps: [{ id: 's1', action: 'tap', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true }],
      verify: { screen: 'invoice_detail' },
    };
    ctx.db.putRecipe(recipe, { dirty: true, reason: 'test' });
    drive('invoice_new');
    const started = await startGuidedRun(ctx, { recipe_id: recipe.id, params: {} }, noHooks);
    drive('invoice_new', { url: 'appmap://invoice_new' });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'ok');
    const step = result.status === 'ok' ? result.step : ({} as RunStep);
    assert.equal(step.intent_critical, true);
    assert.equal(step.announce, true);
    assertStepBudget(step);
  });

  it('an intent_critical step whose label changed falls back with intent_critical_label_changed', async () => {
    withStaticLabel('Done');
    const recipe: RecipeFile = {
      ...OPEN_NEW, id: 'save_invoice', matches: ['save the invoice'],
      entry: { deep_link: 'appmap://invoice_new' },
      steps: [{ id: 's1', action: 'tap', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true }],
      verify: { screen: 'invoice_detail' },
    };
    ctx.db.putRecipe(recipe, { dirty: true, reason: 'test' });
    drive('invoice_new');
    const started = await startGuidedRun(ctx, { recipe_id: 'save_invoice', params: {} }, noHooks);
    drive('invoice_new', {
      url: 'appmap://invoice_new',
      mutate: (tree) => {
        const n = node(tree, byId('invoice.save.button'));
        delete n.a11y_id;
        n.label = 'Done';
      },
    });
    const result = await reportStep(ctx, { run_id: started.run_id, step_id: 's0', ok: true });
    assert.equal(result.status, 'fallback');
    const fb = result.status === 'fallback' ? result.fallback : undefined;
    assert.equal(fb?.reason, 'intent_critical_label_changed');
    assert.equal(fb?.step, 's1');
    assert.equal(fb?.screen_seen, 'invoice_new');
    assert.ok(fb!.candidates.length > 0 && fb!.candidates.length <= 3);
    const ev = events('heal')[0]!;
    assert.equal(ev.kind === 'heal' && ev.reason, 'intent_critical_label_changed');
    assert.equal(ev.kind === 'heal' && ev.intent_critical, true);
    assert.equal(ctx.db.getScreen('invoice_new')?.elements.find((e) => e.id === 'invoice.save.button')?.status, 'verified');
  });
});
