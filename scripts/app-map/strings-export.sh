#!/usr/bin/env bash
# scripts/app-map/strings-export.sh — static string table snapshot for the scrubber (07 §2.3.3).
#
# Extracts every static UI string from iOS string catalogs (.xcstrings, .strings, .stringsdict) and
# Android resources (values*/strings.xml: <string>, <plurals><item>, <string-array><item>) found
# under the given paths and writes app-map/.local/strings.<platform>.txt — one string per line,
# sorted, unique, LF. Newlines inside a string are written as the two characters "\n".
# The file is git-ignored (app-map/.local); regenerate at build time. Pure python3, no packages.
#
# usage: scripts/app-map/strings-export.sh [--platform ios|android] [--out-dir DIR] PATH...
#        (platform is inferred per file when --platform is omitted; both files may be written)
set -euo pipefail

PLATFORM=""
OUT_DIR=""

usage() { sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; }

# Consume options; re-append positional PATH arguments to "$@" (POSIX sh, no arrays).
count=$#
i=0
while [ "$i" -lt "$count" ]; do
  arg=$1; shift; i=$((i + 1))
  case "$arg" in
    --platform) [ "$i" -lt "$count" ] || { usage >&2; exit 2; }; PLATFORM=$1; shift; i=$((i + 1)) ;;
    --out-dir) [ "$i" -lt "$count" ] || { usage >&2; exit 2; }; OUT_DIR=$1; shift; i=$((i + 1)) ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "strings-export: unknown option $arg" >&2; usage >&2; exit 2 ;;
    *) set -- "$@" "$arg" ;;
  esac
done
[ $# -gt 0 ] || { usage >&2; exit 2; }
case "$PLATFORM" in ""|ios|android) ;; *) echo "strings-export: --platform must be ios or android" >&2; exit 2 ;; esac

if [ -z "$OUT_DIR" ]; then
  ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/../.." && pwd))
  OUT_DIR="$ROOT/app-map/.local"
fi
command -v python3 >/dev/null 2>&1 || { echo "strings-export: python3 is required" >&2; exit 2; }

exec python3 - "$PLATFORM" "$OUT_DIR" "$@" <<'PY'
import json
import os
import plistlib
import re
import sys
import xml.etree.ElementTree as ET

platform_filter, out_dir, *roots = sys.argv[1:]
tables = {"ios": set(), "android": set()}


def normalise(value):
    if not isinstance(value, str):
        return None
    value = value.replace("\r\n", "\n").replace("\r", "\n").strip()
    if not value:
        return None
    return value.replace("\n", "\\n")


def add(platform, value):
    v = normalise(value)
    if v:
        tables[platform].add(v)


def read_text(path):
    with open(path, "rb") as fh:
        raw = fh.read()
    if raw.startswith(b"\xff\xfe") or raw.startswith(b"\xfe\xff"):
        return raw.decode("utf-16")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return raw.decode("utf-16")


APPLE_ESCAPES = {"n": "\n", "t": "\t", '"': '"', "\\": "\\", "'": "'", "r": "\r"}


def apple_unescape(s):
    return re.sub(r"\\(.)", lambda m: APPLE_ESCAPES.get(m.group(1), m.group(1)), s)


STRINGS_RE = re.compile(r'"((?:[^"\\]|\\.)*)"\s*=\s*"((?:[^"\\]|\\.)*)"\s*;')


def parse_strings(path):
    text = read_text(path)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"^\s*//.*$", "", text, flags=re.M)
    for key, value in STRINGS_RE.findall(text):
        add("ios", apple_unescape(key))
        add("ios", apple_unescape(value))


def walk_string_units(node):
    if isinstance(node, dict):
        unit = node.get("stringUnit")
        if isinstance(unit, dict) and isinstance(unit.get("value"), str):
            add("ios", unit["value"])
        for child in node.values():
            walk_string_units(child)
    elif isinstance(node, list):
        for child in node:
            walk_string_units(child)


def parse_xcstrings(path):
    with open(path, "rb") as fh:
        doc = json.load(fh)
    for key, entry in (doc.get("strings") or {}).items():
        add("ios", key)
        walk_string_units(entry)


STRINGSDICT_META = {"NSStringLocalizedFormatKey", "NSStringFormatSpecTypeKey", "NSStringFormatValueTypeKey"}


def walk_plist(node):
    if isinstance(node, dict):
        for key, child in node.items():
            if key in STRINGSDICT_META:
                continue
            if isinstance(child, str):
                add("ios", child)
            else:
                walk_plist(child)
    elif isinstance(node, list):
        for child in node:
            walk_plist(child)


def parse_stringsdict(path):
    with open(path, "rb") as fh:
        walk_plist(plistlib.load(fh))


ANDROID_ESCAPES = {"n": "\n", "t": "\t", "'": "'", '"': '"', "\\": "\\", "@": "@", "?": "?", "u": "\\u"}


def android_unescape(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        s = s[1:-1]
    else:
        s = re.sub(r"\s+", " ", s)
    return re.sub(r"\\(.)", lambda m: ANDROID_ESCAPES.get(m.group(1), m.group(1)), s)


def parse_android_xml(path):
    try:
        root = ET.parse(path).getroot()
    except ET.ParseError as e:
        print(f"strings-export: skipping {path}: {e}", file=sys.stderr)
        return
    if root.tag != "resources":
        return
    for el in root.iter():
        if el.tag in ("string", "item"):
            text = "".join(el.itertext())
            if text.strip():
                add("android", android_unescape(text))


def handle(path):
    name = os.path.basename(path)
    lower = name.lower()
    if lower.endswith(".xcstrings"):
        parse_xcstrings(path)
    elif lower.endswith(".strings"):
        parse_strings(path)
    elif lower.endswith(".stringsdict"):
        parse_stringsdict(path)
    elif lower.endswith(".xml") and ("values" in os.path.basename(os.path.dirname(path)) or lower == "strings.xml"):
        parse_android_xml(path)


SKIP_DIRS = {".git", "node_modules", "build", ".build", "DerivedData", ".gradle", "Pods"}

for root_path in roots:
    if os.path.isfile(root_path):
        handle(root_path)
        continue
    if not os.path.isdir(root_path):
        print(f"strings-export: {root_path} does not exist", file=sys.stderr)
        sys.exit(1)
    for dirpath, dirnames, filenames in os.walk(root_path):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for filename in filenames:
            handle(os.path.join(dirpath, filename))

os.makedirs(out_dir, exist_ok=True)
written = 0
for platform in ("ios", "android"):
    if platform_filter and platform != platform_filter:
        continue
    values = tables[platform]
    if not values and not platform_filter:
        continue
    target = os.path.join(out_dir, f"strings.{platform}.txt")
    with open(target, "w", encoding="utf-8", newline="\n") as fh:
        for line in sorted(values):
            fh.write(line + "\n")
    print(f"strings-export: {len(values)} {platform} strings → {target}", file=sys.stderr)
    written += 1
if written == 0:
    print("strings-export: no string tables found under the given paths", file=sys.stderr)
    sys.exit(1)
PY
