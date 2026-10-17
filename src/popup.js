(function exposePopup(root, factory) {
  const node = typeof module === "object" && module.exports;
  const manual = node ? require("./manual-translation.js") : root.SensemarkManualTranslation;
  const I18n = node ? require("./i18n.js") : root.SensemarkI18n;
  const api = factory(manual, I18n, root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkPopup = api;
    if (root.chrome?.storage?.local && root.chrome?.runtime) {
      api
        .createPopupController({
          document: root.document,
          chrome: root.chrome,
          navigator: root.navigator,
          window: root
        })
        .init();
    }
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (manual, I18n, root) => {
  if (!manual) throw new Error("Sensemark: manual translation helper is unavailable.");
  const { t } = I18n;

  function createPopupController(environment) {
    const document = environment.document;
    I18n.localize(document);
    const chrome = environment.chrome;
    const navigator = environment.navigator || {};
    const window = environment.window || {};
    const autoTranslateDelayMs = environment.autoTranslateDelayMs ?? 850;
    const pasteTranslateDelayMs = environment.pasteTranslateDelayMs ?? 60;
    const scheduleTimeout = window.setTimeout?.bind(window) || setTimeout;
    // Free mode: Chrome's built-in translator right inside the popup;
    // OpenAI mode: a request through the background, as on the page.
    const builtin = environment.builtin || root.SensemarkBuiltin;
    let builtinEngine = null;
    // Language detection: chrome.i18n in Chrome, Apple's system in Safari
    // through the Sensemark app.
    function detectLanguage(text) {
      const platform = builtin?.platformDeps?.(chrome, window);
      if (platform?.platform === "safari") return platform.detectLanguage(text);
      return chrome.i18n?.detectLanguage?.(text);
    }
    function openPort() {
      if (settings.provider === "openai" || !builtin) {
        return chrome.runtime.connect({ name: "translate" });
      }
      const platform = builtin.platformDeps ? builtin.platformDeps(chrome, window) : null;
      builtinEngine ||= builtin.createBuiltinTranslator({
        Translator: environment.Translator ?? platform?.Translator ?? window.Translator,
        detectLanguage: platform?.detectLanguage ?? ((text) => chrome.i18n.detectLanguage(text)),
        labels: platform?.labels,
        isRussianOnly: environment.language?.isRussianOnly ?? root.SensemarkLanguageDetection?.isRussianOnly,
        detectScripts: (text) =>
          (environment.language ?? root.SensemarkLanguageDetection)?.detectSignificantScripts?.(text) || []
      });
      return builtin.openLocalPort(builtinEngine);
    }
    const cancelTimeout = window.clearTimeout?.bind(window) || clearTimeout;

    const elements = {
      source: document.getElementById("sourceText"),
      clear: document.getElementById("clearButton"),
      count: document.getElementById("charCount"),
      activity: document.getElementById("activity"),
      settings: document.getElementById("settingsButton"),
      setup: document.getElementById("setupBanner"),
      setupText: document.getElementById("setupText"),
      setupButton: document.getElementById("setupButton"),
      message: document.getElementById("message"),
      result: document.getElementById("result"),
      resultLabel: document.getElementById("resultLabel"),
      resultBody: document.getElementById("resultBody"),
      copy: document.getElementById("copyButton"),
      copyLabel: document.querySelector("#copyButton span"),
      status: document.getElementById("status")
    };

    if (Object.values(elements).some((element) => !element)) {
      throw new Error("Sensemark: popup markup is incomplete.");
    }

    let settings = { ...manual.SETTINGS_DEFAULTS };
    let setupIssue = null;
    let currentPort = null;
    let requestId = 0;
    let busy = false;
    let copyValue = "";
    let initialized = false;
    let autoTimer = null;
    let pastePending = false;

    const createElement = (tag, className = "", text = "") => {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (text) element.textContent = text;
      return element;
    };

    function openSettings() {
      if (chrome.runtime?.openOptionsPage) {
        chrome.runtime.openOptionsPage();
      } else {
        chrome.runtime?.sendMessage?.({ type: "open-options" });
      }
    }

    function setStatus(message, kind = "") {
      elements.status.textContent = message;
      const state = kind || (busy ? "busy" : "");
      elements.activity.className = `activity${state ? ` ${state}` : ""}`;
    }

    function showMessage(message, kind = "") {
      elements.message.textContent = message;
      elements.message.className = `message${kind ? ` ${kind}` : ""}`;
      elements.message.hidden = !message;
    }

    function clearResult() {
      copyValue = "";
      elements.result.hidden = true;
      elements.result.className = "result";
      elements.resultBody.textContent = "";
      elements.copy.disabled = true;
      elements.copy.classList.remove("copied");
      elements.copyLabel.textContent = t("actionCopy");
    }

    function applySetupState() {
      setupIssue = manual.settingsIssue(settings);
      elements.setup.hidden = !setupIssue;
      elements.setupText.textContent = setupIssue?.message || "";
      refreshControls();
    }

    function refreshControls() {
      const hasText = Boolean(elements.source.value.trim());
      elements.clear.hidden = !hasText;
      elements.activity.classList.toggle("busy", busy);
    }

    function updateCount() {
      const length = [...elements.source.value].length;
      elements.count.textContent = `${length} / ${manual.MAX_CHARS}`;
      refreshControls();
    }

    function setBusy(next) {
      busy = next;
      refreshControls();
    }

    function clearScheduled() {
      if (autoTimer === null) return;
      cancelTimeout(autoTimer);
      autoTimer = null;
    }

    function cancelActive(announce = false, cancelScheduled = true) {
      if (cancelScheduled) clearScheduled();
      requestId++;
      const port = currentPort;
      currentPort = null;
      setBusy(false);
      if (port) {
        try {
          port.disconnect();
        } catch {
          // The channel is already closed.
        }
      }
      if (announce) {
        setStatus(t("statusStopped"), "error");
        showMessage(t("messageStopped"));
      }
    }

    function renderTranslation(view) {
      const text = createElement("p", "translation-text", view.text);
      elements.resultBody.appendChild(text);
      if (view.detail) {
        const detail = createElement("div", "detail");
        detail.append(
          createElement("div", "detail-label", view.detailLabel || t("labelOtherMeanings")),
          createElement("p", "detail-text", view.detail)
        );
        elements.resultBody.appendChild(detail);
      }
    }

    function renderReference(view) {
      elements.resultBody.append(
        createElement("span", "reference-category", view.category),
        createElement("p", "reference-title", view.title),
        createElement("p", "reference-note", t("referenceNote"))
      );
      if (view.detail) {
        const detail = createElement("div", "detail");
        detail.append(
          createElement("div", "detail-label", view.detailLabel),
          createElement("p", "detail-text", view.detail)
        );
        elements.resultBody.appendChild(detail);
      }
    }

    function renderMultilingual(view) {
      for (const section of view.sections) {
        const item = createElement("section", "segment");
        const isRussian = new RegExp(t("patternTargetLanguage"), "i").test(section.language);
        const label = isRussian
          ? t("sectionKept", section.language)
          : t("sectionTranslated", section.language);
        item.append(
          createElement("div", `segment-language${isRussian ? " kept" : ""}`, label),
          createElement("p", "segment-text", section.text)
        );
        elements.resultBody.appendChild(item);
      }
    }

    function renderView(view) {
      elements.resultBody.textContent = "";
      elements.result.className = `result ${view.kind}`;
      elements.resultLabel.textContent =
        view.kind === "reference"
          ? t("labelReference")
          : view.kind === "multilingual"
            ? t("labelMultilingual")
            : t("labelTranslation");

      if (view.kind === "reference") renderReference(view);
      else if (view.kind === "multilingual") renderMultilingual(view);
      else renderTranslation(view);

      copyValue = view.copyText;
      elements.copy.disabled = !copyValue;
      elements.result.hidden = false;
      showMessage("");
    }

    function fail(message) {
      setBusy(false);
      setStatus(t("statusNeedsCheck"), "error");
      clearResult();
      showMessage(message || t("errorTranslationFailed"), "error");
    }

    function connect(plan, id) {
      let port;
      try {
        port = openPort();
      } catch {
        fail(t("errorPopupReload"));
        return;
      }

      currentPort = port;
      let finished = false;
      let visible = false;

      const release = () => {
        finished = true;
        if (currentPort === port) currentPort = null;
        setBusy(false);
      };

      port.onMessage.addListener((message) => {
        if (id !== requestId) return;

        if (message?.type === "chunk" || message?.type === "done") {
          const view = manual.parseManualResponse(message.text, plan.wordMode, plan.text);
          if (view.visible) {
            visible = true;
            renderView(view);
            setStatus(
              message.type === "done" ? t("statusDone") : t("statusStreaming"),
              message.type === "done" ? "success" : "busy"
            );
          }

          if (message.type === "done") {
            if (!visible) {
              fail(t("errorNoTranslation"));
            } else {
              release();
            }
            try {
              port.disconnect();
            } catch {
              // The channel is already closed.
            }
          }
        } else if (message?.type === "status") {
          if (!visible) setStatus(message.text, "busy");
        } else if (message?.type === "error") {
          release();
          fail(message.error);
          try {
            port.disconnect();
          } catch {
            // The channel is already closed.
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (id !== requestId || finished) return;
        release();
        fail(t("errorConnectionLost"));
      });

      port.postMessage({
        type: "start",
        text: plan.text,
        context: plan.context,
        wordMode: plan.wordMode,
        sourceScripts: plan.sourceScripts
      });
    }

    async function translate() {
      clearScheduled();
      if (setupIssue) {
        setStatus(t("statusSetupRequired"), "error");
        showMessage(setupIssue.message, "error");
        return;
      }

      cancelActive(false, false);
      const id = ++requestId;
      clearResult();
      showMessage("");
      setBusy(true);
      setStatus(t("statusDetecting"));

      let detection = null;
      try {
        detection = await detectLanguage(elements.source.value);
      } catch {
        // The local detector may return no language for short text.
      }
      if (id !== requestId) return;

      const plan = manual.createRequestPlan(elements.source.value, detection);
      if (plan.kind === "error") {
        fail(plan.message);
        return;
      }
      if (plan.kind === "russian") {
        setBusy(false);
        setStatus(t("statusAlreadyRussian"), "local");
        showMessage(t("messageAlreadyRussian"), "local");
        return;
      }

      setStatus(t("statusConnecting"));
      connect(plan, id);
    }

    async function copyResult() {
      if (!copyValue) return false;
      let copied;
      try {
        await navigator.clipboard.writeText(copyValue);
        copied = true;
      } catch {
        try {
          const textarea = createElement("textarea");
          textarea.value = copyValue;
          textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none";
          document.body.appendChild(textarea);
          textarea.select();
          copied = Boolean(document.execCommand?.("copy"));
          textarea.remove();
        } catch {
          copied = false;
        }
      }

      if (copied) {
        elements.copy.classList.add("copied");
        elements.copyLabel.textContent = t("actionCopied");
        setTimeout(() => {
          elements.copy.classList.remove("copied");
          elements.copyLabel.textContent = t("actionCopy");
        }, 1100);
      }
      return copied;
    }

    function clear() {
      cancelActive(false);
      elements.source.value = "";
      updateCount();
      clearResult();
      showMessage("");
      setStatus(t("statusAutoStart"));
      elements.source.focus();
    }

    function scheduleAutoTranslate(fromPaste = false) {
      clearScheduled();
      const expectedText = elements.source.value.trim();
      if (!expectedText) {
        setStatus(t("statusAutoStart"));
        return;
      }
      if (setupIssue) {
        setStatus(t("statusSetupRequired"), "error");
        return;
      }

      const delay = fromPaste ? pasteTranslateDelayMs : autoTranslateDelayMs;
      setStatus(fromPaste ? t("statusStarting") : t("statusAfterPause"));
      autoTimer = scheduleTimeout(() => {
        autoTimer = null;
        if (elements.source.value.trim() !== expectedText) return;
        translate();
      }, delay);
    }

    function onInput(event) {
      cancelActive(false);
      clearResult();
      showMessage("");
      updateCount();
      const fromPaste = pastePending || event?.inputType === "insertFromPaste";
      pastePending = false;
      scheduleAutoTranslate(fromPaste);
    }

    function bind() {
      elements.clear.addEventListener("click", clear);
      elements.copy.addEventListener("click", copyResult);
      elements.settings.addEventListener("click", openSettings);
      elements.setupButton.addEventListener("click", openSettings);
      elements.source.addEventListener("paste", () => {
        pastePending = true;
      });
      elements.source.addEventListener("input", onInput);
      elements.source.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          translate();
        }
      });
      window.addEventListener?.("unload", () => cancelActive(false), { once: true });
      chrome.storage?.onChanged?.addListener?.((changes, area) => {
        if (area !== "local") return;
        const hadSetupIssue = Boolean(setupIssue);
        for (const key of Object.keys(manual.SETTINGS_DEFAULTS)) {
          if (changes[key]) settings[key] = changes[key].newValue;
        }
        applySetupState();
        if (hadSetupIssue && !setupIssue && elements.source.value.trim()) {
          scheduleAutoTranslate(false);
        }
      });
    }

    async function init() {
      if (initialized) return;
      initialized = true;
      bind();
      updateCount();
      setStatus(t("statusLoadingSettings"));

      try {
        settings = await chrome.storage.local.get(manual.SETTINGS_DEFAULTS);
        applySetupState();
        setStatus(setupIssue ? t("statusSetupRequired") : t("statusAutoStart"), setupIssue ? "error" : "");
      } catch {
        setupIssue = {
          code: "storage",
          message: t("errorReadSettings")
        };
        elements.setup.hidden = false;
        elements.setupText.textContent = setupIssue.message;
        refreshControls();
        setStatus(t("statusSettingsUnavailable"));
      }

      elements.source.focus();
    }

    return {
      cancelActive,
      clear,
      copyResult,
      getState: () => ({
        busy,
        copyValue,
        currentPort,
        scheduled: autoTimer !== null,
        requestId,
        settings: { ...settings },
        setupIssue
      }),
      init,
      renderView,
      translate
    };
  }

  return { createPopupController };
});
