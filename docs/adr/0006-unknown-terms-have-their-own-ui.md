# 6. Unknown terms have their own UI

- Status: Accepted
- Formerly: D-006

## Context

A name, title, brand, nickname, typo or made-up term must not look like an
ordinary translation — a confident fake translation is worse than none.

## Decision

The model answers such input with `[[reference]]`, which renders as a separate
amber card with a category and a careful explanation. An ordinary dictionary
word such as `Why` always prefers a translation, even when capitalised.

## Consequences

- The word parser and the card handle two distinct answer kinds.
- Prompt changes are covered by tests for both kinds.
