# Copilot instructions

The full guidance for AI agents is in [AGENTS.md](../AGENTS.md). The essentials:

- Sensemark is a Manifest V3 extension in plain JavaScript (no bundler, no runtime
  dependencies) that translates any language into Russian. Source is in `src/`.
- Everything is in English. User-facing strings live only in `src/_locales/ru/messages.json`
  (use `t("key")` in JavaScript and `<!--t:key-->` in HTML); Russian test samples live in
  `tests/fixtures/russian.json`.
- Never change `src/popup.css`, `src/popup.html`, `src/options.html` or the styles in
  `src/content/card-styles.js`: they are design-locked (`tests/design-lock.json`).
- No site-specific rules, no analytics, no remote code, no extra API requests.
- Every feature and bug fix comes with a test. Run `npm run verify` before committing.
