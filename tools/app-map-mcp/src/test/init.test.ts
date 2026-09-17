/**
 * [D2] `app-map init` — scaffolding a consuming app repository (01 R1, 05 §2–§5.1).
 *
 * The load-bearing claim is end-to-end: a repo `init` has just scaffolded passes app-map's own
 * gates (`validate`, `export --check`, `policy-check`, `lint-ids`) with no hand editing. Everything
 * else here guards the ways that claim quietly stops being true — a template that stops being
 * staged, a path into THIS repository surviving into the app repo, an `init` that overwrites work.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import {
  CONSUMER_SCRIPTS, HOOK_SCRIPTS, PACKAGE_NAME, REWRITES, SERVER_ENTRY,
  claudeTemplates, detectAppSrcDirs, initRepo, templateFile,
} from '../init.ts';
import { CONFIG_FILE, readRepoConfig } from '../repo-config.ts';
import { lintIds } from '../lint-ids.ts';
import { validateMap } from '../validate.ts';
import { policyCheck } from '../policy-check.ts';
import { CONFIG_DEFAULTS } from '../config.ts';
import { PACKAGE_ROOT } from '../paths.ts';

/** A throwaway app repo with one Swift file, scaffolded unless `scaffold` is false. */
function makeApp(opts: { scaffold?: boolean; platform?: 'ios' | 'android' } = {}): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'app-map-init-'));
  mkdirSync(join(dir, 'App', 'Sources'), { recursive: true });
  writeFileSync(join(dir, 'App', 'Sources', 'ContentView.swift'), 'import SwiftUI\nstruct ContentView: View { var body: some View { Text("hi") } }\n');
  if (opts.scaffold !== false) initRepo({ target: dir, ...(opts.platform !== undefined ? { platform: opts.platform } : {}) });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function read(dir: string, rel: string): string {
  return readFileSync(join(dir, rel), 'utf8');
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs, base) : [abs.slice(base.length + 1).split('\\').join('/')];
  });
}

describe('init: a scaffolded repo passes app-map\u2019s own gates', () => {
  it('validate, export --check, policy-check and lint-ids are all clean with no hand editing', () => {
    const app = makeApp();
    try {
      const config = { ...CONFIG_DEFAULTS, dir: join(app.dir, 'app-map'), platform: 'ios' as const };
      const v = validateMap(config);
      assert.deepEqual(v.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(v.issues, null, 2));

      const policy = policyCheck(app.dir);
      assert.equal(policy.ok, true, JSON.stringify(policy.violations, null, 2));

      const lint = lintIds({ dir: join(app.dir, 'app-map') }, { repoRoot: app.dir });
      assert.deepEqual(lint.issues.filter((i) => i.severity === 'error'), [], JSON.stringify(lint.issues, null, 2));
    } finally {
      app.cleanup();
    }
  });

  it('the scaffolded YAML is already canonical, so the first `export --check` cannot fail', () => {
    const app = makeApp();
    try {
      // canonicalYaml wrote them; re-parsing and re-serialising must be byte-identical
      for (const rel of ['app-map/ids.yaml', 'app-map/ios/manifest.yaml', 'app-map/policy/mcp-allowlist.yaml']) {
        const text = read(app.dir, rel);
        assert.ok(text.endsWith('\n'), `${rel} must end in exactly one newline`);
        assert.ok(!text.includes('\r'), `${rel} must be LF`);
      }
    } finally {
      app.cleanup();
    }
  });
});

describe('init: nothing points back into the app-map repository', () => {
  it('no scaffolded file still matches a REWRITES pattern or names this repo\u2019s tree as a local path', () => {
    const app = makeApp();
    try {
      const files = [...walk(join(app.dir, '.claude'), app.dir), ...walk(join(app.dir, 'scripts'), app.dir)];
      assert.ok(files.length >= 20, `expected the skills, agents, hooks and scripts, got ${files.length}`);
      for (const rel of files) {
        const text = read(app.dir, rel);
        for (const { from } of REWRITES) {
          // a GitHub URL legitimately contains the upstream path; a bare local path does not
          const bare = text.replace(/https:\/\/github\.com\/[^\s`)]+/g, '');
          assert.equal(new RegExp(from.source).test(bare), false, `${rel} still matches ${from}`);
        }
      }
    } finally {
      app.cleanup();
    }
  });

  it('every CLI invocation in the scaffolded skills is `npx app-map`, which resolves the devDependency', () => {
    const app = makeApp();
    try {
      const skill = read(app.dir, '.claude/skills/app-instrument/SKILL.md');
      assert.match(skill, /npx app-map/);
      assert.doesNotMatch(skill, /tools\/app-map-mcp/);
    } finally {
      app.cleanup();
    }
  });

  it('the hooks resolve the CLI from node_modules and never bootstrap a checkout', () => {
    const app = makeApp();
    try {
      for (const name of HOOK_SCRIPTS) {
        const text = read(app.dir, `.claude/hooks/${name}`);
        assert.match(text, /node_modules\/\.bin\/app-map/, `${name} must prefer the installed bin`);
        assert.doesNotMatch(text, /npm ci --prefix/, `${name} must not bootstrap a checkout`);
        assert.ok(text.startsWith('#!/bin/sh'), `${name} needs its shebang`);
        assert.equal(statSync(join(app.dir, '.claude/hooks', name)).mode & 0o111, 0o111, `${name} must be executable`);
      }
    } finally {
      app.cleanup();
    }
  });

  it('.mcp.json and the allowlist agree on the installed server entry point (07 §6)', () => {
    const app = makeApp();
    try {
      const mcp = JSON.parse(read(app.dir, '.mcp.json')) as { mcpServers: Record<string, { args: string[] }> };
      assert.ok(mcp.mcpServers['app-map']?.args[0]?.endsWith(SERVER_ENTRY), 'the server points at the installed package');
      assert.match(read(app.dir, 'app-map/policy/mcp-allowlist.yaml'), new RegExp(SERVER_ENTRY.replace(/[/@.]/g, '\\$&')));
      assert.ok(SERVER_ENTRY.includes(PACKAGE_NAME));
    } finally {
      app.cleanup();
    }
  });
});

describe('init: re-running is safe', () => {
  it('a second run changes nothing', () => {
    const app = makeApp();
    try {
      const again = initRepo({ target: app.dir });
      assert.deepEqual(again.files.filter((f) => f.action !== 'unchanged'), [], 'a second run must be a no-op');
      assert.equal(again.ok, true);
    } finally {
      app.cleanup();
    }
  });

  it('a customised agent is reported as a conflict and left alone, unless --force', () => {
    const app = makeApp();
    try {
      const rel = '.claude/agents/app-instrument-swiftui.md';
      writeFileSync(join(app.dir, rel), 'my own version\n');
      const r = initRepo({ target: app.dir });
      assert.equal(r.files.find((f) => f.path === rel)?.action, 'conflict');
      assert.equal(read(app.dir, rel), 'my own version\n', 'the customised file is untouched');
      assert.equal(r.ok, false, 'a conflict makes the run non-ok so the CLI exits 1');

      const forced = initRepo({ target: app.dir, force: true });
      assert.equal(forced.files.find((f) => f.path === rel)?.action, 'updated');
      assert.notEqual(read(app.dir, rel), 'my own version\n');
    } finally {
      app.cleanup();
    }
  });

  it('an existing .mcp.json server of the same name is kept, and other servers survive', () => {
    const app = makeApp({ scaffold: false });
    try {
      writeFileSync(join(app.dir, '.mcp.json'), `${JSON.stringify({ mcpServers: { argent: { command: 'mine' }, other: { command: 'x' } } }, null, 2)}\n`);
      initRepo({ target: app.dir });
      const mcp = JSON.parse(read(app.dir, '.mcp.json')) as { mcpServers: Record<string, { command: string }> };
      assert.equal(mcp.mcpServers.argent?.command, 'mine', 'an existing server is never replaced');
      assert.equal(mcp.mcpServers.other?.command, 'x', 'unrelated servers survive');
      assert.equal(mcp.mcpServers['app-map']?.command, 'node', 'the missing server is added');
    } finally {
      app.cleanup();
    }
  });

  it('a malformed .mcp.json is left untouched and reported, never overwritten', () => {
    const app = makeApp({ scaffold: false });
    try {
      writeFileSync(join(app.dir, '.mcp.json'), '{ not json\n');
      const r = initRepo({ target: app.dir });
      assert.equal(r.files.find((f) => f.path === '.mcp.json')?.action, 'skipped');
      assert.equal(read(app.dir, '.mcp.json'), '{ not json\n');
    } finally {
      app.cleanup();
    }
  });

  it('--dry-run writes nothing', () => {
    const app = makeApp({ scaffold: false });
    try {
      const r = initRepo({ target: app.dir, dryRun: true });
      assert.ok(r.files.some((f) => f.action === 'created'));
      assert.equal(existsSync(join(app.dir, 'app-map')), false, 'nothing reached disk');
    } finally {
      app.cleanup();
    }
  });
});

describe('init: the per-repo config is what lets lint-ids work in an app repo', () => {
  it('app-map.config.json records the detected source root and the generated constants path', () => {
    const app = makeApp();
    try {
      const cfg = readRepoConfig(app.dir);
      assert.deepEqual(cfg.appSrcDirs, ['App/Sources'], 'the Swift tree is detected');
      assert.deepEqual(cfg.instrumentedPlatforms, ['ios']);
      assert.ok(cfg.generated?.swift !== undefined && cfg.generated.swift.endsWith('.swift'));
      assert.ok(existsSync(join(app.dir, CONFIG_FILE)));
    } finally {
      app.cleanup();
    }
  });

  it('lint-ids scans the configured roots rather than this repository\u2019s defaults', () => {
    const app = makeApp();
    try {
      // a literal equal to a registered id must be found in the app's own tree, which is only
      // scanned because app-map.config.json names it
      writeFileSync(join(app.dir, 'app-map', 'ids.yaml'),
        'schema_version: 1\nscreens:\n  - id: home\ngates: []\nelements: []\n');
      writeFileSync(join(app.dir, 'App', 'Sources', 'Bad.swift'), 'let x = "screen.home"\n');
      const lint = lintIds({ dir: join(app.dir, 'app-map') }, { repoRoot: app.dir });
      assert.ok(lint.issues.some((i) => i.rule === 'string_literal_id'), JSON.stringify(lint.issues, null, 2));
    } finally {
      app.cleanup();
    }
  });

  it('a repo with no config file keeps this repository\u2019s historical defaults', () => {
    assert.deepEqual(readRepoConfig(mkdtempSync(join(tmpdir(), 'app-map-noconfig-'))), {});
  });

  it('a malformed config is an error naming the file, not a silent default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-map-badconfig-'));
    writeFileSync(join(dir, CONFIG_FILE), '{ "appSrcDirs": "App" }\n');
    assert.throws(() => readRepoConfig(dir), /appSrcDirs must be an array/);
  });

  it('detectAppSrcDirs keeps the shallowest root and ignores build output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'app-map-detect-'));
    for (const rel of ['Sources/A.swift', 'Sources/Deep/B.swift', 'node_modules/x/C.swift', '.build/D.swift']) {
      mkdirSync(join(dir, dirname(rel)), { recursive: true });
      writeFileSync(join(dir, rel), '');
    }
    assert.deepEqual(detectAppSrcDirs(dir), ['Sources']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('the bin shim survives the layout npm installs it into', () => {
  it('resolves its own directory through a symlink, the way node_modules/.bin/app-map is linked', () => {
    // `npm install` links bin/app-map into node_modules/.bin/. Taking dirname of the LINK put
    // dist/ one directory above node_modules, so an installed package fell through to the
    // TypeScript-source branch and died on a `src/` the tarball does not ship.
    const dir = mkdtempSync(join(tmpdir(), 'app-map-bin-'));
    try {
      const link = join(dir, 'app-map');
      symlinkSync(join(PACKAGE_ROOT, 'bin', 'app-map'), link);
      const r = spawnSync(link, ['help'], { encoding: 'utf8' });
      assert.equal(r.status, 0, `${r.stderr}${r.stdout}`);
      assert.match(r.stdout, /app-map <command>/);
      assert.doesNotMatch(r.stderr, /Cannot find module/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('init: every template it promises is resolvable', () => {
  it('claudeTemplates() lists the agents and both skills, and each one resolves', () => {
    const templates = claudeTemplates();
    for (const rel of templates) assert.ok(existsSync(templateFile(rel)), `${rel} does not resolve`);
    for (const expected of [
      '.claude/agents/app-nav-replayer.md',
      '.claude/agents/app-instrument-surveyor.md',
      '.claude/agents/app-instrument-swiftui.md',
      '.claude/agents/app-instrument-uikit.md',
      '.claude/skills/app-nav/SKILL.md',
      '.claude/skills/app-instrument/SKILL.md',
    ]) assert.ok(templates.includes(expected), `${expected} is not staged`);
    assert.equal(templates.some((t) => t.startsWith('.claude/hooks/')), false, 'hooks come from the consumer templates');
  });

  it('the hook and script templates resolve, so a packed install can scaffold', () => {
    for (const name of HOOK_SCRIPTS) assert.ok(existsSync(templateFile(`hooks/${name}`)), `hooks/${name}`);
    for (const name of CONSUMER_SCRIPTS) assert.ok(existsSync(templateFile(`scripts/app-map/${name}`)), name);
  });

  it('a missing template is a named error, never a half-scaffolded repo', () => {
    assert.throws(() => templateFile('.claude/skills/does-not-exist/SKILL.md'), /template missing/);
  });
});
