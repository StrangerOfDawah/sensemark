(function exposeManualTranslation(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          language: require("./language-detection.js"),
          textResponse: require("./text-response.js"),
          wordResponse: require("./word-response.js")
        }
      : {
          language: root.SensemarkLanguageDetection,
          textResponse: root.SensemarkTextResponse,
          wordResponse: root.SensemarkWordResponse
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkManualTranslation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  const MAX_CHARS = 5000;
  const PRIVACY_CONSENT_VERSION = 1;
  const SETTINGS_DEFAULTS = {
    apiKey: "",
    model: "gpt-4o-mini",
    targetLang: "русский",
    autoTranslate: false,
    privacyConsentVersion: 0
  };

  const detectScripts = dependencies.language?.detectScripts;
  const hasMultipleScripts = dependencies.language?.hasMultipleScripts;
  const isRussianOnly = dependencies.language?.isRussianOnly;
  const parseTextResponse = dependencies.textResponse?.parse;
  const parseWordResponse = dependencies.wordResponse?.parse;

  if (
    !detectScripts ||
    !hasMultipleScripts ||
    !isRussianOnly ||
    !parseTextResponse ||
    !parseWordResponse
  ) {
    throw new Error("Sensemark: manual translation dependencies are unavailable.");
  }

  function isShortText(text) {
    return text.length <= 40 && text.split(/\s+/).length <= 3;
  }

  function settingsIssue(settings = {}) {
    if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
      return {
        code: "consent",
        message: "Подтвердите отправку текста в OpenAI в настройках."
      };
    }
    if (!String(settings.apiKey || "").trim()) {
      return {
        code: "api-key",
        message: "Добавьте API-ключ OpenAI в настройках."
      };
    }
    return null;
  }

  function createRequestPlan(rawText, detection = null) {
    const text = String(rawText || "").trim();
    if (!text) {
      return { kind: "error", message: "Введите текст для перевода." };
    }
    if (text.length > MAX_CHARS) {
      return {
        kind: "error",
        message: `Слишком длинный текст: максимум ${MAX_CHARS} символов.`
      };
    }
    if (!/\p{L}/u.test(text)) {
      return { kind: "error", message: "В тексте не найдено слов для перевода." };
    }
    if (isRussianOnly(text, detection)) {
      return { kind: "russian", text };
    }

    const sourceScripts = detectScripts(text);
    return {
      kind: "request",
      text,
      context: null,
      sourceScripts,
      wordMode: isShortText(text) && !hasMultipleScripts(text)
    };
  }

  function parseManualResponse(rawResponse, wordMode, source = "") {
    const response = String(rawResponse || "");

    if (wordMode) {
      const parsed = parseWordResponse(response);
      if (parsed.mode === "pending" || parsed.mode === "skip") {
        return { visible: false, kind: parsed.mode, copyText: "" };
      }

      if (parsed.mode === "reference") {
        const modelContent = response.split("\n").slice(1).join("\n").trim();
        if (!modelContent) return { visible: false, kind: "pending", copyText: "" };
        const copyText = [source, parsed.detail].filter(Boolean).join("\n");
        return {
          visible: true,
          kind: "reference",
          title: source,
          category: parsed.category || "неизвестный термин",
          detail: parsed.detail,
          detailLabel: parsed.detailLabel || "Что это может быть",
          copyText
        };
      }

      if (!parsed.main) return { visible: false, kind: "pending", copyText: "" };
      return {
        visible: true,
        kind: "translation",
        text: parsed.main,
        detail: parsed.detail,
        detailLabel: parsed.detailLabel || "Другие значения",
        copyText: parsed.main
      };
    }

    const parsed = parseTextResponse(response);
    if (parsed.mode === "pending" || parsed.mode === "skip") {
      return { visible: false, kind: parsed.mode, copyText: "" };
    }
    if (parsed.mode === "multilingual") {
      const sections = parsed.sections.filter((section) => Boolean(section.text));
      if (!sections.length) return { visible: false, kind: "pending", copyText: "" };
      return {
        visible: true,
        kind: "multilingual",
        sections,
        copyText: sections.map((section) => section.text).join("\n\n")
      };
    }
    if (!parsed.text) return { visible: false, kind: "pending", copyText: "" };
    return {
      visible: true,
      kind: "translation",
      text: parsed.text,
      detail: "",
      detailLabel: "",
      copyText: parsed.text
    };
  }

  return {
    MAX_CHARS,
    PRIVACY_CONSENT_VERSION,
    SETTINGS_DEFAULTS,
    createRequestPlan,
    isShortText,
    parseManualResponse,
    settingsIssue
  };
});
