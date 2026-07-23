const MENU_ID = "translate-selection";
const API_URL = "https://api.openai.com/v1/chat/completions";
const PRIVACY_CONSENT_VERSION = 1;

const DEFAULTS = {
  apiKey: "",
  model: "gpt-4o-mini",
  targetLang: "русский",
  autoTranslate: false,
  privacyConsentVersion: 0
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

  // До первого перевода пользователь должен увидеть раскрытие обработки данных.
  if (details.reason === "install") {
    chrome.runtime.openOptionsPage();
  } else if (details.reason === "update") {
    chrome.storage.local.get({ privacyConsentVersion: 0 }).then((settings) => {
      if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
        chrome.runtime.openOptionsPage();
      }
    });
  }
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
        files: [
          "language-detection.js",
          "selection-text.js",
          "word-response.js",
          "text-response.js",
          "ui-scale.js",
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
});

// Разовый перевод без стриминга — используется кнопкой «Проверить ключ».
async function translate(rawText, context, wordMode = false) {
  const { settings, cacheKey, messages } = await prepareRequest(rawText, context, wordMode);

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
async function prepareRequest(rawText, context, wordMode = false, rawSourceScripts = []) {
  const text = (rawText || "").trim();
  if (!text) throw new Error("Ничего не выделено.");

  const settings = await chrome.storage.local.get(DEFAULTS);
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

    const hit = cacheGet(cacheKey);
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

function repeatsForeignSource(payload, sourceText) {
  const normalizedPayload = normalizeComparable(payload);
  const candidates = [sourceText, ...String(sourceText || "").split(/[\n.!?؟؛،]+/u)];

  return candidates.some((candidate) => {
    const letters = [...String(candidate || "")].filter((char) => /\p{L}/u.test(char));
    if (letters.length < 4 || letters.every((char) => /[А-Яа-яЁё]/u.test(char))) return false;
    const normalized = normalizeComparable(candidate);
    return normalized.length >= 4 && normalizedPayload.includes(normalized);
  });
}

function translatedBodies(value) {
  const sections = [
    ...String(value || "").matchAll(
      /^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:[^\]]+\]\]\s*\n([\s\S]*?)(?=^\[\[(?:script\s*:|lang\s*:)|$)/gim
    )
  ].map((match) => match[1].trim());
  return sections.length ? sections : [responsePayload(value)];
}

function contentIssue(value, sourceText) {
  const payload = responsePayload(value);
  if (/полный перевод на язык|перевод фрагмента|без пояснений и исходного текста/i.test(payload)) {
    return "Ответ повторяет инструкцию вместо перевода.";
  }
  if (/^(?:перевод|translation)\s*:/im.test(payload)) {
    return "Ответ содержит лишнюю подпись «Перевод:» вместо чистого результата.";
  }
  if (repeatsForeignSource(payload, sourceText)) {
    return "Ответ повторяет выделенный иностранный текст вместо чистого перевода.";
  }

  if (
    /[\p{Script=Arabic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Hebrew}\p{Script=Greek}\p{Script=Devanagari}]/u.test(
      payload
    )
  ) {
    return "Ответ содержит текст исходной письменностью вместо русского перевода.";
  }

  const nonRussianBody = translatedBodies(value).find(
    (body) => /\p{L}/u.test(body) && !/[А-Яа-яЁё]/u.test(body)
  );
  return nonRussianBody
    ? "Одна из секций содержит не русский перевод."
    : "";
}

function responseIssue(text, wordMode, rawSourceScripts = [], sourceText = "") {
  const value = String(text || "").trim();
  if (/^\[\[skip\]\]/i.test(value)) {
    return "Ответ ошибочно содержит запрещённую метку [[skip]].";
  }

  const firstLine = value.split("\n", 1)[0].trim().toLowerCase();
  if (wordMode) {
    if (firstLine === "[[reference]]") return "";
    if (firstLine !== "[[translation]]") {
      return "Для короткого фрагмента отсутствует формат [[translation]] или [[reference]].";
    }
    return contentIssue(value, sourceText);
  }

  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const multilingual = firstLine === "[[multilingual]]";
  const declaredScripts = [
    ...value.matchAll(/^\[\[script\s*:\s*([^|\]]+)\s*\|/gim)
  ].map((match) => match[1].trim());
  const unexpectedScripts = declaredScripts.filter((script) => !sourceScripts.includes(script));
  if (unexpectedScripts.length) {
    return `Ответ добавил отсутствующие в выделении письменности: ${[
      ...new Set(unexpectedScripts)
    ].join(", ")}.`;
  }
  if (sourceScripts.length > 1 && !multilingual) {
    return "Для выделения с несколькими письменностями отсутствует формат [[multilingual]].";
  }
  if (sourceScripts.length < 2 && multilingual) {
    const languages = [
      ...value.matchAll(/^\[\[(?:script\s*:[^|\]]+\|\s*)?lang\s*:\s*([^\]]+)\]\]/gim)
    ].map((match) => match[1].trim().toLowerCase());
    if (new Set(languages).size < 2) {
      return "Для текста на одном языке ошибочно выбран многоязычный формат.";
    }
  } else if (!multilingual && firstLine !== "[[text]]") {
    return "Для обычного текста отсутствует формат [[text]].";
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
      return `В ответе отсутствуют секции для письменностей: ${missing.join(", ")}.`;
    }
  }

  return contentIssue(value, sourceText);
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
  const required = sourceScripts.length > 1
    ? ` Обязательно верни секции для всех письменностей: ${sourceScripts.join(", ")}.`
    : "";
  const repairMessages = [
    ...messages,
    { role: "assistant", content: invalidResponse },
    {
      role: "user",
      content:
        `Исправь ответ: ${issue}${required} Не пропускай ни один исходный фрагмент и не используй [[skip]]. ` +
        "Все содержательные строки пиши только по-русски. Не повторяй иностранный оригинал, не переводи на третий язык, " +
        "не копируй текст инструкции и не добавляй подпись «Перевод:». Повтори весь ответ целиком строго в требуемом формате."
    }
  ];

  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: 0,
      messages: repairMessages
    }),
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

function buildTextMessages(text, lang, rawSourceScripts = []) {
  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const scriptList = sourceScripts.join(", ");
  const multiScript = sourceScripts.length > 1;
  const format = multiScript
    ? "В исходном выделении локально обнаружены письменности: " +
      `${scriptList}. Поэтому ответ ОБЯЗАТЕЛЬНО должен иметь формат:\n` +
      "[[multilingual]]\n" +
      "Затем для каждого исходного фрагмента напиши строку [[script:SCRIPT|lang:LANGUAGE]], а со следующей строки — только его русский перевод. " +
      "SCRIPT замени точным значением из списка, LANGUAGE — названием исходного языка по-русски. " +
      "Значение SCRIPT описывает источник и НИКОГДА не означает, что результат нужно писать этой письменностью. " +
      "В ответе должна быть хотя бы одна непустая секция для КАЖДОЙ письменности из списка; ничего не пропускай."
    : "Если весь исходный текст на одном языке, первая строка ответа должна быть только [[text]], " +
      `а начиная со второй строки напиши сам перевод на язык «${lang}». ` +
      "Только если в самом исходном тексте действительно несколько языков одной письменности, начни с [[multilingual]], " +
      "затем для каждого языка добавь строку [[script:SCRIPT|lang:LANGUAGE]] и под ней русский перевод.";

  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик на язык «${lang}». Самостоятельно определи язык каждого предложения или смыслового фрагмента. ` +
        "Не считай английский языком по умолчанию: в одном выделении могут одновременно встречаться русский, английский, арабский и другие языки. " +
        "Переводи только фрагменты не на целевом языке; фрагменты уже на целевом языке сохраняй дословно. Сохраняй порядок, абзацы, имена собственные и технические термины. " +
        "Определяй количество языков только по исходному пользовательскому тексту: русский язык результата не является вторым исходным языком.\n" +
        "Метка [[skip]] запрещена: проверка русского текста уже выполнена локально до запроса. Служебные метки пиши точно как указано.\n" +
        "Все содержательные строки ответа пиши только по-русски. Никогда не повторяй иностранный оригинал, не переводи его на третий язык, " +
        "не копируй формулировки этой инструкции и не добавляй подписи «Перевод:» или «Translation:».\n" +
        "Классический или коранический арабский переводи непосредственно с арабского с учётом грамматики и доступного контекста; не подменяй перевод толкованием или обратным переводом через другой язык.\n" +
        `${format}\n` +
        "Создавай отдельную секцию для каждого последовательного предложения или блока исходного языка и сохраняй исходный порядок. Соседние фрагменты одного языка можно объединить. Не добавляй никаких пояснений вне секций."
    },
    { role: "user", content: text }
  ];
}

// Короткий фрагмент переводим с оглядкой на предложение: у слова значений много,
// а нужно то единственное, в котором оно употреблено здесь.
function buildWordMessages(text, context, lang, rawSourceScripts = []) {
  const sourceScripts = normalizeSourceScripts(rawSourceScripts);
  const scriptHint = sourceScripts.length
    ? ` Локально определённая письменность выделения: ${sourceScripts.join(", ")}.`
    : "";
  return [
    {
      role: "system",
      content:
        `Ты профессиональный переводчик на ${lang} язык. Самостоятельно определи исходный язык выделенного фрагмента; не считай английский языком по умолчанию.${scriptHint} ` +
        "Контекст, если он дан, нужен ТОЛЬКО для определения значения — переводить его целиком не нужно.\n" +
        "Сначала определи, как фрагмент употреблён именно здесь. Заглавная буква сама по себе НЕ означает, что это имя или название: слово может стоять в начале предложения. Если контекста нет, но фрагмент является обычным словарным словом хотя бы одного языка, предпочти перевод. Например, «Why» — обычное английское слово и переводится как «почему».\n" +
        "Используй режим reference только если по контексту фрагмент употреблён как имя, название, бренд или никнейм либо если это действительно опечатка или придуманное слово без словарного значения. Например, Apple в «Apple released an update» — бренд, а apple в «I ate an apple» — обычное слово. Не выдумывай значения и факты.\n" +
        "Ответь строго в одном из двух форматов. Служебную метку пиши точно как указано.\n" +
        "Метка [[skip]] запрещена. Даже если перевод не требуется, используй [[translation]] и верни фрагмент без изменений.\n" +
        "Для обычного слова или выражения первая строка должна быть только [[translation]]. " +
        `Со второй строки напиши сам перевод в подходящем по контексту значении на языке «${lang}». ` +
        "При необходимости следующей строкой можно написать «другие значения:» и короткий список.\n" +
        `Если фрагмент уже на языке «${lang}», верни его без изменений. Строку «другие значения» не пиши, если их нет.\n` +
        "Не повторяй иностранный оригинал, не копируй формулировки инструкции и не добавляй отдельную строку «Перевод:».\n" +
        "Классический или коранический арабский переводи непосредственно с арабского с учётом грамматики и контекста, не через английский и не в виде толкования.\n" +
        "Для имени, названия, бренда, никнейма, опечатки или придуманного слова первая строка должна быть только [[reference]]. " +
        "Со второй строки напиши одну категорию: название, имя, бренд, никнейм, опечатка или неизвестный термин. " +
        `Со следующей строки дай одно короткое осторожное объяснение на языке «${lang}» по написанию и контексту; если определить нельзя, напиши, что это, вероятно, имя или название.\n` +
        "Никакого другого текста в ответе быть не должно."
    },
    {
      role: "user",
      content: `${context ? `Контекст: ${context}\n\n` : "Контекст не предоставлен.\n\n"}Выделенный фрагмент: ${text}`
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
