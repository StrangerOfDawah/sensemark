(function exposeWordResponseParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkWordResponse = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
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
    const main = (lines[0] || "").replace(/^перевод\s*:\s*/i, "");
    const secondary = lines.slice(1).join(" ");
    const meanings = secondary.match(/^друг\S*\s+значения\s*:\s*(.+)$/i);
    // Бесплатный режим: перевод всего предложения вместо списка значений.
    const sentence = secondary.match(/^в\s+предложении\s*:\s*(.+)$/i);

    return {
      mode: "translation",
      main,
      category: "",
      detail: meanings?.[1] || sentence?.[1] || "",
      detailLabel: meanings ? "Другие значения" : sentence ? "В предложении" : ""
    };
  }

  function parseReference(lines) {
    const category = (lines[0] || "неизвестный термин")
      .replace(/^категория\s*:\s*/i, "")
      .trim();
    const detail = lines
      .slice(1)
      .join(" ")
      .replace(/^(?:описание|возможно,?\s+это)\s*:\s*/i, "")
      .trim();

    return {
      mode: "reference",
      main: "",
      category,
      detail,
      detailLabel: "Что это может быть"
    };
  }

  function parse(text) {
    const value = String(text || "").trim().toLowerCase();
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

    // Поддержка ответа старого формата во время обновления расширения.
    if (/такого\s+(?:общеупотребительного\s+)?слова\s+не\s+существует/i.test(lines[0])) {
      return parseReference(["неизвестный термин", ...lines.slice(1)]);
    }
    return parseTranslation(lines);
  }

  return { parse, TRANSLATION_MARKER, REFERENCE_MARKER, SKIP_MARKER };
});
