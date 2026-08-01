(function exposeTranslationCard(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("../../shared/config.js"),
          drag: require("./card-drag-controller.js"),
          errors: require("../../shared/errors.js"),
          growth: require("./card-growth-controller.js"),
          positioner: require("./card-positioner.js"),
          renderer: require("../../shared/result-renderer.js"),
          resize: require("./card-resize-controller.js")
        }
      : {
          config: root.SensemarkConfig,
          drag: root.SensemarkCardDragController,
          errors: root.SensemarkErrors,
          growth: root.SensemarkCardGrowthController,
          positioner: root.SensemarkCardPositioner,
          renderer: root.SensemarkResultRenderer,
          resize: root.SensemarkCardResizeController
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkTranslationCard = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (dependencies) => {
  const CSS = `
    :host{all:initial;color-scheme:light dark;--sm-scale:1;--sm-font-size:calc(14px * var(--sm-scale));--sm-spacing:calc(10px * var(--sm-scale));--sm-control-size:calc(30px * var(--sm-scale))}
    *{box-sizing:border-box}
    .card,.trigger{font:var(--sm-font-size)/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18202a}
    /* Content-sized as in 1.3: a two-word translation is a small card, not a
       fixed 390px slab. Bounds match the original 230-400px range. */
    .card{position:fixed;z-index:2147483647;width:max-content;min-width:min(230px,calc(100vw - 24px));max-width:min(400px,calc(100vw - 24px));max-height:min(520px,calc(100vh - 24px));display:none;flex-direction:column;background:rgba(255,255,255,.98);border:1px solid rgba(22,36,50,.14);border-radius:calc(16px * var(--sm-scale));box-shadow:0 16px 48px rgba(15,23,42,.25);overflow:hidden}
    .card.visible{display:flex;animation:sm-in .13s ease-out}
    @keyframes sm-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
    .header{display:flex;align-items:center;gap:calc(8px * var(--sm-scale));padding:.79em .71em .5em 1.14em;cursor:grab;touch-action:none;user-select:none;border-bottom:1px solid rgba(22,36,50,.08)}
    .header:active{cursor:grabbing}.brand{font-weight:700;letter-spacing:-.01em}.spacer{flex:1}
    button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;border-radius:calc(9px * var(--sm-scale))}
    button:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
    .icon{width:var(--sm-control-size);height:var(--sm-control-size);display:grid;place-items:center}.icon:hover{background:#eef2f7}
    .body{padding:.5em 1.14em .93em;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;min-height:0}
    .translation{font-size:1.04em;line-height:1.5}
    .source{display:none;margin-top:.62em;padding-top:.62em;border-top:1px solid #e5e9ef;color:#5b6572}.source.visible{display:block}
    .section{margin-top:.62em;padding-top:.5em;border-top:1px solid #e5e9ef}.section-label{font-size:calc(11px * var(--sm-scale));text-transform:uppercase;color:#697586}
    .explanation,.alternatives{margin-top:.5em;color:#485466}
    .status{color:#697586}.error{color:#9f2d2d}.actions{display:flex;gap:calc(8px * var(--sm-scale));margin-top:.62em}
    .action{padding:calc(7px * var(--sm-scale)) var(--sm-spacing);background:#eef2f7}.action.primary{background:#2563eb;color:white}
    .grip{position:absolute;right:1px;bottom:1px;width:calc(20px * var(--sm-scale));height:calc(20px * var(--sm-scale));cursor:nwse-resize;touch-action:none}
    .grip::after{content:"";position:absolute;right:calc(5px * var(--sm-scale));bottom:calc(5px * var(--sm-scale));width:calc(7px * var(--sm-scale));height:calc(7px * var(--sm-scale));border-right:2px solid #94a0af;border-bottom:2px solid #94a0af}
    .trigger{position:fixed;z-index:2147483647;padding:calc(7px * var(--sm-scale)) calc(11px * var(--sm-scale));border-radius:999px;background:#18202a;color:white;box-shadow:0 8px 24px rgba(15,23,42,.28);display:none}
    .trigger.visible{display:block}.trigger.busy{opacity:.65;pointer-events:none}
    @media(prefers-reduced-motion:reduce){.card.visible{animation:none}}
    @media(prefers-color-scheme:dark){.card{color:#edf2f7;background:rgba(24,32,42,.98);border-color:#394453}.header,.section,.source{border-color:#394453}.icon:hover,.action{background:#303b49}.source,.explanation,.alternatives,.status{color:#b8c2cf}}
  `;

  function element(documentObject, tag, className, text = "") {
    const node = documentObject.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function createTranslationCard({
    documentObject = document,
    initialView = { scale: 1, cardWidth: 0, cardHeight: 0 },
    saveView,
    onClose,
    openSettings = () => chrome.runtime.openOptionsPage()
  } = {}) {
    const host = documentObject.createElement("sensemark-translation");
    const shadow = host.attachShadow({ mode: "open" });
    const style = element(documentObject, "style");
    style.textContent = CSS;
    const card = element(documentObject, "section", "card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Перевод Sensemark");
    const header = element(documentObject, "header", "header");
    header.setAttribute("aria-label", "Перетащить карточку перевода");
    const brand = element(documentObject, "span", "brand", "Sensemark");
    const spacer = element(documentObject, "span", "spacer");
    const originalButton = element(documentObject, "button", "icon", "Aa");
    originalButton.title = "Показать оригинал";
    originalButton.setAttribute("aria-label", originalButton.title);
    const copyButton = element(documentObject, "button", "icon", "⧉");
    copyButton.title = "Копировать перевод";
    copyButton.setAttribute("aria-label", copyButton.title);
    const settingsButton = element(documentObject, "button", "icon", "⚙");
    settingsButton.title = "Настройки";
    settingsButton.setAttribute("aria-label", settingsButton.title);
    const closeButton = element(documentObject, "button", "icon", "×");
    closeButton.title = "Закрыть";
    closeButton.setAttribute("aria-label", closeButton.title);
    header.append(brand, spacer, originalButton, copyButton, settingsButton, closeButton);
    const body = element(documentObject, "div", "body");
    const translation = element(documentObject, "div", "translation");
    translation.setAttribute("aria-live", "polite");
    const source = element(documentObject, "div", "source");
    body.append(translation, source);
    const grip = element(documentObject, "div", "grip");
    grip.setAttribute("role", "separator");
    grip.setAttribute("aria-label", "Изменить размер карточки");
    card.append(header, body, grip);
    const trigger = element(documentObject, "button", "trigger", "Перевести");
    trigger.setAttribute("aria-label", "Перевести выделенный текст");
    shadow.append(style, card, trigger);
    (documentObject.documentElement || documentObject.body).append(host);

    let anchor = null;
    let sourceText = "";
    let outputText = "";
    let manualPosition = false;
    let retryAction = null;
    let renderFrame = 0;
    let pendingDelta = "";
    let loadingTimer = 0;
    let previousFocus = null;
    let hasPlaced = false;
    const view = { ...initialView };

    function viewport() {
      return { width: innerWidth, height: innerHeight };
    }

    function place() {
      if (manualPosition) return;
      const rect = card.getBoundingClientRect();
      const next = dependencies.positioner.positionCard(
        anchor,
        { width: rect.width, height: rect.height },
        viewport()
      );
      card.style.left = `${next.left}px`;
      card.style.top = `${next.top}px`;
    }

    function clampManualPosition() {
      const rect = card.getBoundingClientRect();
      const next = dependencies.positioner.clampPosition(
        { left: rect.left, top: rect.top },
        { width: rect.width, height: rect.height },
        viewport()
      );
      card.style.left = `${next.left}px`;
      card.style.top = `${next.top}px`;
    }

    function refreshPosition() {
      if (manualPosition) clampManualPosition();
      else place();
    }

    function applyView() {
      const scale = Math.min(1.75, Math.max(0.75, Number(view.scale) || 1));
      host.style.setProperty("--sm-scale", scale);
      const maximum = dependencies.positioner.clampSize(
        {
          width: view.cardWidth || 390,
          height: view.cardHeight || 520
        },
        {
          width: Math.max(240, viewport().width),
          height: Math.max(120, viewport().height)
        }
      );
      card.style.width = view.cardWidth ? `${maximum.width}px` : "";
      card.style.height = view.cardHeight ? `${maximum.height}px` : "";
      card.style.maxWidth = `${Math.max(1, viewport().width - 24)}px`;
      card.style.maxHeight = `${Math.max(1, viewport().height - 24)}px`;
    }

    function show() {
      trigger.classList.remove("visible", "busy");
      const newlyVisible = !card.classList.contains("visible");
      card.classList.add("visible");
      if (newlyVisible && !hasPlaced) {
        hasPlaced = true;
        requestAnimationFrame(place);
        if (!previousFocus) previousFocus = documentObject.activeElement;
        requestAnimationFrame(() => closeButton.focus({ preventScroll: true }));
      }
      growthController.start();
    }

    function clearBody() {
      translation.replaceChildren();
      source.textContent = sourceText;
      source.classList.remove("visible");
    }

    function begin(nextSource, nextAnchor) {
      growthController.stop();
      pendingDelta = "";
      outputText = "";
      sourceText = String(nextSource || "");
      anchor = nextAnchor || null;
      manualPosition = false;
      retryAction = null;
      hasPlaced = false;
      clearTimeout(loadingTimer);
      card.classList.remove("visible");
      trigger.classList.remove("visible", "busy");
      clearBody();
      card.setAttribute("aria-busy", "true");
      translation.setAttribute("aria-live", "off");
      loadingTimer = setTimeout(() => {
        loadingTimer = 0;
        if (outputText || pendingDelta) return;
        translation.setAttribute("aria-live", "polite");
        translation.replaceChildren(
          element(documentObject, "div", "status", "Перевожу…")
        );
        show();
      }, dependencies.config.LOADING_THRESHOLD_MS);
    }

    function flushDelta() {
      renderFrame = 0;
      if (!pendingDelta) return;
      clearTimeout(loadingTimer);
      loadingTimer = 0;
      outputText += pendingDelta;
      pendingDelta = "";
      translation.setAttribute("aria-live", "off");
      // A model can answer a text-mode request with structured output. Paint the
      // extracted text, never the payload, even mid-stream.
      translation.textContent = dependencies.renderer.displayText
        ? dependencies.renderer.displayText(outputText)
        : outputText;
      if (translation.textContent.trim()) show();
    }

    function appendDelta(delta) {
      pendingDelta += String(delta || "");
      if (!renderFrame) renderFrame = requestAnimationFrame(flushDelta);
    }

    function complete(result) {
      clearTimeout(loadingTimer);
      loadingTimer = 0;
      flushDelta();
      card.setAttribute("aria-busy", "false");
      translation.setAttribute("aria-live", "polite");
      outputText = result.translation || result.text || outputText;
      dependencies.renderer.renderResult({
        documentObject,
        container: translation,
        result,
        fallbackText: outputText
      });
      show();
    }

    function showError(error, onRetry) {
      clearTimeout(loadingTimer);
      loadingTimer = 0;
      card.setAttribute("aria-busy", "false");
      translation.setAttribute("aria-live", "polite");
      retryAction = onRetry || null;
      translation.replaceChildren(element(documentObject, "div", "error", error.message || "Не удалось перевести."));
      const actions = element(documentObject, "div", "actions");
      const action = dependencies.errors.userActionForError(error);
      if (action === "retry") {
        const retry = element(documentObject, "button", "action primary", "Повторить");
        retry.setAttribute("aria-label", "Повторить перевод");
        retry.addEventListener("click", () => retryAction?.());
        actions.append(retry);
      }
      if (action === "open-settings") {
        const settings = element(documentObject, "button", "action primary", "Открыть настройки");
        settings.setAttribute("aria-label", "Открыть настройки Sensemark");
        settings.addEventListener("click", openSettings);
        actions.append(settings);
      }
      if (actions.childNodes.length) translation.append(actions);
      show();
    }

    function showIntentButton(nextAnchor, onClick) {
      anchor = nextAnchor || null;
      const size = { width: 100, height: 34 };
      const next = dependencies.positioner.positionCard(anchor, size, viewport(), { gap: 7 });
      trigger.style.left = `${next.left}px`;
      trigger.style.top = `${next.top}px`;
      trigger.onclick = (event) => {
        event.preventDefault();
        trigger.classList.add("busy");
        onClick?.();
      };
      trigger.classList.add("visible");
    }

    function close() {
      clearTimeout(loadingTimer);
      loadingTimer = 0;
      if (renderFrame) cancelAnimationFrame(renderFrame);
      renderFrame = 0;
      growthController.stop();
      card.classList.remove("visible");
      card.setAttribute("aria-busy", "false");
      trigger.classList.remove("visible", "busy");
      onClose?.();
      previousFocus?.focus?.({ preventScroll: true });
      previousFocus = null;
    }

    function hideIntent() {
      trigger.classList.remove("visible", "busy");
    }

    originalButton.addEventListener("click", () => source.classList.toggle("visible"));
    copyButton.addEventListener("click", async () => {
      const copyText =
        outputText ||
        Array.from(translation.querySelectorAll(".section"), (node) => node.textContent).join("\n");
      if (copyText) await navigator.clipboard.writeText(copyText);
    });
    settingsButton.addEventListener("click", openSettings);
    closeButton.addEventListener("click", close);
    documentObject.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Escape" || !card.classList.contains("visible")) return;
        event.preventDefault();
        close();
      },
      true
    );
    header.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        view.scale = Math.min(1.75, Math.max(0.75, (view.scale || 1) + (event.deltaY < 0 ? 0.05 : -0.05)));
        applyView();
        requestAnimationFrame(refreshPosition);
        saveView?.({ ui: { scale: view.scale } });
      },
      { passive: false }
    );

    const growthController = dependencies.growth.createCardGrowthController({
      element: card,
      isVisible: () => card.classList.contains("visible"),
      isManual: () => manualPosition,
      onAnchored: place,
      onManual: clampManualPosition
    });

    dependencies.drag.createCardDragController({
      element: card,
      handle: header,
      onPosition: () => {
        manualPosition = true;
      },
      onReset: () => {
        manualPosition = false;
        place();
      }
    });
    dependencies.resize.createCardResizeController({
      element: card,
      handle: grip,
      onSize(size) {
        view.cardWidth = size.width;
        view.cardHeight = size.height;
        if (manualPosition) {
          clampManualPosition();
        }
        saveView?.({ ui: { cardWidth: size.width, cardHeight: size.height } });
      }
    });
    addEventListener("resize", () => {
      if (card.classList.contains("visible")) {
        refreshPosition();
      }
    });
    applyView();

    return {
      appendDelta,
      begin,
      close,
      complete,
      hideIntent,
      host,
      hideTriggerButton: hideIntent,
      dismissSelectionUi: close,
      showError,
      showIntentButton
    };
  }

  return { createTranslationCard };
});
