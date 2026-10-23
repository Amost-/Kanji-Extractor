#!/usr/bin/env bash
# =============================================================================
# Kanji Extractor — build script.
#
# Stamps the single source of truth in ./src into the three browser packages.
# Each package is staged beside its destination and replaced as a unit.
# Existing icons and optional README files are preserved in the staged copy.
#
# Usage:  ./build.sh
# =============================================================================
set -euo pipefail

BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$BASE/src"

CHROME="$BASE/Kanji Extractor Chrome"
FIREFOX="$BASE/KanjiFirefox"
SAFARI="$BASE/Kanji Extractor Safari - multi/Shared (Extension)/Resources"

# Keep the existing numeric manifest version for browser update ordering.
# Safari also gets the separate marketing version as its display version.
PBXPROJ="$BASE/Kanji Extractor Safari - multi/Kanji Extractor.xcodeproj/project.pbxproj"
BUILD=""
MARKETING_VERSION=""
if [ -f "$PBXPROJ" ]; then
  BUILD="$(sed -nE 's/^[[:space:]]*CURRENT_PROJECT_VERSION = ([0-9]+);[[:space:]]*$/\1/p' "$PBXPROJ" | sort -u)"
  MARKETING_VERSION="$(sed -nE 's/^[[:space:]]*MARKETING_VERSION = ([0-9.]+);[[:space:]]*$/\1/p' "$PBXPROJ" | sort -u)"
fi
# Validate before copying anything; mismatched target/configuration versions
# must not silently produce packages with inconsistent release metadata.
# Xcode accepts two- or three-part marketing versions (1.4 as well as 1.4.1).
if ! [[ "$BUILD" =~ ^[0-9]+$ && "$MARKETING_VERSION" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]]; then
  echo "Expected one shared CURRENT_PROJECT_VERSION and MARKETING_VERSION in $PBXPROJ" >&2
  exit 1
fi

# Web assets copied verbatim to every target.
WEB_FILES=(sync-core.js sync-coordinator.js popup.js popup.html popup.css background.js)

copy_common() {
  local dst="$1"
  for f in "${WEB_FILES[@]}"; do
    cp "$SRC/$f" "$dst/$f"
  done
  cp -R "$SRC/_locales" "$dst/_locales"
}

build_target() (
  local name="$1" dst="$2" manifest="$3"
  if [ ! -d "$dst" ]; then
    echo "  ! skipping $name — target folder not found: $dst"
    return
  fi
  local parent stage backup old_file relative ver base
  parent="$(dirname "$dst")"
  stage="$(mktemp -d "$parent/.kanji-build.XXXXXXXX")"
  backup=""
  # Restore the old package if the second rename fails; always clear staging.
  trap 'if [ -n "$backup" ] && [ -d "$backup" ]; then if [ -e "$dst" ]; then rm -rf "$backup"; else mv "$backup" "$dst" || echo "Could not restore $dst from $backup" >&2; fi; fi; rm -rf "$stage"' EXIT
  cp -R "$dst/icons" "$stage/icons"
  if [ -f "$dst/README.md" ]; then cp "$dst/README.md" "$stage/README.md"; fi
  copy_common "$stage"
  cp "$SRC/manifests/$manifest" "$stage/manifest.json"
  # Finder metadata is not part of any package, including icon and locale folders.
  find "$stage" -name .DS_Store -type f -delete
  # Stamp version = "<base>.<build>" (base from src, build from the pbxproj).
  if [ -n "$BUILD" ]; then
    base="$(grep -m1 -oE '"version": "[0-9.]+"' "$stage/manifest.json" | grep -oE '[0-9.]+')"
    ver="${base}.${BUILD}"
    sed -i '' -E "s/\"version\": \"[0-9.]+\"/\"version\": \"${ver}\"/" "$stage/manifest.json"
  fi
  if [ "$manifest" = "safari.json" ]; then
    # WebKit's displayVersion prefers version_name over the numeric version.
    # Derive it from Xcode every time, without appending the build number.
    sed -i '' -E "s/\"version_name\": \"[^\"]*\"/\"version_name\": \"${MARKETING_VERSION}\"/" "$stage/manifest.json"
  fi
  # Report stale files before replacing the package with the allow-listed tree.
  while IFS= read -r old_file; do
    if [ "$old_file" = "$dst" ]; then continue; fi
    relative="${old_file#"$dst"/}"
    if [ ! -e "$stage/$relative" ]; then echo "  - $name removed: $relative"; fi
  done < <(find "$dst" -depth -print)
  backup="$(mktemp -d "$parent/.kanji-old.XXXXXXXX")"
  rmdir "$backup"
  mv "$dst" "$backup"
  mv "$stage" "$dst"
  rm -rf "$backup"
  backup=""
  if [ "$manifest" = "safari.json" ]; then
    echo "  ✓ $name (v$MARKETING_VERSION, build $BUILD; manifest $ver)"
  else
    echo "  ✓ $name (v$ver)"
  fi
)

echo "Building Kanji Extractor packages from src/ ..."
build_target "Chrome"  "$CHROME"  "chrome.json"
build_target "Firefox" "$FIREFOX" "firefox.json"
build_target "Safari"  "$SAFARI"  "safari.json"
echo "Done."
