// Free mode: Chrome's built-in translator (Translator API, Chrome 138+),
// and in Safari Apple's system translator through the app's native part.
// Runs on the device: no key, no cost, the text goes nowhere.
// Results use the same format as the OpenAI answer ([[text]],
// [[translation]], [[multilingual]]), so the card and the popup do not change.
(function exposeBuiltinTranslator(root, factory) {
  const api = factory(
    typeof module === "object" && module.exports ? require("./i18n.js") : root.SensemarkI18n
  );
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkBuiltin = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (I18n) => {
  const { t } = I18n;
  const TARGET = "ru";
  // When the language detector is unsure, the script hints at the language.
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
      return new Intl.DisplayNames([TARGET], { type: "language" }).of(code) || code;
    } catch {
      return code;
    }
  }

  // The language name in the genitive case, for phrases like "translating from X".
  function languageGenitive(code) {
    return languageName(code).replace(
      new RegExp(t("grammarGenitiveEnding"), "u"),
      t("grammarGenitiveReplacement")
    );
  }

  function normalizeLanguage(code) {
    const value = String(code || "")
      .trim()
      .toLowerCase();
    if (!value || value === "und") return "";
    const base = value.split(/[-_]/)[0];
    if (base === "zh") return value.includes("hant") || /-(?:tw|hk|mo)$/.test(value) ? "zh-Hant" : "zh";
    return LANGUAGE_ALIASES[base] || base;
  }

  // Sentences and lines: the units used to detect the language of mixed text.
  function splitUnits(text) {
    const units = [];
    for (const line of String(text || "").split("\n")) {
      const parts = line.split(/(?<=[.!?…。！？؟])\s+/u).filter((part) => part.trim());
      parts.forEach((part, index) =>
        units.push({ text: part.trim(), newline: index === 0 && units.length > 0 })
      );
    }
    return units;
  }

  const DOWNLOAD_TIMEOUT_MS = 60_000;

  // Texts that depend on whose translator is running.
  const CHROME_LABELS = {
    engine: t("engineChrome"),
    unavailable: t("chromeUnavailable"),
    needsDownload: (language) => t("chromeNeedsDownload", languageGenitive(language)),
    downloadFailed: t("chromeDownloadFailed"),
    failed: t("chromeFailed"),
    downloading: (name) => t("chromeDownloading", name),
    reportsProgress: true
  };
  const APPLE_LABELS = {
    engine: t("engineApple"),
    unavailable: t("appleUnavailable"),
    needsDownload: (language) => t("appleNeedsDownload", languageGenitive(language)),
    downloadFailed: t("appleDownloadFailed"),
    failed: t("appleFailed"),
    downloading: (name) => t("appleDownloading", name),
    reportsProgress: false
  };

  function createBuiltinTranslator({
    Translator,
    detectLanguage,
    isRussianOnly,
    detectScripts,
    downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS,
    labels = CHROME_LABELS
  }) {
    const translators = new Map();

    function ensureAvailable() {
      if (!Translator?.create) {
        throw new BuiltinError("unavailable", labels.unavailable);
      }
    }

    async function detect(text, sourceScripts = []) {
      let language = "";
      try {
        const result = await detectLanguage?.(text);
        const top = result?.languages?.find((item) => normalizeLanguage(item.language));
        language = normalizeLanguage(top?.language);
      } catch {
        // The detector may fail on very short text.
      }
      const script = sourceScripts.find((item) => SCRIPT_LANGUAGE[item]);
      // For non-Latin scripts the script beats the detector on short text.
      if (script && (!language || language === "en")) return SCRIPT_LANGUAGE[script];
      return language || "en";
    }

    // Creates a translator. If the language pack is missing, Chrome downloads it
    // (once): show progress and do not wait forever.
    function createWithDownload(language, availability, onStatus) {
      const options = { sourceLanguage: language, targetLanguage: TARGET };
      const downloading = availability === "downloadable" || availability === "downloading";
      // The second argument feeds the progress ring on the page.
      const status = (percent) =>
        onStatus?.(
          percent === null
            ? t("downloadingPack", languageGenitive(language))
            : t("downloadingPackPercent", languageGenitive(language), percent),
          { kind: "download", language, progress: percent === null ? null : percent / 100 }
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
          () => reject(new BuiltinError("download-failed", labels.downloadFailed, language)),
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
              t("engineUnsupported", labels.engine, languageGenitive(language)),
              language
            );
          }
          // Apple's translator downloads languages only in the Sensemark app,
          // so offer the "Download" button right away instead of waiting.
          if (availability !== "available" && Translator.install) {
            throw new BuiltinError("needs-download", labels.needsDownload(language), language);
          }
          try {
            return await createWithDownload(language, availability, onStatus);
          } catch (error) {
            if (error?.name === "NotAllowedError") {
              throw new BuiltinError("needs-download", labels.needsDownload(language), language);
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
      // The built-in translator joins lines into one, so multi-line text is
      // translated line by line and headings and paragraphs stay in place.
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
          // Chrome yields either a delta or the whole text so far; support both.
          result = chunk.startsWith(result) ? chunk : result + chunk;
          onPartial(result);
        }
        return result.trim();
      }
      return String(await translator.translate(text, { signal })).trim();
    }

    // Splits mixed text into single-language pieces; Russian pieces are not translated.
    async function segments(text, sourceScripts) {
      const units = splitUnits(text);
      const groups = [];
      for (const unit of units) {
        const russian = Boolean(isRussianOnly?.(unit.text));
        const language = russian
          ? TARGET
          : await detect(unit.text, detectScripts ? detectScripts(unit.text) : sourceScripts);
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
        // The built-in translator cannot pick a meaning from context, so the whole
        // sentence is translated too and the meaning is clear at once.
        if (context && context.trim() !== text.trim()) {
          const sentence = await translateText(translator, context, signal);
          if (sentence) result += `\n${t("protocolInSentence")}: ${sentence.replace(/\s+/g, " ")}`;
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

    // Download a language pack on a user click (Chrome requires a gesture).
    // onProgress(0…1) feeds the progress ring on the page.
    async function prepare(language, onProgress) {
      ensureAvailable();
      translators.delete(language);
      if (Translator.install) {
        await Translator.install(language, onProgress);
        return;
      }
      await Translator.create({
        sourceLanguage: language,
        targetLanguage: TARGET,
        monitor(monitor) {
          monitor.addEventListener?.("downloadprogress", (event) => {
            onProgress?.(Math.min(1, Number(event.loaded) || 0));
          });
        }
      });
    }

    return { run, prepare, detect, labels };
  }

  // A channel with the chrome.runtime.Port interface: content.js and popup.js
  // use it exactly like an OpenAI request through the background.
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
            onStatus: (text, meta) => emit({ type: "status", text, ...meta })
          })
          .then((text) => emit({ type: "done", text }))
          .catch((error) => {
            if (abort.signal.aborted || error?.name === "AbortError") return;
            emit({
              type: "error",
              code: error?.code || "failed",
              language: error?.language || "",
              error: error instanceof BuiltinError ? error.message : (engine.labels || CHROME_LABELS).failed
            });
          });
      }
    };
  }

  // ---------- Safari: Apple's translator through the app's native part ----------
  // Safari has no Chrome Translator API. Instead the extension asks the
  // Sensemark container app (Swift) to translate with the macOS system
  // translator. The bridge mirrors the Translator API interface, so the
  // engine above works with it exactly as with Chrome.
  const NATIVE_STATUS = { installed: "available", supported: "downloadable", unsupported: "unavailable" };

  function isSafariExtension(runtime) {
    try {
      return /^safari-web-extension:/i.test(runtime?.getURL?.("") || "");
    } catch {
      return false;
    }
  }

  function createAppleBridge({
    send,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    installTimeoutMs = 180_000,
    pollMs = 2000
  }) {
    async function call(payload) {
      let reply;
      try {
        reply = await send(payload);
      } catch {
        reply = null;
      }
      if (!reply || reply.ok !== true) {
        const source = payload.source || "";
        if (reply?.code === "needs-download") {
          throw new BuiltinError("needs-download", APPLE_LABELS.needsDownload(source), source);
        }
        // No answer: the Sensemark app is not installed; "unavailable":
        // macOS is older than 26.4.
        if (!reply || reply.code === "unavailable") {
          throw new BuiltinError("unavailable", APPLE_LABELS.unavailable, source);
        }
        throw new BuiltinError("failed", APPLE_LABELS.failed, source);
      }
      return reply;
    }

    const Translator = {
      async availability({ sourceLanguage, targetLanguage = TARGET }) {
        const reply = await call({ op: "availability", source: sourceLanguage, target: targetLanguage });
        return NATIVE_STATUS[reply.status] || "unavailable";
      },
      async create({ sourceLanguage, targetLanguage = TARGET }) {
        const status = await Translator.availability({ sourceLanguage, targetLanguage });
        if (status !== "available") {
          throw new BuiltinError(
            "needs-download",
            APPLE_LABELS.needsDownload(sourceLanguage),
            sourceLanguage
          );
        }
        return {
          async translate(text) {
            const reply = await call({
              op: "translate",
              text,
              source: sourceLanguage,
              target: targetLanguage
            });
            return String(reply.text ?? "");
          }
        };
      },
      // Opens the Sensemark app (languages are downloaded there) and waits
      // until the language appears on the Mac.
      async install(language) {
        try {
          await call({ op: "openApp", source: language });
        } catch {
          // If it did not open by itself, the user opens Sensemark manually; wait the same way.
        }
        const deadline = Date.now() + installTimeoutMs;
        while (Date.now() < deadline) {
          await sleep(pollMs);
          if ((await Translator.availability({ sourceLanguage: language })) === "available") return;
        }
        throw new BuiltinError("download-failed", APPLE_LABELS.downloadFailed, language);
      }
    };

    // Same format as chrome.i18n.detectLanguage.
    async function detectLanguage(text) {
      const reply = await call({ op: "detect", text });
      return {
        isReliable: Boolean(reply.isReliable),
        languages: Array.isArray(reply.languages) ? reply.languages : []
      };
    }

    return { Translator, detectLanguage };
  }

  // What to use for free mode in this browser.
  function platformDeps(api = globalThis.chrome, scope = globalThis) {
    if (isSafariExtension(api?.runtime) && !scope.Translator) {
      const runtime = scope.browser?.runtime || api.runtime;
      const bridge = createAppleBridge({
        send: (payload) => runtime.sendMessage({ type: "native", payload })
      });
      return {
        platform: "safari",
        Translator: bridge.Translator,
        detectLanguage: bridge.detectLanguage,
        labels: APPLE_LABELS
      };
    }
    return {
      platform: "chrome",
      Translator: scope.Translator,
      detectLanguage: (text) => api.i18n.detectLanguage(text),
      labels: CHROME_LABELS
    };
  }

  return {
    APPLE_LABELS,
    BuiltinError,
    CHROME_LABELS,
    createAppleBridge,
    createBuiltinTranslator,
    isSafariExtension,
    platformDeps,
    languageGenitive,
    languageName,
    normalizeLanguage,
    openLocalPort,
    splitUnits
  };
});
