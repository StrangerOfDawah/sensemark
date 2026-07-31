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
    // Monotonic within a worker generation and assigned synchronously in prepare(),
    // so replacement order follows the order the user actually made the requests —
    // never the order in which storage writes happen to resolve. It resets when the
    // worker restarts, which is why it is only ever the tiebreaker WITHIN a
    // generation; `generationId` orders across generations.
    let sequenceCounter = Number(options.startSequence) || 0;
    let generationPromise = null;
    // One promise chain per tab. Replacement must be read-modify-write, and two
    // concurrent context-menu clicks in one tab must not interleave inside it.
    const tabLocks = new Map();

    function nextSequence() {
      sequenceCounter += 1;
      return sequenceCounter;
    }

    /** Serialize `task` against every other locked task for the same tab. */
    function withTabLock(tabId, task) {
      const previous = tabLocks.get(tabId) || Promise.resolve();
      const current = previous.then(task, task);
      // Keep the chain alive but never let a rejection poison the next waiter.
      tabLocks.set(
        tabId,
        current.then(
          () => undefined,
          () => undefined
        )
      );
      return current;
    }

    /**
     * Resolve this worker's generation, allocating it durably on first use.
     *
     * The counter lives in the same session storage as the pending records, so it
     * survives a service-worker restart and is cleared with them at end of session.
     * Cached per worker instance: every request from one generation shares a value.
     */
    function generation() {
      if (!generationPromise) {
        generationPromise = (async () => {
          if (options.generationId !== undefined) return Number(options.generationId);
          const key = config.SIDE_PANEL_GENERATION_KEY;
          try {
            const stored = await storageArea.get(key);
            const next = Number(stored?.[key] || 0) + 1;
            await storageArea.set({ [key]: next });
            return next;
          } catch {
            // Without a durable counter, fall back to wall clock so a fresh worker
            // still outranks records written by an earlier one.
            return now();
          }
        })();
      }
      return generationPromise;
    }

    /**
     * Order two records: newer generation wins outright, then the in-worker
     * sequence, then wall clock.
     *
     * Generation must dominate. A fresh user action after a restart starts its
     * sequence at 1 and would otherwise lose to a stale pending record that reached
     * sequence 5 in the previous generation — discarding the click the user just
     * made and translating stale text.
     */
    function isNewerThan(candidate, existing) {
      if (!existing) return true;
      const candidateGeneration = Number(candidate?.generationId || 0);
      const existingGeneration = Number(existing?.generationId || 0);
      if (candidateGeneration !== existingGeneration) {
        return candidateGeneration > existingGeneration;
      }
      const candidateSequence = Number(candidate?.sequence);
      const existingSequence = Number(existing?.sequence);
      if (Number.isFinite(candidateSequence) && Number.isFinite(existingSequence)) {
        if (candidateSequence !== existingSequence) return candidateSequence > existingSequence;
      }
      return Number(candidate?.createdAt || 0) >= Number(existing?.createdAt || 0);
    }

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
        sequence: Number.isFinite(value.sequence) ? value.sequence : nextSequence(),
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

    /**
     * Atomically make `pending` the one claimable request for its tab.
     *
     * Replacing used to be `store()` followed by an independent `supersede()` scan.
     * Two concurrent opens could interleave as store(A), store(B), A-removes-B,
     * B-removes-A and leave the tab with nothing at all. Everything now happens
     * inside one per-tab lock, and an older request that loses the race simply
     * declines to store rather than deleting the winner.
     *
     * @returns {Promise<{stored: boolean, pending: object, superseded: string[], winner: object}>}
     */
    async function replace(value) {
      const prepared = value?.sequence === undefined ? prepare(value) : value;
      const identity = normalizedIdentity(prepared);
      const key = keyFor(identity);
      return withTabLock(identity.tabId, async () => {
        // Stamped inside the lock: resolving the generation is asynchronous, and it
        // must not run on the user-gesture stack.
        const generationId =
          prepared.generationId === undefined ? await generation() : prepared.generationId;
        const pending = { ...prepared, generationId };
        await clearExpired();
        const stored = await storageArea.get(null);
        const siblings = Object.entries(stored || {}).filter(
          ([entryKey, record]) =>
            entryKey.startsWith(config.SIDE_PANEL_PENDING_PREFIX) &&
            record &&
            record.tabId === identity.tabId
        );
        const newest = siblings
          .map(([, record]) => record)
          .sort(
            (left, right) =>
              Number(right.sequence || 0) - Number(left.sequence || 0) ||
              Number(right.createdAt || 0) - Number(left.createdAt || 0)
          )[0];

        // A newer request already won this tab. Leave it completely alone.
        if (newest && newest.requestId !== identity.requestId && !isNewerThan(pending, newest)) {
          return { stored: false, pending, superseded: [], winner: newest };
        }

        const stale = siblings
          .map(([entryKey]) => entryKey)
          .filter((entryKey) => entryKey !== key);
        if (stale.length) await storageArea.remove(stale);
        await storageArea.set({ [key]: pending });
        return { stored: true, pending, superseded: stale, winner: pending };
      });
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
      generation,
      get,
      keyFor,
      peek,
      prepare,
      replace,
      set,
      store,
      supersede
    };
  }

  return { DEFAULT_TTL_MS, createSidePanelState };
});
