// The service worker: context menus, the toolbar icon menu, OpenAI requests and
// their cache. Prompts and answer checks are pure modules loaded below.
importScripts("i18n.js", "background/prompts.js", "background/validation.js");

const { t } = self.SensemarkI18n;
const {
  buildTextMessages,
  buildWordMessages,
  isParallelTitleCandidate,
  normalizeSourceScripts,
  requestBody
} = self.SensemarkBackgroundPrompts;
const { responseIssue } = self.SensemarkBackgroundValidation;

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
  targetLang: t("targetLanguage"),
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

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: t("menuTranslate"),
      contexts: ["selection"]
    });
    // Right click on the Sensemark icon in Chrome's toolbar. Safari does not
    // support this menu on the icon, so auto-translate is toggled in settings there.
    try {
      chrome.contextMenus.create(
        { id: AUTO_MENU_ID, title: t("autoMenuEnable"), contexts: ["action"] },
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
    ? t("autoMenuEnable")
    : Date.now() < autoPausedUntil
      ? t("autoMenuResume")
      : t("autoMenuDisable");
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
          "i18n.js",
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
  if (!result) throw new Error(t("errorEmptyResponse"));

  cacheSet(cacheKey, result);
  return result;
}

// Shared request preparation for both modes: regular and streaming.
async function prepareRequest(rawText, context, wordMode = false, rawSourceScripts = []) {
  const text = (rawText || "").trim();
  if (!text) throw new Error(t("errorNothingSelected"));

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.model || RETIRED_MODELS.has(settings.model)) settings.model = DEFAULT_MODEL;
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    throw new Error(t("errorConsentRequired"));
  }
  if (!settings.apiKey) {
    throw new Error(t("errorNoApiKey"));
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
    if (!full) throw new Error(t("errorEmptyResponse"));

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
  if (!repaired) throw new Error(t("errorEmptyRepair"));

  const remainingIssue = responseIssue(repaired, wordMode, sourceScripts, sourceText);
  if (remainingIssue) {
    throw new Error(t("errorIncompleteTranslation"));
  }
  return repaired;
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
      return t("errorApi401");
    case 403:
      return t("errorApi403");
    case 404:
      return t("errorApi404", detail);
    case 429:
      return t("errorApi429");
    default:
      return t("errorApiStatus", response.status, detail).trim();
  }
}
