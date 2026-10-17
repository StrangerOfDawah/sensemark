# Copilot instructions

The full guidance for AI agents is in [AGENTS.md](../AGENTS.md). The essentials:

- Sensemark is a Manifest V3 extension in plain JavaScript (no bundler, no runtime
  dependencies) that translates any language into Russian. Source is in `src/`.
- Code, comments, tests and commits are in English; user-facing strings stay Russian.
- Never change `src/popup.css`, `src/popup.html`, `src/options.html` or the styles in
  `src/content/card-styles.js`: they are design-locked (`tests/design-lock.json`).
- No site-specific rules, no analytics, no remote code, no extra API requests.
- Every feature and bug fix comes with a test. Run `npm run verify` before committing.
