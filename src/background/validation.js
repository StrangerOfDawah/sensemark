// Checks the model's answer before anyone sees it. Lenient on purpose: every
// retry doubles the price, so only a clearly broken answer is rejected.
(function exposeBackgroundValidation(root, factory) {
  const node = typeof module === "object" && module.exports;
  const api = node
    ? factory(require("../i18n.js"), require("./prompts.js"))
    : factory(root.SensemarkI18n, root.SensemarkBackgroundPrompts);
  if (node) {
    module.exports = api;
  } else {
    root.SensemarkBackgroundValidation = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (I18n, Prompts) => {
  const { t } = I18n;
  const { isParallelTitleCandidate, normalizeSourceScripts } = Prompts;

  function responsePayload(value) {
    return String(value || "")
      .split("\n")
      .filter((line) => !/^\s*\[\[.+\]\]\s*$/.test(line))
      .join("\n")
      .trim();
  }

  function translatedBodies(value) {
    const sections = [
      ...String(value || "").matchAll(
        /^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:[^\]]+\]\]\s*\n([\s\S]*?)(?=^\[\[(?:script\s*:|lang\s*:)|$)/gim
      )
    ].map((match) => match[1].trim());
    return sections.length ? sections : [responsePayload(value)];
  }

  const FOREIGN_SCRIPT_LETTER =
    /[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Hebrew}\p{Script=Greek}\p{Script=Devanagari}]/u;

  // The Russian alphabet, including the letter Yo, as code points.
  const RUSSIAN_LETTER = /[\u0410-\u044F\u0401\u0451]/u;
  const COPIED_INSTRUCTIONS = new RegExp(
    `full translation into|translate the text|${t("patternCopiedInstructions")}`,
    "i"
  );
  const TRANSLATION_LABEL = new RegExp(`^(?:${t("protocolTranslationLabel")}|translation)\\s*:`, "im");

  // Validation is lenient on purpose: every retry doubles the price of a translation.
  // Catch only a clearly broken answer, not legitimately kept names,
  // brands and terms ("GitHub Copilot", "API", "東京").
  function contentIssue(value) {
    const payload = responsePayload(value);
    if (COPIED_INSTRUCTIONS.test(payload)) {
      return "The answer repeats the instructions instead of a translation.";
    }
    if (TRANSLATION_LABEL.test(payload)) {
      return "The answer starts with a translation label instead of a clean result.";
    }

    const letters = [...payload].filter((char) => /\p{L}/u.test(char));
    const foreign = letters.filter((char) => FOREIGN_SCRIPT_LETTER.test(char)).length;
    if (letters.length && foreign / letters.length > 0.2) {
      return "The answer is written in the source script instead of Russian.";
    }

    const untranslated = translatedBodies(value).find(
      (body) =>
        !RUSSIAN_LETTER.test(body) && body.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length >= 4
    );
    return untranslated ? "A section is not translated into Russian." : "";
  }

  function responseIssue(text, wordMode, rawSourceScripts = [], sourceText = "") {
    const value = String(text || "").trim();
    if (/^\[\[skip\]\]/i.test(value)) {
      return "The answer contains the forbidden [[skip]] marker.";
    }

    const firstLine = value.split("\n", 1)[0].trim().toLowerCase();
    if (wordMode) {
      if (firstLine === "[[reference]]") return "";
      if (firstLine !== "[[translation]]") {
        return "The answer must start with [[translation]] or [[reference]].";
      }
      return contentIssue(value);
    }

    const sourceScripts = normalizeSourceScripts(rawSourceScripts);
    const multilingual = firstLine === "[[multilingual]]";
    const unifiedParallelTitle =
      firstLine === "[[text]]" && isParallelTitleCandidate(sourceText, sourceScripts);
    const declaredScripts = [...value.matchAll(/^\[\[script\s*:\s*([^|\]]+)\s*\|/gim)].map((match) =>
      match[1].trim()
    );
    const unexpectedScripts = declaredScripts.filter((script) => !sourceScripts.includes(script));
    if (unexpectedScripts.length) {
      return `The answer added scripts that are not in the selection: ${[...new Set(unexpectedScripts)].join(
        ", "
      )}.`;
    }
    if (sourceScripts.length > 1 && !multilingual && !unifiedParallelTitle) {
      return "The selection has several scripts, so the answer must use the [[multilingual]] format.";
    }
    if (sourceScripts.length < 2 && multilingual) {
      const languages = [...value.matchAll(/^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:\s*([^\]]+)\]\]/gim)].map(
        (match) => match[1].trim().toLowerCase()
      );
      if (new Set(languages).size < 2) {
        return "The text is in one language, so [[multilingual]] is wrong.";
      }
    } else if (!multilingual && firstLine !== "[[text]]") {
      return "The answer must start with [[text]].";
    }

    if (multilingual && sourceScripts.length > 1) {
      const missing = sourceScripts.filter((script) => {
        const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const section = value.match(
          new RegExp(
            `\\[\\[script\\s*:\\s*${escaped}\\s*\\|\\s*lang\\s*:[^\\]]+\\]\\]\\s*` +
              "([\\s\\S]*?)(?=\\n\\[\\[script\\s*:|$)",
            "i"
          )
        );
        return !section?.[1]?.trim();
      });
      if (missing.length) {
        return `Sections are missing for scripts: ${missing.join(", ")}.`;
      }
    }

    return contentIssue(value);
  }

  return { contentIssue, responseIssue, responsePayload, translatedBodies };
});
