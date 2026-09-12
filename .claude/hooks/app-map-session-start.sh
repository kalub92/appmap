#!/bin/sh
# .claude/hooks/app-map-session-start.sh — SessionStart hook (05 §3); also wired to PreCompact.
#
# Reads the hook payload on stdin, runs `app-map summary --max-tokens 600 --hook-json`, and prints
#   {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<summary + preamble>"}}
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
MAX_TOKENS=${APP_MAP_MAX_CONTEXT_TOKENS:-600}
BUDGET=${APP_MAP_HOOK_BUDGET_SECS:-20}
# The CLI resolves the map from APP_MAP_DIR, else from its own CWD (config.ts). A hook does not
# control its CWD, so without this an off-root session silently reports an EMPTY map as loaded.
APP_MAP_DIR=${APP_MAP_DIR:-$ROOT/app-map}
export APP_MAP_DIR

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

# 05 §7 AC1 (fresh clone → `claude` → summary in the first turn): dist/ and node_modules/ are both
# gitignored, so a fresh clone has neither and .mcp.json's `node …/dist/index.js` cannot start.
# Install ONCE, guarded by a stamp file so a failure never re-runs on every session, and bounded
# like everything else here. Offline/failed installs simply fall through to the "unavailable" note.
STAMP="$PKG/node_modules/.app-map-bootstrap"
if [ ! -d "$PKG/node_modules" ] && [ ! -f "$STAMP" ] && [ -f "$PKG/package-lock.json" ] && command -v npm >/dev/null 2>&1; then
  bounded "${APP_MAP_BOOTSTRAP_BUDGET_SECS:-180}" npm ci --prefix "$PKG" >/dev/null 2>&1 || true
  [ -d "$PKG/node_modules" ] && : > "$STAMP"
fi
# Build once if the package was installed but never built. The bin/app-map shim can also run the
# TypeScript source directly, so this is an optimisation, not a requirement.
if [ ! -f "$PKG/dist/cli.js" ] && [ -d "$PKG/node_modules" ]; then
  bounded "$BUDGET" npm run build --prefix "$PKG" >/dev/null 2>&1 || true
fi

# `summary --hook-json` emits exactly the 05 §3 envelope, with the summary AND the fixed preamble
# (src/format.ts formatSessionStartContext) inside `additionalContext`. Building the preamble here
# too printed the four rules twice and cost ~60% more tokens.
status=ok
envelope=""
if [ -f "$CLI" ]; then
  envelope=$(bounded "$BUDGET" sh "$CLI" summary --max-tokens "$MAX_TOKENS" --hook-json 2>/dev/null) || status=failed
else
  status=missing
fi

if [ "$status" = ok ] && [ -n "$envelope" ]; then
  printf '%s\n' "$envelope"
  exit 0
fi

context="app-map is unavailable in this session (app-map summary: $status). Run: npm ci --prefix tools/app-map-mcp && npm run build --prefix tools/app-map-mcp. Until then drive the simulator without the map and do not call mcp__app-map__* tools."
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
