(function exposeConfig(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkConfig = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SETTINGS_KEY = "sensemarkSettings";
  const SETTINGS_VERSION = 3;
  const PRIVACY_CONSENT_VERSION = 2;
  const CACHE_KEY = "sensemarkTranslationCache";
  const SIDE_PANEL_PENDING_PREFIX = "sensemarkSidePanelPending:";
  const MAX_SOURCE_CODE_POINTS = 5000;
  const TARGET_LANGUAGE = "ru";
  const PROMPT_VERSION = "2026-07-31.1";
  const RESPONSE_PROTOCOL_VERSION = "2";
  const CONTEXTUAL_MAX_WORDS = 12;
  const CONTEXTUAL_MAX_CODE_POINTS = 160;
  const MAX_CONTAINER_CODE_POINTS = 2000;
  const MAX_CONTEXT_CODE_POINTS = 800;
  const SELECTION_COOLDOWN_MS = 1500;
  const LOADING_THRESHOLD_MS = 150;

  const PORTS = Object.freeze({
    TRANSLATION: "sensemark.translation"
  });

  const MESSAGE = Object.freeze({
    PUBLIC_SETTINGS_GET: "settings.public.get",
    PUBLIC_SETTINGS_PATCH: "settings.public.patch",
    PRIVATE_SETTINGS_GET: "settings.private.get",
    PRIVATE_SETTINGS_PATCH: "settings.private.patch",
    SETTINGS_TEST: "settings.test",
    TRANSLATE_SELECTION: "selection.translate",
    SIDE_PANEL_PENDING_GET: "sidepanel.pending.get",
    SIDE_PANEL_PENDING_CLEAR: "sidepanel.pending.clear"
  });

  const TRANSLATION_MODE = Object.freeze({
    TEXT: "text",
    CONTEXTUAL: "contextual",
    MULTILINGUAL: "multilingual"
  });

  const SELECTION_MODE = Object.freeze({
    AUTOMATIC: "automatic",
    BUTTON: "button",
    MANUAL: "manual"
  });

  return {
    CACHE_KEY,
    CONTEXTUAL_MAX_CODE_POINTS,
    CONTEXTUAL_MAX_WORDS,
    LOADING_THRESHOLD_MS,
    MAX_SOURCE_CODE_POINTS,
    MAX_CONTAINER_CODE_POINTS,
    MAX_CONTEXT_CODE_POINTS,
    MESSAGE,
    PORTS,
    PRIVACY_CONSENT_VERSION,
    PROMPT_VERSION,
    RESPONSE_PROTOCOL_VERSION,
    SELECTION_MODE,
    SELECTION_COOLDOWN_MS,
    SETTINGS_KEY,
    SETTINGS_VERSION,
    SIDE_PANEL_PENDING_PREFIX,
    TARGET_LANGUAGE,
    TRANSLATION_MODE
  };
});
