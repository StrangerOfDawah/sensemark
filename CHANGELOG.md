# Changelog

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.6.0] — 2026-10-17

### Added

- Sensemark for Safari on the Mac (personal use, not published): free mode
  translates with Apple's system translator right on the Mac, OpenAI mode works
  as in Chrome. Languages are downloaded once in the Sensemark app. The kit is
  built with `npm run safari:kit`; installation is described in
  `platforms/safari/README.md`.

### Changed

- Auto-translate on selection is on by default: select text with the mouse and
  the translation appears half a second later. Anyone who had turned
  auto-translate off keeps it off; it can be paused or turned off from the card
  or in settings.

### For developers

- The Chrome Web Store description written for 1.5.0 is back in the
  repository (`store/listing.ru.txt`) and mentions that auto-translate is on.
- The extension moved to `src/`, the Safari part to `platforms/safari/`, and
  tests are split into `unit`, `integration` and `e2e`. `content.js` is split
  into modules in `src/content/`: card styles, page text, placement and the
  status pill. Prompts and answer validation moved out of `background.js` into
  `src/background/`. The Chrome Web Store archive is built from `src/`, with
  `manifest.json` still at its root.
- All user-facing text moved to `src/_locales/ru/messages.json` and is read
  through `chrome.i18n`; code, comments, tests and docs are in English, and a
  test keeps Russian out of everything except `README.md`, the locale file, the
  Russian test samples and the store listing.
- ESLint, Prettier, `.editorconfig`, `.nvmrc` and `npm run verify`; CI checks
  lint and formatting.
- Every release automatically gets both archives (Chrome and Safari) and
  `SHA256SUMS.txt`.
- Developer docs are in English: `AGENTS.md` (with `CLAUDE.md` and
  `.github/copilot-instructions.md`), `CONTRIBUTING.md`, `SECURITY.md`,
  `docs/architecture.md`; decisions D-001…D-018 became records in `docs/adr/`.
  `PRIVACY.md` is now the English policy.

## [1.5.0] — 2026-10-17

### Highlights

- Free mode by default: Chrome's built-in translator works right on the
  computer, with no key and no cost, and the text goes nowhere. OpenAI is the
  "smarter" option with your own key. The mode is chosen in settings, with a
  hint about the approximate OpenAI cost. Users who already have a key stay on
  OpenAI after the update.
- The default OpenAI model is `gpt-6-luna`: `gpt-4o-mini` and other older
  OpenAI models are retired before January 2027. Saved older models are switched
  automatically.
- Translation through OpenAI is roughly half the price: short English
  instructions, fewer needless retries, a cache that lives until the browser
  closes, and a capped answer length.

### New "chameleon" card

- The card adapts to the page: white on a white site, dark on a dark one, warm on
  a sepia one, and the translation matches the size of the text you are reading.
  The Appearance settings offer a theme (match the page / light / dark), a
  translation font (system, Golos Text or Literata, bundled with the extension)
  and "same size as the page".
- Until the translation starts, a small "Translating from English…" pill sits
  at the selection and shrinks into a circle with a running arc after a second.
  While a language pack downloads, the ring shows the real percentage. The pill
  always matches the card's colour.
- A long selection (about 300+ characters or several paragraphs) is translated
  as a margin note to the right of the text, with a bracket along the selection.
  When there is no room on the right, it becomes a panel at the right window
  edge. The text is never covered.
- The card no longer closes on scroll: it moves with the text.

### Changed

- README and Chrome Web Store images were retaken with the new card and
  settings; the store description covers free mode.
- The "Original" button is gone: the source text is already visible next to the
  card.
- Sensemark is universal again: handling for a single site (Quran.com) and
  topic-specific prompt instructions were removed. Selection cleanup and
  translation work the same for any text on any site.

### Fixed

- "Test key" no longer shows the internal `[[text]]` marker.
- Correct translations that keep names and terms ("GitHub Copilot", "API") are
  no longer rejected and no longer trigger a paid retry.
- An ordinary card no longer shows an empty category badge.
- Linked words no longer drop out of the translated text.
- Paragraphs and line breaks of a selection are kept, and words with inline
  styling (`un<em>believ</em>able`) are no longer split by spaces.

### Added

- Auto-translate ignores accidental selections: pressing ⌘/Ctrl+C or the right
  mouse button right after selecting cancels the translation, and selections in
  input fields are never auto-translated.
- A pause button on the card: pause auto-translate for 5 minutes or turn it off;
  turn it back on in settings or by right-clicking the extension icon.
- Translation of noisy selections, up to the whole page: menus, the site header
  and footer, buttons, footnotes and icon glyphs are removed locally, and the
  model skips leftover interface labels itself.
- E2E tests in real Chromium: the whole extension is loaded, and selection, the
  card, the cache, errors and the manual popup are checked without real OpenAI;
  CI attaches screenshots for a visual check.
- A design lock test: an accidental visual change stops CI, and an intentional
  one is accepted with `npm run design:approve`.

## [1.3.0] — 2026-07-23

### Added

- Translation into Russian from an automatically detected language instead of
  English only.
- Multilingual sections for mixed Russian, English, Arabic and other text.
- A separate amber explanation for names, titles, brands, nicknames, typos and
  unknown terms.
- A manual toolbar popup that translates after a paste or a typing pause,
  cancels stale requests and copies the result.
- Pull request CI: unit and DOM tests, coverage thresholds, Manifest V3 checks,
  the ZIP and an unpacked test build.
- Canonical AI agent instructions, architecture, decisions, product direction
  and a reproducible release process.

### Changed

- Russian-only text is ignored locally with no card and no API request;
  technical Latin inserts inside Russian do not trigger a translation.
- The on-page card opens only after the first visible text of the stream.
- Selection cleanup removes hidden duplicates, UI captions, control characters
  and Quran.com font glyphs before anything reaches the model.
- Card scaling uses small rate-limited steps.
- Short parallel titles in two languages are translated once.
- The popup got a more readable, compact visual hierarchy while keeping Chrome's
  automatic size measurement.

### Fixed

- `Why` is no longer classified as a non-existent word because of its capital
  letter.
- Arabic text and mixed Arabic-English selections are no longer skipped because
  of DOM noise and special fonts.
- The model must not repeat the source text or the prompt, or translate into an
  unrequested third language.
- Incomplete multilingual answers are checked before they are shown.
- `Japanese Daycares – 日本の保育園` no longer causes a completeness error and an
  extra repair request.
- Sharp trackpad wheel events no longer make the scale fly away.
- The root `height: 100%` that stretched the Chrome popup into a large empty
  window was reverted.

## [1.2.0] — 2026-07-22

### Added

- The Sensemark name, Chrome Web Store materials and a privacy policy.
- Explicit consent before selected text is sent to OpenAI.
- Reproducible ZIP packaging.

### Changed

- Updated repository and support links.

## [1.1.0] — 2026-07-21

### Added

- First public release: translating selected English text into Russian.
- Streaming output, context for single words, a cache and request cancellation.
- Dark theme, scaling and card resizing.
- Russian and English README versions.

[Unreleased]: https://github.com/StrangerOfDawah/sensemark/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.3.0...v1.5.0
[1.3.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/StrangerOfDawah/sensemark/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/StrangerOfDawah/sensemark/releases/tag/v1.1.0
