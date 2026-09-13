/**
 * [D2] `scripts/app-map/gen-ids --platforms` (01 R1 registry → constants, 06 R2 `--check` in CI,
 * issue #17). The generator ships one file per platform; an iOS-only repo has nowhere to put the
 * Kotlin one, and `--out-android /dev/null` generated fine but left `--check` printing a
 * permanent diff against /dev/null. Each case spawns the real script, the way CI and the
 * pre-commit hook do.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PILOT_APP_MAP_DIR, REPO_ROOT } from './helpers.ts';

const GEN_IDS = join(REPO_ROOT, 'scripts', 'app-map', 'gen-ids');

interface Run { code: number; stdout: string; stderr: string }

function withTempIds(fn: (paths: { ids: string; swift: string; kotlin: string; run: (args: string[]) => Run }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gen-ids-test-'));
  try {
    const ids = join(dir, 'ids.yaml');
    copyFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), ids);
    const swift = join(dir, 'AppMapID.swift');
    const kotlin = join(dir, 'AppMapId.kt');
    const run = (args: string[]): Run => {
      const r = spawnSync(process.execPath, [GEN_IDS, '--ids', ids, '--out-ios', swift, '--out-android', kotlin, ...args], { encoding: 'utf8' });
      assert.equal(r.error, undefined, `spawn failed: ${String(r.error)}`);
      return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };
    fn({ ids, swift, kotlin, run });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('scripts/app-map/gen-ids --platforms (01 R1, 06 R2, issue #17)', () => {
  it('--platforms ios writes only the Swift file', () => {
    withTempIds(({ swift, kotlin, run }) => {
      const r = run(['--platforms', 'ios']);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(existsSync(swift), 'the Swift constants are generated');
      assert.equal(existsSync(kotlin), false, 'the Kotlin file is not written at all — not even empty');
      assert.match(readFileSync(swift, 'utf8'), /public enum AppMapID \{/);
      assert.doesNotMatch(r.stdout, /AppMapId\.kt/);
    });
  });

  it('--platforms ios --check is clean against a generated Swift file — no permanent /dev/null diff', () => {
    withTempIds(({ kotlin, run }) => {
      assert.equal(run(['--platforms', 'ios']).code, 0);
      const check = run(['--platforms', 'ios', '--check']);
      assert.equal(check.code, 0, check.stdout + check.stderr);
      assert.equal(check.stderr, '', 'a skipped platform produces no diff');
      assert.match(check.stdout, /1 files up to date/, 'the summary counts only the selected outputs');
      assert.equal(existsSync(kotlin), false);
    });
  });

  it('the default still writes and checks both files (the CI job and the pre-commit hook pass no flag)', () => {
    withTempIds(({ swift, kotlin, run }) => {
      const wrote = run([]);
      assert.equal(wrote.code, 0, wrote.stdout + wrote.stderr);
      assert.ok(existsSync(swift) && existsSync(kotlin), wrote.stdout);
      const check = run(['--check']);
      assert.equal(check.code, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /2 files up to date/);
      // 06 R2: a stale committed file still fails, with the diff
      rmSync(kotlin);
      const stale = run(['--check']);
      assert.equal(stale.code, 1, stale.stdout);
      assert.match(stale.stderr, /AppMapId\.kt is missing/);
    });
  });

  it('an unknown or empty platform exits 1 naming ios,android', () => {
    withTempIds(({ run }) => {
      const bad = run(['--platforms', 'web']);
      assert.equal(bad.code, 1, bad.stdout);
      assert.match(bad.stderr, /ios,android/);
      assert.equal(run(['--platforms', ',']).code, 1, 'an empty list is not "both"');
      assert.equal(run(['--platforms']).code, 1, 'a missing value is not a path');
    });
  });

  it('--platforms ios,android is the default spelled out, and --platform is accepted as the lint-ids alias', () => {
    withTempIds(({ swift, kotlin, run }) => {
      assert.equal(run(['--platforms', 'ios,android']).code, 0);
      assert.ok(existsSync(swift) && existsSync(kotlin));
      rmSync(kotlin);
      // `lint-ids --platform ios` is the existing spelling; accept it here so the two commands
      // do not disagree about the flag name
      const r = run(['--platform', 'ios', '--check']);
      assert.equal(r.code, 0, r.stdout + r.stderr);
    });
  });
});
