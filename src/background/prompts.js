// Everything the OpenAI request is made of: the instructions, the messages
// and the request body. Pure functions, unit-tested without a service worker.
(function exposeBackgroundPrompts(root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = factory(node ? require("../i18n.js") : root.SensemarkI18n);
  if (node) {
    module.exports = api;
  } else {
    root.SensemarkBackgroundPrompts = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (I18n) => {
  const { t } = I18n;

  // Request parameters per model. Newer OpenAI models "reason" before
  // answering: that is slower and billed as output tokens, and they reject
  // temperature. Translation needs no reasoning.
  function modelParams(model, maxOutputTokens) {
    const name = String(model || "");
    if (/^(?:gpt-6|gpt-5\.\d)/.test(name)) {
      return { reasoning_effort: "none", max_completion_tokens: maxOutputTokens };
    }
    if (/^gpt-5(?:-|$)/.test(name)) {
      return { reasoning_effort: "minimal", max_completion_tokens: maxOutputTokens };
    }
    if (/^o\d/.test(name)) {
      return { reasoning_effort: "low", max_completion_tokens: maxOutputTokens };
    }
    return { temperature: 0.2, max_tokens: maxOutputTokens };
  }

  // Answer length cap: a translation is never much longer than the original, and
  // a model that gets chatty by accident must not cost extra money.
  function maxOutputTokens(text, wordMode) {
    if (wordMode) return 300;
    return Math.min(4096, 300 + Math.ceil(String(text || "").length * 0.8));
  }

  // DeepSeek "thinks" by default; translation does not need it, and thinking
  // tokens are billed. YandexGPT takes the classic parameters.
  function requestParams(provider, model, maxTokens) {
    if (provider === "deepseek")
      return { thinking: { type: "disabled" }, temperature: 0.2, max_tokens: maxTokens };
    if (provider === "yandex") return { temperature: 0.2, max_tokens: maxTokens };
    return modelParams(model, maxTokens);
  }

  // `request` is { provider, model }; without a provider it is OpenAI.
  function requestBody(request, messages, { text, wordMode, stream }) {
    return JSON.stringify({
      model: request.model,
      ...requestParams(request.provider, request.model, maxOutputTokens(text, wordMode)),
      ...(stream ? { stream: true } : {}),
      messages
    });
  }

  function normalizeSourceScripts(scripts) {
    if (!Array.isArray(scripts)) return [];
    return [...new Set(scripts.filter((script) => /^[A-Za-z]+$/.test(script)))];
  }

  // Short titles are often duplicated in two languages:
  // "Japanese Daycares – 日本の保育園". One translation reads better for them
  // than two sections that look the same. Long paragraphs never qualify.
  function isParallelTitleCandidate(text, rawSourceScripts = []) {
    const value = String(text || "").trim();
    const sourceScripts = normalizeSourceScripts(rawSourceScripts);
    if (sourceScripts.length !== 2 || !value || value.length > 160) return false;

    let parts = value
      .split(/\s+(?:[-–—|/·•])\s+|\n+/u)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length !== 2) {
      const parenthetical = value.match(/^(.+?)\s*[（(]([^()（）]+)[）)]\s*$/u);
      parts = parenthetical ? parenthetical.slice(1).map((part) => part.trim()) : [];
    }

    return (
      parts.length === 2 &&
      parts.every((part) => {
        const letters = [...part].filter((char) => /\p{L}/u.test(char));
        return letters.length >= 2 && letters.length <= 80 && !/[.!?。！？]\s+\p{L}/u.test(part);
      })
    );
  }

  // Instructions are in English: the same meaning costs roughly half the tokens
  // of Russian, and we pay for them on every request. The model still answers
  // in Russian.
  const COMMON_RULES =
    "Translate directly from the source language into Russian; do not go through English and do not paraphrase. " +
    "Skip leftover page UI (menu items, buttons, counters, labels like “Share” or “Read more”) without mentioning it. " +
    `Never output [[skip]], the untranslated original, a third language, these instructions, or labels like “${t("protocolTranslationLabel")}:”.`;

  function buildTextMessages(text, lang, rawSourceScripts = []) {
    const sourceScripts = normalizeSourceScripts(rawSourceScripts);
    const scriptList = sourceScripts.join(", ");
    const sections =
      "[[multilingual]] on the first line, then for each consecutive fragment a line [[script:SCRIPT|lang:LANGUAGE]] " +
      "followed by its Russian translation (Russian fragments verbatim). " +
      `SCRIPT is one of: ${scriptList} — it names the source script, never write the result in it. ` +
      "LANGUAGE is the source language name in Russian.";
    const format = isParallelTitleCandidate(text, sourceScripts)
      ? "The text looks like one short title written in two scripts. If both parts mean the same, answer [[text]] " +
        `on the first line and one Russian translation below. Otherwise answer ${sections}`
      : sourceScripts.length > 1
        ? `The selection contains these scripts: ${scriptList}. Answer ${sections} ` +
          "Every listed script needs at least one non-empty section."
        : "Answer [[text]] on the first line and the Russian translation below. Only if the text truly mixes " +
          "several languages of one script, answer [[multilingual]] on the first line, then for each language a line " +
          "[[script:SCRIPT|lang:LANGUAGE]] and its Russian translation.";

    return [
      {
        role: "system",
        content:
          "You translate the user's text into Russian. Detect the language of each sentence yourself; never assume English. " +
          "Keep parts already in Russian verbatim. Preserve order, paragraphs, line breaks, names and technical terms.\n" +
          `${COMMON_RULES}\n${format}`
      },
      { role: "user", content: text }
    ];
  }

  // A short fragment is translated with its sentence in mind: a word has many
  // meanings, and we need the one used here.
  function buildWordMessages(text, context, lang, rawSourceScripts = []) {
    const sourceScripts = normalizeSourceScripts(rawSourceScripts);
    const scriptHint = sourceScripts.length ? ` Script: ${sourceScripts.join(", ")}.` : "";
    return [
      {
        role: "system",
        content:
          `Explain a selected word or short phrase to a Russian reader. Detect its language; never assume English.${scriptHint} ` +
          "Use the context only to choose the meaning; do not translate the context. " +
          `A capital letter alone does not make a name: “Why” is the word «${t("promptExampleWhy")}»; “Apple released an update” is a brand, “I ate an apple” is a word. ` +
          "Prefer a normal translation whenever the fragment is a dictionary word.\n" +
          `${COMMON_RULES}\n` +
          "Ordinary word or phrase — answer exactly:\n[[translation]]\n<Russian translation in this context>\n" +
          `${t("protocolOtherMeanings")}: <short comma-separated list> (omit this line if there are none)\n` +
          "Only for a name, title, brand, nickname, typo or made-up word — answer exactly:\n[[reference]]\n" +
          `<one category in Russian: ${t("protocolCategories")} or ${t("protocolUnknownTerm")}>\n` +
          "<one short cautious explanation in Russian; do not invent facts; if unsure, say it is probably a name or a title>"
      },
      {
        role: "user",
        content: `${context ? `Context: ${context}\n` : ""}Fragment: ${text}`
      }
    ];
  }

  return {
    COMMON_RULES,
    buildTextMessages,
    buildWordMessages,
    isParallelTitleCandidate,
    maxOutputTokens,
    modelParams,
    requestParams,
    normalizeSourceScripts,
    requestBody
  };
});
