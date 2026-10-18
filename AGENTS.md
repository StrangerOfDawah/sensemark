# AGENTS.md

Guidance for AI coding agents working in this repository. Explicit instructions
from the repository owner take precedence, but never silently break the product
invariants, test requirements or release process below.

## Project overview

Sensemark is a Manifest V3 browser extension (Chrome, plus a Safari build for
macOS) that translates selected or typed text from any language into Russian.
A free on-device translator (default) and three paid modes with the user's own
key: OpenAI, DeepSeek and YandexGPT. Plain JavaScript, no bundler, no runtime
dependencies.

Read before changing anything:

1. [docs/architecture.md](docs/architecture.md): layers, data flow, which file owns what.
2. [docs/adr/](docs/adr/README.md): recorded decisions and known traps.
3. [docs/product-direction.md](docs/product-direction.md): priorities and non-goals.
4. [CHANGELOG.md](CHANGELOG.md): what shipped recently.
5. For a release: [docs/releasing.md](docs/releasing.md).

Then check `git status`, find the existing tests for the behaviour you are about
to touch and read them before editing runtime code.

## Commands

Node 24 (`.nvmrc`). Install with `npm ci --ignore-scripts`.

| Command                  | What it does                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `npm test`               | Unit and integration tests (`tests/unit`, `tests/integration`)        |
| `npm run test:coverage`  | The same with coverage thresholds (CI gate)                           |
| `npm run test:e2e`       | Real Chromium via Playwright with the extension loaded, OpenAI stubbed |
| `npm run lint`           | ESLint                                                                |
| `npm run format`         | Prettier (locked design files are excluded)                           |
| `npm run check`          | Validates the manifest, file lists and packaging script               |
| `npm run verify`         | lint + format check + check + coverage: run before every commit       |
| `npm run package`        | Builds `dist/sensemark-vX.Y.Z.zip`                                    |
| `npm run safari:kit`     | Also builds `dist/sensemark-safari-vX.Y.Z.zip`                        |
| `npm run design:status`  | Shows whether any design-locked file changed                          |

To try the extension, load `src/` via `chrome://extensions` → "Load unpacked".

## Layout

- `src/`: the shipped extension. `src/content/` holds the content scripts;
  their load order is listed in `src/manifest.json` and in the `executeScript`
  fallback in `src/background.js`, and a test keeps both in sync.
- `platforms/safari/`: Swift sources and `install.sh` for the Safari kit.
- `scripts/`: packaging, validation, the design lock and the Safari kit build.
- `tests/unit`, `tests/integration`, `tests/e2e`, with `helpers/` and `fixtures/`.
- `docs/`, `store/` (Chrome Web Store copy), `PRIVACY.md` at the root (the
  store's privacy link points to it; do not move it).

## Code style

- Classic scripts with a UMD wrapper (`globalThis.SensemarkX` in the browser,
  `module.exports` under Node), so files run unbundled and are unit-tested as is.
- Prefer small pure modules (see `card-theme.js`, `content/placement.js`,
  `background/prompts.js`) and keep DOM and browser APIs in the thin controllers
  (`content/content.js`, `background.js`). The service worker loads its modules
  with `importScripts`; a structure test keeps that list and the package in sync.
- Prettier and ESLint are the source of truth for formatting and lint.
- Language: everything in the repository is in English, except four files:
  `README.md` (the Russian front page; `README.en.md` is its English twin),
  `src/_locales/ru/messages.json` (every user-facing string, read through
  `src/i18n.js`), `tests/fixtures/russian.json` (Russian test samples) and
  `store/listing.ru.txt` (the store listing). Never write Russian in code,
  comments, tests or other docs; `tests/integration/language-policy.test.js`
  enforces this. In HTML, put text in `<!--t:key-->` comments and attributes in
  `data-i18n-*`; in JavaScript, call `t("key", ...values)`.
- Cyrillic letter ranges in regular expressions are written as code points
  (`\u0410-\u044F\u0401\u0451`).

## Product invariants

- The target language is always Russian; the source language is detected.
- Free mode (Chrome Translator API, or Apple's translator in Safari,
  [ADR 0017](docs/adr/0017-safari-uses-apple-translation.md)) is the default;
  paid modes are optional. Every feature works in free and paid modes or explains
  to the user why it needs a paid one.
- Paid services are listed in `src/providers.js` and share one OpenAI-compatible
  request path ([ADR 0019](docs/adr/0019-openai-compatible-providers.md)). A new
  service gets an optional host permission, its own key and consent, a section
  in `PRIVACY.md` and a `scripts/check-provider.js` run before it is offered.
- A Russian-only selection is handled locally: no API request, no card.
- In a mixed selection, Russian is kept and foreign fragments are translated.
  Real multilingual blocks are shown in source order with clear language labels.
- Hidden duplicates, UI elements and Unicode control characters are removed
  locally before any text reaches a model.
- Sensemark is universal: any language and any text in, Russian out. Never add
  rules, prompts, examples or descriptions for particular sites, topics or texts
  ([ADR 0012](docs/adr/0012-universal-translator.md)).
- A single word is translated in context. A name, title, brand, nickname, typo or
  unknown term is shown as an explanation, not as an invented translation.
- The on-page card appears only with the first visible piece of translation.
  While waiting, only the small status pill may show
  ([ADR 0016](docs/adr/0016-chameleon-card.md)).
- Closing the card, clearing or editing manual input cancels the unfinished request.
- Auto-translate is on by default, but a user who turned it off stays off
  ([ADR 0018](docs/adr/0018-auto-translate-on-by-default.md)). Users who saved an
  OpenAI key keep it and stay in OpenAI mode after an update.
- API keys and settings stay in `chrome.storage.local`; each key goes only to its
  own service. No analytics, no developer server, no third-party data sharing
  without an explicit decision by the owner and an updated privacy policy.
- The default OpenAI model is the cheapest current one. Before changing it, check
  the OpenAI deprecations page and the model's parameters (reasoning models do
  not accept `temperature`).

## Token budget

- Anything that can be decided locally is not sent to the model.
- One user translation means one API request by default. A repair request is
  allowed only after a concrete, checkable format error or incomplete answer.
- No second request just to detect a language, classify or format cosmetically.
- Keep the translation cache and immediate stream cancellation.
- Do not grow the prompt without a measurable need; new instructions are short,
  consistent and covered by a test.

## Tests are mandatory

Every new feature and every bug fix **must** add a new automated test or change an
existing one in the same commit/PR. A behaviour change without a test is not done.

For a bug fix:

1. Add a regression test that reproduces the exact user example or a minimal
   equivalent.
2. Make sure it checks the root cause, not only the error text.
3. Keep the test forever so the bug cannot return.

For a feature:

1. Cover the main success path.
2. Cover the important edge case and the failure/cancel path where relevant.
3. UI: a DOM integration test, and a scenario in `tests/e2e/extension.e2e.js` for
   the user journey. Parsers and detectors: pure unit tests. Background/runtime:
   tests for request count, streaming, cache or cancellation as needed.

If a scenario truly cannot be automated, explain why in the PR, add the closest
automated test and describe the manual check. Never delete tests or lower coverage
thresholds to make CI pass.

## UI and the toolbar popup

- The on-page card lives in a Shadow DOM; never move its styles into the page DOM.
- The popup is plain `popup.html`, `popup.css` and `popup.js`: no React, no `#root`.
- Chrome sizes the popup from its content. Never set `height: 100%` on `html`,
  `body` and the root container together: it once stretched the popup into an
  empty window ([ADR 0007](docs/adr/0007-toolbar-popup-stays-compact.md)).
- Check popup geometry in the unpacked build via `chrome://extensions`, not in a
  regular web page.
- Keep inner spacing, readability, light/dark themes, high contrast and
  reduced motion.

## Design lock

- The look is fingerprinted in `tests/design-lock.json`: `src/popup.css`,
  `src/popup.html`, `src/options.html` and the styles in
  `src/content/card-styles.js` ([ADR 0011](docs/adr/0011-design-lock.md)).
- Agents **do not change** the design and **never run** `npm run design:approve`
  without the owner's explicit approval of that specific visual change. Show
  screenshots first.
- If the lock test fails because of your change, revert the visual part instead of
  updating the fingerprints.

## Safari

- Safari-specific code lives in `builtin-translator.js` (`platformDeps`,
  `createAppleBridge`), `platforms/safari/` and `scripts/build-safari-kit.js`.
  Never add `nativeMessaging` to `src/manifest.json`; it goes only into the Safari
  manifest.
- When you change bridge operations, change `SafariWebExtensionHandler.swift` too;
  `tests/integration/safari-kit.test.js` compares them. The `Safari app (Xcode)` CI
  job builds the Swift part on macOS through `install.sh`, without signing.
- `platforms/safari/install.sh` must run on macOS bash 3.2: write every variable as
  `${NAME}` (a test enforces this).

## Dependencies

- Check standard Web/Chrome APIs and proven solutions before writing your own
  detector, parser or library ([ADR 0010](docs/adr/0010-platform-first.md)).
- A new runtime dependency needs a stated benefit, cost, size, licence and privacy
  impact.
- No remote code: Manifest V3 and this project require all executable code to be
  packaged in the extension.

## Workflow

1. State the observable behaviour and the token-cost risk.
2. Find the layer that owns the problem in `docs/architecture.md`.
3. Add or update the test.
4. Make the smallest fix, without unrelated rewrites.
5. Run `npm run verify` and, for UI or flow changes, `npm run test:e2e`.
6. Check which Markdown files are now stale and update them in the same commit/PR:
   - user-visible behaviour and release notes: `CHANGELOG.md` and the READMEs;
   - data flow or file ownership: `docs/architecture.md`;
   - a new invariant, trade-off or known trap: a new record in `docs/adr/`;
   - product course: `docs/product-direction.md`;
   - checks or publishing: `docs/releasing.md`;
   - rules for the next agent: `AGENTS.md`.
   If no Markdown file needs a change, say why in the PR.
7. Publish only a verified branch. No tag or GitHub Release before CI passes on the
   exact commit being released.

## Commits and pull requests

- English, imperative subject line ("Split content.js into focused modules").
- No AI co-author or session trailers in commits or PR descriptions.
- Never commit API keys, user data, `chrome.storage` contents, `.idea/`,
  `.mcp.json` or build output (`dist/`).
