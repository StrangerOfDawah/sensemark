(function exposeRequestPlan(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("../shared/config.js"),
          contracts: require("../shared/contracts.js"),
          language: require("../shared/language-utils.js"),
          mode: require("../shared/mode-utils.js"),
          text: require("../shared/text-utils.js")
        }
      : {
          config: root.SensemarkConfig,
          contracts: root.SensemarkContracts,
          language: root.SensemarkLanguageUtils,
          mode: root.SensemarkModeUtils,
          text: root.SensemarkTextUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkRequestPlan = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function createRequestPlan(rawText, surface = "popup") {
    const text = dependencies.text.normalizeText(rawText);
    if (!text) return { error: "Введите или вставьте текст." };
    if (!dependencies.text.hasLetters(text)) return { error: "В тексте не найдено слов." };
    if (dependencies.text.countCodePoints(text) > dependencies.config.MAX_SOURCE_CODE_POINTS) {
      return {
        error: `Слишком длинный текст: максимум ${dependencies.config.MAX_SOURCE_CODE_POINTS} символов.`
      };
    }
    const mode = dependencies.mode.determineTranslationMode(text);
    return {
      request: dependencies.contracts.createTranslationRequest({
        text,
        mode,
        sourceScripts: dependencies.language.detectScripts(text),
        targetLanguage: dependencies.config.TARGET_LANGUAGE,
        surface
      })
    };
  }

  return { createRequestPlan };
});
