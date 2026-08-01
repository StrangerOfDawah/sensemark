(function exposeSelectionController(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("../../shared/config.js"),
          context: require("./context-extractor.js"),
          contracts: require("../../shared/contracts.js"),
          intent: require("./selection-intent.js"),
          language: require("../../shared/language-utils.js"),
          mode: require("../../shared/mode-utils.js"),
          reader: require("./selection-reader.js"),
          text: require("../../shared/text-utils.js")
        }
      : {
          config: root.SensemarkConfig,
          context: root.SensemarkContextExtractor,
          contracts: root.SensemarkContracts,
          intent: root.SensemarkSelectionIntent,
          language: root.SensemarkLanguageUtils,
          mode: root.SensemarkModeUtils,
          reader: root.SensemarkSelectionReader,
          text: root.SensemarkTextUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSelectionController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  function selectionKeyFor({ text, sourceType, anchorRect, frameIdentity }) {
    return JSON.stringify({
      text: String(text || ""),
      sourceType: String(sourceType || "unknown"),
      frameIdentity: String(frameIdentity || ""),
      left: Math.round(Number(anchorRect?.left) || 0),
      top: Math.round(Number(anchorRect?.top) || 0),
      width: Math.round(Number(anchorRect?.width) || 0),
      height: Math.round(Number(anchorRect?.height) || 0)
    });
  }

  function createSelectionDeduper({
    cooldownMs = dependencies.config.SELECTION_COOLDOWN_MS,
    now = Date.now
  } = {}) {
    let lastKey = "";
    let lastAcceptedAt = 0;
    return {
      isDuplicate(key) {
        return Boolean(key && key === lastKey && now() - lastAcceptedAt < cooldownMs);
      },
      record(key) {
        lastKey = String(key || "");
        lastAcceptedAt = now();
      }
    };
  }

  function createSelectionController({
    documentObject = document,
    runtime = chrome.runtime,
    settingsClient,
    translationClient,
    card,
    frameIdentity = (() => {
      try {
        return `${documentObject.location?.origin || ""}${documentObject.location?.pathname || ""}:${
          globalThis.top === globalThis ? "top" : "frame"
        }`;
      } catch {
        return "isolated-frame";
      }
    })(),
    languageDetector = dependencies.language.createChromeLanguageDetector(
      globalThis.chrome?.i18n
    )
  }) {
    let settings = null;
    let lastTarget = documentObject.activeElement;
    let lastPointerEvent = {};
    let currentPlan = null;
    let pendingPlan = null;
    let selectionRevision = 0;
    const deduper = createSelectionDeduper();

    function openShadowRoots(target) {
      const root = target?.getRootNode?.();
      return root && root !== documentObject && root.mode === "open" ? [root] : [];
    }

    function read(explicitText = "") {
      const selection = dependencies.reader.readSelection({
        documentObject,
        target: lastTarget || documentObject.activeElement,
        shadowRoots: openShadowRoots(lastTarget)
      });
      if (
        selection?.status === "unsupported" &&
        (selection.reason === "password-field" || !explicitText)
      ) {
        return { status: "unsupported", reason: selection.reason };
      }
      const selectedText = dependencies.text.normalizeText(explicitText || selection?.text);
      if (!selectedText || !dependencies.text.hasLetters(selectedText)) return null;
      const context = dependencies.context.extractContext({
        range: selection?.range,
        target: selection?.target || lastTarget,
        selectedText,
        maximum: dependencies.config.MAX_CONTEXT_CODE_POINTS
      });
      const mode = dependencies.mode.determineTranslationMode(selectedText, context);
      const anchorRect = selection?.rect || null;
      const sourceType = selection?.source || (explicitText ? "explicit" : "unknown");
      const selectionKey = selectionKeyFor({
        text: selectedText,
        sourceType,
        frameIdentity,
        anchorRect
      });
      return {
        request: dependencies.contracts.createTranslationRequest({
          text: selectedText,
          context: mode === dependencies.config.TRANSLATION_MODE.CONTEXTUAL ? context : null,
          mode,
          sourceScripts: dependencies.language.detectScripts(selectedText),
          targetLanguage: dependencies.config.TARGET_LANGUAGE,
          anchorRect: selection?.rect,
          surface: "content"
        }),
        anchorRect,
        createdAt: Date.now(),
        selectionKey,
        sourceType,
        snapshotRevision: selectionRevision,
        status: "ready"
      };
    }

    function planSignature(plan) {
      return JSON.stringify({
        selectionKey: plan?.selectionKey || "",
        mode: plan?.request?.mode || "",
        context: plan?.request?.context || ""
      });
    }

    async function translatePlan(plan, { allowDuplicate = false } = {}) {
      if (!plan?.request) {
        return {
          status: plan?.status === "unsupported" ? "unsupported" : "no-selection",
          reason: plan?.reason || ""
        };
      }
      const signature = planSignature(plan);
      if (
        !allowDuplicate &&
        deduper.isDuplicate(signature)
      ) {
        card.hideIntent?.();
        return { status: "duplicate", requestId: plan.request.requestId };
      }
      const languagePolicy = await dependencies.language.detectLanguagePolicy(plan.request.text, {
        detectLanguage: languageDetector
      });
      if (plan.snapshotRevision !== selectionRevision) {
        return { status: "no-selection", reason: "selection-changed" };
      }
      if (languagePolicy.skipTranslation) {
        card.hideIntent?.();
        return { status: "skipped-russian", requestId: plan.request.requestId };
      }
      deduper.record(signature);
      currentPlan = plan;
      card.begin(plan.request.text, plan.anchorRect);
      translationClient.translate(plan.request, {
        onDelta(delta) {
          card.appendDelta(delta);
        },
        onCompleted(result) {
          card.complete(result);
        },
        onSkipped() {
          card.close();
        },
        onFailed(error) {
          card.showError(error, () => translatePlan(currentPlan, { allowDuplicate: true }));
        }
      });
      return { status: "accepted", requestId: plan.request.requestId };
    }

    async function translateCurrent(explicitText = "") {
      return translatePlan(read(explicitText));
    }

    const intentController = dependencies.intent.createIntentController({
      getSnapshot() {
        return pendingPlan;
      },
      validateSnapshot(snapshot) {
        if (!snapshot?.request || snapshot.snapshotRevision !== selectionRevision) return false;
        const current = read();
        return Boolean(
          current?.request &&
            current.request.text === snapshot.request.text &&
            current.sourceType === snapshot.sourceType &&
            current.selectionKey === snapshot.selectionKey
        );
      },
      onAutomatic(snapshot) {
        translatePlan(snapshot);
      },
      onButton(snapshot) {
        const plan = snapshot;
        if (!plan) return;
        card.showIntentButton(plan.anchorRect, () => translatePlan(plan));
      },
      onDismiss() {
        card.hideIntent?.();
      }
    });

    function capturePlan() {
      pendingPlan = read();
      if (!pendingPlan?.request) {
        intentController.cancel();
        card.hideIntent?.();
      }
      return pendingPlan;
    }

    async function refreshSettings() {
      settings = await settingsClient.get();
      intentController.update(settings.selection);
      return settings;
    }

    function isOwnUi(event) {
      return event.composedPath?.().includes(card.host);
    }

    documentObject.addEventListener(
      "pointerdown",
      (event) => {
        // Clicking anywhere on the page dismisses the card, as in 1.3. Anything
        // inside our own shadow host — header, buttons, resize grip, the trigger —
        // is not "outside", so ordinary interaction with the card is unaffected.
        if (isOwnUi(event)) return;
        card.close?.();
        selectionRevision += 1;
        pendingPlan = null;
        card.hideIntent?.();
        lastTarget = event.composedPath?.()[0] || event.target;
        lastPointerEvent = event;
        intentController.handlePointerDown(event);
      },
      true
    );
    documentObject.addEventListener(
      "pointerup",
      (event) => {
        if (isOwnUi(event)) return;
        lastTarget = event.composedPath?.()[0] || event.target;
        lastPointerEvent = event;
        capturePlan();
        intentController.handlePointerUp(event);
      },
      true
    );
    documentObject.addEventListener("selectionchange", () => {
      selectionRevision += 1;
      card.hideIntent?.();
      capturePlan();
      intentController.evaluate(lastPointerEvent);
    });
    documentObject.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Escape") {
          intentController.dismiss();
          card.hideIntent?.();
        }
        intentController.handleKeyDown(event);
      },
      true
    );
    documentObject.addEventListener(
      "keyup",
      (event) => {
        selectionRevision += 1;
        card.hideIntent?.();
        lastTarget = event.composedPath?.()[0] || documentObject.activeElement;
        lastPointerEvent = event;
        capturePlan();
        intentController.evaluate(event);
      },
      true
    );
    documentObject.addEventListener(
      "copy",
      () => {
        intentController.cancel();
        card.hideIntent?.();
      },
      true
    );
    globalThis.addEventListener?.("focus", () => {
      refreshSettings().catch(() => {});
    });

    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== dependencies.config.MESSAGE.TRANSLATE_SELECTION) return;
      const plan = read(String(message.text || ""));
      if (plan?.status === "unsupported") {
        sendResponse({
          status: "unsupported",
          reason: plan.reason
        });
        return false;
      }
      translatePlan(plan)
        .then(sendResponse)
        .catch(() => sendResponse({ status: "content-script-unavailable" }));
      return true;
    });

    refreshSettings().catch(() => {});
    return { read, refreshSettings, translateCurrent, translatePlan };
  }

  return { createSelectionController, createSelectionDeduper, selectionKeyFor };
});
