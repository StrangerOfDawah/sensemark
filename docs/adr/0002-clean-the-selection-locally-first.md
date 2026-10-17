# 2. Clean the selection locally before the model sees it

- Status: Accepted
- Formerly: D-002

## Context

A DOM selection can carry a hidden duplicate, a button caption, a site's own
translation layer or invisible control characters. Sending that to a model is
expensive and makes the answer less reliable.

## Decision

`selection-text.js` and `content/page-text.js` remove *proven* structural
noise before any request is built. Removal must rely on a general DOM signal
(controls, navigation, site chrome outside `article`/`main`, hidden text) or a
Unicode control category — never on rules for a particular site.

Text is never removed just because it looks unusual. Links inside a paragraph
are content: an earlier version treated every `<a>` as UI and dropped words such
as "France" from a sentence about Paris. Only links inside menus, navigation and
the site header/footer count as UI.

## Consequences

- Cleaning is universal and unit-tested with DOM fixtures.
- Leftover UI text the local pass cannot identify is skipped by the model per
  the prompt; there is no second request for it.
