# 15. OpenAI model and token budget

- Status: Accepted
- Formerly: D-015

## Context

`gpt-4o-mini` and the other older OpenAI models are retired before January 2027.

## Decision

The default model is `gpt-6-luna` ($0.10 / $0.50 per 1M tokens), the cheapest
current model. It is a reasoning model, so requests send
`reasoning_effort: "none"` and `max_completion_tokens` and omit `temperature`
(otherwise HTTP 400 and paid reasoning tokens).

Token use is trimmed: instructions are in English and shorter (430–550 →
170–275 tokens per request); validation does not reject kept names and terms
(every extra repair doubles the price); tiny inserts of another script ("π",
"東京") do not switch to the multilingual format; the cache lives until the
browser closes; answer length is capped.

## Consequences

- A typical phrase translation costs about $0.00003.
- Before changing the model, check the OpenAI deprecations page and the model's
  parameters.
