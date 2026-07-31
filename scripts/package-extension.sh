#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT_DIR/manifest.json" | head -n 1)"
DIST_DIR="$ROOT_DIR/dist"
DEFAULT_ARCHIVE="$DIST_DIR/sensemark-v$VERSION.zip"
REQUESTED_ARCHIVE="${1:-$DEFAULT_ARCHIVE}"
if [[ "$REQUESTED_ARCHIVE" = /* ]]; then
  ARCHIVE="$REQUESTED_ARCHIVE"
else
  ARCHIVE="$ROOT_DIR/$REQUESTED_ARCHIVE"
fi
STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/sensemark-package.XXXXXX")"

cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid or missing extension version: $VERSION" >&2
  exit 1
fi

mkdir -p "$(dirname "$ARCHIVE")"
rm -f "$ARCHIVE"

for item in \
  manifest.json \
  background \
  shared \
  content \
  extension \
  popup \
  options \
  sidepanel \
  icons \
  LICENSE \
  PRIVACY.md \
  PRIVACY.en.md
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

echo "$ARCHIVE"
