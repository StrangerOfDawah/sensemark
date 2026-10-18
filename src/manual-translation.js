(function exposeManualTranslation(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          language: require("./language-detection.js"),
          textResponse: require("./text-response.js"),
          wordResponse: require("./word-response.js"),
          i18n: require("./i18n.js"),
          providers: require("./providers.js")
        }
      : {
          language: root.SensemarkLanguageDetection,
          textResponse: root.SensemarkTextResponse,
          wordResponse: root.SensemarkWordResponse,
          i18n: root.SensemarkI18n,
          providers: root.SensemarkProviders
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkManualTranslation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  const { t } = dependencies.i18n;
  const Providers = dependencies.providers;
  const MAX_CHARS = 5000;
  const PRIVACY_CONSENT_VERSION = Providers?.CONSENT_VERSION;
  const SETTINGS_DEFAULTS = {
    ...Providers?.SETTINGS_DEFAULTS,
    model: "gpt-6-luna",
    targetLang: t("targetLanguage"),
    autoTranslate: true
  };

  const detectScripts = dependencies.language?.detectScripts;
  const hasMultipleScripts = dependencies.language?.hasMultipleScripts;
  const isRussianOnly = dependencies.language?.isRussianOnly;
  const parseTextResponse = dependencies.textResponse?.parse;
  const parseWordResponse = dependencies.wordResponse?.parse;

  if (
    !Providers ||
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
    // Chrome's free translator runs on the device: it needs neither a key nor
    // consent to send text. Paid modes need both, and YandexGPT a folder ID.
    const code = Providers.settingsIssue(settings);
    if (!code) return null;
    const label = Providers.get(settings.provider).label;
    const messages = {
      consent: t("setupConsent", label),
      "api-key": t("setupApiKey", label),
      folder: t("setupFolder")
    };
    return { code, message: messages[code] };
  }

  function createRequestPlan(rawText, detection = null) {
    const text = String(rawText || "").trim();
    if (!text) {
      return { kind: "error", message: t("errorEnterText") };
    }
    if (text.length > MAX_CHARS) {
      return {
        kind: "error",
        message: t("errorTextTooLong", MAX_CHARS)
      };
    }
    if (!/\p{L}/u.test(text)) {
      return { kind: "error", message: t("errorNoWords") };
    }
    if (isRussianOnly(text, detection)) {
      return { kind: "russian", text };
    }

    const sourceScripts = (dependencies.language.detectSignificantScripts || detectScripts)(text);
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
          category: parsed.category || t("protocolUnknownTerm"),
          detail: parsed.detail,
          detailLabel: parsed.detailLabel || t("labelWhatItMayBe"),
          copyText
        };
      }

      if (!parsed.main) return { visible: false, kind: "pending", copyText: "" };
      return {
        visible: true,
        kind: "translation",
        text: parsed.main,
        detail: parsed.detail,
        detailLabel: parsed.detailLabel || t("labelOtherMeanings"),
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
