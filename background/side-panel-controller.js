(function exposeSidePanelController(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          contracts: require("../shared/contracts.js"),
          errors: require("../shared/errors.js"),
          language: require("../shared/language-utils.js")
        }
      : {
          contracts: root.SensemarkContracts,
          errors: root.SensemarkErrors,
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
    // Read-only view of the tab-lifecycle configurator. The controller NEVER calls
    // setOptions(): configuring a tab-specific panel while open() is already in
    // flight can leave Chrome showing a different instance than the one the identity
    // protocol expects. It only asks whether the tab was prepared, to classify a
    // failure correctly.
    isTabConfigured,
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
      const intent = handoff?.announce(pending);

      // `sidePanel.open()` is the ONLY extension API on the user-action path.
      let openPromise;
      try {
        openPromise = Promise.resolve(sidePanel.open({ tabId }));
      } catch (error) {
        openPromise = Promise.reject(error);
      }

      // Atomic newest-wins replacement, ordered across worker generations. Never
      // store-then-supersede: two overlapping requests in one tab used to delete each
      // other and leave nothing claimable.
      const replacePromise = Promise.resolve(
        state.replace
          ? state.replace(pending)
          : state.store(pending).then((stored) => ({ stored: true, pending: stored }))
      ).then((outcome) => {
        // A newer request already owns this tab; publishing this one would hand the
        // panel stale text.
        if (outcome.stored !== false) handoff?.publish(outcome.pending || pending);
        return outcome;
      });

      // The durable window->tab binding write is part of the handoff lifecycle, not a
      // fire-and-forget side effect: the handoff is not "prepared" while it is still
      // outstanding, and a failure must surface rather than vanish.
      const bindingPromise = Promise.resolve(
        intent?.persisted || handoff?.bindingPersistence?.(pending.windowId)
      ).catch((error) => ({
        status: "failed",
        error: String(error?.message || error || "binding persistence failed")
      }));

      return Promise.all([replacePromise, openPromise])
        .then(async ([outcome]) => {
          const binding = await bindingPromise;
          return {
            status: outcome.stored === false ? "superseded" : "opened",
            pending,
            superseded: outcome.superseded || [],
            bindingStatus: binding?.status || "idle",
            bindingError: binding?.status === "failed" ? binding.error : null
          };
        })
        .catch(async (error) => {
          const [replaceResult] = await Promise.allSettled([replacePromise, openPromise]);
          const binding = await bindingPromise;
          const message = String(error?.message || error || "Side panel failed to open.");

          // If a panel for this scope is already connected it can still claim the
          // request, so a rejected open() must not destroy valid pending state.
          if (handoff?.hasPanelFor?.({ tabId, windowId: pending.windowId })) {
            return {
              status: "open-failed-panel-available",
              code: dependencies.errors.ERROR_CODE.PANEL_OPEN_FAILED,
              pending,
              error: message,
              bindingStatus: binding?.status || "idle"
            };
          }

          // A tab that lifecycle preparation never reached cannot show a tab-specific
          // panel. That is a configuration problem, not an opening problem.
          const configured = isTabConfigured ? Boolean(isTabConfigured(tabId)) : true;
          handoff?.abandon(pending);
          if (replaceResult.status !== "fulfilled" || replaceResult.value?.stored !== false) {
            await state.clear(pending);
          }
          return {
            status: configured ? "open-failed" : "not-configured",
            code: configured
              ? dependencies.errors.ERROR_CODE.PANEL_OPEN_FAILED
              : dependencies.errors.ERROR_CODE.PANEL_NOT_CONFIGURED,
            error: message,
            bindingStatus: binding?.status || "idle"
          };
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
