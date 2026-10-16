(() => {
  // Скрипт может быть внедрён повторно из background — второй раз не выполняемся.
  if (window.__gptTranslateLoaded) return;

  const parseWordResponse = globalThis.SensemarkWordResponse?.parse;
  const parseTextResponse = globalThis.SensemarkTextResponse?.parse;
  const isRussianOnly = globalThis.SensemarkLanguageDetection?.isRussianOnly;
  const detectScripts = globalThis.SensemarkLanguageDetection?.detectScripts;
  const hasMultipleScripts = globalThis.SensemarkLanguageDetection?.hasMultipleScripts;
  const detectSignificantScripts = globalThis.SensemarkLanguageDetection?.detectSignificantScripts;
  const joinSelectionParts = globalThis.SensemarkSelectionText?.joinSelectionParts;
  const createScaleController = globalThis.SensemarkScale?.createScaleController;
  const Builtin = globalThis.SensemarkBuiltin;
  if (
    !parseWordResponse ||
    !parseTextResponse ||
    !isRussianOnly ||
    !detectScripts ||
    !hasMultipleScripts ||
    !detectSignificantScripts ||
    !joinSelectionParts ||
    !createScaleController ||
    !Builtin
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

  // Размеры карточки живут в storage, чтобы держаться на всех страницах.
  const VIEW_DEFAULTS = { uiScale: 1, cardWidth: 0, cardHeight: 0 };
  const WIDTH_MIN = 230; // совпадает с min-width карточки в CSS
  const HEIGHT_MIN = 120;

  // Держим флаги локально, чтобы не будить service worker на каждое выделение.
  let autoTranslate = false;
  let autoPausedUntil = 0; // пауза автоперевода (общая для всех вкладок), мс
  // Режим перевода: "builtin" — бесплатный переводчик Chrome на устройстве,
  // "openai" — свой ключ OpenAI через background.
  let provider = "builtin";
  const builtinEngine = Builtin.createBuiltinTranslator({
    Translator: globalThis.Translator,
    detectLanguage: (text) => chrome.i18n.detectLanguage(text),
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

  chrome.storage.local.get({ autoTranslate: false, autoPausedUntil: 0, provider: "builtin", ...VIEW_DEFAULTS }).then((s) => {
    autoTranslate = s.autoTranslate;
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
    // Изменения из соседней вкладки применяем на лету.
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

    if (view.cardWidth) {
      card.style.width = `${view.cardWidth}px`;
      card.style.maxWidth = "none";
    } else {
      card.style.width = "";
      card.style.maxWidth = "";
    }

    if (view.cardHeight) {
      card.style.height = `${view.cardHeight}px`;
      // Тело растягивается на всю карточку, свой лимит уступает.
      card.style.setProperty("--bd-max", "none");
    } else {
      card.style.height = "";
      card.style.removeProperty("--bd-max");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "translate-selection") {
      sendResponse({ received: true }); // подтверждаем, что скрипт жив
      handleSelection();
    }
  });

  // Автоперевод ждёт немного после выделения: если за это время человек
  // копирует (⌘/Ctrl+C) или открывает контекстное меню, значит, он выделял
  // не для перевода — запрос отменяется, пока карточка ещё не появилась.
  const AUTO_DELAY = 500;
  const PAUSE_MINUTES = 5;
  let autoTimer = null;
  let autoPendingId = 0; // id автозапроса, карточка которого ещё не показана

  function isAutoEnabled() {
    return Boolean(autoTranslate) && Date.now() >= autoPausedUntil;
  }

  // Выделение внутри поля ввода или редактора — это правка, а не чтение.
  function isEditableSelection() {
    const active = document.activeElement;
    if (active && (/^(?:INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) {
      return true;
    }
    const anchor = window.getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    return Boolean(element?.isContentEditable);
  }

  function cancelPendingAuto() {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (autoPendingId && autoPendingId === requestId) {
      requestId++;
      currentPort?.disconnect(); // background оборвёт запрос
      currentPort = null;
    }
    autoPendingId = 0;
  }

  document.addEventListener("mouseup", (event) => {
    if (event.button !== 0) return; // правая/средняя кнопка — не выделение для чтения
    if (!isAutoEnabled()) return;
    if (host && event.composedPath().includes(host)) return;
    if (isEditableSelection()) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => handleSelection({ auto: true }), AUTO_DELAY);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      // event.code, а не key: на русской раскладке клавиша C даёт «с».
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

    // OCR не запускаем автоматически: это дорого и ненадёжно для декоративных
    // шрифтов. Изображение без иностранного текстового слоя объясняем локально,
    // не отправляя пустые данные и русские подписи в API.
    const imageTextUnsupported =
      selectedImages.length > 0 && (text.length < 2 || isRussianOnly(text));
    if (imageTextUnsupported) {
      return { text: "", rect, context: null, wordMode: false, sourceScripts: [], imageTextUnsupported };
    }
    if (text.length < 2) return null;

    // Для коротких фрагментов подтягиваем предложение вокруг — без него
    // многозначные слова переводятся наугад.
    const wordMode = isShort(text) && !hasMultipleScripts(text);
    const context = wordMode && text === rawText ? extractContext(range, text) : null;

    return { text, rect, context, wordMode, sourceScripts: detectSignificantScripts(text) };
  }

  function extractVisibleRangeText(range) {
    const root = range.commonAncestorContainer;
    const nodes = [];
    // Кэши на одно выделение: при выделении всей страницы иначе getComputedStyle
    // вызывается заново для каждого предка каждого текстового узла.
    const cache = { visible: new Map(), block: new Map(), noise: new Map() };

    if (root.nodeType === Node.TEXT_NODE) {
      nodes.push(root);
    } else {
      const walker = document.createTreeWalker(
        root,
        NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node) =>
            node.nodeType === Node.TEXT_NODE || node.nodeName === "BR"
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_SKIP
        }
      );
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
    }

    const parts = [];
    for (const node of nodes) {
      try {
        if (!range.intersectsNode(node)) continue;
        const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!element) continue;

        if (node.nodeName === "BR") {
          if (!isVisibleElement(element, cache.visible)) continue;
          parts.push({
            lineBreak: true,
            block: blockOf(element, cache.block),
            noise: isNoiseElement(element, cache.noise)
          });
          continue;
        }

        if (!isVisibleTextNode(node, cache.visible)) continue;

        let start = 0;
        let end = node.data.length;
        if (node === range.startContainer) start = range.startOffset;
        if (node === range.endContainer) end = range.endOffset;
        const part = node.data.slice(start, end);
        if (!part) continue;

        parts.push({
          text: part,
          block: blockOf(element, cache.block),
          noise: isNoiseElement(element, cache.noise),
          preserveLines: /^(?:pre|break-spaces)/.test(getComputedStyle(element).whiteSpace || "")
        });
      } catch {
        // Некоторые сложные Range на динамических страницах нельзя пересечь.
      }
    }
    return joinSelectionParts(parts);
  }

  // Ближайший блочный предок: текст внутри одного блока — один абзац.
  function blockOf(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      const display = getComputedStyle(current).display;
      if (display && !display.startsWith("inline") && display !== "contents") break;
      current = current.parentElement;
    }
    const block = current || document.body;
    cache.set(element, block);
    return block;
  }

  // Мусор интерфейса, общий для любого сайта: элементы управления, меню и
  // навигация, шапка/подвал/боковая панель сайта, сноски-ссылки.
  // Ссылки внутри текста — это содержимое, их не трогаем.
  const CONTROL_SELECTOR =
    "button, input, select, textarea, option, summary, nav, menu, " +
    '[role="button"], [role="menuitem"], [role="menu"], [role="menubar"], ' +
    '[role="navigation"], [role="toolbar"], [role="tablist"], [role="tab"], ' +
    '[role="search"], [role="tooltip"]';
  const SITE_CHROME_SELECTOR =
    'header, footer, aside, [role="banner"], [role="contentinfo"], [role="complementary"]';
  const CONTENT_SELECTOR = 'article, main, [role="main"], [role="article"]';

  function isNoiseElement(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let noise = Boolean(element.closest(CONTROL_SELECTOR));
    if (!noise) {
      // Шапка статьи с заголовком — содержимое; шапка всего сайта — нет.
      const chrome = element.closest(SITE_CHROME_SELECTOR);
      noise = Boolean(chrome && !chrome.closest(CONTENT_SELECTOR));
    }
    if (!noise) {
      // Сноска вида [1] — ссылка в верхнем индексе. Обычный x² остаётся.
      const sup = element.closest("sup");
      noise = Boolean(sup && (sup.querySelector("a") || sup.closest("a")));
    }
    cache.set(element, noise);
    return noise;
  }

  function extractSelectedImages(range) {
    const root =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!root) return [];

    const images = root.matches?.("img") ? [root] : [...root.querySelectorAll("img")];
    return images.filter((image) => {
      try {
        if (!range.intersectsNode(image) || !isVisibleElement(image)) return false;
        const rect = image.getBoundingClientRect();
        return rect.width >= 12 && rect.height >= 12;
      } catch {
        return false;
      }
    });
  }

  function isVisibleElement(element, cache = new Map()) {
    if (!element || element === document.documentElement) return true;
    if (cache.has(element)) return cache.get(element);

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hidden =
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0 ||
      style.clipPath === "inset(50%)" ||
      (style.position === "absolute" &&
        style.overflow === "hidden" &&
        rect.width <= 1 &&
        rect.height <= 1);

    const visible = !hidden && isVisibleElement(element.parentElement, cache);
    cache.set(element, visible);
    return visible;
  }

  function isVisibleTextNode(node, cache) {
    if (!node.parentElement || !isVisibleElement(node.parentElement, cache)) return false;

    const probe = document.createRange();
    probe.selectNodeContents(node);
    return [...probe.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1);
  }

  function isShort(text) {
    return text.length <= 40 && text.split(/\s+/).length <= 3;
  }

  async function shouldIgnoreSelection(text) {
    let detection = null;
    try {
      detection = await chrome.i18n?.detectLanguage?.(text);
    } catch {
      // Локальный CLD может не дать результат для очень короткого текста.
    }
    return isRussianOnly(text, detection);
  }

  // Ближайший блочный предок — за его границы предложение не выходит.
  function nearestBlock(node) {
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display && !display.startsWith("inline") && display !== "contents") {
        return element;
      }
      element = element.parentElement;
    }
    return element || document.body;
  }

  function extractContext(range, selectedText) {
    const block = nearestBlock(range.startContainer);
    if (!block) return null;

    let full;
    let offset;
    try {
      const whole = document.createRange();
      whole.selectNodeContents(block);
      full = whole.toString();

      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      offset = before.toString().length;
    } catch {
      return null; // выделение через границы узлов, с которыми Range не справился
    }

    if (!full || offset < 0 || offset > full.length) return null;

    const LOOKAROUND = 400;
    const BOUNDARY = /[.!?…\n\r]/;

    let start = offset;
    while (start > 0 && offset - start < LOOKAROUND && !BOUNDARY.test(full[start - 1])) {
      start--;
    }

    let end = offset + selectedText.length;
    const from = end;
    while (end < full.length && end - from < LOOKAROUND && !BOUNDARY.test(full[end])) {
      end++;
    }
    if (end < full.length) end++; // забираем сам знак конца предложения

    const sentence = full.slice(start, end).replace(/\s+/g, " ").trim();

    // Контекст полезен, только если он реально шире выделения и содержит его.
    if (sentence.length <= selectedText.length + 5) return null;
    if (!sentence.includes(selectedText)) return null;

    return sentence;
  }

  async function handleSelection({ auto = false } = {}) {
    autoTimer = null;
    const info = getSelectionInfo();
    if (!info) return; // в этом фрейме выделения нет — молчим

    if (info.imageTextUnsupported) {
      ++requestId;
      currentPort?.disconnect();
      currentPort = null;
      render(info.rect, {
        state: "error",
        message:
          "Выделенный фрагмент нарисован как изображение, а не как текст. " +
          "Sensemark не отправил его в API, чтобы не тратить токены. " +
          "Выделите доступную текстовую подпись или перевод."
      });
      return;
    }

    if (info.text.length > MAX_CHARS) {
      render(info.rect, {
        state: "error",
        message: `Слишком длинный фрагмент: ${info.text.length} символов (максимум ${MAX_CHARS}).`
      });
      return;
    }

    const id = ++requestId;
    autoPendingId = auto ? id : 0;
    currentPort?.disconnect();
    currentPort = null;

    // Русский текст уже является результатом перевода: не показываем карточку
    // и не отправляем лишний запрос в OpenAI.
    if (await shouldIgnoreSelection(info.text)) {
      if (id !== requestId) return;
      if (host) close();
      return;
    }
    if (id !== requestId) return;

    startTranslation(info, id);
  }

  function startTranslation(info, id) {
    // Старый результат убираем сразу, но пустую карточку для нового запроса не
    // создаём. Она появится только вместе с первым содержательным фрагментом.
    if (host) close({ cancelRequest: false, animate: false });

    // Стриминг: перевод печатается по мере генерации, не дожидаясь всего ответа.
    let port;
    try {
      port = openTranslationPort();
    } catch {
      render(info.rect, { state: "error", message: "Расширение перезагружено — обновите страницу." });
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

    port.onMessage.addListener((message) => {
      if (id !== requestId) return;

      if (message.type === "chunk" || message.type === "done") {
        if (!started && !hasVisibleStreamContent(message.text, info.wordMode)) {
          if (message.type === "done") {
            render(info.rect, {
              state: "error",
              message: "Не удалось получить перевод — попробуйте ещё раз."
            });
            release();
            port.disconnect();
          }
          return;
        }
        if (!started) {
          if (autoPendingId === id) autoPendingId = 0; // карточка показана — больше не отменяем
          beginStreamCard(info.rect, info.text, info.wordMode);
          started = true;
        }
        updateStream(message.text);
        position(lastRect);
        if (message.type === "done") {
          finalizeStream();
          release();
          port.disconnect();
        }
      } else if (message.type === "status") {
        // Например, «Скачиваю языковой пакет… 40%» — пока перевода ещё нет.
        if (!started) render(info.rect, { state: "error", message: message.text, action: null, icon: false });
      } else if (message.type === "error") {
        release();
        port.disconnect();
        if (message.code === "needs-download") {
          // Chrome скачивает языковой пакет только по клику пользователя.
          render(info.rect, {
            state: "error",
            message: `${message.error} Это займёт несколько секунд.`,
            action: {
              label: "Скачать",
              run: async () => {
                render(info.rect, { state: "error", message: "Скачиваю языковой пакет…", action: null });
                try {
                  await builtinEngine.prepare(message.language);
                } catch {
                  render(info.rect, {
                    state: "error",
                    message: "Не удалось скачать языковой пакет — проверьте интернет и попробуйте ещё раз."
                  });
                  return;
                }
                const retryId = ++requestId;
                startTranslation(info, retryId);
              }
            }
          });
          return;
        }
        render(info.rect, { state: "error", message: message.error });
      }
    });

    // Service worker умер посреди ответа — молчать нельзя.
    port.onDisconnect.addListener(() => {
      if (id !== requestId || finished) return;
      release();
      render(info.rect, { state: "error", message: "Соединение прервано — попробуйте ещё раз." });
    });

    port.postMessage({
      type: "start",
      text: info.text,
      context: info.context,
      wordMode: info.wordMode,
      sourceScripts: info.sourceScripts
    });
  }

  const ICONS = {
    close:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    copy:
      '<svg viewBox="0 0 16 16" fill="none"><rect x="5.2" y="5.2" width="8" height="8.6" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M10.8 3.4v-.2a1.8 1.8 0 0 0-1.8-1.8H4.6a1.8 1.8 0 0 0-1.8 1.8V8a1.8 1.8 0 0 0 1.8 1.8h.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M3.2 8.6 6.6 12l6.2-7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M6 4.5 10 8l-4 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pause:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M6 4.2v7.6M10 4.2v7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    warn:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.4 14.5 13a1 1 0 0 1-.86 1.5H2.36A1 1 0 0 1 1.5 13L8 2.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.4v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".9" fill="currentColor"/></svg>'
  };

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;

    host = document.createElement("div");
    host.id = HOST_ID;
    // Стили самого хоста задаём инлайном, чтобы CSS страницы не мог их перебить.
    host.style.cssText =
      "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .card {
          --text: #1d1d1f;
          --sec: #6e6e73;
          --hair: rgba(0, 0, 0, 0.09);
          --fill: rgba(120, 120, 128, 0.10);
          --fill-hover: rgba(120, 120, 128, 0.18);
          --accent: #007aff;
          --warn: #ff9500;
          --ok: #34c759;
          position: fixed;
          width: max-content;
          min-width: 230px;
          max-width: 400px;
          border-radius: 18px;
          border: 1px solid transparent;
          background:
            linear-gradient(rgba(250, 250, 253, 0.80), rgba(250, 250, 253, 0.80)) padding-box,
            linear-gradient(135deg, rgba(100, 210, 255, 0.55), rgba(94, 92, 230, 0.35) 50%, rgba(191, 90, 242, 0.5)) border-box;
          -webkit-backdrop-filter: blur(28px) saturate(1.9);
          backdrop-filter: blur(28px) saturate(1.9);
          box-shadow:
            0 1px 2px rgba(0, 0, 0, 0.06),
            0 12px 44px rgba(0, 0, 0, 0.20),
            0 0 34px rgba(94, 92, 230, 0.16);
          color: var(--text);
          /* Всё внутри задано в em — карточка целиком тянется от этого размера. */
          font: calc(14px * var(--ui-scale, 1)) / 1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          opacity: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .card.in {
          opacity: 1;
          animation: pop 0.34s cubic-bezier(0.21, 1.02, 0.36, 1);
          transition:
            top 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            left 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            font-size 0.09s ease-out;
        }
        .card.out {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        @keyframes pop {
          from { opacity: 0; transform: translateY(8px) scale(0.97); }
          to { opacity: 1; transform: none; }
        }
        @media (prefers-color-scheme: dark) {
          .card {
            --text: #f5f5f7;
            --sec: #98989d;
            --hair: rgba(255, 255, 255, 0.12);
            --fill: rgba(120, 120, 128, 0.24);
            --fill-hover: rgba(120, 120, 128, 0.36);
            --accent: #0a84ff;
            --warn: #ff9f0a;
            --ok: #30d158;
            background:
              linear-gradient(rgba(22, 23, 34, 0.74), rgba(22, 23, 34, 0.74)) padding-box,
              linear-gradient(135deg, rgba(100, 210, 255, 0.5), rgba(94, 92, 230, 0.35) 50%, rgba(191, 90, 242, 0.5)) border-box;
            box-shadow:
              0 1px 2px rgba(0, 0, 0, 0.3),
              0 12px 44px rgba(0, 0, 0, 0.5),
              0 0 38px rgba(94, 92, 230, 0.22);
          }
        }

        .card.reference {
          --accent: #d97706;
          background:
            linear-gradient(rgba(255, 251, 242, 0.88), rgba(255, 251, 242, 0.88)) padding-box,
            linear-gradient(135deg, rgba(255, 159, 10, 0.72), rgba(255, 214, 10, 0.34) 55%, rgba(255, 107, 64, 0.42)) border-box;
          box-shadow:
            0 1px 2px rgba(0, 0, 0, 0.06),
            0 12px 44px rgba(0, 0, 0, 0.2),
            0 0 34px rgba(255, 159, 10, 0.16);
        }
        @media (prefers-color-scheme: dark) {
          .card.reference {
            --accent: #ff9f0a;
            background:
              linear-gradient(rgba(30, 27, 20, 0.82), rgba(30, 27, 20, 0.82)) padding-box,
              linear-gradient(135deg, rgba(255, 159, 10, 0.8), rgba(255, 214, 10, 0.38) 55%, rgba(255, 107, 64, 0.5)) border-box;
            box-shadow:
              0 1px 2px rgba(0, 0, 0, 0.32),
              0 12px 44px rgba(0, 0, 0, 0.5),
              0 0 38px rgba(255, 159, 10, 0.14);
          }
        }

        .hd {
          display: flex;
          align-items: center;
          flex: none;
          padding: 0.79em 0.71em 0 1.14em;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
          font-size: 0.79em;
          font-weight: 600;
          letter-spacing: 0.09em;
          text-transform: uppercase;
          color: var(--sec);
          white-space: nowrap;
        }
        .badge::before {
          content: "";
          width: 0.55em;
          height: 0.55em;
          border-radius: 50%;
          background: linear-gradient(135deg, #64d2ff, #bf5af2);
          box-shadow: 0 0 9px rgba(100, 210, 255, 0.9);
          flex: none;
        }
        .card.reference .badge { color: var(--accent); }
        .card.multilingual .badge { color: var(--accent); }
        .card.reference .badge::before {
          background: linear-gradient(135deg, #ffd60a, #ff7a00);
          box-shadow: 0 0 10px rgba(255, 159, 10, 0.75);
        }
        .sp { flex: 1; }

        .bd {
          flex: 1;
          padding: 0.5em 1.14em 0.93em;
          max-height: var(--bd-max, 340px);
          overflow-y: auto;
          animation: fade 0.22s ease;
        }
        .bd::-webkit-scrollbar { width: 6px; }
        .bd::-webkit-scrollbar-thumb { background: var(--fill-hover); border-radius: 3px; }
        @keyframes fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .tr {
          font-size: 1.04em;
          letter-spacing: -0.01em;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
          cursor: text;
        }
        .card.reference .tr {
          font-size: 1.14em;
          font-weight: 650;
        }

        .term-kind {
          display: inline-flex;
          width: fit-content;
          margin-bottom: 0.5em;
          padding: 0.24em 0.62em;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 14%, transparent);
          color: var(--accent);
          font-size: 0.72em;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        /* display: inline-flex выше перебивает атрибут hidden — без этой строки
           пустой бейджик категории виден в каждой обычной карточке. */
        .term-kind[hidden] { display: none; }
        .reference-note {
          margin-top: 0.3em;
          color: var(--sec);
          font-size: 0.82em;
        }

        .segments {
          display: grid;
          gap: 0.86em;
        }
        .segment + .segment {
          padding-top: 0.79em;
          border-top: 1px solid var(--hair);
        }
        .segment-lang {
          display: inline-flex;
          width: fit-content;
          margin-bottom: 0.36em;
          padding: 0.22em 0.58em;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          color: var(--accent);
          font-size: 0.7em;
          font-weight: 700;
          letter-spacing: 0.055em;
          text-transform: uppercase;
        }
        .segment-lang.kept {
          background: var(--fill);
          color: var(--sec);
        }
        .segment-text {
          font-size: 1em;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
        }

        .alt {
          margin-top: 0.79em;
          padding-top: 0.71em;
          border-top: 1px solid var(--hair);
        }
        .cap {
          font-size: 0.75em;
          font-weight: 600;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--sec);
          margin-bottom: 0.21em;
        }
        .alt-t {
          font-size: 0.89em;
          color: var(--sec);
          overflow-wrap: break-word;
        }

        .src {
          overflow: hidden;
          max-height: 0;
          opacity: 0;
          transition: max-height 0.28s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.22s ease, margin-top 0.28s ease;
        }
        .src.open { opacity: 1; margin-top: 0.64em; }
        .src-t {
          font-size: 0.89em;
          color: var(--sec);
          padding: 0.14em 0 0.14em 0.71em;
          border-left: 2px solid var(--hair);
          white-space: pre-wrap;
          overflow-wrap: break-word;
          max-height: 9.4em;
          overflow-y: auto;
          user-select: text;
          -webkit-user-select: text;
        }

        .acts {
          display: flex;
          align-items: center;
          gap: 0.43em;
          margin-top: 0.79em;
          transition: opacity 0.25s ease;
        }
        .acts.pending { opacity: 0; pointer-events: none; }

        .caret {
          display: inline-block;
          width: 0.14em;
          height: 1.05em;
          margin-left: 0.14em;
          vertical-align: -0.18em;
          border-radius: 1px;
          background: linear-gradient(180deg, #64d2ff, #bf5af2);
          animation: blink 1s steps(2) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2em;
          height: 2em;
          border: none;
          border-radius: 0.57em;
          background: transparent;
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }
        .icon-btn:hover { background: var(--fill); color: var(--text); }
        .icon-btn:active { transform: scale(0.92); }
        .icon-btn svg { width: 1.07em; height: 1.07em; }
        .icon-btn.ok { color: var(--ok); }
        .icon-btn.xs { width: 1.71em; height: 1.71em; border-radius: 0.5em; }
        .icon-btn.xs svg { width: 0.86em; height: 0.86em; }

        .chip {
          display: inline-flex;
          align-items: center;
          gap: 0.21em;
          border: none;
          border-radius: 999px;
          padding: 0.36em 0.79em 0.36em 0.5em;
          font: 600 0.86em/1 -apple-system, BlinkMacSystemFont, sans-serif;
          background: transparent;
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .chip:hover { background: var(--fill); color: var(--text); }
        .chip svg { width: 1em; height: 1em; transition: transform 0.24s cubic-bezier(0.32, 0.72, 0, 1); }
        .chip.open svg { transform: rotate(90deg); }
        .chip.accent { color: var(--accent); padding: 6px 13px; }
        .chip.accent:hover { background: var(--fill); color: var(--accent); }
        .icon-btn.open { background: var(--fill); color: var(--text); }
        .icon-btn[hidden], .auto-menu[hidden], .auto-note[hidden] { display: none; }

        .auto-menu {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 0.29em;
          margin-top: 0.43em;
        }
        .auto-note {
          margin-top: 0.57em;
          color: var(--sec);
          font-size: 0.82em;
          line-height: 1.45;
        }

        .err {
          display: flex;
          gap: 9px;
          align-items: flex-start;
        }
        .err svg { width: 1.14em; height: 1.14em; flex: none; margin-top: 0.14em; color: var(--warn); }
        .err-t { font-size: 0.96em; color: var(--text); overflow-wrap: break-word; }

        /* Уголок для изменения размера — свой, чтобы не тащить системный resize. */
        .grip {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 18px;
          height: 18px;
          cursor: nwse-resize;
          opacity: 0;
          transition: opacity 0.2s ease;
          touch-action: none;
        }
        .card:hover .grip, .grip.active { opacity: 0.55; }
        .grip:hover { opacity: 0.9 !important; }
        .grip::after {
          content: "";
          position: absolute;
          right: 4px;
          bottom: 4px;
          width: 8px;
          height: 8px;
          border-right: 1.5px solid var(--sec);
          border-bottom: 1.5px solid var(--sec);
          border-bottom-right-radius: 3px;
        }

        /* Процент масштаба показываем вместо заголовка, пока крутят колесо. */
        .zoom {
          font-size: 0.79em;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--accent);
          font-variant-numeric: tabular-nums;
        }
      </style>
      <div class="card" role="dialog" aria-label="Перевод">
        <div class="hd">
          <span class="badge">Перевод</span>
          <span class="zoom" hidden></span>
          <span class="sp"></span>
          <button class="icon-btn xs" data-act="close" title="Закрыть (Esc)">${ICONS.close}</button>
        </div>
        <div class="bd"></div>
        <div class="grip" title="Потяните — размер, двойной клик — сброс"></div>
      </div>
    `;
    document.documentElement.appendChild(host);

    card = shadow.querySelector(".card");
    bodyEl = shadow.querySelector(".bd");
    shadow.querySelector("[data-act=close]").addEventListener("click", close);

    applyView();
    setupZoom();
    setupResize();

    document.addEventListener("mousedown", onOutsideClick, true);
    window.addEventListener("scroll", onScroll, { passive: true, capture: true });
    window.addEventListener("resize", close, { passive: true });
  }

  function onOutsideClick(event) {
    if (host && !event.composedPath().includes(host)) close();
  }

  // Прокрутка внутри карточки не должна её закрывать — иначе длинный
  // перевод невозможно домотать до конца.
  function onScroll(event) {
    if (host && event.composedPath?.().includes(host)) return;
    close();
  }

  // Cmd/Ctrl + колесо — масштаб карточки. preventDefault обязателен,
  // иначе браузер зумит всю страницу.
  let scalePositionTimer = null;
  function setupZoom() {
    scaleController.reset();
    card.addEventListener(
      "wheel",
      (event) => {
        if (!event.metaKey && !event.ctrlKey) return;
        event.preventDefault();
        if (!event.deltaY) return;

        // Трекпад отправляет десятки wheel-событий за одно движение. Раньше
        // каждое из них меняло масштаб сразу на 8%, поэтому карточка улетала.
        // Принимаем не чаще одного небольшого шага за интервал.
        const change = scaleController.next(view.uiScale, event.deltaY, performance.now());
        if (!change.changed) return;

        view.uiScale = change.value;
        applyView();
        showZoom();
        saveView();

        // Во время жеста сохраняем верхний левый угол стабильным. После паузы
        // мягко возвращаем карточку к выделению и внутрь границ экрана.
        clearTimeout(scalePositionTimer);
        scalePositionTimer = setTimeout(() => {
          scalePositionTimer = null;
          if (host && lastRect) position(lastRect);
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
        if (lastRect) position(lastRect);
      };

      grip.addEventListener("pointermove", onMove);
      grip.addEventListener("pointerup", onUp);
    });

    // Двойной клик по уголку возвращает размер и масштаб по умолчанию.
    grip.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      view = { ...VIEW_DEFAULTS };
      applyView();
      showZoom();
      saveView();
      if (lastRect) position(lastRect);
    });
  }

  function setCardPresentation(mode) {
    const reference = mode === "reference";
    const multilingual = mode === "multilingual";
    card.classList.toggle("reference", reference);
    card.classList.toggle("multilingual", multilingual);
    card.setAttribute(
      "aria-label",
      reference ? "Объяснение фрагмента" : multilingual ? "Перевод с нескольких языков" : "Перевод"
    );
    const badge = shadow.querySelector(".badge");
    if (badge) badge.textContent = reference ? "Объяснение" : multilingual ? "Несколько языков" : "Перевод";
  }

  function render(rect, payload) {
    ensureHost();
    lastRect = rect;
    setCardPresentation("translation");

    if (payload.state === "error") {
      bodyEl.innerHTML = `
        <div class="err">${payload.icon === false ? "" : ICONS.warn}<p class="err-t"></p></div>
        <div class="acts"><span class="sp"></span><button class="chip accent" data-act="options">Открыть настройки</button></div>`;
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

    // Перезапускаем появление контента.
    bodyEl.style.animation = "none";
    void bodyEl.offsetWidth;
    bodyEl.style.animation = "";

    position(rect);
  }

  // Каркас карточки для стриминга: текст пишется в .live, действия скрыты до конца.
  // wordMode — только для коротких фрагментов: там модель отдаёт перевод первой
  // строкой, а ниже — другие значения или объяснение несловарного фрагмента.
  // У обычного текста переносы строк — это просто абзацы, и разбирать их нельзя.
  function beginStreamCard(rect, source, wordMode) {
    ensureHost();
    lastRect = rect;
    setCardPresentation("translation");
    bodyEl.innerHTML = `
      <div class="term-kind" hidden></div>
      <p class="tr"><span class="live"></span><span class="caret"></span></p>
      <div class="segments" hidden></div>
      <p class="reference-note" hidden>Не переводится как обычное слово</p>
      <div class="alt" hidden><div class="cap">Другие значения</div><p class="alt-t"></p></div>
      <div class="acts pending">
        <span class="sp"></span>
        <button class="icon-btn" data-act="auto" title="Автоперевод" hidden>${ICONS.pause}</button>
        <button class="icon-btn" data-act="copy" title="Скопировать">${ICONS.copy}</button>
      </div>
      <div class="auto-menu" hidden>
        <button class="chip accent" data-act="pause">Пауза на ${PAUSE_MINUTES} минут</button>
        <button class="chip" data-act="off">Выключить автоперевод</button>
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

  // Кнопка «пауза» в карточке: пауза на 5 минут или полное выключение
  // автоперевода. Ручной перевод (правый клик, горячая клавиша) работает всегда.
  function setupAutoControls() {
    const toggle = bodyEl.querySelector("[data-act=auto]");
    const menu = bodyEl.querySelector(".auto-menu");
    const note = bodyEl.querySelector(".auto-note");
    toggle.hidden = !isAutoEnabled();

    const hotkey = /Mac/i.test(navigator.platform) ? "⌘⇧Y" : "Ctrl+Shift+Y";
    const manualHint = `Переводите вручную: правый клик → «Перевести на русский» или ${hotkey}.`;
    const finish = (message) => {
      menu.hidden = true;
      toggle.hidden = true;
      note.textContent = message;
      note.hidden = false;
      if (lastRect) position(lastRect);
    };

    toggle.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      toggle.classList.toggle("open", !menu.hidden);
      if (lastRect) position(lastRect);
    });
    menu.querySelector("[data-act=pause]").addEventListener("click", () => {
      const until = Date.now() + PAUSE_MINUTES * 60 * 1000;
      autoPausedUntil = until;
      chrome.storage.local.set({ autoPausedUntil: until }).catch(() => {});
      const time = new Date(until).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
      finish(`Автоперевод на паузе до ${time}. ${manualHint}`);
    });
    menu.querySelector("[data-act=off]").addEventListener("click", () => {
      autoTranslate = false;
      chrome.storage.local.set({ autoTranslate: false, autoPausedUntil: 0 }).catch(() => {});
      finish(
        `Автоперевод выключен. ${manualHint} ` +
          "Включить снова — в настройках или правым кликом по значку Sensemark."
      );
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
      // [[skip]] — ошибочный ответ модели: background автоматически запросит
      // исправление. Метку пользователю не показываем.
      if (parsed.mode === "skip") return;

      if (parsed.mode === "multilingual") {
        setCardPresentation("multilingual");
        streamState.mainEl.hidden = true;
        streamState.segments.hidden = false;
        renderLanguageSections(streamState, parsed.sections);
        return;
      }

      // Обычный перевод показываем как есть — переносы строк это абзацы.
      setCardPresentation("translation");
      streamState.mainEl.hidden = false;
      streamState.segments.hidden = true;
      streamState.main = parsed.text;
      streamState.copyText = parsed.text;
      streamState.live.textContent = parsed.text;
      streamState.live.after(streamState.caret);
      return;
    }

    const parsed = parseWordResponse(text);
    if (parsed.mode === "pending" || parsed.mode === "skip") return;

    if (parsed.mode === "reference") {
      setCardPresentation("reference");
      streamState.termKind.hidden = false;
      streamState.termKind.textContent = parsed.category || "Неизвестный термин";
      streamState.live.textContent = streamState.source;
      streamState.referenceNote.hidden = false;
      streamState.referenceNote.textContent = /опечат|неизвест/i.test(parsed.category)
        ? "Словарное значение не найдено"
        : `Использовано как ${parsed.category || "имя или название"} — перевод не требуется`;
      streamState.alt.hidden = false;
      streamState.altCap.textContent = parsed.detailLabel || "Что это может быть";
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
    streamState.altCap.textContent = parsed.detailLabel || "Другие значения";
    streamState.altT.textContent = parsed.detail;
  }

  function renderLanguageSections(state, sections) {
    state.segments.textContent = "";
    let lastText = null;

    for (const section of sections) {
      const item = document.createElement("section");
      item.className = "segment";

      const language = document.createElement("div");
      const isRussian = /^русск/i.test(section.language);
      language.className = `segment-lang${isRussian ? " kept" : ""}`;
      language.textContent = isRussian
        ? `${section.language} · без изменений`
        : `${section.language} → русский`;

      const translated = document.createElement("p");
      translated.className = "segment-text";
      translated.textContent = section.text;
      item.append(language, translated);
      state.segments.appendChild(item);
      lastText = translated;
    }

    (lastText || state.segments).appendChild(state.caret);
    const combined = sections.map((section) => section.text).filter(Boolean).join("\n\n");
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

  function position(rect) {
    requestAnimationFrame(() => {
      if (!card) return;
      const box = card.getBoundingClientRect();
      const margin = 10;

      let top = rect.bottom + margin;
      if (top + box.height > window.innerHeight - margin) {
        top = rect.top - box.height - margin; // не влезает снизу — показываем сверху
      }
      top = Math.max(margin, Math.min(top, window.innerHeight - box.height - margin));

      let left = rect.left + rect.width / 2 - box.width / 2;
      left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));

      card.style.top = `${top}px`;
      card.style.left = `${left}px`;
      card.classList.add("in");
    });
  }

  function close({ cancelRequest = true, animate = true } = {}) {
    if (!host) return;
    clearTimeout(scalePositionTimer);
    scalePositionTimer = null;
    if (cancelRequest) {
      requestId++; // отменяем ответ на текущий запрос
      currentPort?.disconnect(); // background оборвёт fetch и не будет жечь токены
      currentPort = null;
    }
    streamState = null;

    document.removeEventListener("mousedown", onOutsideClick, true);
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", close);

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
  }
})();
