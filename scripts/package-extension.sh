#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/src/manifest.json" | head -n 1)"
DIST_DIR="$ROOT_DIR/dist"
ARCHIVE="$DIST_DIR/sensemark-v$VERSION.zip"

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid or missing extension version: $VERSION" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"
rm -f "$ARCHIVE"

# The extension itself lives in src/; manifest.json must be at the top of the
# archive for Chrome Web Store and "Load unpacked".
cd "$ROOT_DIR/src"
zip -q -r "$ARCHIVE" \
  manifest.json \
  background.js \
  background/prompts.js \
  background/validation.js \
  i18n.js \
  language-detection.js \
  selection-text.js \
  word-response.js \
  text-response.js \
  manual-translation.js \
  ui-scale.js \
  builtin-translator.js \
  card-theme.js \
  fonts/golos-text-latin-400.woff2 \
  fonts/golos-text-cyrillic-400.woff2 \
  fonts/literata-latin-400.woff2 \
  fonts/literata-cyrillic-400.woff2 \
  fonts/OFL-GolosText.txt \
  fonts/OFL-Literata.txt \
  content/card-styles.js \
  content/page-text.js \
  content/placement.js \
  content/status-pill.js \
  content/content.js \
  popup.html \
  popup.css \
  popup.js \
  options.html \
  options.js \
  _locales/ru/messages.json \
  icons

# Legal documents ship with the extension.
cd "$ROOT_DIR"
zip -q "$ARCHIVE" \
  LICENSE \
  PRIVACY.md

echo "$ARCHIVE"
