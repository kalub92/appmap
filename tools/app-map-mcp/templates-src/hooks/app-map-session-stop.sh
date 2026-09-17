#!/bin/sh
# .claude/hooks/app-map-session-stop.sh — Stop hook (05 §3): export dirty durable map changes to YAML.
#
# Written by `app-map init`. Runs `app-map export` WITHOUT --force. 03 §4: export refuses to
# overwrite a YAML file whose git blob changed since load and prints the diff instead; that message
# is forwarded to stderr for the developer. Prints the files written to stderr. Emits nothing on
# stdout. Exit 0 always — never blocks the agent.
set -u

ROOT=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
BUDGET=${APP_MAP_HOOK_BUDGET_SECS:-50}
# The CLI resolves the map from APP_MAP_DIR, else from its own CWD. A hook does not control its CWD,
# so without this an off-root session exports NOTHING while still exiting 0.
APP_MAP_DIR=${APP_MAP_DIR:-$ROOT/app-map}
export APP_MAP_DIR

cat >/dev/null 2>&1 || true   # payload (session_id, stop_hook_active, …) is not needed

bounded() {
  secs=$1; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"; else "$@"; fi
}

if [ -x "$ROOT/node_modules/.bin/app-map" ]; then
  set -- "$ROOT/node_modules/.bin/app-map"
elif command -v app-map >/dev/null 2>&1; then
  set -- app-map
elif command -v npx >/dev/null 2>&1; then
  set -- npx --no-install app-map
else
  echo "app-map-session-stop: the app-map CLI is not installed (npm install); nothing exported" >&2
  exit 0
fi

out=$(bounded "$BUDGET" "$@" export 2>&1)
rc=$?
if [ "$rc" -eq 0 ]; then
  [ -n "$out" ] && printf 'app-map export:\n%s\n' "$out" >&2
else
  printf 'app-map export did not complete (rc=%s); run `npx app-map export` manually:\n%s\n' "$rc" "$out" >&2
fi
exit 0
