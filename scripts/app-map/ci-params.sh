#!/usr/bin/env bash
# scripts/app-map/ci-params.sh — produce app-map/.local/ci-params.<platform>.json (04 §6.2, 06 R5/R6).
#
# `app-map maestro-export` and `app-map run --all` need a value for every required recipe param and
# refuse to guess (architecture §7 decision 36: "the CI workflow must produce the file — or pass
# --params-file — before maestro-export"). This script is that step.
#
# Source, first match wins:
#   1. $APP_MAP_CI_PARAMS                                  explicit path (CI variable / secret-free)
#   2. app-map/ci-params.<platform>.json                   committed fixture values, if the team keeps them in the map
#   3. instrumentation/<platform>/fixtures/ci-params.json  the app's own fixture module
#
# The values are FIXTURE data by definition (07 §3: recipes only ever run against fixture accounts),
# so they are safe to commit; they are copied into app-map/.local/ which is git-ignored.
#
# usage: scripts/app-map/ci-params.sh [--platform ios|android] [--out PATH] [--source PATH]
set -euo pipefail

PLATFORM=${APP_MAP_PLATFORM:-ios}
OUT=""
SOURCE=${APP_MAP_CI_PARAMS:-}

usage() { sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --platform) PLATFORM=${2:?--platform needs a value}; shift 2 ;;
    --out) OUT=${2:?--out needs a value}; shift 2 ;;
    --source) SOURCE=${2:?--source needs a value}; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ci-params: unknown argument $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$PLATFORM" in ios|android) ;; *) echo "ci-params: --platform must be ios or android" >&2; exit 2 ;; esac

ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))
[ -n "$OUT" ] || OUT="$ROOT/app-map/.local/ci-params.$PLATFORM.json"

if [ -z "$SOURCE" ]; then
  for candidate in \
    "$ROOT/app-map/ci-params.$PLATFORM.json" \
    "$ROOT/instrumentation/$PLATFORM/fixtures/ci-params.json"
  do
    if [ -f "$candidate" ]; then SOURCE=$candidate; break; fi
  done
fi

if [ -z "$SOURCE" ] || [ ! -f "$SOURCE" ]; then
  cat >&2 <<MSG
ci-params: no source for the CI parameter values ($PLATFORM).
Provide one of:
  APP_MAP_CI_PARAMS=<path>                              (or --source <path>)
  $ROOT/app-map/ci-params.$PLATFORM.json
  $ROOT/instrumentation/$PLATFORM/fixtures/ci-params.json
Shape: {"<recipe_id>": {"<param>": <value>}} — fixture values only (07 §3).
MSG
  exit 1
fi

command -v python3 >/dev/null 2>&1 || { echo "ci-params: python3 is required" >&2; exit 2; }
mkdir -p "$(dirname "$OUT")"
python3 - "$SOURCE" "$OUT" <<'PY'
import json, sys
src, out = sys.argv[1], sys.argv[2]
with open(src, encoding='utf-8') as fh:
    doc = json.load(fh)
if not isinstance(doc, dict) or not all(isinstance(v, dict) for v in doc.values()):
    raise SystemExit(f'ci-params: {src} must be {{"<recipe_id>": {{"<param>": <value>}}}}')
with open(out, 'w', encoding='utf-8') as fh:
    json.dump(doc, fh, indent=2, sort_keys=True)
    fh.write('\n')
print(f'ci-params: wrote {out} ({len(doc)} recipe(s))', file=sys.stderr)
PY
