# Принятые решения

## D-001 — Никаких правил для конкретных сайтов

Нельзя ветвиться по hostname, URL, title, CSS-классу, точному селектору, имени
шрифта или нестандартному `data-*`. Надёжность достигается стандартными
Selection/Range/accessibility API, оценкой кандидатов и строгими лимитами.

## D-002 — Native first, fallback bounded

Обычное выделение и формы должны завершаться за fast path. DOM-wide traversal
запрещён. Fallback касается только текущего Range, максимум 2000 узлов, 25 мс,
5000 кодовых точек и стандартных семантических полей. Visibility кэшируется,
а кандидат обязан пройти confidence threshold.

## D-003 — Один translation request, без repair

`text` использует plain-text stream. `contextual` и `multilingual` используют
strict Structured Outputs. Неожиданный формат становится явной ошибкой; второй
запрос для ремонта запрещён. Один retry допустим только до первой дельты для
сетевой ошибки, 408/409, короткого 429 `Retry-After` или 5xx.

## D-004 — Provider boundary заранее, второй provider потом

Registry принимает provider с `id`, `displayName`, `capabilities`,
`validateConfiguration`, `translate`, `normalizeError` и
`settingsDescriptor`. OpenAI —
единственная активная реализация и единственный host permission. Исследование
Gemini подтвердило совместимость общего контракта, но не является основанием
добавлять лишний provider или permission сейчас.

## D-005 — Private/public settings

API‑ключ никогда не доступен content script. Trusted extension pages работают с
private settings через service worker; страница получает только selection/ui.
Миграция schema v3 сохраняет старый ключ, модель, поведение и размеры, но
сбрасывает устаревшее privacy consent после изменения disclosure.

## D-006 — Session cache вместо service-worker memory

MV3 может остановить worker в любой момент. Cache хранится в
`chrome.storage.session`, ключ хэшируется SHA‑256, применяется TTL/LRU и лимит
размера. Cache identity включает prompt/protocol/semantic versions; обычный hit
не перезаписывает весь session object немедленно. Cache не является
пользовательской историей переводов.

## D-007 — Intent — отдельная state machine

`pointerdown/up`, keyboard selection и `selectionchange` — сигналы, а не
немедленные команды. Выделение перечитывается после 600 мс и сверяется по
text/source/rect/frame key; duplicate cooldown равен 1500 мс. Copy shortcut и
событие `copy` отменяют только pending intent и не закрывают карточку. Новая
установка использует режим `button`.

## D-008 — Карточка управляется пользователем

Placement использует flip/shift/clamp. Header перетаскивается Pointer Events с
pointer capture и rAF; double click возвращает к anchor. Положение после drag не
переопределяется stream-дельтами. Размер и масштаб сохраняются, абсолютная
координата — нет.

## D-009 — Защищённые страницы не считаются ошибкой пользователя

Если content script недоступен, context-menu text временно сохраняется в
tab/frame/request-specific session entry и открывается tab-specific side panel.
Русский и password-source не открывают fallback. Popup остаётся универсальным
ручным fallback.

## D-011 — Русский пропускается только при высокой уверенности

Письменность не равна языку. Запрос блокируется только при reliable `ru` от
Chrome без отрицательного языкового сигнала. При сомнении перевод выполняется;
отдельный LLM-запрос для language detection запрещён.

## D-012 — Завершённость stream является частью протокола

Непустого текста недостаточно. Успех требует `finish_reason: stop` и `[DONE]`.
Length, content filter, прерванный stream и неизвестная причина завершения
остаются разными ошибками и не запускают repair/retry после первой дельты.

То же правило применяется к contextual и multilingual Structured Outputs:
JSON результата разбирается только после `finish_reason: stop`.

## D-013 — Capability validation не равна существованию модели

`GET /v1/models/{model}` подтверждает credentials и видимость модели, но не
Chat Completions, streaming или strict Structured Outputs. Sensemark показывает
`verified` только для provider allowlist; существующая custom model остаётся
`unverified` до реального перевода.

## D-014 — Side-panel handoff одноразовый, но не называется атомарным

Session entry удаляется при claim, а in-memory guard не даёт двум одновременным
consumer начать один перевод. После перезапуска worker durable remove остаётся
источником истины.

## D-017 — Доставка в side panel не зависит от порядка асинхронных операций

Идентичность запроса не передаётся в URL панели: `setOptions()` всегда
назначает статический путь `sidepanel/sidepanel.html`. Панель не может прочитать
свой `tabId`, поэтому она сообщает своё окно (`chrome.windows.getCurrent()`), а
worker разрешает scope как sender tab → активная вкладка окна → окно.

Intent регистрируется синхронно до первого `await`, поэтому панель, готовая
раньше записи в storage, получает `waiting`, а не пустой результат. Доставка
идёт через push от worker и ограниченные повторы (2 с, шаг 150 мс). Unbounded
polling запрещён. Потерянный handoff обязан завершиться видимой ошибкой, а не
пустой панелью.

Политика повторного запроса в одной вкладке — newest-wins: новая запись
вытесняет предыдущую неполученную для той же вкладки.

## D-018 — User activation важнее лишней проверки русского языка

`sidePanel.open()` должен вызываться на стеке пользовательского жеста. Любой
`await` перед ним рискует потерять transient user activation, поэтому
асинхронный `chrome.i18n.detectLanguage()` больше не выполняется до открытия.

Выбран вариант A: синхронный консервативный вердикт. Панель не открывается
только при уверенно русском тексте — есть русская исключительная буква
(`ы`, `э`, `ё`; `ъ` исключён, так как активно используется в болгарском) либо
два различных русских служебных слова при отсутствии non-Russian сигнала. Всё
остальное открывает панель.

Приоритет: не потерять валидный нерусский запрос важнее, чем избежать лишней
панели для русского текста. Полная асинхронная policy сохраняется в
translation service, поэтому уверенно русский текст показывает
«Текст уже на русском.» без обращения к провайдеру.

## D-010 — Нулевые runtime-зависимости

Изучены eventsource-parser, fetch-event-source, Floating UI и interact.js.
Нужные подмножества малы, поэтому локальные parser/placement/drag helpers
уменьшают supply-chain поверхность. Подробности и лицензии:
[RESEARCH_NOTES.md](../RESEARCH_NOTES.md).

Playwright остаётся только pinned development dependency для повторяемого
browser smoke; в production ZIP и runtime dependency graph он не входит.

## D-015 — Coverage всегда публикуется вместе со scope

`test:coverage` измеряет 16 перечисленных critical modules, а не весь runtime.
Перед процентами команда печатает include/exclude список, физические line counts
и долю runtime source. Composition roots проверяются отдельно static/browser
tests и не маскируются как покрытые строки.

## D-016 — Production artifact детерминирован

Packager копирует только allowlisted runtime paths во временный staging,
нормализует permissions и timestamp, сортирует все file entries и вызывает
Info-ZIP с отключёнными extra fields. Поддерживаемая reproducible environment —
Ubuntu 24.04, Node 24 и Info-ZIP 3.0; macOS используется как дополнительная,
но не гарантированная среда.
