(function exposePopup(root, factory) {
  const manual =
    typeof module === "object" && module.exports
      ? require("./manual-translation.js")
      : root.SensemarkManualTranslation;
  const api = factory(manual);

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
})(typeof globalThis !== "undefined" ? globalThis : this, (manual) => {
  if (!manual) throw new Error("Sensemark: manual translation helper is unavailable.");

  function createPopupController(environment) {
    const document = environment.document;
    const chrome = environment.chrome;
    const navigator = environment.navigator || {};
    const window = environment.window || {};
    const autoTranslateDelayMs = environment.autoTranslateDelayMs ?? 850;
    const pasteTranslateDelayMs = environment.pasteTranslateDelayMs ?? 60;
    const scheduleTimeout = window.setTimeout?.bind(window) || setTimeout;
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
      elements.copyLabel.textContent = "Копировать";
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
          // Канал уже закрыт.
        }
      }
      if (announce) {
        setStatus("Перевод остановлен", "error");
        showMessage("Запрос остановлен — незавершённая генерация отменена.");
      }
    }

    function renderTranslation(view) {
      const text = createElement("p", "translation-text", view.text);
      elements.resultBody.appendChild(text);
      if (view.detail) {
        const detail = createElement("div", "detail");
        detail.append(
          createElement("div", "detail-label", view.detailLabel || "Другие значения"),
          createElement("p", "detail-text", view.detail)
        );
        elements.resultBody.appendChild(detail);
      }
    }

    function renderReference(view) {
      elements.resultBody.append(
        createElement("span", "reference-category", view.category),
        createElement("p", "reference-title", view.title),
        createElement("p", "reference-note", "Не переводится как обычное слово")
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
        const isRussian = /^русск/i.test(section.language);
        const label = isRussian
          ? `${section.language} · без изменений`
          : `${section.language} → русский`;
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
          ? "Объяснение"
          : view.kind === "multilingual"
            ? "Несколько языков"
            : "Перевод";

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
      setStatus("Нужна проверка", "error");
      clearResult();
      showMessage(message || "Не удалось выполнить перевод.", "error");
    }

    function connect(plan, id) {
      let port;
      try {
        port = chrome.runtime.connect({ name: "translate" });
      } catch {
        fail("Расширение было обновлено. Закройте popup и откройте его снова.");
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
              message.type === "done" ? "Готово" : "Перевод поступает…",
              message.type === "done" ? "success" : "busy"
            );
          }

          if (message.type === "done") {
            if (!visible) {
              fail("Не удалось получить перевод — попробуйте ещё раз.");
            } else {
              release();
            }
            try {
              port.disconnect();
            } catch {
              // Канал уже закрыт.
            }
          }
        } else if (message?.type === "error") {
          release();
          fail(message.error);
          try {
            port.disconnect();
          } catch {
            // Канал уже закрыт.
          }
        }
      });

      port.onDisconnect.addListener(() => {
        if (id !== requestId || finished) return;
        release();
        fail("Соединение прервано — попробуйте ещё раз.");
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
        setStatus("Требуется настройка", "error");
        showMessage(setupIssue.message, "error");
        return;
      }

      cancelActive(false, false);
      const id = ++requestId;
      clearResult();
      showMessage("");
      setBusy(true);
      setStatus("Определяю язык…");

      let detection = null;
      try {
        detection = await chrome.i18n?.detectLanguage?.(elements.source.value);
      } catch {
        // Для короткого текста локальный определитель может не вернуть язык.
      }
      if (id !== requestId) return;

      const plan = manual.createRequestPlan(elements.source.value, detection);
      if (plan.kind === "error") {
        fail(plan.message);
        return;
      }
      if (plan.kind === "russian") {
        setBusy(false);
        setStatus("Уже на русском", "local");
        showMessage("Текст уже на русском — перевод не требуется.", "local");
        return;
      }

      setStatus("Подключаю перевод…");
      connect(plan, id);
    }

    async function copyResult() {
      if (!copyValue) return false;
      let copied = false;
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
        elements.copyLabel.textContent = "Скопировано";
        setTimeout(() => {
          elements.copy.classList.remove("copied");
          elements.copyLabel.textContent = "Копировать";
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
      setStatus("Перевод начнётся автоматически");
      elements.source.focus();
    }

    function scheduleAutoTranslate(fromPaste = false) {
      clearScheduled();
      const expectedText = elements.source.value.trim();
      if (!expectedText) {
        setStatus("Перевод начнётся автоматически");
        return;
      }
      if (setupIssue) {
        setStatus("Требуется настройка", "error");
        return;
      }

      const delay = fromPaste ? pasteTranslateDelayMs : autoTranslateDelayMs;
      setStatus(fromPaste ? "Начинаю перевод…" : "Переведу после паузы…");
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
      setStatus("Загружаю настройки…");

      try {
        settings = await chrome.storage.local.get(manual.SETTINGS_DEFAULTS);
        applySetupState();
        setStatus(
          setupIssue ? "Требуется настройка" : "Перевод начнётся автоматически",
          setupIssue ? "error" : ""
        );
      } catch {
        setupIssue = {
          code: "storage",
          message: "Не удалось прочитать настройки расширения."
        };
        elements.setup.hidden = false;
        elements.setupText.textContent = setupIssue.message;
        refreshControls();
        setStatus("Настройки недоступны");
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
