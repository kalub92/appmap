/**
 * [C2] Gate controls and the one property they must never lose (01 R7, 02 §6, issue #24).
 *
 * A destructive confirmation used to be unautomatable: `gates[]` declared exactly one control,
 * `dismiss`, and `elements[]` reserves the `gate.` prefix, so the Delete button was neither — and
 * `dismiss_gate` resolves to Cancel, the opposite of the intent.
 *
 * The property the fix must guarantee, and what these tests exist for: **healing can never turn a
 * Cancel into a Delete, or a Delete into a Cancel.** That is not a thing to leave to arithmetic —
 * two buttons in one alert agree on role, role path and parent role and sit close together, so the
 * 04 §7.1 score alone lands within noise of the 0.75 acceptance line. It is enforced structurally,
 * and on BOTH replay rungs, because a safety property only one rung applies is not one.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { AppMapContext } from '../context.ts';
import { openContext } from '../context.ts';
import type { ElementDef, ScreenFile, Tree, TreeNode } from '../types.ts';
import { idsFile, screenFile } from '../paths.ts';
import { scoreCandidates } from '../heal.ts';
import { gateDialogRoot, gateHealScope, resolve as resolveElement } from '../resolve.ts';
import { identify } from '../identify.ts';
import { validateMap } from '../validate.ts';
import { canonicalYaml } from '../yaml/canonical.ts';
import { makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

const GATE = 'gate.push_permission';
const DISMISS = 'gate.push_permission.deny';
const CONFIRM = 'gate.push_permission.allow';

let t: TempAppMapDir;
let ctx: AppMapContext;

/** register a second control on the pilot's push_permission gate and declare it on the gate file */
function withConfirmControl(): void {
  ctx.close();
  const ids = idsFile(t.config);
  const yaml = readIds();
  writeFileSync(ids, yaml.replace(
    `  - id: ${GATE}\n    dismiss: ${DISMISS}\n`,
    `  - id: ${GATE}\n    dismiss: ${DISMISS}\n    controls:\n      - id: ${CONFIRM}\n        intent_critical: true\n`,
  ), 'utf8');

  const path = screenFile(t.config, GATE, 'ios');
  const gate = readGate(path);
  gate.elements = [...gate.elements, {
    id: CONFIRM,
    role: 'button',
    intent: 'allow_push_permission',
    intent_critical: true,
    locators: [{ strategy: 'role_label', value: { role: 'button', label_regex: '^Allow$' }, weight: 0.8 }],
    fingerprint: { role: 'button', label_norm: 'allow', parent_role: 'alert', sibling_index: 1 },
    status: 'verified',
    last_verified_build: '4412',
  } as ElementDef];
  writeGate(path, gate);
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
}

function readIds(): string {
  return readFileSync(idsFile(t.config), 'utf8');
}
function readGate(path: string): ScreenFile {
  return parse(readFileSync(path, 'utf8')) as ScreenFile;
}
// the repo's own serializer, not `yaml.stringify` — otherwise validate rule 7 fires on the fixture
// this test writes, which is rule 7 working correctly and the test being wrong
function writeGate(path: string, doc: ScreenFile): void {
  writeFileSync(path, canonicalYaml('screen', doc), 'utf8');
}

/** an alert with both buttons, as the OS would present it, over `markerScreen` */
function dialogTree(markerScreen = 'invoice_list'): Tree {
  const btn = (label: string, y: number): TreeNode => ({
    role: 'button', label, enabled: true, bbox_norm: { x: 0.1, y, w: 0.35, h: 0.06 }, children: [],
  });
  return {
    schema_version: 1, platform: 'ios', source: 'argent', viewport: { w: 390, h: 844 },
    root: {
      role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 },
      children: [{
        role: 'container', a11y_id: `screen.${markerScreen}`, bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [],
      }, {
        role: 'alert', bbox_norm: { x: 0.05, y: 0.4, w: 0.9, h: 0.25 },
        children: [
          { role: 'staticText', label: 'Enable notifications?', bbox_norm: { x: 0.1, y: 0.42, w: 0.7, h: 0.05 }, children: [] },
          btn('Allow', 0.52),
          btn("Don't Allow", 0.58),
        ],
      }],
    },
  } as Tree;
}

beforeEach(() => {
  t = makeTempAppMapDir();
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
afterEach(() => { ctx.close(); t.cleanup(); });

describe('a gate can declare more than one control (01 R7, issue #24)', () => {
  it('registers every control, with the criticality the author declared', () => {
    withConfirmControl();
    assert.equal(ctx.map.elementRegistry.get(CONFIRM)?.intent_critical, true, 'the confirm control commits, and says so');
    assert.equal(ctx.map.elementRegistry.get(DISMISS)?.intent_critical, false, 'the safe escape keeps the default');
  });

  it('the map still validates with the control declared', () => {
    withConfirmControl();
    assert.deepEqual(validateMap(t.config, { platforms: ['ios'] }).issues.filter((i) => i.severity === 'error'), []);
  });

  it('a control resolves while its dialog is up, which a plain element could never do', () => {
    withConfirmControl();
    const hit = resolveElement(ctx.map, ctx.map.gates.get(GATE)!.elements.find((e) => e.id === CONFIRM)!, dialogTree());
    assert.equal(hit.status, 'hit');
    assert.equal(hit.status === 'hit' && hit.node.label, 'Allow');
  });
});

describe('healing can never cross from one gate control to another (04 §7.3, issue #24)', () => {
  it('the dialog is the whole search space — a heal never looks outside the alert', () => {
    withConfirmControl();
    const tree = dialogTree();
    const root = gateDialogRoot(ctx.map, tree, GATE);
    assert.ok(root !== undefined && root.role === 'alert', 'the gate dialog is located');
  });

  it('the SIBLING control can never be proposed, whatever it scores', () => {
    withConfirmControl();
    const tree = dialogTree();
    const confirmDef = ctx.map.gates.get(GATE)!.elements.find((e) => e.id === CONFIRM)!;
    const bounds = gateHealScope(ctx.map, confirmDef, tree, GATE);
    assert.ok(bounds !== undefined && bounds.candidateRoot !== undefined, 'a locatable dialog yields bounds');

    // the Cancel node is the one thing a heal of the confirm control must never land on
    const cancelNode = resolveElement(ctx.map, ctx.map.gates.get(GATE)!.elements.find((e) => e.id === DISMISS)!, tree);
    assert.equal(cancelNode.status, 'hit');
    assert.ok(bounds.forbiddenNodes?.has(cancelNode.status === 'hit' ? cancelNode.node : ({} as TreeNode)));

    const candidates = scoreCandidates({
      recipe: 'r', step: { id: 's1', action: 'tap_gate', gate: GATE, control: CONFIRM, expect: { screen: 'invoice_list' } },
      screen: GATE, element: confirmDef, intent_critical: true, tree,
      trigger: { status: 'miss', element: CONFIRM, tried: [], candidates: [] }, build: '4412', ...bounds,
    });
    assert.ok(!candidates.some((c) => c.label === "Don't Allow"), `the safe escape was proposed as a replacement for the committing control: ${JSON.stringify(candidates)}`);
  });

  it('and the reverse: a heal of the DISMISS control can never land on the committing one', () => {
    withConfirmControl();
    const tree = dialogTree();
    const dismissDef = ctx.map.gates.get(GATE)!.elements.find((e) => e.id === DISMISS)!;
    const bounds = gateHealScope(ctx.map, dismissDef, tree, GATE)!;
    const candidates = scoreCandidates({
      recipe: 'r', step: { id: 's1', action: 'dismiss_gate', gate: GATE }, screen: GATE,
      element: dismissDef, intent_critical: false, tree,
      trigger: { status: 'miss', element: DISMISS, tried: [], candidates: [] }, build: '4412', ...bounds,
    });
    assert.ok(!candidates.some((c) => c.label === 'Allow'), 'guided synthesizes this dismissal unattended — it must never press Allow');
  });

  it('REFUSES the heal outright when the dialog cannot be located', () => {
    withConfirmControl();
    // the redesign case: the alert is gone from the capture, which is exactly when a heal is tried
    const bare = { ...dialogTree(), root: { ...dialogTree().root, children: [dialogTree().root.children[0]!] } } as Tree;
    const confirmDef = ctx.map.gates.get(GATE)!.elements.find((e) => e.id === CONFIRM)!;
    assert.equal(gateHealScope(ctx.map, confirmDef, bare, GATE), undefined,
      'an unbounded walk here could propose the button next to the one we lost');
  });

  it('REFUSES when a registered sibling control is missing from the gate file', () => {
    // half-integrated map: ids.yaml registers the confirm control, the gate file does not declare
    // it. Skipping the sibling would leave its node in the candidate set — the exact node a heal
    // of the dismiss must never land on.
    ctx.close();
    writeFileSync(idsFile(t.config), readIds().replace(
      `  - id: ${GATE}\n    dismiss: ${DISMISS}\n`,
      `  - id: ${GATE}\n    dismiss: ${DISMISS}\n    controls:\n      - id: ${CONFIRM}\n        intent_critical: true\n`,
    ), 'utf8');
    ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
    const dismissDef = ctx.map.gates.get(GATE)!.elements.find((e) => e.id === DISMISS)!;
    assert.equal(gateHealScope(ctx.map, dismissDef, dialogTree(), GATE), undefined);
  });

  it('REFUSES a `gate.`-prefixed element whose owning gate cannot be found', () => {
    // returning `{}` here would hand a gate control the unbounded walk this exists to prevent
    const orphan = { id: 'gate.unknown_thing.confirm', role: 'button', locators: [], status: 'candidate' } as unknown as ElementDef;
    assert.equal(gateHealScope(ctx.map, orphan, dialogTree()), undefined);
  });

  it('an ordinary screen element is unaffected — it heals exactly as before', () => {
    const def = ctx.map.screens.get('invoice_list')!.elements.find((e) => e.id === 'invoice.add.button')!;
    assert.deepEqual(gateHealScope(ctx.map, def, dialogTree()), {}, 'no gate, no bounds');
  });
});

describe('the covered-screen rule never masks a real navigation (03 §5.1b, issue #24)', () => {
  it('answers the REMEMBERED screen when a modal occluded its marker', () => {
    // the reported failure: a dialog over the current screen hides its `screen.<id>`, so the
    // deepest surviving marker is an ancestor and rule 2 answers THAT at confidence 1.0.
    // `invoice_new` is the ancestor here and declares no gate, so nothing contradicts the memory.
    const tree = dialogTree('invoice_new');
    const covered = identify(ctx.map, tree, { covered_screen: 'client_picker' });
    assert.equal(covered.screen_id, 'client_picker');
    assert.equal(covered.confidence, 0.75, 'above unknown, below any live evidence, below a marker');
    assert.equal(covered.candidates?.[0]?.screen_id, 'invoice_new', 'the marker-named ancestor stays visible');
  });

  it('but stands down when the marker-named screen is the one that RAISED the gate', () => {
    // `invoice_list` declares gate.push_permission on entry (02 §4.2). A capture showing
    // `screen.invoice_list` with that gate up is a screen that NAVIGATED and raised its own gate —
    // the marker is the better witness. Without this the rule masks every navigation to a
    // gate-raising screen, reporting the screen we came from for as long as the gate is up.
    assert.ok((ctx.map.screens.get('invoice_list')?.gates ?? []).includes(GATE), 'precondition: the screen declares the gate');
    assert.equal(identify(ctx.map, dialogTree('invoice_list'), { covered_screen: 'client_picker' }).screen_id, 'invoice_list');
  });

  it('and stands down when the remembered screen\u2019s own marker is still in the tree', () => {
    // nothing is occluded: rule 2 has the evidence and must win
    const r = identify(ctx.map, dialogTree('invoice_new'), { covered_screen: 'invoice_new' });
    assert.equal(r.screen_id, 'invoice_new');
    assert.equal(r.confidence, 1);
  });

  it('the learned `gates` list is not the only discriminator: the PREVIOUS capture settles it', () => {
    // `gates` is learned (02 §4.2), so it says nothing about a screen that has not met this gate
    // yet — and occlusion and navigation produce byte-identical trees. 01 R3 leaves a covered
    // screen's marker behind, so the ancestor under a modal was already on screen a moment ago.
    const tree = dialogTree('invoice_new');
    assert.deepEqual(ctx.map.screens.get('invoice_new')?.gates, undefined, 'precondition: invoice_new has not learned any gate');

    // OCCLUSION: `screen.invoice_new` was already there before the dialog appeared
    const occluded = identify(ctx.map, tree, {
      covered_screen: 'client_picker', previous_markers: new Set(['screen.invoice_new', 'screen.client_picker']),
    });
    assert.equal(occluded.screen_id, 'client_picker');
    assert.equal(occluded.confidence, 0.75);

    // NAVIGATION: the marker appears for the first time WITH the gate — the tree is the witness
    const navigated = identify(ctx.map, tree, {
      covered_screen: 'client_picker', previous_markers: new Set(['screen.client_picker']),
    });
    assert.equal(navigated.screen_id, 'invoice_new');
    assert.equal(navigated.confidence, 1, 'a marker that just appeared is evidence, not occlusion');
  });

  it('ignores the memory entirely when no gate is present', () => {
    const base = dialogTree('invoice_new');
    const noGate = { ...base, root: { ...base.root, children: [base.root.children[0]!] } } as Tree;
    assert.equal(identify(ctx.map, noGate, { covered_screen: 'client_picker' }).screen_id, 'invoice_new',
      'otherwise an ordinary push/pop would report the previous screen for ever');
  });
});

describe('a plain tap can no longer reach a gate control (issue #24)', () => {
  it('validate rejects it, naming the action that should have been used', () => {
    withConfirmControl();
    const recipe = structuredClone(ctx.map.recipes.get('create_invoice')!);
    recipe.steps = [{ id: 's1', action: 'tap', element: CONFIRM, intent_critical: true }, ...recipe.steps];
    writeFileSync(join(t.dir, 'ios', 'recipes', 'create_invoice.yaml'), canonicalYaml('recipe', recipe), 'utf8');
    const errors = validateMap(t.config, { platforms: ['ios'] }).issues.filter((i) => i.severity === 'error');
    assert.ok(
      errors.some((e) => /is a control of gate\.push_permission/.test(e.message) && /tap_gate/.test(e.message)),
      `expected the gate-control tap to be rejected: ${JSON.stringify(errors.map((e) => e.message))}`,
    );
  });
});
