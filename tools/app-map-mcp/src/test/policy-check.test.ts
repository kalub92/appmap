/**
 * [D2] `app-map policy-check` (06 R3, 06 §5, 07 §5, 07 §6, 07 §8) and `intent-critical-diff`
 * (07 §4, 07 §7).
 */
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as yamlParse } from 'yaml';
import type { IdsRegistry, McpAllowlist, PolicyCheckResult, ScreenFile } from '../types.ts';
import { codexTomlFromMcp, cursorConfigFromMcp, parseMcpJson } from '../gen-configs.ts';
import { SECRET_PATTERNS, intentCriticalDiff, isPinnedNpx, looksLikeSecret, parseCodexToml, policyCheck } from '../policy-check.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { readAllowlist } from '../yaml/load.ts';
import { PILOT_APP_MAP_DIR, REPO_ROOT } from './helpers.ts';

const ALLOWLIST: McpAllowlist = readAllowlist({ dir: PILOT_APP_MAP_DIR });

const OK_MCP = {
  mcpServers: {
    'app-map': {
      command: 'node',
      args: ['${CLAUDE_PROJECT_DIR:-.}/tools/app-map-mcp/dist/index.js'],
      env: { APP_MAP_DIR: '${CLAUDE_PROJECT_DIR:-.}/app-map', APP_MAP_PLATFORM: '${APP_MAP_PLATFORM:-ios}' },
    },
    argent: { command: 'npx', args: ['-y', '@swmansion/argent@0.25.0'] },
  },
};

const OK_SETTINGS = {
  hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/app-map-session-start.sh', timeout: 30 }] }],
    PostToolUse: [{ matcher: 'mcp__argent__.*', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/app-map-record.sh', timeout: 5 }] }],
  },
};

interface Fixture { root: string; write: (rel: string, text: string) => void; check: (files?: string[]) => PolicyCheckResult }

function withRepo(fn: (f: Fixture) => void, opts: { mcp?: unknown; settings?: unknown } = {}): void {
  const root = mkdtempSync(join(tmpdir(), 'app-map-policy-'));
  try {
    const write = (rel: string, text: string): void => {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    };
    write('.mcp.json', `${JSON.stringify(opts.mcp ?? OK_MCP, null, 2)}\n`);
    write('.claude/settings.json', `${JSON.stringify(opts.settings ?? OK_SETTINGS, null, 2)}\n`);
    write('.claude/hooks/app-map-record.sh', '#!/bin/sh\nexit 0\n');
    write('.claude/hooks/app-map-session-start.sh', '#!/bin/sh\nexit 0\n');
    fn({ root, write, check: (files) => policyCheck(root, { allowlist: ALLOWLIST, ...(files !== undefined ? { files } : {}) }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rules = (r: PolicyCheckResult): string[] => [...new Set(r.violations.map((v) => v.rule))].sort();

describe('policy-check on the committed repo (06 R3)', () => {
  it('passes: every server allowlisted and pinned, no secrets, hooks inside .claude/hooks/', () => {
    const r = policyCheck(REPO_ROOT);
    assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
    assert.ok(r.ok);
  });

  it('parses all four 06 R3 files, and the generated Cursor/Codex configs too', () => {
    const r = policyCheck(REPO_ROOT, { files: ['.mcp.json', '.cursor/mcp.json', '.codex/config.toml', '.claude/settings.json'] });
    assert.ok(r.ok, JSON.stringify(r.violations));
  });
});

describe('06 §5: R3 fails on a .mcp.json that adds an unlisted server', () => {
  it('unlisted_server for a server missing from mcp-allowlist.yaml', () => {
    withRepo((f) => {
      const r = f.check();
      assert.deepEqual(rules(r), ['unlisted_server']);
      assert.match(r.violations[0]!.message, /"rogue"/);
      assert.equal(r.violations[0]!.file, '.mcp.json');
      assert.equal(r.ok, false);
    }, { mcp: { mcpServers: { ...OK_MCP.mcpServers, rogue: { command: 'node', args: ['rogue.js'] } } } });
  });

  it('unlisted_server when the npm pin differs from the approved package@version', () => {
    withRepo((f) => {
      const r = f.check();
      assert.ok(r.violations.some((v) => v.rule === 'unlisted_server' && /@swmansion\/argent@0\.25\.0/.test(v.message)), JSON.stringify(r.violations));
    }, { mcp: { mcpServers: { ...OK_MCP.mcpServers, argent: { command: 'npx', args: ['-y', '@swmansion/argent@0.99.0'] } } } });
  });

  it('unlisted_server when an in-repo server runs different args', () => {
    withRepo((f) => {
      const r = f.check();
      assert.ok(r.violations.some((v) => v.rule === 'unlisted_server' && /args/.test(v.message)), JSON.stringify(r.violations));
    }, { mcp: { mcpServers: { ...OK_MCP.mcpServers, 'app-map': { command: 'node', args: ['/somewhere/else.js'] } } } });
  });

  it('an unlisted server in the generated Codex TOML is caught too', () => {
    withRepo((f) => {
      f.write('.codex/config.toml', '[mcp_servers.rogue]\ncommand = "node"\nargs = ["rogue.js"]\n');
      const r = f.check();
      assert.ok(r.violations.some((v) => v.rule === 'unlisted_server' && v.file === '.codex/config.toml'));
    });
  });
});

describe('06 R3: npx without an exact version pin', () => {
  it('unpinned_npx for @latest, a bare name and a range', () => {
    for (const spec of ['@swmansion/argent@latest', '@swmansion/argent', '@swmansion/argent@^0.25.0', '@swmansion/argent@0.25']) {
      withRepo((f) => {
        const r = f.check();
        assert.ok(r.violations.some((v) => v.rule === 'unpinned_npx'), `${spec} should be unpinned: ${JSON.stringify(r.violations)}`);
      }, { mcp: { mcpServers: { argent: { command: 'npx', args: ['-y', spec] } } } });
    }
  });

  it('isPinnedNpx accepts an exact pin (with -y or -p) and nothing looser', () => {
    assert.ok(isPinnedNpx('npx', ['-y', '@swmansion/argent@0.25.0']));
    assert.ok(isPinnedNpx('npx', ['@swmansion/argent@0.25.0']));
    assert.ok(isPinnedNpx('npx', ['-p', 'pkg@1.2.3', 'bin']));
    assert.ok(isPinnedNpx('npx', ['-y', 'pkg@1.2.3-beta.1']));
    assert.ok(isPinnedNpx('/usr/local/bin/npx', ['-y', 'pkg@1.2.3']));
    assert.ok(!isPinnedNpx('npx', ['-y', 'pkg']));
    assert.ok(!isPinnedNpx('npx', ['-y', 'pkg@latest']));
    assert.ok(!isPinnedNpx('npx', ['-y', 'pkg@~1.2.3']));
    assert.ok(!isPinnedNpx('npx', []));
    // npx hidden inside a shell command is still an npx invocation
    assert.ok(!isPinnedNpx('sh', ['-c', 'npx -y pkg']));
    assert.ok(isPinnedNpx('sh', ['-c', 'npx -y pkg@1.2.3']));
    // not an npx invocation at all
    assert.ok(isPinnedNpx('node', ['dist/index.js']));
  });
});

describe('06 R3: token/secret-looking literals in env, headers or url (07 §2.3.5)', () => {
  it('secret_literal for a literal token in env', () => {
    withRepo((f) => {
      const r = f.check();
      assert.ok(r.violations.some((v) => v.rule === 'secret_literal' && /env\.APP_MAP_TOKEN/.test(v.message)), JSON.stringify(r.violations));
      assert.equal(r.ok, false);
    }, {
      mcp: {
        mcpServers: {
          'app-map': { command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/tools/app-map-mcp/dist/index.js'], env: { APP_MAP_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123' } },
        },
      },
    });
  });

  it('secret_literal for a Bearer header and a token in a url', () => {
    withRepo((f) => {
      const r = f.check();
      const messages = r.violations.filter((v) => v.rule === 'secret_literal').map((v) => v.message).join('\n');
      assert.match(messages, /headers\.Authorization/);
      assert.match(messages, /url/);
    }, {
      mcp: {
        mcpServers: {
          'app-map': { url: 'https://example.test/mcp?token=s3cretvalue', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwx' } },
        },
      },
    });
  });

  it('${VAR} references are fine', () => {
    withRepo((f) => {
      assert.ok(f.check().ok);
    }, {
      mcp: {
        mcpServers: {
          'app-map': { command: 'node', args: ['${CLAUDE_PROJECT_DIR:-.}/tools/app-map-mcp/dist/index.js'], env: { APP_MAP_TOKEN: '${APP_MAP_TOKEN}', APP_MAP_DIR: '${CLAUDE_PROJECT_DIR:-.}/app-map' } },
          argent: OK_MCP.mcpServers.argent,
        },
      },
    });
  });

  it('looksLikeSecret covers every SECRET_PATTERNS family and no plain value', () => {
    for (const secret of [
      'AKIAIOSFODNN7EXAMPLE',
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwxyz0123',
      'xoxb-1234567890-abcdef',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk',
      'Bearer abcdefghijklmnopqrstuvwx',
      'password=hunter2000',
      '0123456789abcdef0123456789abcdef',
    ]) {
      assert.ok(looksLikeSecret(secret), `expected secret: ${secret}`);
    }
    for (const plain of ['${APP_MAP_TOKEN}', '${CLAUDE_PROJECT_DIR:-.}/app-map', 'ios', 'info', 'node', '', '4412']) {
      assert.ok(!looksLikeSecret(plain), `expected not a secret: ${plain}`);
    }
    assert.ok(SECRET_PATTERNS.length >= 8, 'the 06 R3 pattern list stays in place');
  });
});

describe('06 R3: a hook script outside .claude/hooks/', () => {
  it('hook_outside_dir for a command elsewhere in the repo and for an absolute path', () => {
    withRepo((f) => {
      const r = f.check();
      assert.deepEqual(rules(r), ['hook_outside_dir']);
      assert.equal(r.violations.length, 2, JSON.stringify(r.violations));
      assert.equal(r.violations[0]!.file, '.claude/settings.json');
    }, {
      settings: {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/scripts/evil.sh' }] }],
          Stop: [{ hooks: [{ type: 'command', command: '/usr/bin/curl https://example.test' }] }],
        },
      },
    });
  });

  it('a path that escapes via .. is rejected', () => {
    withRepo((f) => {
      assert.deepEqual(rules(f.check()), ['hook_outside_dir']);
    }, { settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: '$CLAUDE_PROJECT_DIR/.claude/hooks/../../evil.sh' }] }] } } });
  });

  it('${CLAUDE_PROJECT_DIR} (braced) resolves the same way', () => {
    withRepo((f) => {
      assert.ok(f.check().ok);
    }, { settings: { hooks: { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/app-map-record.sh' }] }] } } });
  });

  it('non-command hook entries are ignored', () => {
    withRepo((f) => {
      assert.ok(f.check().ok);
    }, { settings: { hooks: { Stop: [{ hooks: [{ type: 'other', command: '/anywhere/x.sh' }] }] } } });
  });

  it('missing files are skipped, not violations', () => {
    withRepo((f) => {
      assert.ok(f.check(['.cursor/mcp.json', '.codex/config.toml']).ok);
    });
  });
});

describe('parseCodexToml (minimal reader)', () => {
  it('round-trips what codexTomlFromMcp writes', () => {
    const mcp = parseMcpJson(JSON.stringify(OK_MCP));
    const parsed = parseCodexToml(codexTomlFromMcp(mcp));
    assert.deepEqual(Object.keys(parsed).sort(), ['app-map', 'argent']);
    assert.equal(parsed['app-map']!.command, 'node');
    assert.deepEqual(parsed['app-map']!.args, ['${CLAUDE_PROJECT_DIR:-.}/tools/app-map-mcp/dist/index.js']);
    assert.equal(parsed['app-map']!.env?.APP_MAP_PLATFORM, '${APP_MAP_PLATFORM:-ios}');
    assert.deepEqual(parsed.argent!.args, ['-y', '@swmansion/argent@0.25.0']);
    // the Cursor JSON is the same object, so both generated files agree
    assert.deepEqual(Object.keys(JSON.parse(cursorConfigFromMcp(mcp)).mcpServers as object).sort(), ['app-map', 'argent']);
  });

  it('ignores comments, other tables and unknown keys; handles quoted keys and url', () => {
    const parsed = parseCodexToml([
      '# a comment',
      '[model]',
      'name = "ignored"',
      '',
      '[mcp_servers."odd name"]',
      'command = "node"',
      'url = "https://example.test/mcp"',
      'startup_timeout_ms = 10000',
      '',
      '[mcp_servers."odd name".env]',
      'A = "1"',
      '"B-KEY" = "2"',
    ].join('\n'));
    assert.deepEqual(Object.keys(parsed), ['odd name']);
    assert.equal(parsed['odd name']!.url, 'https://example.test/mcp');
    assert.deepEqual(parsed['odd name']!.env, { A: '1', 'B-KEY': '2' });
  });

  it('an empty document parses to an empty map', () => {
    assert.deepEqual(parseCodexToml(''), {});
  });
});

// ---------------------------------------------------------------------------------------------
// intent-critical-diff (07 §4, 07 §7)
// ---------------------------------------------------------------------------------------------

function withPilotRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'app-map-icd-'));
  try {
    cpSync(PILOT_APP_MAP_DIR, join(root, 'app-map'), { recursive: true, filter: (src) => !src.split(/[/\\]/).includes('.local') });
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** the pilot ids.yaml with `intent_critical` of one id forced to `value` (or removed) */
function idsWith(root: string, id: string, value: boolean | undefined): string {
  const doc = yamlParse(readFileSync(join(root, 'app-map', 'ids.yaml'), 'utf8')) as IdsRegistry;
  const el = doc.elements.find((e) => e.id === id);
  assert.ok(el !== undefined, `${id} must be in the pilot registry`);
  if (value === undefined) delete (el as { intent_critical?: boolean }).intent_critical;
  else el.intent_critical = value;
  return canonicalYaml('ids', doc);
}

describe('intentCriticalDiff (07 §4, 07 §7)', () => {
  it('reports a downgrade true → false with a markdown row and no upgrade', () => {
    withPilotRepo((root) => {
      const base = idsWith(root, 'invoice.save.button', true);
      writeFileSync(join(root, 'app-map', 'ids.yaml'), idsWith(root, 'invoice.save.button', false));
      const r = intentCriticalDiff(root, 'origin/main', { readAtRef: (_ref, rel) => (rel.endsWith('ids.yaml') ? base : undefined) });
      assert.deepEqual(r.downgraded, ['invoice.save.button']);
      assert.deepEqual(r.upgraded, []);
      assert.equal(r.base_ref, 'origin/main');
      assert.match(r.markdown, /\| `invoice\.save\.button` \| downgraded/);
      assert.match(r.markdown, /two approvals/);
    });
  });

  it('reports an upgrade false → true', () => {
    withPilotRepo((root) => {
      const base = idsWith(root, 'invoice.save.button', false);
      const r = intentCriticalDiff(root, 'HEAD~1', { readAtRef: (_ref, rel) => (rel.endsWith('ids.yaml') ? base : undefined) });
      assert.deepEqual(r.upgraded, ['invoice.save.button']);
      assert.deepEqual(r.downgraded, []);
      assert.match(r.markdown, /upgraded/);
    });
  });

  it('an absent `intent_critical` in the base counts as false (decision 26)', () => {
    withPilotRepo((root) => {
      const base = idsWith(root, 'invoice.save.button', undefined);
      const r = intentCriticalDiff(root, 'HEAD', { readAtRef: (_ref, rel) => (rel.endsWith('ids.yaml') ? base : undefined) });
      assert.deepEqual(r.upgraded, ['invoice.save.button']);
    });
  });

  it('lists intent_critical elements whose screen element or recipe step changed (07 §4)', () => {
    withPilotRepo((root) => {
      const screenRel = 'app-map/ios/screens/invoice_new.yaml';
      const screenText = readFileSync(join(root, screenRel), 'utf8');
      const doc = yamlParse(screenText) as ScreenFile;
      const save = doc.elements.find((e) => e.id === 'invoice.save.button');
      assert.ok(save !== undefined && save.locators.length > 0, 'the pilot screen declares invoice.save.button');
      save.locators[0]!.weight = 0.42; // a locator change on an intent_critical element (07 §4)
      writeFileSync(join(root, screenRel), canonicalYaml('screen', doc));
      const idsText = readFileSync(join(root, 'app-map', 'ids.yaml'), 'utf8');
      const r = intentCriticalDiff(root, 'HEAD', {
        readAtRef: (_ref, rel) => (rel.endsWith('ids.yaml') ? idsText : rel === screenRel ? screenText : readFileSync(join(root, rel), 'utf8')),
      });
      assert.deepEqual(r.downgraded, []);
      assert.deepEqual(r.touched, [{ element: 'invoice.save.button', file: screenRel }]);
      assert.match(r.markdown, /\| `invoice\.save\.button` \| touched \| `app-map\/ios\/screens\/invoice_new\.yaml`/);
    });
  });

  it('no changes → empty lists and a plain markdown note', () => {
    withPilotRepo((root) => {
      const idsText = readFileSync(join(root, 'app-map', 'ids.yaml'), 'utf8');
      const r = intentCriticalDiff(root, 'main', {
        readAtRef: (_ref, rel) => (rel.endsWith('ids.yaml') ? idsText : readFileSync(join(root, rel), 'utf8')),
      });
      assert.deepEqual(r.downgraded, []);
      assert.deepEqual(r.upgraded, []);
      assert.deepEqual(r.touched, []);
      assert.match(r.markdown, /No `intent_critical` changes against `main`/);
    });
  });

  it('a missing base file is treated as empty and never throws', () => {
    withPilotRepo((root) => {
      const r = intentCriticalDiff(root, 'does-not-exist', { readAtRef: () => undefined });
      // every intent_critical id looks new, so they are upgrades, not downgrades
      assert.deepEqual(r.downgraded, []);
      assert.ok(r.upgraded.includes('invoice.save.button'));
    });
  });

  it('a malformed base file is treated as empty and never throws', () => {
    withPilotRepo((root) => {
      const r = intentCriticalDiff(root, 'broken', { readAtRef: () => ':\n  - [unbalanced' });
      assert.deepEqual(r.downgraded, []);
    });
  });
});
