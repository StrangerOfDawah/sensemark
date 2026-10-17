const assert = require("node:assert/strict");
const test = require("node:test");

const { detectScripts, hasMultipleScripts, isRussianOnly } = require("../../src/language-detection.js");
const RU = require("../fixtures/russian.json");

test("recognizes Russian-only selections without requiring reliable CLD output", () => {
  assert.equal(isRussianOnly(RU.helloHowAreYou, { isReliable: false, languages: [] }), true);
});

test("does not suppress mixed Russian and English text", () => {
  assert.equal(isRussianOnly(`${RU.helloExclaim} How are you?`), false);
  assert.equal(hasMultipleScripts(`${RU.helloExclaim} How are you?`), true);
});

test("ignores Russian selections with small technical Latin insertions", () => {
  const englishBiasedDetection = {
    isReliable: true,
    languages: [{ language: "en", percentage: 72 }]
  };
  assert.equal(isRussianOnly(RU.devSecret, englishBiasedDetection), true);
  assert.equal(isRussianOnly(RU.localEnv), true);
  assert.equal(isRussianOnly(RU.openUrl), true);
});

test("still translates a real English phrase inside Russian text", () => {
  assert.equal(isRussianOnly(RU.captionWelcome), false);
});

test("does not treat distinct Ukrainian letters as Russian", () => {
  assert.equal(isRussianOnly(RU.ukrainian), false);
});

test("reliable Chrome detection can distinguish a same-script language", () => {
  const bulgarian = {
    isReliable: true,
    languages: [{ language: "bg", percentage: 100 }]
  };
  assert.equal(isRussianOnly(RU.bulgarian, bulgarian), false);
});

test("detects Latin, Cyrillic, and Arabic as multiple scripts", () => {
  const text = `Hello. ${RU.helloDot} مرحبا.`;
  assert.deepEqual(detectScripts(text), ["Latin", "Cyrillic", "Arabic"]);
  assert.equal(hasMultipleScripts(text), true);
});

test("detects Arabic with diacritics alongside English", () => {
  assert.deepEqual(detectScripts("مَرْحَبًا بِكُمْ Welcome everyone"), ["Arabic", "Latin"]);
});

test("treats Japanese kanji and kana as one writing system", () => {
  assert.deepEqual(detectScripts("日本語の文章です"), ["Japanese"]);
});
