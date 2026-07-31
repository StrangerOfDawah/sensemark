# Sensemark v1.4.2 release-readiness remediation

Remediation date: 2026-07-31

This document records the release-candidate behavior of the v1.4.2 source tree. The
universal modular architecture remains intact; the review fixes harden its
security, request correctness, selection lifecycle, side-panel isolation, and
UI behavior.

## Preserved architecture

- Runtime remains dependency-free Manifest V3 JavaScript split into small UMD
  modules that Chrome loads directly and Node tests through CommonJS.
- There is one provider registry and one active OpenAI provider.
- Text mode uses plain SSE deltas. Contextual and multilingual modes use one
  strict Structured Output response. There is no marker protocol and no repair
  request.
- Content scripts never receive private settings or the API key.
- The selection pipeline remains native-first, site-neutral, frame-aware, and
  free of hostname, selector, font, or custom-attribute branches.
- Request cancellation stays scoped by surface/tab/frame through
  `AbortController`.
- Translation cache and side-panel handoff remain in `chrome.storage.session`.

## Security and privacy decisions

- Form selection uses the explicit input allowlist `text`, `search`, `url`,
  `tel`, and `email`. Password fields return
  `{status: "unsupported", reason: "password-field"}` before text is read.
- The same password guard applies to automatic/button selection, content
  delivery, and the all-frame keyboard shortcut. Password text is never logged.
- `chrome.storage.local` is restricted to trusted extension contexts. Content
  scripts receive only public selection/UI settings.
- Privacy consent is version 2 and settings schema is version 3. Previous
  disclosure consent is reset by migration.
- Unicode normalization preserves ZWNJ/ZWJ, Arabic/Indic marks, and emoji
  sequences; it removes soft hyphen and directional controls and replaces NBSP.

## Language and mode policy

`chrome.i18n.detectLanguage()` is combined with Unicode script groups,
language-specific negative signals, and technical-token analysis. Translation
is skipped only for a reliable high-confidence `ru` result without a known
non-Russian signal. Unreliable, empty, or failed detection translates on doubt.

Han plus Kana is one Japanese group; Han plus Hangul is one Korean group; Han
alone is CJK. Technical Latin identifiers in Russian do not create a
multilingual request. Contextual mode applies to selections up to 12 words and
160 code points, even when no context is available, so popup and side panel use
the same rule.

The target-language contract is the stable code `ru`.

## Result and provider contracts

Contextual Structured Output requires:

```text
kind: translation | reference
translation: string
alternatives: string[0..4]
category: "" | name | title | brand | username | typo | unknown_term
explanation: string
```

Multilingual output remains structured by meaningful script/language spans.
Popup, side panel, and the content card use `shared/result-renderer.js`.

Every provider supplies `id`, `displayName`, `capabilities`,
`validateConfiguration`, `translate`, `normalizeError`, and
`settingsDescriptor`. API-key/model validation calls the provider's model
metadata endpoint and never invokes the production translator, prompt, or
translation cache. Only provider-allowlisted models return `verified`;
existing custom models return `unverified` because this endpoint does not prove
streaming or strict Structured Output support.

## Streaming and retries

- The SSE parser exposes `feed()`, `finish()`, and `reset()`. `finish()` flushes
  a final event without a blank line.
- A text stream succeeds only after both `finish_reason: "stop"` and `[DONE]`.
- Contextual and multilingual JSON is parsed only after `finish_reason: "stop"`.
- `length`, `content_filter`, missing `[DONE]`, missing/unknown finish reason,
  malformed JSON, and empty output are distinct errors.
- UTF-8 decoding uses one streaming `TextDecoder`, so split multibyte sequences
  remain intact.
- Output-token limits are calculated from source length and mode.
- One logical translation is issued. The transport may retry at most once
  before a response/first delta; stream failures are never automatically
  retried.

## Selection and context

Intent stores a snapshot with normalized text, source type, approximate rect,
frame identity, key, and creation time. After the stability delay, selection is
read again and must match. A 1500 ms location-aware dedupe cooldown suppresses
duplicate intent while allowing the same text elsewhere or after cooldown.

Copy only cancels pending intent. It does not close the card or abort streaming.
Trigger-button hiding is separate from timer cancellation. Pointerdown,
selection changes, invalid/collapsed selection, Escape, and a replacement
intent hide the old trigger.

Context is at most 800 code points from a container bounded to 2000 code points.
Up to eight ancestors are inspected: semantic blocks win, then the nearest
block-level element, then a bounded inline parent. It must contain the selected
occurrence; repeated terms use the current Range offset. Missing selection
returns `null`. `body`, `main`, oversized containers, and roots with many
unrelated block branches are rejected.

Fallback traversal is scoped to the current Range/common ancestor and stops at
2000 nodes, 25 ms, or 5000 code points. Visibility results are cached, hidden
ancestors are respected, and block/`br` boundaries are preserved. StaticRange
objects are converted to live Range objects. Scored fallback candidates expose
confidence and must pass a minimum threshold. Normalized duplicates are removed
before scoring while paragraph-boundary differences remain distinct.

## Card lifecycle

- Structured/slow results show a compact loading card only after 150 ms.
- Stream deltas are rAF-batched, but placement happens once; delta flushes do
  not reposition the card.
- A throttled `ResizeObserver` coalesces content growth into one animation-frame
  positioning pass. Anchored cards return to the selection and clamp; manually
  dragged cards keep their coordinates and only clamp overflow. Close
  disconnects the observer.
- Stored size is clamped to the current viewport, including viewports smaller
  than the nominal minimum.
- Scale uses CSS variables for all typography, spacing, controls, and handles;
  it does not use `transform: scale()`.
- Escape closes trigger/loading/stream/result/error UI and aborts only the
  card's active request.
- Copy leaves the card and request intact.
- External click and scroll intentionally do not close or reposition a manually
  dragged card. Window resize clamps it; a non-manual card returns to anchored
  placement. Frame unload/disconnect cancels its request.
- The dialog, buttons, resize handle, focus state, live-region behavior, and
  reduced-motion mode have explicit accessibility semantics.

## Side panel

### Handoff protocol

The panel never learns its **request** from its URL. The only thing the URL
carries is the panel's own tab id, assigned on tab lifecycle events.

Delivery is a ready/claim handshake over the long-lived
`sensemark.sidepanel` port:

1. The context-menu handler validates the selection and prepares a request,
   assigning a monotonic `sequence` synchronously.
2. `handoff.announce()` records the intent and the window→tab binding
   **synchronously**, before any await.
3. `sidePanel.open({tabId})` is started on the user-gesture stack. It is the
   only extension API on that path. The atomic storage replacement is started
   in the same task and deliberately allowed to settle last.
4. The panel resolves its own window with `chrome.windows.getCurrent()`, reads
   its tab token, and sends `sidepanel.ready`.
5. The worker answers `sidepanel.request` (claimed), `sidepanel.request.waiting`
   (announced but not yet stored), or `sidepanel.idle` (a manual open, or a tab
   that could not be positively identified).
6. When the write lands, the worker pushes `sidepanel.request.available` and the
   panel claims immediately.
7. The panel independently retries every 150 ms for at most 2 s. Retries are
   always bounded.
8. A claim is single-use; the record is removed on read behind an in-memory
   guard, so exactly one translation starts.
9. A `waiting` handoff that never arrives ends in a visible typed error rather
   than a blank panel.

Because the intent is registered synchronously and the panel retries, **no
ordering between the storage write, `open()` and panel initialisation can lose
or duplicate a request**, and `setOptions()` is not in that ordering at all.

### Panel model: tab-specific

Sensemark uses a **tab-specific** side panel, never a global one. Every tab is
configured with the same document, `sidepanel/sidepanel.html`, carrying one
stable query parameter: the tab's own id.

Configuration happens on `tabs.onActivated`, `tabs.onUpdated`,
`runtime.onInstalled` and `runtime.onStartup` — never in the context-menu
handler. `sidePanel.open()` is consequently the only extension API on the
user-action path, so `setOptions()` cannot race it.

The three failure kinds are distinct:

- **configuration failed** — reported as `configurationError`, never fatal,
  never deletes pending state;
- **opening failed** — `open-failed`; pending state is cleaned, unless a panel
  for that scope is already connected, in which case the result is
  `open-failed-panel-available` and the request stays claimable;
- **handoff failed** — the panel's bounded retry expires and it shows a typed
  error.

### Tab identity

A panel cannot read its own tab id, and "whichever tab is active right now" is
not that tab: the user can switch tabs between `open()` and READY, and two
panel documents can briefly coexist in one window. Identity resolves through a
deterministic ladder, heuristics last:

1. `port.sender.tab` when Chrome supplies it — never assumed to exist.
2. The stable per-tab token in the panel URL. Tab identity only, assigned on
   tab lifecycle events, never request identity.
3. The worker's open binding for that window, recorded at `open()` time and
   persisted in `chrome.storage.session` so it survives a worker restart.
4. The active tab — accepted only when it actually owns a pending record.

If nothing positively identifies a tab, the panel is told it is idle. A request
is never claimed by window alone.

### Same-tab replacement

Records carry `tabId`, `frameId`, `requestId`, `windowId`, a monotonic
`sequence` and a five-minute TTL.

Replacement is a single atomic `state.replace()` behind a per-tab lock. It is
never `store()` followed by an independent `supersede()` scan: two concurrent
opens could interleave as store(A), store(B), A-removes-B, B-removes-A and
leave the tab with nothing claimable at all.

The policy is **newest-wins by sequence**, not by promise completion order. The
sequence is assigned synchronously in `prepare()`, in the order the user acted.
Inside the lock, an older request that has already lost declines to store
rather than deleting the winner. An already-running translation is superseded
through the existing request coordinator, so a stale result can never replace a
newer one.

A service-worker restart is safe: intents are in-memory only, but the pending
record and the window binding both live in `chrome.storage.session`, so the
panel still claims exactly once. A panel reload finds nothing left to claim and
stays idle.

### User activation and the Russian preflight

`sidePanel.open()` must run on the user-gesture stack. v1.4.2 awaited
`chrome.i18n.detectLanguage()` before opening for every Cyrillic selection,
which drops Chrome's transient activation and would fail Ukrainian, Bulgarian,
Serbian and Kazakh requests.

The preflight is now **synchronous and conservative**
(`synchronousRussianVerdict`). There is deliberately **no rule where a single
character or a small character class yields a confident verdict**: `ы`, `э` and
`ё` all occur in Kazakh, Belarusian, Kyrgyz and Mongolian, and an earlier
version that trusted them wrongly skipped "Сынып", "Добры дзень", "Кыргыз
тили", "Бул жакшы", "Энэ текст" and "Мына сынып".

"russian" now requires **all** of:

- no known non-Russian Cyrillic signal;
- no mixed independent language groups;
- at least 16 Cyrillic code points;
- at least 3 Cyrillic words;
- at least 2 distinct Russian-only function words
  (`что`/`это`/`который`/`если`/`сейчас`/… — words the neighbouring languages
  render differently).

Everything else is "uncertain" and opens the panel. Short Cyrillic always stays
uncertain. The full asynchronous `chrome.i18n` policy still runs inside the
translation service, so Russian text that slips past the sync check opens a
panel that reports "Текст уже на русском." without any provider call. No
provider or network call is used for the preflight.

This is the documented tradeoff: an occasional unnecessary panel for Russian
text is accepted in exchange for never losing a valid non-Russian request.

Restricted schemes and PDF URLs take the direct context-menu fallback path.
Delivery distinguishes `accepted`, `skipped-russian`, `unsupported`,
`no-selection`, `duplicate`, and `content-script-unavailable`.

The minimum supported Chrome version is 119.

## Error and cache contracts

Errors expose code, safe user message, provider ID/code, HTTP status,
retryability, retry delay, settings relevance, and UI action. Invalid key,
permission, missing model, rate limit, quota, network, three timeout phases,
service unavailability, invalid/interrupted/truncated/filtered output, consent,
configuration, unsupported selection, cancellation, and unknown errors remain
distinct.

Cache identity includes provider, model, prompt version, response protocol
version, mode, target, source text/scripts/language, context, and semantic hint.
Cache hits update in-memory LRU metadata and do not rewrite the full session
cache immediately.

## Verification boundary

Automated tests use deterministic providers and never contact OpenAI. Source
validation, syntax validation, unit/integration tests, coverage, packaging, and
archive validation are reproducible through the commands in
`docs/RELEASING.md`. Real-Chrome checks must be recorded separately and must not
be claimed from Node/jsdom results.

## Release engineering boundary

- CI uses Node.js 24 LTS and the repository validators rather than obsolete
  root-path shell assertions.
- Production packaging is deterministic on the documented Ubuntu 24.04 /
  Info-ZIP 3.0 environment and verified from two independent source copies.
- Coverage is explicitly targeted to the 17 critical modules printed by
  `npm run coverage:scope`; its percentage is never described as whole-runtime.
- Playwright is pinned as a development-only Apache-2.0 dependency. Browser
  smoke responses are intercepted locally and never contact OpenAI.
- `BROWSER_ACCEPTANCE.md` blocks store publication until built-in Chrome PDF
  and real side-panel user-activation checks pass.
