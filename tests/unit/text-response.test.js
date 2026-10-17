const assert = require("node:assert/strict");
const test = require("node:test");

const { parse } = require("../../src/text-response.js");

test("parses a regular translated text", () => {
  assert.deepEqual(parse("[[text]]\nПереведённый абзац."), {
    mode: "text",
    text: "Переведённый абзац.",
    sections: []
  });
});

test("parses multilingual sections in their original order", () => {
  assert.deepEqual(
    parse(
      "[[multilingual]]\n" +
        "[[script:Cyrillic|lang:русский]]\nПривет!\n" +
        "[[script:Latin|lang:английский]]\nКак дела?\n" +
        "[[script:Arabic|lang:арабский]]\nДобро пожаловать."
    ),
    {
      mode: "multilingual",
      text: "",
      sections: [
        { script: "Cyrillic", language: "русский", text: "Привет!" },
        { script: "Latin", language: "английский", text: "Как дела?" },
        { script: "Arabic", language: "арабский", text: "Добро пожаловать." }
      ]
    }
  );
});

test("keeps compatibility with language-only section markers", () => {
  assert.deepEqual(parse("[[multilingual]]\n[[lang:арабский]]\nПеревод.").sections, [
    { script: "", language: "арабский", text: "Перевод." }
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
