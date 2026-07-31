(function exposeSidePanelState(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSidePanelState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  const DEFAULT_TTL_MS = 5 * 60 * 1000;

  function createSidePanelState(storageArea, options = {}) {
    const now = options.now || Date.now;
    const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const consuming = new Set();

    function normalizedIdentity(value = {}) {
      const tabId = Number(value.tabId);
      const frameId = Number.isInteger(Number(value.frameId)) ? Number(value.frameId) : 0;
      const requestId = String(value.requestId || "");
      if (!Number.isInteger(tabId) || tabId < 0 || !requestId) {
        throw new TypeError("Side-panel state requires tabId and requestId.");
      }
      return { tabId, frameId, requestId };
    }

    function keyFor(value) {
      const identity = normalizedIdentity(value);
      return `${config.SIDE_PANEL_PENDING_PREFIX}${identity.tabId}:${identity.frameId}:${identity.requestId}`;
    }

    function prepare(value) {
      const identity = normalizedIdentity(value);
      return {
        ...identity,
        text: String(value.text || "").trim(),
        context: String(value.context || "").trim() || null,
        createdAt: Number.isFinite(value.createdAt) ? value.createdAt : now()
      };
    }

    async function clearExpired() {
      const stored = await storageArea.get(null);
      const expired = Object.entries(stored || {})
        .filter(
          ([key, value]) =>
            key.startsWith(config.SIDE_PANEL_PENDING_PREFIX) &&
            (!Number.isFinite(value?.createdAt) || now() - value.createdAt > ttlMs)
        )
        .map(([key]) => key);
      if (expired.length) await storageArea.remove(expired);
      return expired.length;
    }

    async function store(value) {
      const pending = prepare(value);
      await storageArea.set({ [keyFor(pending)]: pending });
      await clearExpired();
      return pending;
    }

    async function set(value) {
      return store(prepare(value));
    }

    async function consumePending(identity) {
      const key = keyFor(identity);
      if (consuming.has(key)) return null;
      consuming.add(key);
      try {
        await clearExpired();
        const stored = await storageArea.get(key);
        const pending = stored?.[key] || null;
        if (pending) await storageArea.remove(key);
        return pending;
      } finally {
        consuming.delete(key);
      }
    }

    async function get(identity, { consume = false } = {}) {
      if (consume) return consumePending(identity);
      await clearExpired();
      const key = keyFor(identity);
      const stored = await storageArea.get(key);
      return stored?.[key] || null;
    }

    async function clear(identity) {
      await storageArea.remove(keyFor(identity));
    }

    async function clearTab(tabId) {
      if (!Number.isInteger(tabId)) return 0;
      const prefix = `${config.SIDE_PANEL_PENDING_PREFIX}${tabId}:`;
      const stored = await storageArea.get(null);
      const keys = Object.keys(stored || {}).filter((key) => key.startsWith(prefix));
      if (keys.length) await storageArea.remove(keys);
      return keys.length;
    }

    return {
      clear,
      clearExpired,
      clearTab,
      consume: consumePending,
      get,
      keyFor,
      prepare,
      set,
      store
    };
  }

  return { DEFAULT_TTL_MS, createSidePanelState };
});
