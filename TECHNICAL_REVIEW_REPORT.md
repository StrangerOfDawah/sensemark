# Sensemark v1.4.2 release-readiness report

Remediation date: 2026-07-31

## Release status

**Release candidate — browser acceptance pending.**

The source, automated tests, browser smoke infrastructure, release workflow,
and packaging controls are ready for a final immutable-commit CI run. Chrome
Web Store publication remains blocked until the real-Chrome built-in PDF and
side-panel user-activation matrix in `BROWSER_ACCEPTANCE.md` is executed. Node,
jsdom, mocked Chrome APIs, and Playwright's bundled Chromium are not presented
as proof of that manual gate.

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
- Claims are single-use, scoped by sender tab → active tab of the panel's window
  → window, so two tabs and two windows stay isolated.
- Newest-wins supersession for repeat requests in one tab.
- A lost handoff ends in a visible typed error, never a blank panel.

Restricted schemes and PDF URLs still use the context-menu selection text
directly, and pending state is removed on failed opening, tab closure, expiry,
or successful claim.

### Side-panel user activation

The reviewed commit awaited `chrome.i18n.detectLanguage()` before
`sidePanel.open()` for every Cyrillic selection. That await drops Chrome's
transient user activation, which would fail Ukrainian, Bulgarian, Serbian and
Kazakh requests — the exact case the language policy exists to serve.

**Option A (synchronous conservative preflight) was implemented.** Only a
confident synchronous Russian verdict skips opening; every other selection
reaches `open()` on the gesture stack with no awaited work in front of it. The
full asynchronous policy still runs in the translation service, so Russian text
that passes the sync check opens a panel reporting "Текст уже на русском."
without a provider call.

This tradeoff was chosen because real-Chrome verification could not be
performed in this environment, and the stated decision priority puts never
losing a valid non-Russian request above avoiding an unnecessary Russian panel.
Unit tests assert call ordering only and are **not** presented as proof of real
Chrome activation.

### Honest coverage scope

`npm run test:coverage` is explicitly **Targeted core-module coverage**, not
whole-runtime coverage. `npm run coverage:scope` prints the resolved 16-file
critical include list and every excluded first-party runtime file. The current
physical-line scope is 3,368 of 5,446 runtime JavaScript lines (61.84%, including
comments and blank lines). Measured targeted coverage is 91.33% lines, 88.17%
functions, and 74.47% branches, against 80/85/70 thresholds.

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

- `npm test`: 111 passed, 0 failed, 0 skipped; exit 0.
- `npm run check`: 55 runtime files and extension metadata validated; exit 0.
- `npm run test:coverage`: 111 passed; 91.26% lines, 88.70% functions,
  74.89% branches in the disclosed 14-file scope; exit 0.
- `npm run test:browser:auto`: 18 passed, 0 failed, 0 skipped; console errors 0;
  exit 0.
- `npm run verify:reproducible`: two independent builds matched; exit 0.

The final handoff supersedes this snapshot with the exact clean-source Node 24
and GitHub Actions results, artifact sizes/counts, and hashes.

## Remaining gate

The built-in Chrome PDF context-menu path, real protected-page fallback,
two-tab panel UI, controlled real opening failure, Russian direct fallback,
worker restart between store/consume, and side-panel/service-worker console
audit have not been executed in real Chrome. Until all pass, v1.4.2 must not be
uploaded to the Chrome Web Store or described as store-ready.
