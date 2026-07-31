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
  function createSidePanelConfigurator({ sidePanel, tabs, path = SIDE_PANEL_PATH }) {
    const configured = new Map();
    const failures = new Map();

    function pathForTab(tabId) {
      return `${path}?${TAB_TOKEN_PARAMETER}=${encodeURIComponent(String(tabId))}`;
    }

    async function configure(tabId) {
      if (!Number.isInteger(tabId) || tabId < 0) return { status: "invalid-tab" };
      if (!sidePanel?.setOptions) return { status: "unavailable" };
      const wanted = pathForTab(tabId);
      if (configured.get(tabId) === wanted) return { status: "already-configured" };
      try {
        await sidePanel.setOptions({ tabId, enabled: true, path: wanted });
        configured.set(tabId, wanted);
        failures.delete(tabId);
        return { status: "configured", path: wanted };
      } catch (error) {
        // A tab that cannot be configured still works through the open binding.
        const message = String(error?.message || error || "setOptions failed");
        failures.set(tabId, message);
        return { status: "configuration-failed", error: message };
      }
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
        configured: results.filter((item) => item.status === "configured").length
      };
    }

    function forget(tabId) {
      configured.delete(tabId);
      failures.delete(tabId);
    }

    return {
      configure,
      configureAll,
      configuredPath: (tabId) => configured.get(tabId) || null,
      failureFor: (tabId) => failures.get(tabId) || null,
      forget,
      pathForTab
    };
  }

  return { createSidePanelConfigurator, SIDE_PANEL_PATH, TAB_TOKEN_PARAMETER };
});
