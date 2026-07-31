(function exposeConfigurationStatus(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkConfigurationStatus = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function describeConfigurationValidation(validation = {}) {
    if (!validation.validCredentials || !validation.modelExists) {
      return "Не удалось подтвердить API‑ключ и модель.";
    }
    if (validation.compatibility === "verified") {
      return "API‑ключ действителен. Выбранная модель поддерживается Sensemark.";
    }
    if (validation.compatibility === "unsupported") {
      return "API‑ключ действителен, но модель не поддерживает все возможности Sensemark.";
    }
    return "API‑ключ и модель найдены. Совместимость structured output не проверена и подтвердится при первом переводе.";
  }

  return { describeConfigurationValidation };
});
