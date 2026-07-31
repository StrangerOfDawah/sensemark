(function exposeSettingsService(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("./config.js"),
          schema: require("./settings-schema.js")
        }
      : {
          config: root.SensemarkConfig,
          schema: root.SensemarkSettingsSchema
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSettingsService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ config, schema }) => {
  function createSettingsService(storageArea) {
    if (!storageArea) throw new TypeError("A storage area is required.");

    async function readAll() {
      const stored = await storageArea.get(null);
      const migration = schema.migrateStoredSettings(stored);
      if (migration.migrated) {
        await storageArea.set({ [config.SETTINGS_KEY]: migration.settings });
        if (migration.legacyKeys.length && storageArea.remove) {
          await storageArea.remove(migration.legacyKeys);
        }
      }
      return migration.settings;
    }

    async function write(nextSettings) {
      const settings = schema.normalizeSettings(nextSettings);
      await storageArea.set({ [config.SETTINGS_KEY]: settings });
      return settings;
    }

    async function patch(patchValue, visibility = "private") {
      const current = await readAll();
      return write(schema.patchSettings(current, patchValue, visibility));
    }

    return {
      getPrivate: readAll,
      async getPublic() {
        return schema.publicSettings(await readAll());
      },
      patchPrivate(patchValue) {
        return patch(patchValue, "private");
      },
      patchPublic(patchValue) {
        return patch(patchValue, "public");
      },
      write
    };
  }

  async function restrictLocalStorageToTrustedContexts(chromeApi) {
    try {
      await chromeApi?.storage?.local?.setAccessLevel?.({
        accessLevel: "TRUSTED_CONTEXTS"
      });
      return true;
    } catch {
      return false;
    }
  }

  return { createSettingsService, restrictLocalStorageToTrustedContexts };
});
