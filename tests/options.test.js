const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

async function setupOptions(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "options.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "options.js"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://extension.test/options.html"
  });
  Object.defineProperty(dom.window.navigator, "platform", {
    configurable: true,
    value: overrides.platform || "MacIntel"
  });

  const settings = {
    apiKey: "saved-key",
    model: "gpt-4o-mini",
    targetLang: "русский",
    autoTranslate: true,
    privacyConsentVersion: 1,
    ...overrides.settings
  };
  const writes = [];
  const messages = [];
  dom.window.chrome = {
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, ...settings };
        },
        async set(value) {
          Object.assign(settings, value);
          writes.push(value);
        }
      }
    },
    runtime: {
      async sendMessage(message) {
        messages.push(message);
        return overrides.response || { ok: true, text: "[[text]]\nПривет, мир!" };
      }
    }
  };

  dom.window.eval(`${source}\n//# sourceURL=options.js`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document: dom.window.document, dom, messages, settings, writes };
}

test("options page loads saved values and platform shortcut", async () => {
  const context = await setupOptions();
  assert.equal(context.document.getElementById("apiKey").value, "saved-key");
  assert.equal(context.document.getElementById("model").value, "gpt-4o-mini");
  assert.equal(context.document.getElementById("autoTranslate").checked, true);
  assert.equal(context.document.getElementById("dataConsent").checked, true);
  assert.match(context.document.getElementById("kbd").textContent, /⌘⇧Y/);
});

test("options collection fixes the target language and persists consent", async () => {
  const context = await setupOptions();
  context.document.getElementById("apiKey").value = " new-key ";
  context.document.getElementById("model").value = "gpt-4.1-mini";
  context.document.getElementById("autoTranslate").checked = false;
  context.document.getElementById("dataConsent").checked = false;

  const collected = context.dom.window.collect();
  assert.equal(collected.apiKey, "new-key");
  assert.equal(collected.targetLang, "русский");
  assert.equal(collected.autoTranslate, false);
  assert.equal(collected.privacyConsentVersion, 0);
  await context.dom.window.save();
  assert.equal(context.writes.at(-1).targetLang, "русский");
});

test("key verification validates setup and reports API success", async () => {
  const context = await setupOptions();
  const consent = context.document.getElementById("dataConsent");
  const key = context.document.getElementById("apiKey");
  const button = context.document.getElementById("test");
  const status = context.document.getElementById("testStatus");

  consent.checked = false;
  button.click();
  assert.match(status.textContent, /подтвердите согласие/i);

  consent.checked = true;
  key.value = "";
  button.click();
  assert.match(status.textContent, /введите ключ/i);

  key.value = "valid-key";
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.messages[0].type, "translate");
  assert.match(status.textContent, /Работает/);
  assert.equal(button.disabled, false);
});
