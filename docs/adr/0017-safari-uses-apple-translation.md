# 17. Safari uses Apple's translator instead of the Translator API

- Status: Accepted
- Formerly: D-017

## Context

Safari has no Chrome Translator API.

## Decision

In Safari, free mode goes through the native part of the container app:
`background.js` forwards `{type: "native"}` messages to
`SafariWebExtensionHandler.swift`, which translates with `TranslationSession`
(windowless only on macOS 26.4+, languages must already be downloaded) and
detects the language with `NLLanguageRecognizer`. `createAppleBridge` mirrors the
Translator API interface, so the engine, the card and the popup are shared by both
browsers.

macOS allows language downloads only from an app window (`.translationTask`), so
the card's "Download" button opens the Sensemark app and waits until the language
appears; there is no percentage, the ring just spins.

The `nativeMessaging` permission is added only to the Safari manifest
(`scripts/build-safari-kit.js`): in Chrome it would add an install warning. A test
keeps it out of `src/manifest.json`.

## Consequences

- Swift cannot be built in CI (macOS and Xcode required). A test checks that its
  operations match the bridge; the build is verified on a Mac.
- The Safari kit is a separate release asset, `sensemark-safari-vX.Y.Z.zip`.
