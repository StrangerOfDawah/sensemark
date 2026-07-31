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
6.746 seconds with Chrome for Testing 151 on macOS (`darwin 25.5.0`); service
worker/page console errors: **0**. The final CI run repeats the suite on the
documented Linux/Node 24 environment. Machine-readable results and screenshots
are recorded in `dist/browser-results.json` and `dist/browser-evidence/` in the
CI verification artifact because generated `dist/` output is intentionally
excluded from the source archive.

For non-Cyrillic direct fallbacks, pending storage, `setOptions()`, and
`sidePanel.open()` are invoked synchronously and in order before any of their
promises is awaited. Cyrillic text deliberately waits for trusted
`chrome.i18n.detectLanguage()` preflight so confident Russian never opens a
panel. Whether Chrome retains user activation across that unavoidable
preflight remains part of the manual gate and is not claimed by the automated
suite.

## Manual Chrome 119+ acceptance

Record the Chrome version, operating system, build hash, exact steps, console
output and screenshots for every row. `Not tested` blocks store publication.

| Scenario | Steps | Expected | Actual | Status | Evidence |
| --- | --- | --- | --- | --- | --- |
| Built-in PDF Viewer side panel | Open a text PDF in Chrome, select foreign text, choose Sensemark from the context menu | Correct tab panel opens; selected text is consumed once; one translation starts | Not executed | Not tested | None |
| Protected/unavailable overlay | Trigger context-menu translation where a content overlay cannot run | Direct fallback opens the correct panel without a provider call before open | Not executed | Not tested | None |
| Two-tab isolation | Trigger different selections in two tabs | Each panel consumes only its own tab/frame/request state | Not executed | Not tested | None |
| Failed panel opening | Cause a controlled real `sidePanel.open()` failure, then issue a valid request | Failed pending state is deleted; stale text never appears; later request works | Not executed | Not tested | None |
| Russian direct fallback | Select confidently Russian text in the PDF/protected path | No panel, pending state, cache entry or provider request | Not executed | Not tested | None |
| Worker restart between store and consume | Terminate/restart the worker before panel consumption | Request is translated at most once | Not executed | Not tested | None |
| User-activation timing | Inspect context-menu → language preflight → storage → setOptions → open in real Chrome | `sidePanel.open()` succeeds without a user-gesture error | Not executed | Not tested | None |
| Console audit | Inspect service-worker and side-panel consoles for all scenarios | No critical errors | Not executed | Not tested | None |

## Provider/account checks

Real provider account/model compatibility, billing, quota and platform-specific
network behavior are manual-only and must use a restricted test key. They are
not part of automated acceptance and are currently not tested.
