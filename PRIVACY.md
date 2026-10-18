# Sensemark Privacy Policy

**Effective date:** October 18, 2026

This policy applies to the **Sensemark** Chrome extension (the “Extension”). The Extension is an independent open-source project and is not affiliated with or endorsed by OpenAI, DeepSeek or Yandex.

## Translation modes

The Extension works in one of four modes chosen by the user in settings:

- **Chrome's built-in translator** (the default). Translation runs on the user's device using Chrome. Selected or entered text **is not sent anywhere** — not to the developer, not to any translation service, not to any other party. For a new language Chrome downloads a language pack once from its own servers; the user's text is not transmitted.
- **OpenAI**, **DeepSeek** or **YandexGPT** (the "translation service"). Text is sent to the service the user chose, as described below. Each of these modes is enabled only explicitly, with the user's own API key and only after the user's consent to send text to that particular service.

| Service | API address | Operator | Where requests are processed |
| --- | --- | --- | --- |
| OpenAI | `https://api.openai.com` | OpenAI | See OpenAI's policies linked below |
| DeepSeek | `https://api.deepseek.com` | DeepSeek | According to DeepSeek's privacy policy, on servers in the People's Republic of China |
| YandexGPT | `https://llm.api.cloud.yandex.net` | Yandex Cloud (Yandex AI Studio) | Yandex Cloud in Russia |

Everything below about sending data applies to these paid modes only, and only to the one service the user chose.

## Data the Extension handles

The Extension handles only the data needed to translate text:

- the text the user explicitly selects for translation;
- text the user manually types or pastes into the popup for translation;
- for a short selection, the surrounding sentence used to determine the correct meaning;
- the user's API key for each service the user set up, and for YandexGPT the Yandex Cloud folder ID;
- local preferences such as the selected model, automatic translation setting, and card size;
- the user's consent status for sending text, recorded separately for each service.

Before transmission, the Extension locally removes hidden duplicates and interface elements from the selection. Images, screenshots, and page pixels are not sent to any service.

## How the data is used and shared

Selected or manually entered text and optional selection context are sent directly from the user's browser to the API of the chosen service (see the table above) solely to generate the requested translation. The API key of that service is sent only to that service, in the authorization header, solely to authenticate the request; for YandexGPT the folder ID is sent in a request header as Yandex requires. A key for one service is never sent to another.

Before the first request to a service, the Extension asks the user to explicitly consent to sending text to that service. Consent to one service does not cover another. Translation network requests are blocked until consent is provided. For DeepSeek and YandexGPT the browser also asks the user to allow access to the service's address when the mode is chosen.

The developer does not receive this data, operate an intermediary server, sell data, use it for advertising, or share it with any other party. Each service processes API requests according to its own terms: OpenAI's [API data controls](https://developers.openai.com/api/docs/guides/your-data) and [privacy policy](https://openai.com/policies/privacy-policy/), DeepSeek's [privacy policy](https://chat.deepseek.com/downloads/DeepSeek%20Privacy%20Policy.html), and Yandex Cloud's [terms of use](https://yandex.com/legal/cloud_termsofuse/en/) and [data privacy](https://yandex.cloud/en/security/data-privacy).

## Storage and retention

API keys, preferences, and consent status are stored locally in `chrome.storage.local` on the user's device. Translation results may be kept temporarily in the extension's session storage (`chrome.storage.session`) for faster repeated translations. It lives in memory, is never written to disk, and is cleared when the browser closes.

The Extension does not maintain translation history, analytics, tracking identifiers, or developer-operated logs. Each service's own retention practices are described in the policies linked above.

## User control

Users can remove a stored API key by clearing it in the Extension settings. Consent to send text can be withdrawn by clearing the corresponding checkbox in settings; new requests to that service are then blocked. Uninstalling the Extension removes its locally stored settings through Chrome. Users should not translate secrets or content they are not authorized to send to the chosen service.

## Chrome Web Store Limited Use

The Extension's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. Information is used only to provide translation functionality and is not used for advertising, creditworthiness, or unrelated purposes.

## Changes and contact

Material changes will be published in this file with an updated effective date. For privacy questions, [open an issue in the public repository](https://github.com/StrangerOfDawah/sensemark/issues).
