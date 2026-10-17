# 16. The "chameleon" card

- Status: Accepted
- Formerly: D-016

## Context

A fixed white card looks foreign on dark or sepia pages, and an empty waiting
card is ruled out ([ADR 0004](0004-never-show-an-empty-card.md)).

## Decision

The card takes the page's background and text colours and its font size (the
"match the page" theme); light or dark can be pinned in settings. Fallback
colours live on `:host`, not on `.card` — otherwise they override the page
colours and the card is always white (that bug happened; a regression test
exists).

While there is no answer, a small status pill appears (12 px, muted colour) and
shrinks into a circle after a second. Only a language-pack download shows a real
percentage; for OpenAI the arc spins, because there is no honest percentage. The
pill appears after 200 ms so it does not flash in free mode (~30 ms per
translation).

A long selection — 300+ characters, or two or more paragraphs with 120+
characters together — is shown as a margin note to the right (needs ≥ 300 px),
otherwise as a panel at the window edge. Chrome's side panel cannot be opened
without a click, so the panel is drawn on the page. Narrow windows (< 640 px)
always use the card next to the selection.

## Consequences

- Theme and layout choice are pure functions in `src/card-theme.js`; geometry is
  in `src/content/placement.js`; both are unit-tested.
