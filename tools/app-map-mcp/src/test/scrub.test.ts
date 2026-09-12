/** [B1] scrub.ts — 03 §7 contract and the six 07 §2.3 rules on fixtures/trees/pii.normalized.json. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import { AppMapError, ERROR_CODES } from '../errors.ts';
import { PII_PATTERNS, buildScrubPolicy, findForbiddenContent, perceptionBytes, redactString, scrub } from '../scrub.ts';
import { allNodes, compactJson, findByA11yId } from '../tree.ts';
import type { IdsRegistry, ScrubPolicy, ScrubbedTree, Tree, TreeNode } from '../types.ts';
import { REDACTED, assertScrubbed, isScrubbed } from '../types.ts';
import { PILOT_APP_MAP_DIR, cloneTree, loadFixtureTree, loadStaticStringsFixture } from './helpers.ts';

function loadIds(): IdsRegistry {
  return parseYaml(readFileSync(join(PILOT_APP_MAP_DIR, 'ids.yaml'), 'utf8')) as IdsRegistry;
}
const iosPolicy = (): ScrubPolicy => buildScrubPolicy(loadIds(), loadStaticStringsFixture('ios'));

/** the subtree under the first node with `id` */
function subtree(t: ScrubbedTree | Tree, id: string): TreeNode[] {
  return allNodes(findByA11yId(t, id)[0]!);
}

describe('buildScrubPolicy', () => {
  it('splits the registry into static / dynamic ids, markers, gate dismiss ids and label regexes', () => {
    const p = iosPolicy();
    assert.ok(p.staticIds.has('invoice.add.button'));
    assert.ok(p.staticIds.has('login.email.field'));
    assert.ok(p.staticIds.has('gate.push_permission.deny'), 'gate dismiss controls are registered static ids');
    assert.ok(p.dynamicIds.has('invoice.list.table') && p.dynamicIds.has('invoice.list.cell') && p.dynamicIds.has('login.error.text'));
    assert.ok(!p.staticIds.has('invoice.list.table'));
    assert.ok(p.markers.has('screen.invoice_list') && p.markers.has('screen.login'));
    assert.ok(p.staticLabels.has('New Invoice') && p.staticLabels.has('Don’t Allow'));
    assert.equal(p.piiPatterns, PII_PATTERNS);
    assert.equal(p.labelRegexById.size, 0);
  });

  it('compiles label_regex entries, skips invalid ones, and accepts a custom deny list', () => {
    const ids: IdsRegistry = { schema_version: 1, screens: [], gates: [], elements: [
      { id: 'invoice.count.text', kind: 'text', label_regex: '^\\d+ invoices$' },
      { id: 'bad.regex.text', kind: 'text', label_regex: '(' },
    ] };
    const p = buildScrubPolicy(ids, new Set(['x']), { piiPatterns: [/secret/] });
    assert.ok(p.labelRegexById.get('invoice.count.text')!.test('3 invoices'));
    assert.equal(p.labelRegexById.has('bad.regex.text'), false);
    assert.deepEqual(p.piiPatterns, [/secret/]);
    assert.ok(p.dynamicIds.has('bad.regex.text'), 'an invalid regex makes the id dynamic (label dropped)');
    assert.ok(!p.staticIds.has('invoice.count.text'), 'label_regex ids are not static ids (rule a never applies)');
    assert.ok(!p.staticIds.has('bad.regex.text'));
  });
});

describe('scrub on fixtures/trees/pii.normalized.json', () => {
  const raw = loadFixtureTree('pii');
  const before = JSON.stringify(raw);
  const out = scrub(raw, iosPolicy());
  const json = JSON.stringify(out);

  it('leaves the input untouched and mints the runtime brand', () => {
    assert.equal(JSON.stringify(raw), before);
    assert.equal(out.scrubbed, true);
    assert.ok(isScrubbed(out));
    assert.equal(isScrubbed(raw), false);
    assert.equal(typeof out.scrub_hits, 'number');
    assert.throws(() => assertScrubbed(raw, 'test'), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    assertScrubbed(out, 'test');
  });

  it('contains no email, phone, card, amount, IBAN, SSN, client name or field value anywhere', () => {
    for (const needle of [
      'billing@acme.example', '@', '+1 415', '(415)', '555', '0142', '4111', '1111', 'DE89', '3704', '0044', '123-45-6789',
      '$', '€', '£', '1,250', '2,000', '99.99', 'Acme Corp', 'Jane Doe', 'Card on file', 'acme secret query', 'Search invoices',
    ]) {
      assert.ok(!json.includes(needle), `must not contain ${JSON.stringify(needle)}`);
    }
  });

  it('rule 1: no `value` or `text` key survives anywhere', () => {
    for (const n of allNodes(out)) {
      assert.ok(!('value' in n), 'value');
      assert.ok(!('text' in n), 'text');
    }
    assert.ok(!json.includes('"value"') && !json.includes('"text"'));
  });

  it('rule 2: everything under the dynamic list loses its labels, the region node keeps role/id/bbox/flags', () => {
    const list = findByA11yId(out, 'invoice.list.table')[0]!;
    assert.equal(list.role, 'list');
    assert.equal(list.enabled, true);
    assert.deepEqual(list.bbox_norm, findByA11yId(raw, 'invoice.list.table')[0]!.bbox_norm);
    for (const n of subtree(out, 'invoice.list.table')) assert.equal(n.label, undefined, `${n.role} ${n.a11y_id ?? ''}`);
    assert.equal(findByA11yId(out, 'invoice.list.cell').length, 5, 'dynamic cells keep their registered id');
    // a static string inside a dynamic region is still dropped (rule 2 precedes rule 3)
    const listTree = scrub(loadFixtureTree('invoice_list'), iosPolicy());
    for (const n of subtree(listTree, 'invoice.list.table')) assert.equal(n.label, undefined);
  });

  it('rule 3: static labels on button/tab/navigationBar/staticText survive; other labels are dropped', () => {
    const labels = allNodes(out).map((n) => n.label).filter((l): l is string => l !== undefined);
    for (const l of ['Invoices', 'New Invoice', 'Filter', 'All', 'Draft', 'Sent', 'Paid', 'Clients', 'Settings']) assert.ok(labels.includes(l), l);
    assert.ok(!labels.includes('9:41'), 'staticText not in the table is dropped');
    assert.ok(!labels.includes('status bar'));
    assert.equal(out.root.label, undefined, 'application label "Invoices" is static but the role is not in STATIC_LABEL_ROLES');
    const nav = allNodes(out).find((n) => n.role === 'navigationBar')!;
    assert.equal(nav.label, 'Invoices');
    assert.ok(labels.every((l) => l === REDACTED || iosPolicy().staticLabels.has(l)));
  });

  it('rule 5: role, a11y_id, bbox_norm, enabled, focused, selected and children are kept', () => {
    const rawNodes = allNodes(raw);
    const outNodes = allNodes(out);
    assert.equal(outNodes.length, rawNodes.length);
    outNodes.forEach((n, i) => {
      const r = rawNodes[i]!;
      assert.equal(n.role, r.role);
      assert.equal(n.a11y_id, r.a11y_id);
      assert.deepEqual(n.bbox_norm, r.bbox_norm);
      assert.equal(n.enabled, r.enabled);
      assert.equal(n.focused, r.focused);
      assert.equal(n.selected, r.selected);
      assert.equal(n.children.length, r.children.length);
    });
    assert.deepEqual(out.viewport, raw.viewport);
    assert.equal(out.platform, raw.platform);
    assert.equal(out.source, raw.source);
    assert.equal(out.schema_version, 1);
  });

  it('is idempotent and hash-neutral in size', () => {
    const again = scrub(out as unknown as Tree, iosPolicy());
    assert.equal(compactJson(again), compactJson(out));
    assert.equal(perceptionBytes(out), Buffer.byteLength(compactJson(out), 'utf8'));
    assert.ok(perceptionBytes(out) > 0 && perceptionBytes(out) < Buffer.byteLength(before, 'utf8'));
  });
});

describe('scrub rule 4 (PII deny list) and scrub_hits', () => {
  it('redacts an unregistered a11y_id that embeds row data, keeps registered ids, and sets scrub_hits', () => {
    const raw = cloneTree(loadFixtureTree('pii'));
    const cells = findByA11yId(raw, 'invoice.list.cell');
    cells[0]!.a11y_id = 'cell_billing@acme.example';
    cells[1]!.a11y_id = 'cell_4111111111111111';
    cells[2]!.a11y_id = 'row_plain';
    const out = scrub(raw, iosPolicy());
    const ids = allNodes(out).map((n) => n.a11y_id);
    assert.ok(!ids.includes('cell_billing@acme.example') && !ids.includes('cell_4111111111111111'));
    // only the embedded row data is spliced out; whatever the match did not cover survives
    // (the email pattern's local part swallows the `cell_` prefix, the card pattern does not)
    assert.deepEqual(
      ids.filter((i) => typeof i === 'string' && i.includes(REDACTED)).sort(),
      [REDACTED, `cell_${REDACTED}`],
    );
    assert.ok(ids.includes('row_plain'), 'an unregistered id without PII is kept');
    assert.equal(ids.filter((i) => i === 'invoice.list.cell').length, 2);
    assert.ok(ids.includes('screen.invoice_list'));
    assert.equal(out.scrub_hits, 2);
    assert.ok(!JSON.stringify(out).includes('acme.example'));
  });

  it('reports zero hits when nothing needed redacting', () => {
    assert.equal(scrub(loadFixtureTree('invoice_list'), iosPolicy()).scrub_hits, 0);
  });

  it('sweeps labels that survive rule 3 through a label_regex (07 §9) and never a registered id', () => {
    const ids: IdsRegistry = { schema_version: 1, screens: [{ id: 'login' }], gates: [], elements: [
      { id: 'invoice.count.text', kind: 'text', label_regex: '^\\d+ invoices$' },
      { id: 'invoice.anything.text', kind: 'text', label_regex: '.*' },
      { id: 'login.submit.button', kind: 'button' },
    ] };
    const policy = buildScrubPolicy(ids, new Set());
    const mk = (a11y_id: string, label: string): TreeNode => ({ role: 'staticText', a11y_id, label, bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] });
    const raw: Tree = { schema_version: 1, platform: 'ios', source: 'synthetic', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [
      mk('invoice.count.text', '3 invoices'), mk('invoice.count.text', 'billing@acme.example'), mk('invoice.anything.text', 'a@b.co'),
      { ...mk('login.submit.button', 'Custom Label Not In Table'), role: 'button' },
    ] } };
    const out = scrub(raw, policy);
    const [count, mismatch, any, submit] = out.root.children;
    assert.equal(count!.label, '3 invoices', 'computed label matching label_regex survives');
    assert.equal(mismatch!.label, undefined, 'label not matching label_regex is dropped');
    assert.equal(any!.label, REDACTED, 'a surviving label that hits the deny list is redacted');
    assert.equal(any!.a11y_id, 'invoice.anything.text');
    assert.equal(submit!.label, 'Custom Label Not In Table', 'registered dynamic:false id keeps its label without a table entry');
    assert.equal(out.scrub_hits, 1);
  });

  it('keeps the route key but drops a query that hits the deny list', () => {
    const base = loadFixtureTree('invoice_list');
    const clean = scrub({ ...base, route: 'appmap://invoice_detail?fixture=x' }, iosPolicy());
    assert.equal(clean.route, 'appmap://invoice_detail?fixture=x');
    assert.equal(clean.scrub_hits, 0);
    const dirty = scrub({ ...base, route: 'appmap://invoice_detail?email=a@b.co' }, iosPolicy());
    assert.equal(dirty.route, 'appmap://invoice_detail');
    assert.equal(dirty.scrub_hits, 1);
  });
});

describe('scrub on gates and dynamic ids', () => {
  it('keeps the gate button labels (static table) so gate signatures still match, drops the alert copy', () => {
    const out = scrub(loadFixtureTree('invoice_list.with_gate'), iosPolicy());
    const alert = allNodes(out).find((n) => n.role === 'alert')!;
    assert.equal(alert.label, undefined);
    const buttons = alert.children.filter((c) => c.role === 'button').map((c) => c.label);
    assert.deepEqual(buttons, ['Don’t Allow', 'Allow']);
    assert.ok(!JSON.stringify(out).includes('Would Like to Send'), 'the alert title (app name + copy) is not in the table');
    const bio = scrub(loadFixtureTree('login.with_gate'), iosPolicy());
    const bioAlert = allNodes(bio).find((n) => n.role === 'alert')!;
    assert.deepEqual(bioAlert.children.map((c) => c.label), [undefined, 'Face ID', 'Sign in to Invoices', 'Cancel']);
  });

  it('drops the label of a dynamic text element even when it is short', () => {
    const raw = cloneTree(loadFixtureTree('login'));
    findByA11yId(raw, 'login.error.text')[0]!.label = 'Wrong password';
    findByA11yId(raw, 'login.email.field')[0]!.value = 'me@example.com';
    const out = scrub(raw, iosPolicy());
    assert.equal(findByA11yId(out, 'login.error.text')[0]!.label, undefined);
    assert.equal(findByA11yId(out, 'login.email.field')[0]!.label, 'Email');
    assert.ok(!JSON.stringify(out).includes('me@example.com'));
    assert.ok(!JSON.stringify(out).includes('Wrong password'));
  });

  it('uses strings.android.txt for the Android fixtures', () => {
    const policy = buildScrubPolicy(loadIds(), loadStaticStringsFixture('android'));
    const out = scrub(loadFixtureTree('android/login'), policy);
    const labels = allNodes(out).map((n) => n.label).filter((l) => l !== undefined);
    assert.ok(labels.includes('Sign In') && labels.includes('Email'));
    for (const n of allNodes(out)) {
      if (n.label === undefined) continue;
      assert.ok(n.label === REDACTED || policy.staticLabels.has(n.label) || (n.a11y_id !== undefined && policy.staticIds.has(n.a11y_id)), `${n.role} ${n.label}`);
    }
    assert.ok(!labels.includes('Welcome back') || policy.staticLabels.has('Welcome back'));
  });

  it('never promotes a raw `text` to `label` (decision 23) and brands the compact JSON', () => {
    const raw: Tree = { schema_version: 1, platform: 'android', source: 'maestro', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [
      { role: 'staticText', text: 'New Invoice', bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] },
      { role: 'button', a11y_id: 'invoice.add.button', text: 'me@example.com', label: 'New Invoice', bbox_norm: { x: 0, y: 0, w: 0.1, h: 0.1 }, children: [] },
    ] } };
    const out = scrub(raw, iosPolicy());
    assert.equal(out.root.children[0]!.label, undefined);
    assert.equal(out.root.children[1]!.label, 'New Invoice');
    const json = compactJson(out);
    assert.ok(!json.includes('example.com') && !json.includes('"text"') && !json.includes('"value"'));
    assert.ok(json.endsWith('"scrubbed":true,"scrub_hits":0}'));
    assert.deepEqual(JSON.parse(json), out);
  });

  it('rejects a rootless tree or a bogus policy with bad_input instead of crashing', () => {
    assert.throws(() => scrub({} as Tree, iosPolicy()), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
    assert.throws(() => scrub(loadFixtureTree('login'), {} as ScrubPolicy), (e: unknown) => AppMapError.is(e) && e.code === ERROR_CODES.BAD_INPUT);
  });

  it('tolerates malformed nodes (missing children / bbox) without crashing', () => {
    const raw = { schema_version: 1, platform: 'ios', source: 'synthetic', root: { role: 'application', bbox_norm: { x: 0, y: 0, w: 1, h: 1 }, children: [
      { role: 'button', label: 'Save' } as unknown as TreeNode,
    ] } } as Tree;
    const out = scrub(raw, iosPolicy());
    assert.equal(out.root.children[0]!.label, 'Save');
    assert.deepEqual(out.root.children[0]!.bbox_norm, { x: 0, y: 0, w: 0, h: 0 });
    assert.deepEqual(out.root.children[0]!.children, []);
  });
});

describe('ScrubbedTree brand (compile time)', () => {
  it('a raw tree cannot be passed where a scrubbed one is required', () => {
    const raw: Tree = loadFixtureTree('login');
    // @ts-expect-error a raw Tree is not a ScrubbedTree
    const asScrubbed: ScrubbedTree = raw;
    void asScrubbed;
    // @ts-expect-error setting `scrubbed: true` by hand does not mint the brand
    const faked: ScrubbedTree = { ...raw, scrubbed: true as const, scrub_hits: 0 };
    void faked;
    // @ts-expect-error perceptionBytes takes only scrubbed trees
    perceptionBytes(raw);
    const real: ScrubbedTree = scrub(raw, iosPolicy());
    assert.ok(perceptionBytes(real) > 0);
  });
});

describe('redactString / findForbiddenContent (07 §2.3.4)', () => {
  it('hits every pattern of the deny list and leaves UI copy alone', () => {
    const hits: Array<[string, number]> = [
      ['billing@acme.example', 0], ['+1 415 555 0142', 1], ['(415) 555-0142', 1], ['+14155550142', 1],
      ['4111 1111 1111 1111', 2], ['4111111111111111', 2], ['1234567890123', 2],
      ['$1,250.00', 3], ['€2,000.00', 3], ['£ 99.99', 3], ['Total: $5', 3],
      ['DE89 3704 0044 0532 0130 00', 4], ['GB29NWBK60161331926819', 4],
      ['123-45-6789', 5],
    ];
    for (const [s, idx] of hits) {
      const r = redactString(s);
      assert.equal(r.hit, true, s);
      // 07 §2.2: the VALUE never survives — only the matched substring is spliced out, so a
      // string that is nothing but the value still comes back fully redacted.
      assert.equal(r.value.includes(REDACTED), true, s);
      assert.deepEqual(findForbiddenContent(r.value), [], `${s} -> ${r.value} still carries a value`);
      assert.ok(PII_PATTERNS[idx]!.test(s), `pattern ${idx} matches ${s}`);
    }
    // surrounding structure survives (04 §3.4 param inference, 08 §2 task text)
    assert.deepEqual(redactString('Total: $5'), { value: `Total: ${REDACTED}`, hit: true });
    assert.deepEqual(
      redactString('create an invoice for $50 for Acme Corp'),
      { value: `create an invoice for ${REDACTED} for Acme Corp`, hit: true },
    );
    assert.deepEqual(redactString('mail a@b.co and c@d.co'), { value: `mail ${REDACTED} and ${REDACTED}`, hit: true });
    for (const s of ['New Invoice', 'Sign in with Face ID', '9:41', 'Don’t Allow', 'Version 2.0.1', 'Order #12', '3 invoices', 'Invoice 4412', '']) {
      assert.deepEqual(redactString(s), { value: s, hit: false }, s);
    }
    assert.deepEqual(redactString('anything', []), { value: 'anything', hit: false });
    assert.deepEqual(redactString('secret', [/secret/g]), { value: REDACTED, hit: true });
    assert.deepEqual(redactString('secret', [/secret/g]), { value: REDACTED, hit: true }, 'a global pattern stays stateless');
    assert.deepEqual(redactString('a secret b', [/secret/g]), { value: `a ${REDACTED} b`, hit: true });
    assert.ok(PII_PATTERNS.every((p) => !p.global && !p.sticky), 'deny-list patterns carry no g/y flag');
  });

  it('findForbiddenContent lists every match with its pattern index', () => {
    const found = findForbiddenContent('mail a@b.co or call +1 415 555 0142, pay $12');
    assert.deepEqual(found.map((f) => f.pattern), [0, 1, 3]);
    assert.equal(found[0]!.match, 'a@b.co');
    assert.equal(found[1]!.match, '+1 415 555 0142');
    assert.equal(found[2]!.match, '$12', 'the currency pattern spans the whole amount');
    assert.deepEqual(findForbiddenContent(''), []);
    assert.deepEqual(findForbiddenContent('New Invoice'), []);
    assert.equal(findForbiddenContent('a@b.co c@d.io').length, 2);
  });
});
