const MENU_ID = "translate-selection";
const AUTO_MENU_ID = "toggle-auto-translate";
const API_URL = "https://api.openai.com/v1/chat/completions";
const PRIVACY_CONSENT_VERSION = 1;

// Самая дешёвая актуальная модель OpenAI (октябрь 2026): $0.10 / $0.50 за 1M токенов.
const DEFAULT_MODEL = "gpt-6-luna";
// Модели, которые OpenAI отключает до января 2027 — переводим на DEFAULT_MODEL.
const RETIRED_MODELS = new Set([
  "gpt-4o-mini",
  "gpt-4o",
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-4.1-nano",
  "gpt-5-nano",
  "gpt-5-mini"
]);

const DEFAULTS = {
  apiKey: "",
  model: DEFAULT_MODEL,
  targetLang: "русский",
  autoTranslate: false,
  privacyConsentVersion: 0
};

// Кэш повторных переводов, чтобы тот же кусок не стоил денег дважды.
// Service worker Chrome засыпает через ~30 с простоя и теряет память, поэтому
// копия лежит в chrome.storage.session: она живёт до закрытия браузера и
// никогда не пишется на диск.
const cache = new Map();
const CACHE_LIMIT = 200;
const CACHE_STORAGE_KEY = "translationCache";
let cacheLoaded = null;

function loadCache() {
  if (!cacheLoaded) {
    cacheLoaded = (async () => {
      try {
        const stored = await chrome.storage.session?.get(CACHE_STORAGE_KEY);
        for (const [key, value] of stored?.[CACHE_STORAGE_KEY] || []) {
          if (!cache.has(key)) cache.set(key, value);
        }
      } catch {
        // Без session storage работаем только с памятью.
      }
    })();
  }
  return cacheLoaded;
}

async function cacheGet(key) {
  await loadCache();
  return cache.get(key);
}

function cacheSet(key, value) {
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
  chrome.storage.session
    ?.set({ [CACHE_STORAGE_KEY]: [...cache] })
    .catch(() => {});
}

// Параметры запроса под модель. Новые модели OpenAI «размышляют» перед
// ответом: это медленнее и оплачивается как выходные токены, а temperature
// они отклоняют. Для перевода размышления не нужны.
function modelParams(model, maxOutputTokens) {
  const name = String(model || "");
  if (/^(?:gpt-6|gpt-5\.\d)/.test(name)) {
    return { reasoning_effort: "none", max_completion_tokens: maxOutputTokens };
  }
  if (/^gpt-5(?:-|$)/.test(name)) {
    return { reasoning_effort: "minimal", max_completion_tokens: maxOutputTokens };
  }
  if (/^o\d/.test(name)) {
    return { reasoning_effort: "low", max_completion_tokens: maxOutputTokens };
  }
  return { temperature: 0.2, max_tokens: maxOutputTokens };
}

// Потолок длины ответа: перевод не бывает намного длиннее оригинала, а
// случайно «разговорившаяся» модель не должна стоить лишних денег.
function maxOutputTokens(text, wordMode) {
  if (wordMode) return 300;
  return Math.min(4096, 300 + Math.ceil(String(text || "").length * 0.8));
}

function requestBody(settings, messages, { text, wordMode, stream }) {
  return JSON.stringify({
    model: settings.model,
    ...modelParams(settings.model, maxOutputTokens(text, wordMode)),
    ...(stream ? { stream: true } : {}),
    messages
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Перевести на русский",
      contexts: ["selection"]
    });
    // Правый клик по значку Sensemark в панели Chrome. Safari такого меню
    // у значка не поддерживает — там автоперевод включается в настройках.
    try {
      chrome.contextMenus.create(
        { id: AUTO_MENU_ID, title: "Включить автоперевод", contexts: ["action"] },
        () => void chrome.runtime.lastError
      );
      refreshAutoMenuTitle();
    } catch {
      // Контекст "action" недоступен в этом браузере.
    }
  });

  // Режим перевода: у тех, кто уже ввёл ключ OpenAI, ничего не меняется;
  // остальные начинают с бесплатного встроенного переводчика Chrome.
  chrome.storage.local.get({ provider: "", apiKey: "", privacyConsentVersion: 0 }).then((settings) => {
    const provider = settings.provider || (settings.apiKey ? "openai" : "builtin");
    if (!settings.provider) chrome.storage.local.set({ provider });

    // При установке показываем выбор режима. При обновлении настройки
    // открываются, только если режиму OpenAI не хватает согласия.
    if (details.reason === "install") {
      chrome.runtime.openOptionsPage();
    } else if (
      details.reason === "update" &&
      provider === "openai" &&
      settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION
    ) {
      chrome.runtime.openOptionsPage();
    }
  });
});

chrome.contextMenus.onClicked.addListener(onMenuClicked);

async function onMenuClicked(info, tab) {
  if (info.menuItemId === AUTO_MENU_ID) {
    const { autoTranslate, autoPausedUntil } = await chrome.storage.local.get({
      autoTranslate: false,
      autoPausedUntil: 0
    });
    const paused = autoTranslate && Date.now() < autoPausedUntil;
    // На паузе пункт снимает паузу, иначе — переключает автоперевод.
    await chrome.storage.local.set(
      paused ? { autoPausedUntil: 0 } : { autoTranslate: !autoTranslate, autoPausedUntil: 0 }
    );
    return;
  }
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  await ping(tab.id, info.frameId);
}

// Заголовок пункта на значке отражает текущее состояние автоперевода.
async function refreshAutoMenuTitle() {
  const { autoTranslate, autoPausedUntil } = await chrome.storage.local.get({
    autoTranslate: false,
    autoPausedUntil: 0
  });
  const title = !autoTranslate
    ? "Включить автоперевод"
    : Date.now() < autoPausedUntil
      ? "Снять паузу автоперевода"
      : "Выключить автоперевод";
  chrome.contextMenus.update(AUTO_MENU_ID, { title }, () => void chrome.runtime.lastError);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.autoTranslate || changes.autoPausedUntil)) {
    refreshAutoMenuTitle();
  }
});

// Пауза кончается сама — обновляем заголовок, когда меню открывают.
chrome.runtime.onStartup?.addListener(refreshAutoMenuTitle);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== MENU_ID || !tab?.id) return;
  // Без frameId сообщение уходит во все фреймы — ответит тот, где есть выделение.
  ping(tab.id);
});

// На вкладках, открытых до установки расширения, content script ещё не внедрён.
// Пробуем достучаться, а при неудаче внедряем его и повторяем.
async function ping(tabId, frameId) {
  const options = frameId === undefined ? {} : { frameId };
  const message = { type: "translate-selection" };

  try {
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target:
          frameId === undefined
            ? { tabId, allFrames: true }
            : { tabId, frameIds: [frameId] },
        files: [
          "language-detection.js",
          "selection-text.js",
          "word-response.js",
          "text-response.js",
          "ui-scale.js",
          "builtin-translator.js",
          "card-theme.js",
          "content.js"
        ]
      });
      await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      // Служебные страницы (chrome://, Web Store) скриптам недоступны — молчим.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    translate(message.text, message.context, message.wordMode)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // держим канал открытым для асинхронного ответа
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }

  // Safari: перевод и определение языка системой Apple через приложение
  // Sensemark (SafariWebExtensionHandler.swift). В Chrome нативной части нет.
  if (message?.type === "native") {
    const runtime = globalThis.browser?.runtime || chrome.runtime;
    if (typeof runtime.sendNativeMessage !== "function") {
      sendResponse({ ok: false, code: "unavailable" });
      return;
    }
    Promise.resolve()
      .then(() => runtime.sendNativeMessage("application.id", message.payload))
      .then((reply) => sendResponse(reply || { ok: false, code: "failed" }))
      .catch((error) => sendResponse({ ok: false, code: "failed", error: String(error?.message || error) }));
    return true;
  }

  if (message?.type === "get-font") {
    loadFont(message.font)
      .then((faces) => sendResponse({ ok: true, faces }))
      .catch(() => sendResponse({ ok: false, faces: [] }));
    return true;
  }
});

// Шрифты перевода вшиты в расширение (лицензия OFL, папка fonts/). Страница
// не может сама прочитать файлы расширения, поэтому content script получает
// их отсюда — без web_accessible_resources, по которым сайт мог бы узнать о
// расширении, и без загрузки из интернета.
const FONT_FILES = {
  golos: ["golos-text-latin-400.woff2", "golos-text-cyrillic-400.woff2"],
  literata: ["literata-latin-400.woff2", "literata-cyrillic-400.woff2"]
};
const FONT_RANGES = {
  latin:
    "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, " +
    "U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
  cyrillic: "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116"
};

async function loadFont(font) {
  const files = FONT_FILES[font];
  if (!files) return [];
  return Promise.all(
    files.map(async (file) => {
      const response = await fetch(chrome.runtime.getURL(`fonts/${file}`));
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return {
        data: btoa(binary),
        unicodeRange: file.includes("cyrillic") ? FONT_RANGES.cyrillic : FONT_RANGES.latin
      };
    })
  );
}

// Разовый перевод без стриминга — используется кнопкой «Проверить ключ».
async function translate(rawText, context, wordMode = false) {
  const { settings, cacheKey, messages } = await prepareRequest(rawText, context, wordMode);

  const hit = await cacheGet(cacheKey);
  if (hit) return hit;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: requestBody(settings, messages, { text: rawText, wordMode })
  });

  if (!response.ok) {
    throw new Error(await describeError(response));
  }

  const data = await response.json();
  const result = data?.choices?.[0]?.message?.content?.trim();
  if (!result) throw new Error("Пустой ответ от API.");

  cacheSet(cacheKey, result);
  return result;
}

// Общая подготовка запроса для обоих режимов — обычного и стримингового.
async function prepareRequest(rawText, context, wordMode = false, rawSourceScripts = []) {
  const text = (rawText || "").trim();
  if (!text) throw new Error("Ничего не выделено.");

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.model || RETIRED_MODELS.has(settings.model)) settings.model = DEFAULT_MODEL;
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    throw new Error(
      "Перед переводом подтвердите отправку текста в OpenAI в настройках расширения."
    );
  }
  if (!settings.apiKey) {
    throw new Error("Не задан API-ключ. Откройте настройки расширения.");
  }

  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const requestMode = wordMode ? "word" : "text";
  const scriptKey = sourceScripts.join(",");
  const cacheKey = `${settings.model}|${settings.targetLang}|${requestMode}|${scriptKey}|${context || ""}|${text}`;
  const messages = wordMode
    ? buildWordMessages(text, context, settings.targetLang, sourceScripts)
    : buildTextMessages(text, settings.targetLang, sourceScripts);

  return { settings, cacheKey, messages, sourceScripts };
}

// Стриминг: перевод уходит в content script по мере генерации,
// первые слова видны через долю секунды вместо ожидания всего ответа.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      streamTranslate(
        port,
        message.text,
        message.context,
        message.wordMode,
        message.sourceScripts
      );
    }
  });
});

async function streamTranslate(port, rawText, context, wordMode = false, rawSourceScripts = []) {
  const abort = new AbortController();
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    abort.abort(); // пользователь закрыл карточку — не жжём токены впустую
  });
  const send = (message) => {
    if (disconnected) return;
    try {
      port.postMessage(message);
    } catch {
      disconnected = true;
      abort.abort();
    }
  };

  try {
    const { settings, cacheKey, messages, sourceScripts } = await prepareRequest(
      rawText,
      context,
      wordMode,
      rawSourceScripts
    );

    const hit = await cacheGet(cacheKey);
    if (hit) {
      const cachedIssue = responseIssue(hit, wordMode, sourceScripts, rawText);
      if (!cachedIssue) {
        send({ type: "done", text: hit });
        return;
      }

      const repaired = await repairResponse(
        settings,
        messages,
        hit,
        cachedIssue,
        wordMode,
        sourceScripts,
        rawText,
        abort.signal
      );
      cacheSet(cacheKey, repaired);
      send({ type: "done", text: repaired });
      return;
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: requestBody(settings, messages, { text: rawText, wordMode, stream: true }),
      signal: abort.signal
    });

    if (!response.ok) {
      throw new Error(await describeError(response));
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // хвост неполной строки ждёт следующего чанка

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload)?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            send({ type: "chunk", text: full });
          }
        } catch {
          // повреждённое SSE-событие — пропускаем
        }
      }
    }

    full = full.trim();
    if (!full) throw new Error("Пустой ответ от API.");

    const issue = responseIssue(full, wordMode, sourceScripts, rawText);
    if (issue) {
      full = await repairResponse(
        settings,
        messages,
        full,
        issue,
        wordMode,
        sourceScripts,
        rawText,
        abort.signal
      );
    }

    cacheSet(cacheKey, full);
    send({ type: "done", text: full });
  } catch (error) {
    if (error.name !== "AbortError") {
      send({ type: "error", error: error.message });
    }
  }
}

function normalizeSourceScripts(scripts) {
  if (!Array.isArray(scripts)) return [];
  return [...new Set(scripts.filter((script) => /^[A-Za-z]+$/.test(script)))];
}

// Короткие заголовки часто продублированы на двух языках:
// "Japanese Daycares – 日本の保育園". Для них естественнее один перевод,
// а не две визуально одинаковые секции. Длинные абзацы сюда не попадают.
function isParallelTitleCandidate(text, rawSourceScripts = []) {
  const value = String(text || "").trim();
  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  if (sourceScripts.length !== 2 || !value || value.length > 160) return false;

  let parts = value
    .split(/\s+(?:[-–—|/·•])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length !== 2) {
    const parenthetical = value.match(/^(.+?)\s*[（(]([^()（）]+)[）)]\s*$/u);
    parts = parenthetical ? parenthetical.slice(1).map((part) => part.trim()) : [];
  }

  return (
    parts.length === 2 &&
    parts.every((part) => {
      const letters = [...part].filter((char) => /\p{L}/u.test(char));
      return letters.length >= 2 && letters.length <= 80 && !/[.!?。！？]\s+\p{L}/u.test(part);
    })
  );
}

function responsePayload(value) {
  return String(value || "")
    .split("\n")
    .filter((line) => !/^\s*\[\[.+\]\]\s*$/.test(line))
    .join("\n")
    .trim();
}

function normalizeComparable(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function translatedBodies(value) {
  const sections = [
    ...String(value || "").matchAll(
      /^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:[^\]]+\]\]\s*\n([\s\S]*?)(?=^\[\[(?:script\s*:|lang\s*:)|$)/gim
    )
  ].map((match) => match[1].trim());
  return sections.length ? sections : [responsePayload(value)];
}

const FOREIGN_SCRIPT_LETTER =
  /[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Hebrew}\p{Script=Greek}\p{Script=Devanagari}]/u;

// Проверка нарочно мягкая: каждый повторный запрос удваивает цену перевода.
// Ловим только явно сломанный ответ, а не допустимые оставленные имена,
// бренды и термины («GitHub Copilot», «API», «東京»).
function contentIssue(value) {
  const payload = responsePayload(value);
  if (/full translation into|translate the text|полный перевод на язык|без пояснений и исходного текста/i.test(payload)) {
    return "The answer repeats the instructions instead of a translation.";
  }
  if (/^(?:перевод|translation)\s*:/im.test(payload)) {
    return "The answer contains a «Перевод:» label instead of a clean result.";
  }

  const letters = [...payload].filter((char) => /\p{L}/u.test(char));
  const foreign = letters.filter((char) => FOREIGN_SCRIPT_LETTER.test(char)).length;
  if (letters.length && foreign / letters.length > 0.2) {
    return "The answer is written in the source script instead of Russian.";
  }

  const untranslated = translatedBodies(value).find(
    (body) => !/[А-Яа-яЁё]/u.test(body) && body.split(/\s+/).filter((word) => /\p{L}/u.test(word)).length >= 4
  );
  return untranslated ? "A section is not translated into Russian." : "";
}

function responseIssue(text, wordMode, rawSourceScripts = [], sourceText = "") {
  const value = String(text || "").trim();
  if (/^\[\[skip\]\]/i.test(value)) {
    return "The answer contains the forbidden [[skip]] marker.";
  }

  const firstLine = value.split("\n", 1)[0].trim().toLowerCase();
  if (wordMode) {
    if (firstLine === "[[reference]]") return "";
    if (firstLine !== "[[translation]]") {
      return "The answer must start with [[translation]] or [[reference]].";
    }
    return contentIssue(value);
  }

  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const multilingual = firstLine === "[[multilingual]]";
  const unifiedParallelTitle =
    firstLine === "[[text]]" && isParallelTitleCandidate(sourceText, sourceScripts);
  const declaredScripts = [
    ...value.matchAll(/^\[\[script\s*:\s*([^|\]]+)\s*\|/gim)
  ].map((match) => match[1].trim());
  const unexpectedScripts = declaredScripts.filter((script) => !sourceScripts.includes(script));
  if (unexpectedScripts.length) {
    return `The answer added scripts that are not in the selection: ${[
      ...new Set(unexpectedScripts)
    ].join(", ")}.`;
  }
  if (sourceScripts.length > 1 && !multilingual && !unifiedParallelTitle) {
    return "The selection has several scripts, so the answer must use the [[multilingual]] format.";
  }
  if (sourceScripts.length < 2 && multilingual) {
    const languages = [
      ...value.matchAll(/^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:\s*([^\]]+)\]\]/gim)
    ].map((match) => match[1].trim().toLowerCase());
    if (new Set(languages).size < 2) {
      return "The text is in one language, so [[multilingual]] is wrong.";
    }
  } else if (!multilingual && firstLine !== "[[text]]") {
    return "The answer must start with [[text]].";
  }

  if (multilingual && sourceScripts.length > 1) {
    const missing = sourceScripts.filter((script) => {
      const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const section = value.match(
        new RegExp(
          `\\[\\[script\\s*:\\s*${escaped}\\s*\\|\\s*lang\\s*:[^\\]]+\\]\\]\\s*` +
            "([\\s\\S]*?)(?=\\n\\[\\[script\\s*:|$)",
          "i"
        )
      );
      return !section?.[1]?.trim();
    });
    if (missing.length) {
      return `Sections are missing for scripts: ${missing.join(", ")}.`;
    }
  }

  return contentIssue(value);
}

async function repairResponse(
  settings,
  messages,
  invalidResponse,
  issue,
  wordMode,
  sourceScripts,
  sourceText,
  signal
) {
  const parallelTitle = isParallelTitleCandidate(sourceText, sourceScripts);
  const required = sourceScripts.length > 1 && !parallelTitle
    ? ` Include sections for all scripts: ${sourceScripts.join(", ")}.`
    : "";
  const unifiedOption = parallelTitle
    ? " If the two short parts are one bilingual title, return a single [[text]] translation; otherwise return all [[multilingual]] sections."
    : "";
  const repairMessages = [
    ...messages,
    { role: "assistant", content: invalidResponse },
    {
      role: "user",
      content:
        `Fix the answer: ${issue}${required}${unifiedOption} ` +
        "Write every content line in Russian, do not repeat the original, do not add labels. " +
        "Return the whole answer again in the required format."
    }
  ];

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: requestBody(settings, repairMessages, { text: sourceText, wordMode }),
    signal
  });

  if (!response.ok) throw new Error(await describeError(response));
  const data = await response.json();
  const repaired = data?.choices?.[0]?.message?.content?.trim();
  if (!repaired) throw new Error("Пустой ответ при исправлении перевода.");

  const remainingIssue = responseIssue(repaired, wordMode, sourceScripts, sourceText);
  if (remainingIssue) {
    throw new Error("Не удалось получить полный перевод всех выделенных языков — попробуйте ещё раз.");
  }
  return repaired;
}

// Инструкции написаны по-английски: тот же смысл стоит примерно вдвое меньше
// токенов, чем по-русски, а платим мы за них в каждом запросе. Ответ модели
// по-прежнему русский.
const COMMON_RULES =
  "Translate directly from the source language into Russian; do not go through English and do not paraphrase. " +
  "Skip leftover page UI (menu items, buttons, counters, labels like “Share” or “Read more”) without mentioning it. " +
  "Never output [[skip]], the untranslated original, a third language, these instructions, or labels like “Перевод:”.";

function buildTextMessages(text, lang, rawSourceScripts = []) {
  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const scriptList = sourceScripts.join(", ");
  const sections =
    "[[multilingual]] on the first line, then for each consecutive fragment a line [[script:SCRIPT|lang:LANGUAGE]] " +
    "followed by its Russian translation (Russian fragments verbatim). " +
    `SCRIPT is one of: ${scriptList} — it names the source script, never write the result in it. ` +
    "LANGUAGE is the source language name in Russian.";
  const format = isParallelTitleCandidate(text, sourceScripts)
    ? "The text looks like one short title written in two scripts. If both parts mean the same, answer [[text]] " +
      `on the first line and one Russian translation below. Otherwise answer ${sections}`
    : sourceScripts.length > 1
      ? `The selection contains these scripts: ${scriptList}. Answer ${sections} ` +
        "Every listed script needs at least one non-empty section."
      : "Answer [[text]] on the first line and the Russian translation below. Only if the text truly mixes " +
        "several languages of one script, answer [[multilingual]] on the first line, then for each language a line " +
        "[[script:SCRIPT|lang:LANGUAGE]] and its Russian translation.";

  return [
    {
      role: "system",
      content:
        "You translate the user's text into Russian. Detect the language of each sentence yourself; never assume English. " +
        "Keep parts already in Russian verbatim. Preserve order, paragraphs, line breaks, names and technical terms.\n" +
        `${COMMON_RULES}\n${format}`
    },
    { role: "user", content: text }
  ];
}

// Короткий фрагмент переводим с оглядкой на предложение: у слова значений много,
// а нужно то единственное, в котором оно употреблено здесь.
function buildWordMessages(text, context, lang, rawSourceScripts = []) {
  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const scriptHint = sourceScripts.length ? ` Script: ${sourceScripts.join(", ")}.` : "";
  return [
    {
      role: "system",
      content:
        `Explain a selected word or short phrase to a Russian reader. Detect its language; never assume English.${scriptHint} ` +
        "Use the context only to choose the meaning; do not translate the context. " +
        "A capital letter alone does not make a name: “Why” is the word «почему»; “Apple released an update” is a brand, “I ate an apple” is a word. " +
        "Prefer a normal translation whenever the fragment is a dictionary word.\n" +
        `${COMMON_RULES}\n` +
        "Ordinary word or phrase — answer exactly:\n[[translation]]\n<Russian translation in this context>\n" +
        "другие значения: <short comma-separated list> (omit this line if there are none)\n" +
        "Only for a name, title, brand, nickname, typo or made-up word — answer exactly:\n[[reference]]\n" +
        "<one category in Russian: название, имя, бренд, никнейм, опечатка or неизвестный термин>\n" +
        "<one short cautious explanation in Russian; do not invent facts; if unsure, say it is probably a name or a title>"
    },
    {
      role: "user",
      content: `${context ? `Context: ${context}\n` : ""}Fragment: ${text}`
    }
  ];
}

async function describeError(response) {
  let detail = "";
  try {
    const body = await response.json();
    detail = body?.error?.message || "";
  } catch {
    // тело не JSON — не страшно
  }

  switch (response.status) {
    case 401:
      return "Неверный API-ключ (401). Проверьте его в настройках.";
    case 403:
      return "Доступ запрещён (403). Возможно, модель недоступна для вашего аккаунта.";
    case 404:
      return `Модель не найдена (404). ${detail}`;
    case 429:
      return "Лимит запросов или закончился баланс (429). Проверьте billing в OpenAI.";
    default:
      return `Ошибка API ${response.status}. ${detail}`.trim();
  }
}
