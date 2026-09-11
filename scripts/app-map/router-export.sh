#!/usr/bin/env bash
# scripts/app-map/router-export.sh — run the app's debug-only router export (01 R6) and fetch the JSON.
#
# iOS (default)   boots/uses a simulator, launches the app with `-AppMapExport <path>` via
#                 `xcrun simctl launch`, waits for the file (the app writes it and exits).
# Android         broadcasts <bundle_id>.APPMAP_EXPORT with `--es path …` and pulls the file the
#                 receiver reports it wrote (see instrumentation/android/appmap).
#
# usage: router-export.sh [--platform ios|android] [--out FILE] [--udid UDID|booted] [--bundle-id ID]
#                         [--app PATH(.app|.apk)] [--timeout SECS]
# env:   APP_MAP_SIM_UDID (default booted) · APP_MAP_BUNDLE_ID (default com.example.app)
#        APP_MAP_APP_PATH (install first when set) · APP_MAP_EXPORT_TIMEOUT (default 90)
#        APP_MAP_ADB_SERIAL (android: device serial)
set -euo pipefail

PLATFORM=ios
OUT=/tmp/router-export.json
UDID=${APP_MAP_SIM_UDID:-booted}
BUNDLE_ID=${APP_MAP_BUNDLE_ID:-com.example.app}
APP_PATH=${APP_MAP_APP_PATH:-}
TIMEOUT=${APP_MAP_EXPORT_TIMEOUT:-90}

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }
die() { echo "router-export: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM=$2; shift 2 ;;
    --out) OUT=$2; shift 2 ;;
    --udid) UDID=$2; shift 2 ;;
    --bundle-id) BUNDLE_ID=$2; shift 2 ;;
    --app) APP_PATH=$2; shift 2 ;;
    --timeout) TIMEOUT=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

json_ok() { # json_ok FILE — non-empty and parseable (node or python3 when available)
  [ -s "$1" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); if (d.schema_version === undefined) process.exit(1)' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if "schema_version" in d else 1)' "$1"
  fi
}

wait_for() { # wait_for SECS CHECK_CMD...
  deadline=$(( $(date +%s) + $1 )); shift
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep 1
  done
}

mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"

# 01 R6: build.git_sha must be 7–40 hex. Prefer an explicit APP_MAP_GIT_SHA, else the checkout's HEAD.
GIT_SHA=${APP_MAP_GIT_SHA:-$(git -C "$(dirname "$0")" rev-parse HEAD 2>/dev/null || true)}

case "$PLATFORM" in
  ios)
    command -v xcrun >/dev/null 2>&1 || die "xcrun not found (macOS with Xcode required)"
    if [ "$UDID" = booted ]; then
      xcrun simctl list devices booted | grep -q '(Booted)' || die "no booted simulator; pass --udid or boot one"
    else
      xcrun simctl boot "$UDID" 2>/dev/null || true
      xcrun simctl bootstatus "$UDID" -b >/dev/null
    fi
    if [ -n "$APP_PATH" ]; then
      xcrun simctl install "$UDID" "$APP_PATH"
    fi
    xcrun simctl terminate "$UDID" "$BUNDLE_ID" >/dev/null 2>&1 || true
    echo "router-export: launching $BUNDLE_ID on $UDID with -AppMapExport $OUT" >&2
    # SIMCTL_CHILD_* variables are forwarded into the launched app's environment.
    SIMCTL_CHILD_APP_MAP_GIT_SHA="$GIT_SHA" xcrun simctl launch "$UDID" "$BUNDLE_ID" -AppMapExport "$OUT" >/dev/null
    wait_for "$TIMEOUT" json_ok "$OUT" || die "timed out after ${TIMEOUT}s waiting for $OUT (is AppMapRouterRegistry.exportIfRequested() called at launch in a Debug build?)"
    ;;
  android)
    command -v adb >/dev/null 2>&1 || die "adb not found"
    adb_() { # adb, scoped to APP_MAP_ADB_SERIAL when set
      if [ -n "${APP_MAP_ADB_SERIAL:-}" ]; then adb -s "$APP_MAP_ADB_SERIAL" "$@"; else adb "$@"; fi
    }
    adb_ wait-for-device
    if [ -n "$APP_PATH" ]; then
      adb_ install -r "$APP_PATH" >/dev/null
    fi
    remote=/sdcard/router-export.json
    adb_ shell rm -f "$remote" >/dev/null 2>&1 || true
    echo "router-export: broadcasting $BUNDLE_ID.APPMAP_EXPORT --es path $remote" >&2
    result=$(adb_ shell am broadcast -a "$BUNDLE_ID.APPMAP_EXPORT" --es path "$remote" --es git_sha "$GIT_SHA" 2>&1) || die "broadcast failed: $result"
    # The debug receiver returns the path it actually wrote as result data (scoped storage may
    # redirect it to the app-specific external files dir).
    actual=$(printf '%s' "$result" | sed -n 's/.*data="\([^"]*\)".*/\1/p' | head -n 1)
    actual=${actual:-$remote}
    pull_ok() {
      adb_ pull "$actual" "$OUT" >/dev/null 2>&1 && json_ok "$OUT" && return 0
      case "$actual" in
        /data/user/0/"$BUNDLE_ID"/*|/data/data/"$BUNDLE_ID"/*)
          rel=${actual#/data/user/0/"$BUNDLE_ID"/}; rel=${rel#/data/data/"$BUNDLE_ID"/}
          adb_ shell run-as "$BUNDLE_ID" cat "$rel" > "$OUT" 2>/dev/null && json_ok "$OUT" && return 0 ;;
      esac
      return 1
    }
    wait_for "$TIMEOUT" pull_ok || die "timed out after ${TIMEOUT}s fetching $actual (broadcast result: $result)"
    ;;
  *) die "unknown platform: $PLATFORM" ;;
esac

echo "router-export: wrote $OUT" >&2
