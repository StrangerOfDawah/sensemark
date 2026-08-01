# Sensemark v1.4.2 browser acceptance

Release gate: **BLOCKED — real Chrome acceptance not executed**.

The project may produce a release-candidate ZIP while this gate is blocked. It
must not be described as store-ready, and PR #4 must remain a draft.

## Three distinct levels of evidence

These are never conflated. Only the third can lift the gate.

| Level | Command / method | Proves | Result |
| --- | --- | --- | --- |
| Unit / integration | `npm test` (Node, jsdom, mocked Chrome APIs) | Module contracts, ordering, state machines | 193 passed, 0 failed |
| Automated Chromium smoke | `npm run test:browser:auto` (Playwright, intercepted provider) | Extension loads, content-script and card behaviour in a real renderer | 18 passed, 0 failed, 0 skipped, 0 console errors |
| **Real Chrome manual acceptance** | Human operator, stable Chrome 119+ | Native context menus, transient user activation, built-in PDF Viewer, Side Panel UI | **Not executed** |

Node, jsdom and mocked Chrome APIs cannot model Chrome's transient user
activation. Playwright cannot drive native context menus, the built-in PDF
Viewer, or the Side Panel UI. Neither is evidence for the third level.

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

Local result: **18 passed, 0 failed, 0 skipped**, Chrome for Testing 151 on
macOS; service worker/page console errors: **0**. CI repeats the suite on
Ubuntu 24.04 / Node 24.

## Implemented model under test

- Panel model is **strictly tab-specific**. Global default panels are not
  supported for request delivery.
- The request controller checks tab configuration **before** creating pending
  state, before announcing a binding and before `sidePanel.open()`. An
  unconfigured tab returns `PANEL_NOT_CONFIGURED` and creates nothing.
- Configuration happens only on lifecycle events and at service-worker module
  initialisation. The request controller never calls `setOptions()`.
- Panel identity comes only from `port.sender.tab` or the stable per-tab URL
  token `sidepanel/sidepanel.html?tab=<tabId>`. Untokenized instances cannot
  claim requests.
- `sidePanel.open()` is the only extension API on the user-action path.

## Why the manual gate was not executed

The acceptance operator must be a human with a real Chrome window. The
automation available to this project cannot perform it:

- `chrome://extensions` is unreachable from browser automation (navigation
  resolves to an error page), so **Load unpacked** cannot be driven; the file
  picker it opens is a native OS dialog, not page content.
- Native right-click context menus are OS-level UI, not DOM, so the
  "Перевести выделенное" item cannot be invoked programmatically.
- Chrome's built-in PDF Viewer selection and its context menu are likewise
  native.
- The Side Panel is browser UI, not a tab document; its DevTools console and
  the service-worker console cannot be read by automation.

No scenario below may be marked `Passed` on the strength of automated tests.

## Manual Chrome 119+ acceptance

Before starting, record:

| Field | Value |
| --- | --- |
| Tested commit | *not recorded* |
| Production ZIP SHA-256 | *not recorded* |
| Source ZIP SHA-256 | *not recorded* |
| Chrome version | *not recorded* |
| Operating system | *not recorded* |
| Extension ID | *not recorded* |
| Test date | *not recorded* |

Every row carries: status, Chrome version, OS, steps, actual result, evidence,
notes. `Chrome`/`OS`/`Actual`/`Evidence` stay `—` until executed.

### A. Configuration hydration

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | Existing tabs hydrated after worker start | Load unpacked production build; open several ordinary tabs; terminate the service worker from `chrome://extensions`; wake it | Existing eligible tabs become configured; each panel path is `sidepanel/sidepanel.html?tab=<tabId>`; no request-time `setOptions()`; no unhandled rejection | Not tested | — | — | — | — | Hydration runs at module init, not only `onStartup` |
| A2 | Hydration does not block the gesture | Invoke immediately after worker wake on a configured tab | The handler does not await hydration; the panel opens | Not tested | — | — | — | — | |
| A3 | Early click during hydration | Invoke before hydration reaches the tab | `PANEL_NOT_CONFIGURED` retry hint; no global panel; no pending record; no binding; no provider request; retry after hydration succeeds | Not tested | — | — | — | — | |
| A4 | Configuration failure is typed | Force a `setOptions()` failure for one tab | Tab stays unconfigured; error is typed and visible | Not tested | — | — | — | — | |

### B. Ordinary pages

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| B1 | Content-script path | Select foreign text on an ordinary HTTPS page; invoke Sensemark | Inline card flow works; the Side Panel is not opened | Not tested | — | — | — | — | |
| B2 | Content script unavailable | Trigger where the content script cannot answer after the async delivery attempt | `CONTENT_SCRIPT_UNAVAILABLE`; no delayed `sidePanel.open()`; clear retry message; no pending record; no unhandled rejection | Not tested | — | — | — | — | Do not claim activation survives the async round trip unless demonstrated |

### C. Built-in Chrome PDF Viewer

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C1 | Non-Cyrillic foreign text | Open a text PDF in the built-in viewer; select; native context menu; invoke | `sidePanel.open({tabId})` succeeds; correct tab-specific panel; URL carries the right tab token; exact text arrives; one translation; pending consumed; no stale record | Not tested | — | — | — | — | Must be the built-in viewer, not an embedded renderer |
| C2 | `Як справи?` (Ukrainian) | As C1 | Not skipped as Russian; panel opens; translation starts; consumed once | Not tested | — | — | — | — | |
| C3 | `Добар дан` (Serbian) | As C1 | As C2 | Not tested | — | — | — | — | |
| C4 | `Как си` (Bulgarian) | As C1 | As C2 | Not tested | — | — | — | — | |
| C5 | `Сәлем` (Kazakh) | As C1 | As C2 | Not tested | — | — | — | — | |
| C6 | `Кыргыз тили` (Kyrgyz) | As C1 | As C2 | Not tested | — | — | — | — | |
| C7 | `Добры дзень` (Belarusian) | As C1 | As C2 | Not tested | — | — | — | — | |
| C8 | Confidently Russian text | Select a full Russian sentence; invoke | Matches the implemented policy: skipped before opening, **or** panel opens and reports the text is already Russian. Record which | Not tested | — | — | — | — | Non-Russian Cyrillic must never be lost to satisfy this |

### D. Strict tab-specific model

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| D1 | Token present | Open a configured panel; inspect its document URL | URL contains a valid stable tab token | Not tested | — | — | — | — | |
| D2 | Untokenized panel | Reach `sidepanel/sidepanel.html` with no token | `PANEL_NOT_CONFIGURED`; cannot claim; no identity via active tab; none via window binding; no availability push; clear close-and-retry instruction | Not tested | — | — | — | — | |
| D3 | No global fallback | Invoke on an unconfigured tab | No global default panel opens; `PANEL_NOT_CONFIGURED`; no pending state or binding | Not tested | — | — | — | — | Confirm with real Chrome, not mocks |

### E. Isolation and concurrency

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| E1 | Two-tab isolation | Configure tabs A and B in one window; request in each | Each panel receives only its own text; neither consumes the other's; nothing stranded | Not tested | — | — | — | — | Repeat while switching rapidly |
| E2 | Tab switch during READY/CLAIM | Request in A; switch to B before handoff completes; wait; return to A | A stays with A; B never receives A; active-tab state does not redefine identity; delivered at most once | Not tested | — | — | — | — | Keep the worker console open |
| E3 | Rapid same-tab requests | Two or three selections rapidly in one tab | Newest wins; older cannot be claimed; no empty final state; exactly one translation; no stale overwrite | Not tested | — | — | — | — | |
| E4 | Rapid same-tab after restart | Repeat E3 after terminating and restarting the worker | As E3 | Not tested | — | — | — | — | |

### F. Worker restart

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| F1 | Pending before restart | Create a pending request; terminate the worker before claim; let Chrome revive it | The request remains claimable exactly once | Not tested | — | — | — | — | |
| F2 | New request after restart | Leave an old pending record; restart; make a new request in the same tab | The new request supersedes the old; durable generation ordering holds; the old cannot be translated; the new is delivered once | Not tested | — | — | — | — | |
| F3 | Binding persistence | Exercise requests in several tabs/windows before restart | Bindings recover the latest logical identity; an older delayed write cannot reappear; no binding authorizes an untokenized panel | Not tested | — | — | — | — | |

### G. Failure and timeout

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G1 | Genuine `sidePanel.open()` failure | Force a real opening failure | `PANEL_OPEN_FAILED`; pending cleaned per policy; later requests unaffected | Not tested | — | — | — | — | |
| G2 | Handoff failure | Force a failed handoff | `PANEL_HANDOFF_FAILED`; no blank panel | Not tested | — | — | — | — | |
| G3 | Handoff timeout | Force a handoff that never completes | `PANEL_HANDOFF_TIMEOUT`; visible message; retries stop; no infinite retry | Not tested | — | — | — | — | |
| G4 | Tab closed before claim | Close the originating tab mid-handoff | Pending removed; nothing stale delivered later | Not tested | — | — | — | — | |
| G5 | Configuration failure | Force a `setOptions()` failure, then request | `PANEL_NOT_CONFIGURED`; not collapsed into a generic error | Not tested | — | — | — | — | |
| G6 | Panel closed during translation | Close the panel mid-stream | Request cancelled cleanly; no unhandled rejection | Not tested | — | — | — | — | |

### H. Console audit

| # | Scenario | Steps | Expected | Status | Chrome | OS | Actual | Evidence | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| H1 | Service-worker console | Watch during every scenario above | Zero unexplained errors; zero unhandled rejections; warnings documented and classified | Not tested | — | — | — | — | |
| H2 | Side Panel console | Watch during every scenario above | As H1 | Not tested | — | — | — | — | |
| H3 | Page console | Watch during ordinary-page scenarios | As H1 | Not tested | — | — | — | — | |

## Operator runbook

```bash
# 1. Clean verification and artifacts
npm ci && npm test && npm run check && npm run test:coverage
npm run test:browser:auto
npm run package:extension && npm run package:source
npm run verify:reproducible && npm run verify:artifacts

# 2. Record identity
git rev-parse HEAD
shasum -a 256 dist/sensemark-v1.4.2.zip dist/sensemark-v1.4.2-source.zip

# 3. Unpack the PRODUCTION build (not the source repo)
rm -rf /tmp/sensemark-accept && mkdir -p /tmp/sensemark-accept
unzip -q dist/sensemark-v1.4.2.zip -d /tmp/sensemark-accept
```

Then, in a separate Chrome profile: `chrome://extensions` → enable Developer
mode → **Load unpacked** → select `/tmp/sensemark-accept`. Record the extension
ID. Open the service-worker console and the Side Panel DevTools console, then
work through sections A–H, filling in every column.

Change a row to `Passed` only after observing it yourself. Remove the blocking
status only when every row in A–H is `Passed`.

## Provider/account checks

Real provider account/model compatibility, billing, quota and platform-specific
network behavior are manual-only and must use a restricted test key. They are
not part of automated acceptance and are currently not tested.
