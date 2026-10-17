const assert = require("node:assert/strict");
const test = require("node:test");

const { parse } = require("../../src/word-response.js");

test("parses a marked translation without showing the marker", () => {
  assert.deepEqual(parse("[[translation]]\nпочему\nдругие значения: зачем"), {
    mode: "translation",
    main: "почему",
    category: "",
    detail: "зачем",
    detailLabel: "Другие значения"
  });
});

test("parses a reference explanation as a separate response type", () => {
  assert.deepEqual(parse("[[reference]]\nназвание\nВероятно, название проекта."), {
    mode: "reference",
    main: "",
    category: "название",
    detail: "Вероятно, название проекта.",
    detailLabel: "Что это может быть"
  });
});

test("hides an incomplete streaming marker", () => {
  assert.equal(parse("[").mode, "pending");
  assert.equal(parse("[[translat").mode, "pending");
});

test("never exposes an unexpected skip marker as a translation", () => {
  assert.equal(parse("[[skip]]").mode, "skip");
});

test("keeps compatibility with the previous unknown-word format", () => {
  const result = parse(
    "Такого общеупотребительного слова не существует.\nВозможно, это: название проекта."
  );

  assert.equal(result.mode, "reference");
  assert.equal(result.category, "неизвестный термин");
  assert.equal(result.detail, "название проекта.");
});
