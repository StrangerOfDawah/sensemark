(function exposeLanguageUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkLanguageUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SCRIPT_TESTS = Object.freeze({
    Cyrillic: /\p{Script=Cyrillic}/u,
    Latin: /\p{Script=Latin}/u,
    Arabic: /\p{Script=Arabic}/u,
    Han: /\p{Script=Han}/u,
    Hiragana: /\p{Script=Hiragana}/u,
    Katakana: /\p{Script=Katakana}/u,
    Devanagari: /\p{Script=Devanagari}/u,
    Hebrew: /\p{Script=Hebrew}/u,
    Greek: /\p{Script=Greek}/u,
    Hangul: /\p{Script=Hangul}/u
  });

  function detectScripts(value) {
    const text = String(value || "");
    return Object.entries(SCRIPT_TESTS)
      .filter(([, expression]) => expression.test(text))
      .map(([name]) => name);
  }

  function hasMultipleScripts(value) {
    return detectScripts(value).length > 1;
  }

  function detectScriptGroups(value) {
    const scripts = Array.isArray(value) ? value : detectScripts(value);
    const remaining = new Set(scripts);
    const groups = [];
    const hasHan = remaining.delete("Han");
    const hasHiragana = remaining.delete("Hiragana");
    const hasKatakana = remaining.delete("Katakana");
    const hasHangul = remaining.delete("Hangul");

    if (hasHiragana || hasKatakana) {
      groups.push("Japanese");
    } else if (hasHangul) {
      groups.push("Korean");
    } else if (hasHan) {
      groups.push("CJK");
    }
    if (hasHangul && !groups.includes("Korean")) groups.push("Korean");
    for (const script of remaining) groups.push(script);
    return groups;
  }

  function latinTokens(value) {
    return (
      String(value || "").match(/[A-Za-z][A-Za-z0-9_.]*(?:-[A-Za-z0-9_.]+)*/g) || []
    );
  }

  function isTechnicalLatinMix(value) {
    const text = String(value || "");
    if (!/\p{Script=Cyrillic}/u.test(text) || !/\p{Script=Latin}/u.test(text)) return false;
    const tokens = latinTokens(text);
    if (!tokens.length) return false;
    if (tokens.length === 1) {
      const [token] = tokens;
      return (
        /[_./0-9]/.test(token) ||
        /^[A-Z][A-Z0-9_-]*$/.test(token) ||
        /^[A-Z][a-z]+(?:[A-Z][A-Za-z]*)?$/.test(token)
      );
    }
    const hasIdentifier = tokens.some(
      (token) =>
        /[_./]/.test(token) ||
        /^[A-Z][A-Z0-9_-]*$/.test(token) ||
        /^[A-Z][a-z]+(?:[A-Z][A-Za-z]*)?$/.test(token)
    );
    return hasIdentifier && tokens.filter((token) => /^[a-z]+$/.test(token)).length <= 1;
  }

  function hasMultipleIndependentLanguageGroups(value) {
    const groups = detectScriptGroups(value);
    if (groups.length <= 1) return false;
    if (
      groups.length === 2 &&
      groups.includes("Cyrillic") &&
      groups.includes("Latin") &&
      isTechnicalLatinMix(value)
    ) {
      return false;
    }
    return true;
  }

  const NON_RUSSIAN_SIGNALS =
    /[іїєґўђљњћџќѓѕјәғқңөұүһ]|(?:^|\s)(?:як справи|доброго дня|как си|добар дан|сәлем)(?:$|[!?.\s])/iu;
  const DEFINITELY_NON_RUSSIAN = new Set([
    "uk",
    "bg",
    "sr",
    "be",
    "kk",
    "mk",
    "ky",
    "mn",
    "tg"
  ]);

  /**
   * Function words that are Russian rather than Ukrainian, Bulgarian, Serbian,
   * Macedonian, Belarusian, Kazakh or Kyrgyz — "что" vs "що"/"какво"/"шта"/"што",
   * "это" vs "це"/"това"/"гэта", "который" vs "який"/"който"/"који".
   *
   * This is a discriminator, not a classifier: it is only ever consulted to raise
   * confidence, never to lower it, and it can only fire alongside the length and
   * word-count floors below.
   */
  const RUSSIAN_FUNCTION_WORDS = new Set([
    "что",
    "это",
    "этот",
    "эта",
    "эти",
    "этого",
    "чтобы",
    "который",
    "которая",
    "которое",
    "которые",
    "очень",
    "если",
    "сейчас",
    "нужно",
    "надо",
    "только",
    "может",
    "потому",
    "здесь",
    "сегодня",
    "всегда",
    "ещё",
    "еще",
    "уже",
    "были",
    "было",
    "была",
    "будет",
    "есть",
    "должен",
    "должна",
    "также",
    "тоже",
    "почему",
    "когда",
    "теперь"
  ]);

  // A confident verdict needs a real sentence, not a fragment. Kazakh, Belarusian and
  // Kyrgyz words such as "сынып", "добры" or "кыргыз" contain letters Russian also
  // uses, so length and word evidence — never individual characters — decide.
  const MIN_CYRILLIC_CODE_POINTS_FOR_RUSSIAN = 16;
  const MIN_CYRILLIC_WORDS_FOR_RUSSIAN = 3;
  const MIN_RUSSIAN_FUNCTION_WORDS = 2;

  function cyrillicLength(value) {
    return (String(value || "").match(/\p{Script=Cyrillic}/gu) || []).length;
  }

  function cyrillicWords(value) {
    return String(value || "")
      .toLowerCase()
      .match(/\p{Script=Cyrillic}+/gu) || [];
  }

  /**
   * Decide, without any asynchronous work, whether text is confidently Russian.
   *
   * This runs on the user-gesture call stack, so it must never await: Chrome drops
   * transient user activation across an await and `sidePanel.open()` then fails.
   *
   * It is deliberately biased towards "uncertain". A wrong "russian" verdict silently
   * destroys a translation the user asked for; a wrong "uncertain" verdict only costs
   * an extra panel that reports the text is already Russian. There is deliberately no
   * rule where a single character or a tiny character class yields "russian": "ы", "э"
   * and "ё" all occur in Kazakh, Belarusian, Kyrgyz and Mongolian text.
   *
   * @returns {"russian"|"uncertain"|"not-russian"}
   */
  function synchronousRussianVerdict(value) {
    const text = String(value || "").trim();
    if (!text) return "not-russian";
    if (!SCRIPT_TESTS.Cyrillic.test(text)) return "not-russian";
    // Ukrainian, Bulgarian, Serbian, Kazakh, Belarusian and friends: never skip these.
    if (NON_RUSSIAN_SIGNALS.test(text)) return "not-russian";
    // Mixed-script selections are a multilingual request, not a Russian one.
    if (hasMultipleIndependentLanguageGroups(text)) return "uncertain";

    const words = cyrillicWords(text);
    if (cyrillicLength(text) < MIN_CYRILLIC_CODE_POINTS_FOR_RUSSIAN) return "uncertain";
    if (words.length < MIN_CYRILLIC_WORDS_FOR_RUSSIAN) return "uncertain";

    const evidence = new Set(words.filter((word) => RUSSIAN_FUNCTION_WORDS.has(word)));
    if (evidence.size >= MIN_RUSSIAN_FUNCTION_WORDS) return "russian";
    return "uncertain";
  }

  async function detectLanguagePolicy(value, { detectLanguage } = {}) {
    const text = String(value || "").trim();
    const scripts = detectScripts(text);
    const groups = detectScriptGroups(scripts);
    let browserResult = { isReliable: false, languages: [] };
    try {
      browserResult =
        typeof detectLanguage === "function" ? (await detectLanguage(text)) || browserResult : browserResult;
    } catch {}
    const languages = Array.isArray(browserResult.languages)
      ? [...browserResult.languages].sort(
          (left, right) => Number(right.percentage || 0) - Number(left.percentage || 0)
        )
      : [];
    const top = languages[0] || null;
    const reliable = Boolean(browserResult.isReliable) && Number(top?.percentage || 0) >= 60;
    const hasNegativeSignal =
      NON_RUSSIAN_SIGNALS.test(text) ||
      (reliable && DEFINITELY_NON_RUSSIAN.has(String(top?.language || "").toLowerCase()));
    return {
      browserResult,
      groups,
      scripts,
      technicalLatinMix: isTechnicalLatinMix(text),
      skipTranslation:
        reliable &&
        String(top?.language || "").toLowerCase() === "ru" &&
        !hasNegativeSignal
    };
  }

  function createChromeLanguageDetector(i18n = globalThis.chrome?.i18n) {
    return (text) =>
      new Promise((resolve, reject) => {
        if (!i18n?.detectLanguage) {
          resolve({ isReliable: false, languages: [] });
          return;
        }
        try {
          i18n.detectLanguage(text, (result) => {
            const runtimeError = globalThis.chrome?.runtime?.lastError;
            if (runtimeError) reject(new Error(runtimeError.message));
            else resolve(result || { isReliable: false, languages: [] });
          });
        } catch (error) {
          reject(error);
        }
      });
  }

  return {
    createChromeLanguageDetector,
    detectLanguagePolicy,
    detectScriptGroups,
    detectScripts,
    hasMultipleIndependentLanguageGroups,
    hasMultipleScripts,
    isTechnicalLatinMix,
    synchronousRussianVerdict
  };
});
