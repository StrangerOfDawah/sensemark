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
  const CardTheme = globalThis.SensemarkCardTheme;
  if (
    !parseWordResponse ||
    !parseTextResponse ||
    !isRussianOnly ||
    !detectScripts ||
    !hasMultipleScripts ||
    !detectSignificantScripts ||
    !joinSelectionParts ||
    !createScaleController ||
    !Builtin ||
    !CardTheme
  ) {
    console.error("Sensemark: response helpers are unavailable.");
    return;
  }
  window.__gptTranslateLoaded = true;

  const HOST_ID = "__gpt_translate_popup_host__";
  const STATUS_HOST_ID = "__sensemark_status_host__";
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
  // Где стоит карточка: anchor — у выделения, margin — на полях справа,
  // drawer — панель у края окна. anchorInfo — выделение, к которому она
  // привязана: при прокрутке карточка едет вместе с текстом.
  let layout = { kind: "anchor" };
  let anchorInfo = null;
  let anchorOffset = null;
  let lastStatusPoint = null;

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
  // Оформление: тема (под страницу / светлая / тёмная), шрифт перевода и
  // размер текста как на странице.
  const APPEARANCE_DEFAULTS = { cardTheme: "auto", cardFont: "system", matchPageSize: true };
  let appearance = { ...APPEARANCE_DEFAULTS };
  // Chrome — встроенный Translator API; Safari — переводчик Apple через
  // приложение Sensemark (см. builtin-translator.js → platformDeps).
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

  const STORED_DEFAULTS = {
    autoTranslate: false,
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

    // На полях и в панели ширину задаёт место на экране, а не сохранённый размер.
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
      hideStatus();
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
    const anchor = { range: range.cloneRange(), page: samplePage(range) };

    // OCR не запускаем автоматически: это дорого и ненадёжно для декоративных
    // шрифтов. Изображение без иностранного текстового слоя объясняем локально,
    // не отправляя пустые данные и русские подписи в API.
    const imageTextUnsupported =
      selectedImages.length > 0 && (text.length < 2 || isRussianOnly(text));
    if (imageTextUnsupported) {
      return { ...anchor, text: "", rect, context: null, wordMode: false, sourceScripts: [], imageTextUnsupported };
    }
    if (text.length < 2) return null;

    // Для коротких фрагментов подтягиваем предложение вокруг — без него
    // многозначные слова переводятся наугад.
    const wordMode = isShort(text) && !hasMultipleScripts(text);
    const context = wordMode && text === rawText ? extractContext(range, text) : null;

    return { ...anchor, text, rect, context, wordMode, sourceScripts: detectSignificantScripts(text) };
  }

  // Цвет фона и текста там, где человек читает, — по ним карточка
  // подстраивается под страницу. Прозрачные слои пропускаем до первого фона.
  function samplePage(range) {
    const node = range.startContainer;
    const start = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) || document.body;
    let background = null;
    for (let element = start; element; element = element.parentElement) {
      const color = CardTheme.parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a >= 0.5) {
        background = color;
        break;
      }
    }
    if (!background) {
      // У страницы нет своего фона: Chrome рисует белый, а тёмный — только
      // если сайт сам объявил тёмную схему.
      const scheme = getComputedStyle(document.documentElement).colorScheme || "";
      const dark = /dark/.test(scheme) && !/light/.test(scheme);
      background = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    }
    const style = getComputedStyle(start);
    return { background, text: CardTheme.parseColor(style.color), fontSize: style.fontSize };
  }

  // Палитра, шрифт и размер для карточки и пилюли этого выделения.
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

  // Шрифты Golos Text и Literata лежат в расширении; на страницу добавляются
  // один раз и только если их выбрали в настройках.
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

  // Русский ли это текст и с какого языка переводим — для подписи
  // «Перевожу с английского…». Определяет сам Chrome, локально и бесплатно.
  // На одном слове определитель часто ошибается («bank» → себуано), поэтому
  // язык для подписи берём по предложению вокруг, а ненадёжный ответ не
  // показываем вовсе — лучше просто «Перевод», чем неверный язык.
  async function detectSource(text, labelText = text) {
    const detection = await detectLanguageSafe(text);
    const labelDetection = labelText === text ? detection : await detectLanguageSafe(labelText);
    const top = labelDetection?.languages?.[0];
    const code = Builtin.normalizeLanguage(top?.language);
    // isReliable у Chrome бывает false даже на верном ответе для короткого
    // предложения, поэтому от 20 символов верим и «ненадёжному» ответу.
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
      return null; // локальный CLD может не дать результат для очень короткого текста
    }
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
      render(info, {
        state: "error",
        message:
          "Выделенный фрагмент нарисован как изображение, а не как текст. " +
          "Sensemark не отправил его в API, чтобы не тратить токены. " +
          "Выделите доступную текстовую подпись или перевод."
      });
      return;
    }

    if (info.text.length > MAX_CHARS) {
      render(info, {
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
    const source = await detectSource(info.text, info.context || info.text);
    if (source.ignore) {
      if (id !== requestId) return;
      close();
      return;
    }
    if (id !== requestId) return;
    // Смешанный текст получает свою подпись «Несколько языков».
    info.language = info.sourceScripts.length > 1 ? "" : source.language;

    startTranslation(info, id);
  }

  function startTranslation(info, id) {
    // Старый результат убираем сразу, но пустую карточку для нового запроса не
    // создаём. Она появится только вместе с первым содержательным фрагментом,
    // а пока ждём — только маленькая пилюля «Перевожу с английского…».
    if (host) close({ cancelRequest: false, animate: false });
    hideStatus({ animate: false });
    prepareCardFor(info);

    // Стриминг: перевод печатается по мере генерации, не дожидаясь всего ответа.
    let port;
    try {
      port = openTranslationPort();
    } catch {
      render(info, { state: "error", message: "Расширение перезагружено — обновите страницу." });
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
    // Бесплатный режим отвечает за ~30 мс — тогда пилюля не мелькает зря.
    scheduleStatus(info, id, {
      label: info.language ? `Перевожу с ${info.language}…` : "Перевожу…"
    });

    port.onMessage.addListener((message) => {
      if (id !== requestId) return;

      if (message.type === "chunk" || message.type === "done") {
        if (!started && !hasVisibleStreamContent(message.text, info.wordMode)) {
          if (message.type === "done") {
            render(info, {
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
          hideStatus();
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
        // Например, скачивание языкового пакета — кольцо заполняется по-настоящему.
        if (!started) showStatus(info, id, statusFromMessage(message));
      } else if (message.type === "error") {
        release();
        port.disconnect();
        if (message.code === "needs-download") {
          // Chrome скачивает языковой пакет только по клику пользователя.
          render(info, {
            state: "error",
            message: `${message.error} Это займёт несколько секунд.`,
            action: {
              label: "Скачать",
              run: async () => {
                const downloadId = ++requestId;
                close({ cancelRequest: false, animate: false });
                const name = Builtin.languageName(message.language);
                // Chrome сообщает настоящий процент; переводчик Apple скачивает
                // язык в приложении Sensemark — там кольцо просто крутится.
                const labels = builtinEngine.labels;
                showStatus(info, downloadId, {
                  label: labels.downloading(name),
                  kind: "download",
                  progress: labels.reportsProgress ? 0 : null
                });
                try {
                  await builtinEngine.prepare(message.language, (progress) => {
                    if (downloadId !== requestId) return;
                    showStatus(info, downloadId, {
                      label: `Скачиваю ${name} · ${Math.round(progress * 100)}%`,
                      kind: "download",
                      progress
                    });
                  });
                } catch {
                  if (downloadId !== requestId) return;
                  render(info, {
                    state: "error",
                    message: "Не удалось скачать языковой пакет — проверьте интернет и попробуйте ещё раз."
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

    // Service worker умер посреди ответа — молчать нельзя.
    port.onDisconnect.addListener(() => {
      if (id !== requestId || finished) return;
      release();
      render(info, { state: "error", message: "Соединение прервано — попробуйте ещё раз." });
    });

    port.postMessage({
      type: "start",
      text: info.text,
      context: info.context,
      wordMode: info.wordMode,
      sourceScripts: info.sourceScripts
    });
  }

  // Оформление и место карточки решаются до ответа, чтобы пилюля стояла
  // там же, где потом раскроется карточка, и была того же цвета.
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
      label: progress === null ? `Скачиваю ${name}…` : `Скачиваю ${name} · ${Math.round(progress * 100)}%`,
      kind: "download",
      progress,
      hint: message.text
    };
  }

  // ---------- пилюля статуса → кружок ----------
  // Пока перевода нет, у выделения видна небольшая пилюля, через секунду она
  // сжимается в кружок, а дуга продолжает бежать. Она отдельно от карточки:
  // пустую карточку до первого фрагмента перевода мы не показываем.
  const STATUS_DELAY = 200;
  const COLLAPSE_AFTER = { translate: 1200, info: 4000, download: 3000 };
  let statusHost = null;
  let statusEl = null;
  let statusInfo = null;
  let statusTimer = null;
  let collapseTimer = null;

  function scheduleStatus(info, id, status) {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusTimer = null;
      if (id === requestId && !card) showStatus(info, id, status);
    }, STATUS_DELAY);
  }

  function showStatus(info, id, { label, kind = "translate", progress = null, hint = "" }) {
    if (id !== requestId) return;
    clearTimeout(statusTimer);
    statusTimer = null;
    const fresh = !statusEl;
    if (fresh) {
      statusHost = document.createElement("div");
      statusHost.id = STATUS_HOST_ID;
      statusHost.style.cssText = "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
      const root = statusHost.attachShadow({ mode: "open" });
      root.innerHTML = `${STATUS_STYLE}
        <div class="status" role="status" aria-live="polite">
          <svg class="ring" viewBox="0 0 20 20" aria-hidden="true">
            <circle class="track" cx="10" cy="10" r="7.5"/>
            <circle class="arc" cx="10" cy="10" r="7.5" pathLength="100"/>
          </svg>
          <span class="lbl"></span>
        </div>`;
      document.documentElement.appendChild(statusHost);
      statusEl = root.querySelector(".status");
    }
    statusInfo = info;
    applyLook(statusHost, info.look);
    statusEl.dataset.scheme = info.look?.scheme || "light";
    statusEl.classList.toggle("drawer", info.layout?.kind === "drawer");

    const labelEl = statusEl.querySelector(".lbl");
    const changedKind = statusEl.dataset.kind !== kind;
    labelEl.textContent = label;
    statusEl.title = hint || label;
    statusEl.setAttribute("aria-label", label);
    statusEl.dataset.kind = kind;
    const determinate = typeof progress === "number";
    statusEl.classList.toggle("determinate", determinate);
    if (determinate) statusEl.style.setProperty("--progress", String(Math.round(progress * 100)));

    if (fresh || changedKind) {
      statusEl.classList.remove("mini");
      clearTimeout(collapseTimer);
      collapseTimer = setTimeout(() => statusEl?.classList.add("mini"), COLLAPSE_AFTER[kind] || 1200);
    }
    placeStatus();
    if (fresh) requestAnimationFrame(() => statusEl?.classList.add("in"));
  }

  function placeStatus() {
    if (!statusEl || !statusInfo) return;
    const rect = liveRect(statusInfo);
    const kind = statusInfo.layout?.kind || "anchor";
    if (kind === "drawer") {
      lastStatusPoint = { x: window.innerWidth - 16, y: 16, fixed: true };
      return;
    }
    let x;
    let y;
    if (kind === "margin") {
      x = rect.right + 28;
      y = Math.max(rect.top, Math.min(16, rect.bottom - 28));
    } else {
      x = Math.max(10, Math.min(rect.left, window.innerWidth - 200));
      y = rect.bottom + 8 + 28 > window.innerHeight ? rect.top - 8 - 28 : rect.bottom + 8;
    }
    statusEl.style.left = `${x + window.scrollX}px`;
    statusEl.style.top = `${y + window.scrollY}px`;
    lastStatusPoint = { x, y: y + 14 };
  }

  function hideStatus({ animate = true } = {}) {
    clearTimeout(statusTimer);
    clearTimeout(collapseTimer);
    statusTimer = null;
    collapseTimer = null;
    if (!statusHost) {
      lastStatusPoint = null;
      return;
    }
    const dying = statusHost;
    if (animate && statusEl) {
      statusEl.classList.add("out");
      setTimeout(() => dying.remove(), 160);
    } else {
      dying.remove();
    }
    statusHost = null;
    statusEl = null;
    statusInfo = null;
  }

  const STATUS_STYLE = `
      <style>
        :host { all: initial; }
        .status {
          position: absolute;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          height: 28px;
          padding: 0 12px 0 7px;
          box-sizing: border-box;
          border-radius: 999px;
          background: var(--surface, #fff);
          border: 1px solid var(--border, #e3e3e8);
          box-shadow: var(--shadow, 0 10px 26px rgba(0, 0, 0, 0.12));
          color: var(--sec, #62646f);
          font: 500 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          letter-spacing: -0.003em;
          -webkit-font-smoothing: antialiased;
          white-space: nowrap;
          opacity: 0;
          transform: translateY(3px) scale(0.96);
          transform-origin: 14px 50%;
          transition:
            opacity 0.2s ease,
            transform 0.24s cubic-bezier(0.21, 1.02, 0.36, 1),
            padding 0.38s cubic-bezier(0.32, 0.72, 0, 1),
            gap 0.38s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .status.in { opacity: 1; transform: none; }
        .status.out { opacity: 0; transform: scale(0.9); }
        .status.drawer { position: fixed; top: 16px; right: 16px; }
        .lbl {
          display: inline-block;
          max-width: 280px;
          overflow: hidden;
          transition: max-width 0.38s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.18s ease;
        }
        /* Кружок: подпись уезжает, остаётся кольцо прогресса. */
        .status.mini { gap: 0; padding: 0 6px; }
        .status.mini .lbl { max-width: 0; opacity: 0; }
        .ring { width: 14px; height: 14px; flex: none; animation: spin 0.9s linear infinite; }
        .ring circle { fill: none; stroke-width: 2.4; }
        .track { stroke: var(--track, #e6e6ef); }
        .arc {
          stroke: var(--accent, #5e5ce6);
          stroke-linecap: round;
          stroke-dasharray: 26 100;
          transform: rotate(-90deg);
          transform-origin: 50% 50%;
          transition: stroke-dasharray 0.3s ease;
        }
        .status.determinate .ring { animation: none; }
        .status.determinate .arc { stroke-dasharray: var(--progress, 0) 100; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .status, .lbl { transition: opacity 0.2s ease; }
          .ring { animation-duration: 2.4s; }
        }
        @media (prefers-contrast: more) {
          .status { border-color: var(--text, #16171c); color: var(--text, #16171c); }
        }
      </style>`;

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
    // position: absolute — координаты страницы: карточка едет вместе с текстом.
    host.style.cssText =
      "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        /* Цвета приходят переменными из card-theme.js (на самом хосте):
           под страницу, светлая или тёмная. Здесь — только запасные значения;
           они стоят на :host, чтобы не перекрывать цвета страницы. */
        :host {
          all: initial;
          --surface: #ffffff;
          --border: #e3e3e8;
          --text: #16171c;
          --sec: #62646f;
          --hair: rgba(22, 23, 28, 0.06);
          --fill: rgba(22, 23, 28, 0.06);
          --fill-hover: rgba(22, 23, 28, 0.11);
          --accent: #5e5ce6;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .card {
          --warn: #ff9500;
          --ok: #34c759;
          --notch-x: 28px;
          position: absolute;
          width: max-content;
          min-width: 240px;
          max-width: 420px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: var(--surface);
          box-shadow: var(--shadow, 0 14px 36px rgba(0, 0, 0, 0.14), 0 2px 4px rgba(0, 0, 0, 0.05));
          color: var(--text);
          /* Всё внутри задано в em — карточка целиком тянется от этого размера. */
          font: calc(14px * var(--ui-scale, 1)) / 1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          opacity: 0;
          display: flex;
          flex-direction: column;
        }
        .card[data-scheme="dark"] { --warn: #ff9f0a; --ok: #30d158; }
        .card.in {
          opacity: 1;
          animation: pop 0.34s cubic-bezier(0.21, 1.02, 0.36, 1);
          transition:
            top 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            left 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            font-size 0.09s ease-out;
        }
        /* При прокрутке карточка следует за текстом без задержки. */
        .card.in.tracking { transition: none; }
        .card.out {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        @keyframes pop {
          from { opacity: 0; transform: scale(0.94); }
          to { opacity: 1; transform: none; }
        }

        /* Носик к выделению. */
        .card.anchor::before {
          content: "";
          position: absolute;
          top: -6px;
          left: var(--notch-x);
          width: 11px;
          height: 11px;
          margin-left: -5.5px;
          transform: rotate(45deg);
          background: var(--surface);
          border-left: 1px solid var(--border);
          border-top: 1px solid var(--border);
          border-radius: 2px 0 0 0;
        }
        .card.anchor.above::before {
          top: auto;
          bottom: -6px;
          border: 0;
          border-right: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          border-radius: 0 0 2px 0;
        }
        .card.anchor.free::before { display: none; }

        /* Заметка на полях справа от длинного выделения. */
        .card.margin { max-width: none; }
        .bracket {
          position: absolute;
          width: 10px;
          border: 2px solid var(--accent, #5e5ce6);
          border-left: 0;
          border-radius: 0 8px 8px 0;
          opacity: 0.5;
          pointer-events: none;
        }
        .bracket[hidden] { display: none; }

        /* Панель у правого края окна, когда справа от текста нет места. */
        .card.drawer {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          max-width: none;
          border-radius: 0;
          border-width: 0 0 0 1px;
        }
        .card.drawer.in { animation: slide 0.32s cubic-bezier(0.21, 1.02, 0.36, 1); }
        @keyframes slide {
          from { opacity: 0; transform: translateX(28px); }
          to { opacity: 1; transform: none; }
        }
        .card.margin .bd, .card.drawer .bd { min-height: 0; }
        .card.drawer .hd { padding-top: 1.1em; padding-bottom: 0.6em; border-bottom: 1px solid var(--hair); }
        .card.drawer .bd { padding-top: 1em; display: flex; flex-direction: column; }
        .card.margin .acts, .card.drawer .acts {
          position: sticky;
          bottom: -0.93em;
          margin: 0.79em -1.14em -0.93em;
          padding: 0.5em 1.14em 0.7em;
          background: var(--surface);
          border-top: 1px solid var(--hair);
        }
        /* В панели кнопки прижаты к низу окна. */
        .card.drawer .acts { margin-top: auto; }
        .card.margin .grip, .card.drawer .grip { display: none; }

        .card.reference { --accent: #c56a00; border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
        .card.reference[data-scheme="dark"] { --accent: #ff9f0a; }

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
          font-size: 0.86em;
          font-weight: 600;
          color: var(--sec);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .badge::before {
          content: "";
          width: 0.5em;
          height: 0.5em;
          border-radius: 50%;
          background: linear-gradient(135deg, #64d2ff, #8f5bff);
          flex: none;
        }
        .card.reference .badge { color: var(--accent); }
        .card.multilingual .badge { color: var(--accent); }
        .card.reference .badge::before { background: linear-gradient(135deg, #ffd60a, #ff7a00); }
        .sp { flex: 1; }

        .bd {
          flex: 1;
          padding: 0.43em 1.14em 0.93em;
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
          font-family: var(--tr-font, inherit);
          font-size: calc(var(--tr-size, 15px) * var(--ui-scale, 1));
          line-height: 1.55;
          letter-spacing: -0.003em;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
          cursor: text;
        }
        .card.reference .tr {
          font-size: calc(var(--tr-size, 15px) * 1.08 * var(--ui-scale, 1));
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
          font-family: var(--tr-font, inherit);
          font-size: calc(var(--tr-size, 15px) * var(--ui-scale, 1));
          line-height: 1.55;
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
          font-family: var(--tr-font, inherit);
          font-size: 0.93em;
          color: var(--sec);
          overflow-wrap: break-word;
        }

        .acts {
          display: flex;
          align-items: center;
          gap: 0.29em;
          margin-top: 0.64em;
          transition: opacity 0.25s ease;
        }
        .acts.pending { opacity: 0; pointer-events: none; }

        .caret {
          display: inline-block;
          width: 2px;
          height: 1.05em;
          margin-left: 1px;
          vertical-align: -0.18em;
          border-radius: 1px;
          background: var(--accent);
          animation: blink 1s steps(2) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2.14em;
          height: 2.14em;
          border: none;
          border-radius: 0.57em;
          background: var(--fill);
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }
        .icon-btn:hover { background: var(--fill-hover); color: var(--text); }
        .icon-btn:active { transform: scale(0.92); }
        .icon-btn svg { width: 1em; height: 1em; }
        .icon-btn.ok { color: var(--ok); }
        .icon-btn.xs { width: 1.86em; height: 1.86em; border-radius: 0.5em; background: transparent; }
        .icon-btn.xs:hover { background: var(--fill); }
        .icon-btn.xs svg { width: 0.86em; height: 0.86em; }

        .chip {
          display: inline-flex;
          align-items: center;
          gap: 0.21em;
          border: none;
          border-radius: 999px;
          padding: 0.43em 0.86em;
          font: 600 0.86em/1 -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--fill);
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .chip:hover { background: var(--fill-hover); color: var(--text); }
        .chip.accent { color: var(--accent); }
        .chip.accent:hover { color: var(--accent); }
        .icon-btn.open { background: var(--fill-hover); color: var(--text); }
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
          right: 5px;
          bottom: 5px;
          width: 7px;
          height: 7px;
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

        @media (prefers-reduced-motion: reduce) {
          .card.in, .card.drawer.in, .bd { animation: none; }
          .card.in { transition: none; }
          .caret { animation: none; }
        }
        @media (prefers-contrast: more) {
          .card { border-color: var(--text); }
          .badge, .cap, .reference-note, .auto-note { color: var(--text); }
        }
      </style>
      <div class="bracket" hidden></div>
      <div class="card anchor" role="dialog" aria-label="Перевод">
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

  // Прокрутка больше не закрывает карточку: она привязана к тексту и едет
  // вместе с ним, в том числе внутри прокручиваемых блоков страницы.
  window.addEventListener(
    "scroll",
    (event) => {
      if (host && event.composedPath?.().includes(host)) return; // прокрутка внутри карточки
      if (card) placeNow({ decide: false });
      if (statusEl) placeStatus();
    },
    { passive: true, capture: true }
  );
  window.addEventListener(
    "resize",
    () => {
      if (card && anchorInfo) {
        setLayout(
          CardTheme.chooseLayout({ text: anchorInfo.text, rect: liveRect(anchorInfo), viewportWidth: window.innerWidth })
        );
        place();
      }
      if (statusEl) placeStatus();
    },
    { passive: true }
  );

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

    // Двойной клик по уголку возвращает размер и масштаб по умолчанию.
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
      reference ? "Объяснение фрагмента" : multilingual ? "Перевод с нескольких языков" : "Перевод"
    );
    const badge = shadow.querySelector(".badge");
    if (badge) {
      badge.textContent = reference
        ? "Объяснение"
        : multilingual
          ? "Несколько языков"
          : CardTheme.headerLabel({
              language: anchorInfo?.language || "",
              paragraphs: anchorInfo?.paragraphs || 1,
              long: layout.kind !== "anchor"
            });
    }
  }

  // Карточка привязывается к выделению, берёт его оформление и место.
  function attachCard(info, cardLayout) {
    ensureHost();
    hideStatus({ animate: false });
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

  // Ошибки и подсказки короткие — всегда карточкой у выделения.
  function render(info, payload) {
    attachCard(info, { kind: "anchor" });
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

    place();
  }

  // Каркас карточки для стриминга: текст пишется в .live, действия скрыты до конца.
  // wordMode — только для коротких фрагментов: там модель отдаёт перевод первой
  // строкой, а ниже — другие значения или объяснение несловарного фрагмента.
  // У обычного текста переносы строк — это просто абзацы, и разбирать их нельзя.
  function beginStreamCard(info) {
    const source = info.text;
    const wordMode = info.wordMode;
    attachCard(info, info.layout);
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
      // В длинном переводе (поля, панель) абзацы разделяем пустой строкой,
      // иначе они сливаются в сплошной текст. Копируется перевод как есть.
      streamState.live.textContent = layout.kind === "anchor" ? parsed.text : parsed.text.replace(/\n+/g, "\n\n");
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

  // Текущее место выделения на экране. Range живой: после прокрутки или
  // перестройки страницы он даёт новые координаты.
  function liveRect(info) {
    try {
      const rect = info?.range?.getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    } catch {
      // Узлы выделения убраны со страницы — остаёмся на последнем месте.
    }
    return info?.rect || lastRect;
  }

  function place() {
    requestAnimationFrame(() => placeNow({ decide: true }));
  }

  // decide — заново выбрать сторону (снизу/сверху) и сдвиг. При прокрутке
  // сторона не меняется, карточка просто едет вместе с текстом.
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
      const box = card.getBoundingClientRect();
      // Пока выделение на экране, заметка держится рядом с ним, но не уходит
      // ниже его конца.
      const top = Math.max(rect.top, Math.min(16, rect.bottom - box.height));
      const left = rect.right + 28;
      card.style.left = `${left + sx}px`;
      card.style.top = `${top + sy}px`;
      bracket.style.left = `${rect.right + 10 + sx}px`;
      bracket.style.top = `${rect.top + sy}px`;
      bracket.style.height = `${Math.max(16, rect.height)}px`;
      reveal({ left, top });
      return;
    }

    const box = card.getBoundingClientRect();
    if (decide || !anchorOffset) {
      const gap = 12;
      const margin = 10;
      let top;
      let side;
      if (rect.bottom + gap + box.height <= vh - margin) {
        side = "below";
        top = rect.bottom + gap;
      } else if (rect.top - gap - box.height >= margin) {
        side = "above";
        top = rect.top - gap - box.height;
      } else {
        side = "free"; // не влезает ни снизу, ни сверху — внутри экрана, без носика
        top = Math.max(margin, Math.min(rect.bottom + gap, vh - box.height - margin));
      }
      const wide = rect.width > box.width;
      const pointX = wide ? rect.left + 28 : rect.left + rect.width / 2;
      let left = wide ? rect.left - 6 : pointX - box.width / 2;
      left = Math.max(margin, Math.min(left, vw - box.width - margin));
      card.classList.toggle("above", side === "above");
      card.classList.toggle("free", side === "free");
      card.style.setProperty("--notch-x", `${Math.max(18, Math.min(pointX - left, box.width - 18))}px`);
      anchorOffset = { x: left - rect.left, y: side === "above" ? top + box.height - rect.top : top - rect.bottom, side };
    }
    const left = rect.left + anchorOffset.x;
    const top =
      anchorOffset.side === "above" ? rect.top + anchorOffset.y - box.height : rect.bottom + anchorOffset.y;
    card.style.left = `${left + sx}px`;
    card.style.top = `${top + sy}px`;
    reveal({ left, top });
  }

  // Первое появление: карточка раскрывается из того места, где был кружок.
  function reveal(point) {
    if (card.classList.contains("in")) return;
    if (point && lastStatusPoint && !lastStatusPoint.fixed) {
      card.style.transformOrigin = `${lastStatusPoint.x - point.left}px ${lastStatusPoint.y - point.top}px`;
    }
    lastStatusPoint = null;
    card.classList.add("in");
  }

  function close({ cancelRequest = true, animate = true } = {}) {
    if (!host) {
      if (cancelRequest) {
        // Пилюля ещё ждёт ответа — Esc и клик мимо отменяют и её.
        if (statusHost) {
          requestId++;
          currentPort?.disconnect();
          currentPort = null;
        }
        hideStatus({ animate });
      }
      return;
    }
    clearTimeout(scalePositionTimer);
    scalePositionTimer = null;
    if (cancelRequest) {
      requestId++; // отменяем ответ на текущий запрос
      currentPort?.disconnect(); // background оборвёт fetch и не будет жечь токены
      currentPort = null;
    }
    streamState = null;

    document.removeEventListener("mousedown", onOutsideClick, true);
    if (cancelRequest) hideStatus({ animate: false });

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
