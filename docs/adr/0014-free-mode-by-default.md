# 14. Free mode by default, OpenAI on request

- Status: Accepted
- Formerly: D-014

## Context

The goal is translation that costs the user almost nothing. There is no free
AI API without a key: LLM translation from large vendors is paid, and unofficial
translator endpoints break service terms and can stop working at any time.

## Decision

By default Sensemark uses the browser's built-in, on-device translator (the
Chrome Translator API): free, keyless and offline. OpenAI is an optional
"smarter" mode with the user's own key.

## Consequences

- Users who already saved an OpenAI key stay in OpenAI mode after updating
  (guarded by a test).
- Every feature works in both modes or explains why it is OpenAI-only.
