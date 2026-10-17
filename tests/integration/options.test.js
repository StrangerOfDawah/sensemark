const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { getMessage, t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

async function setupOptions(overrides = {}) {
  const html = fs.readFileSync(path.join(__dirname, "..", "..", "src", "options.html"), "utf8");
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "options.js"), "utf8");
  const i18nSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "i18n.js"), "utf8");
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "https://extension.test/options.html"
  });
  Object.defineProperty(dom.window.navigator, "platform", {
    configurable: true,
    value: overrides.platform || "MacIntel"
  });

  const settings = {
    provider: "openai",
    apiKey: "saved-key",
    model: "gpt-6-luna",
    targetLang: t("targetLanguage"),
    autoTranslate: true,
    privacyConsentVersion: 1,
    ...overrides.settings
  };
  for (const key of overrides.omit || []) delete settings[key];
  const writes = [];
  const messages = [];
  dom.window.chrome = {
    i18n: { getMessage },
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
        return overrides.response || { ok: true, text: `[[text]]\n${RU.helloWorld}` };
      }
    }
  };

  dom.window.eval(`${i18nSource}\n//# sourceURL=i18n.js`);
  dom.window.eval(`${source}\n//# sourceURL=options.js`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document: dom.window.document, dom, messages, settings, writes };
}

test("options page loads saved values and platform shortcut", async () => {
  const context = await setupOptions();
  assert.equal(context.document.getElementById("apiKey").value, "saved-key");
  assert.equal(context.document.getElementById("model").value, "gpt-6-luna");
  assert.equal(context.document.querySelector('input[value="openai"]').checked, true);
  assert.equal(context.document.getElementById("openaiSettings").hidden, false);
  assert.equal(context.document.getElementById("autoTranslate").checked, true);
  assert.equal(context.document.getElementById("dataConsent").checked, true);
  assert.match(context.document.getElementById("kbd").textContent, /⌘⇧Y/);
});

test("options collection fixes the target language and persists consent", async () => {
  const context = await setupOptions();
  context.document.getElementById("apiKey").value = " new-key ";
  context.document.getElementById("autoTranslate").checked = false;
  context.document.getElementById("dataConsent").checked = false;

  const collected = context.dom.window.collect();
  assert.equal(collected.apiKey, "new-key");
  assert.equal(collected.targetLang, t("targetLanguage"));
  assert.equal(collected.autoTranslate, false);
  assert.equal(collected.privacyConsentVersion, 0);
  await context.dom.window.save();
  assert.equal(context.writes.at(-1).targetLang, t("targetLanguage"));
});

test("key verification validates setup and reports API success", async () => {
  const context = await setupOptions();
  const consent = context.document.getElementById("dataConsent");
  const key = context.document.getElementById("apiKey");
  const button = context.document.getElementById("test");
  const status = context.document.getElementById("testStatus");

  consent.checked = false;
  button.click();
  assert.equal(status.textContent, t("testNeedsConsent"));

  consent.checked = true;
  key.value = "";
  button.click();
  assert.equal(status.textContent, t("testNeedsKey"));

  key.value = "valid-key";
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.messages[0].type, "translate");
  assert.equal(status.textContent, t("testWorks", RU.helloWorld));
  assert.doesNotMatch(status.textContent, /\[\[/);
  assert.equal(button.disabled, false);
});

test("free mode hides every OpenAI setting and needs no key", async () => {
  const context = await setupOptions({
    settings: { provider: "builtin", apiKey: "", privacyConsentVersion: 0 }
  });
  assert.equal(context.document.querySelector('input[value="builtin"]').checked, true);
  assert.equal(context.document.getElementById("openaiSettings").hidden, true);

  const openai = context.document.querySelector('input[value="openai"]');
  openai.checked = true;
  openai.dispatchEvent(new context.dom.window.Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.document.getElementById("openaiSettings").hidden, false);
  assert.equal(context.writes.at(-1).provider, "openai");
});

test("a retired model is replaced by the current cheapest one", async () => {
  const context = await setupOptions({ settings: { model: "gpt-4o-mini" } });
  assert.equal(context.document.getElementById("model").value, "gpt-6-luna");
  assert.equal(context.settings.model, "gpt-6-luna");
});

test("the OpenAI option explains the benefit and the approximate cost", async () => {
  const { document } = await setupOptions();
  const modes = document.getElementById("modeGroup").textContent;
  for (const key of ["tagFree", "tagSmart", "tagPrice", "modeOpenaiCaption"]) {
    assert.ok(modes.includes(t(key)), `settings show ${key}`);
  }
  // Prices are written with $$ in messages.json; users see a single $.
  assert.match(t("tagPrice"), /^[^$]*\$1\b/);
  assert.match(t("modeOpenaiCaption"), /\$5\b/);
});

test("every text on the settings page comes from messages.json", async () => {
  const { document } = await setupOptions();
  const walker = document.createTreeWalker(document.body, 128);
  const leftovers = [];
  while (walker.nextNode())
    if (walker.currentNode.data.startsWith("t:")) leftovers.push(walker.currentNode.data);
  assert.deepEqual(leftovers, [], "every placeholder is replaced");
  assert.equal(document.title, t("optionsTitle"));
  assert.equal(document.getElementById("toggleKey").getAttribute("title"), t("showKey"));
});

test("auto-translate switch is on by default for a fresh install", async () => {
  const context = await setupOptions({ omit: ["autoTranslate"] });
  assert.equal(context.document.getElementById("autoTranslate").checked, true);
});
