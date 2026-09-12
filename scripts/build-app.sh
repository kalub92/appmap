#!/usr/bin/env bash
# scripts/build-app.sh — build the app for app-map CI (06 §3). DOCUMENTED STUB.
#
# CI calls:  ./scripts/build-app.sh --configuration Debug --sim        (iOS jobs)
#            ./scripts/build-app.sh --configuration Debug --emulator   (Android job)
#
# Either replace this file with the real build, or set APP_MAP_BUILD_CMD to the real command; it is
# exec'd through `sh -c` with APP_MAP_BUILD_CONFIGURATION and APP_MAP_BUILD_TARGET exported.
# Without APP_MAP_BUILD_CMD this script prints what the real build must do and exits 2.
set -euo pipefail

CONFIGURATION=Debug
TARGET=""

usage() {
  cat <<USAGE
usage: scripts/build-app.sh [--configuration Debug|Release] (--sim | --emulator)
env:   APP_MAP_BUILD_CMD   real build command (exec'd via sh -c); see the guidance printed without it
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --configuration) [ $# -ge 2 ] || { usage >&2; exit 2; }; CONFIGURATION=$2; shift 2 ;;
    --configuration=*) CONFIGURATION=${1#*=}; shift ;;
    --sim) TARGET=sim; shift ;;
    --emulator) TARGET=emulator; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "build-app.sh: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$CONFIGURATION" != Debug ]; then
  # 07 §3: recipes and the drift tour run only against Debug builds with APP_MAP_DEBUG.
  echo "build-app.sh: app-map CI builds must use --configuration Debug (got $CONFIGURATION)" >&2
  exit 2
fi

if [ -n "${APP_MAP_BUILD_CMD:-}" ]; then
  export APP_MAP_BUILD_CONFIGURATION="$CONFIGURATION"
  export APP_MAP_BUILD_TARGET="$TARGET"
  exec sh -c "$APP_MAP_BUILD_CMD"
fi

cat >&2 <<GUIDE
build-app.sh: no build configured (APP_MAP_BUILD_CMD is unset). configuration=$CONFIGURATION target=${TARGET:-unset}

What the real script must do:
  iOS (--sim)
    xcodebuild -scheme <App> -configuration Debug -sdk iphonesimulator \\
      -destination 'platform=iOS Simulator,name=iPhone 16' \\
      OTHER_SWIFT_FLAGS='\$(inherited) -D APP_MAP_DEBUG' build
    - the Debug config must define APP_MAP_DEBUG (01 §2) and set Info.plist AppMapGitSHA to the git sha
    - export the .app path and bundle id for the next steps:
        echo "APP_MAP_APP_PATH=<DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app" >> "\$GITHUB_ENV"
        echo "APP_MAP_BUNDLE_ID=com.example.app" >> "\$GITHUB_ENV"
  Android (--emulator)
    ./gradlew :app:assembleDebug   # debug build type sets BuildConfig.APP_MAP_DEBUG=true via the appmap module
    echo "APP_MAP_APP_PATH=app/build/outputs/apk/debug/app-debug.apk" >> "\$GITHUB_ENV"
    echo "APP_MAP_BUNDLE_ID=com.example.app" >> "\$GITHUB_ENV"
  Both
    - Debug only, sandbox backend, fixture accounts (07 §3); never a Release configuration
    - the build must include the AppMapKit package / :appmap module and the debug-only fixtures module
    - scripts/app-map/router-export.sh consumes APP_MAP_APP_PATH / APP_MAP_BUNDLE_ID afterwards

Set APP_MAP_BUILD_CMD (or replace this stub) and set the repo variable APP_MAP_HAS_APP=true to enable
the mobile CI jobs (.github/workflows/app-map.yml).
GUIDE
exit 2
