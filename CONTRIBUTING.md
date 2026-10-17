# Contributing

Thanks for your interest in Sensemark. Issues and pull requests are welcome.

## Getting started

```bash
nvm use               # Node 24, see .nvmrc
npm ci --ignore-scripts
npm test
```

Load the extension from `src/` via `chrome://extensions` → "Load unpacked". Use a
separate Chrome profile so a development API key does not mix with a store install.

## Before you open a pull request

- Read [docs/architecture.md](docs/architecture.md) and the relevant
  [decision records](docs/adr/README.md).
- Every feature and bug fix includes an automated test (a regression test for bugs).
- Run `npm run verify`; for UI or flow changes also run `npm run test:e2e`.
- Update the docs your change makes stale (see the workflow in [AGENTS.md](AGENTS.md)).
- Write commits and the PR in English. User-facing text in the extension stays in Russian.

## Things that are deliberately out of scope

- Rules for particular sites or topics: Sensemark works the same everywhere.
- Changing the look without a reviewed screenshot: the design is locked by
  `tests/design-lock.json` and changes are accepted by the maintainer.
- Analytics, servers or remote code.

See [docs/product-direction.md](docs/product-direction.md) for the full list.
