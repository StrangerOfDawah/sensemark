const MENU_ID = "translate-selection";
const API_URL = "https://api.openai.com/v1/chat/completions";

const DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",
  targetLang: "русский",
  autoTranslate: false
};

// Небольшой кэш, чтобы повторный перевод того же куска не стоил денег.
const cache = new Map();
const CACHE_LIMIT = 200;

function cacheGet(key) {
  return cache.get(key);
}

function cacheSet(key, value) {
  if (cache.size >= CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
  cache.set(key, value);
}

chrome.runtime.onInstalled.addListener((details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Перевести на русский",
      contexts: ["selection"]
    });
  });

  // После установки сразу показываем настройку ключа и раскрытие обработки данных.
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  ping(tab.id, info.frameId);
});

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
        files: ["content.js"]
      });
      await chrome.tabs.sendMessage(tabId, message, options);
    } catch {
      // Служебные страницы (chrome://, Web Store) скриптам недоступны — молчим.
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translate") {
    translate(message.text, message.context)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true; // держим канал открытым для асинхронного ответа
  }

  if (message?.type === "open-options") {
    chrome.runtime.openOptionsPage();
  }
});

// Разовый перевод без стриминга — используется кнопкой «Проверить ключ».
async function translate(rawText, context) {
  const { settings, cacheKey, messages } = await prepareRequest(rawText, context);

  const hit = cacheGet(cacheKey);
  if (hit) return hit;

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.2,
      messages
    })
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
async function prepareRequest(rawText, context) {
  const text = (rawText || "").trim();
  if (!text) throw new Error("Ничего не выделено.");

  const settings = await chrome.storage.local.get(DEFAULTS);
  if (!settings.apiKey) {
    throw new Error("Не задан API-ключ. Откройте настройки расширения.");
  }

  const cacheKey = `${settings.model}|${settings.targetLang}|${context || ""}|${text}`;
  const messages = context
    ? buildWordMessages(text, context, settings.targetLang)
    : buildTextMessages(text, settings.targetLang);

  return { settings, cacheKey, messages };
}

// Стриминг: перевод уходит в content script по мере генерации,
// первые слова видны через долю секунды вместо ожидания всего ответа.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "translate") return;
  port.onMessage.addListener((message) => {
    if (message?.type === "start") {
      streamTranslate(port, message.text, message.context);
    }
  });
});

async function streamTranslate(port, rawText, context) {
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
    const { settings, cacheKey, messages } = await prepareRequest(rawText, context);

    const hit = cacheGet(cacheKey);
    if (hit) {
      send({ type: "done", text: hit });
      return;
    }

    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: 0.2,
        stream: true,
        messages
      }),
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

    cacheSet(cacheKey, full);
    send({ type: "done", text: full });
  } catch (error) {
    if (error.name !== "AbortError") {
      send({ type: "error", error: error.message });
    }
  }
}

function buildTextMessages(text, lang) {
  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик. Переведи текст пользователя на ${lang} язык. ` +
        "Верни ТОЛЬКО перевод: без кавычек, без пояснений, без исходного текста, без комментариев. " +
        "Сохраняй разметку абзацев, имена собственные и технические термины. " +
        `Если текст уже на ${lang}, верни его без изменений.`
    },
    { role: "user", content: text }
  ];
}

// Короткий фрагмент переводим с оглядкой на предложение: у слова значений много,
// а нужно то единственное, в котором оно употреблено здесь.
function buildWordMessages(text, context, lang) {
  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик на ${lang} язык. Пользователь выделил фрагмент внутри предложения. ` +
        "Предложение дано ТОЛЬКО как контекст — переводить его целиком не нужно.\n" +
        "Формат ответа строго такой:\n" +
        "Первая строка — перевод выделенного фрагмента в том значении, в котором он употреблён в этом предложении. Только перевод, без кавычек и пояснений.\n" +
        "Вторая строка — если у фрагмента есть другие распространённые значения, напиши «другие значения: » и перечисли их через запятую. Если других значений нет или фрагмент однозначен, вторую строку не пиши вообще.\n" +
        "Никакого другого текста в ответе быть не должно."
    },
    {
      role: "user",
      content: `Предложение: ${context}\n\nВыделенный фрагмент: ${text}`
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
