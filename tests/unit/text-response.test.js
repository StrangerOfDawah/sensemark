const assert = require("node:assert/strict");
const test = require("node:test");

const { parse } = require("../../src/text-response.js");
const RU = require("../fixtures/russian.json");

test("parses a regular translated text", () => {
  assert.deepEqual(parse(`[[text]]\n${RU.translatedParagraph}`), {
    mode: "text",
    text: RU.translatedParagraph,
    sections: []
  });
});

test("parses multilingual sections in their original order", () => {
  assert.deepEqual(
    parse(
      "[[multilingual]]\n" +
        `[[script:Cyrillic|lang:${RU.langRussian}]]\n${RU.helloExclaim}\n` +
        `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.howAreYou}\n` +
        `[[script:Arabic|lang:${RU.langArabic}]]\n${RU.welcome}`
    ),
    {
      mode: "multilingual",
      text: "",
      sections: [
        { script: "Cyrillic", language: RU.langRussian, text: RU.helloExclaim },
        { script: "Latin", language: RU.langEnglish, text: RU.howAreYou },
        { script: "Arabic", language: RU.langArabic, text: RU.welcome }
      ]
    }
  );
});

test("keeps compatibility with language-only section markers", () => {
  assert.deepEqual(parse(`[[multilingual]]\n[[lang:${RU.langArabic}]]\n${RU.translationWord}`).sections, [
    { script: "", language: RU.langArabic, text: RU.translationWord }
  ]);
});

test("recognizes a Russian-only skip response", () => {
  assert.equal(parse("[[skip]]").mode, "skip");
});

test("hides incomplete streaming markers and empty multilingual scaffolding", () => {
  assert.equal(parse("[").mode, "pending");
  assert.equal(parse("[[multi").mode, "pending");
  assert.equal(parse("[[multilingual]]\n").mode, "pending");
});
