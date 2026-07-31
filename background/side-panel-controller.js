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
  // A single stable path for every request. Request identity is never carried in the
  // URL, so it does not matter whether setOptions() or open() settles first.
  const SIDE_PANEL_PATH = "sidepanel/sidepanel.html";

  function createSidePanelController({
    sidePanel,
    state,
    handoff,
    detectLanguage,
    randomId = dependencies.contracts.cryptoRandomId
  }) {
    if (!state?.prepare || !state?.store || !state?.clear) {
      throw new TypeError("Side-panel state is required.");
    }

    // Full asynchronous language policy. Deliberately NOT used before open(): it is
    // the same policy the translation service applies once the panel is already up.
    async function languagePreflight(text) {
      if (!String(text || "").trim()) return { skipTranslation: false };
      return dependencies.language.detectLanguagePolicy(text, { detectLanguage });
    }

    function invokeOpen(tabId, value, text) {
      const pending = state.prepare({
        tabId,
        frameId: Number.isInteger(value.frameId) ? value.frameId : 0,
        windowId: Number.isInteger(value.windowId) ? value.windowId : null,
        requestId: value.requestId || randomId(),
        text,
        context: value.context || ""
      });

      // Synchronous, before anything can await. A panel that becomes ready before the
      // storage write lands still learns that a handoff is on the way, so it waits and
      // retries instead of reporting an empty panel.
      handoff?.announce(pending);

      // Start every extension API call while the originating user gesture is still
      // on the stack. Awaiting anything before open can consume Chrome's transient
      // user activation on protected pages and in the built-in PDF viewer.
      const optionsPromise = Promise.resolve(
        sidePanel.setOptions({ tabId, enabled: true, path: SIDE_PANEL_PATH })
      );
      let openPromise;
      try {
        openPromise = Promise.resolve(sidePanel.open({ tabId }));
      } catch (error) {
        openPromise = Promise.reject(error);
      }
      const storePromise = Promise.resolve(state.store(pending)).then(async (stored) => {
        // Newest-wins: drop this tab's older unclaimed requests before advertising.
        if (state.supersede) await state.supersede(stored);
        handoff?.publish(stored);
        return stored;
      });

      return Promise.all([storePromise, optionsPromise, openPromise])
        .then(() => ({ status: "opened", pending }))
        .catch(async (error) => {
          await Promise.allSettled([storePromise, optionsPromise, openPromise]);
          handoff?.abandon(pending);
          await state.clear(pending);
          return {
            status: "open-failed",
            error: String(error?.message || error || "Side panel failed to open.")
          };
        });
    }

    function open(tabId, value = {}) {
      if (!Number.isInteger(tabId) || !sidePanel?.open || !sidePanel?.setOptions) {
        return Promise.resolve({ status: "unavailable" });
      }
      const text = String(value.text || "").trim();
      // Synchronous verdict only. Awaiting chrome.i18n.detectLanguage here would drop
      // Chrome's transient user activation and sidePanel.open() would be rejected for
      // Ukrainian, Bulgarian, Serbian and Kazakh selections. Anything short of a
      // confident Russian verdict opens the panel; the translation service still
      // applies the full asynchronous policy and reports "already Russian" there.
      if (dependencies.language.synchronousRussianVerdict(text) === "russian") {
        return Promise.resolve({ status: "skipped-russian" });
      }
      return invokeOpen(tabId, value, text);
    }

    return { languagePreflight, open, SIDE_PANEL_PATH };
  }

  return { createSidePanelController };
});
