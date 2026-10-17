# 3. Multilingual text gets a structured answer

- Status: Accepted
- Formerly: D-003

## Context

A selection can mix several languages. Translating it as one block makes the
UI blend results from different languages.

## Decision

Multilingual answers use sections tagged with script and language
(`[[multilingual]]`, `[[script:…|lang:…]]`). Russian parts are kept unchanged.

Exception: a short parallel title in two languages (for example
`Japanese Daycares – 日本の保育園`) may be translated once as a single `[[text]]`.

## Consequences

- The card shows sections in source order with readable language labels.
- The exception prevents duplicated output and an unnecessary repair request.
