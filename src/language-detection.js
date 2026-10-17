(function exposeLanguageDetection(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkLanguageDetection = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const RUSSIAN_LETTER = /^[А-Яа-яЁё]$/u;
  const LATIN_LETTER = /^\p{Script=Latin}$/u;
  const LETTER = /^\p{L}$/u;
  const CYRILLIC_LANGUAGE_CODES = new Set(["be", "bg", "kk", "ky", "mk", "mn", "sr", "tg", "uk"]);
  const SCRIPT_DEFINITIONS = [
    ["Latin", /\p{Script=Latin}/u],
    ["Cyrillic", /\p{Script=Cyrillic}/u],
    ["Arabic", /\p{Script=Arabic}/u],
    ["Han", /\p{Script=Han}/u],
    ["Hiragana", /\p{Script=Hiragana}/u],
    ["Katakana", /\p{Script=Katakana}/u],
    ["Hangul", /\p{Script=Hangul}/u],
    ["Hebrew", /\p{Script=Hebrew}/u],
    ["Greek", /\p{Script=Greek}/u],
    ["Devanagari", /\p{Script=Devanagari}/u]
  ];

  function detectScripts(text) {
    const scripts = new Set();
    for (const char of String(text || "")) {
      if (!LETTER.test(char)) continue;
      const definition = SCRIPT_DEFINITIONS.find(([, pattern]) => pattern.test(char));
      scripts.add(definition?.[0] || "Other");
    }
    if (scripts.has("Hiragana") || scripts.has("Katakana")) {
      scripts.delete("Han");
      scripts.delete("Hiragana");
      scripts.delete("Katakana");
      scripts.add("Japanese");
    }
    if (scripts.has("Hangul")) {
      scripts.delete("Han");
      scripts.delete("Hangul");
      scripts.add("Korean");
    }
    return [...scripts];
  }

  // Scripts with a noticeable share of the text. A single "π" or "東京" in an
  // English paragraph does not make it multilingual: otherwise the model must
  // answer in sections, and the extra format is a common cause of a retry.
  function detectSignificantScripts(text, { minLetters = 3, minShare = 0.15 } = {}) {
    const counts = new Map();
    let total = 0;
    for (const char of String(text || "")) {
      if (!LETTER.test(char)) continue;
      const [script] = detectScripts(char);
      counts.set(script, (counts.get(script) || 0) + 1);
      total++;
    }
    // Japanese: kanji and kana are one script, as in detectScripts.
    const merged = new Map();
    for (const script of detectScripts(text)) merged.set(script, 0);
    for (const [script, count] of counts) {
      const target =
        script === "Han" && merged.has("Japanese")
          ? "Japanese"
          : script === "Han" && merged.has("Korean")
            ? "Korean"
            : script;
      if (merged.has(target)) merged.set(target, merged.get(target) + count);
    }
    const top = [...merged].sort((left, right) => right[1] - left[1])[0]?.[0];
    // Keep text order; the dominant script always stays.
    return [...merged]
      .filter(([script, count]) => script === top || (count >= minLetters && count / total >= minShare))
      .map(([script]) => script);
  }

  function hasMultipleScripts(text) {
    return detectSignificantScripts(text).length > 1;
  }

  function isRussianOnly(text, detection = null) {
    const value = String(text || "");
    const letters = [...value].filter((char) => LETTER.test(char));
    if (!letters.length) return false;

    const russianCount = letters.filter((char) => RUSSIAN_LETTER.test(char)).length;
    const latinCount = letters.filter((char) => LATIN_LETTER.test(char)).length;
    if (!russianCount || letters.length !== russianCount + latinCount) return false;

    // CLD is often unsure about short Russian text, so the alphabet is a
    // fallback signal. A confident detection of another language wins, so
    // Bulgarian or Serbian text is never ignored by mistake.
    const detected = detection?.languages?.find(
      (item) => item.language && item.language !== "und" && item.percentage >= 20
    );
    if (!latinCount) {
      return !(detection?.isReliable && detected && detected.language !== "ru");
    }

    // Russian interfaces often carry technical inserts inside a phrase:
    // dev-секрет, APP_ENV, a URL or ChatGPT. They do not make the whole
    // selection multilingual and must not trigger a translation.
    // A real English phrase or a noticeable share of Latin is still translated.
    const latinWords = [...value.matchAll(/[A-Za-z][A-Za-z0-9_./:@=+#]*/g)].map((match) => {
      const token = match[0];
      const start = match.index;
      const end = start + token.length;
      const touchesRussianCompound =
        /[А-Яа-яЁё]-$/u.test(value.slice(Math.max(0, start - 2), start)) ||
        /^-[А-Яа-яЁё]/u.test(value.slice(end, end + 2));
      const technical =
        /[_0-9./:@=+#]/.test(token) ||
        /^[A-Z]{2,}$/.test(token) ||
        /[a-z][A-Z]/.test(token) ||
        touchesRussianCompound;
      return { token, start, end, technical };
    });
    const naturalLatinWords = latinWords.filter((word) => !word.technical && word.token.length >= 2);
    const naturalLatinCount = naturalLatinWords.reduce((sum, word) => sum + word.token.length, 0);
    const hasLatinPhrase = naturalLatinWords.some((word, index) => {
      const next = naturalLatinWords[index + 1];
      if (!next) return false;
      const between = value.slice(word.end, next.start);
      return /^[\s,;:!?()[\]{}'"“”‘’—–]+$/u.test(between);
    });
    if (hasLatinPhrase || russianCount < naturalLatinCount * 2) return false;

    // CLD may call such a mixed fragment English because of the identifiers.
    // A confident result for another Cyrillic language still wins.
    if (detection?.isReliable && detected && CYRILLIC_LANGUAGE_CODES.has(detected.language.toLowerCase())) {
      return false;
    }

    return true;
  }

  return { detectScripts, detectSignificantScripts, hasMultipleScripts, isRussianOnly };
});
