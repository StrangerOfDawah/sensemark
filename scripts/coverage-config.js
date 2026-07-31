const INCLUDED_FIRST_PARTY_FILES = Object.freeze([
  "background/providers/openai-provider.js",
  "background/translation-service.js",
  "background/request-coordinator.js",
  "background/side-panel-controller.js",
  "background/side-panel-handoff.js",
  "background/side-panel-state.js",
  "background/sse-parser.js",
  "extension/side-panel-handoff-client.js",
  "content/selection/selection-reader.js",
  "content/selection/selection-controller.js",
  "content/selection/selection-intent.js",
  "content/selection/context-extractor.js",
  "content/ui/translation-card.js",
  "content/ui/card-growth-controller.js",
  "shared/language-utils.js",
  "shared/settings-schema.js"
]);

const THRESHOLDS = Object.freeze({ lines: 80, functions: 85, branches: 70 });
const RUNTIME_DIRECTORIES = Object.freeze([
  "background",
  "content",
  "extension",
  "shared",
  "popup",
  "options",
  "sidepanel"
]);

module.exports = { INCLUDED_FIRST_PARTY_FILES, RUNTIME_DIRECTORIES, THRESHOLDS };
