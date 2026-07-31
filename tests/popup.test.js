const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const { createTranslatorController } = require("../extension/translator-controller.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("popup exposes an explicit translate button and safe result container", () => {
  const dom = new JSDOM(read("popup/popup.html"));
  const document = dom.window.document;
  assert.equal(document.getElementById("translate").tagName, "BUTTON");
  assert.equal(document.getElementById("source").tagName, "TEXTAREA");
  assert.equal(document.getElementById("result").hasAttribute("hidden"), true);
  assert.equal(document.querySelectorAll("script:not([src])").length, 0);
});

test("ordinary typing only cancels; paste and Ctrl+Enter translate", () => {
  const source = read("popup/popup.js");
  assert.match(source, /addEventListener\("input", \(\) => controller\.cancel\(\)\)/);
  assert.match(source, /addEventListener\("paste"/);
  assert.match(source, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(source, /translateButton\.addEventListener\("click"/);
});

test("translator controller reports validation before opening a port", () => {
  const failures = [];
  const controller = createTranslatorController({
    getText: () => "",
    surface: "popup",
    runtime: { connect: () => assert.fail("port must not open") },
    view: {
      failed: (error) => failures.push(error.message),
      start() {},
      delta() {},
      completed() {}
    }
  });
  assert.equal(controller.translate(), false);
  assert.match(failures[0], /Введите/);
});
