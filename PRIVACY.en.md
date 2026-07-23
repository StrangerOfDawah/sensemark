# Sensemark Privacy Policy

[Русский](PRIVACY.md)

**Effective date:** July 23, 2026

This policy applies to the **Sensemark** Chrome extension (the “Extension”). The Extension is an independent open-source project and is not affiliated with or endorsed by OpenAI.

## Data the Extension handles

The Extension handles only the data needed to translate text:

- the text the user explicitly selects for translation;
- text the user manually types or pastes into the popup for translation;
- for a short selection, the surrounding sentence used to determine the correct meaning;
- the user's OpenAI API key;
- local preferences such as the selected model, automatic translation setting, and card size;
- the user's consent status for sending text to OpenAI.

Before transmission, the Extension locally removes hidden duplicates and interface elements from the selection. If a site renders text with page-font glyphs but provides a semantic text copy beside them, the cleaned text copy is included in the request. Images, screenshots, and page pixels are not sent to OpenAI.

## How the data is used and shared

Selected or manually entered text and optional selection context are sent directly from the user's browser to the OpenAI API at `https://api.openai.com` solely to generate the requested translation. The API key is sent to OpenAI in the authorization header solely to authenticate that request.

Before the first request, the Extension asks the user to explicitly consent to this data transfer. Translation network requests are blocked until consent is provided.

The developer does not receive this data, operate an intermediary server, sell data, use it for advertising, or share it with any other party. OpenAI processes API requests according to its [API data controls](https://developers.openai.com/api/docs/guides/your-data) and [privacy policy](https://openai.com/policies/privacy-policy/).

## Storage and retention

The API key, preferences, and consent status are stored locally in `chrome.storage.local` on the user's device. Translation results may be kept temporarily in the extension service worker's in-memory cache for faster repeated translations. This cache is not persistent and is discarded when Chrome stops the service worker.

The Extension does not maintain translation history, analytics, tracking identifiers, or developer-operated logs. OpenAI's own retention practices are described in the policies linked above.

## User control

Users can remove the stored API key by clearing it in the Extension settings. Consent to send text can be withdrawn by clearing the corresponding checkbox in settings; new OpenAI requests are then blocked. Uninstalling the Extension removes its locally stored settings through Chrome. Users should not translate secrets or content they are not authorized to send to OpenAI.

## Chrome Web Store Limited Use

The Extension's use of information complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements. Information is used only to provide translation functionality and is not used for advertising, creditworthiness, or unrelated purposes.

## Changes and contact

Material changes will be published in this file with an updated effective date. For privacy questions, [open an issue in the public repository](https://github.com/StrangerOfDawah/sensemark/issues).
