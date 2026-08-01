const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const config = require("../shared/config.js");
const schema = require("../shared/settings-schema.js");
const renderer = require("../shared/result-renderer.js");
const route = require("../background/selection-route.js");
const selectionController = require("../content/selection/selection-controller.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * UX restoration against the 1.3 baseline (sensemark-pr-3).
 *
 * The refactor drifted the product away from its original feel: the card became a
 * fixed-width slab that no longer closed on an outside click, the default mode
 * required an explicit gesture, a required-modifier control appeared in settings,
 * and a structured payload could be rendered to the user as raw JSON.
 */

// ------------------------------------------------------------------ defaults

test("automatic translation is the default mode", () => {
  const settings = schema.defaultSettings();
  assert.equal(settings.selection.mode, config.SELECTION_MODE.AUTOMATIC);
  assert.equal(settings.selection.mode, "automatic");
});

test("no modifier is required by default", () => {
  assert.equal(schema.defaultSettings().selection.requiredModifier, "none");
  // Even a stored profile asking for one is normalized against the default set,
  // and an unknown value can never become a requirement.
  const normalized = schema.normalizeSettings({
    selection: { requiredModifier: "totally-invalid" }
  });
  assert.equal(normalized.selection.requiredModifier, "none");
});

test("the restored flow does not depend on a mandatory modifier", () => {
  // Nothing in the content runtime may gate translation behind a modifier by
  // default: the default is "none", and the settings UI offers no way to set one.
  assert.equal(schema.defaultSettings().selection.requiredModifier, "none");
  assert.equal(new JSDOM(read("options/options.html")).window.document.getElementById("modifier"), null);
  assert.doesNotMatch(read("options/options.js"), /getElementById\("modifier"\)/);
});

// ------------------------------------------------------------ compact layout

test("the translation card is content-sized, not a fixed slab", () => {
  const css = read("content/ui/translation-card.js");
  const cardRule = css.match(/\n\s*\.card\{[^}]*\}/)[0];

  // 1.3 sized the card to its content between 230 and 400px.
  assert.match(cardRule, /width:max-content/);
  assert.match(cardRule, /min-width:min\(230px/);
  assert.match(cardRule, /max-width:min\(400px/);
  assert.doesNotMatch(cardRule, /width:min\(390px/, "the fixed 390px slab must not return");

  // A body min-height forced a tall card even for a one-word translation.
  const bodyRule = css.match(/\n\s*\.body\{[^}]*\}/)[0];
  assert.match(bodyRule, /min-height:0/);
  assert.doesNotMatch(bodyRule, /min-height:calc\(70px/);
});

test("card typography stays at the compact 1.3 proportions", () => {
  const css = read("content/ui/translation-card.js");
  assert.match(css, /--sm-font-size:calc\(14px/);
  const translation = css.match(/\n\s*\.translation\{[^}]*\}/)[0];
  assert.match(translation, /font-size:1\.04em/, "1.3 rendered the result at 1.04em");
  assert.doesNotMatch(translation, /16px/, "the enlarged 16px result must not return");
});

test("settings stay compact: no oversized advanced block", () => {
  const document = new JSDOM(read("options/options.html")).window.document;
  const ids = Array.from(document.querySelectorAll("[id]"), (node) => node.id);
  assert.ok(!ids.includes("modifier"), "the required-modifier control is gone");
  for (const id of ["apiKey", "model", "selectionMode", "consent", "test"]) {
    assert.ok(ids.includes(id), `the compact essentials must remain: #${id}`);
  }
  // Automatic is offered first so the default reads as the intended flow.
  const modes = Array.from(
    document.querySelectorAll("#selectionMode option"),
    (option) => option.value
  );
  assert.equal(modes[0], "automatic");
});

// ------------------------------------------------------- outside-click close

/** Minimal content-script harness around the real selection controller. */
function mountController({ mode = "automatic" } = {}) {
  const dom = new JSDOM(
    `<!doctype html><body><p id="text">Foreign text in a paragraph.</p></body>`,
    { url: "https://example.test/page" }
  );
  const documentObject = dom.window.document;
  const events = [];
  const host = documentObject.createElement("sensemark-test-ui");
  documentObject.body.append(host);
  const inner = documentObject.createElement("button");
  host.append(inner);

  const originalAdd = globalThis.addEventListener;
  globalThis.addEventListener = () => {};
  const card = {
    host,
    begin: () => events.push("begin"),
    appendDelta: () => {},
    complete: () => {},
    close: () => events.push("close"),
    hideIntent: () => {},
    showError: () => {},
    showIntentButton: () => events.push("intent")
  };
  const controller = selectionController.createSelectionController({
    documentObject,
    languageDetector: async () => ({ isReliable: false, languages: [] }),
    runtime: { onMessage: { addListener() {} } },
    settingsClient: {
      async get() {
        return { selection: { mode, stableDelayMs: 1, requiredModifier: "none" } };
      }
    },
    translationClient: { translate() {} },
    card
  });
  if (originalAdd) globalThis.addEventListener = originalAdd;
  else delete globalThis.addEventListener;

  function pointerDownOn(target) {
    const event = new dom.window.Event("pointerdown", { bubbles: true, composed: true });
    Object.defineProperty(event, "composedPath", {
      value: () => {
        const chain = [];
        for (let node = target; node; node = node.parentNode) chain.push(node);
        return chain;
      }
    });
    target.dispatchEvent(event);
  }

  return { card, controller, documentObject, events, host, inner, pointerDownOn };
}

test("clicking outside the floating card closes it", async () => {
  const harness = mountController();
  await harness.controller.refreshSettings();

  harness.pointerDownOn(harness.documentObject.getElementById("text"));
  assert.ok(harness.events.includes("close"), "an outside pointerdown must close the card");
});

test("clicking inside the card does not close it", async () => {
  const harness = mountController();
  await harness.controller.refreshSettings();

  harness.pointerDownOn(harness.inner);
  assert.ok(
    !harness.events.includes("close"),
    "interaction inside the card must never dismiss it"
  );

  // The host element itself counts as inside too.
  harness.pointerDownOn(harness.host);
  assert.ok(!harness.events.includes("close"));
});

// ------------------------------------------------- card first, side panel last

test("normal pages use the floating card, not the side panel", () => {
  for (const url of [
    "https://example.test/article",
    "http://localhost:3000/",
    "https://news.example/story?id=1"
  ]) {
    assert.equal(
      route.routeForSelection({ url }).route,
      route.ROUTE.CONTENT_SCRIPT,
      `${url} must be handled by the in-page card`
    );
  }

  // And the worker only opens the panel on the direct branch.
  const worker = read("background/service-worker.js");
  const handler = worker.split("chrome.contextMenus.onClicked")[1].split("\n});")[0];
  const afterDelivery = handler.split("await deliverSelection")[1] || "";
  assert.doesNotMatch(
    afterDelivery,
    /openSidePanel/,
    "an ordinary page must never be pushed into the side panel"
  );
});

test("PDF and protected pages still fall back to the side panel", () => {
  for (const url of [
    "https://example.test/paper.pdf",
    "chrome://settings",
    "view-source:https://example.test/",
    "https://chromewebstore.google.com/detail/x"
  ]) {
    assert.equal(
      route.routeForSelection({ url }).route,
      route.ROUTE.DIRECT_SIDE_PANEL,
      `${url} must still use the panel fallback`
    );
  }
});

// ------------------------------------------------------- structured payloads

test("a structured response renders as user-facing text, never raw JSON", () => {
  const dom = new JSDOM("<div id='c'></div>");
  const documentObject = dom.window.document;
  const container = documentObject.getElementById("c");

  const payloads = [
    // The exact shape reported by users.
    JSON.stringify({ text: "привет", context: null, sections: [] }),
    JSON.stringify({
      kind: "multilingual",
      text: "привет",
      sections: [{ script: "Latin", source: "hello", translation: "привет" }]
    }),
    JSON.stringify({ translation: "привет", alternatives: [], explanation: "" }),
    JSON.stringify({ tabId: 1, frameId: 0, requestId: "x", text: "привет", context: null })
  ];

  for (const payload of payloads) {
    // Arriving as a streamed text body...
    container.replaceChildren();
    renderer.renderResult({ documentObject, container, result: {}, fallbackText: payload });
    assert.equal(container.textContent, "привет", payload.slice(0, 40));
    assert.doesNotMatch(container.textContent, /[{}]|"text"|null/);

    // ...and arriving in the text field of a result object.
    container.replaceChildren();
    renderer.renderResult({ documentObject, container, result: { text: payload } });
    assert.doesNotMatch(container.textContent, /[{}]|"text"|null/);
  }

  // An object where a string was expected must not become "[object Object]".
  container.replaceChildren();
  renderer.renderResult({ documentObject, container, result: { translation: { text: "привет" } } });
  assert.equal(container.textContent, "привет");
  assert.doesNotMatch(container.textContent, /object Object/);
});

test("ordinary text that merely starts with a brace is still shown", () => {
  // The guard must not eat legitimate content.
  assert.equal(renderer.displayText("{не json"), "{не json");
  assert.equal(renderer.displayText("обычный перевод"), "обычный перевод");
  assert.equal(renderer.displayText("{ и скобка в конце }"), "{ и скобка в конце }");
});

test("an unrecognisable structured payload renders nothing rather than JSON", () => {
  const dom = new JSDOM("<div id='c'></div>");
  const documentObject = dom.window.document;
  const container = documentObject.getElementById("c");
  renderer.renderResult({
    documentObject,
    container,
    result: {},
    fallbackText: JSON.stringify({ unexpected: true, nested: { deep: 1 } })
  });
  assert.equal(container.textContent, "", "showing nothing beats showing JSON");
});
