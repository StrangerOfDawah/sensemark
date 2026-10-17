# 11. The design is protected by a lock

- Status: Accepted
- Formerly: D-011

## Context

An AI agent once reworked the look of the extension and broke the interface.

## Decision

Everything that defines the look is fingerprinted with SHA-256 in
`tests/design-lock.json` by `scripts/design-lock.js`: `src/popup.css`,
`src/popup.html`, `src/options.html` and every `<style>` block in
`src/content/card-styles.js`. `tests/integration/design-lock.test.js` fails on any
change.

An intentional visual change is accepted with `npm run design:approve`. Agents
run it only with the owner's explicit approval of that specific change, after
showing screenshots.

## Consequences

- Translation logic in `src/content/content.js` is outside the lock; only the
  stylesheet module is fingerprinted.
- Locked files are excluded from Prettier so formatting never touches them.
