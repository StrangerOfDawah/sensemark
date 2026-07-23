const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const { createPopupController } = require("../popup.js");

function eventHub() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(value, ...rest) {
      for (const listener of [...listeners]) listener(value, ...rest);
    }
  };
}

function createPort() {
  const onMessage = eventHub();
  const onDisconnect = eventHub();
  return {
    disconnected: false,
    onDisconnect,
    onMessage,
    posted: [],
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      onDisconnect.emit();
    },
    postMessage(message) {
      this.posted.push(message);
    },
    serverMessage(message) {
      onMessage.emit(message);
    }
  };
}

async function setupPopup(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");
  const dom = new JSDOM(html, { url: "https://extension.test/popup.html" });
  const ports = [];
  const storageChanges = eventHub();
  const settings = {
    apiKey: "test-key",
    model: "gpt-4o-mini",
    targetLang: "русский",
    autoTranslate: false,
    privacyConsentVersion: 1,
    ...overrides.settings
  };
  let optionsOpened = 0;
  const copied = [];
  const chrome = {
    i18n: {
      detectLanguage: overrides.detectLanguage || (async () => ({
        isReliable: true,
        languages: [{ language: "en", percentage: 100 }]
      }))
    },
    runtime: {
      connect() {
        const port = createPort();
        ports.push(port);
        return port;
      },
      openOptionsPage() {
        optionsOpened++;
      }
    },
    storage: {
      local: {
        get: async () => ({ ...settings })
      },
      onChanged: storageChanges
    }
  };
  const navigator = {
    platform: "MacIntel",
    clipboard: {
      async writeText(value) {
        copied.push(value);
      }
    }
  };
  const controller = createPopupController({
    document: dom.window.document,
    chrome,
    navigator,
    window: dom.window
  });
  await controller.init();

  return {
    chrome,
    controller,
    copied,
    document: dom.window.document,
    dom,
    get optionsOpened() {
      return optionsOpened;
    },
    ports,
    storageChanges
  };
}

function setInput(context, value) {
  const input = context.document.getElementById("sourceText");
  input.value = value;
  input.dispatchEvent(new context.dom.window.Event("input", { bubbles: true }));
  return input;
}

test("popup blocks translation until privacy and API settings are ready", async () => {
  const context = await setupPopup({
    settings: { apiKey: "", privacyConsentVersion: 0 }
  });

  setInput(context, "Hello");
  assert.equal(context.document.getElementById("setupBanner").hidden, false);
  assert.equal(context.document.getElementById("translateButton").disabled, true);
  context.document.getElementById("setupButton").click();
  assert.equal(context.optionsOpened, 1);
});

test("popup ignores Russian manual input without opening an API port", async () => {
  const context = await setupPopup({
    detectLanguage: async () => ({
      isReliable: true,
      languages: [{ language: "ru", percentage: 100 }]
    })
  });

  setInput(context, "Этот текст уже на русском языке.");
  await context.controller.translate();

  assert.equal(context.ports.length, 0);
  assert.match(context.document.getElementById("message").textContent, /уже на русском/);
  assert.match(context.document.getElementById("status").textContent, /API не потребовался/);
});

test("popup streams a word translation without exposing protocol markers", async () => {
  const context = await setupPopup();
  setInput(context, "Why");
  await context.controller.translate();

  assert.equal(context.ports.length, 1);
  const port = context.ports[0];
  assert.deepEqual(port.posted[0], {
    type: "start",
    text: "Why",
    context: null,
    wordMode: true,
    sourceScripts: ["Latin"]
  });

  port.serverMessage({ type: "chunk", text: "[[translation]]\n" });
  assert.equal(context.document.getElementById("result").hidden, true);

  port.serverMessage({ type: "chunk", text: "[[translation]]\nпо" });
  assert.equal(context.document.getElementById("result").hidden, false);
  assert.equal(context.document.querySelector(".translation-text").textContent, "по");

  port.serverMessage({
    type: "done",
    text: "[[translation]]\nпочему\nдругие значения: зачем"
  });
  assert.equal(context.document.querySelector(".translation-text").textContent, "почему");
  assert.equal(context.document.querySelector(".detail-text").textContent, "зачем");
  assert.equal(context.document.getElementById("translateButton").classList.contains("busy"), false);
  assert.equal(port.disconnected, true);

  await context.controller.copyResult();
  assert.deepEqual(context.copied, ["почему"]);
  assert.equal(context.document.querySelector("#copyButton span").textContent, "Скопировано");
});

test("popup renders multilingual output with source-language labels", async () => {
  const context = await setupPopup();
  setInput(context, "Hello مرحبا");
  await context.controller.translate();

  const port = context.ports[0];
  assert.deepEqual(port.posted[0].sourceScripts, ["Latin", "Arabic"]);
  assert.equal(port.posted[0].wordMode, false);
  port.serverMessage({
    type: "done",
    text:
      "[[multilingual]]\n" +
      "[[script:Latin|lang:английский]]\nПривет.\n" +
      "[[script:Arabic|lang:арабский]]\nДобро пожаловать."
  });

  assert.equal(context.document.getElementById("resultLabel").textContent, "Несколько языков");
  assert.deepEqual(
    [...context.document.querySelectorAll(".segment-language")].map((item) => item.textContent),
    ["английский → русский", "арабский → русский"]
  );
});

test("popup renders unknown terms in the amber explanation state", async () => {
  const context = await setupPopup();
  setInput(context, "Sensemark");
  await context.controller.translate();
  context.ports[0].serverMessage({
    type: "done",
    text: "[[reference]]\nназвание\nВероятно, название проекта."
  });

  assert.equal(context.document.getElementById("result").classList.contains("reference"), true);
  assert.equal(context.document.getElementById("resultLabel").textContent, "Объяснение");
  assert.equal(context.document.querySelector(".reference-title").textContent, "Sensemark");
  assert.equal(context.document.querySelector(".reference-category").textContent, "название");
});

test("popup aborts a stale stream when the user edits or stops", async () => {
  const context = await setupPopup();
  setInput(context, "Translate this sentence, please.");
  await context.controller.translate();
  const firstPort = context.ports[0];

  setInput(context, "A different sentence.");
  assert.equal(firstPort.disconnected, true);
  assert.equal(context.controller.getState().busy, false);

  await context.controller.translate();
  const secondPort = context.ports[1];
  await context.controller.translate();
  assert.equal(secondPort.disconnected, true);
  assert.match(context.document.getElementById("message").textContent, /остановлен/);
});

test("popup surfaces model errors and unexpected disconnects", async () => {
  const context = await setupPopup();
  setInput(context, "Translate this text.");
  await context.controller.translate();
  context.ports[0].serverMessage({ type: "error", error: "Недостаточно средств." });
  assert.match(context.document.getElementById("message").textContent, /Недостаточно средств/);

  setInput(context, "Try once more.");
  await context.controller.translate();
  context.ports[1].disconnect();
  assert.match(context.document.getElementById("message").textContent, /Соединение прервано/);
});

test("popup reacts to settings changes and supports the keyboard shortcut", async () => {
  const context = await setupPopup({
    settings: { apiKey: "", privacyConsentVersion: 1 }
  });
  setInput(context, "Hello");
  assert.equal(context.document.getElementById("translateButton").disabled, true);

  context.storageChanges.emit({ apiKey: { newValue: "new-key" } }, "local");
  assert.equal(context.document.getElementById("translateButton").disabled, false);

  context.document.getElementById("sourceText").dispatchEvent(
    new context.dom.window.KeyboardEvent("keydown", {
      key: "Enter",
      metaKey: true,
      bubbles: true,
      cancelable: true
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.ports.length, 1);
});
