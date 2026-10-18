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
  const providersSource = fs.readFileSync(path.join(__dirname, "..", "..", "src", "providers.js"), "utf8");
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
  const permissionRequests = [];
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
    // Optional host permissions: granted unless a test declines them.
    permissions: {
      async request(details) {
        permissionRequests.push(details);
        return overrides.permissionGranted !== false;
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
  dom.window.eval(`${providersSource}\n//# sourceURL=providers.js`);
  dom.window.eval(`${source}\n//# sourceURL=options.js`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { document: dom.window.document, dom, messages, permissionRequests, settings, writes };
}

test("options page loads saved values and platform shortcut", async () => {
  const context = await setupOptions();
  assert.equal(context.document.getElementById("apiKey").value, "saved-key");
  assert.equal(context.document.getElementById("model").value, "gpt-6-luna");
  assert.equal(context.document.querySelector('input[value="openai"]').checked, true);
  assert.equal(context.document.getElementById("providerSettings").hidden, false);
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
  assert.equal(context.document.getElementById("providerSettings").hidden, true);

  const openai = context.document.querySelector('input[value="openai"]');
  openai.checked = true;
  openai.dispatchEvent(new context.dom.window.Event("change"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(context.document.getElementById("providerSettings").hidden, false);
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

const tickOptions = () => new Promise((resolve) => setTimeout(resolve, 0));

async function pick(context, provider) {
  const input = context.document.querySelector(`input[value="${provider}"]`);
  input.checked = true;
  input.dispatchEvent(new context.dom.window.Event("change"));
  await tickOptions();
}

test("DeepSeek and YandexGPT are offered with an icon, a price and what they need", async () => {
  const { document } = await setupOptions();
  const rows = [...document.querySelectorAll('#modeGroup input[name="provider"]')].map(
    (input) => input.value
  );
  assert.deepEqual(rows, ["builtin", "openai", "deepseek", "yandex"]);
  for (const input of document.querySelectorAll('#modeGroup input[name="provider"]')) {
    assert.ok(input.closest(".mode").querySelector(".mode-icon"), `${input.value} has an icon`);
  }
  const modes = document.getElementById("modeGroup").textContent;
  for (const key of ["tagPriceDeepseek", "tagPriceYandex", "modeDeepseekCaption", "modeYandexCaption"]) {
    assert.ok(modes.includes(t(key)), `settings show ${key}`);
  }
});

test("choosing DeepSeek asks for its host permission and names DeepSeek everywhere", async () => {
  const context = await setupOptions();
  await pick(context, "deepseek");
  const { document } = context;

  assert.deepEqual(JSON.parse(JSON.stringify(context.permissionRequests)), [
    { origins: ["https://api.deepseek.com/*"] }
  ]);
  assert.equal(context.writes.at(-1).provider, "deepseek");
  assert.equal(document.getElementById("privacyTitle").textContent, t("privacyTitle", "DeepSeek"));
  assert.match(document.getElementById("privacyText").textContent, new RegExp(t("privacyRegionDeepseek")));
  assert.equal(document.getElementById("consentText").textContent, t("consentText", "DeepSeek"));
  assert.equal(document.getElementById("apiKeyCaption").textContent, t("apiKeyCaption", "api.deepseek.com"));
  assert.equal(document.getElementById("modelRow").hidden, true, "DeepSeek has one fixed model");
  assert.equal(document.getElementById("folderRow").hidden, true);
  // OpenAI's key and consent are not reused for another company.
  assert.equal(document.getElementById("apiKey").value, "");
  assert.equal(document.getElementById("dataConsent").checked, false);
});

test("a declined permission keeps the previous mode", async () => {
  const context = await setupOptions({ permissionGranted: false });
  await pick(context, "yandex");
  assert.equal(context.document.querySelector('input[value="openai"]').checked, true);
  assert.equal(context.document.getElementById("testStatus").textContent, t("permissionDenied", "YandexGPT"));
  assert.equal(context.writes.length, 0, "nothing is saved");
});

test("each service keeps its own key, folder and consent", async () => {
  const context = await setupOptions();
  const { document, dom } = context;
  const key = document.getElementById("apiKey");
  const consent = document.getElementById("dataConsent");

  await pick(context, "yandex");
  assert.equal(document.getElementById("folderRow").hidden, false);
  key.value = " AQVN-yandex ";
  key.dispatchEvent(new dom.window.Event("input"));
  const folder = document.getElementById("folderId");
  folder.value = "b1gfolder";
  folder.dispatchEvent(new dom.window.Event("input"));
  consent.checked = true;
  consent.dispatchEvent(new dom.window.Event("change"));
  await tickOptions();

  await pick(context, "openai");
  assert.equal(key.value, "saved-key", "the OpenAI key comes back");
  assert.equal(consent.checked, true);

  const saved = dom.window.collect();
  assert.equal(saved.apiKey, "saved-key");
  assert.equal(saved.yandexApiKey, "AQVN-yandex");
  assert.equal(saved.yandexFolderId, "b1gfolder");
  assert.equal(saved.privacyConsentVersion, 1);
  assert.equal(saved.providerConsent.yandex, 1);
  assert.equal(saved.providerConsent.deepseek, undefined);
});

test("checking a YandexGPT key without a folder explains what is missing", async () => {
  const context = await setupOptions({
    settings: { provider: "yandex", yandexApiKey: "AQVN", providerConsent: { yandex: 1 } }
  });
  context.document.getElementById("test").click();
  await tickOptions();
  assert.equal(context.document.getElementById("testStatus").textContent, t("setupFolder"));
  assert.equal(context.messages.length, 0, "no request without a folder");
});
