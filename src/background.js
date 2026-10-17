const MENU_ID = "translate-selection";
const AUTO_MENU_ID = "toggle-auto-translate";
const API_URL = "https://api.openai.com/v1/chat/completions";
const PRIVACY_CONSENT_VERSION = 1;

// The cheapest current OpenAI model (October 2026): $0.10 / $0.50 per 1M tokens.
const DEFAULT_MODEL = "gpt-6-luna";
// Models OpenAI retires before January 2027 are migrated to DEFAULT_MODEL.
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
  // Auto-translate is on by default: select text, get a translation.
  autoTranslate: true,
  privacyConsentVersion: 0
};

// Cache of repeat translations, so the same piece never costs money twice.
// Chrome's service worker sleeps after ~30 s idle and loses its memory, so a
// copy lives in chrome.storage.session: it lasts until the browser closes and
// is never written to disk.
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
        // Without session storage, work from memory only.
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
  chrome.storage.session?.set({ [CACHE_STORAGE_KEY]: [...cache] }).catch(() => {});
}

// Request parameters per model. Newer OpenAI models "reason" before
// answering: that is slower and billed as output tokens, and they reject
// temperature. Translation needs no reasoning.
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

// Answer length cap: a translation is never much longer than the original, and
// a model that gets chatty by accident must not cost extra money.
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
    // Right click on the Sensemark icon in Chrome's toolbar. Safari does not
    // support this menu on the icon, so auto-translate is toggled in settings there.
    try {
      chrome.contextMenus.create(
        { id: AUTO_MENU_ID, title: "Включить автоперевод", contexts: ["action"] },
        () => void chrome.runtime.lastError
      );
      refreshAutoMenuTitle();
    } catch {
      // The "action" context is not available in this browser.
    }
  });

  // Translation mode: users who already entered an OpenAI key keep it;
  // everyone else starts with Chrome's free built-in translator.
  chrome.storage.local.get({ provider: "", apiKey: "", privacyConsentVersion: 0 }).then((settings) => {
    const provider = settings.provider || (settings.apiKey ? "openai" : "builtin");
    if (!settings.provider) chrome.storage.local.set({ provider });

    // On install, show the mode choice. On update, settings open only
    // when OpenAI mode is missing consent.
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
      autoTranslate: DEFAULTS.autoTranslate,
      autoPausedUntil: 0
    });
    const paused = autoTranslate && Date.now() < autoPausedUntil;
    // While paused, the item lifts the pause; otherwise it toggles auto-translate.
    await chrome.storage.local.set(
      paused ? { autoPausedUntil: 0 } : { autoTranslate: !autoTranslate, autoPausedUntil: 0 }
    );
    return;
  }
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  await ping(tab.id, info.frameId);
}

// The icon menu title reflects the current auto-translate state.
async function refreshAutoMenuTitle() {
  const { autoTranslate, autoPausedUntil } = await chrome.storage.local.get({
    autoTranslate: DEFAULTS.autoTranslate,
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

// The pause ends by itself, so refresh the title when the menu opens.
chrome.runtime.onStartup?.addListener(refreshAutoMenuTitle);

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== MENU_ID || !tab?.id) return;
  // Without frameId the message goes to every frame; the one with the selection answers.
  ping(tab.id);
});

// Tabs opened before the extension was installed have no content script yet.
// Try to reach it, and on failure inject it and retry.
async function ping(tabId, frameId) {
  const options = frameId === undefined ? {} : { frameId };
  const message = { type: "translate-selection" };

  try {
    await chrome.tabs.sendMessage(tabId, message, options);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: frameId === undefined ? { tabId, allFrames: true } : { tabId, frameIds: [frameId] },
        files: [
          "language-detection.js",
          "selection-text.js",
          "word-response.js",
          "text-response.js",
          "ui-scale.js",
          "builtin-translator.js",
          "card-theme.js",
          "content/card-styles.js",
          "content/page-text.js",
          "content/placement.js",
          "content/status-pill.js",
          "content/content.js"
        ]
      });
      await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      // Internal pages (chrome://, Web Store) are closed to scripts; stay quiet.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    translate(message.text, message.context, message.wordMode)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // keep the channel open for the async response
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }

  // Safari: translation and language detection by Apple's system through the
  // Sensemark app (SafariWebExtensionHandler.swift). Chrome has no native part.
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

// Translation fonts ship inside the extension (OFL licence, fonts/). A page
// cannot read extension files itself, so the content script gets them from
// here: no web_accessible_resources a site could use to detect the
// extension, and nothing downloaded from the web.
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

// One-off translation without streaming, used by the "Check key" button.
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

// Shared request preparation for both modes: regular and streaming.
async function prepareRequest(rawText, context, wordMode = false, rawSourceScripts = []) {
  const text = (rawText || "").trim();
  if (!text) throw new Error("Ничего не выделено.");

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.model || RETIRED_MODELS.has(settings.model)) settings.model = DEFAULT_MODEL;
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    throw new Error("Перед переводом подтвердите отправку текста в OpenAI в настройках расширения.");
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

// Streaming: the translation reaches the content script as it is generated,
// so the first words show in a fraction of a second instead of after the full answer.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      streamTranslate(port, message.text, message.context, message.wordMode, message.sourceScripts);
    }
  });
});

async function streamTranslate(port, rawText, context, wordMode = false, rawSourceScripts = []) {
  const abort = new AbortController();
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    abort.abort(); // the user closed the card, do not burn tokens
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
      buffer = lines.pop(); // the tail of an incomplete line waits for the next chunk

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
          // broken SSE event, skip it
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

// Short titles are often duplicated in two languages:
// "Japanese Daycares – 日本の保育園". One translation reads better for them
// than two sections that look the same. Long paragraphs never qualify.
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

// Validation is lenient on purpose: every retry doubles the price of a translation.
// Catch only a clearly broken answer, not legitimately kept names,
// brands and terms ("GitHub Copilot", "API", "東京").
function contentIssue(value) {
  const payload = responsePayload(value);
  if (
    /full translation into|translate the text|полный перевод на язык|без пояснений и исходного текста/i.test(
      payload
    )
  ) {
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
  const declaredScripts = [...value.matchAll(/^\[\[script\s*:\s*([^|\]]+)\s*\|/gim)].map((match) =>
    match[1].trim()
  );
  const unexpectedScripts = declaredScripts.filter((script) => !sourceScripts.includes(script));
  if (unexpectedScripts.length) {
    return `The answer added scripts that are not in the selection: ${[...new Set(unexpectedScripts)].join(
      ", "
    )}.`;
  }
  if (sourceScripts.length > 1 && !multilingual && !unifiedParallelTitle) {
    return "The selection has several scripts, so the answer must use the [[multilingual]] format.";
  }
  if (sourceScripts.length < 2 && multilingual) {
    const languages = [...value.matchAll(/^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:\s*([^\]]+)\]\]/gim)].map(
      (match) => match[1].trim().toLowerCase()
    );
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
  const required =
    sourceScripts.length > 1 && !parallelTitle
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

// Instructions are in English: the same meaning costs roughly half the tokens
// of Russian, and we pay for them on every request. The model still answers
// in Russian.
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

// A short fragment is translated with its sentence in mind: a word has many
// meanings, and we need the one used here.
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
    // the body is not JSON, that is fine
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
