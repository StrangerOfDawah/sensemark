(function exposePublicSettingsClient(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? { config: require("../shared/config.js") }
      : { config: root.SensemarkConfig };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkPublicSettingsClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function fallbackSettings() {
    return {
      schemaVersion: dependencies.config.SETTINGS_VERSION,
      selection: {
        mode: dependencies.config.SELECTION_MODE.BUTTON,
        stableDelayMs: 600,
        requiredModifier: "none"
      },
      ui: { scale: 1, cardWidth: 0, cardHeight: 0 }
    };
  }

  function createPublicSettingsClient(runtime = chrome.runtime) {
    return {
      async get() {
        const response = await runtime.sendMessage({
          type: dependencies.config.MESSAGE.PUBLIC_SETTINGS_GET
        });
        if (!response?.ok) {
          return fallbackSettings();
        }
        return response.settings;
      },
      async patch(patch) {
        const response = await runtime.sendMessage({
          type: dependencies.config.MESSAGE.PUBLIC_SETTINGS_PATCH,
          patch
        });
        if (!response?.ok) throw new Error("Не удалось сохранить настройки интерфейса.");
        return response.settings;
      }
    };
  }

  return { createPublicSettingsClient, fallbackSettings };
});
