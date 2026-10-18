// Translation services that take the user's own key. All of them speak the
// OpenAI Chat Completions format, so one request path serves every provider;
// this module holds what differs between them: address, key, model, consent.
// Pure data and functions, shared by the service worker, the popup and the
// settings page.
(function exposeProviders(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkProviders = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  // Bumped when the privacy text a user agreed to changes.
  const CONSENT_VERSION = 1;

  const PROVIDERS = {
    openai: {
      id: "openai",
      label: "OpenAI",
      url: "https://api.openai.com/v1/chat/completions",
      origin: "https://api.openai.com/*",
      host: "api.openai.com",
      keySetting: "apiKey",
      keyPlaceholder: "sk-…",
      // Granted at install for users who already had OpenAI.
      optionalPermission: false
    },
    deepseek: {
      id: "deepseek",
      label: "DeepSeek",
      url: "https://api.deepseek.com/chat/completions",
      origin: "https://api.deepseek.com/*",
      host: "api.deepseek.com",
      keySetting: "deepseekApiKey",
      keyPlaceholder: "sk-…",
      optionalPermission: true,
      model: () => "deepseek-flash"
    },
    yandex: {
      id: "yandex",
      label: "YandexGPT",
      url: "https://llm.api.cloud.yandex.net/v1/chat/completions",
      origin: "https://llm.api.cloud.yandex.net/*",
      host: "llm.api.cloud.yandex.net",
      keySetting: "yandexApiKey",
      keyPlaceholder: "AQVN…",
      // Yandex models live in a cloud folder; its ID is part of the model name
      // and goes in a header of every request.
      folderSetting: "yandexFolderId",
      optionalPermission: true,
      model: (settings) => `gpt://${String(settings.yandexFolderId || "").trim()}/yandexgpt-lite/latest`
    }
  };

  const CLOUD_IDS = Object.keys(PROVIDERS);

  // Storage defaults for everything provider-related. "apiKey" and
  // "privacyConsentVersion" keep their original names, so OpenAI users who
  // saved a key before keep it after an update.
  const SETTINGS_DEFAULTS = {
    provider: "builtin",
    apiKey: "",
    deepseekApiKey: "",
    yandexApiKey: "",
    yandexFolderId: "",
    privacyConsentVersion: 0,
    providerConsent: {}
  };

  function isCloud(provider) {
    return CLOUD_IDS.includes(provider);
  }

  // Unknown or missing values fall back to the free on-device translator.
  function normalize(provider) {
    return isCloud(provider) ? provider : "builtin";
  }

  function get(provider) {
    return PROVIDERS[provider] || null;
  }

  function apiKey(settings, provider = settings.provider) {
    const entry = get(provider);
    return entry ? String(settings[entry.keySetting] || "").trim() : "";
  }

  function hasConsent(settings, provider = settings.provider) {
    if (provider === "openai") return settings.privacyConsentVersion === CONSENT_VERSION;
    return Boolean(isCloud(provider) && settings.providerConsent?.[provider] === CONSENT_VERSION);
  }

  // The storage change that records or withdraws consent for one provider.
  function consentPatch(settings, provider, granted) {
    if (provider === "openai") return { privacyConsentVersion: granted ? CONSENT_VERSION : 0 };
    return {
      providerConsent: { ...(settings.providerConsent || {}), [provider]: granted ? CONSENT_VERSION : 0 }
    };
  }

  // What stops a request before it is sent: null when everything is in place.
  function settingsIssue(settings) {
    const provider = settings.provider;
    if (!isCloud(provider)) return null;
    if (!hasConsent(settings, provider)) return "consent";
    if (!apiKey(settings, provider)) return "api-key";
    const folder = PROVIDERS[provider].folderSetting;
    if (folder && !String(settings[folder] || "").trim()) return "folder";
    return null;
  }

  function model(settings) {
    const entry = get(settings.provider);
    if (!entry) return "";
    return entry.model ? entry.model(settings) : settings.model;
  }

  // Address and headers of a request. The key goes only to its own provider.
  function connection(settings) {
    const entry = get(settings.provider);
    if (!entry) throw new Error(`Unknown provider: ${settings.provider}`);
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey(settings)}`
    };
    if (entry.folderSetting) headers["OpenAI-Project"] = String(settings[entry.folderSetting] || "").trim();
    return { provider: entry.id, label: entry.label, url: entry.url, headers, model: model(settings) };
  }

  return {
    CONSENT_VERSION,
    PROVIDERS,
    CLOUD_IDS,
    SETTINGS_DEFAULTS,
    apiKey,
    connection,
    consentPatch,
    get,
    hasConsent,
    isCloud,
    model,
    normalize,
    settingsIssue
  };
});
