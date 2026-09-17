#!/bin/sh
# .claude/hooks/app-map-session-start.sh — SessionStart hook (05 §3); also wired to PreCompact.
#
# Written by `app-map init` for a repo that installs @kalub92/app-map as a devDependency. Reads the
# hook payload on stdin, runs `app-map summary --max-tokens 600 --hook-json`, and prints
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<summary + preamble>"}}
# Never fails the hook: on any error it injects a one-line "app-map is unavailable" note and exits 0.
# No network egress (07 §5.4): it runs only the installed CLI.
#
# SessionStart fires after compaction too (matcher_value "compact"), which is how the summary is
# re-injected. PreCompact has no context-injection channel, so for that event this script exits 0
# without output.
set -u

ROOT=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
MAX_TOKENS=${APP_MAP_MAX_CONTEXT_TOKENS:-600}
BUDGET=${APP_MAP_HOOK_BUDGET_SECS:-20}
# The CLI resolves the map from APP_MAP_DIR, else from its own CWD. A hook does not control its CWD,
# so without this an off-root session silently reports an EMPTY map as loaded.
APP_MAP_DIR=${APP_MAP_DIR:-$ROOT/app-map}
export APP_MAP_DIR

payload=$(cat 2>/dev/null || true)
event=$(printf '%s' "$payload" | tr -d '\n\r' | sed -n 's/.*"hook_event_name"[[:space:]]*:[[:space:]]*"\([A-Za-z]*\)".*/\1/p')
case "${event:-SessionStart}" in
  SessionStart) ;;
  *) exit 0 ;;
esac

bounded() { # bounded <secs> <cmd...>: wall-clock limit when `timeout` exists
  secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

# The devDependency's bin. `npx --no-install` is the fallback for a global or npx-only install and
# never reaches the network; if neither resolves, the note below tells the session what to run.
if [ -x "$ROOT/node_modules/.bin/app-map" ]; then
  set -- "$ROOT/node_modules/.bin/app-map"
elif command -v app-map >/dev/null 2>&1; then
  set -- app-map
elif command -v npx >/dev/null 2>&1; then
  set -- npx --no-install app-map
else
  set --
fi

status=ok
envelope=""
if [ "$#" -gt 0 ]; then
  envelope=$(bounded "$BUDGET" "$@" summary --max-tokens "$MAX_TOKENS" --hook-json 2>/dev/null) || status=failed
else
  status=missing
fi

if [ "$status" = ok ] && [ -n "$envelope" ]; then
  printf '%s\n' "$envelope"
  exit 0
fi

context="app-map is unavailable in this session (app-map summary: $status). Run: npm install (the repo needs the @kalub92/app-map devDependency). Until then drive the simulator without the map and do not call mcp__app-map__* tools."
if command -v node >/dev/null 2>&1; then
  printf '%s' "$context" | node -e '
let s = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { s += d; });
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: s } }) + "\n");
});' && exit 0
fi
# Fallback: for SessionStart, plain stdout is also injected as context.
printf '%s\n' "$context"
exit 0
