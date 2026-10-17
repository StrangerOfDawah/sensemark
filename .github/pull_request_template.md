## What changed

<!-- The observable change, in a sentence or two. -->

## Why

<!-- For a bug: the root cause and the original user example. -->

## Checklist

- [ ] New behaviour has an automated test; every fixed bug has a regression test.
- [ ] `npm run verify` passes (lint, formatting, structure, tests with coverage).
- [ ] `npm run test:e2e` passes, or this change cannot affect the browser flow.
- [ ] `npm run design:status` reports no change, or the visual change was reviewed
      with screenshots before `npm run design:approve`.
- [ ] Affected docs are updated (README, `CHANGELOG.md`, `docs/`, `AGENTS.md`).

## Risks

- [ ] No extra API requests without a reason.
- [ ] Russian-only text still opens no card and spends no tokens.
- [ ] Privacy, permissions and remote code are unchanged, or the change is described above.
