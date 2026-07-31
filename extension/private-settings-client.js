(function exposePrivateSettingsClient(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkPrivateSettingsClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  function createPrivateSettingsClient(runtime = chrome.runtime) {
    async function send(type, value = {}) {
      const response = await runtime.sendMessage({ type, ...value });
      if (!response?.ok) throw new Error(response?.error?.message || "Ошибка настроек.");
      return response;
    }
    return {
      async get() {
        return (await send(config.MESSAGE.PRIVATE_SETTINGS_GET)).settings;
      },
      async patch(patch) {
        return (
          await send(config.MESSAGE.PRIVATE_SETTINGS_PATCH, {
            patch
          })
        ).settings;
      },
      async test() {
        return send(config.MESSAGE.SETTINGS_TEST);
      }
    };
  }

  return { createPrivateSettingsClient };
});
