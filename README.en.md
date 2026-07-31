# Sensemark

A universal Chrome extension that translates explicitly selected or entered
text into Russian using the user's own OpenAI API key.

## Highlights

- native-first selection in normal DOM, form controls, open Shadow DOM, and
  accessible nested frames;
- button (default), automatic, and manual selection modes;
- context menu and `Ctrl/⌘+Shift+Y`;
- true plain-text streaming deltas;
- strict structured output for short contextual and multilingual selections;
- draggable and resizable Shadow DOM card with viewport-safe placement;
- explicit popup action, with automatic start only after paste;
- direct side-panel fallback for protected pages and the built-in PDF viewer;
- session TTL/LRU cache and cancellation of stale requests;
- API key unavailable to content scripts;
- no analytics, developer server, ads, or site-specific rules.

## Use

Open the options page, enter an OpenAI API key with API balance, choose the
Sensemark-verified model or an advanced unverified custom model, and consent to
sending selected text to OpenAI. Select foreign text and press the nearby
Translate button, use the context menu, or press `Ctrl/⌘+Shift+Y`.

A ChatGPT subscription does not include API usage.

## Privacy

Sensemark sends only selected/entered text. A short ambiguous selection may
include up to 800 code points from its nearest text block. Page URL/title,
links, arbitrary `data-*`, images, and whole-page content are excluded. See the
[privacy policy](PRIVACY.en.md).

## Development

Node.js 24 LTS is required and pinned by `.nvmrc` and CI.

```bash
npm ci
npm test
npm run test:coverage
npm run check
npm run test:browser:auto
npm run package:extension
npm run package:source
npm run verify:reproducible
npm run verify:artifacts
```

Project references:

- [Agent instructions](AGENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Decisions](docs/DECISIONS.md)
- [Product direction](docs/PRODUCT_DIRECTION.md)
- [Changelog](CHANGELOG.md)
- [Release process](docs/RELEASING.md)
- [Browser acceptance](BROWSER_ACCEPTANCE.md)
- [Research notes](RESEARCH_NOTES.md)

Independent open-source project. Not affiliated with or endorsed by OpenAI.
