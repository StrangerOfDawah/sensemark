(function exposeTranslationClient(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTranslationClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  function createTranslationClient(runtime = chrome.runtime) {
    let active = null;

    function cancel() {
      if (!active) return;
      active.port.postMessage({ type: "translation.cancel", requestId: active.requestId });
      active.port.disconnect();
      active = null;
    }

    function translate(request, handlers = {}) {
      cancel();
      const port = runtime.connect({ name: config.PORTS.TRANSLATION });
      const current = { port, requestId: request.requestId };
      active = current;

      port.onMessage.addListener((message) => {
        if (message.requestId !== current.requestId || active !== current) return;
        if (message.type === "translation.started") handlers.onStarted?.();
        if (message.type === "translation.delta") handlers.onDelta?.(message.delta);
        if (message.type === "translation.completed") {
          if (message.status === "skipped-russian") {
            handlers.onSkipped?.({ reason: "already-russian" });
          } else {
            handlers.onCompleted?.(message.result, { cached: message.cached });
          }
          port.disconnect();
          if (active === current) active = null;
        }
        if (message.type === "translation.failed") {
          handlers.onFailed?.(message.error);
          port.disconnect();
          if (active === current) active = null;
        }
      });
      port.onDisconnect.addListener(() => {
        if (active === current) active = null;
      });
      port.postMessage({ type: "translation.start", request });
      return { cancel };
    }

    return { cancel, translate };
  }

  return { createTranslationClient };
});
