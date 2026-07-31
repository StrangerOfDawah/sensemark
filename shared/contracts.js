(function exposeContracts(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("./config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkContracts = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  const modes = new Set(Object.values(config.TRANSLATION_MODE));
  const surfaces = new Set(["content", "popup", "sidepanel", "options", "extension"]);

  function cleanString(value, max = 20000) {
    return typeof value === "string" ? value.slice(0, max) : "";
  }

  function cleanCodePoints(value, maximum) {
    return typeof value === "string" ? Array.from(value).slice(0, maximum).join("") : "";
  }

  function normalizeRect(value) {
    if (!value || typeof value !== "object") return null;
    const rect = {
      left: Number(value.left),
      top: Number(value.top),
      right: Number(value.right),
      bottom: Number(value.bottom),
      width: Number(value.width),
      height: Number(value.height)
    };
    return Object.values(rect).every(Number.isFinite) ? rect : null;
  }

  function createTranslationRequest(value = {}) {
    const text = cleanString(value.text, config.MAX_SOURCE_CODE_POINTS * 4).trim();
    if (!text) throw new TypeError("TranslationRequest.text is required.");
    if (Array.from(text).length > config.MAX_SOURCE_CODE_POINTS) {
      throw new RangeError(`Maximum length is ${config.MAX_SOURCE_CODE_POINTS} code points.`);
    }

    if (
      value.requestId !== undefined &&
      (typeof value.requestId !== "string" ||
        value.requestId.length > 100 ||
        !/^[A-Za-z0-9._:-]+$/.test(value.requestId))
    ) {
      throw new TypeError("TranslationRequest.requestId is invalid.");
    }
    const mode = modes.has(value.mode) ? value.mode : config.TRANSLATION_MODE.TEXT;
    return Object.freeze({
      requestId: cleanString(value.requestId, 100) || cryptoRandomId(),
      text,
      context: cleanCodePoints(value.context, config.MAX_CONTEXT_CODE_POINTS).trim() || null,
      mode,
      sourceScripts: Array.isArray(value.sourceScripts)
        ? value.sourceScripts.filter((item) => typeof item === "string").slice(0, 12)
        : [],
      semanticHint: cleanString(value.semanticHint, 120),
      targetLanguage: config.TARGET_LANGUAGE,
      anchorRect: normalizeRect(value.anchorRect),
      surface: surfaces.has(value.surface) ? value.surface : "content"
    });
  }

  function createTranslationResult(value = {}) {
    const kind = ["translation", "reference", "multilingual"].includes(value.kind)
      ? value.kind
      : "translation";
    const translation = cleanString(value.translation || value.text);
    const result = {
      kind,
      translation,
      text: translation,
      alternatives: Array.isArray(value.alternatives)
        ? value.alternatives.map((item) => cleanString(item, 3000)).filter(Boolean).slice(0, 4)
        : [],
      category: ["", "name", "title", "brand", "username", "typo", "unknown_term"].includes(
        value.category
      )
        ? value.category
        : "",
      explanation: cleanString(value.explanation, 6000),
      sections: Array.isArray(value.sections)
        ? value.sections
            .map((section) => ({
              script: cleanString(section?.script, 80),
              source: cleanString(section?.source, 6000),
              translation: cleanString(section?.translation, 6000)
            }))
            .filter((section) => section.translation)
            .slice(0, 16)
        : []
    };
    if (!result.translation && !result.sections.length) {
      throw new TypeError("TranslationResult must contain translation or sections.");
    }
    return result;
  }

  function cryptoRandomId() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `sm-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function isTranslationDelta(value) {
    return Boolean(
      value &&
        value.type === "translation.delta" &&
        typeof value.requestId === "string" &&
        typeof value.delta === "string"
    );
  }

  return {
    createTranslationRequest,
    createTranslationResult,
    cryptoRandomId,
    isTranslationDelta,
    normalizeRect
  };
});
