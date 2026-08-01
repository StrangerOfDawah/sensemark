const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const errors = require("../shared/errors.js");
const schema = require("../shared/settings-schema.js");
const settingsModule = require("../shared/settings-service.js");
const { createRequestClient } = require("../background/request-client.js");
const cacheModule = require("../background/translation-cache.js");
const { createRequestCoordinator } = require("../background/request-coordinator.js");
const { createProviderRegistry } = require("../background/provider-registry.js");
const { createTranslationService } = require("../background/translation-service.js");
const { createSidePanelState } = require("../background/side-panel-state.js");

function memoryStorage(initial = {}) {
  const state = structuredClone(initial);
  return {
    state,
    async get(key) {
      if (key == null) return structuredClone(state);
      if (typeof key === "string") return { [key]: structuredClone(state[key]) };
      return structuredClone(state);
    },
    async set(value) {
      Object.assign(state, structuredClone(value));
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
}

test("settings service performs migration before removing legacy values", async () => {
  const storage = memoryStorage({ apiKey: "secret", autoTranslate: true });
  const service = settingsModule.createSettingsService(storage);
  const settings = await service.getPrivate();
  assert.equal(settings.providers.openai.apiKey, "secret");
  assert.equal(settings.selection.mode, "automatic");
  assert.equal(storage.state.apiKey, undefined);
  assert.equal(storage.state[config.SETTINGS_KEY].schemaVersion, config.SETTINGS_VERSION);
  const publicValue = await service.getPublic();
  assert.equal(publicValue.providers, undefined);
  await service.patchPublic({ ui: { scale: 1.4 }, providers: { openai: { apiKey: "bad" } } });
  assert.equal((await service.getPrivate()).providers.openai.apiKey, "secret");
  await service.patchPrivate({ providers: { openai: { model: "next" } } });
  assert.equal((await service.getPrivate()).providers.openai.model, "next");
  await service.write(schema.defaultSettings());
  assert.equal((await service.getPrivate()).selection.mode, "automatic");
});

test("local storage access is restricted when the platform supports it", async () => {
  let accessLevel = "";
  assert.equal(
    await settingsModule.restrictLocalStorageToTrustedContexts({
      storage: {
        local: {
          async setAccessLevel(value) {
            accessLevel = value.accessLevel;
          }
        }
      }
    }),
    true
  );
  assert.equal(accessLevel, "TRUSTED_CONTEXTS");
  assert.equal(
    await settingsModule.restrictLocalStorageToTrustedContexts({
      storage: { local: { setAccessLevel: async () => Promise.reject(new Error("old Chrome")) } }
    }),
    false
  );
});

test("request client retries transient failures only before returning a response", async () => {
  let calls = 0;
  const waits = [];
  const client = createRequestClient({
    async fetchImpl() {
      calls += 1;
      if (calls === 1) return new Response("", { status: 503 });
      return new Response("ok", { status: 200 });
    },
    sleep: async (milliseconds) => waits.push(milliseconds)
  });
  const result = await client.request("https://example.test", {}, { maximumRetries: 1 });
  assert.equal(result.response.status, 200);
  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [250]);

  const limited = createRequestClient({
    fetchImpl: async () =>
      new Response("", { status: 429, headers: { "retry-after": "10" } }),
    sleep: async () => assert.fail("long Retry-After must not sleep")
  });
  assert.equal(
    (await limited.request("https://example.test", {}, { maximumRetries: 1 })).attempts,
    1
  );

  let quotaCalls = 0;
  const quota = createRequestClient({
    fetchImpl: async () => {
      quotaCalls += 1;
      return new Response("insufficient_quota", {
        status: 429,
        headers: { "retry-after": "1" }
      });
    },
    sleep: async () => assert.fail("quota must not retry")
  });
  await quota.request("https://example.test", {}, { maximumRetries: 1 });
  assert.equal(quotaCalls, 1);
});

test("request client normalizes network and abort failures", async () => {
  const network = createRequestClient({
    fetchImpl: async () => {
      throw new TypeError("offline");
    },
    sleep: async () => {}
  });
  await assert.rejects(
    network.request("x", {}, { maximumRetries: 0 }),
    (error) => error.code === errors.ERROR_CODE.NETWORK
  );

  const controller = new AbortController();
  controller.abort();
  const aborted = createRequestClient({
    fetchImpl: async (_url, init) => {
      throw init.signal.reason || new DOMException("abort", "AbortError");
    }
  });
  await assert.rejects(
    aborted.request("x", {}, { signal: controller.signal }),
    (error) => error.code === errors.ERROR_CODE.ABORTED
  );
});

test("session cache hashes keys, expires entries and promotes LRU hits", async () => {
  let now = 1000;
  const storage = memoryStorage();
  const cache = cacheModule.createTranslationCache(storage, {
    ttlMs: 100,
    maximumEntries: 2,
    maximumBytes: 10000,
    now: () => now
  });
  await cache.set("a", { text: "A" });
  now += 1;
  await cache.set("b", { text: "B" });
  now += 1;
  assert.deepEqual(await cache.get("a"), { text: "A" });
  now += 1;
  await cache.set("c", { text: "C" });
  assert.equal(await cache.get("b"), null);
  assert.deepEqual(await cache.get("a"), { text: "A" });
  now += 200;
  assert.equal(await cache.get("a"), null);
  await cache.clear();
  assert.equal(storage.state[config.CACHE_KEY], undefined);
  assert.equal((await cacheModule.sha256("same")).length, 64);
});

test("request coordinator cancels only the superseded surface scope", () => {
  const coordinator = createRequestCoordinator();
  const first = coordinator.begin({ surface: "content", tabId: 1, frameId: 0 });
  const other = coordinator.begin({ surface: "content", tabId: 2, frameId: 0 });
  const replacement = coordinator.begin({ surface: "content", tabId: 1, frameId: 0 });
  assert.equal(first.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  replacement.finish();
  coordinator.cancel({ surface: "content", tabId: 2, frameId: 0 });
  assert.equal(other.signal.aborted, true);
  assert.equal(coordinator.keyFor({ surface: "popup" }), "popup:extension:0");
});

test("side-panel pending selection is short-lived session state", async () => {
  const storage = memoryStorage();
  let now = 1000;
  const state = createSidePanelState(storage, { now: () => now, ttlMs: 100 });
  const identity = { tabId: 3, frameId: 1, requestId: "request" };
  await state.set({ ...identity, text: " selected ", context: " nearby " });
  assert.equal((await state.get(identity)).text, "selected");
  now += 101;
  assert.equal(await state.get(identity), null);
  await state.set({ ...identity, text: "again" });
  await state.clear(identity);
  assert.equal(await state.get(identity), null);
});

test("provider registry validates providers and exposes only registered IDs", () => {
  const provider = {
    id: "openai",
    displayName: "OpenAI",
    capabilities: {},
    validateConfiguration() {},
    translate() {},
    normalizeError(error) {
      return error;
    },
    settingsDescriptor: {}
  };
  const registry = createProviderRegistry([provider]);
  assert.equal(registry.get("openai"), provider);
  assert.equal(registry.has("openai"), true);
  assert.deepEqual(registry.ids(), ["openai"]);
  assert.throws(() => registry.get("gemini"), /Unknown/);
  assert.throws(() => createProviderRegistry([{}]), /needs id/);
});

test("translation service enforces consent/key, skips Russian and uses cache", async () => {
  let settings = schema.normalizeSettings({
    providers: { openai: { apiKey: "", model: "model" } }
  });
  const cachedValues = new Map();
  const cache = {
    get: async (key) => cachedValues.get(key) || null,
    set: async (key, value) => cachedValues.set(key, value)
  };
  let providerCalls = 0;
  const provider = {
    id: "openai",
    displayName: "OpenAI",
    capabilities: {},
    validateConfiguration() {},
    normalizeError(error) {
      return error;
    },
    settingsDescriptor: {
      apiKey: { type: "secret", required: true }
    },
    async translate(_request, options) {
      providerCalls += 1;
      options.onDelta?.("перевод");
      return { kind: "translation", text: "перевод", alternatives: [], explanation: "", sections: [] };
    }
  };
  const service = createTranslationService({
    settingsService: { getPrivate: async () => settings },
    providerRegistry: createProviderRegistry([provider]),
    cache,
    languageDetector: async (text) => ({
      isReliable: true,
      languages: [
        {
          language: /\p{Script=Cyrillic}/u.test(text) ? "ru" : "en",
          percentage: 99
        }
      ]
    })
  });

  const russianDeltas = [];
  const russian = await service.translate(
    { text: "Это русский текст", mode: "text" },
    { onDelta: (delta) => russianDeltas.push(delta) }
  );
  assert.equal(russian.skippedProvider, true);
  assert.equal(russian.status, "skipped-russian");
  assert.equal(russian.result, null);
  assert.deepEqual(russianDeltas, []);

  await assert.rejects(
    service.translate({ text: "hello", mode: "text" }),
    (error) => error.code === errors.ERROR_CODE.CONSENT
  );
  settings = {
    ...settings,
    privacyConsentVersion: config.PRIVACY_CONSENT_VERSION
  };
  await assert.rejects(
    service.translate({ text: "hello", mode: "text" }),
    (error) => error.code === errors.ERROR_CODE.CONFIGURATION_REQUIRED
  );
  settings.providers.openai.apiKey = "secret";
  const first = await service.translate({ text: "hello", mode: "text" });
  const secondDeltas = [];
  const second = await service.translate(
    { text: "hello", mode: "text" },
    { onDelta: (delta) => secondDeltas.push(delta) }
  );
  assert.equal(first.cached, false);
  assert.equal(second.cached, true);
  assert.equal(providerCalls, 1);
  assert.deepEqual(secondDeltas, ["перевод"]);
});
