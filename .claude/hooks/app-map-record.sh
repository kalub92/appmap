#!/bin/sh
# .claude/hooks/app-map-record.sh — PostToolUse / PostToolUseFailure hook for driver calls (05 §3, 04 §2).
#
# Reads the hook payload (session_id, hook_event_name, tool_name, tool_input, tool_response |
# tool_error, …) from stdin once and hands it to the app-map server as ONE newline-terminated JSON
# line, in order of preference:
#   1. unix socket app-map/.local/ingest.sock via `nc -U` (OpenBSD/macOS nc), else `socat`   (03 §2, <50 ms)
#   2. `app-map record --stdin` (direct SQLite write; spawns node)
# Always exits 0 — recording must never block the agent. Total runtime is bounded to ~4 s, under the
# 5 s hook timeout in .claude/settings.json. Talks only to the local socket/CLI: no network egress (07 §4).
set -u

ROOT=${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}
CLI="$ROOT/tools/app-map-mcp/bin/app-map"
MAP_DIR=${APP_MAP_DIR:-$ROOT/app-map}
SOCK="$MAP_DIR/.local/ingest.sock"
# The CLI resolves the map from APP_MAP_DIR, else from its own CWD (config.ts). A hook does not
# control its CWD, so without this the fallback path writes the observation into a stray
# <cwd>/app-map/.local/ and the project map never sees it (05 §3).
export APP_MAP_DIR="$MAP_DIR"
DEADLINE=4

umask 077
tmp=$(mktemp "${TMPDIR:-/tmp}/app-map-record.XXXXXX" 2>/dev/null) || exit 0
trap 'rm -f "$tmp"' EXIT

# JSON strings never contain raw newlines, so flattening yields exactly one line.
tr -d '\n\r' > "$tmp" 2>/dev/null || exit 0
[ -s "$tmp" ] || exit 0
printf '\n' >> "$tmp"

# bounded <secs> <infile> <cmd...>: run cmd with stdin from infile under a wall-clock limit.
# Uses `timeout` when present (Linux); otherwise a watchdog (macOS). The explicit `<` matters:
# POSIX shells give background jobs /dev/null as stdin unless redirected.
bounded() {
  secs=$1; in=$2; shift 2
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@" < "$in"
    return $?
  fi
  "$@" < "$in" &
  cmd=$!
  ( sleep "$secs"; kill "$cmd" 2>/dev/null ) &
  watchdog=$!
  wait "$cmd"
  rc=$?
  kill "$watchdog" 2>/dev/null
  return $rc
}

start=$(date +%s)
remaining() {
  r=$(( DEADLINE - ($(date +%s) - start) ))
  [ "$r" -gt 0 ] && echo "$r" || echo 0
}

# `sockaddr_un` caps the CONNECT path at ~103 bytes, so the socket is always addressed by its bare
# name from inside .local/ — a deep checkout would otherwise make the absolute spelling unusable
# and silently push every observation onto the slow CLI path (03 §2).
if [ -S "$SOCK" ]; then
  if command -v nc >/dev/null 2>&1; then
    ( cd "$MAP_DIR/.local" 2>/dev/null && bounded 2 "$tmp" nc -U -w 2 ingest.sock >/dev/null 2>&1 ) && exit 0
  fi
  if command -v socat >/dev/null 2>&1; then
    ( cd "$MAP_DIR/.local" 2>/dev/null && bounded 2 "$tmp" socat -T 2 - UNIX-CONNECT:ingest.sock >/dev/null 2>&1 ) && exit 0
  fi
fi

secs=$(remaining)
if [ "$secs" -gt 0 ] && [ -f "$CLI" ]; then
  bounded "$secs" "$tmp" sh "$CLI" record --stdin >/dev/null 2>&1
fi
exit 0
