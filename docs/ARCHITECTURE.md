# Архитектура Sensemark

Sensemark 1.4 — универсальное Manifest V3-расширение без доменных правил.
Runtime написан на обычном JavaScript без сборщика и runtime-зависимостей.
Небольшие UMD-модули одновременно загружаются Chrome и тестируются через
CommonJS.

## Поток данных

1. `content/selection/selection-reader.js` сначала читает `input`/`textarea` или
   нативный `Selection`.
2. Для открытого Shadow DOM используются `getComposedRanges()`. Только если
   нативная строка пуста или заполнена Private Use Area-глифами, reader строит
   кандидаты из текущего `Range`, `cloneContents()`, стандартных
   accessibility-полей и ограниченного обхода до 2000 узлов, 25 мс и 5000
   кодовых точек.
3. `candidate-scorer.js` нормализует и дедуплицирует кандидаты, сохраняя источник
   с наибольшим trust, затем выбирает читаемый кандидат с минимальным confidence
   без знания сайта, URL, селекторов или шрифтов. `StaticRange` предварительно
   преобразуется в обычный `Range`.
4. `context-extractor.js` проходит вверх не более восьми предков, предпочитает
   semantic block, затем ближайший block-level контейнер и bounded inline
   fallback. Контекст ограничен 800, контейнер — 2000 кодовыми точками; `body`,
   `main` и page-scale application roots не читаются.
5. Асинхронная языковая policy объединяет `chrome.i18n.detectLanguage`,
   Unicode-группы письменностей и технические токены. `mode-utils.js` локально
   выбирает `text`, `contextual` или `multilingual`.
6. `translation-client.js` открывает именованный port. Service worker отменяет
   предыдущий запрос того же surface/tab/frame и возвращает только дельты.
7. `translation-service.js` проверяет согласие и provider configuration, ищет SHA‑256 cache key в
   `chrome.storage.session`, затем вызывает активный provider.
8. `openai-provider.js` отдаёт обычный текст как SSE stream, а контекстный и
   многоязычный результат — один strict JSON Schema response. Structured result
   разбирается только после `finish_reason: "stop"`. Repair-запросов нет.
9. `translation-card.js` показывает карточку после первой видимой дельты,
   готового structured result или 150 мс ожидания. Throttled `ResizeObserver`
   повторно clamping/anchoring карточку после роста содержимого. Общий renderer
   записывает вывод модели только через `textContent`.

## Владельцы ответственности

- `shared/` — контракты, полный error model, общий result renderer,
  текст/языки, режимы, schema v3 и миграция.
- `background/service-worker.js` — только Chrome wiring: listeners, context
  menu, commands, ports, trusted settings и side-panel fallback.
- `background/providers/` — provider-specific HTTP, prompt, SSE/JSON parsing и
  error normalization.
- `background/request-client.js` — таймаут ответа и единственный допустимый
  pre-stream retry.
- `background/translation-cache.js` — TTL/LRU cache в session storage:
  максимум 200 записей, 2 MiB и 6 часов.
- `background/side-panel-state.js` — pending-записи handoff в session storage:
  scope, TTL, одноразовый claim и атомарная newest-wins замена под per-tab
  блокировкой с монотонным `sequence`.
- `background/side-panel-handoff.js` — worker-половина протокола: синхронный
  intent, лестница идентичности вкладки, ready/claim handshake и push
  доступности по порту `sensemark.sidepanel`.
- `background/side-panel-configurator.js` — tab-specific настройка панели на
  lifecycle-событиях, вне пути пользовательского действия.
- `content/selection/` — чтение выделения, контекст и intent state machine.
- `content/ui/` — Shadow DOM-карточка, placement, drag и resize.
- `extension/side-panel-handoff-client.js` — половина панели: разрешение окна,
  ограниченные повторы и видимая ошибка при потерянном handoff.
- `extension/` — общие контроллеры popup/side panel и доверенный клиент
  настроек.
- `popup/`, `options/`, `sidepanel/` — тонкие страницы интерфейса.

## Настройки и граница доверия

`sensemarkSettings` имеет `schemaVersion: 3`, а privacy consent — версию 2. В private-части находятся provider
ID, API‑ключ, модель, согласие и все настройки. Service worker вызывает
`chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"})`.

Content script не читает `chrome.storage.local`: через сообщения он получает
только `selection` и `ui`. Старые плоские поля мигрируют один раз после записи
нового объекта; миграция идемпотентна.

## Точки входа

- Выделение: `automatic`, `button` (default для новой установки) или `manual`.
- Контекстное меню использует `info.selectionText` и `frameId`.
- Горячая клавиша проверяет все доступные frames через `scripting`.
- Popup переводит по кнопке или `Ctrl/⌘+Enter`; paste может стартовать
  автоматически, обычный ввод — нет.
- На защищённой странице trusted language preflight сначала локально пропускает
  уверенный русский текст. Затем tab/frame/request-specific запись кладётся в
  `storage.session`, настраивается tab-specific path и сразу открывается side
  panel. In-memory consume guard плюс remove-on-read дают одноразовый handoff;
  failed open, TTL и закрытие вкладки очищают запись.

## Отмена и ошибки

Новый запрос в том же scope отменяет старый через `AbortController`. Transport
имеет таймаут первого ответа, stream — idle timeout. Invalid key, permission,
model, consent, quota, rate-limit, network, три timeout-фазы, interrupted,
truncated и filtered output нормализованы в полный контракт с безопасным
сообщением и явным действием.
