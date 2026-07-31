const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const scorer = require("../content/selection/candidate-scorer.js");
const context = require("../content/selection/context-extractor.js");
const reader = require("../content/selection/selection-reader.js");

test("candidate scorer prefers native readable text but rejects PUA-heavy glyphs", () => {
  const native = scorer.scoreCandidate({ source: "native", text: "ordinary text" });
  const range = scorer.scoreCandidate({ source: "range", text: "ordinary text" });
  assert.ok(native > range);
  assert.ok(
    scorer.scoreCandidate({ source: "accessibility", text: "meaningful label" }) >
      scorer.scoreCandidate({ source: "native", text: "\uE000\uE001\uE002" })
  );
  assert.equal(scorer.scoreCandidate({ source: "native", text: "" }), -Infinity);
  assert.equal(
    scorer.chooseCandidate([
      { source: "native", text: "\uE000\uE001" },
      { source: "accessibility", text: "Accessible phrase" }
    ]).source,
    "accessibility"
  );
  assert.equal(scorer.chooseCandidate([]), null);
});

test("form controls are a first-class selection source", () => {
  const dom = new JSDOM(`<textarea>alpha beta gamma</textarea>`, { pretendToBeVisual: true });
  const textarea = dom.window.document.querySelector("textarea");
  textarea.setSelectionRange(6, 10);
  const selection = reader.formSelection(textarea);
  assert.equal(selection.text, "beta");
  assert.equal(selection.source, "form");
  textarea.setSelectionRange(5, 5);
  assert.equal(reader.formSelection(textarea), null);
  assert.equal(reader.formSelection(dom.window.document.body), null);
});

test("native Selection/Range is the fast path", () => {
  const dom = new JSDOM(`<p>Hello <strong>universal world</strong>.</p>`, {
    pretendToBeVisual: true
  });
  const document = dom.window.document;
  const textNode = document.querySelector("strong").firstChild;
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const result = reader.readSelection({ documentObject: document, target: textNode.parentElement });
  assert.equal(result.text, "universal world");
  assert.equal(result.source, "native");
});

test("PUA-heavy native selection falls back to a standard accessible label", () => {
  const dom = new JSDOM(`<p><span aria-label="Readable selection">\uE000\uE001</span></p>`, {
    pretendToBeVisual: true
  });
  const document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  const span = document.querySelector("span");
  const range = document.createRange();
  range.selectNodeContents(span);
  const selection = document.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  const result = reader.readSelection({ documentObject: document, target: span });
  assert.equal(result.source, "accessibility");
  assert.equal(result.text, "Readable selection");
  delete global.NodeFilter;
});

test("range fallback candidates use bounded standard text and accessibility fields", () => {
  const dom = new JSDOM(
    `<div><span aria-label="Readable words">\uE000\uE001</span><span> fallback text </span></div>`
  );
  const document = dom.window.document;
  global.NodeFilter = dom.window.NodeFilter;
  const range = document.createRange();
  range.selectNodeContents(document.querySelector("div"));
  const candidates = reader.fallbackCandidates(range, document);
  assert.ok(candidates.some((candidate) => candidate.source === "accessibility"));
  assert.ok(candidates.some((candidate) => candidate.source === "bounded"));
  assert.ok(candidates.length <= reader.MAX_VISITED_NODES);
  delete global.NodeFilter;
});

test("composed ranges are preferred and ordinary ranges remain a fallback", () => {
  const composed = { toString: () => "composed" };
  assert.deepEqual(
    reader.selectionRanges(
      { isCollapsed: false, getComposedRanges: () => [composed], rangeCount: 0 },
      [{}]
    ),
    [composed]
  );
  const ordinary = { toString: () => "ordinary" };
  assert.deepEqual(
    reader.selectionRanges(
      { isCollapsed: false, getComposedRanges: () => [], rangeCount: 1, getRangeAt: () => ordinary },
      []
    ),
    [ordinary]
  );
  assert.deepEqual(reader.selectionRanges({ isCollapsed: true }), []);
});

test("context extraction returns only nearby sentence-sized text", () => {
  const source = "First sentence. The bank was beside the river. Last sentence.";
  assert.equal(context.sentenceAround(source, "bank", 700), source);
  assert.ok(context.sentenceAround(source.repeat(30), "bank", 80).length <= 80);

  const dom = new JSDOM(`<article><p>${source}</p></article>`);
  const document = dom.window.document;
  const node = document.querySelector("p").firstChild;
  const range = document.createRange();
  range.setStart(node, source.indexOf("bank"));
  range.setEnd(node, source.indexOf("bank") + 4);
  assert.match(context.extractContext({ range, selectedText: "bank" }), /river/);
  assert.equal(context.sentenceAround("", "bank"), null);

  const repeated =
    "The first bank was closed. We rested on the second bank beside the river.";
  const repeatedDom = new JSDOM(`<p>${repeated}</p>`);
  const repeatedDocument = repeatedDom.window.document;
  const repeatedNode = repeatedDocument.querySelector("p").firstChild;
  const secondBank = repeated.lastIndexOf("bank");
  const repeatedRange = repeatedDocument.createRange();
  repeatedRange.setStart(repeatedNode, secondBank);
  repeatedRange.setEnd(repeatedNode, secondBank + 4);
  const repeatedContext = context.extractContext({
    range: repeatedRange,
    selectedText: "bank",
    maximum: 55
  });
  assert.match(repeatedContext, /river/);
  assert.doesNotMatch(repeatedContext, /closed/);
});
