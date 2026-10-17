# Product direction

## Promise

Sensemark turns a selection into clear Russian faster than the user could switch
to a separate translator — and stays out of the way when no translation is needed.

## Priorities

1. **Meaning first.** Context matters more than literal correspondence, but a
   translation must not turn into an interpretation.
2. **Predictability.** Russian text is ignored, an unknown name looks different
   from a translation, languages are never mixed.
3. **Low cost.** Local filtering, one main request, a cache and cancellation of
   streams nobody needs.
4. **Unobtrusive UI.** No empty waiting window, no extra buttons, no technical
   markers.
5. **Reliability on real pages.** DOM noise, hidden layers and mixed scripts are
   covered by concrete regression fixtures.
6. **Safe by default.** Minimal permissions, a local key, no analytics and no
   remote code.

## Design

- The visual language is calm, compact and native to the platform.
- Corner radii, materials and motion support hierarchy; they are not decoration.
- The main translation is read first; service information is secondary.
- A name or unknown term looks different from an ordinary translation.
- Any redesign is checked in the real Chrome popup or on a real page, not only in
  an enlarged preview — and goes through the design lock
  ([ADR 0011](adr/0011-design-lock.md)).

## Non-goals

- A general-purpose chat with a model.
- Translation into an arbitrary target language.
- Automatic OCR of images.
- Storing selection history on a server.
- Behaviour analytics.
- A large framework for a small popup.
- Rules for particular sites ([ADR 0012](adr/0012-universal-translator.md)).

## What makes a good change

It improves an observable user scenario, does not add API requests without a
reason, has an automated test and keeps the rules in [AGENTS.md](../AGENTS.md).
