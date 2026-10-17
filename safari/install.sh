#!/bin/bash
# Собирает Xcode-проект Sensemark для Safari из этой папки.
#
# Первый запуск: создаёт проект в ~/Sensemark-Safari шаблоном Apple
# (safari-web-extension-converter) и подставляет в него наши файлы.
# Следующие запуски (обновление): только обновляют файлы расширения
# и Swift-код — выбранная в Xcode команда подписи сохраняется.
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${SENSEMARK_PROJECT_DIR:-$HOME/Sensemark-Safari}"
BUNDLE_ID="${SENSEMARK_BUNDLE_ID:-com.sensemark.safari}"

find_one() {
  find "$PROJECT_DIR" -name "$1" -not -path "*/build/*" -not -path "*/DerivedData/*" -print -quit 2>/dev/null
}

if [ -z "$(find "$PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit 2>/dev/null)" ]; then
  echo "Создаю Xcode-проект в $PROJECT_DIR…"
  mkdir -p "$PROJECT_DIR"
  xcrun safari-web-extension-converter "$KIT/extension" \
    --project-location "$PROJECT_DIR" \
    --app-name Sensemark \
    --bundle-identifier "$BUNDLE_ID" \
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
XCODEPROJ="$(find "$PROJECT_DIR" -maxdepth 3 -name '*.xcodeproj' -print -quit)"

if [ -z "$HANDLER" ] || [ -z "$VIEW_CONTROLLER" ] || [ -z "$MANIFEST" ] || [ -z "$XCODEPROJ" ]; then
  echo "Не нашёл файлы проекта в $PROJECT_DIR. Пришлите этот вывод разработчику." >&2
  find "$PROJECT_DIR" -maxdepth 4 -not -path "*/.*" >&2
  exit 1
fi

# Шаблон Apple может выставить старую минимальную macOS, а Swift-код
# использует Translation и Logger — поднимаем её до macOS 15 (выше не нужно:
# перевод без окна сам проверяет 26.4 во время работы).
PBXPROJ="$XCODEPROJ/project.pbxproj"
if [ -f "$PBXPROJ" ]; then
  sed -i '' -E 's/MACOSX_DEPLOYMENT_TARGET = [0-9.]+;/MACOSX_DEPLOYMENT_TARGET = 15.0;/g' "$PBXPROJ"
fi

cp "$KIT/native/SafariWebExtensionHandler.swift" "$HANDLER"
cp "$KIT/native/ViewController.swift" "$VIEW_CONTROLLER"
rsync -a --delete "$KIT/extension/" "$(dirname "$MANIFEST")/"

echo "Готово: $XCODEPROJ"
open "$XCODEPROJ"
