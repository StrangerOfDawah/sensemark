(function exposeProviderRegistry(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkProviderRegistry = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function createProviderRegistry(providers = []) {
    const entries = new Map();
    for (const provider of providers) {
      const valid =
        provider &&
        typeof provider.id === "string" &&
        provider.id &&
        typeof provider.displayName === "string" &&
        provider.displayName &&
        provider.capabilities &&
        typeof provider.capabilities === "object" &&
        typeof provider.validateConfiguration === "function" &&
        typeof provider.translate === "function" &&
        typeof provider.normalizeError === "function" &&
        provider.settingsDescriptor &&
        typeof provider.settingsDescriptor === "object";
      if (!valid) {
        throw new TypeError(
          "A provider needs id, displayName, capabilities, validateConfiguration(), translate(), normalizeError(), and settingsDescriptor."
        );
      }
      if (entries.has(provider.id)) throw new TypeError(`Duplicate provider: ${provider.id}`);
      entries.set(provider.id, provider);
    }
    return {
      get(id) {
        const provider = entries.get(id);
        if (!provider) throw new Error(`Unknown translation provider: ${id}`);
        return provider;
      },
      has(id) {
        return entries.has(id);
      },
      ids() {
        return Array.from(entries.keys());
      }
    };
  }

  return { createProviderRegistry };
});
