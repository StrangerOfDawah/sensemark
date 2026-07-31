# Research notes

Date: 2026-07-31

The implementation keeps runtime dependencies at zero. The projects below were
examined for protocol and interaction patterns; their source was not copied.

## Platform and provider documentation

- [Chrome Manifest V3 service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/)
  confirms that global state is disposable and listeners must be registered at
  top level. This is why translations use `chrome.storage.session` rather than a
  service-worker `Map`.
- [Chrome context menus](https://developer.chrome.com/docs/extensions/reference/api/contextMenus)
  documents `OnClickData.selectionText` and `frameId`. Sensemark therefore uses
  the supplied text as authoritative and targets the originating frame.
- [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
  documents user-gesture opening and availability from Chrome 114. It is the
  fallback when a content script cannot run.
- [Chrome storage](https://developer.chrome.com/docs/extensions/reference/api/storage)
  documents session storage and storage access levels. Private settings are
  restricted to trusted extension contexts.
- [MDN Selection.getComposedRanges](https://developer.mozilla.org/docs/Web/API/Selection/getComposedRanges)
  provides a standards-based path for open Shadow DOM selections.
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
  describes strict JSON-schema responses and explicit refusal handling.
- [OpenAI streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
  informed the incremental SSE/delta contract.
- [OpenAI error codes](https://developers.openai.com/api/docs/guides/error-codes)
  and [rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
  informed normalized error categories and bounded pre-stream retry behavior.
- [Gemini structured output](https://ai.google.dev/gemini-api/docs/structured-output)
  and [Gemini API troubleshooting](https://ai.google.dev/gemini-api/docs/troubleshooting)
  were reviewed only to keep the provider boundary future-compatible. Gemini is
  not implemented or exposed in this release.

## Open-source implementations reviewed

- [rexxars/eventsource-parser](https://github.com/rexxars/eventsource-parser)
  (MIT): incremental line parsing, CR/LF handling, multi-line `data` events, and
  bounded parser state.
- [Azure/fetch-event-source](https://github.com/Azure/fetch-event-source)
  (MIT): abort propagation and the rule that retry policy must be separate from
  event parsing.
- [Chrome extension samples](https://github.com/GoogleChrome/chrome-extensions-samples)
  (Apache-2.0): passing context-menu selection through
  `chrome.storage.session` before opening a side panel.
- [MDN webextensions examples](https://github.com/mdn/webextensions-examples)
  (MPL-2.0): conservative selection/context-menu integration patterns.
- [Floating UI](https://github.com/floating-ui/floating-ui) (MIT): the
  `flip`/`shift` mental model for viewport-safe placement.
- [interact.js](https://github.com/taye/interact.js) (MIT): pointer-capture and
  frame-batched dragging patterns.
- [Continue](https://github.com/continuedev/continue) (Apache-2.0): keeping
  provider-specific request/response logic behind a registry.

## Adopted decisions

- Implement a small SSE parser locally because only OpenAI `data:` events are
  required and adding a package would be disproportionate.
- Implement placement and drag helpers locally with Pointer Events,
  `setPointerCapture`, `requestAnimationFrame`, viewport clamping, and a
  double-click reset.
- Use strict structured output for contextual and multilingual modes; use plain
  text deltas for ordinary text translation.
- Allow at most one retry, only before any response delta is shown and only for
  a narrow transient-error set. There is no format-repair request.
- Treat future providers as registry entries that receive the same
  `TranslationRequest` and return the same `TranslationResult`.
- Pin Playwright 1.62.1 (Apache-2.0) as a development-only dependency for the
  persistent-context extension smoke suite. It is never shipped in the
  production ZIP and all provider traffic is intercepted with local fixtures.
- Use Info-ZIP 3.0 with fixed timestamps, normalized permissions, sorted paths,
  maximum deflate compression, and `-X` metadata stripping for reproducible
  production archives. Reproducibility is supported on the Ubuntu 24.04 CI
  environment documented in `scripts/verify-reproducible-build.js`.
