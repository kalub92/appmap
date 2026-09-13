/**
 * [D2] `bin/app-map` CLI (03 §10, 05 §3, docs/dev/harness-notes.md §4). The spawned cases cover
 * the contracts the hooks and the CI workflow rely on; `parseArgs` covers the flag grammar of
 * every command in the 03 §10 table (the wave-2 bodies are exercised by their own owners).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { RecipeFile, SessionStartHookOutput } from '../types.ts';
import { openContext } from '../context.ts';
import { estimateTokens } from '../token.ts';
import { parseArgs, USAGE } from '../cli.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { PACKAGE_ROOT, loadHookFixture, loadRouterExportFixture, makeTempAppMapDir, readFixture } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const BIN = join(PACKAGE_ROOT, 'bin', 'app-map');

interface CliRun { code: number; stdout: string; stderr: string }

function runCli(args: string[], opts: { dir?: string; input?: string; cwd?: string; env?: NodeJS.ProcessEnv } = {}): CliRun {
  const r = spawnSync(BIN, args, {
    encoding: 'utf8',
    cwd: opts.cwd ?? PACKAGE_ROOT,
    input: opts.input ?? '',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      ...(opts.dir !== undefined ? { APP_MAP_DIR: opts.dir } : {}),
      APP_MAP_LOG_LEVEL: 'error',
      ...opts.env,
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function withTemp(fn: (t: TempAppMapDir) => void, opts?: Parameters<typeof makeTempAppMapDir>[0]): void {
  const t = makeTempAppMapDir(opts);
  try {
    fn(t);
  } finally {
    t.cleanup();
  }
}

describe('app-map validate (03 §10, 06 R1)', () => {
  it('exits 0 on the pilot map', () => {
    withTemp((t) => {
      const r = runCli(['validate'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /ok/);
    });
  });

  it('exits 1 and names the dangling id when an id is renamed without migrate-id (06 §5)', () => {
    withTemp((t) => {
      const ids = join(t.dir, 'ids.yaml');
      // rename the registry entry only — every screen/recipe reference now dangles (02 §10 rule 2)
      writeFileSync(ids, readFileSync(ids, 'utf8').replace('id: invoice.add.button', 'id: invoice.addx.button'));
      const r = runCli(['validate'], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout + r.stderr, /invoice\.add\.button/, 'the dangling id must be named');
    });
  });

  it('--platform scopes the check', () => {
    withTemp((t) => {
      assert.equal(runCli(['validate', '--platform', 'android'], { dir: t.dir }).code, 0);
    });
  });
});

describe('app-map export (03 §4, 06 R1, harness-notes §4)', () => {
  it('--check exits 0 on the canonical pilot', () => {
    withTemp((t) => {
      const r = runCli(['export', '--check'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
    });
  });

  it('--check exits 1 and names a hand-edited non-canonical file', () => {
    withTemp((t) => {
      const file = join(t.dir, 'ios', 'screens', 'invoice_list.yaml');
      writeFileSync(file, `${readFileSync(file, 'utf8')}\n# hand-edited trailing comment\n`);
      const r = runCli(['export', '--check'], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /invoice_list\.yaml/);
    });
  });

  it('with nothing dirty prints no path and exits 0 (the Stop hook prints written paths one per line)', () => {
    withTemp((t) => {
      const r = runCli(['export'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout.trim(), '');
    });
  });
});

describe('app-map summary (05 §3, harness-notes §4)', () => {
  it('--max-tokens 600 prints plain text within the cap, with a build token and the recipes', () => {
    withTemp((t) => {
      const r = runCli(['summary', '--max-tokens', '600'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(estimateTokens(r.stdout) <= 600, `summary is ${estimateTokens(r.stdout)} tokens`);
      assert.match(r.stdout, /build 4412/, 'harness-notes §4: the hook greps a `build <n>` token');
      assert.match(r.stdout, /create_invoice/, 'the recipes block must list the recipes');
      assert.doesNotMatch(r.stdout, /^\{/, 'plain text, not JSON, without --hook-json');
    });
  });

  it('--hook-json emits a SessionStart hookSpecificOutput object', () => {
    withTemp((t) => {
      const r = runCli(['summary', '--max-tokens', '600', '--hook-json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      const payload = JSON.parse(r.stdout) as SessionStartHookOutput;
      assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
      assert.match(payload.hookSpecificOutput.additionalContext, /app-map is loaded for ios build 4412/);
      assert.match(payload.hookSpecificOutput.additionalContext, /Recipes: create_invoice/);
    });
  });

  it('honours APP_MAP_MAX_CONTEXT_TOKENS when --max-tokens is absent (03 §3)', () => {
    withTemp((t) => {
      const r = runCli(['summary'], { dir: t.dir, env: { APP_MAP_MAX_CONTEXT_TOKENS: '80' } });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(estimateTokens(r.stdout) <= 80, `summary is ${estimateTokens(r.stdout)} tokens`);
    });
  });
});

describe('app-map record --stdin (05 §3, harness-notes §4: ALWAYS exit 0)', () => {
  it('writes a trajectory line for a PostToolUse payload', () => {
    withTemp((t) => {
      const payload = loadHookFixture('post-tool-use.tap');
      const r = runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(payload)}\n` });
      assert.equal(r.code, 0, r.stderr);
      const dir = join(t.dir, '.local', 'trajectories');
      assert.ok(existsSync(dir), 'a trajectory directory must exist');
      const files = readdirSync(dir);
      assert.equal(files.length, 1, `expected one trajectory, got ${files.join(', ')}`);
      const lines = readFileSync(join(dir, files[0]!), 'utf8').split('\n').filter((l) => l.trim().length > 0);
      assert.equal(lines.length, 1);
      const obs = JSON.parse(lines[0]!) as { session: string; snapshot?: { scrubbed?: boolean } };
      assert.equal(obs.session, payload.session_id);
      assert.equal(obs.snapshot?.scrubbed, true, '07 §2: only scrubbed trees reach disk');
    });
  });

  it('accepts a PostToolUseFailure payload (tool_error, no tool_response)', () => {
    withTemp((t) => {
      const payload = loadHookFixture('post-tool-use-failure.tap');
      assert.equal(payload.tool_response, undefined, 'fixture shape: a failure payload carries no tool_response');
      const r = runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(payload)}\n` });
      assert.equal(r.code, 0, r.stderr);
    });
  });

  it('exits 0 on garbage and on an empty stdin', () => {
    withTemp((t) => {
      assert.equal(runCli(['record', '--stdin'], { dir: t.dir, input: 'not json at all\n' }).code, 0);
      assert.equal(runCli(['record', '--stdin'], { dir: t.dir, input: '' }).code, 0);
      // even a usage mistake must not fail the hook
      assert.equal(runCli(['record'], { dir: t.dir, input: '' }).code, 0);
    });
  });

  it('closes the task on a Stop payload', () => {
    withTemp((t) => {
      runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(loadHookFixture('post-tool-use.tap'))}\n` });
      const r = runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(loadHookFixture('stop'))}\n` });
      assert.equal(r.code, 0, r.stderr);
    });
  });
});

describe('app-map CI commands', () => {
  it('lint-ids passes on the committed repo (06 R2)', () => {
    const r = runCli(['lint-ids'], { cwd: join(PACKAGE_ROOT, '..', '..') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('policy-check passes on the committed repo (06 R3)', () => {
    const r = runCli(['policy-check'], { cwd: join(PACKAGE_ROOT, '..', '..') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('gen-configs --check passes on the committed repo (06 R2)', () => {
    const r = runCli(['gen-configs', '--check'], { cwd: join(PACKAGE_ROOT, '..', '..') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });

  it('report --json prints ReportMetrics for an empty window', () => {
    withTemp((t) => {
      const r = runCli(['report', '--since', '30d', '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      const metrics = JSON.parse(r.stdout) as { platform: string; alerts: string[] };
      assert.equal(metrics.platform, 'ios');
      assert.deepEqual(metrics.alerts, []);
    });
  });

  it('lint-ids --src adds a source root and fails on its string-literal ids (01 R8)', () => {
    const r = runCli(['lint-ids', '--src', join(PACKAGE_ROOT, 'fixtures', 'lint')], { cwd: join(PACKAGE_ROOT, '..', '..') });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /string_literal_id/);
    assert.match(r.stdout, /Bad\.swift:8/);
  });

  it('policy-check exits 1 and names every violation (06 §4)', () => {
    withTemp((t) => {
      // a throwaway repo root whose .mcp.json adds an unlisted, unpinned server
      const root = join(t.dir, '..', 'repo');
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { rogue: { command: 'npx', args: ['-y', 'rogue-mcp@latest'] } } }));
      const r = runCli(['policy-check', '--dir', t.dir], { cwd: root });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /unlisted_server/);
      assert.match(r.stdout, /unpinned_npx/);
    });
  });

  it('intent-critical-diff against HEAD is clean on the committed repo and exits 0 (07 §7)', () => {
    const r = runCli(['intent-critical-diff', 'HEAD'], { cwd: join(PACKAGE_ROOT, '..', '..') });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /No `intent_critical` changes against `HEAD`/);
  });

  it('export prints the written paths one per line after a dirty write (harness-notes §4)', () => {
    withTemp((t) => {
      // a lifecycle write dirties the recipe row; `export` then flushes it to canonical YAML
      const marked = runCli(['mark', 'create_invoice', 'ci_gate', '--reviewer', 'dana', '--force'], { dir: t.dir });
      assert.equal(marked.code, 0, marked.stdout + marked.stderr);
      const r = runCli(['export'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
      assert.deepEqual(lines, ['ios/recipes/create_invoice.yaml'], r.stdout);
      for (const line of lines) assert.match(line, /^[\w./-]+\.yaml$/, 'one relative path per line');
      assert.equal(runCli(['export', '--check'], { dir: t.dir }).code, 0, 'what export wrote is canonical');
    });
  });

  it('export names a machine recompile on stderr while stdout stays a bare path list (issue #13 criterion 4, harness-notes §4)', () => {
    withTemp((t) => {
      // stage what `lifecycle.recompileFrom` leaves behind once its 04 §8 guard passes: a recipe
      // row whose STEPS came from a replay trajectory rather than from a human.
      const ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
      try {
        const recipe = ctx.map.recipes.get('create_invoice') as RecipeFile;
        ctx.db.putRecipe({ ...recipe, status: 'candidate' }, { dirty: true, reason: 'recompile:recompile_failures' });
      } finally {
        ctx.close();
      }
      const r = runCli(['export'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      const lines = r.stdout.split('\n').filter((l) => l.trim().length > 0);
      assert.deepEqual(lines, ['ios/recipes/create_invoice.yaml'], r.stdout);
      // the Stop hook parses stdout as paths, so the warning must never land there (§4)
      for (const line of lines) assert.match(line, /^[\w./-]+\.yaml$/, 'one relative path per line');
      assert.match(r.stderr, /machine recompile: ios\/recipes\/create_invoice\.yaml/);
      assert.match(r.stderr, /rebuilt from a replay trajectory/);
    });
  });

  it('summary works both when the cache is absent and when it exists (read-only path)', () => {
    withTemp((t) => {
      assert.equal(runCli(['summary'], { dir: t.dir }).code, 0, 'no cache yet');
      const second = runCli(['summary'], { dir: t.dir });
      assert.equal(second.code, 0, second.stderr);
      assert.match(second.stdout, /create_invoice/);
    });
  });

  it('record exits 0 even when the map is broken (05 §3: never block the agent)', () => {
    withTemp((t) => {
      writeFileSync(join(t.dir, 'ids.yaml'), 'schema_version: 99\nnot: valid\n');
      const r = runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(loadHookFixture('post-tool-use.tap'))}\n` });
      assert.equal(r.code, 0, r.stderr);
    });
  });

  it('report reads .local/events.jsonl and prints the 08 §4 table', () => {
    withTemp((t) => {
      writeFileSync(join(t.dir, '.local', 'events.jsonl'), readFixture(join('events', 'sample.events.jsonl')));
      const r = runCli(['report', '--since', '3650d'], { dir: t.dir });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /replay_rate/);
      assert.match(r.stdout, /alerts:/);
    });
  });
});

describe('app-map import-router / mark / migrate-id / merge-driver (03 §10)', () => {
  it('import-router --dry-run reports without writing; a real run writes canonical YAML', () => {
    withTemp((t) => {
      const routerFile = join(PACKAGE_ROOT, 'fixtures', 'router-export.ios.json');
      const dry = runCli(['import-router', routerFile, '--dry-run', '--json'], { dir: t.dir });
      assert.equal(dry.code, 0, dry.stderr);
      const dryResult = JSON.parse(dry.stdout) as { created: string[]; unregistered: string[]; written: string[] };
      assert.deepEqual(dryResult.created, ['settings'], 'the fixture export adds one screen (decision 40)');
      assert.deepEqual(dryResult.written, [], '--dry-run writes nothing');
      assert.equal(existsSync(join(t.dir, 'ios', 'screens', 'settings.yaml')), false);

      const real = runCli(['import-router', routerFile, '--json'], { dir: t.dir });
      assert.equal(real.code, 0, real.stderr);
      const result = JSON.parse(real.stdout) as { created: string[]; unregistered: string[]; written: string[] };
      assert.deepEqual(result.unregistered, ['settings']);
      assert.ok(result.written.includes('ios/screens/settings.yaml'), result.written.join(', '));
      assert.ok(result.written.includes('ids.yaml'), 'the new screen is appended to the registry');
      assert.equal(runCli(['export', '--check'], { dir: t.dir }).code, 0, 'the import writes canonical YAML');
    });
  });

  it('import-router --strict refuses an unregistered screen (exit 1, invalid_map)', () => {
    withTemp((t) => {
      const r = runCli(['import-router', join(PACKAGE_ROOT, 'fixtures', 'router-export.ios.json'), '--strict'], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /settings/);
      assert.match(r.stderr, /invalid_map/);
    });
  });

  it('import-router on a missing file is not_found (exit 1)', () => {
    withTemp((t) => {
      const r = runCli(['import-router', join(t.dir, 'nope.json')], { dir: t.dir });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not_found/);
    });
  });

  it('mark is the CLI twin of mark_recipe (07 §7: ci_gate needs a reviewer)', () => {
    withTemp((t) => {
      const missing = runCli(['mark', 'create_invoice', 'ci_gate'], { dir: t.dir });
      assert.equal(missing.code, 1, missing.stdout + missing.stderr);
      assert.match(missing.stderr, /bad_input/);
      const ok = runCli(['mark', 'create_invoice', 'ci_gate', '--reviewer', 'dana', '--force'], { dir: t.dir });
      assert.equal(ok.code, 0, ok.stdout + ok.stderr);
      assert.match(ok.stdout, /create_invoice: verified → ci_gate/);
    });
  });

  it('migrate-id --dry-run counts the references without writing (02 §8)', () => {
    withTemp((t) => {
      const before = readFileSync(join(t.dir, 'ids.yaml'), 'utf8');
      const r = runCli(['migrate-id', 'invoice.add.button', 'invoice.plus.button', '--dry-run', '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const result = JSON.parse(r.stdout) as { references: number; files_changed: string[] };
      assert.ok(result.references > 0, 'the pilot references invoice.add.button');
      assert.equal(readFileSync(join(t.dir, 'ids.yaml'), 'utf8'), before, '--dry-run writes nothing');
      assert.equal(runCli(['migrate-id', 'invoice.add.button', 'invoice.plus.button'], { dir: t.dir }).code, 0);
      assert.equal(runCli(['validate'], { dir: t.dir }).code, 0, 'the map still validates after the migration');
    });
  });

  it('merge-driver returns the git merge-driver exit code (02 §9)', () => {
    withTemp((t) => {
      const screen = readFileSync(join(t.dir, 'ios', 'screens', 'invoice_list.yaml'), 'utf8');
      const base = join(t.dir, '.local', 'O.yaml');
      const ours = join(t.dir, '.local', 'A.yaml');
      const theirs = join(t.dir, '.local', 'B.yaml');
      for (const p of [base, ours, theirs]) writeFileSync(p, screen);
      const clean = runCli(['merge-driver', base, ours, theirs, 'ios/screens/invoice_list.yaml'], { dir: t.dir });
      assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    });
  });
});

describe('app-map maestro-export / run --all (04 §6, 06 R5, decision 36)', () => {
  it('maestro-export --all writes a flow per eligible recipe', () => {
    withTemp((t) => {
      const out = join(t.dir, '.local', 'maestro-cli');
      const r = runCli(['maestro-export', '--all', '--out', out, '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const result = JSON.parse(r.stdout) as { flows: Array<{ recipe: string; path: string; eligible: boolean }> };
      assert.ok(result.flows.some((f) => f.recipe === 'create_invoice' && f.eligible));
      assert.ok(existsSync(join(out, 'create_invoice.yaml')));
    });
  });

  it('maestro-export exits 1 with bad_input when no source supplies a required param', () => {
    withTemp((t) => {
      const r = runCli(['maestro-export', '--all', '--out', join(t.dir, '.local', 'flows')], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /bad_input/);
      assert.match(r.stderr, /create_invoice\.(amount|client)/);
    }, { withCiParams: false });
  });

  it('run --all --status … --headless --report writes heal-report.json (harness-notes §4)', () => {
    withTemp((t) => {
      const reportPath = join(t.dir, '.local', 'heal-report.json');
      const r = runCli(['run', '--all', '--status', 'verified,ci_gate', '--headless', '--report', reportPath], { dir: t.dir });
      assert.equal(r.stdout.trim(), reportPath, 'the written path goes to stdout');
      assert.ok(existsSync(reportPath), 'the report is written even when every run fails');
      const healReport = JSON.parse(readFileSync(reportPath, 'utf8')) as { schema_version: number; platform: string; runs: unknown[]; heals: unknown[]; needs_human: unknown[] };
      assert.equal(healReport.schema_version, 1);
      assert.equal(healReport.platform, 'ios');
      assert.ok(Array.isArray(healReport.runs) && Array.isArray(healReport.heals) && Array.isArray(healReport.needs_human));
      // no device/Maestro in the test environment, so every run fails and the command exits 1
      assert.equal(r.code, 1, r.stdout + r.stderr);
    });
  });

  it('run --all without --headless and run without a recipe are usage errors', () => {
    withTemp((t) => {
      assert.equal(runCli(['run', '--all', '--status', 'verified'], { dir: t.dir }).code, 2);
      assert.equal(runCli(['run', '--all', '--headless'], { dir: t.dir }).code, 2, '--all needs --status');
      assert.equal(runCli(['run'], { dir: t.dir }).code, 2);
    });
  });
});

describe('app-map drift (06 R4, harness-notes §4)', () => {
  const ROUTER = join(PACKAGE_ROOT, 'fixtures', 'router-export.ios.json');

  it('--router without --build takes the build from the export and writes --out', () => {
    withTemp((t) => {
      const outPath = join(t.dir, '.local', 'drift-report.json');
      const r = runCli(['drift', '--platform', 'ios', '--router', ROUTER, '--out', outPath, '--json'], { dir: t.dir });
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as { schema_version: number; build: string; summary: { blocking: boolean } };
      assert.equal(report.schema_version, 1);
      assert.equal(report.build, '4412', 'decision 37: --build defaults to the router export build_number');
      // no ci_gate recipe in the pilot, so nothing blocks even though the tour cannot reach a device
      assert.equal(report.summary.blocking, false);
      assert.equal(r.code, 0, r.stdout + r.stderr);
    });
  });

  it('exits non-zero when a ci_gate-referenced screen is broken (06 §4)', () => {
    withTemp((t) => {
      // promote create_invoice so its screens become ci_gate-referenced (06 R5); `drift` runs in a
      // fresh process and reads YAML, so the mark has to be exported first (03 §4)
      assert.equal(runCli(['mark', 'create_invoice', 'ci_gate', '--reviewer', 'dana', '--force'], { dir: t.dir }).code, 0);
      assert.equal(runCli(['export'], { dir: t.dir }).code, 0);
      const outPath = join(t.dir, '.local', 'drift-report.json');
      const r = runCli(['drift', '--router', ROUTER, '--out', outPath], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as { summary: { blocking: boolean }; screens: Array<{ screen: string; status: string; ci_gate_referenced: boolean }> };
      assert.equal(report.summary.blocking, true);
      assert.ok(report.screens.some((sc) => sc.ci_gate_referenced && sc.status === 'broken'));
      assert.match(r.stdout, /invoice_new/, 'the table names the screens');
    });
  });

  it('--build overrides the export build', () => {
    withTemp((t) => {
      const outPath = join(t.dir, '.local', 'drift-report.json');
      runCli(['drift', '--build', '4499', '--router', ROUTER, '--out', outPath], { dir: t.dir });
      assert.equal((JSON.parse(readFileSync(outPath, 'utf8')) as { build: string }).build, '4499');
    });
  });
});

describe('exit codes (03 §10: 0 ok · 1 failure · 2 usage)', () => {
  it('an unknown command exits 2 with the command list', () => {
    const r = runCli(['frobnicate']);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /unknown command: frobnicate/);
    assert.match(r.stderr, /"code": ?"bad_input"|"code":"bad_input"/);
    const err = JSON.parse(r.stderr.split('\n')[0]!) as { error: string; hint: string; code: string };
    assert.equal(err.code, 'bad_input');
    assert.match(err.hint, /known commands/, '03 §11: every error carries a hint');
  });

  it('a missing flag value exits 2', () => {
    withTemp((t) => {
      assert.equal(runCli(['validate', '--platform'], { dir: t.dir }).code, 2);
      assert.equal(runCli(['validate', '--platform', 'windows'], { dir: t.dir }).code, 2);
    });
  });

  it('a missing positional exits 2', () => {
    withTemp((t) => {
      assert.equal(runCli(['migrate-id', 'only.one.id'], { dir: t.dir }).code, 2);
      assert.equal(runCli(['mark', 'create_invoice'], { dir: t.dir }).code, 2);
      assert.equal(runCli(['mark', 'create_invoice', 'nonsense'], { dir: t.dir }).code, 2);
      assert.equal(runCli(['intent-critical-diff'], { dir: t.dir }).code, 2);
    });
  });

  it('help exits 0 and lists every command', () => {
    const r = runCli(['help']);
    assert.equal(r.code, 0);
    for (const cmd of ['validate', 'export', 'record', 'summary', 'import-router', 'compile', 'run', 'maestro-export', 'drift', 'report', 'gen-configs', 'lint-ids', 'policy-check', 'intent-critical-diff', 'mark', 'merge-driver', 'migrate-id']) {
      assert.ok(r.stdout.includes(cmd), `usage must mention ${cmd}`);
    }
    assert.equal(runCli([]).code, 0);
  });
});

describe('parseArgs — the 03 §10 flag grammar', () => {
  it('rejects an unknown command with bad_input', () => {
    assert.throws(() => parseArgs(['nope']), /unknown command/);
    assert.throws(() => parseArgs(['--platform', 'android', 'nope']), /unknown command: nope/);
    assert.throws(() => parseArgs(['--platform', 'android']), /no command given/);
  });

  // 03 §10: the help text calls --dir/--platform/--max-tokens global, so they must parse on
  // EITHER side of the command; a leading flag used to be read as the command itself.
  it('accepts the global flags before the command', () => {
    const a = parseArgs(['--platform', 'android', '--dir=/tmp/x', 'summary', '--max-tokens', '600']);
    assert.equal(a.command, 'summary');
    assert.equal(a.flags.platform, 'android');
    assert.equal(a.flags.dir, '/tmp/x');
    assert.equal(a.flags['max-tokens'], '600');
    assert.deepEqual(a.positional, []);
    const b = parseArgs(['--json', 'validate']);
    assert.equal(b.command, 'validate');
    assert.equal(b.flags.json, true);
    const c = parseArgs(['--dir', '/tmp/y', 'import-router', 'export.json']);
    assert.equal(c.command, 'import-router');
    assert.deepEqual(c.positional, ['export.json']);
  });

  it('parses `--k v`, `--k=v`, booleans and `--`', () => {
    const a = parseArgs(['export', '--force', '--check', '--dir=/tmp/x', '--platform', 'android', '--', '--not-a-flag']);
    assert.equal(a.command, 'export');
    assert.equal(a.flags.force, true);
    assert.equal(a.flags.check, true);
    assert.equal(a.flags.dir, '/tmp/x');
    assert.equal(a.flags.platform, 'android');
    assert.deepEqual(a.positional, ['--not-a-flag']);
  });

  it('compile: --session/--task/--name plus repeated --param name:type=value', () => {
    const a = parseArgs(['compile', '--session', 's1', '--task', 'create an invoice', '--name', 'create_invoice',
      '--param', 'amount:money=50', '--param', 'client:string=Acme Corp', '--to-seq', '7']);
    assert.equal(a.flags.session, 's1');
    assert.equal(a.flags.task, 'create an invoice');
    assert.equal(a.flags.name, 'create_invoice');
    assert.deepEqual(a.flags.param, ['amount:money=50', 'client:string=Acme Corp']);
    assert.equal(a.flags['to-seq'], '7');
  });

  it('run: both shapes of the 03 §10 row', () => {
    const guided = parseArgs(['run', 'create_invoice', '--params', 'amount=50', 'client=Acme Corp']);
    assert.deepEqual(guided.positional, ['create_invoice']);
    assert.deepEqual(guided.flags.params, ['amount=50', 'client=Acme Corp']);
    const all = parseArgs(['run', '--all', '--status', 'verified,ci_gate', '--headless', '--report', 'heal-report.json']);
    assert.equal(all.flags.all, true);
    assert.equal(all.flags.headless, true);
    assert.equal(all.flags.status, 'verified,ci_gate');
    assert.equal(all.flags.report, 'heal-report.json');
  });

  it('maestro-export / drift / import-router / lint-ids flags', () => {
    const m = parseArgs(['maestro-export', '--all', '--status', 'ci_gate', '--params-file', 'p.json', '--out', '.ci/maestro']);
    assert.equal(m.flags.all, true);
    assert.equal(m.flags.out, '.ci/maestro');
    assert.equal(m.flags['params-file'], 'p.json');
    const d = parseArgs(['drift', '--platform', 'ios', '--router', '/tmp/router-export.json', '--out', 'drift-report.json']);
    assert.equal(d.flags.router, '/tmp/router-export.json');
    assert.equal(d.flags.out, 'drift-report.json');
    assert.equal(d.flags.build, undefined, '06 §3 calls drift without --build');
    const ir = parseArgs(['import-router', '/tmp/router-export.json', '--no-retire', '--strict', '--purge-retired', '--dry-run']);
    assert.deepEqual(ir.positional, ['/tmp/router-export.json']);
    for (const f of ['no-retire', 'strict', 'purge-retired', 'dry-run']) assert.equal(ir.flags[f], true);
    const l = parseArgs(['lint-ids', '--platform', 'ios', '--src', 'ios/App', 'ios/Feature']);
    assert.equal(l.flags.platform, 'ios');
    assert.deepEqual(l.flags.src, ['ios/App', 'ios/Feature']);
  });

  it('mark / merge-driver / migrate-id positionals', () => {
    const mk = parseArgs(['mark', 'create_invoice', 'ci_gate', '--reviewer', 'dana', '--recipe-file', 'r.yaml', '--force']);
    assert.deepEqual(mk.positional, ['create_invoice', 'ci_gate']);
    assert.equal(mk.flags.reviewer, 'dana');
    assert.equal(mk.flags.force, true);
    assert.deepEqual(parseArgs(['merge-driver', 'O', 'A', 'B', 'P']).positional, ['O', 'A', 'B', 'P']);
    const mi = parseArgs(['migrate-id', 'a.b.c', 'a.b.d', '--dry-run']);
    assert.deepEqual(mi.positional, ['a.b.c', 'a.b.d']);
    assert.equal(mi.flags['dry-run'], true);
  });

  it('bare `-h`, `--help` and no argv all mean help', () => {
    assert.equal(parseArgs([]).command, 'help');
    assert.equal(parseArgs(['--help']).command, 'help');
    assert.equal(parseArgs(['help']).command, 'help');
    assert.equal(parseArgs(['validate', '-h']).flags.help, true);
    assert.ok(USAGE.includes('app-map <command>'));
  });
});

// ---------------------------------------------------------------------------------------------
// Wave-2 commands end to end. A device is faked with three tiny scripts on PATH: `maestro`
// (`--version` / `test` / `hierarchy`), and `xcrun` + `plutil` for the 07 §3 build probe
// (guided.defaultBuildProbe shells out to `xcrun simctl spawn … defaults export | plutil`).
// ---------------------------------------------------------------------------------------------

interface FakeDevice {
  /** directory to prepend to PATH */
  bin: string;
  /** absolute path of the fake `maestro` (also passed as APP_MAP_MAESTRO_BIN) */
  maestro: string;
  /** env to merge into `runCli({env})` */
  env: NodeJS.ProcessEnv;
}

interface FakeDeviceOptions {
  /** `maestro --version` output (default 2.10.0, the version 07 §5.3 pins) */
  version?: string;
  /** exit code of `maestro test` (default 0) */
  testCode?: number;
  /** stdout of `maestro test` (default a passing line) */
  testOut?: string;
  /** file whose contents `maestro hierarchy` prints (raw Maestro JSON) */
  hierarchyFile?: string;
  /** probe record the fake `plutil` prints; `null` = a Release build (no probe at all) */
  probe?: Record<string, unknown> | null;
}

/** Write the fake device scripts into `dir/bin` (POSIX sh; the CI matrix for this suite is linux/macOS). */
function makeFakeDevice(dir: string, opts: FakeDeviceOptions = {}): FakeDevice {
  const bin = join(dir, 'fakebin');
  mkdirSync(bin, { recursive: true });
  const version = opts.version ?? '2.10.0';
  const testCode = opts.testCode ?? 0;
  const testOut = opts.testOut ?? '[ok] openLink\n[ok] flow passed';
  const hierarchyFile = opts.hierarchyFile ?? '/dev/null';
  const maestro = join(bin, 'maestro');
  writeFileSync(maestro, [
    '#!/bin/sh',
    'case "$1" in',
    `  --version) echo ${JSON.stringify(version)} ;;`,
    `  test) printf '%b\\n' ${JSON.stringify(testOut)}; exit ${testCode} ;;`,
    `  hierarchy) cat ${JSON.stringify(hierarchyFile)} ;;`,
    '  *) exit 0 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  // 07 §3: an absent probe endpoint IS the answer "Release build", so `probe: null` prints nothing.
  const probe = opts.probe === undefined
    ? { schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app', version: '2026.9.1', build_number: '4412', git_sha: 'a1b2c3d', auth: 'logged_in' }
    : opts.probe;
  writeFileSync(join(bin, 'plutil'), probe === null
    ? '#!/bin/sh\nexit 1\n'
    : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify({ app_map_debug_probe: probe })}\nJSON\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'xcrun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return {
    bin,
    maestro,
    env: { PATH: `${bin}:${process.env.PATH ?? ''}`, APP_MAP_MAESTRO_BIN: maestro },
  };
}

/** Copy the committed trajectory fixture in under its own session id (02 §7 file layout). */
function seedTrajectory(t: TempAppMapDir, name = 'create_invoice.session', session = 'sess_2026-09-10_0007'): string {
  const dir = join(t.dir, '.local', 'trajectories');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${session}.jsonl`), readFixture(join('trajectories', `${name}.jsonl`)));
  return session;
}

describe('app-map compile (04 §3, 03 §10)', () => {
  it('compiles the committed trajectory into the pilot recipe steps and prints canonical YAML', () => {
    withTemp((t) => {
      const session = seedTrajectory(t);
      const r = runCli(['compile', '--session', session, '--task', 'create an invoice for $50 for Acme Corp',
        '--name', 'create_invoice', '--param', 'amount:money=50', '--param', 'client:string=Acme Corp'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      // 04 §9: the draft's steps equal the committed recipe's steps
      const committed = readFileSync(join(t.dir, 'ios', 'recipes', 'create_invoice.yaml'), 'utf8');
      const stepsOf = (text: string): string => text.slice(text.indexOf('steps:'), text.indexOf('verify:'));
      assert.equal(stepsOf(r.stdout), stepsOf(committed), r.stdout);
      assert.match(r.stdout, /^id: create_invoice$/m, 'canonical key order starts at `id`');
      assert.match(r.stdout, /^status: candidate$/m, '04 §3.8: a draft is never verified');
      assert.match(r.stdout, /compiled_from: sess_2026-09-10_0007/, 'provenance names the session');
      // 04 §3.8: nothing is written until mark_recipe
      assert.equal(runCli(['export', '--check'], { dir: t.dir }).code, 0);
      assert.equal(readFileSync(join(t.dir, 'ios', 'recipes', 'create_invoice.yaml'), 'utf8'), committed);
    });
  });

  it('--json exposes the draft, and --to-seq truncates the trajectory', () => {
    withTemp((t) => {
      const session = seedTrajectory(t);
      const args = ['compile', '--session', session, '--task', 'create an invoice for $50 for Acme Corp',
        '--name', 'create_invoice', '--param', 'amount:money=50', '--param', 'client:string=Acme Corp', '--json'];
      const full = runCli(args, { dir: t.dir });
      assert.equal(full.code, 0, full.stderr);
      const draft = (JSON.parse(full.stdout) as { ok: boolean; recipe: { steps: Array<{ id: string }> } });
      assert.equal(draft.ok, true);
      assert.deepEqual(draft.recipe.steps.map((s) => s.id), ['s1', 's2', 's3', 's4', 's5']);
      // 04 §3.1: `--to-seq` stops the slice early — seq 5 is the `type` in the amount field
      const short = runCli([...args, '--to-seq', '5'], { dir: t.dir });
      assert.equal(short.code, 0, short.stderr);
      const cut = (JSON.parse(short.stdout) as { recipe: { steps: Array<{ id: string }> } }).recipe.steps;
      assert.deepEqual(cut.map((x) => x.id), ['s1', 's2']);
    });
  });

  it('exits 1 with a closed reason for a session with no observations, 2 for missing flags', () => {
    withTemp((t) => {
      const r = runCli(['compile', '--session', 'sess_nothing', '--task', 'x', '--name', 'y'], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /no_observations/);
      const bare = runCli(['compile', '--session', seedTrajectory(t), '--task', 'create an invoice', '--name', 'create_invoice', '--json'], { dir: t.dir });
      assert.equal(bare.code, 1, bare.stdout + bare.stderr);
      assert.equal((JSON.parse(bare.stdout) as { reason: string }).reason, 'unparameterized_value',
        '04 §3.4: a typed value that matches no declared param is not compilable');
      assert.equal(runCli(['compile', '--session', 's', '--task', 't'], { dir: t.dir }).code, 2, '--name is required');
      assert.equal(runCli(['compile', '--session', 's', '--name', 'r', '--param', 'amount'], { dir: t.dir }).code, 2, '--param needs name:type');
      assert.equal(runCli(['compile', '--session', 's', '--task', 't', '--name', 'r', '--param', 'amount:guess'], { dir: t.dir }).code, 2, 'unknown param type');
    });
  });
});

describe('app-map run --headless against a fake Maestro (04 §6.1, 03 §10)', () => {
  it('replays the pilot recipe, writes the flow and exits 0', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir);
      const r = runCli(['run', 'create_invoice', '--headless', '--json'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const rep = JSON.parse(r.stdout) as { recipe: string; mode: string; ok: boolean; steps: number; steps_done: number; heals: unknown[]; retries: number; build: string };
      assert.equal(rep.recipe, 'create_invoice');
      assert.equal(rep.mode, 'headless');
      assert.equal(rep.ok, true);
      assert.equal(rep.steps_done, rep.steps);
      assert.equal(rep.retries, 0);
      assert.deepEqual(rep.heals, []);
      assert.equal(rep.build, '4412', 'the probe/manifest build is stamped on the report');
      // the exported flow is a real Maestro flow (04 §6.2), written under .local/maestro
      const flow = readFileSync(join(t.dir, '.local', 'maestro', 'create_invoice.yaml'), 'utf8');
      assert.match(flow, /^appId: com\.example\.app$/m);
      assert.match(flow, /- openLink: appmap:\/\/invoice_new\?fixture=logged_in/);
      assert.match(flow, /inputText: "50"|inputText: '50'|inputText: 50/, 'the CI params file supplies {amount}');
      // 07 §2: no raw tree, and no screenshot, ever reaches disk
      assert.equal(existsSync(join(t.dir, '.local', 'screenshots')), false);
    });
  });

  it('--params on the command line beat the CI params file', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir);
      const r = runCli(['run', 'create_invoice', '--headless', '--params', 'amount=99', 'client=Globex'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const flow = readFileSync(join(t.dir, '.local', 'maestro', 'create_invoice.yaml'), 'utf8');
      assert.match(flow, /99/);
      assert.match(flow, /Globex/);
    });
  });

  it('a failing `maestro test` exits 1 with maestro_failed and the failing step', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir, { testCode: 1, testOut: '[ok] openLink\n[ok] extendedWaitUntil\n[failed] tapOn id=invoice.amount.field' });
      const r = runCli(['run', 'create_invoice', '--headless', '--json'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      const rep = JSON.parse(r.stdout) as { ok: boolean; error_code: string; fallback_step?: string; failed_command_index?: number };
      assert.equal(rep.ok, false);
      // no hierarchy dump from the fake device, so the loop stops at hierarchy_unavailable (04 §6.1 step 3)
      assert.ok(['maestro_failed', 'hierarchy_unavailable'].includes(rep.error_code), rep.error_code);
      assert.equal(rep.failed_command_index, 2, 'the ✅/❌ command list is parsed best-effort');
      assert.equal(rep.fallback_step, 's1');
      assert.doesNotMatch(r.stdout, /Acme|invoice #/, '07 §2.4: on-screen text never reaches the report');
    });
  });

  it('reports maestro_unavailable when the binary is absent (03 §13)', () => {
    withTemp((t) => {
      const r = runCli(['run', 'create_invoice', '--headless', '--json'], {
        dir: t.dir,
        env: { ...makeFakeDevice(t.dir).env, APP_MAP_MAESTRO_BIN: join(t.dir, 'no-such-maestro') },
      });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal((JSON.parse(r.stdout) as { error_code: string }).error_code, 'maestro_unavailable');
    });
  });

  it('reports maestro_unavailable when the installed version is below the pinned floor (07 §5.3)', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir, { version: '1.20.0' });
      const r = runCli(['run', 'create_invoice', '--headless', '--json'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal((JSON.parse(r.stdout) as { error_code: string }).error_code, 'maestro_unavailable');
    });
  });

  it('refuses a Release build and a non-sandbox Debug build (07 §3)', () => {
    withTemp((t) => {
      const release = makeFakeDevice(t.dir, { probe: null });
      const r = runCli(['run', 'create_invoice', '--headless', '--json'], { dir: t.dir, env: release.env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.equal((JSON.parse(r.stdout) as { error_code: string }).error_code, 'release_build_refused');
      const prod = makeFakeDevice(t.dir, { probe: { schema_version: 1, build_type: 'debug', sandbox: false, app_id: 'com.example.app', build_number: '4412' } });
      const r2 = runCli(['run', 'create_invoice', '--headless', '--json'], { dir: t.dir, env: prod.env });
      assert.equal((JSON.parse(r2.stdout) as { error_code: string }).error_code, 'release_build_refused', 'sandbox:false is refused too');
      assert.equal(existsSync(join(t.dir, '.local', 'maestro', 'create_invoice.yaml')), false, 'nothing is exported before the policy check');
    });
  });

  it('run --all --status verified --headless --report writes a valid heal report with every run ok', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir);
      const reportPath = join(t.dir, '.local', 'heal-report.json');
      const r = runCli(['run', '--all', '--status', 'verified,ci_gate', '--headless', '--report', reportPath], { dir: t.dir, env: device.env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout.trim(), reportPath);
      const healReport = JSON.parse(readFileSync(reportPath, 'utf8')) as { runs: Array<{ recipe: string; ok: boolean }>; heals: unknown[]; needs_human: unknown[] };
      assert.deepEqual(healReport.runs.map((x) => [x.recipe, x.ok]), [['create_invoice', true]]);
      assert.deepEqual(healReport.heals, []);
      assert.deepEqual(healReport.needs_human, []);
      assert.deepEqual(validateAgainstSchema(join(t.dir, 'schema'), 'heal-report', healReport), [], 'heal-report.schema.json');
    });
  });

  it('a successful headless run stamps last_verified_build on the recipe (04 §8)', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir, { probe: { schema_version: 1, build_type: 'debug', sandbox: true, app_id: 'com.example.app', build_number: '4413' } });
      // 03 §3: an explicit APP_MAP_BUILD wins over every auto-detected source
      assert.equal(runCli(['run', 'create_invoice', '--headless'], { dir: t.dir, env: { ...device.env, APP_MAP_BUILD: '4413' } }).code, 0);
      assert.equal(runCli(['export'], { dir: t.dir }).code, 0);
      assert.match(readFileSync(join(t.dir, 'ios', 'recipes', 'create_invoice.yaml'), 'utf8'), /^last_verified_build: "4413"$/m);
    });
  });
});

describe('app-map run (guided) against a fake probe (04 §5, 03 §10)', () => {
  it('prints the first step of the run after the hook recorded one observation', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir);
      assert.equal(runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(loadHookFixture('post-tool-use.tap'))}\n` }).code, 0);
      const r = runCli(['run', 'create_invoice', '--params', 'amount=50', 'client=Acme Corp'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^run run_\S+ \(create_invoice v3\)$/m);
      // 04 §5: the entry step is the deep link, and the step line stays inside the token budget
      assert.match(r.stdout, /step s0 open_link appmap:\/\/invoice_new\?fixture=logged_in/);
      assert.ok(estimateTokens(r.stdout) <= 200, `the printed step is ${estimateTokens(r.stdout)} tokens`);
    });
  });

  it('without any observation it exits 1 with no_observation (03 §2)', () => {
    withTemp((t) => {
      const r = runCli(['run', 'create_invoice', '--params', 'amount=50', 'client=Acme'], { dir: t.dir, env: makeFakeDevice(t.dir).env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /no_observation/);
    });
  });

  it('names the missing params instead of starting a run (bad_input)', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir);
      runCli(['record', '--stdin'], { dir: t.dir, input: `${JSON.stringify(loadHookFixture('post-tool-use.tap'))}\n` });
      const r = runCli(['run', 'create_invoice'], { dir: t.dir, env: device.env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /bad_input/);
      assert.match(r.stderr, /amount/);
      assert.match(r.stderr, /client/);
    });
  });

  it('an unknown recipe is recipe_unavailable / not_found (exit 1)', () => {
    withTemp((t) => {
      const r = runCli(['run', 'no_such_recipe', '--headless'], { dir: t.dir, env: makeFakeDevice(t.dir).env });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /not_found|recipe_unavailable/);
    });
  });
});

describe('app-map drift against a fake device (06 R4)', () => {
  it('tours the screens the router export lists and reports the matching one ok', () => {
    withTemp((t) => {
      const device = makeFakeDevice(t.dir, { hierarchyFile: join(PACKAGE_ROOT, 'fixtures', 'raw', 'maestro-hierarchy.invoice_list.json') });
      // one-screen export: every other screen is `skipped (not_in_router_export)`, so the tour is
      // fast and deterministic — the fake device only knows how to be invoice_list.
      const routerPath = join(t.dir, '.local', 'router-one.json');
      writeFileSync(routerPath, JSON.stringify({
        schema_version: 1, app_id: 'com.example.app', platform: 'ios',
        build: { version: '2026.9.1', build_number: '4412', git_sha: 'a1b2c3d' },
        screens: [{ id: 'invoice_list', route: 'appmap://invoice_list', view_type: 'InvoiceListView', edges: [] }],
      }));
      const outPath = join(t.dir, '.local', 'drift.json');
      const r = runCli(['drift', '--router', routerPath, '--out', outPath], { dir: t.dir, env: device.env });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const report = JSON.parse(readFileSync(outPath, 'utf8')) as { build: string; summary: { ok: number; broken: number; blocking: boolean }; screens: Array<{ screen: string; status: string; reason?: string }> };
      assert.deepEqual(validateAgainstSchema(join(t.dir, 'schema'), 'drift-report', report), [], 'drift-report.schema.json');
      assert.equal(report.build, '4412');
      const byId = new Map(report.screens.map((s) => [s.screen, s]));
      assert.equal(byId.get('invoice_list')?.status, 'ok', JSON.stringify(byId.get('invoice_list')));
      assert.equal(byId.get('invoice_new')?.reason, 'not_in_router_export');
      assert.equal(report.summary.broken, 0);
      assert.equal(report.summary.blocking, false);
      assert.match(r.stdout, /\| invoice_list \| ok/, 'the markdown table is the human output');
    });
  });
});

describe('app-map merge-driver end to end (02 §9)', () => {
  const O = (t: TempAppMapDir): string => join(t.dir, '.local', 'O.yaml');
  const A = (t: TempAppMapDir): string => join(t.dir, '.local', 'A.yaml');
  const B = (t: TempAppMapDir): string => join(t.dir, '.local', 'B.yaml');

  function seed(t: TempAppMapDir): string {
    mkdirSync(join(t.dir, '.local'), { recursive: true });
    const base = readFileSync(join(t.dir, 'ios', 'screens', 'invoice_list.yaml'), 'utf8');
    for (const p of [O(t), A(t), B(t)]) writeFileSync(p, base);
    return base;
  }

  it('unions non-overlapping edits and writes canonical YAML to %A (exit 0)', () => {
    withTemp((t) => {
      const base = seed(t);
      // ours renames the add button's label; theirs raises the same screen's edge count
      writeFileSync(A(t), base.replace('label: New Invoice', 'label: New invoice'));
      writeFileSync(B(t), base.replace('last_verified_build: "4412"', 'last_verified_build: "4413"'));
      const r = runCli(['merge-driver', O(t), A(t), B(t), 'ios/screens/invoice_list.yaml'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const merged = readFileSync(A(t), 'utf8');
      assert.match(merged, /label: New invoice/, 'our side survives');
      assert.match(merged, /last_verified_build: "4413"/, 'their side survives');
      assert.doesNotMatch(merged, /<<<<<<</);
    });
  });

  it('exits 1 with conflict markers when both sides change one key differently', () => {
    withTemp((t) => {
      const base = seed(t);
      writeFileSync(A(t), base.replace('last_verified_build: "4412"', 'last_verified_build: "4420"'));
      writeFileSync(B(t), base.replace('last_verified_build: "4412"', 'last_verified_build: "4430"'));
      const r = runCli(['merge-driver', O(t), A(t), B(t), 'ios/screens/invoice_list.yaml'], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      const merged = readFileSync(A(t), 'utf8');
      assert.match(merged, /<<<<<<< ours/);
      assert.match(merged, /=======/);
      assert.match(merged, />>>>>>> theirs/);
      assert.match(merged, /4420/);
      assert.match(merged, /4430/);
    });
  });
});

describe('app-map record --stdin accepts a pretty-printed payload (05 §3)', () => {
  it('reads the fixture file as it sits on disk, not only the flattened hook line', () => {
    withTemp((t) => {
      const pretty = JSON.stringify(loadHookFixture('post-tool-use.tap'), null, 2);
      assert.ok(pretty.includes('\n'), 'the fixture is multi-line');
      const r = runCli(['record', '--stdin'], { dir: t.dir, input: pretty });
      assert.equal(r.code, 0, r.stderr);
      const dir = join(t.dir, '.local', 'trajectories');
      assert.equal(readdirSync(dir).length, 1, 'the payload was recorded');
    });
  });
});

describe('app-map maestro-export shapes (04 §6.2, 06 R5)', () => {
  it('exports one named recipe with an explicit --params-file', () => {
    withTemp((t) => {
      const paramsFile = join(t.dir, '.local', 'gate-params.json');
      writeFileSync(paramsFile, JSON.stringify({ create_invoice: { amount: 12.5, client: 'Initech' } }));
      const out = join(t.dir, '.ci', 'maestro');
      const r = runCli(['maestro-export', 'create_invoice', '--params-file', paramsFile, '--out', out, '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const result = JSON.parse(r.stdout) as { flows: Array<{ recipe: string; path: string; eligible: boolean; ineligible_steps: string[] }> };
      assert.equal(result.flows.length, 1);
      assert.equal(result.flows[0]?.eligible, true);
      assert.deepEqual(result.flows[0]?.ineligible_steps, []);
      const flow = readFileSync(join(out, 'create_invoice.yaml'), 'utf8');
      assert.match(flow, /12\.5/, 'the params file supplies {amount}');
      assert.match(flow, /Initech/);
      // 06 R5: generated flows are never committed — they land wherever --out points
      assert.equal(existsSync(join(t.dir, 'ios', 'recipes', 'create_invoice.yaml')), true);
    });
  });

  it('--status ci_gate matches nothing in the pilot and exits 0 with an empty flow list', () => {
    withTemp((t) => {
      const r = runCli(['maestro-export', '--all', '--status', 'ci_gate', '--out', join(t.dir, '.ci', 'gate'), '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual((JSON.parse(r.stdout) as { flows: unknown[] }).flows, []);
    });
  });

  it('an unknown recipe id is not_found (exit 1)', () => {
    withTemp((t) => {
      const r = runCli(['maestro-export', 'no_such_recipe', '--out', join(t.dir, '.ci', 'x')], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /not_found|no_such_recipe/);
    });
  });
});

describe('app-map import-router flags (01 R6, 03 §10)', () => {
  it('--no-retire leaves a screen missing from the export alone', () => {
    withTemp((t) => {
      const router = loadRouterExportFixture();
      // drop invoice_detail from the export: with --no-retire it must stay `active`
      const trimmed = { ...router, screens: router.screens.filter((s) => s.id !== 'invoice_detail') };
      const file = join(t.dir, '.local', 'router-trimmed.json');
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      writeFileSync(file, JSON.stringify(trimmed));
      const kept = runCli(['import-router', file, '--no-retire', '--json'], { dir: t.dir });
      assert.equal(kept.code, 0, kept.stdout + kept.stderr);
      assert.deepEqual((JSON.parse(kept.stdout) as { retired: string[] }).retired, []);
      // the screen's lifecycle status lives under `provenance:` (02 §3), hence the indent
      assert.doesNotMatch(readFileSync(join(t.dir, 'ios', 'screens', 'invoice_detail.yaml'), 'utf8'), /^ {2}status: retired$/m);
    });
  });

  it('the default run retires it (02 §8: retired, never deleted)', () => {
    withTemp((t) => {
      const router = loadRouterExportFixture();
      const trimmed = { ...router, screens: router.screens.filter((s) => s.id !== 'invoice_detail') };
      const file = join(t.dir, '.local', 'router-trimmed.json');
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      writeFileSync(file, JSON.stringify(trimmed));
      const r = runCli(['import-router', file, '--json'], { dir: t.dir });
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual((JSON.parse(r.stdout) as { retired: string[] }).retired, ['invoice_detail']);
      assert.match(readFileSync(join(t.dir, 'ios', 'screens', 'invoice_detail.yaml'), 'utf8'), /^ {2}status: retired$/m);
      assert.equal(runCli(['export', '--check'], { dir: t.dir }).code, 0);
    });
  });

  it('a JSON document that is not a router export is bad_input (exit 1)', () => {
    withTemp((t) => {
      const file = join(t.dir, '.local', 'nope.json');
      mkdirSync(join(t.dir, '.local'), { recursive: true });
      writeFileSync(file, '{"hello":"world"}');
      const r = runCli(['import-router', file], { dir: t.dir });
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /bad_input|invalid_map/);
      const torn = join(t.dir, '.local', 'torn.json');
      writeFileSync(torn, '{"schema_version": 1,');
      const r2 = runCli(['import-router', torn], { dir: t.dir });
      assert.equal(r2.code, 1);
      assert.match(r2.stderr, /not valid JSON/);
    });
  });
});
