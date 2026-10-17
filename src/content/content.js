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
  // Где стоит карточка: anchor — у выделения, margin — на полях справа,
  // drawer — панель у края окна. anchorInfo — выделение, к которому она
  // привязана: при прокрутке карточка едет вместе с текстом.
  let layout = { kind: "anchor" };
  let anchorInfo = null;
  let anchorOffset = null;

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

  // Автоперевод по умолчанию включён; до чтения настроек флаг выше — false,
  // чтобы не перевести лишнего у тех, кто его выключил.
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


  function cancelPendingAuto() {
    clearTimeout(autoTimer);
    autoTimer = null;
    if (autoPendingId && autoPendingId === requestId) {
      requestId++;
      currentPort?.disconnect(); // background оборвёт запрос
      currentPort = null;
      pill.hide();
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
    pill.hide({ animate: false });
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
    pill.schedule(info, id, {
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
        // Например, скачивание языкового пакета — кольцо заполняется по-настоящему.
        if (!started) pill.show(info, id, statusFromMessage(message));
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
                pill.show(info, downloadId, {
                  label: labels.downloading(name),
                  kind: "download",
                  progress: labels.reportsProgress ? 0 : null
                });
                try {
                  await builtinEngine.prepare(message.language, (progress) => {
                    if (downloadId !== requestId) return;
                    pill.show(info, downloadId, {
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
    // Стили самого хоста задаём инлайном, чтобы CSS страницы не мог их перебить.
    // position: absolute — координаты страницы: карточка едет вместе с текстом.
    host.style.cssText =
      "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
    shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `${CARD_STYLE}
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
      pill.place();
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
      pill.place();
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

  // Первое появление: карточка раскрывается из того места, где был кружок.
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
        // Пилюля ещё ждёт ответа — Esc и клик мимо отменяют и её.
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
      requestId++; // отменяем ответ на текущий запрос
      currentPort?.disconnect(); // background оборвёт fetch и не будет жечь токены
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
