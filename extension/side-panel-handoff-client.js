(function exposeSidePanelHandoffClient(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSidePanelHandoffClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  /**
   * Side-panel half of the handoff.
   *
   * The panel cannot read its own tab id, and it deliberately no longer reads a
   * request identity from its URL. It reports the window it lives in — the boundary
   * Chrome itself uses for side panels — and claims by scope.
   *
   * Retries are bounded by a claim window. Outside that window the port stays
   * connected but silent, so a selection made while the panel is already open is
   * still pushed to it without any polling.
   */
  function createSidePanelHandoffClient({
    runtime = globalThis.chrome?.runtime,
    windows = globalThis.chrome?.windows,
    // Stable per-tab token assigned by the configurator on tab lifecycle events.
    // This is tab identity, never request identity, and it never changes between
    // requests for a tab.
    //
    // A valid stable tab token is REQUIRED for side-panel request delivery. An
    // untokenized global or legacy panel is rejected by the worker and cannot claim
    // a tab-scoped request; it receives PANEL_NOT_CONFIGURED instead.
    tabToken = null,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
    timeoutMs = config.SIDE_PANEL_HANDOFF_TIMEOUT_MS,
    retryMs = config.SIDE_PANEL_CLAIM_RETRY_MS,
    onRequest,
    onTimeout,
    onIdle,
    onUnsupported
  } = {}) {
    let port = null;
    let windowId = null;
    // Guard the coercion explicitly: Number(null) and Number("") are both 0, which
    // would make every untokenised panel claim to be tab 0.
    const resolvedTabId = () => {
      if (tabToken === null || tabToken === undefined || tabToken === "") return null;
      const value = Number(tabToken);
      return Number.isInteger(value) && value >= 0 ? value : null;
    };
    let stopped = false;
    let claimWindow = null;
    let lastOutcome = "starting";
    // Delivery is deduplicated by request id, not by panel lifetime: a selection made
    // while the panel is already open must still be accepted.
    const delivered = new Set();

    function clearClaimWindow() {
      if (!claimWindow) return;
      timers.clearTimeout(claimWindow.retryTimer);
      timers.clearTimeout(claimWindow.deadlineTimer);
      claimWindow = null;
    }

    function finish(outcome) {
      lastOutcome = outcome;
      clearClaimWindow();
    }

    function send(message) {
      try {
        port?.postMessage(message);
        return true;
      } catch {
        return false;
      }
    }

    function claimNow() {
      send({ type: config.SIDE_PANEL.CLAIM, windowId, tabId: resolvedTabId() });
    }

    function scheduleRetry() {
      if (!claimWindow) return;
      claimWindow.retryTimer = timers.setTimeout(() => {
        if (!claimWindow || stopped) return;
        claimNow();
        scheduleRetry();
      }, retryMs);
    }

    /** Begin a bounded window of claim attempts. Never unbounded. */
    function openClaimWindow({ expecting = false } = {}) {
      clearClaimWindow();
      claimWindow = {
        startedAt: now(),
        expecting,
        retryTimer: null,
        deadlineTimer: null
      };
      claimWindow.deadlineTimer = timers.setTimeout(() => {
        const wasExpecting = Boolean(claimWindow?.expecting);
        finish(wasExpecting ? "timeout" : "idle");
        if (wasExpecting) onTimeout?.();
        else onIdle?.();
      }, timeoutMs);
      scheduleRetry();
    }

    function handleMessage(message) {
      if (stopped) return;
      switch (message?.type) {
        case config.SIDE_PANEL.REQUEST: {
          const pending = message.pending;
          if (!pending?.text) return;
          if (delivered.has(pending.requestId)) return;
          delivered.add(pending.requestId);
          finish("delivered");
          onRequest?.(pending);
          return;
        }
        case config.SIDE_PANEL.AVAILABLE:
          // Storage landed after we were already listening: claim straight away, and
          // reopen the bounded window so a lost race still ends in a visible state.
          if (!claimWindow) openClaimWindow({ expecting: true });
          else claimWindow.expecting = true;
          claimNow();
          return;
        case config.SIDE_PANEL.WAITING:
          if (claimWindow) claimWindow.expecting = true;
          return;
        case config.SIDE_PANEL.UNSUPPORTED:
          // This panel document has no tab token, so it can never be bound to a tab.
          // Stop retrying and tell the user, rather than sitting empty forever.
          finish("unsupported");
          onUnsupported?.(message);
          return;
        case config.SIDE_PANEL.IDLE:
          // A reason means the worker could not answer properly; keep retrying inside
          // the existing window. A bare IDLE means the user opened the panel manually.
          if (message.reason) return;
          // Only meaningful while a claim window is open and nothing was announced.
          if (!claimWindow || claimWindow.expecting) return;
          finish("idle");
          onIdle?.();
          return;
        default:
      }
    }

    function connect() {
      if (stopped) return;
      port = runtime.connect({ name: config.PORTS.SIDE_PANEL });
      port.onMessage.addListener(handleMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        // The worker idles out while the panel stays open. Reconnecting keeps the
        // panel reachable for a selection made later, without any polling.
        if (!stopped) timers.setTimeout(() => reconnect(), 0);
      });
      send({ type: config.SIDE_PANEL.READY, windowId, tabId: resolvedTabId() });
    }

    function reconnect() {
      if (stopped || port) return;
      connect();
      if (claimWindow) claimNow();
    }

    async function start() {
      try {
        const current = await windows?.getCurrent?.();
        if (Number.isInteger(current?.id)) windowId = current.id;
      } catch {}
      if (stopped) return;
      connect();
      openClaimWindow();
    }

    function stop() {
      stopped = true;
      clearClaimWindow();
      try {
        port?.disconnect();
      } catch {}
      port = null;
    }

    return {
      claimNow,
      openClaimWindow,
      outcome: () => lastOutcome,
      start,
      stop,
      tabId: resolvedTabId,
      windowId: () => windowId
    };
  }

  return { createSidePanelHandoffClient };
});
