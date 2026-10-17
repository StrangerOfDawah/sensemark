const assert = require("node:assert/strict");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const I18n = require("../../src/i18n.js");

test("format follows chrome.i18n: placeholders, a literal $$ and a dropped lone $", () => {
  const entry = {
    message: "$NAME$ costs $$1, end$",
    placeholders: { name: { content: "$1" } }
  };
  assert.equal(I18n.format(entry, ["Tea"]), "Tea costs $1, end");
  assert.equal(I18n.format(undefined, []), "");
});

test("messages.json never relies on a lone $, which Chrome silently drops", () => {
  // A regular expression ending in "$" once lost its anchor in Chrome only.
  const lone = Object.entries(I18n.messages())
    .filter(([, entry]) => /\$/.test(entry.message.replace(/\$\$|\$[a-z0-9_@]+\$/gi, "")))
    .map(([key]) => key);
  assert.deepEqual(lone, []);
});

test("t fills placeholders and falls back to the key for an unknown message", () => {
  assert.match(I18n.t("errorTextTooLong", 5000), /5000/);
  assert.equal(I18n.t("noSuchMessage"), "noSuchMessage");
});

test("localize replaces comment placeholders and data-i18n attributes without changing the DOM shape", () => {
  const { document } = new JSDOM(
    '<title data-i18n="optionsTitle">x</title><p id="p"><!--t:optionsLead--> <span id="k"></span></p>' +
      '<button id="b" data-i18n-title="showKey" data-i18n-aria-label="showKey"></button>'
  ).window;
  I18n.localize(document);
  const p = document.getElementById("p");
  // The message and the space after it become one text node, as in hand-written HTML.
  assert.equal(p.childNodes.length, 2);
  assert.equal(p.firstChild.textContent, `${I18n.t("optionsLead")} `);
  assert.equal(document.title, I18n.t("optionsTitle"));
  assert.equal(document.getElementById("b").getAttribute("title"), I18n.t("showKey"));
  assert.equal(document.getElementById("b").getAttribute("aria-label"), I18n.t("showKey"));
});
