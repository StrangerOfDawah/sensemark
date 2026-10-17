# Chrome Web Store submission copy

Use these values in the Chrome Web Store Developer Dashboard for version `1.5.0`.

## Store listing

**Name**

Sensemark

**Summary**

Переводит выделенный текст на русский с учётом контекста и показывает результат сразу по мере генерации.

**Category**

Productivity

**Language**

Русский

**Assets**

- Store icon: `store/assets/icon-128.png`
- Screenshots, in order: `screenshot-1-overview.png`, `screenshot-2-streaming.png`, `screenshot-3-context.png`, `screenshot-4-long-text.png`, `screenshot-5-settings.png`
- Small promo tile: `store/assets/promo-small-440x280.png`
- Marquee promo tile (optional): `store/assets/promo-marquee-1400x560.png`

**Detailed description**

Sensemark помогает читать статьи, документацию и рабочие материалы на разных языках, не покидая текущую страницу. Исходный язык определяется автоматически, а результат всегда выводится на русском.

Выделите текст и нажмите ⌘⇧Y на Mac или Ctrl+Shift+Y на Windows. Перевод появится рядом с выделением и будет выводиться сразу по мере генерации. Автоперевод включён сразу: достаточно просто выделить текст мышью. Его можно поставить на паузу или выключить кнопкой в карточке. Также есть пункт в контекстном меню.

Если сайт не позволяет корректно выделить текст, нажмите на иконку Sensemark и вставьте его в компактное окно ручного перевода. Перевод начнётся автоматически, без дополнительной кнопки. Окно использует тот же потоковый режим, многоязычные секции, объяснение неизвестных терминов и отмену незавершённого запроса.

Если выделено одно слово или короткий фрагмент, расширение учитывает окружающее предложение, чтобы выбрать подходящее значение, и показывает другие распространённые варианты.

Если фрагмент не является обычным словом — например, это название, имя, никнейм, бренд или опечатка — расширение не придумывает перевод, а переключает карточку в отдельный режим «Объяснение» с категорией и кратким описанием по написанию и контексту.

Выделение только на русском игнорируется без запроса к API. Смешанный текст разбивается на понятные секции: русские предложения сохраняются, а английские, арабские и другие переводятся с подписью исходного языка.

Перед запросом расширение локально удаляет скрытые дубликаты, кнопки и служебные подписи страницы. Изображения без текстового слоя не отправляются в API, поэтому они не расходуют токены и не превращаются в неточный OCR.

Возможности:

- потоковый вывод без ожидания полного ответа;
- компактный ручной перевод по клику на иконку расширения;
- перевод коротких фрагментов с учётом контекста;
- автоматическое определение исходного языка;
- отсутствие лишних запросов для русского текста;
- локальная очистка DOM-шума до обращения к API;
- блокировка затратных запросов для текста, существующего только как изображение;
- секции с подписями языков для смешанных выделений;
- объяснение неизвестных слов, имён и названий без выдуманного перевода;
- карточка в цвет страницы (или светлая / тёмная тема на выбор) и три шрифта перевода;
- длинный текст переводится заметкой на полях справа, не закрывая страницу;
- изменение масштаба и размера карточки;
- копирование перевода;
- локальный кэш повторных переводов;
- отсутствие рекламы и аналитики.

Два режима на выбор. По умолчанию — бесплатный: встроенный переводчик Chrome переводит прямо на компьютере, без ключа и без оплаты, текст никуда не отправляется (Chrome 138 и новее). Режим OpenAI умнее — выбирает значение слова по контексту и объясняет имена и названия; для него нужен собственный API-ключ OpenAI (подписка ChatGPT Plus не включает API), при ежедневном чтении это около $1 в год.

В режиме OpenAI выделенный или вручную введённый текст и, для короткого выделения, окружающее предложение отправляются напрямую из браузера в OpenAI API. API-ключ и настройки хранятся локально в Chrome. У расширения нет сервера разработчика; разработчик не получает и не хранит тексты или ключи пользователей.

Независимый open-source проект. Не связан с OpenAI и не одобрен ею.

## Links

- Homepage: https://github.com/StrangerOfDawah/sensemark
- Support: https://github.com/StrangerOfDawah/sensemark/issues
- Privacy policy: https://github.com/StrangerOfDawah/sensemark/blob/main/PRIVACY.md

## Privacy practices

**Single purpose**

Перевод явно выделенного или вручную введённого пользователем текста на русский язык.

**Permission justifications**

- `contextMenus`: adds the “Перевести на русский” command to the context menu for selected text.
- `storage`: stores the translation mode, the user's optional OpenAI API key and extension preferences locally in Chrome.
- `scripting`: injects the packaged content script into an already-open tab when the user explicitly invokes translation after installing or reloading the extension.
- `activeTab`: grants temporary access to the active tab after an explicit user action so the extension can read the current selection and show the translation card.
- `https://api.openai.com/*`: sends the selected text to the OpenAI API and receives the generated translation over HTTPS.
- `<all_urls>` content-script match: enables translation of user selections on arbitrary web pages and supports the automatic-translation mode (on by default, can be paused or turned off by the user). The extension does not collect URLs or browsing history.

**Remote code**

Select **No, I am not using remote code**. All executable JavaScript and CSS are packaged inside the extension. OpenAI responses are treated only as translation text and are never executed as code.

**Data types to disclose**

- Website content: the explicitly selected or manually entered text and, for short selections, its surrounding sentence.
- Authentication information: the user's OpenAI API key, stored locally and sent only to OpenAI for API authentication.

**Purpose of data use**

- App functionality only.

**Certifications**

- Do not sell or transfer user data except to OpenAI as necessary to provide translation.
- Do not use or transfer user data for purposes unrelated to the extension's single purpose.
- Do not use or transfer user data for creditworthiness or lending.
- Developer does not allow humans to read user data.

## Distribution

- Visibility: Public
- Regions: All regions supported by Chrome Web Store
- The extension does not process payments. Users pay OpenAI directly for their own API usage.

## Reviewer test instructions

The default free mode needs no key: it uses Chrome's built-in Translator API (Chrome 138+). The optional OpenAI mode requires an OpenAI API key with available API balance.

Free mode:

1. Install the extension; the settings page opens automatically with “Встроенный переводчик Chrome — Бесплатно” selected.
2. Open any regular HTTPS page, select an English sentence and press Ctrl+Shift+Y (Windows/Linux) or Command+Shift+Y (macOS).
3. The first time, Chrome downloads a language pack: the card offers “Скачать”, then shows the download progress. Afterwards the Russian translation appears in a card next to the selection, in the page's colours.
4. Select several paragraphs; confirm that the translation appears as a note in the right margin (or as a panel at the window edge) and that the selected text stays visible.

OpenAI mode:

1. Open the settings page and choose “OpenAI”.
2. Review the data disclosure and select the consent checkbox.
3. Paste the reviewer API key into “API-ключ OpenAI”.
4. Click “Проверить ключ” and confirm that “Работает” appears.
5. Open any regular HTTPS page, select a sentence in English, Spanish, Arabic, or another language, and press Ctrl+Shift+Y (Windows/Linux) or Command+Shift+Y (macOS).
6. Confirm that the Russian translation streams into a card next to the selection.
7. Select a single ambiguous word inside a sentence and repeat; confirm that the context-specific translation and alternative meanings are displayed.
8. Select an invented name such as “Sensemark”; confirm that the card says it is not a common word and offers a short possible explanation instead of inventing a translation.
9. Click the Sensemark toolbar icon, paste foreign text into the popup, and confirm that translation starts automatically, streams into the result area, and can be copied.

Do not commit a reviewer key to this repository. If reviewer credentials are supplied, create a dedicated OpenAI project/key with a small budget and place the credential only in the Dashboard's test-instructions field.
