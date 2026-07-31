# Sensemark Privacy Policy

[Русская версия](PRIVACY.md)

**Effective date:** July 31, 2026

Sensemark is an independent open-source Chrome extension and is not affiliated
with or endorsed by OpenAI.

## Data processed

Only for a user-requested translation:

- text explicitly selected, typed, or pasted by the user;
- for a short ambiguous selection, up to 800 code points from the nearest text
  block;
- the user's OpenAI API key;
- local provider/model, selection, card, and consent settings;
- translation inputs/results in a temporary session cache.

Sensemark does not send page URL/title, browsing history, links, arbitrary
`data-*` attributes, images, canvas content, screenshots, or whole-page content.
Standard accessibility fields may be used locally only as bounded candidates to
recover the current selection. Sensemark does not perform OCR.

## Transfer

Text and bounded context are sent directly over HTTPS from the browser to
`https://api.openai.com` solely to produce the requested translation. The API
key is sent to OpenAI for authentication. The user must consent before the
first request and may revoke consent to block later requests.

Sensemark has no developer-operated server. The developer does not receive,
sell, advertise with, or permit humans to read user text or keys. OpenAI handles
API requests under its [API data policy](https://developers.openai.com/api/docs/guides/your-data)
and [privacy policy](https://openai.com/policies/privacy-policy/).

## Local storage

The key, settings, and consent are stored in `chrome.storage.local`. The key is
restricted to trusted extension pages and is unavailable to content scripts.
Like any secret stored by a client-side extension, it is protected by the Chrome
profile boundary rather than separate hardware-backed storage. Temporary
entries use `chrome.storage.session`, SHA‑256 cache keys, a six-hour TTL, and
limits of 200 entries and 2 MiB. A protected-page fallback may briefly store
selected text in a tab/frame/request-specific session entry; it expires and is
removed after consumption, a failed panel open, or tab closure.

Sensemark keeps no persistent translation history, analytics, advertising
identifier, or developer-side logs.

## Controls and Limited Use

Options provide explicit API-key deletion, consent revocation, and card-size
reset. Uninstalling removes extension storage through Chrome. Do not translate
secrets or content you are not authorized to send to OpenAI.

Use complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies),
including Limited Use. Material changes will be published here with a new
effective date. Questions: [issues](https://github.com/StrangerOfDawah/sensemark/issues).
