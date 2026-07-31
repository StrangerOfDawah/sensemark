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
    configurator,
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

      // `sidePanel.open()` is the ONLY extension API on the user-action path. Panel
      // configuration happens on tab lifecycle events, so setOptions() is never raced
      // against open() and can never turn a successful open into a reported failure.
      let openPromise;
      try {
        openPromise = Promise.resolve(sidePanel.open({ tabId }));
      } catch (error) {
        openPromise = Promise.reject(error);
      }

      // Atomic newest-wins replacement. Never store-then-supersede: two overlapping
      // requests in one tab used to delete each other and leave nothing claimable.
      const replacePromise = Promise.resolve(
        state.replace ? state.replace(pending) : state.store(pending).then((p) => ({ stored: true, pending: p }))
      ).then((outcome) => {
        // A newer request already owns this tab; publishing this one would hand the
        // panel stale text.
        if (outcome.stored !== false) handoff?.publish(outcome.pending || pending);
        return outcome;
      });

      // Best-effort repair for a tab that was never configured. Deliberately not part
      // of the result: its failure must not affect request delivery.
      let configurationError = null;
      const configurePromise = Promise.resolve(configurator?.configure?.(tabId))
        .then((result) => {
          if (result?.status === "configuration-failed") configurationError = result.error;
        })
        .catch((error) => {
          configurationError = String(error?.message || error || "setOptions failed");
        });

      return Promise.all([replacePromise, openPromise])
        .then(async ([outcome]) => {
          await configurePromise;
          return {
            status: outcome.stored === false ? "superseded" : "opened",
            pending,
            superseded: outcome.superseded || [],
            configurationError
          };
        })
        .catch(async (error) => {
          const [replaceResult] = await Promise.allSettled([replacePromise, openPromise]);
          await configurePromise;
          const openFailure = String(error?.message || error || "Side panel failed to open.");

          // If a panel for this scope is already connected it can still claim the
          // request, so a rejected open() must not destroy valid pending state.
          if (handoff?.hasPanelFor?.({ tabId, windowId: pending.windowId })) {
            return {
              status: "open-failed-panel-available",
              pending,
              error: openFailure,
              configurationError
            };
          }
          handoff?.abandon(pending);
          if (replaceResult.status !== "fulfilled" || replaceResult.value?.stored !== false) {
            await state.clear(pending);
          }
          return { status: "open-failed", error: openFailure, configurationError };
        });
    }

    function open(tabId, value = {}) {
      // Only open() is required now: configuration is a separate lifecycle concern.
      if (!Number.isInteger(tabId) || !sidePanel?.open) {
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
