# Chrome Web Store submission copy

Values for Sensemark `1.4.2`.

## Listing

**Name:** Sensemark

**Summary:** Переводит выделенный текст на русский с контекстом, потоковым
выводом и управляемой карточкой.

**Category:** Productivity

**Language:** Русский

**Detailed description**

Sensemark переводит явно выделенный или введённый текст на русский, не привязываясь
к конкретным сайтам. Он работает со стандартным выделением, полями ввода,
открытым Shadow DOM и доступными вложенными frames.

Новая установка показывает небольшую кнопку рядом со стабильным выделением.
Также доступны автоматический режим, контекстное меню и Ctrl+Shift+Y /
Command+Shift+Y. На защищённой странице перевод открывается в side panel.

Обычный текст появляется потоково. Короткий неоднозначный фрагмент получает
ограниченный контекст ближайшего текстового блока; смешанный текст возвращается
структурированными секциями. Карточку можно перетаскивать, менять её размер и
масштаб, копировать результат и раскрывать оригинал.

Popup переводит по кнопке или Ctrl/Command+Enter; после paste перевод может
начаться автоматически. Обычный ввод сам запрос не запускает.

API‑ключ и настройки хранятся локально и закрыты от content script. В OpenAI
отправляется только выбранный/введённый текст и, для короткого фрагмента, до 800
кодовых точек ближайшего блока. URL, title, ссылки, изображения, произвольные
`data-*` и вся страница не отправляются. Нет сервера разработчика, рекламы или
аналитики.

Для работы нужен собственный OpenAI API‑ключ с API balance. ChatGPT Plus не
включает API usage. Независимый open-source проект, не связанный с OpenAI.

## Assets

- Icon: `store/assets/icon-128.png`
- Screenshots: `screenshot-1-overview.png`, `screenshot-2-streaming.png`,
  `screenshot-3-context.png`, `screenshot-4-sizing.png`
- Small tile: `store/assets/promo-small-440x280.png`
- Marquee: `store/assets/promo-marquee-1400x560.png`

## Links

- Homepage: https://github.com/StrangerOfDawah/sensemark
- Support: https://github.com/StrangerOfDawah/sensemark/issues
- Privacy: https://github.com/StrangerOfDawah/sensemark/blob/main/PRIVACY.md

## Privacy practices

**Single purpose:** перевод явно выделенного или введённого пользователем
текста на русский.

**Permissions**

- `contextMenus`: команда перевода выделенного текста.
- `storage`: local private settings и временный session cache/fallback.
- `scripting` + `activeTab`: поиск активного выделения во frames после явной
  горячей клавиши.
- `sidePanel`: fallback для страниц без content-script доступа.
- OpenAI host: HTTPS-запрос перевода.
- `<all_urls>` content script: карточка рядом с выделением на произвольной
  странице; URL и history не собираются.

**Remote code:** No. Весь JavaScript/CSS упакован. Provider output — только
текст и никогда не исполняется.

**Data disclosure**

- Website content: selected/entered text and bounded nearby context.
- Authentication: user's OpenAI API key, local and sent only to OpenAI.
- Purpose: app functionality only.

## Reviewer instructions

1. Установить расширение и открыть options.
2. Ввести тестовый OpenAI API‑ключ, подтвердить disclosure и нажать
   «Проверить подключение».
3. На обычной HTTPS-странице выделить иностранное предложение и нажать
   появившуюся кнопку.
4. Проверить plain stream, короткое неоднозначное слово, mixed-script фрагмент,
   drag/resize/double-click reset и copy.
5. Проверить context menu, Ctrl/Command+Shift+Y, popup button, paste auto и side
   panel на защищённой странице.
6. Переключить automatic/manual и убедиться, что Ctrl/Command+C не запускает
   перевод.

Reviewer key хранится только в приватном поле Dashboard и не коммитится.
