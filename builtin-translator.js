// Бесплатный режим: встроенный в Chrome переводчик (Translator API, Chrome 138+).
// Работает на устройстве: без ключа, без денег, текст никуда не отправляется.
// Результат отдаётся в том же формате, что и ответ OpenAI ([[text]],
// [[translation]], [[multilingual]]), поэтому карточка и popup не меняются.
(function exposeBuiltinTranslator(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkBuiltin = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TARGET = "ru";
  // Если определитель языка не уверен, письменность подсказывает язык.
  const SCRIPT_LANGUAGE = {
    Japanese: "ja",
    Korean: "ko",
    Han: "zh",
    Arabic: "ar",
    Hebrew: "he",
    Greek: "el",
    Devanagari: "hi"
  };
  const LANGUAGE_ALIASES = { iw: "he", in: "id", ji: "yi", jw: "jv" };

  class BuiltinError extends Error {
    constructor(code, message, language = "") {
      super(message);
      this.name = "BuiltinError";
      this.code = code;
      this.language = language;
    }
  }

  function languageName(code) {
    try {
      return new Intl.DisplayNames(["ru"], { type: "language" }).of(code) || code;
    } catch {
      return code;
    }
  }

  // «японский» → «японского», для фраз вида «перевод с японского».
  function languageGenitive(code) {
    return languageName(code).replace(/(?:ий|ый|ой)$/u, "ого");
  }

  function normalizeLanguage(code) {
    const value = String(code || "").trim().toLowerCase();
    if (!value || value === "und") return "";
    const base = value.split(/[-_]/)[0];
    if (base === "zh") return value.includes("hant") || /-(?:tw|hk|mo)$/.test(value) ? "zh-Hant" : "zh";
    return LANGUAGE_ALIASES[base] || base;
  }

  // Предложения и строки — единицы, по которым определяется язык смешанного текста.
  function splitUnits(text) {
    const units = [];
    for (const line of String(text || "").split("\n")) {
      const parts = line.split(/(?<=[.!?…。！？؟])\s+/u).filter((part) => part.trim());
      parts.forEach((part, index) => units.push({ text: part.trim(), newline: index === 0 && units.length > 0 }));
    }
    return units;
  }

  const DOWNLOAD_TIMEOUT_MS = 60_000;

  function createBuiltinTranslator({
    Translator,
    detectLanguage,
    isRussianOnly,
    detectScripts,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS
  }) {
    const translators = new Map();

    function ensureAvailable() {
      if (!Translator?.create) {
        throw new BuiltinError(
          "unavailable",
          "Встроенный переводчик Chrome здесь недоступен: он работает в Chrome 138 и новее на компьютере " +
            "и только на защищённых страницах (https). Можно переключиться на OpenAI в настройках."
        );
      }
    }

    async function detect(text, sourceScripts = []) {
      let language = "";
      try {
        const result = await detectLanguage?.(text);
        const top = result?.languages?.find((item) => normalizeLanguage(item.language));
        language = normalizeLanguage(top?.language);
      } catch {
        // Определитель может не справиться с очень коротким текстом.
      }
      const script = sourceScripts.find((item) => SCRIPT_LANGUAGE[item]);
      // Для нелатинских письменностей письменность надёжнее определителя на коротком тексте.
      if (script && (!language || language === "en")) return SCRIPT_LANGUAGE[script];
      return language || "en";
    }

    // Создаёт переводчик. Если языкового пакета ещё нет, Chrome скачивает его
    // (один раз): показываем прогресс и не ждём бесконечно.
    function createWithDownload(language, availability, onStatus) {
      const options = { sourceLanguage: language, targetLanguage: TARGET };
      const downloading = availability === "downloadable" || availability === "downloading";
      const status = (percent) =>
        onStatus?.(
          `Скачиваю языковой пакет для перевода с ${languageGenitive(language)} — это нужно один раз` +
            (percent === null ? "…" : `… ${percent}%`)
        );
      if (downloading) status(null);
      const created = Translator.create({
        ...options,
        monitor(monitor) {
          monitor.addEventListener?.("downloadprogress", (event) => {
            status(Math.round(Math.min(1, Number(event.loaded) || 0) * 100));
          });
        }
      });
      if (!downloading) return created;

      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BuiltinError(
                "download-failed",
                "Не удалось скачать языковой пакет Chrome — проверьте интернет и попробуйте ещё раз " +
                  "или переключитесь на OpenAI в настройках.",
                language
              )
            ),
          downloadTimeoutMs
        );
      });
      return Promise.race([created, timeout]).finally(() => clearTimeout(timer));
    }

    function getTranslator(language, onStatus) {
      if (!translators.has(language)) {
        const pending = (async () => {
          const options = { sourceLanguage: language, targetLanguage: TARGET };
          const availability = await Translator.availability(options);
          if (availability === "unavailable") {
            throw new BuiltinError(
              "unsupported",
              `Встроенный переводчик Chrome не умеет переводить с ${languageGenitive(language)}. ` +
                "Подключите OpenAI в настройках — он переводит с любого языка.",
              language
            );
          }
          try {
            return await createWithDownload(language, availability, onStatus);
          } catch (error) {
            if (error?.name === "NotAllowedError") {
              throw new BuiltinError(
                "needs-download",
                `Chrome нужно один раз скачать языковой пакет для перевода с ${languageGenitive(language)}.`,
                language
              );
            }
            throw error;
          }
        })();
        pending.catch(() => translators.delete(language));
        translators.set(language, pending);
      }
      return translators.get(language);
    }

    async function translateText(translator, text, signal, onPartial) {
      // Встроенный переводчик склеивает строки в одну, поэтому многострочный
      // текст переводим построчно — заголовки и абзацы остаются на месте.
      const lines = String(text).split("\n");
      if (lines.length > 1) {
        const done = [];
        for (const line of lines) {
          done.push(line.trim() ? await translateLine(translator, line, signal) : "");
          onPartial?.(done.join("\n"));
        }
        return done.join("\n").trim();
      }
      return translateLine(translator, text, signal, onPartial);
    }

    async function translateLine(translator, text, signal, onPartial) {
      if (onPartial && translator.translateStreaming) {
        let result = "";
        for await (const chunk of translator.translateStreaming(text, { signal })) {
          // Chrome отдаёт либо добавку, либо весь текст целиком — поддерживаем оба.
          result = chunk.startsWith(result) ? chunk : result + chunk;
          onPartial(result);
        }
        return result.trim();
      }
      return String(await translator.translate(text, { signal })).trim();
    }

    // Делит смешанный текст на куски одного языка; русские куски не переводятся.
    async function segments(text, sourceScripts) {
      const units = splitUnits(text);
      const groups = [];
      for (const unit of units) {
        const russian = Boolean(isRussianOnly?.(unit.text));
        const language = russian ? TARGET : await detect(unit.text, detectScripts ? detectScripts(unit.text) : sourceScripts);
        const last = groups.at(-1);
        if (last && last.language === language) {
          last.text += unit.newline ? `\n${unit.text}` : ` ${unit.text}`;
        } else {
          groups.push({ language, text: unit.text });
        }
      }
      return groups;
    }

    async function run(
      { text, context = null, wordMode = false, sourceScripts = [] },
      { onChunk, onStatus, signal } = {}
    ) {
      ensureAvailable();
      const translatorFor = (language) => getTranslator(language, onStatus);

      if (wordMode) {
        const language = await detect(context || text, sourceScripts);
        const translator = await translatorFor(language);
        const word = await translateText(translator, text, signal);
        let result = `[[translation]]\n${word}`;
        // Встроенный переводчик не выбирает значение по контексту, поэтому
        // показываем ещё и перевод всего предложения — смысл виден сразу.
        if (context && context.trim() !== text.trim()) {
          const sentence = await translateText(translator, context, signal);
          if (sentence) result += `\nв предложении: ${sentence.replace(/\s+/g, " ")}`;
        }
        onChunk?.(result);
        return result;
      }

      const multiScript = sourceScripts.length > 1;
      const whole = multiScript ? "" : await detect(text, sourceScripts);
      if (whole && whole !== TARGET) {
        const translator = await translatorFor(whole);
        const result = await translateText(translator, text, signal, (partial) =>
          onChunk?.(`[[text]]\n${partial}`)
        );
        return `[[text]]\n${result}`;
      }

      const groups = await segments(text, sourceScripts);
      if (groups.length === 1 && groups[0].language !== TARGET) {
        const translator = await translatorFor(groups[0].language);
        return `[[text]]\n${await translateText(translator, groups[0].text, signal)}`;
      }

      let result = "[[multilingual]]";
      for (const group of groups) {
        const translated =
          group.language === TARGET
            ? group.text
            : await translateText(await translatorFor(group.language), group.text, signal);
        result += `\n[[lang:${languageName(group.language)}]]\n${translated}`;
        onChunk?.(result);
      }
      return result;
    }

    // Скачать языковой пакет по клику пользователя (Chrome требует жест).
    async function prepare(language) {
      ensureAvailable();
      translators.delete(language);
      await Translator.create({ sourceLanguage: language, targetLanguage: TARGET });
    }

    return { run, prepare, detect };
  }

  // Канал с тем же интерфейсом, что chrome.runtime.Port: content.js и popup.js
  // работают с ним так же, как с запросом к OpenAI через background.
  function openLocalPort(engine) {
    const messageListeners = [];
    const disconnectListeners = [];
    const abort = new AbortController();
    let closed = false;
    const emit = (message) => {
      if (closed) return;
      for (const listener of [...messageListeners]) listener(message);
    };

    return {
      name: "translate-builtin",
      onMessage: { addListener: (listener) => messageListeners.push(listener) },
      onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
      disconnect() {
        closed = true;
        abort.abort();
      },
      postMessage(message) {
        if (message?.type !== "start") return;
        engine
          .run(message, {
            signal: abort.signal,
            onChunk: (text) => emit({ type: "chunk", text }),
            onStatus: (text) => emit({ type: "status", text })
          })
          .then((text) => emit({ type: "done", text }))
          .catch((error) => {
            if (abort.signal.aborted || error?.name === "AbortError") return;
            emit({
              type: "error",
              code: error?.code || "failed",
              language: error?.language || "",
              error:
                error instanceof BuiltinError
                  ? error.message
                  : "Встроенный переводчик Chrome не смог перевести текст — попробуйте ещё раз."
            });
          });
      }
    };
  }

  return {
    BuiltinError,
    createBuiltinTranslator,
    languageGenitive,
    languageName,
    normalizeLanguage,
    openLocalPort,
    splitUnits
  };
});
