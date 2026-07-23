<div align="center">

[Русский](README.md) · **English**

</div>

<img src="docs/hero.png" alt="Sensemark — select text on any page and get a contextual translation">

<div align="center">

[**Download the latest release**](https://github.com/StrangerOfDawah/sensemark/releases/latest) · Chrome · Manifest V3 · OpenAI API · [Privacy](PRIVACY.en.md)

</div>

> The interface is in Russian and the extension translates **into** Russian — the source language is detected automatically. To target another language, change `targetLang` in `DEFAULTS` inside `background.js` and `options.js`.

A Russian selection is ignored without opening the card or calling the API, including small technical insertions such as `dev-секрет`, `APP_ENV`, a URL, or the ChatGPT name. When a selection contains genuinely separate Russian and foreign-language sentences, Russian fragments stay unchanged while the remaining fragments are translated and displayed in separate source-language sections.

Before a request, Sensemark locally removes hidden duplicates, controls, interface labels, and Unicode direction markers. On Quran.com, page-font glyph codes are replaced with the simple Arabic copy already embedded in the page. The model receives real text rather than visual codes, and DOM noise does not waste tokens.

<br>

## No waiting for the translation

The response streams over SSE: the card opens together with the first translated characters while the model is still writing the rest. No empty loading card is shown before the response begins.

<img src="docs/feature-stream.png" alt="Three stages of a translation appearing as it is generated">

Close the card mid-translation and the request aborts — unfinished tokens aren't billed.

<br>

## One word, the right meaning

Selected a single word? The extension picks up the surrounding sentence and asks for the translation that fits *that* sentence. Other common meanings are listed underneath, in case you needed a different one.

If the selection is not a common word — for example, it is a name, title, username, brand, or typo — Sensemark does not invent a translation. The card switches to a separate amber **Explanation** state, shows the fragment category, and gives a brief, cautious description based on its spelling and context. If there is not enough information, it identifies the fragment as a likely proper name or title.

<img src="docs/feature-context.png" alt="The word bank in two contexts: банк and берег">

The card lives in a Shadow DOM, so site styles can't break it, and it follows the page's light or dark theme.

<br>

## Sized for your eyes

<img src="docs/feature-size.png" alt="The card at 100% and 160% scale">

The whole card scales, not just the font — padding, buttons and icons grow with the text. The corner grip resizes it, a double-click resets everything. The setting persists across every page.

<br>

## One key and you're done

<img src="docs/feature-options.png" alt="Extension settings page">

<br>

## Install

1. Download the archive from the [**Releases**](https://github.com/StrangerOfDawah/sensemark/releases/latest) page and unpack it
2. Open `chrome://extensions`
3. Turn on **Developer mode** — the toggle in the top right
4. Click **Load unpacked** and select the unpacked folder

Don't delete or rename the folder afterwards — Chrome loads the extension straight from it. Put it somewhere permanent.

Until the Chrome Web Store listing is published, the extension is installed manually. Chrome will remind you about developer mode on startup; that's normal for extensions installed this way.

<br>

## Test build from a PR

For every pull request, GitHub Actions validates the code and attaches an unpacked test build. Open the relevant **PR test build** run on the Actions tab, download the `sensemark-pr-N` artifact, unzip it, and load the resulting folder from `chrome://extensions` → **Load unpacked**.

The artifact is retained for 14 days and contains no API keys or user settings. A separate Chrome profile keeps the test build isolated from the installed release. The workflow can also be started manually with **Run workflow**.

<br>

## OpenAI key

You need an OpenAI API key. This is **not** a ChatGPT Plus subscription — that gives no programmatic access. The API is billed separately, per use.

1. Create a key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys) and top up your balance
2. Click the extension icon to open its settings
3. Paste the key and hit **Проверить ключ** (Test key)

**On cost.** The default is the economical `gpt-4o-mini` model. Pricing depends on OpenAI's current rates. Track spending at [platform.openai.com/usage](https://platform.openai.com/usage), where you can also configure limits.

<br>

## Usage

| Method | How |
| --- | --- |
| Keyboard shortcut | Select text → <kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd> (Mac) or <kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Y</kbd> (Windows) |
| Context menu | Select text → right-click → «Перевести на русский» |
| Automatic | Enable the toggle in settings — translates on any mouse selection |
| Scale | <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + scroll over the card |

In the card: the icon button copies the translation, «Оригинал» expands the source text. Close it with <kbd>Esc</kbd>, the ×, a click outside, or by scrolling.

You can rebind the shortcut at `chrome://extensions/shortcuts`. If it doesn't work right away, check there that the combination is actually assigned — Chrome silently leaves the field empty when another extension already claims it.

<br>

## How it works

| File | Purpose |
| --- | --- |
| `manifest.json` | Manifest, permissions, keyboard shortcut |
| `background.js` | Service worker: context menu, OpenAI streaming, translation cache |
| `language-detection.js` | Local check for whether the selected text needs translation |
| `selection-text.js` | Selection cleanup and semantic recovery for page-font glyphs |
| `word-response.js` | Word-response parser: regular translation or name/title explanation |
| `text-response.js` | Parser for regular and sectioned multilingual translations |
| `content.js` | On-page card, context extraction, scale and size |
| `options.html` · `options.js` | Settings page |
| `icons/` | Icons, 16–128 |

The key is stored in `chrome.storage.local`. Selected text and, for a short selection, its surrounding sentence are sent directly to OpenAI for translation. The extension has no developer-operated server and no analytics; see the [privacy policy](PRIVACY.en.md) for details.

Repeat translations of the same fragment come from an in-memory cache in the service worker (last 200) and cost nothing. Selections are capped at 5000 characters so an accidental <kbd>⌘</kbd><kbd>A</kbd> doesn't send a whole page to the API.

If a selection exists only as an image and the page provides no foreign-language text layer, Sensemark shows a local message and sends nothing to the API. Automatic OCR is intentionally avoided because it would add cost and could corrupt decorative or Quranic text.

<br>

## Limitations

- Works only where Chrome lets extensions run scripts: the card won't appear on `chrome://` pages, the Chrome Web Store, or other extensions' pages
- Text inside a PNG, photograph, or canvas cannot be translated through a normal text selection; the extension does not upload such images and asks the user to select an available text label
- The target language is fixed to Russian on purpose — the value goes straight into the system prompt, so there's no free-text field
- After editing the code, press Reload on the extension card in `chrome://extensions` and refresh open tabs

<br>

## License

MIT — see [LICENSE](LICENSE).

OpenAI is a trademark of its respective owner. This is an independent project and is not affiliated with or endorsed by OpenAI.
