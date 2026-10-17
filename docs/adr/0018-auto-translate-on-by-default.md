# 18. Auto-translate is on by default

- Status: Accepted
- Formerly: D-018

## Context

Select and get a translation is the main scenario; hiding it behind a settings
toggle makes no sense.

## Decision

`autoTranslate` defaults to `true` in background, content, options and
manual-translation. The default only applies where the user has never saved the
setting; whoever turned auto-translate off keeps it off. Accidental selections are
still filtered ([ADR 0013](0013-ignore-accidental-selections.md)), and in OpenAI
mode nothing is sent without consent to send text.

## Consequences

- Until settings are read, the content script keeps the flag off, so it never
  translates for someone who disabled auto-translate.
