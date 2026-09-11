/**
 * Token budgeting for LLM-facing output (03 §8: every tool output is capped by
 * `APP_MAP_MAX_CONTEXT_TOKENS`; `summary` ≤600, `get_screen` ≤400, guided steps ≤120).
 *
 * The estimate is deliberately conservative and model-agnostic: the server cannot see the
 * harness tokenizer, so it counts ~1 token per 4 characters of ASCII prose and 1 per 2 for
 * dense punctuation/identifiers, which over-counts slightly on real BPE tokenizers.
 *
 * Layer: leaf.
 */

/** Marker appended when output is truncated; parsers may test for it. */
export const TRUNCATION_MARKER = '…[truncated]';

/**
 * Estimate tokens for `text`. Deterministic; never returns less than 1 for non-empty input.
 * Rule: split into words on whitespace; each word contributes `ceil(len / 4)` plus 1 for every
 * run of non-alphanumeric characters (`.`, `_`, `/`, quotes) which tokenizers tend to split on.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let tokens = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    tokens += Math.ceil(word.length / 4);
    const punct = word.match(/[^A-Za-z0-9À-ɏ]+/g);
    if (punct) tokens += punct.length;
  }
  // newlines are tokens too
  const nl = text.match(/\n/g);
  if (nl) tokens += nl.length;
  return Math.max(1, tokens);
}

/**
 * Cap `text` to at most `max` estimated tokens. Cuts on line boundaries (never mid-line) so the
 * fixed formats of 03 §8 stay parse-stable, and appends `TRUNCATION_MARKER` on its own line
 * when anything was dropped. If even the first line exceeds the budget it is hard-cut by
 * characters. `max <= 0` returns just the marker.
 */
export function capTokens(text: string, max: number): string {
  if (max <= 0) return TRUNCATION_MARKER;
  if (estimateTokens(text) <= max) return text;
  const markerCost = estimateTokens(TRUNCATION_MARKER) + 1;
  const budget = Math.max(0, max - markerCost);
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  if (kept.length === 0) {
    const first = lines[0] ?? '';
    const chars = Math.max(0, budget * 4 - 1);
    return `${first.slice(0, chars)}\n${TRUNCATION_MARKER}`;
  }
  return `${kept.join('\n')}\n${TRUNCATION_MARKER}`;
}

/** True when `text` fits in `max` tokens. */
export function fitsTokens(text: string, max: number): boolean {
  return estimateTokens(text) <= max;
}
