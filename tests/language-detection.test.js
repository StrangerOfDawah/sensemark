const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const language = require("../shared/language-utils.js");
const text = require("../shared/text-utils.js");
const mode = require("../shared/mode-utils.js");

test("text normalization removes invisible controls without destroying paragraphs", () => {
  assert.equal(text.normalizeText("  hello\u200B   world\r\n\r\n\r\nnext  "), "hello world\n\nnext");
  assert.equal(text.countCodePoints("A😀"), 2);
  assert.equal(text.truncateCodePoints("A😀B", 2), "A😀");
  assert.equal(text.truncateCodePoints("AB", 5), "AB");
  assert.equal(text.hasLetters("123!?"), false);
  assert.equal(text.hasLetters("Привет"), true);
  assert.equal(text.privateUseRatio(`A\uE000`), 0.5);
  assert.equal(text.privateUseRatio(""), 0);
});

test("word count uses Segmenter and has a regex fallback", () => {
  assert.equal(text.wordCount("hello, brave world"), 3);
  assert.equal(text.wordCount(""), 0);
  const descriptor = Object.getOwnPropertyDescriptor(Intl, "Segmenter");
  Object.defineProperty(Intl, "Segmenter", { value: undefined, configurable: true });
  assert.equal(text.wordCount("hello, brave world"), 3);
  Object.defineProperty(Intl, "Segmenter", descriptor);
});

test("script detection is universal and Russian skip uses reliable browser detection", async () => {
  assert.deepEqual(language.detectScripts("Hello мир مرحبا 漢字"), [
    "Cyrillic",
    "Latin",
    "Arabic",
    "Han"
  ]);
  assert.equal(language.hasMultipleScripts("hello мир"), true);
  assert.equal(language.hasMultipleScripts("hello"), false);
  const russian = await language.detectLanguagePolicy("Это русский текст", {
    detectLanguage: async () => ({
      isReliable: true,
      languages: [{ language: "ru", percentage: 99 }]
    })
  });
  assert.equal(russian.skipTranslation, true);
  const uncertain = await language.detectLanguagePolicy("Это текст", {
    detectLanguage: async () => ({
      isReliable: false,
      languages: [{ language: "ru", percentage: 30 }]
    })
  });
  assert.equal(uncertain.skipTranslation, false);
});

test("translation mode is deterministic from text shape and bounded context", () => {
  assert.equal(
    mode.determineTranslationMode("hello мир", ""),
    config.TRANSLATION_MODE.MULTILINGUAL
  );
  assert.equal(
    mode.determineTranslationMode("bank", "We sat on the bank of the river."),
    config.TRANSLATION_MODE.CONTEXTUAL
  );
  assert.equal(
    mode.determineTranslationMode("bank", "bank"),
    config.TRANSLATION_MODE.CONTEXTUAL
  );
  assert.equal(
    mode.determineTranslationMode(
      "A deliberately long sentence with more than twelve separate words so it stands on its own.",
      "context"
    ),
    config.TRANSLATION_MODE.TEXT
  );
});
