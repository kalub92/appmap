/**
 * [B2] settle.ts — the settle hint every handed-out step carries (04 §5, issue #26).
 *
 * The measured claim behind the feature: replacing a fixed `sleep(n)` per step with a poll for the
 * step's own declared postcondition took a real suite from 144.1 s to 79.7 s AND removed a flake
 * mode. These tests pin the two properties that make that safe rather than lucky — the target is
 * the same assertion `report_step` is about to check, and a step that declares nothing pollable
 * gets NO hint rather than a guess.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { RecipeFile, RecipeStep, RunStep } from '../types.ts';
import { STEP_MAX_TOKENS, formatRunStep } from '../format.ts';
import { estimateTokens } from '../token.ts';
import { DEFAULT_SETTLE_MS, settleFor } from '../settle.ts';
import { expandSteps, toRunStep } from '../recipes/guided.ts';
import { makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const PARAMS = { amount: 50, client: 'Acme Corp' };

let t: TempAppMapDir;
let ctx: AppMapContext;
beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
afterEach(() => { ctx.close(); t.cleanup(); });

const pilot = (): RecipeFile => structuredClone(ctx.map.recipes.get('create_invoice')!);

/** every expanded step of the pilot, with the settle context the guided runner supplies */
function pilotSteps(): RunStep[] {
  const recipe = pilot();
  const expanded = expandSteps(ctx.map, recipe);
  return expanded.map((e, i) => toRunStep(ctx.map, e.step, PARAMS, {
    settle: {
      ...(e.screen !== undefined ? { screen: e.screen } : {}),
      verify: recipe.verify,
      ...(i === expanded.length - 1 ? { isLast: true } : {}),
    },
  }));
}

describe('settleFor — the server derives what the driver should poll for (issue #26)', () => {
  it('prefers the screen marker: the stable target, unchanged by whatever data is on screen', () => {
    const steps = pilotSteps();
    const s3 = steps.find((s) => s.id === 's3')!;
    assert.deepEqual(s3.settle, {
      target: { by: 'id', id: 'screen.client_picker' },
      condition: 'visible',
      source: 'expect.screen',
      timeout_ms: DEFAULT_SETTLE_MS,
    });
  });

  it('falls to expect.visible when the step asserts no screen', () => {
    const s1 = pilotSteps().find((s) => s.id === 's1')!;
    assert.equal(s1.settle?.source, 'expect.visible');
    assert.deepEqual(s1.settle?.target, { by: 'id', id: 'invoice.amount.field' });
  });

  it('gives NO hint for a step that declares nothing pollable — report at once, never sleep', () => {
    // s2 is `type` with no `expect`. The issue is explicit that this is the honest answer: absent
    // is the encoding, and there is no empty-hint form to confuse it with.
    const s2 = pilotSteps().find((s) => s.id === 's2')!;
    assert.equal(s2.settle, undefined);
  });

  it('covers the whole pilot: five of six steps settle on a stable id', () => {
    const withHint = pilotSteps().filter((s) => s.settle !== undefined);
    assert.equal(withHint.length, 5);
    assert.ok(withHint.every((s) => s.settle!.target.by === 'id'));
  });

  it('prefers a NON-dynamic element over a dynamic one in the same `visible` list', () => {
    const recipe = pilot();
    // invoice.list.cell is `dynamic: true` in ids.yaml; invoice.add.button is not
    const step: RecipeStep = {
      id: 's1', action: 'tap', element: 'invoice.add.button',
      expect: { visible: ['invoice.list.cell', 'invoice.add.button'] },
    };
    const hint = settleFor(ctx.map, step, { screen: 'invoice_list', verify: recipe.verify });
    assert.deepEqual(hint?.target, { by: 'id', id: 'invoice.add.button' }, 'a data-driven row proves the list rendered, not that the right one did');
  });

  it('still uses a dynamic element when it is the only candidate — better than sleeping', () => {
    const step: RecipeStep = { id: 's1', action: 'tap', element: 'invoice.add.button', expect: { visible: ['invoice.list.cell'] } };
    assert.deepEqual(settleFor(ctx.map, step, { screen: 'invoice_list' })?.target, { by: 'id', id: 'invoice.list.cell' });
  });

  it('a `wait_for` names its own budget; everything else gets the shared default', () => {
    const wait: RecipeStep = { id: 's9', action: 'wait_for', expect: { screen: 'invoice_detail' }, timeout_ms: 25_000 };
    assert.equal(settleFor(ctx.map, wait, {})?.timeout_ms, 25_000);
    const tap: RecipeStep = { id: 's1', action: 'tap', element: 'invoice.add.button', expect: { screen: 'invoice_new' } };
    assert.equal(settleFor(ctx.map, tap, {})?.timeout_ms, DEFAULT_SETTLE_MS);
  });

  it('the last step settles on the recipe `verify` when it declares no expect of its own', () => {
    const recipe = pilot();
    const bare: RecipeStep = { id: 's5', action: 'tap', element: 'invoice.save.button', intent_critical: true };
    const hint = settleFor(ctx.map, bare, { verify: recipe.verify, isLast: true });
    assert.equal(hint?.source, 'verify.screen');
    assert.deepEqual(hint?.target, { by: 'id', id: 'screen.invoice_detail' });
  });

  it('does NOT reach for `verify` on a step that is not the last one', () => {
    const recipe = pilot();
    const bare: RecipeStep = { id: 's2', action: 'tap', element: 'invoice.save.button' };
    assert.equal(settleFor(ctx.map, bare, { verify: recipe.verify }), undefined);
  });

  it('`not_visible` is last resort and polls for absence', () => {
    const step: RecipeStep = { id: 's1', action: 'tap', element: 'invoice.add.button', expect: { not_visible: ['invoice.add.button'] } };
    const hint = settleFor(ctx.map, step, { screen: 'invoice_list' });
    assert.equal(hint?.condition, 'not_visible');
    assert.equal(hint?.source, 'expect.not_visible');
  });

  it('a value assertion contributes its ELEMENT: the value is not pollable, its presence is (issue #23)', () => {
    const step: RecipeStep = {
      id: 's5', action: 'tap', element: 'invoice.save.button',
      expect: { value: [{ element: 'invoice.detail.amount.text', equals: '{amount}' }] },
    };
    const hint = settleFor(ctx.map, step, { screen: 'invoice_detail' });
    assert.equal(hint?.source, 'expect.value');
    assert.deepEqual(hint?.target, { by: 'id', id: 'invoice.detail.amount.text' });
  });

  it('reports the gates the destination screen may raise, so a driver can budget for one', () => {
    const step: RecipeStep = { id: 's1', action: 'tap', element: 'nav.invoices.tab', expect: { screen: 'login' } };
    const hint = settleFor(ctx.map, step, {});
    // login declares gate.biometric_prompt on entry
    assert.deepEqual(hint?.gates_possible, ['gate.biometric_prompt']);
  });

  it('a synthesized gate dismissal settles on the DIALOG GOING AWAY (04 §5 gate budget)', () => {
    // not on the interrupted step's postcondition: the runner hands that step back with `retry`,
    // so it has not been re-executed and its postcondition legitimately does not hold yet —
    // polling for it would burn the whole budget on every single gate.
    const dismissal: RecipeStep = { id: 's3', action: 'dismiss_gate', gate: 'gate.push_permission' };
    const hint = settleFor(ctx.map, dismissal, {});
    assert.equal(hint?.source, 'gate.retry');
    assert.equal(hint?.condition, 'not_visible');
    // the pilot's push_permission deny button is addressed by its label regex (an OS dialog
    // carries no app id), which is the id-shaped form a driver polls
    assert.deepEqual(hint?.target, { by: 'id', id: '^Don.t Allow$' });
  });

  it('a gate whose dismiss control cannot be addressed gets no hint rather than a guess', () => {
    const dismissal: RecipeStep = { id: 's3', action: 'dismiss_gate', gate: 'gate.nonexistent' as never };
    assert.equal(settleFor(ctx.map, dismissal, {}), undefined);
  });

  it('never proposes a target the driver cannot address (no path, no geometry)', () => {
    // every hint the pilot produces is an id or text — a `path` selector is not pollable, and a
    // geometry one is satisfied by an empty region at the right coordinates
    for (const step of pilotSteps()) {
      if (step.settle === undefined) continue;
      assert.ok(['id', 'text', 'role_label'].includes(step.settle.target.by), `${step.id}: ${step.settle.target.by}`);
    }
  });
});

describe('the hint travels inside the 04 §5 step budget', () => {
  it('every pilot step still formats within 120 tokens with its settle', () => {
    for (const step of pilotSteps()) {
      const text = formatRunStep(step);
      assert.ok(estimateTokens(text) <= STEP_MAX_TOKENS, `${step.id}: ${text}`);
    }
  });

  it('the formatted step names the settle so a human reading the trace can see it', () => {
    const s3 = pilotSteps().find((s) => s.id === 's3')!;
    assert.match(formatRunStep(s3), /settle visible screen\.client_picker 10000ms/);
  });
});
