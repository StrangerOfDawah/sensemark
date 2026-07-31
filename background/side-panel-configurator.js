(function exposeSidePanelConfigurator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSidePanelConfigurator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const SIDE_PANEL_PATH = "sidepanel/sidepanel.html";
  const TAB_TOKEN_PARAMETER = "tab";

  /**
   * Sensemark uses a **tab-specific** side panel. Every tab is configured with the
   * same document at `sidepanel/sidepanel.html`, carrying one stable query parameter:
   * the tab's own id.
   *
   * That token is tab identity, never request identity. It is assigned from tab
   * lifecycle events long before any context-menu click, so it is not part of the
   * user-action race and it never changes between requests for a given tab. It is
   * what lets two panel documents in one window tell themselves apart — the one
   * question `chrome.windows.getCurrent()` cannot answer.
   *
   * Identity degrades gracefully: a panel with no token still resolves through the
   * worker's open binding, so an unconfigured tab is a latency problem, not a
   * correctness problem.
   */
  const STATE = Object.freeze({
    UNKNOWN: "unknown",
    CONFIGURING: "configuring",
    CONFIGURED: "configured",
    FAILED: "failed"
  });

  function createSidePanelConfigurator({ sidePanel, tabs, path = SIDE_PANEL_PATH }) {
    const configured = new Map();
    const failures = new Map();
    // One in-flight configuration per tab: concurrent lifecycle events (onCreated
    // immediately followed by onActivated and onUpdated) must not fan out into
    // duplicate setOptions() calls.
    const inFlight = new Map();

    function pathForTab(tabId) {
      return `${path}?${TAB_TOKEN_PARAMETER}=${encodeURIComponent(String(tabId))}`;
    }

    async function applyConfiguration(tabId, wanted) {
      try {
        await sidePanel.setOptions({ tabId, enabled: true, path: wanted });
        configured.set(tabId, wanted);
        failures.delete(tabId);
        return { status: "configured", path: wanted };
      } catch (error) {
        // A tab Chrome refused stays UNCONFIGURED. It must never fall through to the
        // global default panel, so the request controller rejects it up front.
        const message = String(error?.message || error || "setOptions failed");
        configured.delete(tabId);
        failures.set(tabId, message);
        return { status: "configuration-failed", error: message };
      } finally {
        inFlight.delete(tabId);
      }
    }

    function configure(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) {
        return Promise.resolve({ status: "invalid-tab" });
      }
      if (!sidePanel?.setOptions) return Promise.resolve({ status: "unavailable" });
      const wanted = pathForTab(tabId);
      if (configured.get(tabId) === wanted) {
        return Promise.resolve({ status: "already-configured", path: wanted });
      }
      const pending = inFlight.get(tabId);
      if (pending) return pending;
      const task = applyConfiguration(tabId, wanted);
      inFlight.set(tabId, task);
      return task;
    }

    async function configureAll() {
      if (!tabs?.query) return { status: "unavailable", configured: 0 };
      let open = [];
      try {
        open = (await tabs.query({})) || [];
      } catch {
        return { status: "query-failed", configured: 0 };
      }
      const results = await Promise.all(
        open.filter((tab) => Number.isInteger(tab?.id)).map((tab) => configure(tab.id))
      );
      return {
        status: "done",
        configured: results.filter((item) =>
          ["configured", "already-configured"].includes(item.status)
        ).length
      };
    }

    function forget(tabId) {
      configured.delete(tabId);
      failures.delete(tabId);
      inFlight.delete(tabId);
    }

    function stateFor(tabId) {
      if (configured.has(tabId)) return STATE.CONFIGURED;
      if (inFlight.has(tabId)) return STATE.CONFIGURING;
      if (failures.has(tabId)) return STATE.FAILED;
      return STATE.UNKNOWN;
    }

    return {
      configure,
      configureAll,
      configuredPath: (tabId) => configured.get(tabId) || null,
      failureFor: (tabId) => failures.get(tabId) || null,
      forget,
      /**
       * True only after Chrome actually accepted setOptions() for this tab at the
       * current stable path. Read synchronously by the request controller BEFORE any
       * handoff state is created. Never optimistic: "configuring" is not "configured".
       */
      isConfigured: (tabId) => configured.get(tabId) === pathForTab(tabId),
      pathForTab,
      stateFor
    };
  }

  return { createSidePanelConfigurator, SIDE_PANEL_PATH, STATE, TAB_TOKEN_PARAMETER };
});
