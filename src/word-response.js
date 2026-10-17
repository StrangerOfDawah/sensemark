(function exposeWordResponseParser(root, factory) {
  const api = factory(
    typeof module === "object" && module.exports ? require("./i18n.js") : root.SensemarkI18n
  );
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkWordResponse = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (I18n) => {
  const { t } = I18n;
  // Prefixes the model writes in Russian; the patterns live in messages.json.
  const prefix = (key, rest = "") => new RegExp(`^(?:${t(key)})${rest}`, "i");
  const TRANSLATION_LABEL = prefix("patternTranslationLabel", "\\s*:\\s*");
  const OTHER_MEANINGS = prefix("patternOtherMeanings", "\\s*:\\s*(.+)$");
  const IN_SENTENCE = prefix("patternInSentence", "\\s*:\\s*(.+)$");
  const CATEGORY_PREFIX = prefix("patternCategoryPrefix", "\\s*:\\s*");
  const DESCRIPTION_PREFIX = prefix("patternDescriptionPrefix", "\\s*:\\s*");
  const NO_SUCH_WORD = new RegExp(t("patternNoSuchWord"), "i");
  const TRANSLATION_MARKER = "[[translation]]";
  const REFERENCE_MARKER = "[[reference]]";
  const SKIP_MARKER = "[[skip]]";

  function cleanLines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseTranslation(lines) {
    const main = (lines[0] || "").replace(TRANSLATION_LABEL, "");
    const secondary = lines.slice(1).join(" ");
    const meanings = secondary.match(OTHER_MEANINGS);
    // Free mode: the whole sentence's translation instead of a list of meanings.
    const sentence = secondary.match(IN_SENTENCE);

    return {
      mode: "translation",
      main,
      category: "",
      detail: meanings?.[1] || sentence?.[1] || "",
      detailLabel: meanings ? t("labelOtherMeanings") : sentence ? t("labelInSentence") : ""
    };
  }

  function parseReference(lines) {
    const category = (lines[0] || t("protocolUnknownTerm")).replace(CATEGORY_PREFIX, "").trim();
    const detail = lines.slice(1).join(" ").replace(DESCRIPTION_PREFIX, "").trim();

    return {
      mode: "reference",
      main: "",
      category,
      detail,
      detailLabel: t("labelWhatItMayBe")
    };
  }

  function parse(text) {
    const value = String(text || "")
      .trim()
      .toLowerCase();
    const markers = [TRANSLATION_MARKER, REFERENCE_MARKER, SKIP_MARKER];
    if (value && markers.some((marker) => marker.startsWith(value) && marker !== value)) {
      return { mode: "pending", main: "", category: "", detail: "" };
    }

    const lines = cleanLines(text);
    if (!lines.length) return { mode: "pending", main: "", category: "", detail: "" };

    const first = lines[0].toLowerCase();
    if (first.startsWith("[[") && !first.endsWith("]]")) {
      return { mode: "pending", main: "", category: "", detail: "" };
    }
    if (first === SKIP_MARKER) {
      return { mode: "skip", main: "", category: "", detail: "", detailLabel: "" };
    }
    if (first === TRANSLATION_MARKER) return parseTranslation(lines.slice(1));
    if (first === REFERENCE_MARKER) return parseReference(lines.slice(1));

    // Support the old answer format while the extension updates.
    if (NO_SUCH_WORD.test(lines[0])) {
      return parseReference([t("protocolUnknownTerm"), ...lines.slice(1)]);
    }
    return parseTranslation(lines);
  }

  return { parse, TRANSLATION_MARKER, REFERENCE_MARKER, SKIP_MARKER };
});
