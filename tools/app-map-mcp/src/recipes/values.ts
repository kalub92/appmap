/**
 * [leaf] Parameter substitution and `expect.value` assertions (02 §6, 04 §3.4, issue #23).
 *
 * A recipe could say *a* thing is on screen, never that it is *the right* thing: `visible` takes
 * ids, `text_present` takes a literal and is documented "static copy only". So a `type` step that
 * no-opped still reported PASS, and `lifecycle.recompile` kept promoting the recipe that never
 * exercised its own parameters. `expect.value` closes that: it names an element and a `{param}`
 * SLOT — never a literal — so the map keeps storing the reference and the value lives only in the
 * run (07 §2, validate rule 8).
 *
 * WHERE AN ASSERTION IS EVALUATED, and why it cannot be where the other four are.
 * `guided.checkExpect` runs against `Observation.snapshot`, which is SCRUBBED: `scrub` drops
 * `value`/`text` from every node unconditionally and drops `label` under any `dynamic: true` id —
 * and a field holding a typed parameter is exactly such an element (the pilot's
 * `invoice.detail.amount.text` is `dynamic: true`). The raw tree never survives that far either:
 * it exists only inside `observe.hookPayloadToObservation`, in the hook path in a DIFFERENT
 * PROCESS from `report_step`, and `db.insertObservation` asserts the snapshot is scrubbed before
 * it can touch disk (07 §8).
 *
 * So the comparison happens ONCE, AT INGEST, in that one window where the raw tree is alive, and
 * what is persisted is a BOOLEAN per declared assertion (`Observation.value_checks`, keyed by
 * `assertionKey`). `checkExpect` reads the bit. The observed string never leaves the ingest stack
 * frame, is never stored, never logged and never reported in a fallback — the failure line names
 * the element and the slot, which is all a reviewer needs and all 07 §2 allows.
 *
 * `compareValue` is deliberately the SAME comparison `compile.parameterize` uses to decide that a
 * literal was a parameter (money/number numerically, everything else trimmed and
 * case-insensitive). If the two disagreed, a recipe could not verify the very run it was compiled
 * from: the trajectory typed `50` and the detail screen renders `$50.00`.
 *
 * Layer: leaf (imports types only). Pure. It is a module of its own rather than more of
 * `guided.ts` because `observe.ts` needs it and `guided.ts` already imports `observe.ts`.
 */
import type { ElementId, Expect, RecipeFile, RecipeParam, RecipeParams, ValueAssertion } from '../types.ts';
import { PARAM_SLOT_REGEX } from '../types.ts';

/** Pure: `{amount}` → params.amount (String()); unknown slots left as-is. */
export function substituteParams(text: string, params: RecipeParams): string {
  if (typeof text !== 'string') return '';
  const values = params ?? {};
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, name: string) => {
    const v = (values as Record<string, unknown>)[name];
    return v === undefined || v === null ? whole : String(v);
  });
}

/** `equals` or `contains` — exactly one is present on a well-formed assertion (recipe.schema.json). */
export type ValueOp = 'equals' | 'contains';

/** The operator an assertion carries, and the `{param}` slot it compares against. */
export function assertionOp(a: ValueAssertion): { op: ValueOp; slot: string } | undefined {
  if (typeof a?.equals === 'string') return { op: 'equals', slot: a.equals };
  if (typeof a?.contains === 'string') return { op: 'contains', slot: a.contains };
  return undefined;
}

/**
 * The key a verdict is stored under on the observation. Stable and derived only from the
 * declaration, so ingest and `checkExpect` agree without sharing any state: `<element>|<op>|<slot>`.
 */
export function assertionKey(element: ElementId, op: ValueOp, slot: string): string {
  return `${element}|${op}|${slot}`;
}

/** The key for an assertion as written, or `undefined` when it carries neither operator. */
export function keyOf(a: ValueAssertion): string | undefined {
  const parsed = assertionOp(a);
  return parsed === undefined ? undefined : assertionKey(a.element, parsed.op, parsed.slot);
}

/** The param a slot names (`{amount}` → `amount`), or `undefined` for anything that is not a bare slot. */
export function paramOfSlot(slot: string): string | undefined {
  return PARAM_SLOT_REGEX.exec(slot ?? '')?.[1];
}

/**
 * The comparison, matching `compile.parameterize` exactly (module doc). `expected` is the
 * SUBSTITUTED value, not the slot.
 */
export function compareValue(observed: string, expected: string, op: ValueOp, type: RecipeParam['type'] | undefined): boolean {
  if (typeof observed !== 'string' || typeof expected !== 'string') return false;
  if (op === 'equals' && (type === 'money' || type === 'number')) {
    const a = numeric(observed);
    const b = numeric(expected);
    if (a !== undefined && b !== undefined) return a === b;
    // neither side parsed as a number: fall through to the textual comparison rather than fail
  }
  const a = observed.trim().toLowerCase();
  const b = expected.trim().toLowerCase();
  return op === 'contains' ? b !== '' && a.includes(b) : a === b;
}

/** `"$50.00"` → 50. Same normalization as `compile.numeric`. */
function numeric(x: string): number | undefined {
  const n = Number(x.replace(/[$€£,\s]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** One assertion to evaluate, flattened out of a recipe. */
export interface PendingValueCheck {
  element: ElementId;
  op: ValueOp;
  /** the `{param}` slot as written in the recipe */
  slot: string;
  key: string;
}

/** Every `expect.value` entry in one `expect` block. */
export function valueChecksOfExpect(expect: Expect | undefined): PendingValueCheck[] {
  const out: PendingValueCheck[] = [];
  for (const a of expect?.value ?? []) {
    const parsed = assertionOp(a);
    if (parsed === undefined || typeof a.element !== 'string' || a.element === '') continue;
    out.push({ element: a.element, op: parsed.op, slot: parsed.slot, key: assertionKey(a.element, parsed.op, parsed.slot) });
  }
  return out;
}

/**
 * Every assertion the recipe declares anywhere — all steps plus `verify`, de-duplicated by key.
 *
 * Ingest evaluates the WHOLE set on every observation of a session with an active run rather than
 * only the pending step's: it costs a resolve per assertion on a tree already in memory, and it
 * removes any coupling between when the hook fires and which step `report_step` is waiting for —
 * including the recipe-level `verify`, which is checked on a separate pass at the end of the run.
 */
export function valueChecksOfRecipe(recipe: RecipeFile): PendingValueCheck[] {
  const byKey = new Map<string, PendingValueCheck>();
  const add = (checks: PendingValueCheck[]): void => { for (const c of checks) byKey.set(c.key, c); };
  for (const step of recipe?.steps ?? []) add(valueChecksOfExpect(step.expect));
  add(valueChecksOfExpect(recipe?.verify));
  return Array.from(byKey.values());
}

/**
 * The params a recipe actually OBSERVES (validate rule 9, issue #23). An `expect.value` slot
 * observes its param outright. A `select {match.text}` slot counts too: the row is addressed BY
 * that text at replay (`toRunStep` hands the driver `{by:'text'}`; the Maestro export emits
 * `scrollUntilVisible`), so the step genuinely fails when nothing matches — the accidental
 * protection the issue identified, made explicit.
 *
 * A `type` step's `{param}` text does NOT count. Typing is not observing; that a typed parameter
 * can go nowhere and still report PASS is the whole of issue #23.
 */
export function observedParams(recipe: RecipeFile): Set<string> {
  const out = new Set<string>();
  const fromSlot = (slot: string | undefined): void => {
    const name = typeof slot === 'string' ? paramOfSlot(slot) : undefined;
    if (name !== undefined) out.add(name);
  };
  for (const check of valueChecksOfRecipe(recipe)) fromSlot(check.slot);
  for (const step of recipe?.steps ?? []) {
    if (step.action === 'select') fromSlot(step.match?.text);
  }
  return out;
}
