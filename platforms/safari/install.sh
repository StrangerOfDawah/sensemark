#!/bin/bash
# Builds the Sensemark Xcode project for Safari from this folder.
#
# First run: creates the project in ~/Sensemark-Safari from Apple's template
# (safari-web-extension-converter) and drops our files into it.
# Later runs (updates): only refresh the extension files and the Swift
# code; the signing team chosen in Xcode is kept.
#
# Important: macOS runs this script with the old bash 3.2, which counts the
# bytes of non-ASCII letters as part of a variable name, so variables here are
# always written in braces: ${NAME}.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SENSEMARK_PROJECT_DIR:-${HOME}/Sensemark-Safari}"
BUNDLE_ID="${SENSEMARK_BUNDLE_ID:-com.sensemark.safari}"

# macOS marks files received via AirDrop or a browser as downloaded;
# remove the mark so Xcode and codesign do not reject them.
xattr -dr com.apple.quarantine "${KIT}" 2>/dev/null || true
xattr -dr com.apple.provenance "${KIT}" 2>/dev/null || true

find_one() {
  find "${PROJECT_DIR}" -name "${1}" -not -path "*/build/*" -not -path "*/DerivedData/*" -print -quit 2>/dev/null
}

if [ -z "$(find "${PROJECT_DIR}" -maxdepth 3 -name '*.xcodeproj' -print -quit 2>/dev/null)" ]; then
  echo "Creating the Xcode project in ${PROJECT_DIR} ..."
  mkdir -p "${PROJECT_DIR}"
  xcrun safari-web-extension-converter "${KIT}/extension" \
    --project-location "${PROJECT_DIR}" \
    --app-name Sensemark \
    --bundle-identifier "${BUNDLE_ID}" \
    --swift \
    --macos-only \
    --copy-resources \
    --no-open \
    --no-prompt \
    --force
fi

HANDLER="$(find_one SafariWebExtensionHandler.swift)"
VIEW_CONTROLLER="$(find_one ViewController.swift)"
MANIFEST="$(find_one manifest.json)"
XCODEPROJ="$(find "${PROJECT_DIR}" -maxdepth 3 -name '*.xcodeproj' -print -quit)"

if [ -z "${HANDLER}" ] || [ -z "${VIEW_CONTROLLER}" ] || [ -z "${MANIFEST}" ] || [ -z "${XCODEPROJ}" ]; then
  echo "Could not find the project files in ${PROJECT_DIR}; please send this output to the developer." >&2
  find "${PROJECT_DIR}" -maxdepth 4 -not -path "*/.*" >&2
  exit 1
fi

# Apple's template may set an old minimum macOS, while the Swift code
# uses Translation and Logger: raise it to macOS 15 (no higher, since
# windowless translation checks for 26.4 at runtime).
PBXPROJ="${XCODEPROJ}/project.pbxproj"
if [ -f "${PBXPROJ}" ]; then
  sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = [0-9.]+;/MACOSX_DEPLOYMENT_TARGET = 15.0;/g' "${PBXPROJ}"
fi

cp "${KIT}/native/SafariWebExtensionHandler.swift" "${HANDLER}"
cp "${KIT}/native/ViewController.swift" "${VIEW_CONTROLLER}"
rsync -a --delete "${KIT}/extension/" "$(dirname "${MANIFEST}")/"

echo "Done: ${XCODEPROJ}"
# CI builds the project itself and has no Xcode window to open.
if [ -z "${SENSEMARK_NO_OPEN:-}" ]; then
  open "${XCODEPROJ}"
fi
