# 10. Platform APIs and proven solutions first

- Status: Accepted
- Formerly: D-010

## Context

Every runtime dependency adds size, licence and security review, and ships to
every user.

## Decision

Before writing a detector, parser or library, check the standard Web and Chrome
APIs and existing mature solutions. A custom implementation is fine when the task
is small, specific to Sensemark and covered by tests. No runtime dependency is
added without weighing size, licence, security and resource cost.

## Consequences

- The extension currently has no runtime dependencies; dev dependencies are
  limited to test and lint tooling.
