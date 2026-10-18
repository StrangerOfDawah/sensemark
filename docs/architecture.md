# Architecture

## Purpose

Sensemark is a Manifest V3 browser extension that translates selected or typed
text into Russian. It has four modes (`provider` in `chrome.storage.local`):

- `builtin` (default): the browser's on-device translator. In Chrome this is the
  Translator API; in Safari it is Apple's translator through the container app.
  No key, no network.
- `openai`, `deepseek`, `yandex`: a paid service with the user's own key. All
  three speak the OpenAI Chat Completions format; the service worker calls the
  chosen one directly ([ADR 0019](adr/0019-openai-compatible-providers.md)).

There is no developer server. Settings stay in local extension storage.

## Repository layout

```text
src/                     the extension itself; this folder is what ships
  manifest.json
  background.js          service worker: menus, provider streaming, cache, repair
  providers.js           paid services: address, key, model, consent, permission
  background/            prompts and answer validation, loaded with importScripts
  builtin-translator.js  free mode: Translator API or the Apple bridge
  *.js                   shared pure modules (detection, parsing, theme, scale)
  content/               content scripts injected into pages
  popup.*, options.*     toolbar popup and settings page
  icons/, fonts/
platforms/safari/        Safari kit: native Swift sources and install.sh
scripts/                 packaging, validation, design lock, Safari kit build
tests/
  unit/                  pure functions, no DOM
  integration/           jsdom and VM harnesses, repo structure, docs
  e2e/                   real Chromium via Playwright
  helpers/, fixtures/
docs/                    architecture, ADRs, product direction, releasing
store/                   Chrome Web Store listing copy and images
```

## Main flow

```text
selection or manual input
        ↓
local cleaning and script detection
        ↓
local skip for Russian-only text, limit checks
        ↓
one prompt and a cache key
        ↓
background.js → OpenAI / DeepSeek / YandexGPT streaming API     (or the on-device translator)
        ↓
protocol and content validation
        ↓
response parser → on-page card or toolbar popup
```

## Layers and owners

| Layer             | Files                                      | Responsibility                                                               |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Manifest          | `src/manifest.json`                        | Permissions, content scripts, service worker, popup and commands             |
| Messages          | `src/_locales/ru/messages.json`, `src/i18n.js` | Every user-facing string and the Russian words of the model protocol     |
| Detection         | `src/language-detection.js`                | Scripts, Russian text, small technical Latin inserts                         |
| Selection text    | `src/selection-text.js`                    | Joining fragments, invisible characters, icon-font glyphs                    |
| Providers         | `src/providers.js`                         | Paid services: address, key setting, model, consent, host permission         |
| Request & stream  | `src/background.js`                        | Menus, provider requests, SSE, cache, repair, error messages                 |
| Prompts           | `src/background/prompts.js`                | Instructions, messages, per-provider parameters and the request body         |
| Answer checks     | `src/background/validation.js`             | Format, sections, scripts and copied-instruction checks before showing an answer |
| Free mode         | `src/builtin-translator.js`                | Translator API or Apple bridge, language packs, local "port"                 |
| Word answer       | `src/word-response.js`                     | `[[translation]]` and `[[reference]]`                                        |
| Text answer       | `src/text-response.js`                     | `[[text]]`, `[[multilingual]]` and language sections                         |
| Card theme        | `src/card-theme.js`                        | Palette, font, size and layout choice (`anchor`, `margin`, `drawer`)         |
| Page text         | `src/content/page-text.js`                 | Selection context, visible text, selected images, editable fields            |
| Placement         | `src/content/placement.js`                 | Pure geometry for the card, margin note, bracket and status pill             |
| Status pill       | `src/content/status-pill.js`               | The "translating…" pill and its lifecycle                                    |
| Card styles       | `src/content/card-styles.js`               | Card and pill CSS, icons (design-locked)                                     |
| Page controller   | `src/content/content.js`                   | Selection events, auto-translate, requests, Shadow DOM card                  |
| Scale             | `src/ui-scale.js`                          | Step, bounds and rate limit                                                  |
| Manual translate  | `src/manual-translation.js`                | Local request plan and a single result view                                  |
| Toolbar popup     | `src/popup.html`, `popup.css`, `popup.js`  | Input, debounce, stream, cancel, copy, settings                              |
| Settings          | `src/options.html`, `options.js`           | Mode, per-provider key and consent, model, auto-translate, appearance        |
| Safari native     | `platforms/safari/native/*.swift`          | Apple translation, language detection, language download window             |
| Checks & packaging | `tests/`, `scripts/`, `.github/workflows/` | Regressions, coverage, manifest, zip, Safari kit, release assets           |

User-facing text lives only in `src/_locales/ru/messages.json` and is read through
`chrome.i18n` by `src/i18n.js`, which also fills static HTML: each `<!--t:key-->`
comment becomes a text node and `data-i18n-title`, `data-i18n-aria-label` and
`data-i18n-placeholder` set attributes, so the DOM keeps its exact shape. The same
file holds the Russian words of the model protocol (for example the "other
meanings" prefix), so the prompt and the parsers never disagree.

Content scripts are classic scripts, not modules. Each shared file uses a small
UMD wrapper: in the browser it publishes `globalThis.SensemarkX`; under Node it
sets `module.exports`, so the same file is unit-tested without a bundler. The
load order is fixed in `src/manifest.json` and repeated in the `executeScript`
fallback in `background.js`; a structure test keeps both lists in sync.

## Local text preparation

`content/content.js` reads the selection and hands it to `content/page-text.js`
and `selection-text.js`. Cleaning keeps the visible meaning and removes only
proven noise. It is universal: there are no rules for particular sites or topics
([ADR 0012](adr/0012-universal-translator.md)).

- Noise: controls (buttons, inputs, `role="button"`), menus and navigation, the
  site header/footer/sidebar outside `article`/`main`, footnote links in `<sup>`,
  hidden text, icon-font glyphs (Private Use Area) and invisible control
  characters.
- Links inside text are content.
- Fragments of one block are joined without extra spaces; different blocks and
  `<br>` become line breaks.
- If only a UI element is selected, it is translated.
- UI leftovers the local pass cannot identify are skipped by the model per the
  prompt; there is no second request for that.

Then `language-detection.js`:

- recognises script families;
- treats Han, Hiragana and Katakana together as Japanese;
- tells Russian from other Cyrillic languages;
- allows small technical Latin inserts inside Russian;
- never skips a real foreign fragment.

A Russian-only selection ends here and opens no API port.

## Free mode

`builtin-translator.js` returns results in the same protocol as OpenAI
(`[[text]]`, `[[translation]]`, `[[multilingual]]`) through `openLocalPort`,
which implements the `chrome.runtime.Port` interface. The card and the popup do
not know where a translation came from, so there is one UI.

- Language detection uses `chrome.i18n.detectLanguage`; for non-Latin scripts the
  script decides when detection is unsure.
- Mixed text is split into sentences; Russian pieces are kept.
- Multi-line text is translated line by line, because the Translator API joins
  lines.
- A single word also gets its sentence translated ("in a sentence: …"), because
  the built-in translator cannot pick a meaning from context.
- A new language needs a language pack. With a user gesture Chrome downloads it
  itself and the card shows status and progress (60 s timeout). Without a gesture
  (shortcut, context menu) the card shows a "Download" button.
- The Translator API exists only in secure contexts; on `http://` pages the card
  explains this.

## Safari

The same `src/` folder runs in Safari ([ADR 0017](adr/0017-safari-uses-apple-translation.md)).
Differences:

- `platformDeps()` in `builtin-translator.js` recognises Safari by the
  `safari-web-extension://` URL and uses `createAppleBridge` instead of the
  Translator API: content scripts and the popup send `{type: "native", payload}`
  to the background, which calls `runtime.sendNativeMessage`;
- `platforms/safari/native/SafariWebExtensionHandler.swift` answers the
  `detect`, `availability`, `translate` and `openApp` operations;
- `platforms/safari/native/ViewController.swift` is the app window: the language
  list, downloads (`.translationTask`) and the extension state in Safari;
- `scripts/build-safari-kit.js` builds `dist/sensemark-safari-vX.Y.Z.zip` with a
  Safari manifest (+`nativeMessaging`), the Swift files and `install.sh`, which
  creates the Xcode project from Apple's template on a Mac and drops them in.

## Request modes

A short fragment can go in word mode with its sentence as context. Everything
else goes in text mode. Detected scripts are part of the cache key and the prompt.

The model answers in an internal protocol:

- `[[translation]]`: an ordinary translation of a word or short phrase;
- `[[reference]]`: a name, title, brand, nickname, typo or unknown term;
- `[[text]]`: a single translation of a text;
- `[[multilingual]]` and `[[script:SCRIPT|lang:LANGUAGE]]`: separate sections.

A short parallel title such as `Japanese Daycares – 日本の保育園` may come back as
one `[[text]]` when both parts mean the same. An ordinary multilingual paragraph
must contain every section.

## Validation and repair

`background/validation.js` rejects:

- `[[skip]]` from the model;
- missing required sections;
- scripts that were not in the selection;
- a repeated foreign original;
- a translation into a third language;
- copied instructions and a translation label (`protocolTranslationLabel`).

Repair is an exceptional second request after a concrete defect
([ADR 0005](adr/0005-repair-is-an-exception.md)). A correct single translation
of a parallel title must not trigger repair.

## Auto-translate and accidental selections

Auto-translate is on by default ([ADR 0018](adr/0018-auto-translate-on-by-default.md)).
It waits 500 ms after a mouse selection. If ⌘/Ctrl+C is pressed (matched by
`event.code`), the context menu opens or a copy happens in that time, the request
is cancelled while the card is not yet shown. Selections inside inputs and editors
are never auto-translated ([ADR 0013](adr/0013-ignore-accidental-selections.md)).

The card's pause button writes `autoPausedUntil` to `chrome.storage.local`
(5 minutes, shared by all tabs) or turns `autoTranslate` off. Manual translation
— the selection context menu and the shortcut — always works. The extension
icon's menu (`contexts: ["action"]`) turns auto-translate on or off or lifts the
pause.

## Rendering

The page and the popup share parsers but not shells:

- the on-page card lives in a Shadow DOM and appears only after visible streamed
  text; until then, if the answer takes longer than 200 ms, only the status pill
  (its own Shadow DOM) is shown, and it shrinks into a circle;
- `card-theme.js` is pure, DOM-free logic: a palette from the page's background
  and text colours (or pinned light/dark), font, "match the page" size and the
  layout: `anchor` (under the selection), `margin` (in the right margin) or
  `drawer` (a panel at the window edge). `content.js` only measures the page;
- `content/placement.js` turns the live `Range` rectangle into coordinates; the
  card is positioned in document coordinates and recalculated on scroll and resize
  so it moves with the text;
- the Golos Text and Literata fonts are in `src/fonts/`; the content script gets
  their bytes from the service worker (`get-font`) and registers them with
  `FontFace`, with no `web_accessible_resources` and nothing loaded from the web;
- the toolbar popup is ready as soon as the icon is clicked, translates pasted or
  typed text after a debounce and cancels any stale stream.

Raw protocol markers never reach the UI.

## Cache and lifecycle

The service worker keeps up to 200 recent results in memory and a copy in
`chrome.storage.session` (survives the worker going to sleep, never written to
disk, cleared when the browser closes). The API key is never part of the cache.
Closing the card or editing manual input disconnects the port and fires
`AbortController`, so nobody pays for generation they no longer need.

## Security boundaries

- `https://api.openai.com/*` is the only host permission granted at install.
  `api.deepseek.com` and `llm.api.cloud.yandex.net` are optional host
  permissions, requested when the user picks that mode; without the grant a
  request fails before it is sent.
- Each key goes only to its own service, and consent is recorded per service.
- No inline or remote executable code.
- The API key never goes into the zip, logs, fixtures or GitHub artifacts.
- Text inside images without a text layer is not sent to the API: there is no
  automatic OCR.

## Where to add a test

| Change                              | Main test                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Prompt, repair, cache, SSE          | `tests/unit/background-prompts.test.js`, `tests/integration/background-runtime.test.js`                       |
| Russian detection and scripts       | `tests/unit/language-detection.test.js`                                                                       |
| DOM noise and selection cleaning    | `tests/unit/selection-text.test.js`, `tests/integration/content-integration.test.js`                          |
| Free mode                           | `tests/unit/builtin-translator.test.js`, `tests/integration/content-integration.test.js`, `tests/integration/popup.test.js` |
| Safari bridge and kit               | `tests/unit/apple-bridge.test.js`, `tests/integration/safari-kit.test.js`                                     |
| Answer formats                      | `tests/unit/word-response.test.js`, `tests/unit/text-response.test.js`                                        |
| Card theme and placement            | `tests/unit/card-theme.test.js`, `tests/unit/placement.test.js`                                               |
| On-page card                        | `tests/integration/content-integration.test.js`                                                               |
| Popup and manual input              | `tests/integration/popup.test.js`, `tests/unit/manual-translation.test.js`                                    |
| User journey in real Chromium       | `tests/e2e/extension.e2e.js`                                                                                  |
| Manifest, CI, packaging, docs       | `tests/integration/extension-structure.test.js`, `tests/integration/project-documentation.test.js`            |
