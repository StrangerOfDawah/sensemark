(async () => {
  if (globalThis.__sensemarkUniversalContentLoaded) return;
  globalThis.__sensemarkUniversalContentLoaded = true;

  const settingsClient = SensemarkPublicSettingsClient.createPublicSettingsClient();
  const initialSettings = await settingsClient
    .get()
    .catch(() => SensemarkPublicSettingsClient.fallbackSettings());
  const translationClient = SensemarkTranslationClient.createTranslationClient();
  const card = SensemarkTranslationCard.createTranslationCard({
    initialView: initialSettings.ui,
    onClose: () => translationClient.cancel(),
    saveView(patch) {
      settingsClient.patch(patch).catch(() => {});
    }
  });
  SensemarkSelectionController.createSelectionController({
    settingsClient,
    translationClient,
    card
  });
})();
