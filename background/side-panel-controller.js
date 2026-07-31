(function exposeSidePanelController(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          contracts: require("../shared/contracts.js"),
          language: require("../shared/language-utils.js")
        }
      : {
          contracts: root.SensemarkContracts,
          language: root.SensemarkLanguageUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSidePanelController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function createSidePanelController({
    sidePanel,
    state,
    detectLanguage,
    randomId = dependencies.contracts.cryptoRandomId
  }) {
    if (!state?.prepare || !state?.store || !state?.clear) {
      throw new TypeError("Side-panel state is required.");
    }

    async function languagePreflight(text) {
      if (!String(text || "").trim()) return { skipTranslation: false };
      return dependencies.language.detectLanguagePolicy(text, { detectLanguage });
    }

    function invokeOpen(tabId, value, text) {
      const pending = state.prepare({
        tabId,
        frameId: Number.isInteger(value.frameId) ? value.frameId : 0,
        requestId: value.requestId || randomId(),
        text,
        context: value.context || ""
      });
      const query = new URLSearchParams({
        tabId: String(pending.tabId),
        frameId: String(pending.frameId),
        requestId: pending.requestId
      });

      // Start every extension API call while the originating user gesture is still
      // on the stack. Awaiting storage or setOptions before open can consume Chrome's
      // transient user activation on protected pages and in the built-in PDF viewer.
      const storePromise = Promise.resolve(state.store(pending));
      const optionsPromise = Promise.resolve(
        sidePanel.setOptions({
          tabId,
          enabled: true,
          path: `sidepanel/sidepanel.html?${query}`
        })
      );
      let openPromise;
      try {
        openPromise = Promise.resolve(sidePanel.open({ tabId }));
      } catch (error) {
        openPromise = Promise.reject(error);
      }

      return Promise.all([storePromise, optionsPromise, openPromise])
        .then(() => ({ status: "opened", pending }))
        .catch(async (error) => {
          await Promise.allSettled([storePromise, optionsPromise, openPromise]);
          await state.clear(pending);
          return {
            status: "open-failed",
            error: String(error?.message || error || "Side panel failed to open.")
          };
        });
    }

    async function openAfterCyrillicPreflight(tabId, value, text) {
      const languagePolicy = await languagePreflight(text);
      if (languagePolicy.skipTranslation) return { status: "skipped-russian" };
      return invokeOpen(tabId, value, text);
    }

    function open(tabId, value = {}) {
      if (!Number.isInteger(tabId) || !sidePanel?.open || !sidePanel?.setOptions) {
        return Promise.resolve({ status: "unavailable" });
      }
      const text = String(value.text || "").trim();
      if (dependencies.language.detectScripts(text).includes("Cyrillic")) {
        return openAfterCyrillicPreflight(tabId, value, text);
      }
      return invokeOpen(tabId, value, text);
    }

    return { languagePreflight, open };
  }

  return { createSidePanelController };
});
