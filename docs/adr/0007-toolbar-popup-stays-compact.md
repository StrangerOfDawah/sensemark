# 7. The toolbar popup stays a compact Chrome popup

- Status: Accepted
- Formerly: D-007

## Context

Manual translation lives in the toolbar popup, built with plain HTML/CSS/JS
(no React). Chrome sizes the popup from its content.

In July 2026 an attempt to make the root edge-to-edge with `height: 100%` on
`html`, `body` and `.shell` stretched the popup into a large empty window. The
change was reverted.

## Decision

- Do not apply ordinary web-page layout rules to the popup.
- Do not set a percentage height on the whole root chain.
- Check the built extension through `chrome://extensions`.
- Keep the current compact outer geometry until the owner approves a tested
  alternative.

## Consequences

- The popup's outer geometry is protected by the design lock ([ADR 0011](0011-design-lock.md)).
