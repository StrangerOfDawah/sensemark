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
    now = Date.now,
    intentTtlMs = config.SIDE_PANEL_HANDOFF_TIMEOUT_MS * 3,
    bindingTtlMs = 5 * 60 * 1000
  }) {
    if (!state?.claim) throw new TypeError("Side-panel state with claim() is required.");

    const intents = new Map();
    const panels = new Set();
    // window -> tab that a side panel was actually opened for. Recorded at open()
    // time and persisted, so it survives a worker restart and — unlike "whichever
    // tab is active right now" — cannot drift when the user switches tabs.
    const bindings = new Map();

    function bindingKey(windowId) {
      return `${config.SIDE_PANEL_BINDING_PREFIX}${windowId}`;
    }

    function rememberBinding(pending) {
      if (!Number.isInteger(pending?.windowId) || !Number.isInteger(pending?.tabId)) return;
      const binding = {
        windowId: pending.windowId,
        tabId: pending.tabId,
        requestId: pending.requestId,
        createdAt: now()
      };
      bindings.set(pending.windowId, binding);
      // Fire and forget: the in-memory copy already covers the same worker generation.
      Promise.resolve(bindingStore?.set?.({ [bindingKey(pending.windowId)]: binding })).catch(
        () => {}
      );
    }

    async function readBinding(windowId) {
      if (!Number.isInteger(windowId)) return null;
      const local = bindings.get(windowId);
      if (local && now() - local.createdAt <= bindingTtlMs) return local;
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
      Promise.resolve(bindingStore?.remove?.(bindingKey(windowId))).catch(() => {});
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
      rememberBinding(pending);
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
      const pending = await state.claim(scope);
      if (pending) {
        abandon(pending);
        post(entry, { type: config.SIDE_PANEL.REQUEST, pending });
        return;
      }
      const intent = intentFor(scope);
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
      bindingFor: readBinding,
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
