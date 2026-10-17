# Releasing

A release produces two artifacts from the same tagged commit:

| Asset                         | For                                                            |
| ----------------------------- | -------------------------------------------------------------- |
| `sensemark-vX.Y.Z.zip`        | Chrome Web Store upload and "Load unpacked" (`manifest.json` at the zip root) |
| `sensemark-safari-vX.Y.Z.zip` | Safari on macOS, built locally with Xcode (see [platforms/safari](../platforms/safari/README.md)) |

## 1. Prepare

- The working tree contains only release changes.
- The version matches in `src/manifest.json`, `package.json` and
  `package-lock.json` (a test checks this).
- `CHANGELOG.md` has a section for the version with a date; move the
  `[Unreleased]` entries into it.
- Every new feature and every fixed bug has an automated test.

## 2. Verify locally

```bash
npm ci --ignore-scripts
npm run verify        # lint, formatting, structure, unit + integration tests with coverage
npm run test:e2e      # real Chromium with the extension loaded and OpenAI stubbed
npm run safari:kit    # builds both zips into dist/
node scripts/validate-extension.js dist/sensemark-vX.Y.Z.zip
```

`npm run test:e2e` loads the extension into Chromium and walks through the main
scenarios below automatically. Screenshots of the card and the popup are saved to
`dist/e2e-screenshots/` (in CI: the `e2e-screenshots-N` artifact) for a visual check.
Set `SENSEMARK_EXTENSION_DIR` to an unpacked zip to run the same suite against the
packaged build.

Then check the unpacked build in a separate Chrome profile:

1. Russian text opens no card and makes no request.
2. Ordinary foreign text appears only with the first translated chunk.
3. Mixed Russian, English and Arabic text keeps the section order.
4. `Japanese Daycares – 日本の保育園` is translated once, without a completeness error.
5. An unknown name shows the amber explanation.
6. Pasting into the toolbar popup starts translating without a button.
7. Clearing or closing cancels an unfinished request.
8. The popup stays compact, with no empty area to the right or below.

## 3. Pull request and CI

- Push to a feature or pre-release branch and open a PR.
- The PR describes the change, the reason and the checks that were run.
- Do not merge unless the required `Test and package` check is green.
- The `sensemark-pr-N` artifact is the unpacked build for a final manual check.

## 4. Merge and tag

After the PR is green:

1. Merge the PR into `main`.
2. Wait for the workflow on the exact merge commit to pass.
3. Create an annotated tag `vX.Y.Z` on that merge commit and push it.

Never move a tag to another commit and never reuse a published version.

## 5. GitHub Release

- Title: `Sensemark vX.Y.Z`.
- Notes: the matching `CHANGELOG.md` section.
- Publishing the release starts `.github/workflows/release.yml`. It checks that the
  tag matches the manifest version, runs `npm run verify`, builds both zips and
  attaches them together with `SHA256SUMS.txt`.
- After the workflow finishes, check the tag target, asset names, sizes, digests and
  the `/releases/latest` link.

If any final check fails, the release is not published.

## 6. Chrome Web Store

Upload `sensemark-vX.Y.Z.zip` in the Developer Dashboard. Listing copy and images
are in [store/chrome-web-store.md](../store/chrome-web-store.md) and
`store/assets/`. The privacy policy link points to `PRIVACY.md` on `main`, so that
file must stay at the repository root.
