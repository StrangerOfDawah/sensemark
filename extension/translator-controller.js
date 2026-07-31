(function exposeTranslatorController(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          plan: require("./request-plan.js"),
          translationClient: require("../content/translation-client.js")
        }
      : {
          plan: root.SensemarkRequestPlan,
          translationClient: root.SensemarkTranslationClient
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTranslatorController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function createTranslatorController({ getText, surface, view, runtime = chrome.runtime }) {
    const client = dependencies.translationClient.createTranslationClient(runtime);
    let lastText = "";

    function translate(value = getText()) {
      lastText = String(value || "");
      const plan = dependencies.plan.createRequestPlan(lastText, surface);
      if (plan.error) {
        view.failed({ message: plan.error, code: "invalid-request" }, () => translate(lastText));
        return false;
      }
      view.start();
      client.translate(plan.request, {
        onDelta: view.delta,
        onCompleted: view.completed,
        onSkipped: view.skipped,
        onFailed: (error) => view.failed(error, () => translate(lastText))
      });
      return true;
    }

    return { cancel: client.cancel, translate };
  }

  return { createTranslatorController };
});
