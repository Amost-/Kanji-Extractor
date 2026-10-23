#!/usr/bin/env bash
# build-store-zips.sh — package the Chrome and Firefox extensions into
# upload-ready zips (manifest.json at the ZIP ROOT, which both stores require),
# for the Chrome Web Store and Firefox AMO.
#
# Usage:   ./build-store-zips.sh           # refresh from src/, then package
#          SKIP_BUILD=1 ./build-store-zips.sh   # package what's on disk as-is
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
CHROME_DIR="$ROOT/Kanji Extractor Chrome"
FIREFOX_DIR="$ROOT/KanjiFirefox"

# Refresh the packages from src/ so a zip can't ship stale code (skip = SKIP_BUILD=1).
if [ "${SKIP_BUILD:-0}" != "1" ] && [ -x "$ROOT/build.sh" ]; then
  "$ROOT/build.sh" >/dev/null && echo "build.sh: packages refreshed from src/"
fi

mkdir -p "$DIST"

pack() {
  local name="$1" dir="$2"
  [ -f "$dir/manifest.json" ] || { echo "ERROR: no manifest.json in $dir" >&2; exit 1; }
  # Validate JSON and read the version.
  local ver
  ver="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$dir/manifest.json")" \
    || { echo "ERROR: invalid manifest.json in $dir" >&2; exit 1; }

  local out="$DIST/kanji-extractor-$name-$ver.zip"
  rm -f "$out"
  # Zip the CONTENTS of the folder (so manifest.json lands at the zip root),
  # stripping macOS metadata (-X) and excluding cruft.
  ( cd "$dir" && zip -r -X "$out" . \
      -x '*.DS_Store' -x '__MACOSX/*' -x '*.zip' -x 'README.md' >/dev/null )

  # Verify manifest.json is at the root (a nested manifest = instant store reject).
  # Capture first, then match via here-string — piping into `grep -q` would SIGPIPE
  # `unzip` and trip `set -o pipefail` even on a match.
  local entries; entries="$(unzip -Z1 "$out")"
  grep -qx 'manifest.json' <<<"$entries" \
    || { echo "ERROR: manifest.json is not at the zip root in $out" >&2; exit 1; }

  printf '  ok  %-8s v%-8s ->  dist/%s  (%s)\n' \
    "$name" "$ver" "$(basename "$out")" "$(du -h "$out" | cut -f1 | tr -d ' \t')"
}

echo "Packaging store zips into dist/ ..."
pack chrome  "$CHROME_DIR"
pack firefox "$FIREFOX_DIR"
echo "Done."
echo "  Chrome Web Store  <-  dist/kanji-extractor-chrome-*.zip"
echo "  Firefox AMO       <-  dist/kanji-extractor-firefox-*.zip"
