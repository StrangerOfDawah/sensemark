(function exposeSelectionRoute(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSelectionRoute = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const ROUTE = Object.freeze({
    // Known before any await: open the side panel straight from the gesture.
    DIRECT_SIDE_PANEL: "direct-side-panel",
    // Ordinary injectable page: try the content script first.
    CONTENT_SCRIPT: "content-script"
  });

  // Contexts where a content script provably cannot run. Detected from the tab URL
  // alone, so the decision is synchronous and `sidePanel.open()` stays on the
  // user-gesture stack.
  const RESTRICTED_SCHEME = /^(?:chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|chrome-untrusted|resource):/i;
  const PDF_URL = /\.pdf(?:$|[?#])/i;
  const WEB_STORE = /^https?:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)/i;

  function restrictedReason(url) {
    const value = String(url || "");
    if (!value) return "unknown-url";
    if (RESTRICTED_SCHEME.test(value)) return "restricted-scheme";
    if (PDF_URL.test(value)) return "pdf-viewer";
    if (WEB_STORE.test(value)) return "web-store";
    return null;
  }

  /**
   * Decide, synchronously, how a context-menu selection should be handled.
   *
   * Chrome only honours `sidePanel.open()` while the user gesture is still live. An
   * awaited `tabs.sendMessage()` round trip may outlive it, so the two cases are kept
   * apart: contexts we can recognise up front open the panel immediately, and
   * ordinary pages go through the content script and are NOT silently retried through
   * the panel afterwards.
   */
  function routeForSelection({ url } = {}) {
    const reason = restrictedReason(url);
    if (reason) return { route: ROUTE.DIRECT_SIDE_PANEL, reason };
    return { route: ROUTE.CONTENT_SCRIPT, reason: null };
  }

  return { ROUTE, restrictedReason, routeForSelection };
});
