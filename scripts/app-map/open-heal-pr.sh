#!/usr/bin/env bash
# scripts/app-map/open-heal-pr.sh — turn a nightly heal run into a reviewable PR (06 R6, 07 §7).
#
# usage: scripts/app-map/open-heal-pr.sh [heal-report.json] [--base BRANCH] [--dry-run]
# env:   APP_MAP_HEAL_BRANCH (default app-map/heal-<UTC date>) · APP_MAP_BASE_BRANCH (default main)
#        GH_TOKEN for gh · GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL (default github-actions[bot])
#
# Precondition: `app-map export` already wrote the accepted heals to app-map/**/*.yaml.
# Commits those YAML changes to the heal branch and opens (or updates) a PR whose body is built from
# heal-report.json: a table of applied heals (recipe · step · element · old→new locator · score), a
# "needs human" section for rejected heals, and the intent_critical elements touched. Never merges.
# Requires git, node and gh (gh not needed with --dry-run, which prints the body and stops).
#
# Report shape: app-map/schema/heal-report.schema.json — `heals[]` are accepted heals (exported to
# YAML), `needs_human[]` are rejected ones, `runs[]` the per-recipe results; each heal carries recipe,
# step, element, old_strategy/new_strategy, optional old_locator/new_locator {strategy, value, weight},
# score, runner_up_score, accepted, reason, intent_critical, build. Older shapes (a bare heal array, or
# runs[].heals[] with accepted:false) are tolerated.
set -euo pipefail

REPORT=heal-report.json
BASE=${APP_MAP_BASE_BRANCH:-main}
DRY_RUN=0

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "open-heal-pr: $*" >&2; exit "${2:-1}"; }
need() { command -v "$1" >/dev/null 2>&1 || die "'$1' is required" 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --base) [ $# -ge 2 ] || die "--base needs a value" 2; BASE=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) die "unknown option: $1" 2 ;;
    *) REPORT=$1; shift ;;
  esac
done

need git; need node
[ "$DRY_RUN" = 1 ] || need gh
[ -f "$REPORT" ] || { echo "open-heal-pr: $REPORT not found; nothing to do" >&2; exit 0; }

ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if git diff --quiet -- app-map && [ -z "$(git ls-files --others --exclude-standard -- app-map)" ]; then
  echo "open-heal-pr: no app-map changes after export; no PR needed" >&2
  exit 0
fi

BODY_FILE=$(mktemp)
ERR_FILE=$(mktemp)
trap 'rm -f "$BODY_FILE" "$ERR_FILE"' EXIT

# Body + title from the report. Prints the title on stderr's last line so the shell can pick it up.
# stderr goes to its own file rather than into $(...): under `set -e` a failing command substitution
# aborts the script at the assignment, so a diagnostic captured into TITLE was never printed and a
# malformed report killed the nightly job in silence.
set +e
node - "$REPORT" 2>"$ERR_FILE" >"$BODY_FILE" <<'JS'
const fs = require('fs');
const path = process.argv[2];
let report;
try { report = JSON.parse(fs.readFileSync(path, 'utf8')); }
catch (e) { console.error(`open-heal-pr: cannot parse ${path}: ${e.message}`); process.exit(1); }

// Collect heals. Schema shape: heals[] (accepted) + needs_human[] (rejected); runs[].heals[] repeats
// the per-run view and is only used when the top-level lists are absent.
let heals = [];
if (Array.isArray(report)) heals = report;
else {
  if (Array.isArray(report.heals)) heals.push(...report.heals);
  if (Array.isArray(report.needs_human)) heals.push(...report.needs_human.map((h) => ({ ...h, accepted: false })));
  if (heals.length === 0) {
    for (const run of report.runs || report.results || []) {
      for (const h of run.heals || []) heals.push({ recipe: run.recipe, ...h });
    }
  }
}

const esc = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const locator = (h, kind) => {
  const loc = h[`${kind}_locator`];
  if (loc && typeof loc === 'object') {
    const value = typeof loc.value === 'string' ? loc.value : JSON.stringify(loc.value ?? '');
    return `${loc.strategy ?? '?'}=${value}`;
  }
  if (typeof loc === 'string') return loc;
  return h[`${kind}_strategy`] ?? '?';
};
const score = (h) => {
  const main = typeof h.score === 'number' ? h.score.toFixed(2) : esc(h.score ?? '-');
  return typeof h.runner_up_score === 'number' ? `${main} (runner-up ${h.runner_up_score.toFixed(2)})` : main;
};
const accepted = heals.filter((h) => h.accepted !== false);
const rejected = heals.filter((h) => h.accepted === false);
const critical = [...new Set(heals.filter((h) => h.intent_critical === true).map((h) => h.element))].sort();

const build = report.build ? (typeof report.build === 'object' ? JSON.stringify(report.build) : report.build) : 'unknown';
const platform = report.platform ?? 'unknown';
const runs = Array.isArray(report.runs) ? report.runs.length : undefined;
const failedRuns = Array.isArray(report.runs) ? report.runs.filter((r) => r.ok === false).length : 0;

const out = [];
out.push(`## app-map nightly heal`);
out.push('');
out.push(`Platform: \`${esc(platform)}\` · build: \`${esc(build)}\`${runs !== undefined ? ` · recipe runs: ${runs} (${failedRuns} failed)` : ''} · applied heals: ${accepted.length} · needs human: ${rejected.length}`);
out.push('');
out.push('Heals that passed postcondition verification were exported to `app-map/**/*.yaml` (element status `healed_pending_review`, 04 §7.2). Review the diff and this log; **never auto-merge** (06 R6). CODEOWNERS approval required (07 §7).');
out.push('');
out.push('### Applied heals');
out.push('');
if (accepted.length === 0) out.push('_none_');
else {
  out.push('| recipe | step | element | old → new locator | score |');
  out.push('|---|---|---|---|---|');
  for (const h of accepted) {
    out.push(`| ${esc(h.recipe)} | ${esc(h.step)} | \`${esc(h.element)}\` | \`${esc(locator(h, 'old'))}\` → \`${esc(locator(h, 'new'))}\` | ${score(h)} |`);
  }
}
out.push('');
out.push('### Needs human');
out.push('');
if (rejected.length === 0) out.push('_none_');
else {
  out.push('Rejected heals were **not** applied (04 §7.2 — `low_score`, `ambiguous`, `intent_critical_label_changed`, `no_expect`, `postcondition_failed`, `no_candidates`). The recipe stays as it was; fix the app or the map by hand.');
  out.push('');
  out.push('| recipe | step | element | candidate | score | reason |');
  out.push('|---|---|---|---|---|---|');
  for (const h of rejected) {
    out.push(`| ${esc(h.recipe)} | ${esc(h.step)} | \`${esc(h.element)}\` | \`${esc(locator(h, 'new'))}\` | ${score(h)} | ${esc(h.reason ?? '-')} |`);
  }
}
out.push('');
out.push('### intent_critical elements touched');
out.push('');
if (critical.length === 0) out.push('_none_');
else {
  out.push('These elements perform consequential actions (01 R1). 07 §7: a human must confirm each before anyone re-runs the recipe.');
  out.push('');
  for (const id of critical) out.push(`- \`${esc(id)}\``);
}
out.push('');
out.push(`<sub>Generated by scripts/app-map/open-heal-pr.sh from \`${esc(path)}\`.</sub>`);
process.stdout.write(out.join('\n') + '\n');
console.error(`app-map: nightly heal ${new Date().toISOString().slice(0, 10)} (${accepted.length} applied, ${rejected.length} need review)`);
JS
node_rc=$?
set -e
if [ "$node_rc" -ne 0 ]; then
  cat "$ERR_FILE" >&2
  die "could not build the PR body from $REPORT"
fi
TITLE=$(tail -n 1 "$ERR_FILE")
[ -n "$TITLE" ] || { cat "$ERR_FILE" >&2; die "could not build the PR body from $REPORT"; }

DATE=$(date -u +%Y-%m-%d)
BRANCH=${APP_MAP_HEAL_BRANCH:-app-map/heal-$DATE}

if [ "$DRY_RUN" = 1 ]; then
  echo "open-heal-pr: dry run — branch $BRANCH → $BASE" >&2
  echo "title: $TITLE" >&2
  git status --short -- app-map >&2
  cat "$BODY_FILE"
  exit 0
fi

git checkout -B "$BRANCH"
git add -- app-map
git -c user.name="${GIT_AUTHOR_NAME:-github-actions[bot]}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-41898282+github-actions[bot]@users.noreply.github.com}" \
    commit -q -m "app-map: nightly heal $DATE" \
    -m "Generated by scripts/app-map/open-heal-pr.sh from $REPORT (06 R6). Human review required; never auto-merged."
git push --force-with-lease origin "$BRANCH"

existing=$(gh pr list --head "$BRANCH" --base "$BASE" --state open --json number --jq '.[0].number // empty')
if [ -n "$existing" ]; then
  gh pr edit "$existing" --title "$TITLE" --body-file "$BODY_FILE" >/dev/null
  gh pr view "$existing" --json url --jq .url
else
  gh pr create --base "$BASE" --head "$BRANCH" --title "$TITLE" --body-file "$BODY_FILE"
fi
