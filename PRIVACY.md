# Privacy Policy / Политика конфиденциальности

**Effective date / Дата вступления в силу:** July 22, 2026 / 22 июля 2026 г.

This policy applies to the **Quick Translate to Russian** Chrome extension (the “Extension”). The Extension is an independent open-source project and is not affiliated with or endorsed by OpenAI.

Настоящая политика применяется к расширению Chrome **«Быстрый перевод на русский»** («Расширение»). Расширение является независимым проектом с открытым исходным кодом, не связано с OpenAI и не одобрено ею.

## Data the Extension handles / Какие данные обрабатываются

The Extension handles only the data needed to translate text:

- the text the user explicitly selects for translation;
- for a short selection, the surrounding sentence used to determine the correct meaning;
- the user's OpenAI API key;
- local preferences such as the selected model, automatic translation setting, and card size.

Расширение обрабатывает только данные, необходимые для перевода:

- текст, который пользователь явно выделил для перевода;
- для короткого фрагмента — окружающее предложение, необходимое для выбора правильного значения;
- API-ключ OpenAI пользователя;
- локальные настройки: выбранная модель, автоматический перевод и размер карточки.

## How the data is used and shared / Как используются и передаются данные

Selected text and optional surrounding context are sent directly from the user's browser to the OpenAI API at `https://api.openai.com` solely to generate the requested translation. The API key is sent to OpenAI in the authorization header solely to authenticate that request.

Выделенный текст и, при необходимости, окружающий контекст отправляются напрямую из браузера пользователя в OpenAI API по адресу `https://api.openai.com` исключительно для создания запрошенного перевода. API-ключ передаётся OpenAI в заголовке авторизации исключительно для аутентификации запроса.

The developer does not receive this data, operate an intermediary server, sell data, use it for advertising, or share it with any other party. OpenAI processes API requests according to its [API data controls](https://developers.openai.com/api/docs/guides/your-data) and [privacy policy](https://openai.com/policies/privacy-policy/).

Разработчик не получает эти данные, не использует промежуточный сервер, не продаёт данные, не применяет их для рекламы и не передаёт другим сторонам. OpenAI обрабатывает API-запросы в соответствии со своими [правилами обработки данных API](https://developers.openai.com/api/docs/guides/your-data) и [политикой конфиденциальности](https://openai.com/policies/privacy-policy/).

## Storage and retention / Хранение и срок хранения

The API key and preferences are stored locally in `chrome.storage.local` on the user's device. Translation results may be kept temporarily in the extension service worker's in-memory cache for faster repeated translations. This cache is not persistent and is discarded when Chrome stops the service worker.

API-ключ и настройки хранятся локально на устройстве пользователя в `chrome.storage.local`. Результаты перевода могут временно находиться в оперативном кэше service worker для ускорения повторных переводов. Этот кэш не является постоянным и удаляется при остановке service worker браузером.

The Extension does not maintain translation history, analytics, tracking identifiers, or developer-operated logs. OpenAI's own retention practices are described in the policies linked above.

Расширение не ведёт историю переводов, не использует аналитику, идентификаторы отслеживания или журналы на сервере разработчика. Правила хранения данных OpenAI приведены по ссылкам выше.

## User control / Управление данными

Users can remove the stored API key by clearing it in the Extension settings. Uninstalling the Extension removes its locally stored settings through Chrome. Users should not translate secrets or content they are not authorized to send to OpenAI.

Пользователь может удалить сохранённый API-ключ, очистив поле в настройках Расширения. При удалении Расширения Chrome удаляет его локальные настройки. Не следует переводить секретные данные или материалы, которые пользователь не имеет права отправлять в OpenAI.

## Chrome Web Store Limited Use

The Extension's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

Использование информации Расширением соответствует [политике пользовательских данных Chrome Web Store](https://developer.chrome.com/docs/webstore/program-policies/policies), включая требования Limited Use.

## Changes and contact / Изменения и связь

Material changes will be published in this file with an updated effective date. For privacy questions, [open an issue in the public repository](https://github.com/StrangerOfDawah/quick-translate/issues).

Существенные изменения будут опубликованы в этом файле с новой датой вступления в силу. По вопросам конфиденциальности [создайте issue в публичном репозитории](https://github.com/StrangerOfDawah/quick-translate/issues).
