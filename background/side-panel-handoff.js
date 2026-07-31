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
    now = Date.now,
    intentTtlMs = config.SIDE_PANEL_HANDOFF_TIMEOUT_MS * 3
  }) {
    if (!state?.claim) throw new TypeError("Side-panel state with claim() is required.");

    const intents = new Map();
    const panels = new Set();

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
        createdAt: now()
      };
      for (const key of scopeKeys(intent)) intents.set(key, intent);
      return intent;
    }

    function abandon(pending) {
      for (const key of scopeKeys(pending)) {
        if (intents.get(key)?.requestId === pending.requestId) intents.delete(key);
      }
    }

    function intentFor(scope) {
      for (const key of scopeKeys(scope)) {
        const intent = intents.get(key);
        if (!intent) continue;
        if (now() - intent.createdAt > intentTtlMs) {
          intents.delete(key);
          continue;
        }
        return intent;
      }
      return null;
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

    async function resolveScope(port, message) {
      // Chrome populates sender.tab for tab-scoped panels on some versions; prefer it.
      const senderTab = port?.sender?.tab;
      if (Number.isInteger(senderTab?.id)) {
        return {
          tabId: senderTab.id,
          windowId: Number.isInteger(senderTab.windowId)
            ? senderTab.windowId
            : Number.isInteger(message?.windowId)
              ? message.windowId
              : null
        };
      }
      const windowId = Number.isInteger(message?.windowId) ? message.windowId : null;
      let tabId = null;
      if (windowId !== null && typeof resolveActiveTab === "function") {
        try {
          const resolved = await resolveActiveTab(windowId);
          if (Number.isInteger(resolved)) tabId = resolved;
        } catch {}
      }
      return { tabId, windowId };
    }

    async function handleClaim(entry, message) {
      const scope = await resolveScope(entry.port, message);
      entry.scope = scope;
      if (!Number.isInteger(scope.tabId) && !Number.isInteger(scope.windowId)) {
        post(entry, { type: config.SIDE_PANEL.IDLE, reason: "unresolved-scope" });
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
      connect,
      intentFor,
      panelCount: () => panels.size,
      publish
    };
  }

  return { createSidePanelHandoff };
});
