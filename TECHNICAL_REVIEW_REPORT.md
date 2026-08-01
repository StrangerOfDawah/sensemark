# Sensemark v1.4.2 release-readiness report

Remediation date: 2026-07-31

## Release status

**Release candidate — browser acceptance pending.**

The source, automated tests, browser smoke infrastructure, release workflow,
and packaging controls are ready for a final immutable-commit CI run. Chrome
Web Store publication remains blocked until every real-Chrome row in sections
A–H of `BROWSER_ACCEPTANCE.md` is executed and passes. Node, jsdom, mocked
Chrome APIs, and Playwright's bundled Chromium are not presented as proof of
that manual gate.

The manual gate has **not** been executed. It requires a human operator with a
real Chrome window: `chrome://extensions` is unreachable from browser
automation, and native context menus, the built-in PDF Viewer and the Side
Panel UI are browser/OS chrome rather than page content.

CI identifiers, immutable commit SHA, downloaded artifact hashes, and the final
external `sensemark-v1.4.2-SHA256SUMS.txt` contents are reported in the release
handoff after the final commit runs. They cannot be embedded here without
creating a self-referential commit/archive evidence cycle.

## Release metadata and environment

- Package and manifest version: `1.4.2`.
- Minimum Chrome version: `119`.
- Supported development and CI Node line: Node.js 24 LTS (`.nvmrc`,
  `engines.node`, and GitHub Actions agree).
- Expected source artifact: `sensemark-v1.4.2-source.zip`.
- Expected production artifact: `sensemark-v1.4.2.zip`.
- External checksum handoff: `sensemark-v1.4.2-SHA256SUMS.txt`.

## Fixed release-readiness defects

### Current GitHub Actions workflow

`.github/workflows/pr-build.yml` now installs locked dependencies on Ubuntu
24.04/Node 24, runs unit/integration tests, static validation, targeted
coverage, Chromium smoke tests, production/source packaging, deterministic
build verification, artifact verification, and current modular entry-point
checks. It calls `scripts/validate-extension.js` for the production ZIP and no
longer validates obsolete root-level popup or manual-translation paths.

Regression coverage: `tests/final-readiness.test.js` reads the workflow and
fails if obsolete paths return or required v1.4.2 commands disappear.

### Side-panel handoff race (fixed after the e3f5384 review)

Two reproducible races were confirmed in the reviewed commit and are now fixed.

**Race A — panel loaded before pending state was stored.** The controller started
`state.store()`, `setOptions()` and `open()` concurrently, and the panel then
performed exactly one pending lookup with no retry. When the panel won, it
received `null`, no translation started, and the record was orphaned in session
storage while the controller still reported `status: "opened"`.

**Race B — `open()` beat `setOptions()`.** Request identity lived in a
dynamically assigned side-panel query string, so a panel opened at the manifest
default path could not identify its request at all.

Both are removed structurally rather than by tuning timing:

- `setOptions()` always assigns the static path `sidepanel/sidepanel.html`;
  request identity never appears in the URL.
- The handoff intent is registered synchronously before any await, so a panel
  that is ready first is told to wait instead of concluding it is empty.
- The panel claims over the `sensemark.sidepanel` port, driven by both a worker
  push and a bounded 2 s / 150 ms retry.
- Claims are single-use and scoped strictly by tab identity, so two tabs and two
  windows stay isolated.
- Newest-wins supersession for repeat requests in one tab.
- A lost handoff ends in a visible typed error, never a blank panel.

Restricted schemes and PDF URLs still use the context-menu selection text
directly, and pending state is removed on failed opening, tab closure, expiry,
or successful claim.

### Same-tab request concurrency (fixed after the 3d991f7 review)

Replacement was `state.store()` followed by an independent `supersede()` scan.
Two concurrent opens in one tab interleaved as store(A), store(B), A-removes-B,
B-removes-A and left session storage **empty** — both translations lost. This
reproduced reliably.

Replacement is now a single atomic `state.replace()` behind a per-tab lock, and
every record carries a monotonic `sequence` assigned synchronously in
`prepare()`. Inside the lock an older request that has already lost the race
declines to store rather than deleting the winner, so the outcome follows the
order the user actually acted — not the order storage writes happen to resolve.
Verified for both interleavings, three rapid requests, and cross-tab
independence.

### Panel configuration model

Sensemark uses a **strictly tab-specific** side panel. Tabs are configured from
`runtime.onInstalled`, `runtime.onStartup`, `tabs.onCreated`,
`tabs.onActivated` and `tabs.onUpdated`, plus hydration at service-worker
module initialisation — never from the context-menu handler and never from the
request controller. `sidePanel.open()` is the only extension API on the
user-action path.

`setOptions()` therefore cannot race `open()`, and a configuration failure is
reported separately from an opening failure: a rejected `setOptions()` after a
successful `open()` no longer produces `open-failed` and no longer deletes
pending state. A rejected `open()` where a panel for that scope is already
connected returns `open-failed-panel-available` and keeps the request
claimable.

### Side-panel tab identity

Identity previously resolved through `tabs.query({active: true, windowId})`,
which returns whichever tab is active at claim time — not necessarily the tab
that originated the request. It then briefly resolved through the persisted
window binding, which still let an untokenized instance look tab-bound.

Sensemark uses a **strictly tab-specific** side panel. A panel document may be
bound to a tab by exactly two things, both of which identify the document itself:

1. `port.sender.tab` — used when Chrome supplies it, never assumed to exist.
2. The stable per-tab token the configurator placed in the panel URL.

There is no third source. A panel with neither is a legacy or global default
instance: it is **not** bound to any tab, it can never claim a tab-scoped
request, and it is told so with a typed `PANEL_NOT_CONFIGURED` error. Inferring
a tab from the window binding or the active tab is precisely what allowed a
global panel opened for tab A to look like tab B's panel and strand tab B's
request.

The persisted window→tab binding remains ordered, restart-safe diagnostic
metadata. It never establishes identity and never promotes an untokenized panel
into a supported one; neither does the active tab, which is not consulted at
all. If neither source identifies a tab, the panel is rejected.

### Strict tab-specific model

`chrome.sidePanel.open()` on an **unconfigured** tab can succeed by opening
Chrome's global default panel from the manifest. That instance escapes the
tab-scoped protocol: it stays bound to whichever tab it first served, so a
later request from another tab is never notified and remains pending forever.

The request controller therefore checks `isConfigured(tabId)` **before**
`state.prepare`/`state.replace`, before `handoff.announce`, and before
`sidePanel.open()`. An unconfigured tab returns
`{status: "not-configured", code: PANEL_NOT_CONFIGURED, retryable: true}` and
creates no pending record, no binding, no notification and no provider call.

Configuration hydration (`configureAll()`) starts during service-worker **module
initialisation**, not only in `runtime.onStartup` — that event fires once per
browser session, while the worker restarts many times within one. It is never
awaited on the user-action path, because awaiting it before `open()` would drop
transient user activation. `isConfigured(tabId)` is true only after Chrome
actually accepted `setOptions()` for the current stable path; "configuring" is
not "configured", and a failure leaves the tab unconfigured.

Global default panels are not supported for request delivery.

### Side-panel user activation

The Cyrillic path awaited `chrome.i18n.detectLanguage()` before
`sidePanel.open()`. That await drops Chrome's transient user activation, which
would fail Ukrainian, Bulgarian, Serbian and Kazakh requests.

**Option A (synchronous conservative preflight) was implemented**, then
tightened after review. The first version treated a single character (`ы`, `э`,
`ё`) as confident Russian, which wrongly skipped Kazakh, Belarusian and Kyrgyz
text — "Сынып", "Добры дзень", "Кыргыз тили", "Бул жакшы", "Энэ текст" and
"Мына сынып" were all classified Russian and their requests destroyed.

There is now no rule where a single character or a small character class yields
a confident verdict. "russian" requires all of: no non-Russian Cyrillic signal,
no mixed independent language groups, at least 16 Cyrillic code points, at
least 3 Cyrillic words, and at least 2 distinct Russian-only function words.
Everything else is "uncertain" and opens the panel. The full asynchronous
policy still runs in the translation service, so Russian text that passes the
sync check opens a panel reporting "Текст уже на русском." without a provider
call. No provider or network call is used for the preflight.

Real-Chrome verification could not be performed in this environment. Unit tests
assert call ordering only and are **not** presented as proof of real Chrome
activation.

### Honest coverage scope

`npm run test:coverage` is explicitly **Targeted core-module coverage**, not
whole-runtime coverage. `npm run coverage:scope` prints the resolved 18-file
critical include list and every excluded first-party runtime file. The current
physical-line scope is 4,046 of 6,260 runtime JavaScript lines (64.63%, including
comments and blank lines). Measured targeted coverage is 92.44% lines, 88.92%
functions, and 74.29% branches, against 80/85/70 thresholds. These are the
figures produced by the release CI run; a local run on the same commit produces
identical values.

### Verification boundary

Three distinct levels, never conflated:

| Level | Command | Result |
| --- | --- | --- |
| Unit/integration (Node, jsdom, mocked Chrome) | `npm test` | 193 passed, 0 failed |
| Automated Chromium smoke (Playwright, intercepted provider) | `npm run test:browser:auto` | 18 passed, 0 failed, 0 skipped, 0 console errors |
| Real Chrome 119+ manual acceptance | `BROWSER_ACCEPTANCE.md` | **Not executed — every row `Not tested`** |

The manual gate could not be executed by automation: `chrome://extensions` is
unreachable from browser automation, and native context menus, the built-in PDF
Viewer and the Side Panel UI are OS/browser chrome rather than page content. A
human operator with a real Chrome window is required; `BROWSER_ACCEPTANCE.md`
carries the runbook.

### Deterministic production ZIP

The production and source packaging scripts copy explicit allowlists to clean
staging directories, normalize directory/file permissions, fix all timestamps,
sort paths under `LC_ALL=C`, and run Info-ZIP with fixed compression and
extra-field stripping. `scripts/verify-reproducible-build.js` creates two
independent source copies, deliberately changes metadata in one, and requires
identical production and source archive bytes and SHA-256 values. The supported
reproducible environment is Ubuntu 24.04 with Info-ZIP 3.0 and Node 24.

### Multilingual prompt/schema consistency

The multilingual instruction names only `kind`, `text`, and `sections` with
section fields `script`, `source`, and `translation`. It does not mention
contextual-only alternatives, explanation, categories, marker protocols, or
repair requests. Its schema remains strict with `additionalProperties: false`.

### Browser acceptance infrastructure

Playwright 1.62.1 is pinned as an Apache-2.0 development-only dependency. The
persistent-context suite loads the unpacked MV3 extension, registers the
service worker, opens popup/options, verifies top-frame/iframe injection, uses
ordinary/nested/form/contenteditable selections, rejects password text, skips
reliable Russian, validates mocked streaming/card interaction, suppresses
duplicates, and proves a cache hit without a real OpenAI request.

Local macOS result: 18 passed, 0 failed, 0 skipped in 6.746 seconds with Chrome
for Testing 151; observed service-worker/page console errors: 0. Generated JSON
and screenshots are uploaded with CI verification evidence.

### Archive hashing and boundaries

Production packaging contains only runtime/user-facing files. Source packaging
contains the lockfile, workflow, tests, scripts, all runtime modules,
documentation, and store metadata while excluding `node_modules`, `coverage`,
`dist`, logs, temporary files, and previous archives. The checksum writer runs
only after both final archives exist; `verify:artifacts` validates both hashes,
versions, required source content, production exclusions, ZIP integrity, and
runtime entry paths.

## Preserved runtime contracts

The modular Manifest V3 architecture, provider registry, private/public settings
boundary, session cache, site-neutral native-first selection, form/password
handling, script/language policy, streaming/structured result modes,
cancellation/stale protection, card lifecycle, and tab/frame/request side-panel
isolation remain intact. Runtime dependencies remain zero. No analytics, OCR,
remote executable code, site-specific branch, marker protocol, response repair,
or hidden second model request was introduced.

## Automated verification snapshot

Current values. This report intentionally describes only the final
implementation; earlier snapshots (111 tests, a 14-file coverage scope, 91.26%
lines) are superseded and are not reproduced here.

- `npm test`: 193 passed, 0 failed, 0 skipped; exit 0.
- `npm run check`: 59 runtime files and extension metadata validated; exit 0.
- `npm run test:coverage`: 193 passed; see BROWSER_ACCEPTANCE.md for the
  three evidence levels; exit 0.
- `npm run test:browser:auto`: 18 passed, 0 failed, 0 skipped; console errors 0;
  exit 0.
- `npm run verify:reproducible`: two independent builds matched; exit 0.
- `npm run verify:artifacts`: both archives and checksums verified; exit 0.

## Current design statements

These are the single current answers; no alternative design is in force.

- **Panel model:** tab-specific. Tab-specific configuration occurs **only** on
  lifecycle events (`runtime.onInstalled`, `runtime.onStartup`,
  `tabs.onCreated`, `tabs.onActivated`, `tabs.onUpdated`). Global and
  tab-specific instances are never mixed.
- **The request controller does not call `setOptions()`.** `sidePanel.open()`
  is the only extension API on the user-action path.
- **Same-tab newest-wins survives a worker restart.** Ordering is
  `(generationId, sequence, createdAt)`, where `generationId` is a durable
  counter in session storage. A process-local sequence never lets a stale
  record defeat a fresh user action.
- **Persisted window bindings are ordered.** Writes are serialized per window
  and refuse to overwrite a newer binding; a failed write is typed and the
  stale stored binding is not trusted.
- **Identity order:** `port.sender.tab` → stable per-tab URL token. Nothing
  else. Untokenized panel instances cannot claim requests and receive a typed
  `PANEL_NOT_CONFIGURED` error.
- **Panel model is strictly tab-specific.** The request controller checks tab
  configuration before creating any handoff state; unconfigured tabs return
  `PANEL_NOT_CONFIGURED`. Global default panels are not supported for request
  delivery. Configuration hydration runs on every service-worker
  initialisation.
- **Ordinary-page asynchronous content-script failure is not guaranteed to
  retain user activation**, so it does not silently fall back to
  `sidePanel.open()`. It returns `CONTENT_SCRIPT_UNAVAILABLE` and asks the user
  to repeat the command. Recognisable protected contexts (PDF viewer,
  restricted schemes, Web Store, unknown URL) still open the panel directly
  with no awaited work in front of `open()`.

## Remaining gate

Real Chrome 119+ acceptance has **not** been executed. The built-in PDF
context-menu path, non-Russian Cyrillic in PDF, rapid same-tab requests before
and after a worker restart, tab switching during handoff, confirmation that the
opened instance is tab-specific, the ordinary-page content-script failure
behaviour, and the service-worker/side-panel console audit all remain
`Not tested` in `BROWSER_ACCEPTANCE.md`.

Until they pass, v1.4.2 must not be uploaded to the Chrome Web Store or
described as store-ready.
