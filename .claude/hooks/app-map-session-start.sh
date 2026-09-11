#!/bin/sh
# .claude/hooks/app-map-session-start.sh — SessionStart hook (05 §3); also wired to PreCompact.
#
# Reads the hook payload on stdin, runs `app-map summary --max-tokens 600`, and prints
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<preamble + summary>"}}
# Never fails the hook: on any error it injects a one-line "app-map is unavailable" note and exits 0.
# No network egress (07 §5.4): it runs only the in-repo CLI and, once, `npm run build`.
#
# Verified against the hooks reference on 2026-09-11 (docs/dev/harness-notes.md): SessionStart also
# fires after compaction (matcher_value "compact"), which is how the summary is re-injected. PreCompact
# has no context-injection channel, so for that event this script exits 0 without output.
set -u

ROOT=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
PKG="$ROOT/tools/app-map-mcp"
CLI="$PKG/bin/app-map"
PLATFORM=${APP_MAP_PLATFORM:-ios}
MAX_TOKENS=${APP_MAP_MAX_CONTEXT_TOKENS:-600}
BUDGET=${APP_MAP_HOOK_BUDGET_SECS:-20}

payload=$(cat 2>/dev/null || true)
# Only the event name is extracted (no user data leaves this script). JSON never contains raw
# newlines inside strings, so flattening is safe.
event=$(printf '%s' "$payload" | tr -d '\n\r' | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p')
case "${event:-SessionStart}" in
  SessionStart) ;;
  *) exit 0 ;;
esac

bounded() { # bounded <secs> <cmd...>: wall-clock limit when `timeout` exists (GNU coreutils)
  secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# Build once if the package was installed but never built. The bin/app-map shim can also run the
# TypeScript source directly, so this is an optimisation, not a requirement.
if [ ! -f "$PKG/dist/cli.js" ] && [ -d "$PKG/node_modules" ]; then
  bounded "$BUDGET" npm run build --prefix "$PKG" >/dev/null 2>&1 || true
fi

status=ok
summary=""
if [ -f "$CLI" ]; then
  summary=$(bounded "$BUDGET" sh "$CLI" summary --max-tokens "$MAX_TOKENS" 2>/dev/null) || status=failed
else
  status=missing
fi

if [ "$status" != ok ] || [ -z "$summary" ]; then
  context="app-map is unavailable in this session (app-map summary: $status). Run: npm ci --prefix tools/app-map-mcp && npm run build --prefix tools/app-map-mcp. Until then drive the simulator without the map and do not call mcp__app-map__* tools."
else
  # Best-effort build number from the summary text; "unknown" if it prints none.
  build=$(printf '%s\n' "$summary" | sed -n 's/.*[Bb]uild[[:space:]:=]*"\{0,1\}\([A-Za-z0-9][A-Za-z0-9._-]*\).*/\1/p' | head -n 1)
  context="app-map is loaded for $PLATFORM build ${build:-unknown}. Before driving the simulator:
1. call mcp__app-map__match_recipe with the task; if it matches, run_recipe (guided) and follow report_step.
2. otherwise call identify_screen, then get_screen, before any tap. Prefer plan_path deep links.
3. do not take screenshots unless the accessibility tree is empty.
4. when a new task succeeds, call compile_recipe and review the draft.
Recipes: see the summary below.

$summary"
fi

if command -v node >/dev/null 2>&1; then
  printf '%s' "$context" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: s } }) + "\n");
});' && exit 0
fi
# Fallback: for SessionStart, plain stdout is also injected as context (hooks reference).
printf '%s\n' "$context"
exit 0
