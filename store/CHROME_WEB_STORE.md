# Chrome Web Store submission copy

Use these values in the Chrome Web Store Developer Dashboard for version `1.2.0`.

## Store listing

**Name**

Быстрый перевод на русский

**Summary**

Переводит выделенный текст на русский с учётом контекста и показывает результат сразу по мере генерации.

**Category**

Productivity

**Language**

Русский

**Assets**

- Store icon: `store/assets/icon-128.png`
- Screenshots, in order: `screenshot-1-overview.png`, `screenshot-2-streaming.png`, `screenshot-3-context.png`, `screenshot-4-sizing.png`
- Small promo tile: `store/assets/promo-small-440x280.png`
- Marquee promo tile (optional): `store/assets/promo-marquee-1400x560.png`

**Detailed description**

Быстрый перевод на русский помогает читать английские статьи, документацию и рабочие материалы, не покидая текущую страницу.

Выделите текст и нажмите ⌘⇧Y на Mac или Ctrl+Shift+Y на Windows. Перевод появится рядом с выделением и будет выводиться сразу по мере генерации. Также можно использовать контекстное меню или включить автоматический перевод при выделении.

Если выделено одно слово или короткий фрагмент, расширение учитывает окружающее предложение, чтобы выбрать подходящее значение, и показывает другие распространённые варианты.

Возможности:

- потоковый вывод без ожидания полного ответа;
- перевод коротких фрагментов с учётом контекста;
- светлая и тёмная тема;
- изменение масштаба и размера карточки;
- копирование перевода и просмотр оригинала;
- локальный кэш повторных переводов;
- отсутствие рекламы и аналитики.

Для работы нужен собственный API-ключ OpenAI с доступным балансом. Подписка ChatGPT Plus не включает использование API. Стоимость запросов определяется действующими тарифами OpenAI.

Для перевода выделенный текст и, для короткого фрагмента, окружающее предложение отправляются напрямую из браузера в OpenAI API. API-ключ и настройки хранятся локально в Chrome. У расширения нет сервера разработчика; разработчик не получает и не хранит тексты или ключи пользователей.

Независимый open-source проект. Не связан с OpenAI и не одобрен ею.

## Links

- Homepage: https://github.com/StrangerOfDawah/quick-translate
- Support: https://github.com/StrangerOfDawah/quick-translate/issues
- Privacy policy: https://github.com/StrangerOfDawah/quick-translate/blob/main/PRIVACY.md

## Privacy practices

**Single purpose**

Перевод явно выделенного пользователем текста на русский язык непосредственно на текущей веб-странице.

**Permission justifications**

- `contextMenus`: adds the “Перевести на русский” command to the context menu for selected text.
- `storage`: stores the user's OpenAI API key and extension preferences locally in Chrome.
- `scripting`: injects the packaged content script into an already-open tab when the user explicitly invokes translation after installing or reloading the extension.
- `activeTab`: grants temporary access to the active tab after an explicit user action so the extension can read the current selection and show the translation card.
- `https://api.openai.com/*`: sends the selected text to the OpenAI API and receives the generated translation over HTTPS.
- `<all_urls>` content-script match: enables translation of user selections on arbitrary web pages and supports the optional automatic-translation mode. The extension does not collect URLs or browsing history.

**Remote code**

Select **No, I am not using remote code**. All executable JavaScript and CSS are packaged inside the extension. OpenAI responses are treated only as translation text and are never executed as code.

**Data types to disclose**

- Website content: the explicitly selected text and, for short selections, its surrounding sentence.
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

The extension requires an OpenAI API key with available API balance.

1. Install the extension; the settings page opens automatically.
2. Paste the reviewer API key into “API-ключ OpenAI”.
3. Click “Проверить ключ” and confirm that “Работает” appears.
4. Open any regular HTTPS page, select an English sentence, and press Ctrl+Shift+Y (Windows/Linux) or Command+Shift+Y (macOS).
5. Confirm that the Russian translation streams into a card next to the selection.
6. Select a single ambiguous word inside a sentence and repeat; confirm that the context-specific translation and alternative meanings are displayed.

Do not commit a reviewer key to this repository. If reviewer credentials are supplied, create a dedicated OpenAI project/key with a small budget and place the credential only in the Dashboard's test-instructions field.
