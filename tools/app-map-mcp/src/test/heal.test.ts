/**
 * [C2] heal.ts — 04 §7 candidate scoring, acceptance and the three-stage apply/reject API.
 * The 04 §9 acceptance criteria drive the scenarios: a renamed label with the id kept needs no
 * heal; a removed id with the label kept heals by `role_label`; `invoice.save.button`
 * (intent_critical) with a changed label and no id is rejected as
 * `intent_critical_label_changed`.
 */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { ElementDef, HealInput, PendingHeal, RecipeStep, ScreenId, ScrubbedTree, Tree, TreeNode } from '../types.ts';
import { HEAL_ACCEPT_SCORE, HEAL_RUNNER_UP_MARGIN, HEAL_WEIGHTS } from '../types.ts';
import { readEvents } from '../events.ts';
import { buildScrubPolicy, scrub } from '../scrub.ts';
import { normalizeTree, walk } from '../tree.ts';
import { resolve } from '../resolve.ts';
import {
  COMPATIBLE_ROLES, applyHeal, bboxProximity, heal, healedElement, jaroWinkler, lcsLength,
  proposeHeal, rejectHeal, scoreCandidates, toPendingHeal,
} from '../heal.ts';
import { stringsFile } from '../paths.ts';
import { loadFixtureTree, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

let t: TempAppMapDir;
let ctx: AppMapContext;
beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true, dbPath: ':memory:' });
});
afterEach(() => { ctx.close(); t.cleanup(); });

/** the pilot tree as ingest would have stored it, after `mutate` changed the live UI */
function observed(name: string, mutate: (tree: Tree) => void = () => {}): ScrubbedTree {
  const tree = normalizeTree(loadFixtureTree(name), { platform: 'ios' });
  mutate(tree);
  return scrub(tree, buildScrubPolicy(ctx.map.ids, ctx.map.staticLabels));
}
function node(tree: Tree | ScrubbedTree, pred: (n: TreeNode) => boolean): TreeNode {
  let found: TreeNode | undefined;
  walk(tree, (n) => { if (found === undefined && pred(n)) found = n; return undefined; });
  assert.ok(found !== undefined, 'node not found in the fixture tree');
  return found;
}
const byId = (id: string) => (n: TreeNode): boolean => n.a11y_id === id;

function element(screen: ScreenId, id: string): ElementDef {
  const def = ctx.map.screens.get(screen)?.elements.find((e) => e.id === id);
  assert.ok(def !== undefined, `${id} is declared on ${screen}`);
  return structuredClone(def);
}
function step(over: Partial<RecipeStep> = {}): RecipeStep {
  return { id: 's1', action: 'tap', element: 'invoice.add.button', expect: { screen: 'invoice_new' }, ...over } as RecipeStep;
}
function healInput(over: Partial<HealInput> & { tree: ScrubbedTree }): HealInput {
  const def = over.element ?? element('invoice_list', 'invoice.add.button');
  return {
    recipe: 'create_invoice', step: step(), screen: 'invoice_list', element: def, intent_critical: false,
    trigger: { status: 'miss', element: def.id, tried: [{ strategy: 'a11y_id', matches: 0 }], candidates: [] },
    build: '4412', ...over,
  };
}
const healEvents = () => readEvents(t.config).events.filter((e) => e.kind === 'heal');

/**
 * Teach the scrubber a piece of static copy the NEW build introduced (07 §2.3.3: labels survive
 * only when the build's string table has them), then reload the map so the policy picks it up.
 */
function withStaticLabel(label: string): void {
  appendFileSync(stringsFile(t.config), `${label}\n`, 'utf8');
  ctx.reload();
}

// ---------------------------------------------------------------------------------------------
// 04 §7.1 the weights and the scalar features
// ---------------------------------------------------------------------------------------------

describe('04 §7.1 weights and thresholds are the spec numbers', () => {
  it('weights sum to 1 and match the table', () => {
    assert.deepEqual({ ...HEAL_WEIGHTS }, { role: 0.35, label: 0.3, path: 0.15, bbox: 0.1, parent_sibling: 0.1 });
    assert.ok(Math.abs(Object.values(HEAL_WEIGHTS).reduce((a, b) => a + b, 0) - 1) < 1e-9);
  });

  it('acceptance score 0.75 and runner-up margin 0.10 (04 §7.2 rule 1)', () => {
    assert.equal(HEAL_ACCEPT_SCORE, 0.75);
    assert.equal(HEAL_RUNNER_UP_MARGIN, 0.1);
  });

  it('compatible role groups are button/link/tab, field/secureField/searchField, list/scrollView', () => {
    assert.deepEqual(COMPATIBLE_ROLES.map((s) => [...s].sort()), [
      ['button', 'link', 'tab'],
      ['field', 'searchField', 'secureField'],
      ['list', 'scrollView'],
    ]);
  });
});

describe('jaroWinkler', () => {
  it('reproduces the reference values', () => {
    assert.equal(jaroWinkler('martha', 'marhta'), 0.9611);
    assert.equal(jaroWinkler('dixon', 'dicksonx'), 0.8133);
  });
  it('is 1 for equal strings (including empty) and 0 when one side is empty or disjoint', () => {
    assert.equal(jaroWinkler('save', 'save'), 1);
    assert.equal(jaroWinkler('', ''), 1);
    assert.equal(jaroWinkler('', 'save'), 0);
    assert.equal(jaroWinkler('save', ''), 0);
    assert.equal(jaroWinkler('abc', 'xyz'), 0);
  });
  it('stays inside [0,1]', () => {
    for (const [a, b] of [['new invoice', 'new invoices'], ['filter', 'new invoice'], ['save', 'done']]) {
      const v = jaroWinkler(a!, b!);
      assert.ok(v >= 0 && v <= 1, `${a}/${b} → ${v}`);
    }
  });
});

describe('lcsLength', () => {
  it('known values', () => {
    assert.equal(lcsLength(['a', 'b', 'c'], ['a', 'c']), 2);
    assert.equal(lcsLength(['a', 'b', 'c'], ['a', 'b', 'c']), 3);
    assert.equal(lcsLength(['a', 'b'], ['b', 'a']), 1);
    assert.equal(lcsLength([], [1]), 0);
    assert.equal(lcsLength([1], []), 0);
  });
});

describe('bboxProximity — 1 − min(1, dist/0.5)', () => {
  it('is 1 at the same centre, 0.5 at a quarter and 0 at or beyond half the screen', () => {
    assert.equal(bboxProximity({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), 1);
    assert.equal(bboxProximity({ x: 0, y: 0 }, { x: 0, y: 0.25 }), 0.5);
    assert.equal(bboxProximity({ x: 0, y: 0 }, { x: 0, y: 0.5 }), 0);
    assert.equal(bboxProximity({ x: 0, y: 0 }, { x: 1, y: 1 }), 0);
  });
});

// ---------------------------------------------------------------------------------------------
// 04 §9: the label changed but the id did not — no heal needed at all
// ---------------------------------------------------------------------------------------------

describe('04 §9: renaming a label with the id unchanged leaves replay unaffected', () => {
  it('resolves by a11y_id at full confidence, so nothing ever reaches heal', () => {
    const tree = observed('invoice_list', (raw) => {
      node(raw, byId('invoice.add.button')).label = 'Add invoice';
    });
    const def = element('invoice_list', 'invoice.add.button');
    const hit = resolve(ctx.map, def, tree);
    assert.equal(hit.status, 'hit');
    assert.equal(hit.status === 'hit' && hit.strategy, 'a11y_id');
    assert.equal(hit.status === 'hit' && hit.degraded, false);
  });
});

// ---------------------------------------------------------------------------------------------
// 04 §9: the id was removed but the label kept — heals via role_label
// ---------------------------------------------------------------------------------------------

/** the 04 §9 scenario: `invoice.add.button` lost its accessibility id, the label survived */
function idRemoved(): ScrubbedTree {
  return observed('invoice_list', (raw) => {
    delete node(raw, byId('invoice.add.button')).a11y_id;
  });
}

describe('04 §9: removing the id but keeping the label heals by role_label', () => {
  it('scores the surviving node at 1.0 with every feature contributing', () => {
    const input = healInput({ tree: idRemoved() });
    const candidates = scoreCandidates(input);
    const top = candidates[0]!;
    assert.equal(top.path, 'navigationBar/button[1]');
    assert.equal(top.label, 'New Invoice');
    assert.equal(top.a11y_id, undefined);
    assert.equal(top.score, 1);
    assert.equal(top.features.role, 1);
    assert.equal(top.features.label, 1);
    assert.equal(top.features.path, 1);
    assert.equal(top.features.parent_sibling, 1);
    assert.ok(top.features.bbox > 0.99);
    // sorted by score desc
    for (let i = 1; i < candidates.length; i++) assert.ok(candidates[i - 1]!.score >= candidates[i]!.score);
  });

  it('proposes it: score ≥ 0.75, runner-up ≥ 0.10 lower, new locator role_label', () => {
    const proposal = proposeHeal(healInput({ tree: idRemoved() }));
    assert.equal(proposal.reason, 'accepted');
    assert.ok(proposal.candidate !== undefined);
    assert.ok(proposal.candidate.score >= HEAL_ACCEPT_SCORE);
    assert.ok(proposal.runner_up !== undefined);
    assert.ok(proposal.candidate.score - proposal.runner_up.score >= HEAL_RUNNER_UP_MARGIN);
    assert.equal(proposal.candidate.proposed_locator.strategy, 'role_label');
    assert.deepEqual(proposal.candidate.proposed_locator.value, { role: 'button', label: 'New Invoice' });
    assert.ok(proposal.candidates.length <= 3);
  });

  it('applyHeal writes the element (rank-0 locator, healed_pending_review, screen dirty) and logs the heal event', () => {
    const input = healInput({ tree: idRemoved() });
    const proposal = proposeHeal(input);
    assert.ok(proposal.candidate !== undefined);
    const result = applyHeal(ctx, { input, candidate: proposal.candidate, ...(proposal.runner_up ? { runner_up: proposal.runner_up } : {}) }, { run_id: 'run_x' });

    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'accepted');
    const updated = result.updated_element!;
    assert.equal(updated.status, 'healed_pending_review');
    assert.equal(updated.locators[0]!.strategy, 'role_label');
    assert.deepEqual(updated.locators[0]!.value, { role: 'button', label: 'New Invoice' });
    // the replaced strategy never survives at a lower rank
    assert.equal(updated.locators.filter((l) => l.strategy === 'role_label').length, 1);
    // the a11y_id locator stays in the cascade for the build that brings the id back
    assert.ok(updated.locators.some((l) => l.strategy === 'a11y_id'));
    assert.equal(updated.fingerprint?.label_norm, 'new invoice');

    // the cache, never YAML (04 §7.3)
    const stored = ctx.db.getScreen('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    assert.equal(stored.status, 'healed_pending_review');
    assert.deepEqual(ctx.db.listDirty().filter((d) => d.kind === 'screen' && d.key === 'invoice_list').map((d) => d.reason), ['heal']);
    assert.equal(ctx.db.getCounters('element', 'invoice.add.button').heals, 1);

    // 08 §2 `heal`: old locator, new locator, score and step
    const events = healEvents();
    assert.equal(events.length, 1);
    const ev = events[0]!;
    assert.equal(ev.kind === 'heal' && ev.accepted, true);
    assert.equal(ev.kind === 'heal' && ev.reason, 'accepted');
    assert.equal(ev.kind === 'heal' && ev.step, 's1');
    assert.equal(ev.kind === 'heal' && ev.element, 'invoice.add.button');
    assert.equal(ev.kind === 'heal' && ev.old_strategy, 'a11y_id');
    assert.equal(ev.kind === 'heal' && ev.new_strategy, 'role_label');
    assert.equal(ev.kind === 'heal' && ev.score, 1);
    assert.equal(ev.kind === 'heal' && ev.build, '4412');
    assert.equal(ev.kind === 'heal' && ev.run_id, 'run_x');
    assert.equal(result.record.old_locator?.strategy, 'a11y_id');
    assert.equal(result.record.new_locator?.strategy, 'role_label');
  });

  it('04 §7.2: a candidate that HAS an id is promoted as a new a11y_id locator at rank 0', () => {
    // the new build renamed both the id and the label, so only the role path still matched
    withStaticLabel('Add invoice');
    const tree = observed('invoice_list', (raw) => {
      const n = node(raw, byId('invoice.add.button'));
      n.a11y_id = 'invoice.add2.button';
      n.label = 'Add invoice';
    });
    const input = healInput({ tree });
    const proposal = proposeHeal(input);
    assert.equal(proposal.reason, 'accepted');
    assert.equal(proposal.candidate!.a11y_id, 'invoice.add2.button');
    assert.equal(proposal.candidate!.proposed_locator.strategy, 'a11y_id');
    const result = applyHeal(ctx, { input, candidate: proposal.candidate!, runner_up: proposal.runner_up! });
    const updated = result.updated_element!;
    assert.deepEqual(updated.locators[0], { strategy: 'a11y_id', value: 'invoice.add2.button', weight: 1 });
    // the stale id is gone: one a11y_id locator, and it is the new one
    assert.deepEqual(updated.locators.filter((l) => l.strategy === 'a11y_id').map((l) => l.value), ['invoice.add2.button']);
    assert.equal(result.record.new_strategy, 'a11y_id');
    assert.equal(result.record.runner_up_score, proposal.runner_up!.score);
  });

  it('applyHeal from a persisted PendingHeal produces the same element (guided crosses tool calls)', () => {
    const input = healInput({ tree: idRemoved() });
    const proposal = proposeHeal(input);
    assert.ok(proposal.candidate !== undefined);
    const pending = toPendingHeal(input, { ...proposal, candidate: proposal.candidate }, 7);
    // serializable: no TreeNode reference survives the round trip
    const roundTripped = JSON.parse(JSON.stringify(pending)) as PendingHeal;
    assert.deepEqual(roundTripped, pending);
    assert.equal(roundTripped.scored_on_seq, 7);
    assert.equal(roundTripped.step, 's1');
    assert.equal(roundTripped.old_strategy, 'a11y_id');

    const live = applyHeal(ctx, { input, candidate: proposal.candidate }, { run_id: 'run_a' });
    const fromPending = healedElement({ element: element('invoice_list', 'invoice.add.button'), intent_critical: false }, roundTripped.candidate);
    assert.deepEqual(fromPending, live.updated_element);
  });

  it('applyHeal({pending}) reads the element from the cache and logs the same event', () => {
    const input = healInput({ tree: idRemoved() });
    const proposal = proposeHeal(input);
    const pending = toPendingHeal(input, { ...proposal, candidate: proposal.candidate! }, 3);
    const result = applyHeal(ctx, { pending, recipe: 'create_invoice' }, { run_id: 'run_b' });
    assert.equal(result.accepted, true);
    assert.equal(result.updated_element?.status, 'healed_pending_review');
    assert.equal(result.record.new_strategy, 'role_label');
    assert.equal(healEvents().length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// 04 §7.2 rejections
// ---------------------------------------------------------------------------------------------

describe('04 §9: intent_critical invoice.save.button with a changed label and no id is rejected', () => {
  function labelChanged(): ScrubbedTree {
    // the rename shipped with a new build, so its string table carries the new copy
    withStaticLabel('Done');
    return observed('invoice_new', (raw) => {
      const n = node(raw, byId('invoice.save.button'));
      delete n.a11y_id;
      n.label = 'Done';
    });
  }
  function saveInput(): HealInput {
    const def = element('invoice_new', 'invoice.save.button');
    return healInput({
      tree: labelChanged(), element: def, screen: 'invoice_new', intent_critical: true,
      step: step({ id: 's5', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true }),
    });
  }

  it('reports intent_critical_label_changed with the top-3 candidates (invariant 6)', () => {
    const proposal = proposeHeal(saveInput());
    assert.equal(proposal.reason, 'intent_critical_label_changed');
    assert.equal(proposal.candidate, undefined);
    assert.equal(proposal.candidates.length, 3);
    // the top candidate would otherwise have passed the score gate — the label alone rejects it
    assert.ok(proposal.candidates[0]!.score >= HEAL_ACCEPT_SCORE);
  });

  it('rejectHeal logs the rejected heal event and bumps misses; nothing is written', () => {
    const input = saveInput();
    const proposal = proposeHeal(input);
    const result = rejectHeal(ctx, { input }, 'intent_critical_label_changed', proposal.candidates, { run_id: 'run_c' });
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'intent_critical_label_changed');
    assert.equal(result.updated_element, undefined);
    assert.equal(result.candidates.length, 3);
    assert.equal(result.record.intent_critical, true);
    const stored = ctx.db.getScreen('invoice_new')?.elements.find((e) => e.id === 'invoice.save.button');
    assert.equal(stored?.status, 'verified');
    assert.equal(ctx.db.getCounters('element', 'invoice.save.button').misses, 1);
    const ev = healEvents()[0]!;
    assert.equal(ev.kind === 'heal' && ev.accepted, false);
    assert.equal(ev.kind === 'heal' && ev.reason, 'intent_critical_label_changed');
    assert.equal(ev.kind === 'heal' && ev.intent_critical, true);
    assert.equal(ev.kind === 'heal' && ev.new_strategy, undefined);
  });

  it('an identical label_norm on an intent_critical element still heals (only the label is the guard)', () => {
    const tree = observed('invoice_new', (raw) => {
      const n = node(raw, byId('invoice.save.button'));
      delete n.a11y_id;
      n.label = 'Save';
    });
    const def = element('invoice_new', 'invoice.save.button');
    const proposal = proposeHeal(healInput({
      tree, element: def, screen: 'invoice_new', intent_critical: true,
      step: step({ id: 's5', element: 'invoice.save.button', expect: { screen: 'invoice_detail' }, intent_critical: true }),
    }));
    assert.equal(proposal.reason, 'accepted');
    assert.equal(proposal.candidate?.proposed_locator.strategy, 'role_label');
  });

  it('04 §7.3: never a text or geometry strategy alone on an intent_critical element', () => {
    // a node with neither id nor a surviving label can only be proposed as `path`
    const def = element('invoice_new', 'invoice.save.button');
    const tree = observed('invoice_new', (raw) => {
      const n = node(raw, byId('invoice.save.button'));
      delete n.a11y_id;
      delete n.label;
    });
    for (const c of scoreCandidates(healInput({ tree, element: def, screen: 'invoice_new', intent_critical: true }))) {
      assert.ok(c.proposed_locator.strategy !== 'text' && c.proposed_locator.strategy !== 'geometry', `${c.path} proposed ${c.proposed_locator.strategy}`);
    }
    // the same node on a NON intent_critical element may fall back to geometry
    const plain = scoreCandidates(healInput({ tree, element: { ...def, intent_critical: false }, screen: 'invoice_new', intent_critical: false }));
    assert.ok(plain.some((c) => c.proposed_locator.strategy === 'geometry' || c.proposed_locator.strategy === 'path'));
  });
});

describe('04 §7.2 rule 1: the runner-up must be ≥ 0.10 lower', () => {
  /** a second button with the same label next to the healed one */
  function twinTree(offsetY: number): ScrubbedTree {
    return observed('invoice_list', (raw) => {
      const original = node(raw, byId('invoice.add.button'));
      delete original.a11y_id;
      const twin = structuredClone(original);
      twin.bbox_norm = { ...original.bbox_norm!, y: original.bbox_norm!.y + offsetY };
      node(raw, (n) => n.role === 'navigationBar').children.push(twin);
    });
  }

  it('a near-identical twin makes the heal ambiguous', () => {
    const proposal = proposeHeal(healInput({ tree: twinTree(0.02) }));
    assert.equal(proposal.reason, 'ambiguous');
    assert.equal(proposal.candidate, undefined);
    assert.ok(proposal.runner_up !== undefined);
    assert.ok(proposal.candidates[0]!.score - proposal.candidates[1]!.score < HEAL_RUNNER_UP_MARGIN);
  });

  it('the same twin far away clears the margin and the heal is accepted (boundary)', () => {
    const proposal = proposeHeal(healInput({ tree: twinTree(0.4) }));
    assert.equal(proposal.reason, 'accepted');
    assert.ok(proposal.candidates[0]!.score - proposal.candidates[1]!.score >= HEAL_RUNNER_UP_MARGIN);
  });

  it('rejectHeal(ambiguous) carries at most 3 candidates for the fallback payload', () => {
    const input = healInput({ tree: twinTree(0.02) });
    const proposal = proposeHeal(input);
    const result = rejectHeal(ctx, { input }, 'ambiguous', proposal.candidates, {
      runner_up_score: proposal.runner_up!.score,
    });
    assert.equal(result.reason, 'ambiguous');
    assert.equal(result.candidates.length, 3);
    assert.equal(result.record.runner_up_score, proposal.runner_up!.score);
    assert.equal(healEvents()[0]!.kind === 'heal' && healEvents()[0]!.reason, 'ambiguous');
  });
});

describe('04 §7.2 rule 1: score ≥ 0.75', () => {
  it('a tree where nothing resembles the element is low_score', () => {
    // the add button is gone; only the unrelated nav/tab buttons remain
    const tree = observed('invoice_list', (raw) => {
      const nav = node(raw, (n) => n.role === 'navigationBar');
      nav.children = nav.children.filter((c) => c.a11y_id !== 'invoice.add.button');
    });
    const proposal = proposeHeal(healInput({ tree }));
    assert.equal(proposal.reason, 'low_score');
    assert.ok(proposal.candidates[0]!.score < HEAL_ACCEPT_SCORE);
  });

  it('no compatible role at all is no_candidates', () => {
    const tree = observed('invoice_list');
    const def = element('invoice_list', 'invoice.list.table');
    // a `picker` element has no compatible role group, and the invoice list tree has no picker
    const proposal = proposeHeal(healInput({ tree, element: { ...def, role: 'picker', fingerprint: { role: 'picker' } } }));
    assert.equal(proposal.reason, 'no_candidates');
    assert.deepEqual(proposal.candidates, []);
  });
});

describe('04 §7.3: a step without `expect` can never heal', () => {
  it('proposeHeal reports no_expect even when a perfect candidate exists', () => {
    const input = healInput({ tree: idRemoved(), step: { id: 's2', action: 'tap', element: 'invoice.add.button' } });
    const proposal = proposeHeal(input);
    assert.equal(proposal.reason, 'no_expect');
    assert.equal(proposal.candidate, undefined);
  });

  it('heal() rejects without ever calling verify, and writes nothing', async () => {
    let verifyCalls = 0;
    const input = healInput({ tree: idRemoved(), step: { id: 's2', action: 'tap', element: 'invoice.add.button' } });
    const result = await heal(ctx, input, async () => { verifyCalls++; return true; });
    assert.equal(verifyCalls, 0);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'no_expect');
    assert.equal(ctx.db.getScreen('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!.status, 'verified');
    assert.equal(healEvents()[0]!.kind === 'heal' && healEvents()[0]!.reason, 'no_expect');
  });
});

describe('heal() — the headless one-call wrapper (04 §6.1)', () => {
  it('a postcondition that holds applies the heal', async () => {
    const result = await heal(ctx, healInput({ tree: idRemoved() }), async () => true);
    assert.equal(result.accepted, true);
    assert.equal(result.reason, 'accepted');
    assert.equal(result.updated_element?.status, 'healed_pending_review');
  });

  it('a postcondition that fails rejects with postcondition_failed and writes nothing', async () => {
    const result = await heal(ctx, healInput({ tree: idRemoved() }), async () => false);
    assert.equal(result.accepted, false);
    assert.equal(result.reason, 'postcondition_failed');
    assert.equal(ctx.db.getScreen('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!.status, 'verified');
    assert.equal(healEvents()[0]!.kind === 'heal' && healEvents()[0]!.reason, 'postcondition_failed');
  });

  it('a verifier that throws is a failed postcondition, not a crash (03 §11)', async () => {
    const result = await heal(ctx, healInput({ tree: idRemoved() }), async () => { throw new Error('maestro exploded'); });
    assert.equal(result.reason, 'postcondition_failed');
  });
});

describe('scoreCandidates — robustness', () => {
  it('a merely compatible role is a candidate but scores 0 on the role feature', () => {
    // `tab` is both role-compatible with `button` (COMPATIBLE_ROLES) and a STATIC_LABEL_ROLE,
    // so the scrubber keeps the label and only the role feature changes
    const tree = observed('invoice_list', (raw) => {
      const n = node(raw, byId('invoice.add.button'));
      delete n.a11y_id;
      n.role = 'tab';
    });
    const candidates = scoreCandidates(healInput({ tree }));
    const compatible = candidates.find((c) => c.path === 'navigationBar/tab');
    assert.ok(compatible !== undefined, 'a `tab` node is a candidate for a `button` element');
    assert.equal(compatible.role, 'tab');
    assert.equal(compatible.features.role, 0);
    assert.equal(compatible.features.label, 1);
    assert.ok(compatible.features.bbox > 0.99);
    assert.equal(compatible.features.parent_sibling, 1);
    // losing the 0.35 role weight (and part of the role path) puts it under the acceptance score
    assert.ok(compatible.score < HEAL_ACCEPT_SCORE);
    assert.equal(proposeHeal(healInput({ tree })).reason, 'low_score');
  });

  it('missing fingerprint features contribute 0', () => {
    const def = element('invoice_list', 'invoice.add.button');
    delete def.fingerprint;
    def.locators = def.locators.filter((l) => l.strategy !== 'path');
    const top = scoreCandidates(healInput({ tree: idRemoved(), element: def }))[0]!;
    assert.deepEqual(top.features, { role: 1, label: 0, path: 0, bbox: 0, parent_sibling: 0 });
    assert.equal(top.score, 0.35);
  });

  it('malformed input yields no candidates instead of throwing', () => {
    assert.deepEqual(scoreCandidates(undefined as unknown as HealInput), []);
    assert.deepEqual(scoreCandidates({ tree: { root: undefined } } as unknown as HealInput), []);
  });
});
