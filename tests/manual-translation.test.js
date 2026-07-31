const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const schema = require("../shared/settings-schema.js");
const { createRequestPlan } = require("../extension/request-plan.js");

test("new installations default to explicit button mode and private OpenAI settings", () => {
  const settings = schema.defaultSettings();
  assert.equal(settings.schemaVersion, config.SETTINGS_VERSION);
  assert.equal(settings.selection.mode, config.SELECTION_MODE.BUTTON);
  assert.equal(settings.providers.openai.model, "gpt-4o-mini");
  assert.equal(settings.providers.openai.apiKey, "");
  assert.equal(settings.targetLanguage, "ru");
});

test("legacy storage migration preserves key, model, behavior and card geometry", () => {
  const migration = schema.migrateStoredSettings({
    apiKey: " sk-old ",
    model: "custom-model",
    autoTranslate: true,
    uiScale: 1.25,
    cardWidth: 480,
    cardHeight: 320,
    privacyConsentVersion: 1
  });
  assert.equal(migration.migrated, true);
  assert.ok(migration.legacyKeys.includes("apiKey"));
  assert.deepEqual(migration.settings.providers.openai, {
    apiKey: "sk-old",
    model: "custom-model"
  });
  assert.equal(migration.settings.selection.mode, config.SELECTION_MODE.AUTOMATIC);
  assert.deepEqual(migration.settings.ui, {
    scale: 1.25,
    cardWidth: 480,
    cardHeight: 320
  });
  assert.equal(migration.settings.privacyConsentVersion, 0);
});

test("migration is idempotent and old disabled auto mode maps to manual", () => {
  const old = schema.migrateStoredSettings({ autoTranslate: false }).settings;
  assert.equal(old.selection.mode, config.SELECTION_MODE.MANUAL);
  const stored = schema.migrateStoredSettings({ [config.SETTINGS_KEY]: old });
  assert.equal(stored.migrated, false);
  assert.deepEqual(stored.legacyKeys, []);
  assert.deepEqual(stored.settings, old);
});

test("v1.4 schema migrates to v3 and resets the superseded privacy consent", () => {
  const migration = schema.migrateStoredSettings({
    [config.SETTINGS_KEY]: {
      schemaVersion: 2,
      activeProviderId: "openai",
      providers: { openai: { apiKey: "secret", model: "model-v14" } },
      targetLanguage: "Russian",
      selection: {
        mode: "button",
        stableDelayMs: 750,
        requiredModifier: "shift"
      },
      ui: { scale: 1.2, cardWidth: 420, cardHeight: 260 },
      privacyConsentVersion: 1
    }
  });
  assert.equal(migration.migrated, true);
  assert.equal(migration.settings.schemaVersion, 3);
  assert.equal(migration.settings.targetLanguage, "ru");
  assert.equal(migration.settings.providers.openai.apiKey, "secret");
  assert.equal(migration.settings.privacyConsentVersion, 0);
});

test("normalization clamps public settings and never accepts another provider", () => {
  const normalized = schema.normalizeSettings({
    activeProviderId: "unknown",
    providers: { openai: { apiKey: 123, model: "" } },
    selection: { mode: "bad", stableDelayMs: 99, requiredModifier: "bad" },
    ui: { scale: 8, cardWidth: -5, cardHeight: 4000 },
    privacyConsentVersion: 99
  });
  assert.equal(normalized.activeProviderId, "openai");
  assert.equal(normalized.providers.openai.apiKey, "123");
  assert.equal(normalized.providers.openai.model, "gpt-4o-mini");
  assert.equal(normalized.selection.mode, "button");
  assert.equal(normalized.selection.stableDelayMs, 250);
  assert.equal(normalized.selection.requiredModifier, "none");
  assert.deepEqual(normalized.ui, { scale: 1.75, cardWidth: 0, cardHeight: 1000 });
  assert.equal(normalized.privacyConsentVersion, 0);
});

test("public settings omit API key and public patches cannot alter it", () => {
  const privateSettings = schema.normalizeSettings({
    providers: { openai: { apiKey: "secret", model: "model-a" } }
  });
  assert.deepEqual(Object.keys(schema.publicSettings(privateSettings)).sort(), [
    "schemaVersion",
    "selection",
    "ui"
  ]);
  const patched = schema.patchSettings(
    privateSettings,
    {
      providers: { openai: { apiKey: "stolen" } },
      ui: { scale: 1.3 }
    },
    "public"
  );
  assert.equal(patched.providers.openai.apiKey, "secret");
  assert.equal(patched.ui.scale, 1.3);
  const privatePatch = schema.patchSettings(privateSettings, {
    providers: { openai: { model: "model-b" } },
    selection: { requiredModifier: "alt" }
  });
  assert.equal(privatePatch.providers.openai.model, "model-b");
  assert.equal(privatePatch.selection.requiredModifier, "alt");
});

test("manual request plan validates length and chooses multilingual mode", () => {
  assert.deepEqual(createRequestPlan(""), { error: "Введите или вставьте текст." });
  assert.deepEqual(createRequestPlan("123!?"), { error: "В тексте не найдено слов." });
  assert.match(createRequestPlan("a".repeat(5001)).error, /максимум 5000/);
  const plan = createRequestPlan("hello мир", "sidepanel");
  assert.equal(plan.request.mode, config.TRANSLATION_MODE.MULTILINGUAL);
  assert.equal(plan.request.surface, "sidepanel");
  assert.deepEqual(plan.request.sourceScripts, ["Cyrillic", "Latin"]);
});
