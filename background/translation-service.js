(function exposeTranslationService(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          cache: require("./translation-cache.js"),
          config: require("../shared/config.js"),
          contracts: require("../shared/contracts.js"),
          errors: require("../shared/errors.js"),
          language: require("../shared/language-utils.js")
        }
      : {
          cache: root.SensemarkTranslationCache,
          config: root.SensemarkConfig,
          contracts: root.SensemarkContracts,
          errors: root.SensemarkErrors,
          language: root.SensemarkLanguageUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTranslationService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function createTranslationService({
    settingsService,
    providerRegistry,
    cache,
    languageDetector
  }) {
    async function translate(rawRequest, options = {}) {
      const request = dependencies.contracts.createTranslationRequest(rawRequest);
      const languagePolicy = await dependencies.language.detectLanguagePolicy(request.text, {
        detectLanguage: languageDetector
      });
      if (languagePolicy.skipTranslation) {
        return {
          status: "skipped-russian",
          result: null,
          cached: false,
          skippedProvider: true,
          languagePolicy
        };
      }

      const settings = await settingsService.getPrivate();
      if (settings.privacyConsentVersion !== dependencies.config.PRIVACY_CONSENT_VERSION) {
        throw new dependencies.errors.SensemarkError(
          dependencies.errors.ERROR_CODE.CONSENT_REQUIRED,
          "Подтвердите отправку выделенного текста внешнему провайдеру в настройках.",
          { settingsRelevant: true }
        );
      }
      const provider = providerRegistry.get(settings.activeProviderId);
      const providerSettings = settings.providers[settings.activeProviderId];
      const missingConfiguration = Object.entries(provider.settingsDescriptor || {}).some(
        ([key, descriptor]) =>
          descriptor?.required &&
          descriptor?.type !== undefined &&
          !String(providerSettings?.[key] || "").trim()
      );
      if (missingConfiguration) {
        throw new dependencies.errors.SensemarkError(
          dependencies.errors.ERROR_CODE.CONFIGURATION_REQUIRED,
          `Настройте ${provider.displayName} перед переводом.`,
          { providerId: provider.id, settingsRelevant: true }
        );
      }
      const rawCacheKey = dependencies.cache.createCacheKey(
        request,
        settings.activeProviderId,
        providerSettings.model,
        {
          sourceLanguage: languagePolicy.browserResult?.languages?.[0]?.language || ""
        }
      );
      const cached = await cache.get(rawCacheKey);
      if (cached) {
        if (request.mode === dependencies.config.TRANSLATION_MODE.TEXT) {
          options.onDelta?.(cached.text);
        }
        return {
          status: "completed",
          result: cached,
          cached: true,
          skippedProvider: false,
          languagePolicy
        };
      }

      const result = await provider.translate(request, {
        providerSettings,
        signal: options.signal,
        onDelta: options.onDelta
      });
      await cache.set(rawCacheKey, result);
      return {
        status: "completed",
        result,
        cached: false,
        skippedProvider: false,
        languagePolicy
      };
    }

    return { translate };
  }

  return { createTranslationService };
});
