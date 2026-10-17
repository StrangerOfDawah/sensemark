# 12. A universal translator, not tied to any site

- Status: Accepted
- Formerly: D-012

## Context

Rules for one particular site and topic once leaked into the code, the prompt
and the descriptions. They narrowed the product and complicated the code, and
were removed.

## Decision

Sensemark translates any text from any language into Russian. There are no
special branches for particular sites, topics or texts — not in selection
cleaning, the prompt, test examples or descriptions. If a site renders text in an
unusual way, the fix must be general and work on every site.

## Consequences

- Test fixtures use generic pages, not copies of real sites.
