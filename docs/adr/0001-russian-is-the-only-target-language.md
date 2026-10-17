# 1. Russian is the only target language

- Status: Accepted
- Formerly: D-001

## Context

Sensemark detects the source language automatically. A target-language picker
would add a control to every surface and multiply the prompt variants that have
to be tested.

## Decision

The translation target is always Russian. There is no language selector.

## Consequences

- A selection that is entirely Russian is handled locally: no card, no API call.
- Prompts stay short and stable, which keeps token cost and test surface small.
