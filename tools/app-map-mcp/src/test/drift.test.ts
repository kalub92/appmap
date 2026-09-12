/** [C3] drift.ts — the drift tour (06 R4), its report (drift-report.schema.json) and PR table. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { AnyTree, DriftReport, Tree, TreeNode } from '../types.ts';
import { DEEP_LINK_REGEX } from '../types.ts';
import { openContext } from '../context.ts';
import type { AppMapContext } from '../context.ts';
import { schemaDir } from '../paths.ts';
import { validateAgainstSchema } from '../yaml/schemas.ts';
import { readEvents } from '../events.ts';
import { walk } from '../tree.ts';
import { ciGateScreens, compareScreen, driftTour, formatDriftTable, summarize } from '../drift.ts';
import type { ExecFn, HierarchyProvider } from '../recipes/headless.ts';
import { cloneTree, loadFixtureTree, loadRouterExportFixture, makeTempAppMapDir } from './helpers.ts';
import type { TempAppMapDir } from './helpers.ts';

/** the tour never spawns anything: every device call is injected */
const execNever: ExecFn = async () => {
  throw new Error('exec must not be called by drift.test');
};

let t: TempAppMapDir;
let ctx: AppMapContext;
/** screen id → the hierarchy the fake device returns for it */
let trees: Map<string, Tree>;
let opened: string[];

before(() => {
  t = makeTempAppMapDir();
  // 06 §5: the acceptance criterion is about a `ci_gate` recipe, so promote the pilot recipe.
  const recipe = join(t.dir, 'ios', 'recipes', 'create_invoice.yaml');
  writeFileSync(recipe, readFileSync(recipe, 'utf8').replace('status: verified', 'status: ci_gate'));
  ctx = openContext(t.config, { logSink: 'none', skipRetention: true });
});
after(() => {
  ctx.close();
  t.cleanup();
});

beforeEach(() => {
  trees = new Map<string, Tree>([
    ['login', loadFixtureTree('login')],
    ['invoice_list', loadFixtureTree('invoice_list')],
    ['invoice_new', loadFixtureTree('invoice_new')],
    ['invoice_detail', loadFixtureTree('invoice_detail')],
  ]);
  opened = [];
});

/** fake device: `open` records the deep link, `hierarchy` replays the tree for that screen */
function device(): { open: NonNullable<Parameters<typeof driftTour>[1]['open']>; hierarchy: HierarchyProvider } {
  let current: string | undefined;
  return {
    open: async (deepLink) => {
      opened.push(deepLink);
      current = DEEP_LINK_REGEX.exec(deepLink)?.[1];
    },
    hierarchy: async (): Promise<AnyTree | null> => (current ? trees.get(current) ?? null : null),
  };
}

function rowFor(report: DriftReport, screen: string) {
  const row = report.screens.find((s) => s.screen === screen);
  assert.ok(row, `no row for ${screen}`);
  return row;
}

/** drop the `a11y_id` of the first node carrying `id` (simulates the id being removed from the app) */
function dropId(tree: Tree, id: string): Tree {
  const copy = cloneTree(tree);
  walk(copy, (n: TreeNode) => {
    if (n.a11y_id === id) delete n.a11y_id;
  });
  return copy;
}

describe('driftTour — happy path (06 R4.2–R4.3)', () => {
  it('reports every deep-linked pilot screen as ok and skips the one without a deep link', async () => {
    const d = device();
    const report = await driftTour(ctx, { ...d, exec: execNever, timeoutMs: 0, build: '4413' });
    assert.equal(report.build, '4413');
    assert.equal(report.platform, 'ios');
    for (const id of ['login', 'invoice_list', 'invoice_new', 'invoice_detail']) {
      const row = rowFor(report, id);
      assert.equal(row.status, 'ok', `${id}: ${JSON.stringify(row)}`);
      assert.equal(row.marker_present, true);
      assert.equal(row.required_present, 1);
      assert.equal(row.hash_changed, false);
      assert.deepEqual(row.unresolvable_elements, []);
    }
    // decision 9: client_picker has `deep_link: none`
    const cp = rowFor(report, 'client_picker');
    assert.equal(cp.status, 'skipped');
    assert.equal(cp.reason, 'no_deep_link');
    assert.deepEqual(opened, ['appmap://invoice_detail?fixture=one_draft_invoice', 'appmap://invoice_list', 'appmap://invoice_new', 'appmap://login']);
    assert.deepEqual(report.summary, { ok: 4, degraded: 0, broken: 0, skipped: 1, blocking: false });
  });

  it('validates against drift-report.schema.json (07 §2.4: ids and scores only)', async () => {
    const d = device();
    const report = await driftTour(ctx, { ...d, exec: execNever, timeoutMs: 0, build: '4413' });
    assert.deepEqual(validateAgainstSchema(schemaDir(t.config), 'drift-report', report), []);
    assert.ok(!JSON.stringify(report).includes('New Invoice'), 'no UI copy leaks into the artifact');
  });

  it('emits one `drift` event per screen (08 §2)', async () => {
    const d = device();
    const before = readEvents(t.config, {}).events.length;
    await driftTour(ctx, { ...d, exec: execNever, timeoutMs: 0, build: '4413' });
    const drift = readEvents(t.config, {}).events.slice(before).filter((e) => e.kind === 'drift');
    assert.equal(drift.length, 5);
    const listEvent = drift.find((e) => e.kind === 'drift' && e.screen === 'invoice_list');
    assert.ok(listEvent && listEvent.kind === 'drift');
    assert.equal(listEvent.build, '4413');
    assert.equal(listEvent.hash_changed, false);
    assert.equal(listEvent.ci_gate_referenced, true);
  });

  it('writes the report to --out when asked', async () => {
    const d = device();
    const outPath = join(t.dir, '.local', 'out', 'drift-report.json');
    const report = await driftTour(ctx, { ...d, exec: execNever, timeoutMs: 0, build: '4413', outPath });
    assert.ok(existsSync(outPath));
    assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')) as DriftReport, report);
  });
});

describe('driftTour — degraded and broken (06 R4.3–R4.5, 08 §5)', () => {
  it('degraded when the structural hash changed but the ids are intact (08 §5 row 5)', async () => {
    const changed = cloneTree(trees.get('invoice_list') as Tree);
    // same ids, different roles → a different structural hash (02 §4.4) but nothing missing
    walk(changed, (n: TreeNode) => {
      if (n.a11y_id === 'nav.settings.tab') n.role = 'button';
    });
    trees.set('invoice_list', changed);
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const row = rowFor(report, 'invoice_list');
    assert.equal(row.status, 'degraded');
    assert.equal(row.hash_changed, true);
    assert.deepEqual(row.missing_ids, []);
    assert.equal(row.required_present, 1);
    assert.equal(report.summary.blocking, false, 'degraded never blocks (06 §4)');
  });

  it('degraded when an element only resolves through a weaker strategy (06 R4.3)', async () => {
    // drop a non-required id: `invoice.filter.button` still resolves by role_label
    trees.set('invoice_list', dropId(trees.get('invoice_list') as Tree, 'invoice.filter.button'));
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const row = rowFor(report, 'invoice_list');
    assert.equal(row.status, 'degraded');
    assert.deepEqual(row.missing_ids, []);
    assert.deepEqual(row.unresolvable_elements, ['invoice.filter.button']);
  });

  it('broken + blocking when a ci_gate-referenced screen loses a required id (06 §5)', async () => {
    trees.set('invoice_list', dropId(trees.get('invoice_list') as Tree, 'invoice.add.button'));
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const row = rowFor(report, 'invoice_list');
    assert.equal(row.status, 'broken');
    assert.deepEqual(row.missing_ids, ['invoice.add.button']);
    assert.equal(row.required_present, 0.5);
    assert.equal(row.ci_gate_referenced, true);
    assert.equal(report.summary.blocking, true);
    assert.match(formatDriftTable(report), /invoice_list: broken — missing invoice\.add\.button/);
  });

  it('broken but not blocking when the screen no ci_gate recipe references loses an id', async () => {
    trees.set('login', dropId(trees.get('login') as Tree, 'login.submit.button'));
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const row = rowFor(report, 'login');
    assert.equal(row.status, 'broken');
    assert.equal(row.ci_gate_referenced, false);
    assert.equal(report.summary.blocking, false);
  });

  it('rounds required_present to 4 decimals (cf. fixtures/ci/drift-report.json 0.6667)', async () => {
    trees.set('invoice_new', dropId(trees.get('invoice_new') as Tree, 'invoice.save.button'));
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const row = rowFor(report, 'invoice_new');
    assert.equal(row.required_present, 0.6667);
    assert.deepEqual(row.missing_ids, ['invoice.save.button']);
    assert.equal(row.status, 'broken');
  });

  it('a label-only change stays ok (06 §5: id unchanged → R4 passes)', async () => {
    const relabelled = cloneTree(trees.get('invoice_list') as Tree);
    walk(relabelled, (n: TreeNode) => {
      if (n.a11y_id === 'invoice.add.button') n.label = 'Create Invoice';
    });
    trees.set('invoice_list', relabelled);
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    assert.equal(rowFor(report, 'invoice_list').status, 'ok');
  });

  it('marker_timeout when the marker never appears, open_failed when the deep link cannot be opened', async () => {
    trees.set('invoice_new', dropId(trees.get('invoice_new') as Tree, 'screen.invoice_new'));
    const d = device();
    const failingOpen: NonNullable<Parameters<typeof driftTour>[1]['open']> = async (link, o) => {
      if (link.startsWith('appmap://login')) throw new Error('simctl: device not booted');
      await d.open(link, o);
    };
    const report = await driftTour(ctx, { open: failingOpen, hierarchy: d.hierarchy, exec: execNever, timeoutMs: 0, build: '4413' });
    const newRow = rowFor(report, 'invoice_new');
    assert.equal(newRow.marker_present, false);
    assert.equal(newRow.status, 'broken');
    assert.equal(newRow.reason, 'marker_timeout');
    const login = rowFor(report, 'login');
    assert.equal(login.status, 'broken');
    assert.equal(login.reason, 'open_failed');
  });

  it('broken with marker_timeout when the hierarchy dump is unavailable', async () => {
    const report = await driftTour(ctx, {
      open: async () => undefined,
      hierarchy: async () => null,
      exec: execNever,
      timeoutMs: 0,
      build: '4413',
    });
    assert.equal(rowFor(report, 'invoice_list').reason, 'marker_timeout');
    assert.equal(rowFor(report, 'invoice_list').status, 'broken');
  });
});

describe('driftTour — the tour never writes to the map (06 R4 last paragraph)', () => {
  it('leaves last_verified_build alone so confidence decays until re-verification', async () => {
    const before = ctx.map.screens.get('invoice_list')?.meta.last_verified_build;
    const changed = cloneTree(trees.get('invoice_list') as Tree);
    walk(changed, (n: TreeNode) => {
      if (n.a11y_id === 'nav.settings.tab') n.role = 'button';
    });
    trees.set('invoice_list', changed);
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    assert.equal(rowFor(report, 'invoice_list').hash_changed, true);
    assert.equal(ctx.db.getScreen('invoice_list')?.meta.last_verified_build, before);
    assert.deepEqual(ctx.db.listDirty(), [], 'drift dirties nothing');
  });
});

describe('driftTour — router export (01 R6, decision 37)', () => {
  it('takes the build from the router export when --build is omitted', async () => {
    const router = loadRouterExportFixture();
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, router });
    assert.equal(report.build, '4412');
  });

  it('skips screens the export does not mention with reason not_in_router_export', async () => {
    const router = loadRouterExportFixture();
    router.screens = router.screens.filter((s) => s.id !== 'login');
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, router });
    const row = rowFor(report, 'login');
    assert.equal(row.status, 'skipped');
    assert.equal(row.reason, 'not_in_router_export');
    assert.deepEqual(opened.filter((l) => l.includes('login')), []);
  });
});

describe('ciGateScreens / summarize / formatDriftTable (pure)', () => {
  it('collects entry, fallback path, expect.screen, verify.screen and element screens of ci_gate recipes', () => {
    const screens = ciGateScreens(ctx.map);
    assert.deepEqual([...screens].sort(), ['client_picker', 'invoice_detail', 'invoice_list', 'invoice_new']);
    assert.ok(!screens.has('login'));
  });

  it('summarize counts every status and blocks only on a ci_gate-referenced broken screen', () => {
    assert.deepEqual(
      summarize([
        { screen: 'a', status: 'ok', marker_present: true, required_present: 1, missing_ids: [], hash_changed: false, unresolvable_elements: [], ci_gate_referenced: false },
        { screen: 'b', status: 'degraded', marker_present: true, required_present: 1, missing_ids: [], hash_changed: true, unresolvable_elements: [], ci_gate_referenced: true },
        { screen: 'c', status: 'broken', marker_present: false, required_present: 0, missing_ids: ['x.y.z'], hash_changed: false, unresolvable_elements: [], ci_gate_referenced: false },
        { screen: 'd', status: 'skipped', marker_present: false, required_present: 0, missing_ids: [], hash_changed: false, unresolvable_elements: [], ci_gate_referenced: false },
      ]),
      { ok: 1, degraded: 1, broken: 1, skipped: 1, blocking: false },
    );
  });

  it('formats the PR comment table (06 R4.4)', async () => {
    const report = await driftTour(ctx, { ...device(), exec: execNever, timeoutMs: 0, build: '4413' });
    const table = formatDriftTable(report);
    const lines = table.split('\n');
    assert.equal(lines[2], '| screen | status | missing ids | hash changed |');
    assert.equal(lines[3], '| --- | --- | --- | --- |');
    assert.equal(lines[4], '| client_picker | skipped (no_deep_link) | — | no |');
    assert.equal(lines[5], '| invoice_detail | ok | — | no |');
    assert.match(table, /4 ok · 0 degraded · 0 broken · 1 skipped/);
  });

  it('compareScreen is pure: same map, same tree, same verdict', () => {
    const screen = ctx.map.screens.get('invoice_list');
    assert.ok(screen);
    const tree = loadFixtureTree('invoice_list');
    const a = compareScreen(ctx.map, screen, tree, { ciGateScreens: new Set(['invoice_list']) });
    const b = compareScreen(ctx.map, screen, tree, { ciGateScreens: new Set<string>() });
    assert.equal(a.status, 'ok');
    assert.equal(a.ci_gate_referenced, true);
    assert.equal(b.ci_gate_referenced, false);
    assert.deepEqual({ ...a, ci_gate_referenced: false }, b);
  });
});
