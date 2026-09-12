#!/bin/sh
# .claude/hooks/app-map-session-stop.sh — Stop hook (05 §3): export dirty durable map changes to YAML.
#
# Runs `app-map export` WITHOUT --force. 03 §4: export refuses to overwrite a YAML file whose git blob
# changed since load and prints the diff instead; that message is forwarded to stderr for the developer.
# Prints the files written to stderr. Emits nothing on stdout. Exit 0 always — never blocks the agent.
set -u

ROOT=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
CLI="$ROOT/tools/app-map-mcp/bin/app-map"
BUDGET=${APP_MAP_HOOK_BUDGET_SECS:-50}
# The CLI resolves the map from APP_MAP_DIR, else from its own CWD (config.ts). A hook does not
# control its CWD, so without this an off-root session exports NOTHING while still exiting 0 —
# every dirty durable change is silently dropped (05 §3, 03 §4).
APP_MAP_DIR=${APP_MAP_DIR:-$ROOT/app-map}
export APP_MAP_DIR

cat >/dev/null 2>&1 || true   # payload (session_id, stop_hook_active, …) is not needed

bounded() {
  secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

if [ ! -f "$CLI" ]; then
  echo "app-map-session-stop: $CLI not found; nothing exported" >&2
  exit 0
fi

out=$(bounded "$BUDGET" sh "$CLI" export 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  [ -n "$out" ] && printf 'app-map export:\n%s\n' "$out" >&2
else
  printf 'app-map export did not complete (rc=%s); run `tools/app-map-mcp/bin/app-map export` manually:\n%s\n' "$rc" "$out" >&2
fi
exit 0
