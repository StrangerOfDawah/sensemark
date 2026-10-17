const assert = require("node:assert/strict");
const test = require("node:test");

const { parse } = require("../../src/word-response.js");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

test("parses a marked translation without showing the marker", () => {
  assert.deepEqual(parse(`[[translation]]\n${RU.why}\n${t("protocolOtherMeanings")}: ${RU.whatFor}`), {
    mode: "translation",
    main: RU.why,
    category: "",
    detail: RU.whatFor,
    detailLabel: t("labelOtherMeanings")
  });
});

test("parses a reference explanation as a separate response type", () => {
  assert.deepEqual(parse(`[[reference]]\n${RU.title}\n${RU.probablyProjectName}`), {
    mode: "reference",
    main: "",
    category: RU.title,
    detail: RU.probablyProjectName,
    detailLabel: t("labelWhatItMayBe")
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
  const result = parse(`${RU.noSuchWordOld}\n${RU.maybeProjectName}`);

  assert.equal(result.mode, "reference");
  assert.equal(result.category, t("protocolUnknownTerm"));
  assert.equal(result.detail, RU.projectName);
});
