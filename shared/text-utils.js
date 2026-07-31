(function exposeTextUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTextUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const REMOVABLE_CONTROLS =
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u061C\u200B\u200E\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu;
  const PRIVATE_USE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

  function normalizeText(value) {
    return String(value || "")
      .normalize("NFC")
      .replace(REMOVABLE_CONTROLS, "")
      .replace(/\u00A0/gu, " ")
      .replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function countCodePoints(value) {
    return Array.from(String(value || "")).length;
  }

  function truncateCodePoints(value, maximum) {
    const points = Array.from(String(value || ""));
    return points.length <= maximum ? points.join("") : points.slice(0, maximum).join("");
  }

  function hasLetters(value) {
    return /\p{L}/u.test(String(value || ""));
  }

  function privateUseRatio(value) {
    const points = Array.from(String(value || ""));
    if (!points.length) return 0;
    return points.filter((point) => PRIVATE_USE.test(point)).length / points.length;
  }

  function wordCount(value) {
    const text = normalizeText(value);
    if (!text) return 0;
    if (typeof Intl?.Segmenter === "function") {
      return Array.from(
        new Intl.Segmenter(undefined, { granularity: "word" }).segment(text)
      ).filter((segment) => segment.isWordLike).length;
    }
    return (text.match(/[\p{L}\p{N}]+/gu) || []).length;
  }

  return {
    countCodePoints,
    hasLetters,
    normalizeText,
    privateUseRatio,
    truncateCodePoints,
    wordCount
  };
});
