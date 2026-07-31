(function exposeSidePanelHandoff(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSidePanelHandoff = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  /**
   * Service-worker half of the side-panel handoff.
   *
   * The panel never learns its request from its URL. It announces readiness on a
   * long-lived port, and this registry answers with one of three states:
   *
   *   REQUEST  the pending request, claimed exactly once;
   *   WAITING  a handoff was announced for this scope but storage has not landed yet;
   *   IDLE     nothing is expected — the user opened the panel themselves.
   *
   * `announce()` runs synchronously on the user-gesture stack, before any await, so
   * WAITING is already knowable no matter how the storage write races the panel load.
   */
  function createSidePanelHandoff({
    state,
    resolveActiveTab,
    bindingStore,
    generation,
    now = Date.now,
    intentTtlMs = config.SIDE_PANEL_HANDOFF_TIMEOUT_MS * 3,
    bindingTtlMs = 5 * 60 * 1000
  }) {
    if (!state?.claim) throw new TypeError("Side-panel state with claim() is required.");
    const resolveGeneration = generation || state.generation;

    const intents = new Map();
    const panels = new Set();
    // window -> tab that a side panel was actually opened for. Recorded at open()
    // time and persisted, so it survives a worker restart and — unlike "whichever
    // tab is active right now" — cannot drift when the user switches tabs.
    const bindings = new Map();
    const bindingLocks = new Map();
    const bindingWrites = new Map();
    const failedBindings = new Map();
    let bindingRevisionCounter = 0;

    function bindingKey(windowId) {
      return `${config.SIDE_PANEL_BINDING_PREFIX}${windowId}`;
    }

    /** Serialize binding updates per window; different windows never block. */
    function withWindowLock(windowId, task) {
      const previous = bindingLocks.get(windowId) || Promise.resolve();
      const current = previous.then(task, task);
      bindingLocks.set(
        windowId,
        current.then(
          () => undefined,
          () => undefined
        )
      );
      return current;
    }

    /** Newer generation wins outright, then the in-worker revision, then wall clock. */
    function isNewerBinding(candidate, existing) {
      if (!existing) return true;
      const candidateGeneration = Number(candidate?.generationId || 0);
      const existingGeneration = Number(existing?.generationId || 0);
      if (candidateGeneration !== existingGeneration) {
        return candidateGeneration > existingGeneration;
      }
      const candidateRevision = Number(candidate?.bindingRevision || 0);
      const existingRevision = Number(existing?.bindingRevision || 0);
      if (candidateRevision !== existingRevision) return candidateRevision > existingRevision;
      return Number(candidate?.createdAt || 0) >= Number(existing?.createdAt || 0);
    }

    /**
     * Record the window -> tab binding for this request.
     *
     * Synchronous in memory (announce runs on the user-gesture stack), durable
     * asynchronously. The write is serialized per window and refuses to overwrite a
     * newer binding: two fire-and-forget writes used to be able to land out of order,
     * leaving the persisted binding pointing at the OLDER tab and making a restarted
     * worker recover the wrong identity.
     *
     * The returned promise is retained by the caller and joined into the post-open
     * lifecycle, so the handoff is never reported as prepared while the durable write
     * is still outstanding or has failed.
     */
    function rememberBinding(pending) {
      if (!Number.isInteger(pending?.windowId) || !Number.isInteger(pending?.tabId)) {
        return { binding: null, persisted: Promise.resolve({ status: "skipped" }) };
      }
      const windowId = pending.windowId;
      bindingRevisionCounter += 1;
      const binding = {
        windowId,
        tabId: pending.tabId,
        requestId: pending.requestId,
        bindingRevision: bindingRevisionCounter,
        generationId: pending.generationId,
        createdAt: now()
      };
      if (isNewerBinding(binding, bindings.get(windowId))) bindings.set(windowId, binding);

      const persisted = withWindowLock(windowId, async () => {
        if (!bindingStore?.set) return { status: "unavailable", binding };
        try {
          const generationId =
            binding.generationId === undefined && typeof resolveGeneration === "function"
              ? await resolveGeneration()
              : binding.generationId;
          const durable = { ...binding, generationId };
          if (isNewerBinding(durable, bindings.get(windowId))) bindings.set(windowId, durable);
          const key = bindingKey(windowId);
          const stored = await bindingStore.get(key);
          if (!isNewerBinding(durable, stored?.[key] || null)) {
            return { status: "superseded", binding: durable };
          }
          await bindingStore.set({ [key]: durable });
          return { status: "persisted", binding: durable };
        } catch (error) {
          // A failed write must not become an unhandled rejection, and the stale
          // stored binding must not be trusted as current.
          const message = String(error?.message || error || "binding persistence failed");
          failedBindings.set(windowId, message);
          return { status: "failed", error: message, binding };
        }
      });
      bindingWrites.set(windowId, persisted);
      return { binding, persisted };
    }

    /** The outstanding durable binding write for a window, if any. */
    function bindingPersistence(windowId) {
      return bindingWrites.get(windowId) || Promise.resolve({ status: "idle" });
    }

    async function readBinding(windowId) {
      if (!Number.isInteger(windowId)) return null;
      const local = bindings.get(windowId);
      if (local && now() - local.createdAt <= bindingTtlMs) return local;
      // A window whose durable write failed has no trustworthy stored binding: the
      // record on disk is from before that failure.
      if (failedBindings.has(windowId)) return null;
      if (!bindingStore?.get) return null;
      try {
        const key = bindingKey(windowId);
        const stored = await bindingStore.get(key);
        const binding = stored?.[key] || null;
        if (!binding) return null;
        if (now() - Number(binding.createdAt || 0) > bindingTtlMs) {
          await bindingStore.remove?.(key);
          return null;
        }
        bindings.set(windowId, binding);
        return binding;
      } catch {
        return null;
      }
    }

    function forgetBinding(windowId) {
      if (!Number.isInteger(windowId)) return;
      bindings.delete(windowId);
      failedBindings.delete(windowId);
      bindingWrites.delete(windowId);
      withWindowLock(windowId, async () => {
        try {
          await bindingStore?.remove?.(bindingKey(windowId));
        } catch {}
      });
    }

    function forgetTab(tabId) {
      for (const [windowId, binding] of [...bindings]) {
        if (binding.tabId === tabId) forgetBinding(windowId);
      }
      for (const [key, intent] of [...intents]) {
        if (intent.tabId === tabId) intents.delete(key);
      }
    }

    function scopeKeys(scope = {}) {
      const keys = [];
      if (Number.isInteger(scope.windowId)) keys.push(`window:${scope.windowId}`);
      if (Number.isInteger(scope.tabId)) keys.push(`tab:${scope.tabId}`);
      return keys;
    }

    function announce(pending) {
      const intent = {
        tabId: pending.tabId,
        frameId: pending.frameId,
        windowId: Number.isInteger(pending.windowId) ? pending.windowId : null,
        requestId: pending.requestId,
        sequence: pending.sequence,
        createdAt: now()
      };
      for (const key of scopeKeys(intent)) intents.set(key, intent);
      const { persisted } = rememberBinding(pending);
      // The caller joins this into the post-open lifecycle so the durable write is
      // never abandoned, but it is deliberately not awaited here: announce() runs on
      // the user-gesture stack ahead of sidePanel.open().
      intent.persisted = persisted;
      return intent;
    }

    function abandon(pending) {
      for (const key of scopeKeys(pending)) {
        if (intents.get(key)?.requestId === pending.requestId) intents.delete(key);
      }
    }

    function intentFor(scope) {
      // A known tab is authoritative. Falling back to the window key here would let a
      // panel for tab A wait on an intent announced for tab B in the same window.
      const keys = Number.isInteger(scope?.tabId)
        ? [`tab:${scope.tabId}`]
        : scopeKeys(scope);
      for (const key of keys) {
        const intent = intents.get(key);
        if (!intent) continue;
        if (now() - intent.createdAt > intentTtlMs) {
          intents.delete(key);
          continue;
        }
        // A window-keyed intent must not be handed to a panel from another tab.
        if (Number.isInteger(scope?.tabId) && intent.tabId !== scope.tabId) continue;
        return intent;
      }
      return null;
    }

    /** Is a panel that could still claim this scope already connected? */
    function hasPanelFor(scope) {
      for (const entry of panels) {
        if (Number.isInteger(scope?.tabId) && entry.scope?.tabId === scope.tabId) return true;
        if (
          !Number.isInteger(scope?.tabId) &&
          Number.isInteger(scope?.windowId) &&
          entry.scope?.windowId === scope.windowId
        ) {
          return true;
        }
      }
      return false;
    }

    function post(entry, message) {
      try {
        entry.port.postMessage(message);
        return true;
      } catch {
        panels.delete(entry);
        return false;
      }
    }

    function scopeMatchesPending(scope, pending) {
      if (Number.isInteger(scope?.tabId) && Number.isInteger(pending?.tabId)) {
        return scope.tabId === pending.tabId;
      }
      if (Number.isInteger(scope?.windowId) && Number.isInteger(pending?.windowId)) {
        return scope.windowId === pending.windowId;
      }
      return false;
    }

    /**
     * Tell already-listening panels that storage has landed. Panels also retry on
     * their own, so a missed notification only costs latency, never the request.
     */
    function publish(pending) {
      for (const entry of [...panels]) {
        if (!scopeMatchesPending(entry.scope, pending)) continue;
        post(entry, {
          type: config.SIDE_PANEL.AVAILABLE,
          requestId: pending.requestId
        });
      }
    }

    /**
     * Resolve which tab a connected panel speaks for.
     *
     * Deterministic sources first, heuristics last. "Whichever tab is active right
     * now" is never trusted on its own: the user can switch tabs between open() and
     * READY, and two panel documents can briefly coexist in one window.
     *
     *   1. `port.sender.tab` — used when Chrome supplies it, never assumed to exist.
     *   2. the stable per-tab token the configurator put in the panel URL.
     *   3. the worker's open binding for that window (persisted, restart-safe).
     *   4. the active tab — only when it actually has a pending record, otherwise
     *      the panel is told it is idle rather than handed someone else's text.
     */
    async function resolveScope(port, message) {
      const windowId = Number.isInteger(message?.windowId) ? message.windowId : null;

      const senderTab = port?.sender?.tab;
      if (Number.isInteger(senderTab?.id)) {
        return {
          tabId: senderTab.id,
          windowId: Number.isInteger(senderTab.windowId) ? senderTab.windowId : windowId,
          source: "sender-tab"
        };
      }

      if (Number.isInteger(message?.tabId)) {
        return { tabId: message.tabId, windowId, source: "tab-token" };
      }

      const binding = await readBinding(windowId);
      if (binding && Number.isInteger(binding.tabId)) {
        return { tabId: binding.tabId, windowId, source: "open-binding" };
      }

      if (windowId !== null && typeof resolveActiveTab === "function") {
        try {
          const active = await resolveActiveTab(windowId);
          if (Number.isInteger(active)) {
            // Only accept the active tab when it genuinely owns a pending request.
            const candidate = state.peek ? await state.peek({ tabId: active }) : null;
            if (candidate) return { tabId: active, windowId, source: "active-tab" };
          }
        } catch {}
      }

      return { tabId: null, windowId, source: "unresolved" };
    }

    async function handleClaim(entry, message) {
      const scope = await resolveScope(entry.port, message);
      entry.scope = scope;
      // A tab must be positively identified before anything is handed over. Claiming
      // by window alone would let a panel whose tab could not be resolved take another
      // tab's text — the misroute this ladder exists to prevent. Refusing costs a
      // visible timeout at worst; guessing corrupts the result.
      if (!Number.isInteger(scope.tabId)) {
        post(entry, { type: config.SIDE_PANEL.IDLE, reason: "unresolved-tab" });
        return;
      }
      const intent = intentFor(scope);

      // A live intent means a newer request for this tab has been announced but its
      // write may not have landed yet. Anything currently on disk for that tab is
      // therefore stale — typically a record left behind by a previous worker
      // generation — and must not be handed over. Wait for the real one instead.
      if (intent && state.peek) {
        const stored = await state.peek({ tabId: scope.tabId });
        if (stored && stored.requestId !== intent.requestId) {
          post(entry, { type: config.SIDE_PANEL.WAITING, requestId: intent.requestId });
          return;
        }
      }

      const pending = await state.claim(scope);
      if (pending) {
        abandon(pending);
        post(entry, { type: config.SIDE_PANEL.REQUEST, pending });
        return;
      }
      if (intent) {
        post(entry, { type: config.SIDE_PANEL.WAITING, requestId: intent.requestId });
        return;
      }
      post(entry, { type: config.SIDE_PANEL.IDLE });
    }

    function connect(port) {
      if (port?.name !== config.PORTS.SIDE_PANEL) return false;
      const entry = { port, scope: { tabId: null, windowId: null } };
      panels.add(entry);
      port.onDisconnect.addListener(() => panels.delete(entry));
      port.onMessage.addListener((message) => {
        if (
          message?.type !== config.SIDE_PANEL.READY &&
          message?.type !== config.SIDE_PANEL.CLAIM
        ) {
          return;
        }
        handleClaim(entry, message).catch(() => {
          post(entry, { type: config.SIDE_PANEL.IDLE, reason: "claim-failed" });
        });
      });
      return true;
    }

    return {
      abandon,
      announce,
      bindingFailure: (windowId) => failedBindings.get(windowId) || null,
      bindingFor: readBinding,
      bindingPersistence,
      connect,
      forgetBinding,
      forgetTab,
      hasPanelFor,
      intentFor,
      panelCount: () => panels.size,
      publish,
      resolveScope
    };
  }

  return { createSidePanelHandoff };
});
