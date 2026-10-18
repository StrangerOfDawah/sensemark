# 19. DeepSeek and YandexGPT through one OpenAI-compatible request path

- Status: Accepted

## Context

OpenAI is blocked in Russia and cannot be paid with a Russian card, while most
Sensemark users read in Russian. DeepSeek works from Russia but still needs a
foreign card; YandexGPT (Yandex AI Studio) works from Russia and takes Russian
cards. Both accept the OpenAI Chat Completions format with streaming.

## Decision

- `src/providers.js` is the single table of paid services: address, key setting,
  model, header extras, consent and host permission. The service worker, the
  popup and the settings page read it; the content script only knows that any
  mode other than `builtin` goes through the service worker.
- One request path serves every provider. `prompts.requestParams` holds the only
  per-provider request difference: DeepSeek runs with `thinking: disabled`
  (thinking is slower and billed), YandexGPT takes `temperature` and
  `max_tokens`, OpenAI keeps its per-model rules
  ([ADR 0015](0015-model-and-token-budget.md)).
- Models: `deepseek-flash`; `gpt://<folder>/yandexgpt-lite/latest` (YandexGPT
  Pro costs about four times more). Only OpenAI offers a model choice.
- OpenAI keeps its original storage names (`apiKey`, `privacyConsentVersion`),
  so saved keys and consent survive the update. New providers store
  `deepseekApiKey`, `yandexApiKey`, `yandexFolderId` and a per-provider
  `providerConsent` map: consent to one company never covers another.
- `api.openai.com` stays a regular host permission. DeepSeek and YandexGPT are
  `optional_host_permissions`, requested when the user picks the mode, so an
  update does not disable the extension for everyone with a new permission
  prompt. Without the permission a request fails before it is sent. The Safari
  manifest lists them as regular host permissions, because Safari asks per site.
- The cache key starts with the provider and model, so switching services never
  shows another service's answer.
- `scripts/check-provider.js` measures a provider on real prompts before it is
  offered: how many answers pass `responseIssue` on the first try, latency and
  tokens. It needs the user's own keys and is not part of CI.

## Consequences

- Adding another OpenAI-compatible service means one entry in `providers.js`, a
  host permission, its texts and price tag, a privacy policy section and a
  `check-provider.js` run; no new request code.
- Price tags are estimates against the OpenAI one: DeepSeek is about twice,
  YandexGPT Lite about eight times the OpenAI cost at the October 2026 prices.
- Every new service must be named in `PRIVACY.md` with where it processes data.
- Provider logos in settings (`src/icons/providers/`) are the companies' own
  files, unchanged: OpenAI's Blossom from openai.com/brand (black, and white for
  the dark theme), DeepSeek's mark from its own CDN. OpenAI's guidelines apply:
  no recolouring or distortion, never larger than Sensemark's own name, no
  implied endorsement. A service without an official file keeps a letter.
