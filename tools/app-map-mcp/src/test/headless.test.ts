/** [C3] recipes/headless.ts — headless replay through Maestro (04 §6.1, 06 R6). No device, no LLM: every process call is injected. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { parse } from 'yaml';
import type { BuildProbeResult, HealCandidate, HealRecord, HealResult, HeadlessReport, RecipeFile, Tree, TreeNode } from '../types.ts';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { openContext } from '../context.ts';
import type { AppMapContext } from '../context.ts';
import { maestroFlowFile, schemaDir } from '../paths.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { readEvents } from '../events.ts';
import { walk } from '../tree.ts';
import type { ExecFn, ExecResult, HealFn, HierarchyProvider, LifecycleHooks } from '../recipes/headless.ts';
import {
  DEFAULT_MAX_RETRIES, checkMaestroVersion, fallbackStepFor, parseMaestroResult, requiredMaestroVersion, runAllHeadless, runHeadless,
} from '../recipes/headless.ts';
import { cloneTree, loadFixtureTree, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let ctx: AppMapContext;
before(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
after(() => {
  ctx.close();
  t.cleanup();
});

const okVersion: ExecResult = { code: 0, stdout: '1.39.2\n', stderr: '' };
const PASS: ExecResult = { code: 0, stdout: '✅ openLink\n✅ assertVisible\n', stderr: '' };
function failAt(index: number): ExecResult {
  return { code: 1, stdout: `Failed command index: ${index}\nElement not found: invoice.save.button\n`, stderr: '' };
}

interface Recorder { exec: ExecFn; calls: Array<{ cmd: string; args: string[] }>; testCalls: string[] }
/** fake `exec`: `--version` always succeeds; each `test` invocation consumes the next scripted result */
function recorder(testResults: ExecResult[], version: ExecResult = okVersion): Recorder {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const testCalls: string[] = [];
  let i = 0;
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args: [...args] });
    if (args[0] === '--version') return version;
    if (args[0] === 'test') {
      testCalls.push(args[1] as string);
      const r = testResults[i] ?? testResults[testResults.length - 1] ?? PASS;
      i++;
      return r;
    }
    return { code: 1, stdout: '', stderr: `unexpected exec ${cmd} ${args.join(' ')}` };
  };
  return { exec, calls, testCalls };
}

/** records the two lifecycle writes a headless run performs instead of calling C2/C1 code */
function lifecycleSpy(): LifecycleHooks & { verified: unknown[]; outcomes: unknown[] } {
  const verified: unknown[] = [];
  const outcomes: unknown[] = [];
  return {
    verified,
    outcomes,
    markVerified: (_ctx, entities, build) => { verified.push({ entities, build }); return {}; },
    recordRunOutcome: (_ctx, run, outcome) => { outcomes.push({ run: run.run_id, outcome }); return null; },
  };
}

const debugProbe: BuildProbeResult = { schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app', version: '2026.9.1', build_number: '4412', git_sha: 'a1b2c3d' };

function hierarchyOf(tree: Tree): HierarchyProvider {
  return async () => tree;
}

/** invoice_new with the save button's id gone (the app renamed it) — 04 §9 heal case */
function invoiceNewWithoutSaveId(): Tree {
  const tree = cloneTree(loadFixtureTree('invoice_new'));
  walk(tree, (n: TreeNode) => {
    if (n.a11y_id === 'invoice.save.button') delete n.a11y_id;
  });
  return tree;
}

const BASE = { skipBuildCheck: true, maxRetries: DEFAULT_MAX_RETRIES } as const;

describe('runHeadless — success (04 §6.1, 04 §9 "headless replay completes with zero LLM calls")', () => {
  it('exports the flow, runs it once and reports ok with every step done', async () => {
    const r = recorder([PASS]);
    const life = lifecycleSpy();
    const before = readEvents(t.config, {}).events.length;
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: r.exec, lifecycle: life });
    assert.equal(report.ok, true);
    assert.equal(report.mode, 'headless');
    assert.equal(report.steps, 6, 'entry s0 + s1…s5');
    assert.equal(report.steps_done, 6);
    assert.equal(report.retries, 0);
    assert.deepEqual(report.heals, []);
    assert.equal(report.error_code, undefined);
    assert.equal(report.fallback_step, undefined);
    assert.ok(report.ms >= 0);
    assert.equal(report.build, ctx.build);

    // the flow landed where 04 §6.1 says, with the params file's values substituted
    const flowPath = maestroFlowFile(t.config, 'create_invoice');
    assert.ok(existsSync(flowPath));
    assert.match(readFileSync(flowPath, 'utf8'), /inputText: "50"/);
    assert.deepEqual(r.testCalls, [flowPath]);
    // 03 §13: the version is checked before anything runs
    assert.deepEqual(r.calls[0], { cmd: 'maestro', args: ['--version'] });

    // 02 §8 / decision 32 + 08 §2
    assert.equal(life.verified.length, 1);
    assert.deepEqual((life.verified[0] as { entities: { recipe: string; screens: string[] } }).entities.recipe, 'create_invoice');
    assert.deepEqual((life.verified[0] as { entities: { screens: string[] } }).entities.screens.sort(), ['client_picker', 'invoice_detail', 'invoice_new']);
    assert.equal(life.outcomes.length, 1);
    const events = readEvents(t.config, {}).events.slice(before).filter((e) => e.kind === 'recipe_run');
    assert.equal(events.length, 1);
    assert.ok(events[0] && events[0].kind === 'recipe_run');
    assert.equal(events[0].ok, true);
    assert.equal(events[0].steps_done, 6);
  });

  it('passes --udid when APP_MAP_SIM_UDID is set (04 §10: headless owns its simulator)', async () => {
    const own = makeTempAppMapDir({ env: { APP_MAP_SIM_UDID: 'SIM-1234' } });
    const ownCtx = openContext(own.config, { logSink: 'none', skipRetention: true });
    try {
      const r = recorder([PASS]);
      await runHeadless(ownCtx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() });
      const testCall = r.calls.find((c) => c.args[0] === 'test');
      assert.ok(testCall);
      assert.deepEqual(testCall.args.slice(2), ['--udid', 'SIM-1234']);
    } finally {
      ownCtx.close();
      own.cleanup();
    }
  });
});

describe('runHeadless — gates (04 §6.1 step 3)', () => {
  it('dismisses a gate seen in the hierarchy and reruns from the failing step', async () => {
    // command 6 is the first command of s3 (see maestro.test.ts command_index)
    const r = recorder([failAt(6), PASS]);
    const life = lifecycleSpy();
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, {
      ...BASE,
      exec: r.exec,
      hierarchy: hierarchyOf(loadFixtureTree('invoice_list.with_gate')),
      lifecycle: life,
    });
    assert.equal(report.ok, true);
    assert.equal(report.retries, 1);
    assert.deepEqual(report.heals, []);
    assert.equal(r.testCalls.length, 2);
    const retryPath = maestroFlowFile(t.config, 'create_invoice.gate1');
    assert.equal(r.testCalls[1], retryPath);
    const cmds = parse((readFileSync(retryPath, 'utf8').split('\n---\n')[1]) as string) as Array<Record<string, unknown>>;
    // the retry starts at s3 and is preceded by the gate's runFlow guard (04 §6.2)
    assert.ok('runFlow' in (cmds[0] ?? {}), JSON.stringify(cmds[0]));
    assert.deepEqual(cmds[1], { tapOn: { id: 'invoice.client.picker' } });
  });
});

describe('runHeadless — healing (04 §6.1 step 3, 04 §7)', () => {
  it('heals the failing step, verifies by re-exporting from step k and reruns', async () => {
    // command 11 is the first command of s5 (tap invoice.save.button)
    const r = recorder([failAt(11), PASS]);
    const healCalls: Array<{ step: string; element: string; screen: string; intent_critical: boolean }> = [];
    const newLocator = { strategy: 'role_label' as const, value: { role: 'button' as const, label: 'Save' }, weight: 0.6 };
    const healer: HealFn = async (_ctx, input, verify) => {
      healCalls.push({ step: input.step.id, element: input.element.id, screen: input.screen, intent_critical: input.intent_critical });
      const candidate = { proposed_locator: newLocator, score: 0.88 } as unknown as HealCandidate;
      const held = await verify(candidate);
      const record: HealRecord = {
        recipe: input.recipe, step: input.step.id, element: input.element.id,
        old_strategy: 'a11y_id', new_strategy: 'role_label',
        score: 0.88, runner_up_score: 0.41, accepted: held, reason: held ? 'accepted' : 'postcondition_failed',
        intent_critical: input.intent_critical, build: input.build,
      };
      return { accepted: held, reason: record.reason, record, candidates: [] } as HealResult;
    };
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, {
      ...BASE,
      exec: r.exec,
      hierarchy: hierarchyOf(invoiceNewWithoutSaveId()),
      healer,
      lifecycle: lifecycleSpy(),
    });
    assert.equal(report.ok, true);
    assert.equal(report.retries, 1);
    assert.equal(report.heals.length, 1);
    assert.equal(report.heals[0]?.accepted, true);
    assert.equal(report.heals[0]?.step, 's5');
    // 04 §3.7: the step is marked intent_critical in the recipe
    assert.deepEqual(healCalls, [{ step: 's5', element: 'invoice.save.button', screen: 'invoice_new', intent_critical: true }]);
    const healPath = maestroFlowFile(t.config, 'create_invoice.heal1');
    assert.equal(r.testCalls[1], healPath);
    const cmds = parse((readFileSync(healPath, 'utf8').split('\n---\n')[1]) as string) as Array<Record<string, unknown>>;
    assert.deepEqual(cmds[0], { tapOn: { text: 'Save' } }, 'the candidate locator, not the stored a11y_id');
  });

  it('a rejected heal ends the run at that step (04 §7.2: fallback, not a retry loop)', async () => {
    const r = recorder([failAt(11)]);
    const healer: HealFn = async (_ctx, input) => {
      const record: HealRecord = {
        recipe: input.recipe, step: input.step.id, element: input.element.id, old_strategy: 'a11y_id',
        score: 0.81, runner_up_score: 0.3, accepted: false, reason: 'intent_critical_label_changed',
        intent_critical: true, build: input.build,
      };
      return { accepted: false, reason: 'intent_critical_label_changed', record, candidates: [] } as HealResult;
    };
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, {
      ...BASE, exec: r.exec, hierarchy: hierarchyOf(invoiceNewWithoutSaveId()), healer, lifecycle: lifecycleSpy(),
    });
    assert.equal(report.ok, false);
    assert.equal(report.fallback_step, 's5');
    assert.equal(report.error_code, 'maestro_failed');
    assert.equal(report.failed_command_index, 11);
    assert.equal(report.steps_done, 5);
    assert.equal(report.screen_seen, 'invoice_new');
    assert.equal(report.heals.length, 1);
    assert.equal(report.heals[0]?.accepted, false);
    assert.equal(r.testCalls.length, 1, 'no rerun after a rejected heal');
  });
});

describe('runHeadless — retry budget (04 §6.1 "max 2 retries")', () => {
  it('stops after the third failure and reports the step to fall back to', async () => {
    const r = recorder([failAt(6), failAt(8), failAt(11)]);
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, {
      ...BASE,
      exec: r.exec,
      hierarchy: hierarchyOf(loadFixtureTree('invoice_list.with_gate')),
      lifecycle: lifecycleSpy(),
    });
    assert.equal(r.testCalls.length, 3, '1 run + 2 retries');
    assert.equal(report.ok, false);
    assert.equal(report.retries, 2);
    assert.equal(report.fallback_step, 's5');
    assert.equal(report.steps_done, 5);
    assert.equal(report.error_code, 'maestro_failed');
    assert.equal(report.failed_command_index, 11);
    // 07 §2.4: the CI artifact carries closed codes, never Maestro's output
    const text = JSON.stringify(report);
    assert.ok(!text.includes('Element not found'), text);
    assert.ok(!text.includes('Failed command index'), text);
  });
});

describe('runHeadless — refusals (03 §13, 04 §6.2, 07 §3)', () => {
  it('maestro_unavailable when the version check fails', async () => {
    const r = recorder([PASS], { code: 0, stdout: '1.20.0\n', stderr: '' });
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() });
    assert.equal(report.ok, false);
    assert.equal(report.error_code, 'maestro_unavailable');
    assert.equal(r.testCalls.length, 0, 'nothing ran');
  });

  it('maestro_unavailable when the binary is missing', async () => {
    const r = recorder([PASS], { code: 127, stdout: '', stderr: 'maestro: command not found' });
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() });
    assert.equal(report.error_code, 'maestro_unavailable');
  });

  it('release_build_refused when the 07 §3 probe is absent or not a sandbox Debug build', async () => {
    const r = recorder([PASS]);
    const absent = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { exec: r.exec, probe: async () => null, lifecycle: lifecycleSpy() });
    assert.equal(absent.error_code, 'release_build_refused');
    const release = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { exec: r.exec, probe: async () => ({ ...debugProbe, build_type: 'release' }), lifecycle: lifecycleSpy() });
    assert.equal(release.error_code, 'release_build_refused');
    const notSandbox = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { exec: r.exec, probe: async () => ({ ...debugProbe, sandbox: false }), lifecycle: lifecycleSpy() });
    assert.equal(notSandbox.error_code, 'release_build_refused');
    assert.equal(r.testCalls.length, 0);
    // a good probe is cached for variant identification (02 §4.3, decision 20)
    await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { exec: r.exec, probe: async () => debugProbe, lifecycle: lifecycleSpy() });
    assert.deepEqual(ctx.probe, debugProbe);
  });

  it('not_headless_eligible when a step cannot be expressed (04 §6.2 last paragraph)', async () => {
    const base = ctx.map.recipes.get('create_invoice');
    assert.ok(base);
    // client_picker has `deep_link: none` (decision 9) → the entry step cannot be exported
    const viaPicker: RecipeFile = { ...base, id: 'pick_then_save', entry: { fallback_path: ['client_picker', 'invoice_new'] } };
    ctx.db.putRecipe(viaPicker, { dirty: false });
    const r = recorder([PASS]);
    const report = await runHeadless(ctx, { recipe_id: 'pick_then_save', params: { amount: 50, client: 'Acme Corp' } }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() });
    assert.equal(report.ok, false);
    assert.equal(report.error_code, 'not_headless_eligible');
    assert.equal(report.fallback_step, 's0');
    assert.equal(r.testCalls.length, 0);
  });

  it('bad_input before anything is exported when a required param has no value', async () => {
    const bare = makeTempAppMapDir({ withCiParams: false });
    const bareCtx = openContext(bare.config, { logSink: 'none', skipRetention: true });
    const r = recorder([PASS]);
    try {
      await assert.rejects(
        () => runHeadless(bareCtx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() }),
        (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT && e.message.includes('create_invoice.amount'),
      );
      assert.equal(r.testCalls.length, 0);
    } finally {
      bareCtx.close();
      bare.cleanup();
    }
  });

  it('not_found / recipe_unavailable for unknown or retired recipes', async () => {
    const r = recorder([PASS]);
    await assert.rejects(
      () => runHeadless(ctx, { recipe_id: 'nope', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.NOT_FOUND,
    );
    const base = ctx.map.recipes.get('create_invoice');
    assert.ok(base);
    ctx.db.putRecipe({ ...base, id: 'gone', status: 'retired' }, { dirty: false });
    await assert.rejects(
      () => runHeadless(ctx, { recipe_id: 'gone', params: {} }, { ...BASE, exec: r.exec, lifecycle: lifecycleSpy() }),
      (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.RECIPE_UNAVAILABLE,
    );
  });

  it('hierarchy_unavailable when the dump cannot be read after a failure', async () => {
    const r = recorder([failAt(6)]);
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, {
      ...BASE, exec: r.exec, hierarchy: async () => null, lifecycle: lifecycleSpy(),
    });
    assert.equal(report.error_code, 'hierarchy_unavailable');
    assert.equal(report.fallback_step, 's3');
  });

  it('timeout is its own closed code', async () => {
    const timeoutExec: ExecFn = async (_cmd, args) => (args[0] === '--version' ? okVersion : { code: 143, stdout: '', stderr: '', timed_out: true });
    const report = await runHeadless(ctx, { recipe_id: 'create_invoice', params: {} }, { ...BASE, exec: timeoutExec, lifecycle: lifecycleSpy() });
    assert.equal(report.error_code, 'timeout');
  });
});

describe('runAllHeadless — the 06 R6 heal report', () => {
  it('aggregates runs, accepted heals and needs_human into a heal-report.schema.json document', async () => {
    const r = recorder([failAt(11), PASS]);
    let first = true;
    const healer: HealFn = async (_ctx, input, verify) => {
      const accepted = first;
      first = false;
      if (accepted) await verify({ proposed_locator: { strategy: 'role_label', value: { role: 'button', label: 'Save' }, weight: 0.6 }, score: 0.88 } as unknown as HealCandidate);
      const record: HealRecord = {
        recipe: input.recipe, step: input.step.id, element: input.element.id,
        old_strategy: 'a11y_id', ...(accepted ? { new_strategy: 'role_label' as const } : {}),
        score: 0.88, runner_up_score: 0.41, accepted, reason: accepted ? 'accepted' : 'low_score',
        intent_critical: input.intent_critical, build: input.build,
      };
      return { accepted, reason: record.reason, record, candidates: [] } as HealResult;
    };
    const report = await runAllHeadless(ctx, {
      ...BASE, statuses: ['verified'], exec: r.exec, hierarchy: hierarchyOf(invoiceNewWithoutSaveId()), healer, lifecycle: lifecycleSpy(),
    });
    assert.equal(report.schema_version, 1);
    assert.equal(report.platform, 'ios');
    assert.equal(report.runs.length, 1);
    assert.equal(report.runs[0]?.recipe, 'create_invoice');
    assert.equal(report.heals.length, 1);
    assert.equal(report.needs_human.length, 0);
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'heal-report', report), []);
  });
});

describe('parseMaestroResult / checkMaestroVersion / fallbackStepFor (pure)', () => {
  it('reads the failing command index from the named marker or the ✅/❌ list', () => {
    assert.deepEqual(parseMaestroResult({ code: 0, stdout: '', stderr: '' }), { ok: true });
    const named = parseMaestroResult(failAt(7));
    assert.equal(named.ok, false);
    assert.equal(named.failed_command_index, 7);
    assert.equal(named.error_code, 'maestro_failed');
    const marked = parseMaestroResult({ code: 1, stdout: '✅ openLink\n✅ extendedWaitUntil\n❌ tapOn\n', stderr: '' });
    assert.equal(marked.failed_command_index, 2);
    const opaque = parseMaestroResult({ code: 1, stdout: 'something went wrong', stderr: '' });
    assert.equal(opaque.failed_command_index, undefined);
    assert.equal(opaque.error_code, 'maestro_failed');
    assert.equal(parseMaestroResult({ code: 143, stdout: '', stderr: '', timed_out: true }).error_code, 'timeout');
    assert.equal(parseMaestroResult({ code: 127, stdout: '', stderr: 'maestro: command not found' }).error_code, 'maestro_unavailable');
  });

  it('compares `maestro --version` against the package.json range (03 §13)', async () => {
    const range = requiredMaestroVersion();
    assert.equal(range, '>=1.39.0');
    const ok = await checkMaestroVersion(async () => ({ code: 0, stdout: '1.39.0', stderr: '' }), 'maestro', range);
    assert.deepEqual(ok, { ok: true, version: '1.39.0' });
    const newer = await checkMaestroVersion(async () => ({ code: 0, stdout: 'maestro 2.0.1', stderr: '' }), 'maestro', range);
    assert.equal(newer.ok, true);
    const older = await checkMaestroVersion(async () => ({ code: 0, stdout: '1.38.9', stderr: '' }), 'maestro', range);
    assert.equal(older.ok, false);
    assert.match(older.message ?? '', /does not satisfy >=1\.39\.0/);
    const missing = await checkMaestroVersion(async () => { throw new Error('spawn ENOENT'); }, 'maestro', range);
    assert.equal(missing.ok, false);
    const silent = await checkMaestroVersion(async () => ({ code: 0, stdout: 'hello', stderr: '' }), 'maestro', range);
    assert.equal(silent.ok, false);
  });

  it('fallbackStepFor maps a command index onto the step that owns it', () => {
    const index = { s0: 0, s1: 2, s2: 4, s3: 6 };
    assert.equal(fallbackStepFor(index, 0), 's0');
    assert.equal(fallbackStepFor(index, 3), 's1');
    assert.equal(fallbackStepFor(index, 99), 's3');
  });
});
