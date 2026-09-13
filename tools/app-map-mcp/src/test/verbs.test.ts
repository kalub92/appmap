/**
 * [C1] recipes/verbs.ts — the 04 §3.3 driver verb table (03 §3 `APP_MAP_DRIVER`). The headline
 * case is issue #9: every tool `@swmansion/argent@0.25.0` actually exposes must classify, because
 * a driver call that classifies as nothing used to vanish from the compiled recipe in silence.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ARGENT_VERBS, bareToolName, classifyVerb, isStepVerb, normalizeVerb } from '../recipes/verbs.ts';
import type { VerbKind } from '../recipes/verbs.ts';

const ARGENT = 'argent';
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
