const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const config = require("../shared/config.js");
const language = require("../shared/language-utils.js");
const mode = require("../shared/mode-utils.js");
const text = require("../shared/text-utils.js");
const selection = require("../content/selection/selection-reader.js");

function detection(languageCode, percentage = 98, isReliable = true) {
  return {
    isReliable,
    languages: languageCode ? [{ language: languageCode, percentage }] : []
  };
}

test("P0: password controls are never translatable while safe form types work", () => {
  const dom = new JSDOM(`
    <input id="password" type="password" value="secret value">
    <input id="text" type="text" value="ordinary value">
    <input id="email" type="email" value="mail@example.com">
    <textarea id="textarea">textarea value</textarea>
  `);
  const document = dom.window.document;
  for (const [id, start, end] of [
    ["password", 0, 6],
    ["text", 0, 8],
    ["textarea", 0, 8]
  ]) {
    document.getElementById(id).setSelectionRange(start, end);
  }
  const email = document.getElementById("email");
  Object.defineProperties(email, {
    selectionStart: { configurable: true, value: 0 },
    selectionEnd: { configurable: true, value: 4 }
  });

  assert.deepEqual(selection.formSelection(document.getElementById("password")), {
    status: "unsupported",
    reason: "password-field"
  });
  assert.equal(selection.formSelection(document.getElementById("text")).text, "ordinary");
  assert.equal(selection.formSelection(document.getElementById("email")).text, "mail");
  assert.equal(selection.formSelection(document.getElementById("textarea")).text, "textarea");
  assert.deepEqual(
    [...selection.TRANSLATABLE_INPUT_TYPES],
    ["text", "search", "url", "tel", "email"]
  );
});

test("P0: browser language detection skips only high-confidence Russian", async () => {
  for (const value of ["Привет", "Как дела?"]) {
    const result = await language.detectLanguagePolicy(value, {
      detectLanguage: async () => detection("ru")
    });
    assert.equal(result.skipTranslation, true, value);
  }

  for (const [value, code] of [
    ["Как си", "bg"],
    ["Добар дан", "sr"],
    ["Як справи?", "uk"],
    ["Доброго дня", "uk"],
    ["Сәлем", "kk"]
  ]) {
    const result = await language.detectLanguagePolicy(value, {
      detectLanguage: async () => detection(code)
    });
    assert.equal(result.skipTranslation, false, value);
  }

  for (const value of [
    "APP_ENV должен быть production",
    "Java-разработчик",
    "Открой URL в браузере"
  ]) {
    const result = await language.detectLanguagePolicy(value, {
      detectLanguage: async () => detection("ru")
    });
    assert.equal(result.skipTranslation, true, value);
  }
});

test("P0: unreliable, empty and failed browser detection translates on doubt", async () => {
  const cases = [
    async () => detection("ru", 35, false),
    async () => detection("", 0, false),
    async () => {
      throw new Error("i18n unavailable");
    }
  ];
  for (const detectLanguage of cases) {
    assert.equal(
      (
        await language.detectLanguagePolicy("Краткая строка", {
          detectLanguage
        })
      ).skipTranslation,
      false
    );
  }
});

test("P0: script grouping treats Japanese, Korean and Chinese as single groups", () => {
  assert.deepEqual(language.detectScriptGroups("日本語の文章です"), ["Japanese"]);
  assert.deepEqual(language.detectScriptGroups("カタカナ漢字"), ["Japanese"]);
  assert.deepEqual(language.detectScriptGroups("한국 漢字 문장"), ["Korean"]);
  assert.deepEqual(language.detectScriptGroups("中文文本"), ["CJK"]);
  assert.equal(language.hasMultipleIndependentLanguageGroups("日本語の文章です"), false);
  assert.equal(language.hasMultipleIndependentLanguageGroups("Hello — مرحبا"), true);
  assert.equal(language.hasMultipleIndependentLanguageGroups("English 日本語"), true);
  assert.equal(
    language.hasMultipleIndependentLanguageGroups("APP_ENV должен быть production"),
    false
  );
  assert.equal(language.hasMultipleIndependentLanguageGroups("Java-разработчик"), false);
  assert.equal(
    language.hasMultipleIndependentLanguageGroups("Русский текст and English text"),
    true
  );
});

test("P0: contextual mode uses 12 words and 160 code points without requiring context", () => {
  for (const value of [
    "run",
    "Apple",
    "get over it",
    "get the hang of it",
    "could have fooled me",
    "that ship has sailed",
    "read between the lines",
    Array(12).fill("word").join(" "),
    "x".repeat(160)
  ]) {
    assert.equal(
      mode.determineTranslationMode({
        text: value,
        scripts: language.detectScripts(value),
        contextAvailable: false
      }),
      config.TRANSLATION_MODE.CONTEXTUAL,
      value
    );
  }
  assert.equal(
    mode.determineTranslationMode({
      text: Array(13).fill("word").join(" "),
      scripts: ["Latin"],
      contextAvailable: true
    }),
    config.TRANSLATION_MODE.TEXT
  );
  assert.equal(
    mode.determineTranslationMode({
      text: "x".repeat(161),
      scripts: ["Latin"],
      contextAvailable: false
    }),
    config.TRANSLATION_MODE.TEXT
  );
  assert.equal(
    mode.determineTranslationMode({
      text: "Hello — مرحبا",
      scripts: ["Latin", "Arabic"],
      contextAvailable: false
    }),
    config.TRANSLATION_MODE.MULTILINGUAL
  );
});

test("P0: Unicode normalization preserves linguistic joiners and strips controls", () => {
  assert.equal(text.normalizeText("می\u200Cروم"), "می\u200Cروم");
  assert.equal(text.normalizeText("👨\u200D👩\u200D👧\u200D👦"), "👨\u200D👩\u200D👧\u200D👦");
  assert.equal(text.normalizeText("مَرْحَبًا"), "مَرْحَبًا");
  assert.equal(text.normalizeText("soft\u00ADhyphen"), "softhyphen");
  assert.equal(text.normalizeText("a\u202Eb\u2066c\u2069d"), "abcd");
  assert.equal(text.normalizeText("hello\u00A0world"), "hello world");
  assert.equal(text.countCodePoints("A😀B"), 3);
});
