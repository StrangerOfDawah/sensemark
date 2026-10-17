# 13. Accidental selections are not translated

- Status: Accepted
- Formerly: D-013

## Context

People select text to copy it, not only to translate it.

## Decision

Guess from behaviour without extra clicks: auto-translate waits 500 ms and
cancels if ⌘/Ctrl+C is pressed (matched by `event.code`, so it works on a Russian
keyboard layout), the context menu opens or the selection is inside an input or
editor. For runs of copying, the card offers a 5-minute pause and a full
switch-off. Manual translation — the context menu and the shortcut — always
works.

Alternatives considered: a button next to the selection (more reliable, but an
extra click) and translating only with a held modifier key (invisible to new
users).

## Consequences

- The pause is stored as `autoPausedUntil` in `chrome.storage.local` and is
  shared by all tabs.
