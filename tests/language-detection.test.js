const assert = require("node:assert/strict");
const test = require("node:test");

const { detectScripts, hasMultipleScripts, isRussianOnly } = require("../language-detection.js");

test("recognizes Russian-only selections without requiring reliable CLD output", () => {
  assert.equal(isRussianOnly("Привет, как дела?", { isReliable: false, languages: [] }), true);
});

test("does not suppress mixed Russian and English text", () => {
  assert.equal(isRussianOnly("Привет! How are you?"), false);
  assert.equal(hasMultipleScripts("Привет! How are you?"), true);
});

test("ignores Russian selections with small technical Latin insertions", () => {
  const englishBiasedDetection = {
    isReliable: true,
    languages: [{ language: "en", percentage: 72 }]
  };
  assert.equal(
    isRussianOnly(
      "Критичный момент: приложение не запустится с dev-секретом, пока не задан APP_ENV.",
      englishBiasedDetection
    ),
    true
  );
  assert.equal(isRussianOnly("Для локальной среды задайте APP_ENV=development."), true);
  assert.equal(isRussianOnly("Откройте URL в ChatGPT и проверьте результат."), true);
});

test("still translates a real English phrase inside Russian text", () => {
  assert.equal(isRussianOnly("Подпись на странице: Come close to Allah."), false);
});

test("does not treat distinct Ukrainian letters as Russian", () => {
  assert.equal(isRussianOnly("Привіт, як справи?"), false);
});

test("reliable Chrome detection can distinguish a same-script language", () => {
  const bulgarian = {
    isReliable: true,
    languages: [{ language: "bg", percentage: 100 }]
  };
  assert.equal(isRussianOnly("Как си днес?", bulgarian), false);
});

test("detects Latin, Cyrillic, and Arabic as multiple scripts", () => {
  const text = "Hello. Привет. مرحبا.";
  assert.deepEqual(detectScripts(text), ["Latin", "Cyrillic", "Arabic"]);
  assert.equal(hasMultipleScripts(text), true);
});

test("detects Arabic with Quranic diacritics alongside English", () => {
  assert.deepEqual(detectScripts("ذَٰلِكَ ٱلْكِتَٰبُ This is the Scripture"), ["Arabic", "Latin"]);
});

test("treats Japanese kanji and kana as one writing system", () => {
  assert.deepEqual(detectScripts("日本語の文章です"), ["Japanese"]);
});
