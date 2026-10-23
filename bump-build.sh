#!/usr/bin/env bash
# Increment the Xcode build number (CURRENT_PROJECT_VERSION) by 1 across every
# build configuration/target. Use standalone or as a git pre-commit hook.
#
#   ./bump-build.sh
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PBXPROJ="$BASE/Kanji Extractor Safari - multi/Kanji Extractor.xcodeproj/project.pbxproj"

if [ ! -f "$PBXPROJ" ]; then
  echo "bump-build: pbxproj not found at $PBXPROJ" >&2
  exit 1
fi

current="$(grep -m1 -oE 'CURRENT_PROJECT_VERSION = [0-9]+;' "$PBXPROJ" | grep -oE '[0-9]+')"
if [ -z "${current:-}" ]; then
  echo "bump-build: CURRENT_PROJECT_VERSION not found" >&2
  exit 1
fi

next=$((current + 1))
sed -i '' -E "s/CURRENT_PROJECT_VERSION = [0-9]+;/CURRENT_PROJECT_VERSION = ${next};/g" "$PBXPROJ"

# Re-stamp the manifest version (= base.build) across the packages.
if [ -x "$BASE/build.sh" ]; then
  "$BASE/build.sh" >/dev/null
fi
echo "bump-build: build ${current} -> ${next} (manifests stamped)"
