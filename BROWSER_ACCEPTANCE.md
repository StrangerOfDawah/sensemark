# Sensemark v1.4.2 browser acceptance

Release gate: **BLOCKED — built-in PDF/user-activation acceptance not tested**.

The project may produce a release-candidate ZIP while this gate is blocked. It
must not be described as store-ready.

## Automated extension smoke suite

Command:

```bash
npm run test:browser:auto
```

Environment:

- Playwright 1.62.1 (Apache-2.0, development-only dependency);
- persistent Chromium context;
- unpacked extension loaded from the source root;
- deterministic local HTTP fixture server;
- intercepted `https://api.openai.com/*` responses;
- no real OpenAI request or key.

The suite writes `dist/browser-results.json` and screenshots under
`dist/browser-evidence/`. It covers extension/service-worker load, extension
pages, top-frame/iframe injection and selection, ordinary/nested/open-Shadow-DOM
selections, input/textarea/contenteditable, password rejection, automatic,
button and manual modes, copy suppression, local Russian skip, mock streaming,
card display/drag/resize/scale/Escape, replacement cancellation/stale-output
protection, duplicate suppression and cache reuse.

Local automated result on 2026-07-31: **18 passed, 0 failed, 0 skipped** in
7.347 seconds with Chrome for Testing 151 on macOS (`darwin 25.5.0`); service
worker/page console errors: **0**. The final CI run repeats the suite on the
documented Linux/Node 24 environment. Machine-readable results and screenshots
are recorded in `dist/browser-results.json` and `dist/browser-evidence/` in the
CI verification artifact because generated `dist/` output is intentionally
excluded from the source archive.

Unit/integration result on the same commit: **191 passed, 0 failed**.

The panel model is **strictly tab-specific**. `sidePanel.open()` is the only
extension API on the user-action path, for every script including Cyrillic, with
no awaited work in front of it. Panel configuration happens only on tab
lifecycle events and at service-worker module initialisation; an unconfigured
tab is rejected with `PANEL_NOT_CONFIGURED` before any handoff state is created,
and untokenized panel instances can never claim a request. The storage write is deliberately
allowed to settle afterwards and the panel claims its request over the
`sensemark.sidepanel` port. The Russian preflight is synchronous and
conservative.

This ordering is asserted by unit tests, but **Node and mocked Chrome APIs
cannot model Chrome's transient user activation**. Whether `sidePanel.open()`
actually succeeds from the context menu in the built-in PDF viewer remains a
manual gate and is not claimed by the automated suite. Playwright cannot drive
native context menus or the side panel, so the automated suite does not cover
the handoff end to end in a real browser either.

## Manual Chrome 119+ acceptance

Record the Chrome version, operating system, build hash, exact steps, console
output and screenshots for every row. `Not tested` blocks store publication.

| Scenario | Steps | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Built-in PDF Viewer side panel | Open a text PDF in Chrome, select non-Cyrillic foreign text, choose Sensemark from the context menu | Correct tab panel opens; selected text appears; one translation starts; no stale pending record | Not executed | Not tested | None |
| Non-Russian Cyrillic — Ukrainian | Select Ukrainian text, invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Non-Russian Cyrillic — Bulgarian | Select Bulgarian text, invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Non-Russian Cyrillic — Serbian | Select Serbian text, invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Non-Russian Cyrillic — Kazakh | Select Kazakh text (`Сынып`, `Сәлем`), invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Non-Russian Cyrillic — Belarusian | Select `Добры дзень`, invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Non-Russian Cyrillic — Kyrgyz | Select `Кыргыз тили`, invoke Sensemark | Panel opens and translation starts | Not executed | Not tested | None |
| Rapid same-tab requests | Trigger two translations rapidly in one tab | The newer request wins and is delivered once; neither request is deleted | Not executed | Not tested | None |
| Tab switch during handoff | Trigger in tab A, immediately switch to tab B | A's request is never delivered to B | Not executed | Not tested | None |
| Closed originating tab | Close the tab between request and claim | Pending request is removed; nothing stale is delivered later | Not executed | Not tested | None |
| Russian | Select confidently Russian text | Documented Option A behaviour: no panel for a confident synchronous verdict, otherwise a panel reporting "Текст уже на русском." with no provider call | Not executed | Not tested | None |
| Protected/unavailable overlay | Trigger context-menu translation where a content overlay cannot run | Direct fallback opens the correct panel without a provider call before open | Not executed | Not tested | None |
| Two-tab isolation | Trigger different selections in two tabs | Each panel claims only its own tab's request | Not executed | Not tested | None |
| Failed panel opening | Cause a controlled real `sidePanel.open()` failure, then issue a valid request | Failed pending state is deleted; stale text never appears; later request works | Not executed | Not tested | None |
| Worker restart between store and claim | Terminate/restart the worker before the panel claims | Request is translated at most once | Not executed | Not tested | None |
| New request after worker restart | Leave a pending request, terminate the worker, then make a fresh request in the same tab | The fresh request replaces the stale one and is the text that appears | Not executed | Not tested | None |
| Rapid same-tab requests after restart | Restart the worker, then trigger A, B and C rapidly in one tab | C wins; no empty state; no duplicate translation | Not executed | Not tested | None |
| Tab-specific instance | Inspect the opened panel URL and the service-worker call log | The document carries the correct `?tab=<id>` token, no global untokenized panel is used, and no `setOptions()` runs at request time | Not executed | Not tested | None |
| Hydration after worker start | Restart the service worker, then invoke from an existing tab without switching tabs first | Existing tabs are configured by module-init hydration; the request is delivered | Not executed | Not tested | None |
| Unconfigured tab | Invoke before hydration reaches a tab | `PANEL_NOT_CONFIGURED` retry hint; no global panel opens; no pending record remains | Not executed | Not tested | None |
| Untokenized panel | Open a legacy/global panel instance and trigger a request from a tab | The untokenized panel shows a typed configuration error and claims nothing; the tab's own panel receives the request | Not executed | Not tested | None |
| Ordinary-page content-script failure | Trigger on a page where the content script cannot respond | Documented policy: a retry hint appears and the panel is NOT silently opened after the awaited round trip | Not executed | Not tested | None |
| Handoff timeout | Force a handoff that never completes | Panel shows "Не удалось получить выделенный текст. Попробуйте ещё раз."; no blank panel; retries stop | Not executed | Not tested | None |
| Panel reload | Reload the side panel after a successful translation | The consumed request is not translated again | Not executed | Not tested | None |
| User-activation timing | Invoke from the context menu in the built-in PDF viewer and in an ordinary page, for Latin and Cyrillic text | `sidePanel.open()` succeeds without a user-gesture error | Not executed | Not tested | None |
| Console audit | Inspect service-worker and side-panel consoles for all scenarios | No unhandled rejection or runtime error | Not executed | Not tested | None |

## Provider/account checks

Real provider account/model compatibility, billing, quota and platform-specific
network behavior are manual-only and must use a restricted test key. They are
not part of automated acceptance and are currently not tested.
