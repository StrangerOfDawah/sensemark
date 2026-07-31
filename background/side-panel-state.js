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
        // The window is the panel's own scope: a side panel can resolve the window it
        // lives in without any permission, but it cannot read its own tab id. Keeping
        // the window on the record is what lets the panel claim without a URL identity.
        windowId: Number.isInteger(Number(value.windowId)) ? Number(value.windowId) : null,
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

    async function pendingEntries() {
      const stored = await storageArea.get(null);
      return Object.entries(stored || {}).filter(
        ([key, value]) =>
          key.startsWith(config.SIDE_PANEL_PENDING_PREFIX) && value && value.text
      );
    }

    function matchesScope(record, scope) {
      // A tab match is the strongest signal and is what keeps two tabs isolated.
      if (Number.isInteger(scope.tabId)) return record.tabId === scope.tabId;
      // Otherwise the window is the isolation boundary: Chrome shows one side panel
      // per window, so a record from another window is never ours to claim.
      if (Number.isInteger(scope.windowId)) return record.windowId === scope.windowId;
      return false;
    }

    /**
     * Take the newest pending request that belongs to the given scope, exactly once.
     *
     * Ordering between `store()` and the panel becoming ready is irrelevant here: the
     * panel retries this call within a bounded window, so whichever lands first wins.
     */
    async function claim(scope = {}) {
      await clearExpired();
      const candidates = (await pendingEntries())
        .filter(([, record]) => matchesScope(record, scope))
        .sort(([, left], [, right]) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
      const [match] = candidates;
      if (!match) return null;
      const [key, record] = match;
      // Synchronous check-and-reserve: concurrent claims for one key cannot both win.
      if (consuming.has(key)) return null;
      consuming.add(key);
      try {
        const stored = await storageArea.get(key);
        const pending = stored?.[key] || null;
        if (!pending) return null;
        await storageArea.remove(key);
        return pending;
      } finally {
        consuming.delete(key);
      }
    }

    async function peek(scope = {}) {
      await clearExpired();
      const candidates = (await pendingEntries())
        .filter(([, record]) => matchesScope(record, scope))
        .sort(([, left], [, right]) => Number(right.createdAt || 0) - Number(left.createdAt || 0));
      return candidates[0]?.[1] || null;
    }

    /**
     * Newest-wins policy: a fresh request for a tab drops that tab's older unclaimed
     * requests so a stale selection can never be handed to the panel instead.
     */
    async function supersede(pending) {
      const identity = normalizedIdentity(pending);
      const keepKey = keyFor(identity);
      const stale = (await pendingEntries())
        .filter(([key, record]) => key !== keepKey && record.tabId === identity.tabId)
        .map(([key]) => key);
      if (stale.length) await storageArea.remove(stale);
      return stale.length;
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
      claim,
      clear,
      clearExpired,
      clearTab,
      consume: consumePending,
      get,
      keyFor,
      peek,
      prepare,
      set,
      store,
      supersede
    };
  }

  return { DEFAULT_TTL_MS, createSidePanelState };
});
