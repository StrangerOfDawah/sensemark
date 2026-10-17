const assert = require("node:assert/strict");
const test = require("node:test");
const Builtin = require("../../src/builtin-translator.js");
const language = require("../../src/language-detection.js");

// A fake of Chrome's built-in translator (Translator API).
function fakeTranslator({ unsupported = [], needsGesture = [], streaming = true } = {}) {
  const state = { created: [], gesture: false, signals: [] };
  const api = {
    state,
    async availability({ sourceLanguage }) {
      return unsupported.includes(sourceLanguage) ? "unavailable" : "available";
    },
    async create({ sourceLanguage, targetLanguage }) {
      assert.equal(targetLanguage, "ru");
      if (needsGesture.includes(sourceLanguage) && !state.gesture) {
        const error = new Error("Requires a user gesture");
        error.name = "NotAllowedError";
        throw error;
      }
      state.created.push(sourceLanguage);
      const translate = (text) => `RU[${sourceLanguage}] ${text}`;
      return {
        async translate(text, options) {
          state.signals.push(options?.signal);
          return translate(text);
        },
        ...(streaming
          ? {
              async *translateStreaming(text) {
                const result = translate(text);
                yield result.slice(0, 6);
                yield result.slice(6);
              }
            }
          : {})
      };
    }
  };
  return api;
}

// A fake chrome.i18n.detectLanguage: decides by script.
async function detectLanguage(text) {
  const code = /[А-Яа-яЁё]/u.test(text)
    ? "ru"
    : /\p{Script=Arabic}/u.test(text)
      ? "ar"
      : /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)
        ? "ja"
        : /[äöüß]/u.test(text)
          ? "de"
          : /\p{Script=Latin}/u.test(text)
            ? "en"
            : "und";
  return { isReliable: code !== "und", languages: [{ language: code, percentage: 100 }] };
}

function engine(Translator, overrides = {}) {
  return Builtin.createBuiltinTranslator({
    Translator,
    detectLanguage,
    isRussianOnly: language.isRussianOnly,
    detectScripts: language.detectSignificantScripts,
    ...overrides
  });
}

test("single-language text streams in the same [[text]] format as OpenAI", async () => {
  const Translator = fakeTranslator();
  const chunks = [];
  const result = await engine(Translator).run(
    { text: "The council voted on Tuesday.", sourceScripts: ["Latin"] },
    { onChunk: (text) => chunks.push(text) }
  );
  assert.equal(result, "[[text]]\nRU[en] The council voted on Tuesday.");
  assert.deepEqual(chunks, ["[[text]]\nRU[en]", "[[text]]\nRU[en] The council voted on Tuesday."]);
});

test("a word gets its sentence translated too, because the built-in translator ignores context", async () => {
  const result = await engine(fakeTranslator()).run({
    text: "Bank",
    context: "Ich war gestern bei der Bank, um Geld für die Miete abzuheben.",
    wordMode: true,
    sourceScripts: ["Latin"]
  });
  // The language comes from the sentence (German), not from the single word.
  assert.equal(
    result,
    "[[translation]]\nRU[de] Bank\nв предложении: RU[de] Ich war gestern bei der Bank, um Geld für die Miete abzuheben."
  );
});

test("mixed text keeps Russian and translates each language in its own section", async () => {
  const result = await engine(fakeTranslator()).run({
    text: "Привет! How are you? مرحبا بك.",
    sourceScripts: ["Cyrillic", "Latin", "Arabic"]
  });
  assert.equal(
    result,
    "[[multilingual]]\n[[lang:русский]]\nПривет!\n[[lang:английский]]\nRU[en] How are you?\n[[lang:арабский]]\nRU[ar] مرحبا بك."
  );
});

test("short non-Latin text falls back to the language of its script", async () => {
  const detector = async () => ({ isReliable: false, languages: [{ language: "und", percentage: 0 }] });
  const result = await engine(fakeTranslator(), { detectLanguage: detector }).run({
    text: "日本の保育園",
    sourceScripts: ["Japanese"]
  });
  assert.equal(result, "[[text]]\nRU[ja] 日本の保育園");
});

test("an unsupported language explains how to switch to OpenAI", async () => {
  await assert.rejects(
    engine(fakeTranslator({ unsupported: ["ja"] })).run({
      text: "日本の保育園です",
      sourceScripts: ["Japanese"]
    }),
    (error) => {
      assert.equal(error.code, "unsupported");
      assert.match(error.message, /не умеет переводить с японского/);
      assert.match(error.message, /OpenAI/);
      return true;
    }
  );
});

test("a missing language pack needs one click, then translation works", async () => {
  const Translator = fakeTranslator({ needsGesture: ["ja"] });
  const translator = engine(Translator);
  await assert.rejects(
    translator.run({ text: "日本の保育園です", sourceScripts: ["Japanese"] }),
    (error) => error.code === "needs-download" && error.language === "ja" && /с японского/.test(error.message)
  );

  Translator.state.gesture = true; // the user pressed «Скачать»
  const progress = [];
  const create = Translator.create;
  Translator.create = async (options) => {
    const target = {
      addEventListener: (_name, listener) => [0.25, 1].forEach((loaded) => listener({ loaded }))
    };
    options.monitor?.(target);
    return create(options);
  };
  await translator.prepare("ja", (value) => progress.push(value));
  assert.deepEqual(progress, [0.25, 1], "прогресс скачивания доходит до кружка");
  assert.equal(
    await translator.run({ text: "日本の保育園です", sourceScripts: ["Japanese"] }),
    "[[text]]\nRU[ja] 日本の保育園です"
  );
});

test("without the Translator API the user gets a clear message", async () => {
  await assert.rejects(
    engine(undefined).run({ text: "Hello there, friends.", sourceScripts: ["Latin"] }),
    (error) => error.code === "unavailable" && /https/.test(error.message)
  );
});

test("works without streaming support too", async () => {
  const chunks = [];
  const result = await engine(fakeTranslator({ streaming: false })).run(
    { text: "Good morning everyone.", sourceScripts: ["Latin"] },
    { onChunk: (text) => chunks.push(text) }
  );
  assert.equal(result, "[[text]]\nRU[en] Good morning everyone.");
});

test("local port behaves like the OpenAI port: chunks, done, cancellation", async () => {
  const port = Builtin.openLocalPort(engine(fakeTranslator()));
  const messages = [];
  port.onMessage.addListener((message) => messages.push(message));
  port.postMessage({ type: "start", text: "Good morning everyone.", sourceScripts: ["Latin"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    messages.map((message) => message.type),
    ["chunk", "chunk", "done"]
  );
  assert.equal(messages.at(-1).text, "[[text]]\nRU[en] Good morning everyone.");

  const cancelled = Builtin.openLocalPort(engine(fakeTranslator()));
  const late = [];
  cancelled.onMessage.addListener((message) => late.push(message));
  cancelled.postMessage({ type: "start", text: "Good morning everyone.", sourceScripts: ["Latin"] });
  cancelled.disconnect();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(late, [], "после закрытия карточки ничего не приходит");
});

test("local port turns engine errors into user-facing messages with a code", async () => {
  const port = Builtin.openLocalPort(engine(fakeTranslator({ needsGesture: ["ar"] })));
  const messages = [];
  port.onMessage.addListener((message) => messages.push(message));
  port.postMessage({ type: "start", text: "مرحبا بكم في المدينة", sourceScripts: ["Arabic"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(messages[0].type, "error");
  assert.equal(messages[0].code, "needs-download");
  assert.equal(messages[0].language, "ar");
  assert.match(messages[0].error, /с арабского/);

  const broken = Builtin.openLocalPort({
    run: async () => {
      throw new Error("boom");
    }
  });
  const errors = [];
  broken.onMessage.addListener((message) => errors.push(message));
  broken.postMessage({ type: "start", text: "x" });
  broken.postMessage({ type: "ignored" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(errors.length, 1);
  assert.match(errors[0].error, /не смог перевести/);
});

test("language codes and names", () => {
  assert.equal(Builtin.normalizeLanguage("zh-Hant"), "zh-Hant");
  assert.equal(Builtin.normalizeLanguage("zh-TW"), "zh-Hant");
  assert.equal(Builtin.normalizeLanguage("zh-CN"), "zh");
  assert.equal(Builtin.normalizeLanguage("iw"), "he");
  assert.equal(Builtin.normalizeLanguage("pt-BR"), "pt");
  assert.equal(Builtin.normalizeLanguage("und"), "");
  assert.equal(Builtin.languageGenitive("en"), "английского");
  assert.equal(Builtin.languageName("de"), "немецкий");
  assert.deepEqual(Builtin.splitUnits("One. Two?\nТри"), [
    { text: "One.", newline: false },
    { text: "Two?", newline: false },
    { text: "Три", newline: true }
  ]);
});

test("downloading a language pack shows progress and gives up after a timeout", async () => {
  const statuses = [];
  const metas = [];
  const hanging = {
    async availability() {
      return "downloadable";
    },
    create({ monitor }) {
      monitor({ addEventListener: (name, listener) => listener({ loaded: 0.4 }) });
      return new Promise(() => {}); // the network hangs
    }
  };
  await assert.rejects(
    engine(hanging, { downloadTimeoutMs: 20 }).run(
      { text: "Good morning everyone.", sourceScripts: ["Latin"] },
      { onStatus: (text, meta) => statuses.push(text) && metas.push(meta) }
    ),
    (error) => error.code === "download-failed" && /OpenAI/.test(error.message)
  );
  assert.match(statuses[0], /Скачиваю языковой пакет для перевода с английского — это нужно один раз…$/);
  assert.match(statuses[1], /… 40%$/);
  // Data for the progress ring: the language and the downloaded share.
  assert.deepEqual(metas[0], { kind: "download", language: "en", progress: null });
  assert.deepEqual(metas[1], { kind: "download", language: "en", progress: 0.4 });
});

test("local port forwards download progress as a status message", async () => {
  const port = Builtin.openLocalPort({
    run: async (_message, { onStatus }) => {
      onStatus("Скачиваю…", { kind: "download", language: "ja", progress: 0.42 });
      return "[[text]]\nготово";
    }
  });
  const messages = [];
  port.onMessage.addListener((message) => messages.push(message));
  port.postMessage({ type: "start", text: "x" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(
    messages.map((message) => message.type),
    ["status", "done"]
  );
  assert.deepEqual(messages[0], {
    type: "status",
    text: "Скачиваю…",
    kind: "download",
    language: "ja",
    progress: 0.42
  });
});

test("line breaks survive: multi-line text is translated line by line", async () => {
  const chunks = [];
  const result = await engine(fakeTranslator()).run(
    { text: "City council approves new park\n\nThe council voted to build it.", sourceScripts: ["Latin"] },
    { onChunk: (text) => chunks.push(text) }
  );
  assert.equal(
    result,
    "[[text]]\nRU[en] City council approves new park\n\nRU[en] The council voted to build it."
  );
  assert.equal(chunks[0], "[[text]]\nRU[en] City council approves new park");
});
