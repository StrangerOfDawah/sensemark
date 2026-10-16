const assert = require("node:assert/strict");
const test = require("node:test");

const { joinSelectionParts, normalizeSelectionText } = require("../selection-text.js");

test("drops selected interface labels when actual content is present", () => {
  assert.equal(
    joinSelectionParts([
      { text: "Menu", noise: true },
      { text: "The meeting starts at noon.", noise: false },
      { text: "Share", noise: true }
    ]),
    "The meeting starts at noon."
  );
});

test("keeps an explicitly selected control when it is the only text", () => {
  assert.equal(joinSelectionParts([{ text: "Open settings", noise: true }]), "Open settings");
});

test("removes directional and soft-hyphen control noise", () => {
  assert.equal(normalizeSelectionText("Hello⁦ ⁩wor­ld"), "Hello world");
});

test("removes icon-font and zero-width characters but keeps joiners", () => {
  assert.equal(normalizeSelectionText(" Read​ more "), "Read more");
  assert.equal(normalizeSelectionText("می‌خواهم"), "می‌خواهم");
});

test("glues parts of one block without inventing spaces", () => {
  const block = {};
  assert.equal(
    joinSelectionParts([
      { text: "This is un", block },
      { text: "believ", block },
      { text: "able, see ", block },
      { text: "France", block },
      { text: ".", block }
    ]),
    "This is unbelievable, see France."
  );
});

test("keeps paragraphs and explicit line breaks", () => {
  const first = {};
  const second = {};
  assert.equal(
    joinSelectionParts([
      { text: "First\n    paragraph.", block: first },
      { text: "Line one", block: second },
      { lineBreak: true, block: second },
      { text: "line two.", block: second }
    ]),
    "First paragraph.\nLine one\nline two."
  );
});

test("keeps real line breaks only inside preformatted text", () => {
  const block = {};
  assert.equal(
    joinSelectionParts([{ text: "let a = 1;\nlet b = 2;", block, preserveLines: true }]),
    "let a = 1;\nlet b = 2;"
  );
});

test("removing noise in the middle of a sentence leaves a single space", () => {
  const block = {};
  assert.equal(
    joinSelectionParts([
      { text: "Click ", block },
      { text: "here", block, noise: true },
      { text: " to continue.", block }
    ]),
    "Click to continue."
  );
});

test("whitespace-only selection gives an empty result", () => {
  assert.equal(joinSelectionParts([{ text: "   ", block: {} }]), "");
});
