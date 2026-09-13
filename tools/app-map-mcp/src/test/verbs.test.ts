/**
 * [C1] recipes/verbs.ts — the 04 §3.3 driver verb table (03 §3 `APP_MAP_DRIVER`). The headline
 * case is issue #9: every tool `@swmansion/argent@0.25.0` actually exposes must classify, because
 * a driver call that classifies as nothing used to vanish from the compiled recipe in silence.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ARGENT_VERBS, bareToolName, classifyVerb, isStepVerb, normalizeVerb } from '../recipes/verbs.ts';
import type { StepVerb, VerbKind } from '../recipes/verbs.ts';
import { REPO_ROOT } from './helpers.ts';

const ARGENT = 'argent';

const AGENT_FILE = join(REPO_ROOT, '.claude', 'agents', 'app-nav-replayer.md');
const SPEC_05 = join(REPO_ROOT, 'docs', 'specs', '05-harness-integration.md');

/** The `tools:` frontmatter line of a subagent file, verbatim (05 §5). */
function toolsLine(file: string): string {
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith('tools:'));
  assert.ok(line !== undefined, `no \`tools:\` line in ${file}`);
  return line;
}
const classify = (tool: string, driver = ARGENT): VerbKind => classifyVerb(tool, driver);

describe('classifyVerb — the @swmansion/argent@0.25.0 tool surface (04 §3.3, issue #9)', () => {
  it('classifies every tool the reporter confirmed against `argent tools`', () => {
    const expected: Record<string, VerbKind> = {
      'gesture-tap': 'tap',
      'gesture-swipe': 'swipe',
      'gesture-scroll': 'swipe',
      keyboard: 'type',
      paste: 'type',
      'open-url': 'open_link',
      button: 'unsupported',
      'tv-remote': 'unsupported',
      'run-sequence': 'batch',
      describe: 'perception',
      'native-describe-screen': 'perception',
      'native-full-hierarchy': 'perception',
      screenshot: 'perception',
      'await-ui-element': 'lifecycle',
      'await-screen-idle': 'lifecycle',
      'launch-app': 'lifecycle',
      'restart-app': 'lifecycle',
      'reinstall-app': 'lifecycle',
      'native-network-logs': 'lifecycle',
      'view-network-logs': 'lifecycle',
    };
    const actual: Record<string, VerbKind> = {};
    for (const tool of Object.keys(expected)) actual[tool] = classify(`mcp__argent__${tool}`);
    // one deepEqual so a regression names the tool that moved
    assert.deepEqual(actual, expected);
  });

  it('`keyboard` and `open-url` are the two the pre-#9 regexes dropped, and both are now verbs', () => {
    assert.equal(classify('mcp__argent__keyboard'), 'type');
    assert.equal(classify('mcp__argent__open-url'), 'open_link');
    assert.equal(isStepVerb(classify('mcp__argent__keyboard')), true);
    assert.equal(isStepVerb(classify('mcp__argent__open-url')), true);
    assert.equal(isStepVerb(classify('mcp__argent__screenshot')), false);
  });

  it('hyphens, underscores and case are the same verb: open-url === open_url === OPEN_URL (03 §3)', () => {
    assert.equal(normalizeVerb('mcp__argent__gesture-tap', ARGENT), 'gesture_tap');
    assert.equal(normalizeVerb('mcp__argent__OPEN-URL', ARGENT), 'open_url');
    for (const tool of ['open-url', 'open_url', 'OPEN_URL']) {
      assert.equal(classify(`mcp__argent__${tool}`), 'open_link', tool);
    }
    // ARGENT_VERBS is keyed on the normalized name, so a hyphenated tool needs no second entry
    assert.equal(Object.keys(ARGENT_VERBS).some((k) => k.includes('-')), false);
  });

  it('a driver with no table falls back to the generic patterns, so `type_text`/`open_url`/`tap`/`swipe` keep compiling (03 §3)', () => {
    assert.equal(classify('mcp__maestro__input_text', 'maestro'), 'type');
    assert.equal(classify('mcp__maestro__tapOn', 'maestro'), 'tap');
    assert.equal(classify('mcp__maestro__swipe', 'maestro'), 'swipe');
    assert.equal(classify('mcp__maestro__open_link', 'maestro'), 'open_link');
    assert.equal(classify('mcp__maestro__take_screenshot', 'maestro'), 'perception');
    // the names the committed fixtures and older trajectories carry (pre-0.25.0 Argent)
    assert.equal(classify('mcp__argent__type_text'), 'type');
    assert.equal(classify('mcp__argent__open_url'), 'open_link');
    assert.equal(classify('mcp__argent__tap'), 'tap');
    assert.equal(classify('mcp__argent__swipe'), 'swipe');
    assert.equal(classify('mcp__argent__describe_ui'), 'perception');
  });

  it('a tool in no table and matching no pattern is `unknown`, never nothing (issue #9)', () => {
    assert.equal(classify('mcp__argent__telemetry_flush'), 'unknown');
    assert.equal(classify('mcp__argent__'), 'unknown');
    assert.equal(classify('', ARGENT), 'unknown');
    assert.equal(isStepVerb(classify('mcp__argent__telemetry_flush')), false);
  });

  it('`report_step` is a known non-step for every driver (guided.reportStep synthesizes it, 04 §5)', () => {
    assert.equal(classify('mcp__argent__report_step'), 'lifecycle');
    assert.equal(classify('mcp__maestro__report_step', 'maestro'), 'lifecycle');
  });

  it('bareToolName strips `mcp__<driver>__`, a foreign driver prefix, and leaves a bare name alone', () => {
    assert.equal(bareToolName('mcp__argent__gesture-tap', ARGENT), 'gesture-tap');
    // a trajectory outlives an APP_MAP_DRIVER change: the recorded prefix may not be today's
    assert.equal(bareToolName('mcp__argent__gesture-tap', 'maestro'), 'gesture-tap');
    assert.equal(bareToolName('mcp__my_driver__tap', 'argent'), 'tap');
    assert.equal(bareToolName('tap', ARGENT), 'tap');
    assert.equal(classify('mcp__argent__keyboard', 'maestro'), 'type', 'a stale prefix still classifies');
  });
});

/**
 * The replayer subagent is granted a fixed tool list because `tools` has no per-tool glob
 * (harness-notes §2). That list was written before anyone ran Argent, so it named four tools the
 * driver does not register — the subagent as shipped could not tap, type, swipe or open a deep
 * link. These tests make `ARGENT_VERBS` (the surface confirmed against `argent tools`, issue #9)
 * the authority for what the harness may grant, so prose and the driver cannot drift apart again.
 */
describe('the harness config only grants Argent tools that exist (05 §5, harness-notes §2, issue #21)', () => {
  it('grants step-verb tools from the confirmed 0.25.0 surface, not the pre-#9 guesses', () => {
    const granted = toolsLine(AGENT_FILE)
      .slice('tools:'.length)
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.startsWith(`mcp__${ARGENT}__`));
    assert.ok(granted.length > 0, 'the replayer must be granted some driver tools');

    const verbs = new Set<StepVerb>();
    for (const tool of granted) {
      const bare = bareToolName(tool, ARGENT);
      // 1. It must be a tool `argent tools` actually lists. `tap`/`type_text`/`swipe` are not.
      assert.ok(
        Object.hasOwn(ARGENT_VERBS, normalizeVerb(tool, ARGENT)),
        `${tool} is not in the confirmed @swmansion/argent@0.25.0 surface (harness-notes §2)`,
      );
      // 2. Argent's registered names are HYPHENATED. `normalizeVerb` folds `-` to `_` for the
      //    classifier, so `open_url` passes (1) while being a name the harness can never match:
      //    `tools:` entries are compared literally. No confirmed tool contains an underscore.
      assert.ok(!bare.includes('_'), `${tool}: Argent registers hyphenated names, so this never matches`);
      // 3. The replayer only ever executes steps (04 §5), so every grant must be a step verb —
      //    no perception tools (§6 rule 1), no `run-sequence` (`batch`, rejected by the compiler).
      const kind = classifyVerb(tool, ARGENT);
      assert.ok(isStepVerb(kind), `${tool} classifies as ${kind}, which is not a replayable step`);
      verbs.add(kind);
    }
    // Between them they must cover all four 02 §6 step verbs, or some recipe is unreplayable.
    assert.deepEqual([...verbs].sort(), ['open_link', 'swipe', 'tap', 'type']);
  });

  it('05 §5 quotes the subagent file verbatim, so the two cannot drift (issue #21)', () => {
    // 05 §5 claims its fenced block IS `.claude/agents/app-nav-replayer.md`. Fixing one file and
    // forgetting the other is exactly how both came to name tools that do not exist.
    assert.ok(
      readFileSync(SPEC_05, 'utf8').includes(toolsLine(AGENT_FILE)),
      '05 §5 does not quote the subagent file\'s current `tools:` line',
    );
  });
});
