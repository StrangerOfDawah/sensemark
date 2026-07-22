#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/manifest.json" | head -n 1)"
DIST_DIR="$ROOT_DIR/dist"
ARCHIVE="$DIST_DIR/quick-translate-v$VERSION.zip"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid or missing extension version: $VERSION" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE"

cd "$ROOT_DIR"
zip -q -r "$ARCHIVE" \
  manifest.json \
  background.js \
  content.js \
  options.html \
  options.js \
  icons \
  LICENSE \
  PRIVACY.md

echo "$ARCHIVE"
