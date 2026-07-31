(function exposeModeUtils(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("./config.js"),
          language: require("./language-utils.js"),
          text: require("./text-utils.js")
        }
      : {
          config: root.SensemarkConfig,
          language: root.SensemarkLanguageUtils,
          text: root.SensemarkTextUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkModeUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ config, language, text }) => {
  function determineTranslationMode(value, legacyContext = "") {
    const options =
      typeof value === "object" && value !== null
        ? value
        : { text: value, contextAvailable: Boolean(text.normalizeText(legacyContext)) };
    const source = text.normalizeText(options.text);
    if (language.hasMultipleIndependentLanguageGroups(source)) {
      return config.TRANSLATION_MODE.MULTILINGUAL;
    }
    if (
      text.countCodePoints(source) <= config.CONTEXTUAL_MAX_CODE_POINTS &&
      text.wordCount(source) <= config.CONTEXTUAL_MAX_WORDS
    ) {
      return config.TRANSLATION_MODE.CONTEXTUAL;
    }
    return config.TRANSLATION_MODE.TEXT;
  }

  return { determineTranslationMode };
});
