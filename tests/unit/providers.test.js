const assert = require("node:assert/strict");
const test = require("node:test");
const Providers = require("../../src/providers.js");

const settings = (overrides = {}) => ({ ...Providers.SETTINGS_DEFAULTS, ...overrides });

test("only known paid services count as cloud providers; anything else is free mode", () => {
  assert.deepEqual(Providers.CLOUD_IDS, ["openai", "deepseek", "yandex"]);
  for (const id of Providers.CLOUD_IDS) assert.equal(Providers.normalize(id), id);
  for (const value of ["builtin", "", undefined, "gemini", "OPENAI"]) {
    assert.equal(Providers.normalize(value), "builtin");
  }
  assert.equal(Providers.get("builtin"), null);
});

test("OpenAI keeps the original key and consent fields, so existing users are not reset", () => {
  const saved = settings({ provider: "openai", apiKey: " sk-old ", privacyConsentVersion: 1 });
  assert.equal(Providers.apiKey(saved), "sk-old");
  assert.equal(Providers.hasConsent(saved), true);
  assert.equal(Providers.settingsIssue(saved), null);
  assert.deepEqual(Providers.consentPatch(saved, "openai", false), { privacyConsentVersion: 0 });
});

test("consent to OpenAI does not cover DeepSeek or YandexGPT", () => {
  const base = settings({ privacyConsentVersion: 1, deepseekApiKey: "sk-ds" });
  assert.equal(Providers.hasConsent({ ...base, provider: "deepseek" }), false);
  assert.equal(Providers.settingsIssue({ ...base, provider: "deepseek" }), "consent");

  const patch = Providers.consentPatch(base, "deepseek", true);
  assert.deepEqual(patch, { providerConsent: { deepseek: 1 } });
  const agreed = { ...base, ...patch, provider: "deepseek" };
  assert.equal(Providers.settingsIssue(agreed), null);
  assert.equal(Providers.hasConsent({ ...agreed, provider: "yandex" }), false);

  // Withdrawing one consent keeps the others.
  const both = { ...agreed, ...Providers.consentPatch(agreed, "yandex", true) };
  assert.deepEqual(Providers.consentPatch(both, "deepseek", false), {
    providerConsent: { deepseek: 0, yandex: 1 }
  });
});

test("settings issues name the first missing piece", () => {
  assert.equal(Providers.settingsIssue(settings({ provider: "builtin" })), null);
  assert.equal(
    Providers.settingsIssue(settings({ provider: "deepseek", providerConsent: { deepseek: 1 } })),
    "api-key"
  );
  const yandex = settings({ provider: "yandex", providerConsent: { yandex: 1 }, yandexApiKey: "AQVN-key" });
  assert.equal(Providers.settingsIssue(yandex), "folder");
  assert.equal(Providers.settingsIssue({ ...yandex, yandexFolderId: " b1gfolder " }), null);
});

test("each provider's key goes only to its own address", () => {
  const all = settings({
    apiKey: "sk-openai",
    deepseekApiKey: "sk-deepseek",
    yandexApiKey: "AQVN-yandex",
    yandexFolderId: "b1gfolder",
    model: "gpt-6-luna"
  });

  const openai = Providers.connection({ ...all, provider: "openai" });
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.headers.Authorization, "Bearer sk-openai");
  assert.equal(openai.model, "gpt-6-luna");

  const deepseek = Providers.connection({ ...all, provider: "deepseek" });
  assert.equal(deepseek.url, "https://api.deepseek.com/chat/completions");
  assert.equal(deepseek.headers.Authorization, "Bearer sk-deepseek");
  assert.equal(deepseek.model, "deepseek-flash");
  assert.equal("OpenAI-Project" in deepseek.headers, false);

  const yandex = Providers.connection({ ...all, provider: "yandex" });
  assert.equal(yandex.url, "https://llm.api.cloud.yandex.net/v1/chat/completions");
  assert.equal(yandex.headers.Authorization, "Bearer AQVN-yandex");
  assert.equal(yandex.headers["OpenAI-Project"], "b1gfolder");
  assert.equal(yandex.model, "gpt://b1gfolder/yandexgpt-lite/latest");

  for (const request of [openai, deepseek, yandex]) {
    const url = new URL(request.url);
    assert.equal(url.protocol, "https:");
    assert.equal(url.host, Providers.get(request.provider).host);
    assert.equal(Providers.get(request.provider).origin, `https://${url.host}/*`);
  }
  assert.throws(() => Providers.connection({ ...all, provider: "builtin" }), /Unknown provider/);
});

test("new providers ask for their host permission only when chosen", () => {
  assert.equal(Providers.get("openai").optionalPermission, false);
  assert.equal(Providers.get("deepseek").optionalPermission, true);
  assert.equal(Providers.get("yandex").optionalPermission, true);
});
