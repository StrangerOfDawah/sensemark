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

### Side-panel user-action path

Restricted schemes and PDF URLs use the context-menu selection text directly;
they do not attempt a content-script round trip first and no provider request
occurs before opening. Pending state remains tab/frame/request scoped and is
removed on failed opening, tab closure, expiry, or successful consume.

For non-Cyrillic text, session storage, tab-specific `setOptions()`, and
`sidePanel.open()` are invoked synchronously in that order before any promise
is awaited. This removes avoidable async gaps from the user-action stack.
Cyrillic text first performs trusted browser language preflight so reliable
Russian does not open a panel, write pending/cache state, or call a provider.
That necessary preflight leaves a real-Chrome activation question and is why
the manual gate remains blocked.

Regression coverage includes Russian skip, non-Russian Cyrillic/doubt, sync
open invocation before setup settles, failed-open cleanup, two-tab/request
state identity, and consume-once semantics.

### Honest coverage scope

`npm run test:coverage` is explicitly **Targeted core-module coverage**, not
whole-runtime coverage. `npm run coverage:scope` prints the resolved 14-file
critical include list and every excluded first-party runtime file. The current
physical-line scope is 2,883 of 4,918 runtime JavaScript lines (58.62%, including
comments and blank lines). Measured targeted coverage is 91.26% lines, 88.70%
functions, and 74.89% branches, against 80/85/70 thresholds.

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
