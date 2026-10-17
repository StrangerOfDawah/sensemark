# 4. Never show an empty card

- Status: Accepted
- Formerly: D-004

## Context

An empty loading window is distracting and reads like an error.

## Decision

The on-page card is created only once visible translated text has arrived.
A service marker or an empty streaming scaffold does not count as visible text.

## Consequences

- While waiting, only the small status pill may appear ([ADR 0016](0016-chameleon-card.md)).
- Integration and e2e tests assert that no card exists before the first chunk.
