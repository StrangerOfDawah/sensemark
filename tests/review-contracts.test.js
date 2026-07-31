const test = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const config = require("../shared/config.js");
const contracts = require("../shared/contracts.js");
const errors = require("../shared/errors.js");
const language = require("../shared/language-utils.js");
const renderer = require("../shared/result-renderer.js");
const scorer = require("../content/selection/candidate-scorer.js");
const context = require("../content/selection/context-extractor.js");
const intent = require("../content/selection/selection-intent.js");
const selectionController = require("../content/selection/selection-controller.js");
const selectionReader = require("../content/selection/selection-reader.js");
const positioner = require("../content/ui/card-positioner.js");
const cache = require("../background/translation-cache.js");
const openai = require("../background/providers/openai-provider.js");
const { createProviderRegistry } = require("../background/provider-registry.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSseParser } = require("../background/sse-parser.js");
const { createMockProvider } = require("./helpers/mock-provider.js");

function request(mode = config.TRANSLATION_MODE.TEXT, text = "hello") {
  return contracts.createTranslationRequest({
    text,
    mode,
    sourceScripts: ["Latin"],
    targetLanguage: "ignored"
  });
}

function streamingResponse(events, splitEveryByte = false) {
  const bytes = new TextEncoder().encode(events);
  return new Response(
    new ReadableStream({
      start(controller) {
        if (splitEveryByte) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        } else {
          controller.enqueue(bytes);
        }
        controller.close();
      }
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

async function translateStream(events, splitEveryByte = false) {
  const provider = openai.createOpenAiProvider({
    requestClient: {
      request: async () => ({
        response: streamingResponse(events, splitEveryByte),
        attempts: 1
      })
    }
  });
  return provider.translate(request(), {
    providerSettings: { apiKey: "test-only", model: "test-model" }
  });
}

test("review: SSE finish flushes a trailing event and keeps split Unicode intact", async () => {
  const events = [];
  const parser = createSseParser({ onEvent: (event) => events.push(event) });
  parser.feed("data: trailing");
  parser.finish();
  assert.deepEqual(events.map((event) => event.data), ["trailing"]);

  const translated = await translateStream(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "При" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "вет" }, finish_reason: "stop" }]
      })}\n\n`,
      "data: [DONE]\n\n"
    ].join(""),
    true
  );
  assert.equal(translated.translation, "Привет");
});

test("review: stream completion distinguishes truncation, filtering and interruption", async () => {
  for (const [finishReason, code] of [
    ["length", errors.ERROR_CODE.OUTPUT_TRUNCATED],
    ["content_filter", errors.ERROR_CODE.CONTENT_FILTERED]
  ]) {
    await assert.rejects(
      translateStream(
        `data: ${JSON.stringify({
          choices: [{ delta: { content: "x" }, finish_reason: finishReason }]
        })}\n\ndata: [DONE]\n\n`
      ),
      (error) => error.code === code
    );
  }
  await assert.rejects(
    translateStream(
      `data: ${JSON.stringify({
        choices: [{ delta: { content: "x" }, finish_reason: "stop" }]
      })}\n\n`
    ),
    (error) => error.code === errors.ERROR_CODE.STREAM_INTERRUPTED
  );
  await assert.rejects(
    translateStream(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\ndata: [DONE]\n\n`
    ),
    (error) => error.code === errors.ERROR_CODE.INVALID_RESPONSE
  );
});

test("review: contextual contract restores reference category and shared rendering", () => {
  const schema = openai.structuredSchema(config.TRANSLATION_MODE.CONTEXTUAL);
  assert.deepEqual(schema.required, [
    "kind",
    "translation",
    "alternatives",
    "category",
    "explanation"
  ]);
  assert.deepEqual(schema.properties.kind.enum, ["translation", "reference"]);
  assert.equal(schema.properties.alternatives.maxItems, 4);

  const result = contracts.createTranslationResult({
    kind: "reference",
    translation: "Sensemark",
    alternatives: ["Сенсмарк", "Sensemark", "third", "fourth", "discarded"],
    category: "brand",
    explanation: "Название продукта."
  });
  assert.equal(result.text, "Sensemark");
  assert.equal(result.alternatives.length, 4);

  const dom = new JSDOM("<main></main>");
  const container = dom.window.document.querySelector("main");
  renderer.renderResult({ documentObject: dom.window.document, container, result });
  assert.match(container.textContent, /Справка · brand/);
  assert.match(container.textContent, /Название продукта/);
});

test("review: provider metadata is complete and configuration validation is separate", async () => {
  let requestedUrl = "";
  const provider = openai.createOpenAiProvider({
    requestClient: {
      async request(url) {
        requestedUrl = url;
        return { response: new Response("{}", { status: 200 }) };
      }
    }
  });
  const registry = createProviderRegistry([provider]);
  assert.equal(registry.get("openai").displayName, "OpenAI");
  assert.equal(provider.capabilities.streamingText, true);
  assert.equal(provider.capabilities.structuredOutput, true);
  assert.equal(provider.capabilities.structuredStreaming, false);
  assert.equal(provider.settingsDescriptor.apiKey.type, "secret");
  await provider.validateConfiguration({ apiKey: "test-only", model: "model" });
  assert.equal(requestedUrl, "https://api.openai.com/v1/models/model");
  assert.throws(
    () => createProviderRegistry([{ id: "incomplete", translate() {} }]),
    /displayName/
  );
});

test("review: deterministic mock provider covers success and typed failure scenarios", async () => {
  const plain = createMockProvider();
  const deltas = [];
  const plainResult = await plain.translate(request(), {
    onDelta: (delta) => deltas.push(delta)
  });
  assert.deepEqual(deltas, ["При", "вет"]);
  assert.equal(plainResult.translation, "Привет");

  const contextual = createMockProvider({ scenario: "structured-contextual" });
  assert.equal((await contextual.translate(request())).kind, "reference");
  const multilingual = createMockProvider({ scenario: "multilingual" });
  assert.equal((await multilingual.translate(request())).sections.length, 2);

  for (const [scenario, code] of [
    ["rate-limit", errors.ERROR_CODE.RATE_LIMITED],
    ["quota", errors.ERROR_CODE.QUOTA_EXHAUSTED],
    ["malformed-stream", errors.ERROR_CODE.INVALID_RESPONSE],
    ["truncated-output", errors.ERROR_CODE.OUTPUT_TRUNCATED]
  ]) {
    const provider = createMockProvider({ scenario });
    await assert.rejects(provider.translate(request()), (error) => error.code === code);
  }
  await plain.validateConfiguration();
  assert.deepEqual(plain.counters, { translate: 1, validate: 1 });
});

test("review: dynamic output budget and cache identity include semantic versions", () => {
  const short = request(config.TRANSLATION_MODE.TEXT, "hello");
  const long = request(config.TRANSLATION_MODE.TEXT, "hello ".repeat(300));
  assert.ok(openai.calculateMaxOutputTokens(long) > openai.calculateMaxOutputTokens(short));
  const identity = JSON.parse(cache.createCacheKey(short, "openai", "model", {
    sourceLanguage: "en"
  }));
  assert.equal(identity.promptVersion, config.PROMPT_VERSION);
  assert.equal(identity.responseProtocolVersion, config.RESPONSE_PROTOCOL_VERSION);
  assert.equal(identity.source.language, "en");
  assert.equal(identity.semantic.alternativesLimit, 4);
  const withHint = contracts.createTranslationRequest({
    text: "hello",
    semanticHint: "brand"
  });
  assert.notEqual(
    cache.createCacheKey(short, "openai", "model"),
    cache.createCacheKey(withHint, "openai", "model")
  );
  assert.notEqual(
    cache.createCacheKey(short, "openai", "model"),
    cache.createCacheKey(short, "openai", "other-model")
  );
});

test("review: copy cancels only pending intent and context requires the selection", () => {
  let cancelledTimer = 0;
  let dismissed = 0;
  const controller = intent.createIntentController({
    schedule: () => 17,
    cancelSchedule: () => {
      cancelledTimer += 1;
    },
    onDismiss: () => {
      dismissed += 1;
    }
  });
  controller.evaluate({});
  controller.handleKeyDown({ key: "c", ctrlKey: true });
  assert.equal(cancelledTimer, 1);
  assert.equal(dismissed, 0);
  assert.equal(context.sentenceAround("First sentence. Second sentence.", "missing"), null);
  assert.equal(context.boundedContainer("before selected after", "selected", 12), "e selected a");
});

test("review: Chrome language detector wraps success, absence and API failure", async () => {
  const detected = language.createChromeLanguageDetector({
    detectLanguage(text, callback) {
      assert.equal(text, "hello");
      callback({
        isReliable: true,
        languages: [{ language: "en", percentage: 99 }]
      });
    }
  });
  assert.equal((await detected("hello")).languages[0].language, "en");
  assert.deepEqual(await language.createChromeLanguageDetector(null)("hello"), {
    isReliable: false,
    languages: []
  });
  const failed = language.createChromeLanguageDetector({
    detectLanguage() {
      throw new Error("unavailable");
    }
  });
  await assert.rejects(failed("hello"), /unavailable/);
});

test("review: async snapshot validation is supported and safely rejects", async () => {
  const jobs = [];
  const events = [];
  const accepted = intent.createIntentController({
    mode: config.SELECTION_MODE.AUTOMATIC,
    getSnapshot: () => ({ selectionKey: "async" }),
    validateSnapshot: async () => true,
    schedule: (callback) => {
      jobs.push(callback);
      return callback;
    },
    cancelSchedule() {},
    onAutomatic: () => events.push("accepted")
  });
  accepted.evaluate({});
  jobs.shift()();
  await Promise.resolve();
  assert.deepEqual(events, ["accepted"]);

  const rejected = intent.createIntentController({
    getSnapshot: () => ({ selectionKey: "reject" }),
    validateSnapshot: async () => {
      throw new Error("stale");
    },
    schedule: (callback) => {
      jobs.push(callback);
      return callback;
    },
    cancelSchedule() {},
    onButton: () => events.push("unexpected")
  });
  rejected.evaluate({});
  jobs.shift()();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["accepted"]);
});

test("review: stable snapshots are revalidated and dedupe is location-aware", () => {
  const jobs = [];
  const events = [];
  let currentSnapshot = { selectionKey: "same" };
  const stable = intent.createIntentController({
    getSnapshot: () => currentSnapshot,
    validateSnapshot: (snapshot) => snapshot.selectionKey === currentSnapshot.selectionKey,
    schedule: (callback) => {
      jobs.push(callback);
      return callback;
    },
    cancelSchedule() {},
    onButton: (snapshot) => events.push(snapshot.selectionKey)
  });
  stable.evaluate({});
  currentSnapshot = { selectionKey: "changed" };
  jobs.shift()();
  assert.deepEqual(events, []);
  stable.evaluate({});
  jobs.shift()();
  assert.deepEqual(events, ["changed"]);

  const first = selectionController.selectionKeyFor({
    text: "hello",
    sourceType: "native",
    frameIdentity: "top",
    anchorRect: { left: 10, top: 10, width: 40, height: 10 }
  });
  const elsewhere = selectionController.selectionKeyFor({
    text: "hello",
    sourceType: "native",
    frameIdentity: "top",
    anchorRect: { left: 200, top: 10, width: 40, height: 10 }
  });
  assert.notEqual(first, elsewhere);
  let now = 1000;
  const deduper = selectionController.createSelectionDeduper({
    cooldownMs: 1500,
    now: () => now
  });
  deduper.record(first);
  assert.equal(deduper.isDuplicate(first), true);
  assert.equal(deduper.isDuplicate(elsewhere), false);
  now += 1501;
  assert.equal(deduper.isDuplicate(first), false);
});

test("review: fallback candidates expose confidence and StaticRange becomes a live Range", () => {
  const candidate = scorer.chooseCandidate([
    { source: "accessibility", text: "Readable accessible phrase" }
  ]);
  assert.ok(candidate.confidence > 0);
  assert.equal(scorer.chooseCandidate([{ source: "bounded", text: "x" }]), null);

  const dom = new JSDOM("<p>static range text</p>");
  const document = dom.window.document;
  const node = document.querySelector("p").firstChild;
  const staticLike = {
    startContainer: node,
    startOffset: 0,
    endContainer: node,
    endOffset: 6
  };
  const live = selectionReader.toLiveRange(staticLike, document);
  assert.equal(live.toString(), "static");
  assert.equal(typeof live.cloneContents, "function");
});

test("review: card size clamp uses the available viewport even below nominal minimum", () => {
  assert.deepEqual(
    positioner.clampSize({ width: 1200, height: 1000 }, { width: 500, height: 300 }),
    { width: 476, height: 276 }
  );
  assert.deepEqual(
    positioner.clampSize({ width: 1200, height: 1000 }, { width: 180, height: 90 }),
    { width: 156, height: 66 }
  );
});

function memoryStorage() {
  const state = {};
  let writes = 0;
  return {
    state,
    get writes() {
      return writes;
    },
    async get(key) {
      if (key === null) return { ...state };
      return { [key]: state[key] };
    },
    async set(value) {
      writes += 1;
      Object.assign(state, value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete state[key];
    }
  };
}

test("review: side-panel handoff is tab/frame/request scoped, expiring and consume-once", async () => {
  let now = 1000;
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: () => now, ttlMs: 100 });
  const first = { tabId: 7, frameId: 2, requestId: "first" };
  const second = { tabId: 7, frameId: 0, requestId: "second" };
  await state.set({ ...first, text: "one" });
  await state.set({ ...second, text: "two" });
  assert.equal((await state.get(first, { consume: true })).text, "one");
  assert.equal(await state.get(first), null);
  assert.equal((await state.get(second)).text, "two");
  now += 101;
  assert.equal(await state.get(second), null);
});

test("review: a cache hit does not rewrite the full session cache immediately", async () => {
  const storage = memoryStorage();
  const translationCache = cache.createTranslationCache(storage);
  await translationCache.set("identity", { text: "cached" });
  const writesAfterSet = storage.writes;
  assert.deepEqual(await translationCache.get("identity"), { text: "cached" });
  assert.equal(storage.writes, writesAfterSet);
  const restartedCache = cache.createTranslationCache(storage);
  assert.deepEqual(await restartedCache.get("identity"), { text: "cached" });
});

test("review: selection controller covers handoff, dedupe, language, stale, and password paths", async (testContext) => {
  const dom = new JSDOM(`<!doctype html><body>
    <p id="text">Foreign text in a paragraph.</p>
    <input id="password" type="password" value="secret">
  </body>`, { url: "https://example.test/page" });
  const documentObject = dom.window.document;
  const cardEvents = [];
  const translations = [];
  let runtimeListener;
  let retry;
  let intentAction;
  let selectionMode = "manual";
  let focusListener;
  const originalAddEventListener = globalThis.addEventListener;
  globalThis.addEventListener = (type, listener) => {
    if (type === "focus") focusListener = listener;
  };
  testContext.after(() => {
    if (originalAddEventListener) globalThis.addEventListener = originalAddEventListener;
    else delete globalThis.addEventListener;
  });
  const card = {
    host: documentObject.createElement("sensemark-test-ui"),
    begin(text) {
      cardEvents.push(["begin", text]);
    },
    appendDelta(delta) {
      cardEvents.push(["delta", delta]);
    },
    complete(result) {
      cardEvents.push(["complete", result.translation]);
    },
    close() {
      cardEvents.push(["close"]);
    },
    hideIntent() {
      cardEvents.push(["hideIntent"]);
    },
    showError(error, action) {
      cardEvents.push(["error", error.message]);
      retry = action;
    },
    showIntentButton(_anchorRect, action) {
      cardEvents.push(["intent"]);
      intentAction = action;
    }
  };
  const controller = selectionController.createSelectionController({
    documentObject,
    languageDetector: async (text) => ({
      isReliable: true,
      languages: [{ language: /русский/i.test(text) ? "ru" : "en", percentage: 99 }]
    }),
    runtime: {
      onMessage: {
        addListener(listener) {
          runtimeListener = listener;
        }
      }
    },
    settingsClient: {
      async get() {
        return {
          selection: { mode: selectionMode, stableDelayMs: 1, requiredModifier: "none" }
        };
      }
    },
    translationClient: {
      translate(requestValue, handlers) {
        translations.push({ request: requestValue, handlers });
      }
    },
    card
  });
  await controller.refreshSettings();
  assert.equal(typeof focusListener, "function");
  focusListener();
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(await controller.translatePlan(null), {
    status: "no-selection",
    reason: ""
  });
  assert.deepEqual(
    await controller.translatePlan({ status: "unsupported", reason: "no-text-layer" }),
    { status: "unsupported", reason: "no-text-layer" }
  );

  function plan(text, selectionKey, snapshotRevision = 0) {
    return {
      request: contracts.createTranslationRequest({ text, sourceScripts: ["Latin"] }),
      anchorRect: { left: 10, top: 20, width: 30, height: 10 },
      selectionKey,
      sourceType: "explicit",
      snapshotRevision,
      status: "ready"
    };
  }

  const firstPlan = plan("foreign text", "first");
  assert.equal((await controller.translatePlan(firstPlan)).status, "accepted");
  assert.equal(translations.length, 1);
  translations[0].handlers.onDelta("Пере");
  translations[0].handlers.onCompleted({ translation: "Перевод" });
  translations[0].handlers.onSkipped();
  translations[0].handlers.onFailed(new Error("offline"));
  assert.equal(typeof retry, "function");
  retry();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(translations.length, 2);
  assert.equal((await controller.translatePlan(firstPlan)).status, "duplicate");

  const russian = plan("Это русский текст", "russian");
  assert.equal((await controller.translatePlan(russian)).status, "skipped-russian");

  documentObject.querySelector("#text").dispatchEvent(
    new dom.window.Event("pointerdown", { bubbles: true, composed: true })
  );
  assert.deepEqual(await controller.translatePlan(plan("stale", "stale")), {
    status: "no-selection",
    reason: "selection-changed"
  });

  const password = documentObject.querySelector("#password");
  password.focus();
  password.setSelectionRange(0, 6);
  password.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  let passwordResponse;
  assert.equal(
    runtimeListener(
      { type: config.MESSAGE.TRANSLATE_SELECTION, text: "secret" },
      {},
      (response) => {
        passwordResponse = response;
      }
    ),
    false
  );
  assert.deepEqual(passwordResponse, { status: "unsupported", reason: "password-field" });

  const paragraph = documentObject.querySelector("#text");
  paragraph.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  let messageResponse;
  const responded = new Promise((resolve) => {
    assert.equal(
      runtimeListener(
        { type: config.MESSAGE.TRANSLATE_SELECTION, text: "message selection" },
        {},
        (response) => {
          messageResponse = response;
          resolve();
        }
      ),
      true
    );
  });
  await responded;
  assert.equal(messageResponse.status, "accepted");
  assert.ok(translations.length >= 3);
  assert.equal(runtimeListener({ type: "unrelated" }, {}, () => {}), undefined);

  assert.equal((await controller.translateCurrent("direct current selection")).status, "accepted");

  function selectParagraph(value) {
    const node = paragraph.firstChild;
    const offset = node.nodeValue.indexOf(value);
    const range = documentObject.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + value.length);
    const selection = documentObject.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    paragraph.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    paragraph.dispatchEvent(new dom.window.Event("pointerup", { bubbles: true }));
  }

  selectionMode = "button";
  await controller.refreshSettings();
  selectParagraph("Foreign");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(typeof intentAction, "function");
  const beforeButton = translations.length;
  intentAction();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(translations.length, beforeButton + 1);

  selectionMode = "automatic";
  await controller.refreshSettings();
  selectParagraph("paragraph");
  const beforeAutomatic = translations.length;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(translations.length, beforeAutomatic + 1);

  documentObject.dispatchEvent(
    new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })
  );
  documentObject.dispatchEvent(
    new dom.window.KeyboardEvent("keyup", { key: "Shift", bubbles: true })
  );
  documentObject.dispatchEvent(new dom.window.Event("copy", { bubbles: true }));
  documentObject.dispatchEvent(new dom.window.Event("selectionchange"));
  assert.ok(cardEvents.some(([name]) => name === "delta"));
  assert.ok(cardEvents.some(([name]) => name === "complete"));
  assert.ok(cardEvents.some(([name]) => name === "error"));
});
