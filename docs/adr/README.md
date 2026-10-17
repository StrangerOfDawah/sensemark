# Architecture decision records

Each record explains *why* something is the way it is. Change a decision only
together with its tests, the docs and an explicit new reason: add a new record
that supersedes the old one rather than rewriting history.

Records were numbered D-001…D-018 before October 2026; the numbers are unchanged.

| # | Decision |
| --- | --- |
| [0001](0001-russian-is-the-only-target-language.md) | Russian is the only target language |
| [0002](0002-clean-the-selection-locally-first.md) | Clean the selection locally before the model sees it |
| [0003](0003-multilingual-text-gets-a-structured-answer.md) | Multilingual text gets a structured answer |
| [0004](0004-never-show-an-empty-card.md) | Never show an empty card |
| [0005](0005-repair-is-an-exception.md) | Repair is an exception, not part of translation |
| [0006](0006-unknown-terms-have-their-own-ui.md) | Unknown terms have their own UI |
| [0007](0007-toolbar-popup-stays-compact.md) | The toolbar popup stays a compact Chrome popup |
| [0008](0008-rate-limited-scaling.md) | Card scaling is rate-limited |
| [0009](0009-every-change-ships-with-a-test.md) | Every feature and bug fix ships with a test |
| [0010](0010-platform-first.md) | Platform APIs and proven solutions first |
| [0011](0011-design-lock.md) | The design is protected by a lock |
| [0012](0012-universal-translator.md) | A universal translator, not tied to any site |
| [0013](0013-ignore-accidental-selections.md) | Accidental selections are not translated |
| [0014](0014-free-mode-by-default.md) | Free mode by default, OpenAI on request |
| [0015](0015-model-and-token-budget.md) | OpenAI model and token budget |
| [0016](0016-chameleon-card.md) | The "chameleon" card |
| [0017](0017-safari-uses-apple-translation.md) | Safari uses Apple's translator instead of the Translator API |
| [0018](0018-auto-translate-on-by-default.md) | Auto-translate is on by default |

## Adding a record

Copy the structure of an existing record (Status, Context, Decision,
Consequences), take the next number and add a row to the table above.
