# 8. Card scaling is rate-limited

- Status: Accepted
- Formerly: D-008

## Context

A trackpad fires many wheel events per gesture. Without limits the text size
jumps far in a single movement.

## Decision

`ui-scale.js` changes the scale in small steps, within fixed bounds and with a
rate limit.

## Consequences

- Scaling feels controlled on trackpads and mice alike; the limits are unit-tested.
