# 5. Repair is an exception, not part of translation

- Status: Accepted
- Formerly: D-005

## Context

A second API request costs tokens and adds latency.

## Decision

A repair request is allowed only when local validation names a concrete defect
in the answer (missing section, added script, untranslated original, wrong
target language, copied instructions). It is never used to detect a language,
polish style or fix optional formatting.

## Consequences

- One user translation means one API request by default.
- Tests count requests whenever a change could affect them.
