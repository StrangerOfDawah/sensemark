# История изменений

Формат основан на [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/),
версии следуют [Semantic Versioning](https://semver.org/lang/ru/).

## [Unreleased]

## [1.4.2] — 2026-07-31

### Исправлено

- GitHub Actions больше не проверяет удалённые v1.3 root-level файлы и запускает
  clean install, unit/integration, targeted coverage, browser smoke,
  deterministic packaging и artifact validation для актуальной архитектуры.
- Production и source ZIP нормализуют порядок, timestamp, permissions и extra
  fields; две независимые clean build копии обязаны иметь одинаковые байты и
  SHA-256.
- Coverage переименован в targeted critical-module coverage и публикует точный
  include/exclude список, физические line counts и долю runtime scope.
- Multilingual prompt больше не упоминает contextual-only поля, отсутствующие в
  strict JSON Schema.
- Добавлены persistent-Chromium smoke tests, ручной Chrome/PDF release gate,
  внешний checksum handoff и end-to-end artifact verifier.
- Устранена гонка в side-panel handoff. Раньше панель делала единственный
  запрос pending-состояния по идентификатору из динамического query string и не
  повторяла попытку: если панель загружалась раньше, чем завершался
  `state.store()`, она получала `null`, перевод не начинался, а запись
  оставалась в session storage — при этом контроллер сообщал `status: "opened"`.
  Если `open()` опережал `setOptions()`, панель открывалась по пути по умолчанию
  и вообще не могла определить свой запрос.
- `sidePanel.setOptions()` всегда назначает статический путь
  `sidepanel/sidepanel.html`; идентичность запроса больше не передаётся в URL.
- Панель получает запрос через долгоживущий порт `sensemark.sidepanel`:
  синхронно зарегистрированный intent, ready/claim handshake, push от worker и
  ограниченные повторы (2 с, шаг 150 мс). Порядок завершения `store()`,
  `setOptions()`, `open()` и инициализации панели больше не влияет на доставку.
- Claim одноразовый и ограничен областью видимости (sender tab → активная
  вкладка окна панели → окно), поэтому две вкладки и два окна изолированы,
  перезагрузка панели не переводит запрос повторно, а перезапуск service worker
  безопасен.
- Повторный запрос в одной вкладке вытесняет предыдущий неполученный
  (newest-wins); устаревший результат не может заменить новый.
- Потерянный handoff завершается видимой типизированной ошибкой
  «Не удалось получить выделенный текст. Попробуйте ещё раз.» вместо пустой
  панели.
- Russian preflight стал синхронным и консервативным: `sidePanel.open()`
  вызывается без предшествующего `await` для любого письма, включая кириллицу.
  Раньше `await chrome.i18n.detectLanguage()` перед открытием мог терять
  transient user activation для украинского, болгарского, сербского и
  казахского текста. Полная асинхронная политика по-прежнему применяется в
  translation service, поэтому уверенно русский текст открывает панель с
  сообщением «Текст уже на русском.» без обращения к провайдеру.
- Устранена потеря обоих запросов при двух одновременных вызовах в одной
  вкладке. `store()` с последующим независимым `supersede()` допускал
  чередование store(A), store(B), A-удаляет-B, B-удаляет-A, после которого
  session storage оставалось пустым. Замена выполняется одной атомарной
  операцией `state.replace()` под per-tab блокировкой, а порядок определяется
  монотонным `sequence`, назначаемым синхронно в момент действия пользователя,
  а не порядком разрешения промисов.
- Убрано небезопасное правило синхронного вердикта по одному символу. Буквы
  `ы`, `э` и `ё` встречаются в казахском, белорусском и киргизском, из-за чего
  «Сынып», «Добры дзень», «Кыргыз тили», «Бул жакшы», «Энэ текст» и
  «Мына сынып» ошибочно определялись как русский текст и их запросы терялись.
  Уверенный вердикт теперь требует длины, количества слов и нескольких
  различных русских служебных слов одновременно; короткая кириллица всегда
  переводится.
- `setOptions()` убран с пути пользовательского действия. Модель панели —
  tab-specific; вкладки настраиваются на lifecycle-событиях, а в обработчике
  context menu остаётся единственный вызов `sidePanel.open()`. Сбой
  конфигурации больше не сообщается как `open-failed` и не удаляет валидный
  pending-запрос, а отказ `open()` при уже открытой панели сохраняет запрос
  claimable.
- Идентичность панели больше не определяется активной вкладкой. Используется
  детерминированная лестница: `port.sender.tab` → стабильный per-tab токен в
  URL панели → binding окно→вкладка, сохранённый в `chrome.storage.session` →
  активная вкладка только при наличии у неё pending-запроса. Claim только по
  окну запрещён, поэтому переключение вкладок во время handoff не
  перенаправляет запрос, а две панели в одном окне изолированы.
- Закрытие вкладки-источника удаляет pending-запрос и binding.
- Разработка и CI закреплены на Node.js 24 LTS.

### Известные ограничения

- Реальное PDF/user-activation поведение остаётся блокирующим ручным Chrome
  gate. Unit-тесты проверяют только порядок вызовов и не являются
  доказательством сохранения user activation в настоящем Chrome.

## [1.4.1] — 2026-07-31

### Исправлено

- Structured contextual и multilingual ответы теперь принимаются только при
  `finish_reason: "stop"`; length, content filter, null, пропуск и неизвестные
  причины завершаются типизированной ошибкой до разбора JSON результата.
- Карточка использует throttled `ResizeObserver`: рост результата вызывает один
  viewport-safe positioning pass на animation frame, сохраняя ручную позицию.
- Side-panel fallback выполняет общую language policy до открытия, очищает
  failed-open state и защищает одноразовый consume от конкурентной гонки.
- Generic context extraction поднимается до ближайшего полезного semantic/block
  контейнера для вложенных `div`/`span`, но отсекает большие application roots.
- Проверка OpenAI различает verified и unverified модели и больше не заявляет
  полную совместимость только по `GET /v1/models/{model}`.
- Selection candidates дедуплицируются до scoring с сохранением наиболее
  доверенного источника.

- Полностью запрещено чтение password-полей во всех selection/shortcut/message
  путях.
- Кириллица больше не считается автоматически русским языком; добавлена
  browser-assisted confidence policy для украинского, болгарского, сербского,
  казахского и технического русского текста.
- Исправлены Japanese/Korean script groups, границы contextual mode
  (12 слов/160 code points) и contextual reference/category contract.
- SSE требует корректного `finish_reason` и `[DONE]`; отдельно обрабатываются
  прерывание, truncation и content filter.
- API-key/model validation отделена от production translation/cache.
- Добавлены stable selection snapshot, 1500 мс dedupe, bounded context/fallback,
  confidence threshold и StaticRange conversion.
- Copy больше не закрывает карточку; добавлены loading threshold, Escape,
  viewport size clamp, полный UI scale и accessibility semantics.
- Side-panel handoff изолирован по tab/frame/request и очищается после consume,
  ошибки открытия, TTL или закрытия вкладки; минимум Chrome повышен до 119.
- Error contract, cache identity, Unicode normalization, schema v3 и privacy
  consent v2 приведены к техническому ревью.

## [1.4.0] — 2026-07-30

### Добавлено

- Универсальный native-first selection pipeline для форм, Selection/Range,
  открытого Shadow DOM и вложенных frames.
- Режим кнопки по умолчанию, automatic/manual, copy suppression и задержка
  стабильности 600 мс.
- Перетаскивание карточки Pointer Events, double-click reset и viewport
  flip/shift/clamp.
- Side panel для защищённых страниц.
- Provider registry, strict Structured Outputs, нормализованные ошибки и
  session TTL/LRU cache с SHA‑256.
- Версионированная schema настроек v2 и идемпотентная миграция.
- Аудит и исследование в `REFACTOR_NOTES.md` и `RESEARCH_NOTES.md`.

### Изменено

- Полностью удалены правила по доменам, URL, селекторам, атрибутам и шрифтам.
- Plain-text перевод передаётся реальными дельтами вместо накопительной строки.
- API‑ключ закрыт от content script через private/public settings boundary.
- Контекстное меню использует `selectionText`; popup требует явное действие для
  обычного ввода и автоматически стартует только после paste.
- Документация, privacy disclosure, store copy и release checklist описывают
  универсальную архитектуру.

### Удалено

- Marker protocol и второй repair-запрос.
- In-memory service-worker cache и корневые монолитные runtime-файлы.

## [1.3.0] — 2026-07-23

### Добавлено

- Автоопределение исходного языка, mixed-script результаты и ручной popup.
- CI, coverage-пороги, релизная документация и материалы магазина.

### Изменено

- Русский текст завершается локально, карточка показывается после видимого
  результата, а UI поддерживает масштабирование и размер.

## [1.2.0] — 2026-07-22

### Добавлено

- Название Sensemark, материалы Chrome Web Store и политика
  конфиденциальности.
- Явное согласие перед отправкой текста в OpenAI и воспроизводимый ZIP.

## [1.1.0] — 2026-07-21

### Добавлено

- Первый публичный перевод выделенного текста на русский.
- Потоковый вывод, контекст короткого фрагмента, кэш и отмена.

[Unreleased]: https://github.com/StrangerOfDawah/sensemark/compare/v1.4.2...HEAD
[1.4.2]: https://github.com/StrangerOfDawah/sensemark/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/StrangerOfDawah/sensemark/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/StrangerOfDawah/sensemark/releases/tag/v1.1.0
