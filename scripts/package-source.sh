#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$ROOT_DIR/package.json').version")"
DIST_DIR="$ROOT_DIR/dist"
DEFAULT_ARCHIVE="$DIST_DIR/sensemark-v$VERSION-source.zip"
REQUESTED_ARCHIVE="${1:-$DEFAULT_ARCHIVE}"
if [[ "$REQUESTED_ARCHIVE" = /* ]]; then
  ARCHIVE="$REQUESTED_ARCHIVE"
else
  ARCHIVE="$ROOT_DIR/$REQUESTED_ARCHIVE"
fi
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sensemark-source.XXXXXX")"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid or missing source version: $VERSION" >&2
  exit 1
fi

mkdir -p "$(dirname "$ARCHIVE")"
rm -f "$ARCHIVE"

for item in \
  .github \
  AGENTS.md \
  BROWSER_ACCEPTANCE.md \
  CHANGELOG.md \
  LICENSE \
  PRIVACY.md \
  PRIVACY.en.md \
  README.md \
  README.en.md \
  REFACTOR_NOTES.md \
  RESEARCH_NOTES.md \
  TECHNICAL_REVIEW_REPORT.md \
  .nvmrc \
  manifest.json \
  package.json \
  package-lock.json \
  background \
  content \
  docs \
  extension \
  icons \
  options \
  popup \
  scripts \
  shared \
  sidepanel \
  store \
  tests
do
  COPYFILE_DISABLE=1 cp -R "$ROOT_DIR/$item" "$STAGE_DIR/$item"
done

find "$STAGE_DIR" -type d -exec chmod 0755 {} +
find "$STAGE_DIR" -type f -exec chmod 0644 {} +
find "$STAGE_DIR" -exec touch -t 200001010000.00 {} +

cd "$STAGE_DIR"
LC_ALL=C find . -type f -print \
  | sed 's#^\./##' \
  | LC_ALL=C sort \
  | zip -X -q -9 -D "$ARCHIVE" -@

if [[ "$ARCHIVE" = "$DEFAULT_ARCHIVE" && -f "$DIST_DIR/sensemark-v$VERSION.zip" ]]; then
  node "$ROOT_DIR/scripts/write-artifact-checksums.js"
fi

echo "$ARCHIVE"
