(function exposeRequestCoordinator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkRequestCoordinator = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function createRequestCoordinator() {
    const active = new Map();

    function keyFor(scope = {}) {
      return [scope.surface || "unknown", scope.tabId ?? "extension", scope.frameId ?? 0].join(":");
    }

    function begin(scope = {}) {
      const key = keyFor(scope);
      active.get(key)?.abort("superseded");
      const controller = new AbortController();
      active.set(key, controller);
      return {
        signal: controller.signal,
        abort(reason = "cancelled") {
          controller.abort(reason);
        },
        finish() {
          if (active.get(key) === controller) active.delete(key);
        }
      };
    }

    function cancel(scope = {}) {
      const key = keyFor(scope);
      active.get(key)?.abort("cancelled");
      active.delete(key);
    }

    return { begin, cancel, keyFor };
  }

  return { createRequestCoordinator };
});
