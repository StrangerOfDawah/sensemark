# 9. Every feature and bug fix ships with a test

- Status: Accepted
- Formerly: D-009

## Context

Regressions in translation behaviour are subtle and easy to reintroduce.

## Decision

Every new user-facing scenario has an automated happy-path test and a relevant
edge case. Every bug fix leaves a regression test built from the original
example. Coverage thresholds are a safety net, not a replacement for a
meaningful test.

- A change that can affect the number of API requests asserts the request count.
- A UI change asserts visibility and DOM state.
- A cancellation change asserts the disconnect or abort.

## Consequences

- Tests are never deleted and thresholds never lowered to make CI pass.
