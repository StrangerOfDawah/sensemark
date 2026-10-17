(() => {
  // The background may inject this script again; the second run does nothing.
  if (window.__gptTranslateLoaded) return;

  const t = globalThis.SensemarkI18n?.t;

  const parseWordResponse = globalThis.SensemarkWordResponse?.parse;
  const parseTextResponse = globalThis.SensemarkTextResponse?.parse;
  const isRussianOnly = globalThis.SensemarkLanguageDetection?.isRussianOnly;
  const detectScripts = globalThis.SensemarkLanguageDetection?.detectScripts;
  const hasMultipleScripts = globalThis.SensemarkLanguageDetection?.hasMultipleScripts;
  const detectSignificantScripts = globalThis.SensemarkLanguageDetection?.detectSignificantScripts;
  const joinSelectionParts = globalThis.SensemarkSelectionText?.joinSelectionParts;
  const createScaleController = globalThis.SensemarkScale?.createScaleController;
  const Builtin = globalThis.SensemarkBuiltin;
  const CardTheme = globalThis.SensemarkCardTheme;
  const { CARD_STYLE, STATUS_STYLE, ICONS } = globalThis.SensemarkCardStyles || {};
  const PageText = globalThis.SensemarkPageText;
  const Placement = globalThis.SensemarkPlacement;
  const {
    extractContext,
    extractSelectedImages,
    extractVisibleRangeText,
    isEditableSelection,
    isShort,
    samplePage
  } = PageText || {};
  if (
    !t ||
    !parseWordResponse ||
    !parseTextResponse ||
    !isRussianOnly ||
    !detectScripts ||
    !hasMultipleScripts ||
    !detectSignificantScripts ||
    !joinSelectionParts ||
    !createScaleController ||
    !Builtin ||
    !CardTheme ||
    !CARD_STYLE ||
    !PageText ||
    !Placement ||
    !globalThis.SensemarkStatusPill
  ) {
    console.error("Sensemark: response helpers are unavailable.");
    return;
  }
  window.__gptTranslateLoaded = true;

  const HOST_ID = "__gpt_translate_popup_host__";
  const MAX_CHARS = 5000;

  let host = null;
  let shadow = null;
  let card = null;
  let bodyEl = null;
  let requestId = 0;
  let lastRect = null;
  let currentPort = null;
  let streamState = null;
  let bracket = null;
  // Where the card sits: anchor (at the selection), margin (in the right margin),
  // drawer (a panel at the window edge). anchorInfo is the selection it is
  // tied to: on scroll the card moves with the text.
  let layout = { kind: "anchor" };
  let anchorInfo = null;
  let anchorOffset = null;

  // Card size lives in storage so it carries across all pages.
  const VIEW_DEFAULTS = { uiScale: 1, cardWidth: 0, cardHeight: 0 };
  const WIDTH_MIN = 230; // matches the card's min-width in CSS
  const HEIGHT_MIN = 120;

  // Keep flags locally so the service worker is not woken on every selection.
  let autoTranslate = false;
  let autoPausedUntil = 0; // auto-translate pause (shared by all tabs), ms
  // Translation mode: "builtin" is Chrome's free on-device translator,
  // "openai" is the user's own OpenAI key through the background.
  let provider = "builtin";
  // Appearance: theme (match the page / light / dark), translation font and
  // text size as on the page.
  const APPEARANCE_DEFAULTS = { cardTheme: "auto", cardFont: "system", matchPageSize: true };
  let appearance = { ...APPEARANCE_DEFAULTS };
  // Chrome: the built-in Translator API; Safari: Apple's translator through the
  // Sensemark app (see builtin-translator.js → platformDeps).
  const platform = Builtin.platformDeps(chrome);
  const builtinEngine = Builtin.createBuiltinTranslator({
    Translator: platform.Translator,
    detectLanguage: platform.detectLanguage,
    labels: platform.labels,
    isRussianOnly,
    detectScripts: (text) => detectSignificantScripts(text)
  });

  function openTranslationPort() {
    return provider === "openai"
      ? chrome.runtime.connect({ name: "translate" })
      : Builtin.openLocalPort(builtinEngine);
  }
  let view = { ...VIEW_DEFAULTS };
  const scaleController = createScaleController();

  // Auto-translate is on by default; until settings are read the flag above is false
  // so nothing is translated for someone who turned it off.
  const STORED_DEFAULTS = {
    autoTranslate: true,
    autoPausedUntil: 0,
    provider: "builtin",
    ...VIEW_DEFAULTS,
    ...APPEARANCE_DEFAULTS
  };
  chrome.storage.local.get(STORED_DEFAULTS).then((s) => {
    autoTranslate = s.autoTranslate;
    for (const key of Object.keys(APPEARANCE_DEFAULTS)) appearance[key] = s[key];
    provider = s.provider === "openai" ? "openai" : "builtin";
    autoPausedUntil = Number(s.autoPausedUntil) || 0;
    view = { uiScale: s.uiScale, cardWidth: s.cardWidth, cardHeight: s.cardHeight };
    if (card) applyView();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.autoTranslate) autoTranslate = changes.autoTranslate.newValue;
    if (changes.autoPausedUntil) autoPausedUntil = Number(changes.autoPausedUntil.newValue) || 0;
    if (changes.provider) provider = changes.provider.newValue === "openai" ? "openai" : "builtin";
    for (const key of Object.keys(APPEARANCE_DEFAULTS)) {
      if (changes[key]) appearance[key] = changes[key].newValue ?? APPEARANCE_DEFAULTS[key];
    }
    // Apply changes from another tab on the fly.
    let touched = false;
    for (const key of Object.keys(VIEW_DEFAULTS)) {
      if (changes[key]) {
        view[key] = changes[key].newValue;
        touched = true;
      }
    }
    if (touched && card) applyView();
  });

  let saveViewTimer = null;
  function saveView() {
    clearTimeout(saveViewTimer);
    saveViewTimer = setTimeout(() => {
      chrome.storage.local.set(view).catch(() => {});
    }, 350);
  }

  function applyView() {
    if (!card) return;
    card.style.setProperty("--ui-scale", view.uiScale);

    // In the margin and the drawer the width comes from the screen, not the saved size.
    if (layout.kind !== "anchor") {
      card.style.width = `${layout.width}px`;
      card.style.maxWidth = "none";
      card.style.height = "";
      card.style.setProperty("--bd-max", "none");
      return;
    }
    card.style.maxHeight = "";

    if (view.cardWidth) {
      card.style.width = `${view.cardWidth}px`;
      card.style.maxWidth = "none";
    } else {
      card.style.width = "";
      card.style.maxWidth = "";
    }

    if (view.cardHeight) {
      card.style.height = `${view.cardHeight}px`;
      // The body stretches to the whole card; its own limit gives way.
      card.style.setProperty("--bd-max", "none");
    } else {
      card.style.height = "";
      card.style.removeProperty("--bd-max");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "translate-selection") {
      sendResponse({ received: true }); // confirm the script is alive
      handleSelection();
    }
  });

  // Auto-translate waits a moment after a selection: if the user copies
  // (⌘/Ctrl+C) or opens the context menu in that time, the selection was
  // not for translation, and the request is cancelled before any card appears.
  const AUTO_DELAY = 500;
  const PAUSE_MINUTES = 5;
  let autoTimer = null;
  let autoPendingId = 0; // id of the auto request whose card is not shown yet

  function isAutoEnabled() {
    return Boolean(autoTranslate) && Date.now() >= autoPausedUntil;
  }

  function cancelPendingAuto() {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (autoPendingId && autoPendingId === requestId) {
      requestId++;
      currentPort?.disconnect(); // the background aborts the request
      currentPort = null;
      pill.hide();
    }
    autoPendingId = 0;
  }

  document.addEventListener("mouseup", (event) => {
    if (event.button !== 0) return; // right/middle button: not a reading selection
    if (!isAutoEnabled()) return;
    if (host && event.composedPath().includes(host)) return;
    if (isEditableSelection()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => handleSelection({ auto: true }), AUTO_DELAY);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      // event.code, not key: on a Russian layout the C key types a Cyrillic letter.
      if ((event.metaKey || event.ctrlKey) && event.code === "KeyC") cancelPendingAuto();
    },
    true
  );
  document.addEventListener("copy", cancelPendingAuto, true);
  document.addEventListener("contextmenu", cancelPendingAuto, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  function getSelectionInfo() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

    const range = selection.getRangeAt(0);
    const rawText = selection.toString().trim();
    const visibleText = extractVisibleRangeText(range);
    const text = detectScripts(visibleText).length ? visibleText : rawText;
    const selectedImages = extractSelectedImages(range);

    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    const anchor = { range: range.cloneRange(), page: samplePage(range) };

    // OCR never runs automatically: it is expensive and unreliable for decorative
    // fonts. An image without a foreign text layer is explained locally,
    // without sending empty data or Russian captions to the API.
    const imageTextUnsupported = selectedImages.length > 0 && (text.length < 2 || isRussianOnly(text));
    if (imageTextUnsupported) {
      return {
        ...anchor,
        text: "",
        rect,
        context: null,
        wordMode: false,
        sourceScripts: [],
        imageTextUnsupported
      };
    }
    if (text.length < 2) return null;

    // For short fragments, pull in the surrounding sentence: without it
    // ambiguous words are translated at random.
    const wordMode = isShort(text) && !hasMultipleScripts(text);
    const context = wordMode && text === rawText ? extractContext(range, text) : null;

    return { ...anchor, text, rect, context, wordMode, sourceScripts: detectSignificantScripts(text) };
  }

  // Palette, font and size for this selection's card and pill.
  function lookFor(info) {
    const prefersDark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const palette = CardTheme.buildPalette({
      mode: appearance.cardTheme,
      background: info.page?.background || null,
      text: info.page?.text || null,
      prefersDark
    });
    return {
      scheme: palette.scheme,
      vars: CardTheme.cssVariables(palette, {
        font: appearance.cardFont,
        fontSize: CardTheme.readableSize(info.page?.fontSize, appearance.matchPageSize !== false)
      })
    };
  }

  function applyLook(element, look) {
    if (!element || !look) return;
    for (const [name, value] of Object.entries(look.vars)) element.style.setProperty(name, value);
  }

  // Golos Text and Literata ship with the extension; they are added to the page
  // once, and only when chosen in settings.
  const loadedFonts = new Map();
  function ensureFont(font) {
    if (font !== "golos" && font !== "literata") return Promise.resolve();
    if (loadedFonts.has(font)) return loadedFonts.get(font);
    const family = font === "golos" ? "Sensemark Golos" : "Sensemark Literata";
    const loading = chrome.runtime
      .sendMessage({ type: "get-font", font })
      .then(async (response) => {
        if (!response?.ok || typeof FontFace !== "function" || !document.fonts) return;
        for (const face of response.faces) {
          const bytes = Uint8Array.from(atob(face.data), (char) => char.charCodeAt(0));
          const fontFace = new FontFace(family, bytes, { weight: "400", unicodeRange: face.unicodeRange });
          await fontFace.load();
          document.fonts.add(fontFace);
        }
      })
      .catch(() => {});
    loadedFonts.set(font, loading);
    return loading;
  }

  // Is the text Russian, and which language are we translating from, for the
  // "Translating from English…" label. Chrome decides locally and for free.
  // The detector often fails on a single word ("bank" → Cebuano), so the
  // label's language comes from the surrounding sentence, and an unreliable
  // answer is not shown at all: a plain "Translation" beats a wrong language.
  async function detectSource(text, labelText = text) {
    const detection = await detectLanguageSafe(text);
    const labelDetection = labelText === text ? detection : await detectLanguageSafe(labelText);
    const top = labelDetection?.languages?.[0];
    const code = Builtin.normalizeLanguage(top?.language);
    // Chrome's isReliable can be false even for a correct answer on a short
    // sentence, so from 20 characters on an "unreliable" answer is trusted.
    const trusted = labelDetection?.isReliable !== false || labelText.trim().length >= 20;
    const known = code && code !== "ru" && trusted && (top?.percentage ?? 100) >= 60;
    return {
      ignore: isRussianOnly(text, detection),
      language: known ? Builtin.languageGenitive(code) : ""
    };
  }

  async function detectLanguageSafe(text) {
    try {
      return await platform.detectLanguage(text);
    } catch {
      return null; // the local CLD may give no result for very short text
    }
  }

  async function handleSelection({ auto = false } = {}) {
    autoTimer = null;
    const info = getSelectionInfo();
    if (!info) return; // no selection in this frame, stay quiet

    if (info.imageTextUnsupported) {
      ++requestId;
      currentPort?.disconnect();
      currentPort = null;
      render(info, {
        state: "error",
        message: t("errorImageText")
      });
      return;
    }

    if (info.text.length > MAX_CHARS) {
      render(info, {
        state: "error",
        message: t("errorFragmentTooLong", info.text.length, MAX_CHARS)
      });
      return;
    }

    const id = ++requestId;
    autoPendingId = auto ? id : 0;
    currentPort?.disconnect();
    currentPort = null;

    // Russian text already is the translation result: show no card
    // and send no extra request to OpenAI.
    const source = await detectSource(info.text, info.context || info.text);
    if (source.ignore) {
      if (id !== requestId) return;
      close();
      return;
    }
    if (id !== requestId) return;
    // Mixed text gets its own "Several languages" label.
    info.language = info.sourceScripts.length > 1 ? "" : source.language;

    startTranslation(info, id);
  }

  function startTranslation(info, id) {
    // Remove the old result at once, but do not create an empty card for the new
    // request. It appears only with the first meaningful fragment; while waiting
    // there is only the small "Translating from English…" pill.
    if (host) close({ cancelRequest: false, animate: false });
    pill.hide({ animate: false });
    prepareCardFor(info);

    // Streaming: the translation is printed as it is generated, without waiting for the full answer.
    let port;
    try {
      port = openTranslationPort();
    } catch {
      render(info, { state: "error", message: t("errorExtensionReloaded") });
      return;
    }
    currentPort = port;

    let started = false;
    let finished = false;
    const release = () => {
      finished = true;
      if (autoPendingId === id) autoPendingId = 0;
      if (currentPort === port) currentPort = null;
    };
    // Free mode answers in ~30 ms; then the pill does not flash for nothing.
    pill.schedule(info, id, {
      label: info.language ? t("statusTranslatingFrom", info.language) : t("statusTranslating")
    });

    port.onMessage.addListener((message) => {
      if (id !== requestId) return;

      if (message.type === "chunk" || message.type === "done") {
        if (!started && !hasVisibleStreamContent(message.text, info.wordMode)) {
          if (message.type === "done") {
            render(info, {
              state: "error",
              message: t("errorNoTranslation")
            });
            release();
            port.disconnect();
          }
          return;
        }
        if (!started) {
          if (autoPendingId === id) autoPendingId = 0; // the card is shown, no more cancelling
          pill.hide();
          beginStreamCard(info);
          started = true;
        }
        updateStream(message.text);
        place();
        if (message.type === "done") {
          finalizeStream();
          release();
          port.disconnect();
        }
      } else if (message.type === "status") {
        // For example a language pack download: the ring fills for real.
        if (!started) pill.show(info, id, statusFromMessage(message));
      } else if (message.type === "error") {
        release();
        port.disconnect();
        if (message.code === "needs-download") {
          // Chrome downloads a language pack only on a user click.
          render(info, {
            state: "error",
            message: t("needsDownloadSuffix", message.error),
            action: {
              label: t("actionDownload"),
              run: async () => {
                const downloadId = ++requestId;
                close({ cancelRequest: false, animate: false });
                const name = Builtin.languageName(message.language);
                // Chrome reports a real percentage; Apple's translator downloads
                // the language in the Sensemark app, where the ring just spins.
                const labels = builtinEngine.labels;
                pill.show(info, downloadId, {
                  label: labels.downloading(name),
                  kind: "download",
                  progress: labels.reportsProgress ? 0 : null
                });
                try {
                  await builtinEngine.prepare(message.language, (progress) => {
                    if (downloadId !== requestId) return;
                    pill.show(info, downloadId, {
                      label: t("downloadingPercent", name, Math.round(progress * 100)),
                      kind: "download",
                      progress
                    });
                  });
                } catch {
                  if (downloadId !== requestId) return;
                  render(info, {
                    state: "error",
                    message: t("errorDownloadFailed")
                  });
                  return;
                }
                if (downloadId !== requestId) return;
                startTranslation(info, downloadId);
              }
            }
          });
          return;
        }
        render(info, { state: "error", message: message.error });
      }
    });

    // The service worker died mid-answer; silence is not an option.
    port.onDisconnect.addListener(() => {
      if (id !== requestId || finished) return;
      release();
      render(info, { state: "error", message: t("errorConnectionLost") });
    });

    port.postMessage({
      type: "start",
      text: info.text,
      context: info.context,
      wordMode: info.wordMode,
      sourceScripts: info.sourceScripts
    });
  }

  // Look and placement are decided before the answer, so the pill stands
  // where the card will open later and has the same colour.
  function prepareCardFor(info) {
    ensureFont(appearance.cardFont);
    info.look = lookFor(info);
    info.paragraphs = CardTheme.countParagraphs(info.text);
    info.long = CardTheme.isLongSelection(info.text);
    info.layout = CardTheme.chooseLayout({
      text: info.text,
      rect: info.rect,
      viewportWidth: window.innerWidth
    });
  }

  function statusFromMessage(message) {
    if (message.kind !== "download") return { label: message.text, kind: "info" };
    const name = Builtin.languageName(message.language || "");
    const progress = typeof message.progress === "number" ? message.progress : null;
    return {
      label:
        progress === null
          ? t("chromeDownloading", name)
          : t("downloadingPercent", name, Math.round(progress * 100)),
      kind: "download",
      progress,
      hint: message.text
    };
  }

  // Status pill → circle while waiting for the first piece of translation.
  const pill = globalThis.SensemarkStatusPill.createStatusPill({
    isCurrent: (id) => id === requestId,
    hasCard: () => Boolean(card),
    liveRect: (info) => liveRect(info),
    applyLook: (element, look) => applyLook(element, look),
    style: STATUS_STYLE,
    placement: Placement
  });

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    // Host styles are inline so the page's CSS cannot override them.
    // position: absolute uses page coordinates: the card moves with the text.
    host.style.cssText = "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${CARD_STYLE}
      <div class="bracket" hidden></div>
      <div class="card anchor" role="dialog" aria-label="${t("labelTranslation")}">
        <div class="hd">
          <span class="badge">${t("labelTranslation")}</span>
          <span class="zoom" hidden></span>
          <span class="sp"></span>
          <button class="icon-btn xs" data-act="close" title="${t("cardCloseTitle")}">${ICONS.close}</button>
        </div>
        <div class="bd"></div>
        <div class="grip" title="${t("cardGripTitle")}"></div>
      </div>
    `;
    document.documentElement.appendChild(host);

    card = shadow.querySelector(".card");
    bodyEl = shadow.querySelector(".bd");
    bracket = shadow.querySelector(".bracket");
    shadow.querySelector("[data-act=close]").addEventListener("click", close);

    applyView();
    setupZoom();
    setupResize();

    document.addEventListener("mousedown", onOutsideClick, true);
  }

  function onOutsideClick(event) {
    if (host && !event.composedPath().includes(host)) close();
  }

  // Scrolling no longer closes the card: it is tied to the text and moves
  // with it, including inside scrollable blocks of the page.
  window.addEventListener(
    "scroll",
    (event) => {
      if (host && event.composedPath?.().includes(host)) return; // scrolling inside the card
      if (card) placeNow({ decide: false });
      pill.place();
    },
    { passive: true, capture: true }
  );
  window.addEventListener(
    "resize",
    () => {
      if (card && anchorInfo) {
        setLayout(
          CardTheme.chooseLayout({
            text: anchorInfo.text,
            rect: liveRect(anchorInfo),
            viewportWidth: window.innerWidth
          })
        );
        place();
      }
      pill.place();
    },
    { passive: true }
  );

  // Cmd/Ctrl + wheel scales the card. preventDefault is required,
  // otherwise the browser zooms the whole page.
  let scalePositionTimer = null;
  function setupZoom() {
    scaleController.reset();
    card.addEventListener(
      "wheel",
      (event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (!event.deltaY) return;

        // A trackpad sends dozens of wheel events per gesture. Previously each
        // of them changed the scale by 8% at once, so the card flew away.
        // Accept at most one small step per interval.
        const change = scaleController.next(view.uiScale, event.deltaY, performance.now());
        if (!change.changed) return;

        view.uiScale = change.value;
        applyView();
        showZoom();
        saveView();

        // During the gesture keep the top-left corner stable. After a pause
        // gently bring the card back to the selection and inside the screen.
        clearTimeout(scalePositionTimer);
        scalePositionTimer = setTimeout(() => {
          scalePositionTimer = null;
          if (host) place();
        }, 180);
      },
      { passive: false }
    );
  }

  let zoomTimer = null;
  function showZoom() {
    const badge = shadow.querySelector(".badge");
    const zoom = shadow.querySelector(".zoom");
    if (!zoom) return;
    zoom.textContent = `${Math.round(view.uiScale * 100)}%`;
    zoom.hidden = false;
    badge.hidden = true;
    clearTimeout(zoomTimer);
    zoomTimer = setTimeout(() => {
      zoom.hidden = true;
      badge.hidden = false;
    }, 900);
  }

  function setupResize() {
    const grip = shadow.querySelector(".grip");
    if (!grip) return;

    grip.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      grip.setPointerCapture(event.pointerId);
      grip.classList.add("active");

      const box = card.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startW = box.width;
      const startH = box.height;

      const onMove = (moveEvent) => {
        view.cardWidth = Math.max(WIDTH_MIN, Math.round(startW + moveEvent.clientX - startX));
        view.cardHeight = Math.max(HEIGHT_MIN, Math.round(startH + moveEvent.clientY - startY));
        applyView();
      };

      const onUp = () => {
        grip.classList.remove("active");
        grip.removeEventListener("pointermove", onMove);
        grip.removeEventListener("pointerup", onUp);
        saveView();
        place();
      };

      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });

    // Double-clicking the corner restores the default size and scale.
    grip.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      view = { ...VIEW_DEFAULTS };
      applyView();
      showZoom();
      saveView();
      place();
    });
  }

  function setCardPresentation(mode) {
    const reference = mode === "reference";
    const multilingual = mode === "multilingual";
    card.classList.toggle("reference", reference);
    card.classList.toggle("multilingual", multilingual);
    card.setAttribute(
      "aria-label",
      reference ? t("cardAriaReference") : multilingual ? t("cardAriaMultilingual") : t("labelTranslation")
    );
    const badge = shadow.querySelector(".badge");
    if (badge) {
      badge.textContent = reference
        ? t("labelReference")
        : multilingual
          ? t("labelMultilingual")
          : CardTheme.headerLabel({
              language: anchorInfo?.language || "",
              paragraphs: anchorInfo?.paragraphs || 1,
              long: layout.kind !== "anchor"
            });
    }
  }

  // The card is tied to the selection and takes its look and placement.
  function attachCard(info, cardLayout) {
    ensureHost();
    pill.hide({ animate: false });
    anchorInfo = info;
    anchorOffset = null;
    lastRect = info.rect;
    info.look ||= lookFor(info);
    applyLook(host, info.look);
    card.dataset.scheme = info.look.scheme;
    setLayout(cardLayout);
  }

  function setLayout(next) {
    layout = next || { kind: "anchor" };
    if (!card) return;
    for (const kind of ["anchor", "margin", "drawer"]) card.classList.toggle(kind, layout.kind === kind);
    if (bracket) bracket.hidden = layout.kind !== "margin";
    applyView();
  }

  // Errors and hints are short, so they always use the card at the selection.
  function render(info, payload) {
    attachCard(info, { kind: "anchor" });
    setCardPresentation("translation");

    if (payload.state === "error") {
      bodyEl.innerHTML = `
        <div class="err">${payload.icon === false ? "" : ICONS.warn}<p class="err-t"></p></div>
        <div class="acts"><span class="sp"></span><button class="chip accent" data-act="options">${t("actionOpenSettings")}</button></div>`;
      bodyEl.querySelector(".err-t").textContent = payload.message;
      const button = bodyEl.querySelector("[data-act=options]");
      if (payload.action === null) {
        button.remove();
      } else if (payload.action) {
        button.textContent = payload.action.label;
        button.addEventListener("click", payload.action.run);
      } else {
        button.addEventListener("click", () => {
          chrome.runtime.sendMessage({ type: "open-options" });
        });
      }
    }

    // Restart the content reveal animation.
    bodyEl.style.animation = "none";
    void bodyEl.offsetWidth;
    bodyEl.style.animation = "";

    place();
  }

  // Card scaffold for streaming: text goes into .live, actions stay hidden until the end.
  // wordMode is only for short fragments: the model puts the translation on the
  // first line, followed by other meanings or an explanation of a non-dictionary fragment.
  // In ordinary text, line breaks are just paragraphs and must not be parsed.
  function beginStreamCard(info) {
    const source = info.text;
    const wordMode = info.wordMode;
    attachCard(info, info.layout);
    setCardPresentation("translation");
    bodyEl.innerHTML = `
      <div class="term-kind" hidden></div>
      <p class="tr"><span class="live"></span><span class="caret"></span></p>
      <div class="segments" hidden></div>
      <p class="reference-note" hidden>${t("referenceNote")}</p>
      <div class="alt" hidden><div class="cap">${t("labelOtherMeanings")}</div><p class="alt-t"></p></div>
      <div class="acts pending">
        <span class="sp"></span>
        <button class="icon-btn" data-act="auto" title="${t("cardAutoTitle")}" hidden>${ICONS.pause}</button>
        <button class="icon-btn" data-act="copy" title="${t("cardCopyTitle")}">${ICONS.copy}</button>
      </div>
      <div class="auto-menu" hidden>
        <button class="chip accent" data-act="pause">${t("actionPause", PAUSE_MINUTES)}</button>
        <button class="chip" data-act="off">${t("autoMenuDisable")}</button>
      </div>
      <p class="auto-note" hidden></p>`;

    const state = {
      main: "",
      copyText: "",
      source: source || "",
      wordMode,
      termKind: bodyEl.querySelector(".term-kind"),
      mainEl: bodyEl.querySelector(".tr"),
      live: bodyEl.querySelector(".live"),
      caret: bodyEl.querySelector(".caret"),
      segments: bodyEl.querySelector(".segments"),
      referenceNote: bodyEl.querySelector(".reference-note"),
      alt: bodyEl.querySelector(".alt"),
      altCap: bodyEl.querySelector(".alt .cap"),
      altT: bodyEl.querySelector(".alt-t"),
      acts: bodyEl.querySelector(".acts")
    };
    streamState = state;

    setupAutoControls();

    const copyBtn = bodyEl.querySelector("[data-act=copy]");
    copyBtn.addEventListener("click", async () => {
      const ok = await copyText(state.copyText || state.main);
      copyBtn.classList.toggle("ok", ok);
      copyBtn.innerHTML = ok ? ICONS.check : ICONS.copy;
      setTimeout(() => {
        copyBtn.classList.remove("ok");
        copyBtn.innerHTML = ICONS.copy;
      }, 1400);
    });
  }

  // The card's pause button: pause for 5 minutes or turn auto-translate off
  // completely. Manual translation (right click, shortcut) always works.
  function setupAutoControls() {
    const toggle = bodyEl.querySelector("[data-act=auto]");
    const menu = bodyEl.querySelector(".auto-menu");
    const note = bodyEl.querySelector(".auto-note");
    toggle.hidden = !isAutoEnabled();

    const hotkey = /Mac/i.test(navigator.platform) ? "⌘⇧Y" : "Ctrl+Shift+Y";
    const manualHint = t("manualHint", hotkey);
    const finish = (message) => {
      menu.hidden = true;
      toggle.hidden = true;
      note.textContent = message;
      note.hidden = false;
      place();
    };

    toggle.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      toggle.classList.toggle("open", !menu.hidden);
      place();
    });
    menu.querySelector("[data-act=pause]").addEventListener("click", () => {
      const until = Date.now() + PAUSE_MINUTES * 60 * 1000;
      autoPausedUntil = until;
      chrome.storage.local.set({ autoPausedUntil: until }).catch(() => {});
      const time = new Date(until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      finish(t("autoPausedUntil", time, manualHint));
    });
    menu.querySelector("[data-act=off]").addEventListener("click", () => {
      autoTranslate = false;
      chrome.storage.local.set({ autoTranslate: false, autoPausedUntil: 0 }).catch(() => {});
      finish(t("autoTurnedOff", manualHint));
    });
  }

  function hasVisibleStreamContent(text, wordMode) {
    if (!wordMode) {
      const parsed = parseTextResponse(text);
      if (parsed.mode === "pending" || parsed.mode === "skip") return false;
      if (parsed.mode === "multilingual") {
        return parsed.sections.some((section) => Boolean(section.text));
      }
      return Boolean(parsed.text);
    }

    const parsed = parseWordResponse(text);
    if (parsed.mode === "pending" || parsed.mode === "skip") return false;
    if (parsed.mode === "reference") {
      const content = String(text || "")
        .split("\n")
        .slice(1)
        .join("\n")
        .trim();
      return Boolean(content);
    }
    return Boolean(parsed.main);
  }

  function updateStream(text) {
    if (!streamState) return;

    if (!streamState.wordMode) {
      const parsed = parseTextResponse(text);
      if (parsed.mode === "pending") return;
      // [[skip]] is an invalid model answer: the background requests a fix
      // automatically. The marker is never shown to the user.
      if (parsed.mode === "skip") return;

      if (parsed.mode === "multilingual") {
        setCardPresentation("multilingual");
        streamState.mainEl.hidden = true;
        streamState.segments.hidden = false;
        renderLanguageSections(streamState, parsed.sections);
        return;
      }

      // An ordinary translation is shown as is: line breaks are paragraphs.
      setCardPresentation("translation");
      streamState.mainEl.hidden = false;
      streamState.segments.hidden = true;
      streamState.main = parsed.text;
      streamState.copyText = parsed.text;
      // In a long translation (margin, drawer) paragraphs get a blank line between them,
      // otherwise they merge into a wall of text. Copying keeps the translation as is.
      streamState.live.textContent =
        layout.kind === "anchor" ? parsed.text : parsed.text.replace(/\n+/g, "\n\n");
      streamState.live.after(streamState.caret);
      return;
    }

    const parsed = parseWordResponse(text);
    if (parsed.mode === "pending" || parsed.mode === "skip") return;

    if (parsed.mode === "reference") {
      setCardPresentation("reference");
      streamState.termKind.hidden = false;
      streamState.termKind.textContent = parsed.category || t("labelUnknownTerm");
      streamState.live.textContent = streamState.source;
      streamState.referenceNote.hidden = false;
      streamState.referenceNote.textContent = new RegExp(t("patternNoDictionaryMeaning"), "i").test(
        parsed.category
      )
        ? t("referenceNoMeaning")
        : t("referenceUsedAs", parsed.category || t("referenceNameOrTitle"));
      streamState.alt.hidden = false;
      streamState.altCap.textContent = parsed.detailLabel || t("labelWhatItMayBe");
      streamState.altT.textContent = parsed.detail;
      streamState.altT.appendChild(streamState.caret);
      streamState.main = streamState.source;
      streamState.copyText = [streamState.source, parsed.detail].filter(Boolean).join("\n");
      return;
    }

    setCardPresentation("translation");
    streamState.termKind.hidden = true;
    streamState.referenceNote.hidden = true;
    streamState.main = parsed.main;
    streamState.copyText = parsed.main;
    streamState.live.textContent = parsed.main;
    streamState.live.after(streamState.caret);
    streamState.alt.hidden = !parsed.detail;
    streamState.altCap.textContent = parsed.detailLabel || t("labelOtherMeanings");
    streamState.altT.textContent = parsed.detail;
  }

  function renderLanguageSections(state, sections) {
    state.segments.textContent = "";
    let lastText = null;

    for (const section of sections) {
      const item = document.createElement("section");
      item.className = "segment";

      const language = document.createElement("div");
      const isRussian = new RegExp(t("patternTargetLanguage"), "i").test(section.language);
      language.className = `segment-lang${isRussian ? " kept" : ""}`;
      language.textContent = isRussian
        ? t("sectionKept", section.language)
        : t("sectionTranslated", section.language);

      const translated = document.createElement("p");
      translated.className = "segment-text";
      translated.textContent = section.text;
      item.append(language, translated);
      state.segments.appendChild(item);
      lastText = translated;
    }

    (lastText || state.segments).appendChild(state.caret);
    const combined = sections
      .map((section) => section.text)
      .filter(Boolean)
      .join("\n\n");
    state.main = combined;
    state.copyText = combined;
  }

  function finalizeStream() {
    if (!streamState) return;
    streamState.caret.remove();
    streamState.acts.classList.remove("pending");
    streamState = null;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position: fixed; opacity: 0;";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  // The selection's current position on screen. The Range is live: after scrolling
  // or a page re-layout it returns new coordinates.
  function liveRect(info) {
    try {
      const rect = info?.range?.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    } catch {
      // The selection's nodes were removed from the page; stay at the last position.
    }
    return info?.rect || lastRect;
  }

  function place() {
    requestAnimationFrame(() => placeNow({ decide: true }));
  }

  // decide: choose the side (below/above) and offset again. On scroll
  // the side does not change, the card just moves with the text.
  function placeNow({ decide }) {
    if (!card || !anchorInfo) return;
    const rect = liveRect(anchorInfo);
    if (!rect) return;
    const sx = window.scrollX;
    const sy = window.scrollY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    card.classList.toggle("tracking", !decide);

    if (layout.kind === "drawer") {
      card.style.top = "";
      card.style.left = "";
      card.style.maxHeight = "";
      reveal(null);
      return;
    }

    if (layout.kind === "margin") {
      card.style.maxHeight = `${vh - 32}px`;
      const note = Placement.marginPlacement({ rect, box: card.getBoundingClientRect() });
      card.style.left = `${note.left + sx}px`;
      card.style.top = `${note.top + sy}px`;
      bracket.style.left = `${note.bracket.left + sx}px`;
      bracket.style.top = `${note.bracket.top + sy}px`;
      bracket.style.height = `${note.bracket.height}px`;
      reveal(note);
      return;
    }

    const box = card.getBoundingClientRect();
    if (decide || !anchorOffset) {
      const spot = Placement.anchorPlacement({ rect, box, viewport: { width: vw, height: vh } });
      card.classList.toggle("above", spot.side === "above");
      card.classList.toggle("free", spot.side === "free");
      card.style.setProperty("--notch-x", `${spot.notchX}px`);
      anchorOffset = spot.offset;
    }
    const { left, top } = Placement.followAnchor({ rect, box, offset: anchorOffset });
    card.style.left = `${left + sx}px`;
    card.style.top = `${top + sy}px`;
    reveal({ left, top });
  }

  // First appearance: the card unfolds from where the circle was.
  function reveal(point) {
    if (card.classList.contains("in")) return;
    const origin = pill.takeOrigin();
    if (point && origin && !origin.fixed) {
      card.style.transformOrigin = `${origin.x - point.left}px ${origin.y - point.top}px`;
    }
    card.classList.add("in");
  }

  function close({ cancelRequest = true, animate = true } = {}) {
    if (!host) {
      if (cancelRequest) {
        // The pill is still waiting for an answer; Esc and an outside click cancel it too.
        if (pill.visible) {
          requestId++;
          currentPort?.disconnect();
          currentPort = null;
        }
        pill.hide({ animate });
      }
      return;
    }
    clearTimeout(scalePositionTimer);
    scalePositionTimer = null;
    if (cancelRequest) {
      requestId++; // cancel the answer to the current request
      currentPort?.disconnect(); // the background aborts the fetch and burns no tokens
      currentPort = null;
    }
    streamState = null;

    document.removeEventListener("mousedown", onOutsideClick, true);
    if (cancelRequest) pill.hide({ animate: false });

    const dying = host;
    if (animate) {
      card.classList.add("out");
      setTimeout(() => dying.remove(), 170);
    } else {
      dying.remove();
    }

    host = null;
    shadow = null;
    card = null;
    bodyEl = null;
    bracket = null;
    anchorInfo = null;
    anchorOffset = null;
    layout = { kind: "anchor" };
  }
})();
