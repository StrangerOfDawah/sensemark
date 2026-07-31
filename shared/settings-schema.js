(function exposeSettingsSchema(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("./config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSettingsSchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  function defaultSettings() {
    return {
      schemaVersion: config.SETTINGS_VERSION,
      activeProviderId: "openai",
      providers: {
        openai: {
          apiKey: "",
          model: "gpt-4o-mini"
        }
      },
      targetLanguage: config.TARGET_LANGUAGE,
      selection: {
        mode: config.SELECTION_MODE.BUTTON,
        stableDelayMs: 600,
        requiredModifier: "none"
      },
      ui: {
        scale: 1,
        cardWidth: 0,
        cardHeight: 0
      },
      privacyConsentVersion: 0
    };
  }

  function clampNumber(value, minimum, maximum, fallback) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.min(maximum, Math.max(minimum, number))
      : fallback;
  }

  function normalizeSettings(input = {}) {
    const defaults = defaultSettings();
    const mode = Object.values(config.SELECTION_MODE).includes(input.selection?.mode)
      ? input.selection.mode
      : defaults.selection.mode;
    const modifier = ["none", "alt", "shift", "meta"].includes(
      input.selection?.requiredModifier
    )
      ? input.selection.requiredModifier
      : "none";

    return {
      schemaVersion: config.SETTINGS_VERSION,
      activeProviderId: "openai",
      providers: {
        openai: {
          apiKey: String(input.providers?.openai?.apiKey || "").trim(),
          model: String(input.providers?.openai?.model || defaults.providers.openai.model).trim()
        }
      },
      targetLanguage: config.TARGET_LANGUAGE,
      selection: {
        mode,
        stableDelayMs: Math.round(
          clampNumber(input.selection?.stableDelayMs, 250, 2000, 600)
        ),
        requiredModifier: modifier
      },
      ui: {
        scale: clampNumber(input.ui?.scale, 0.75, 1.75, 1),
        cardWidth: Math.round(clampNumber(input.ui?.cardWidth, 0, 1200, 0)),
        cardHeight: Math.round(clampNumber(input.ui?.cardHeight, 0, 1000, 0))
      },
      privacyConsentVersion:
        Number(input.privacyConsentVersion) === config.PRIVACY_CONSENT_VERSION
          ? config.PRIVACY_CONSENT_VERSION
          : 0
    };
  }

  function migrateStoredSettings(stored = {}) {
    if (stored[config.SETTINGS_KEY]?.schemaVersion === config.SETTINGS_VERSION) {
      return {
        settings: normalizeSettings(stored[config.SETTINGS_KEY]),
        migrated: false,
        legacyKeys: []
      };
    }

    const nested = stored[config.SETTINGS_KEY] || {};
    const hasLegacy = [
      "apiKey",
      "model",
      "targetLang",
      "autoTranslate",
      "privacyConsentVersion",
      "uiScale",
      "cardWidth",
      "cardHeight"
    ].some((key) => Object.prototype.hasOwnProperty.call(stored, key));

    const selectionMode =
      typeof stored.autoTranslate === "boolean"
        ? stored.autoTranslate
          ? config.SELECTION_MODE.AUTOMATIC
          : config.SELECTION_MODE.MANUAL
        : nested.selection?.mode;

    const settings = normalizeSettings({
      ...nested,
      providers: {
        openai: {
          apiKey: stored.apiKey ?? nested.providers?.openai?.apiKey,
          model: stored.model ?? nested.providers?.openai?.model
        }
      },
      selection: {
        ...nested.selection,
        mode: selectionMode
      },
      ui: {
        ...nested.ui,
        scale: stored.uiScale ?? nested.ui?.scale,
        cardWidth: stored.cardWidth ?? nested.ui?.cardWidth,
        cardHeight: stored.cardHeight ?? nested.ui?.cardHeight
      },
      privacyConsentVersion:
        stored.privacyConsentVersion ?? nested.privacyConsentVersion
    });

    return {
      settings,
      migrated: hasLegacy || nested.schemaVersion !== config.SETTINGS_VERSION,
      legacyKeys: hasLegacy
        ? [
            "apiKey",
            "model",
            "targetLang",
            "autoTranslate",
            "privacyConsentVersion",
            "uiScale",
            "cardWidth",
            "cardHeight"
          ]
        : []
    };
  }

  function publicSettings(settings) {
    const normalized = normalizeSettings(settings);
    return {
      schemaVersion: normalized.schemaVersion,
      selection: { ...normalized.selection },
      ui: { ...normalized.ui }
    };
  }

  function patchSettings(settings, patch = {}, visibility = "private") {
    const current = normalizeSettings(settings);
    const allowed =
      visibility === "public"
        ? {
            ...current,
            selection: { ...current.selection, ...(patch.selection || {}) },
            ui: { ...current.ui, ...(patch.ui || {}) }
          }
        : {
            ...current,
            ...patch,
            providers: {
              openai: {
                ...current.providers.openai,
                ...(patch.providers?.openai || {})
              }
            },
            selection: { ...current.selection, ...(patch.selection || {}) },
            ui: { ...current.ui, ...(patch.ui || {}) }
          };
    return normalizeSettings(allowed);
  }

  return {
    defaultSettings,
    migrateStoredSettings,
    normalizeSettings,
    patchSettings,
    publicSettings
  };
});
