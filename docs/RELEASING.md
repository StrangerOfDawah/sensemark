# Выпуск Sensemark

## Подготовка

1. Используйте Node.js 24 LTS (`.nvmrc`) и убедитесь, что `manifest.json`, `package.json`, `package-lock.json` и новая
   секция `CHANGELOG.md` содержат одну версию.
2. Проверьте store copy и privacy disclosure, если менялись данные, permissions
   или provider.
3. Выполните:

```bash
npm ci
npm test
npm run test:coverage
npm run check
npm run test:browser:auto
npm run package:extension
npm run package:source
npm run verify:reproducible
npm run verify:artifacts
node scripts/validate-source.js dist/sensemark-v$(node -p "require('./manifest.json').version")-source.zip
node scripts/validate-extension.js dist/sensemark-v$(node -p "require('./manifest.json').version").zip
```

4. Выполните ручной gate из `BROWSER_ACCEPTANCE.md`. Если built-in PDF и
   side-panel user activation остаются `Not tested`, артефакт является только
   release candidate и не загружается в Chrome Web Store.
5. После успешного gate загрузите ZIP как новую package-версию в Chrome Web Store. Не распаковывайте
   и не перепаковывайте архив вручную.
6. В Chrome 119+ перед отправкой review проверьте распакованную сборку:
   - обычный текст, формы и открытый Shadow DOM;
   - top frame, same-origin и cross-origin iframe;
   - automatic/button/manual, copy suppression, menu и shortcut;
   - text/contextual/multilingual;
   - cancel, auth, quota, timeout, retry и cache hit;
   - drag, double-click reset, resize, zoom и viewport resize;
   - popup explicit action, paste auto и side-panel fallback.

## Публикация

Тег и GitHub Release создаются только с точного commit, прошедшего CI. Артефакт
релиза должен совпадать с проверенным ZIP. API‑ключ ревьюера не коммитится и
размещается только в приватном поле Dashboard с малым бюджетом.

## После отправки

Review обновления обычно короче первой публикации, но сроки определяет Chrome
Web Store. Не меняйте ZIP во время review; новая загрузка запускает новую
проверку. После публикации проверьте установленную версию и основные сценарии.
