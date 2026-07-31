const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const config = require("../shared/config.js");
const contracts = require("../shared/contracts.js");
const errors = require("../shared/errors.js");
const openai = require("../background/providers/openai-provider.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelController } = require("../background/side-panel-controller.js");
const { createCardGrowthController } = require("../content/ui/card-growth-controller.js");
const { createTranslationCard } = require("../content/ui/translation-card.js");
const positioner = require("../content/ui/card-positioner.js");
const context = require("../content/selection/context-extractor.js");
const scorer = require("../content/selection/candidate-scorer.js");
const {
  describeConfigurationValidation
} = require("../extension/configuration-status.js");

function structuredValue(mode) {
  return mode === config.TRANSLATION_MODE.CONTEXTUAL
    ? {
        kind: "translation",
        translation: "банк",
        alternatives: [],
        category: "",
        explanation: ""
      }
    : {
        kind: "multilingual",
        text: "привет",
        sections: [{ script: "Latin", source: "hello", translation: "привет" }]
      };
}

async function structuredTranslation(mode, { finishReason, includeReason = true, content } = {}) {
  const choice = {
    message: {
      content: content === undefined ? JSON.stringify(structuredValue(mode)) : content
    }
  };
  if (includeReason) choice.finish_reason = finishReason;
  const provider = openai.createOpenAiProvider({
    requestClient: {
      async request() {
        return {
          response: new Response(JSON.stringify({ choices: [choice] }), {
            status: 200,
            headers: { "content-type": "application/json" }
          })
        };
      }
    }
  });
  return provider.translate(
    contracts.createTranslationRequest({ text: "bank", mode, sourceScripts: ["Latin"] }),
    { providerSettings: { apiKey: "test-only", model: "gpt-4o-mini" } }
  );
}

async function assertStructuredCompletionMatrix(mode) {
  assert.equal((await structuredTranslation(mode, { finishReason: "stop" })).kind,
    mode === config.TRANSLATION_MODE.CONTEXTUAL ? "translation" : "multilingual");
  for (const [finishReason, code] of [
    ["length", errors.ERROR_CODE.OUTPUT_TRUNCATED],
    ["content_filter", errors.ERROR_CODE.CONTENT_FILTERED],
    [null, errors.ERROR_CODE.INVALID_RESPONSE],
    ["tool_calls", errors.ERROR_CODE.INVALID_RESPONSE],
    ["function_call", errors.ERROR_CODE.INVALID_RESPONSE],
    ["unexpected", errors.ERROR_CODE.INVALID_RESPONSE]
  ]) {
    await assert.rejects(
      structuredTranslation(mode, { finishReason }),
      (error) => error.code === code,
      String(finishReason)
    );
  }
  await assert.rejects(
    structuredTranslation(mode, { includeReason: false }),
    (error) => error.code === errors.ERROR_CODE.INVALID_RESPONSE
  );
  await assert.rejects(
    structuredTranslation(mode, { finishReason: "stop", content: "{" }),
    (error) => error.code === errors.ERROR_CODE.INVALID_RESPONSE
  );
  await assert.rejects(
    structuredTranslation(mode, { finishReason: "stop", content: "" }),
    (error) => error.code === errors.ERROR_CODE.INVALID_RESPONSE
  );
}

test("final: structured contextual completion requires finish_reason stop", async () => {
  await assertStructuredCompletionMatrix(config.TRANSLATION_MODE.CONTEXTUAL);
});

test("final: structured multilingual completion requires finish_reason stop", async () => {
  await assertStructuredCompletionMatrix(config.TRANSLATION_MODE.MULTILINGUAL);
});

function memoryStorage() {
  const values = {};
  return {
    values,
    async get(key) {
      await Promise.resolve();
      if (key === null) return { ...values };
      return { [key]: values[key] };
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

function reliable(language) {
  return { isReliable: true, languages: [{ language, percentage: 99 }] };
}

test("final: side-panel Russian preflight skips reliable Russian without provider work", async () => {
  const events = [];
  const state = {
    prepare(value) {
      return { ...value, createdAt: 1 };
    },
    async store(value) {
      events.push("store");
      return value;
    },
    async clear() {
      events.push("clear");
    }
  };
  const sidePanel = {
    async setOptions() {
      events.push("setOptions");
    },
    async open() {
      events.push("open");
    }
  };
  let providerCalls = 0;
  const controller = createSidePanelController({
    state,
    sidePanel,
    randomId: () => "request",
    detectLanguage: async () => reliable("ru")
  });
  // Only genuinely strong evidence skips: a real sentence with several Russian-only
  // function words. Short fragments deliberately open the panel instead.
  for (const text of [
    "Это очень длинный русский текст, который нужно проверить.",
    "Если сейчас нужно проверить, то это уже сделано."
  ]) {
    assert.deepEqual(await controller.open(7, { text }), { status: "skipped-russian" });
  }
  assert.deepEqual(events, []);
  assert.equal(providerCalls, 0);
});

test("final: non-Russian Cyrillic opens without awaiting language detection", async () => {
  // v1.4.2 awaited chrome.i18n.detectLanguage before sidePanel.open() for every
  // Cyrillic selection, which drops Chrome's transient user activation. Ukrainian,
  // Bulgarian, Serbian and Kazakh text must now reach open() on the gesture stack.
  for (const text of ["Короткий текст", "Как си", "Як справи", "Добар дан", "Сәлем"]) {
    const events = [];
    const controller = createSidePanelController({
      randomId: () => "request",
      detectLanguage: async () => {
        events.push("detect");
        return reliable("uk");
      },
      state: {
        prepare(value) {
          return { ...value, createdAt: 1 };
        },
        async store(value) {
          events.push("store");
          return value;
        },
        async clear() {
          events.push("clear");
        }
      },
      sidePanel: {
        async setOptions() {
          events.push("setOptions");
        },
        async open(options) {
          events.push("open");
          assert.deepEqual(options, { tabId: 9 });
        }
      }
    });
    assert.equal((await controller.open(9, { text, frameId: 3 })).status, "opened");
    // open() is the only extension API on the user-action path; setOptions() is a
    // separate tab-lifecycle concern and is never raced against it.
    assert.deepEqual(events, ["open", "store"]);
    assert.ok(!events.includes("setOptions"), "setOptions must not be in the open path");
    assert.ok(!events.includes("detect"), `${text} must not await detection before open`);
  }
});

test("final: side-panel open is invoked before asynchronous setup settles", async () => {
  const events = [];
  let releaseStore;
  let releaseOptions;
  const storeGate = new Promise((resolve) => {
    releaseStore = resolve;
  });
  const optionsGate = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  const controller = createSidePanelController({
    randomId: () => "gesture",
    detectLanguage: async () => {
      events.push("detect");
      return reliable("en");
    },
    state: {
      prepare(value) {
        return { ...value, createdAt: 1 };
      },
      async store(value) {
        events.push("store");
        await storeGate;
        return value;
      },
      async clear() {
        events.push("clear");
      }
    },
    sidePanel: {
      async setOptions() {
        events.push("setOptions");
        await optionsGate;
      },
      async open() {
        events.push("open");
      }
    }
  });
  const opening = controller.open(9, { text: "foreign text" });
  // open() is reached synchronously, and never behind the storage write.
  assert.deepEqual(events, ["open", "store"]);
  releaseStore();
  releaseOptions();
  assert.equal((await opening).status, "opened");
  assert.ok(!events.includes("detect"));
  assert.ok(!events.includes("setOptions"));
});

test("final: failed side-panel opening clears its pending request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const controller = createSidePanelController({
    state,
    randomId: () => "failed",
    detectLanguage: async () => reliable("en"),
    sidePanel: {
      async setOptions() {},
      async open() {
        throw new Error("user activation expired");
      }
    }
  });
  const result = await controller.open(3, { text: "hello" });
  assert.equal(result.status, "open-failed");
  assert.match(result.error, /user activation/);
  assert.deepEqual(
    Object.keys(storage.values).filter((key) =>
      key.startsWith(config.SIDE_PANEL_PENDING_PREFIX)
    ),
    []
  );
});

test("final: concurrent side-panel consume hands off one request once", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const identity = { tabId: 4, frameId: 2, requestId: "once" };
  await state.set({ ...identity, text: "translate once" });
  const consumed = await Promise.all([state.consume(identity), state.consume(identity)]);
  assert.equal(consumed.filter(Boolean).length, 1);
  let providerStarts = 0;
  for (const pending of consumed) {
    if (pending) providerStarts += 1;
  }
  assert.equal(providerStarts, 1);
  assert.equal(await state.consume(identity), null);
});

class FakeResizeObserver {
  static instances = [];
  constructor(callback) {
    this.callback = callback;
    this.disconnected = false;
    FakeResizeObserver.instances.push(this);
  }
  observe(element) {
    this.element = element;
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(width, height) {
    this.callback([{ contentRect: { width, height } }]);
  }
}

test("final: card ResizeObserver coalesces anchored growth and clamps each result shape", () => {
  FakeResizeObserver.instances.length = 0;
  const frames = [];
  const element = { getBoundingClientRect: () => ({ width: 180, height: 80 }) };
  let position = { left: 0, top: 0 };
  let passes = 0;
  const controller = createCardGrowthController({
    element,
    ResizeObserverClass: FakeResizeObserver,
    scheduleFrame(callback) {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame() {},
    onAnchored() {
      passes += 1;
      position = positioner.positionCard(
        { left: 470, right: 490, top: 370, bottom: 390, width: 20, height: 20 },
        { width: 260, height: 260 },
        { width: 500, height: 400 }
      );
    }
  });
  controller.start();
  const observer = FakeResizeObserver.instances[0];
  for (const height of [180, 280, 340]) observer.emit(260, height);
  for (let index = 0; index < 100; index += 1) observer.emit(260, 341 + index);
  assert.equal(frames.length, 1);
  frames.shift()();
  assert.equal(passes, 1);
  assert.ok(position.left >= 0 && position.top >= 0);
  assert.ok(position.left + 260 <= 500 && position.top + 260 <= 400);
  controller.stop();
  assert.equal(observer.disconnected, true);
});

test("final: card ResizeObserver preserves manual location and only clamps overflow", () => {
  FakeResizeObserver.instances.length = 0;
  const frames = [];
  let position = { left: 220, top: 130 };
  const controller = createCardGrowthController({
    element: { getBoundingClientRect: () => ({ width: 200, height: 100 }) },
    isManual: () => true,
    ResizeObserverClass: FakeResizeObserver,
    scheduleFrame(callback) {
      frames.push(callback);
      return 1;
    },
    cancelFrame() {},
    onManual() {
      position = positioner.clampPosition(
        position,
        { width: 300, height: 260 },
        { width: 500, height: 400 }
      );
    }
  });
  controller.start();
  FakeResizeObserver.instances[0].emit(300, 260);
  frames.shift()();
  assert.deepEqual(position, { left: 192, top: 130 });
  controller.stop();
});

test("final: translation card disconnects growth observer on close and reclamps on scale", () => {
  FakeResizeObserver.instances.length = 0;
  const previous = {
    addEventListener: global.addEventListener,
    cancelAnimationFrame: global.cancelAnimationFrame,
    innerHeight: global.innerHeight,
    innerWidth: global.innerWidth,
    requestAnimationFrame: global.requestAnimationFrame,
    ResizeObserver: global.ResizeObserver
  };
  const frames = [];
  const windowListeners = {};
  global.innerWidth = 500;
  global.innerHeight = 400;
  global.requestAnimationFrame = (callback) => {
    frames.push(callback);
    return frames.length;
  };
  global.cancelAnimationFrame = () => {};
  global.addEventListener = (type, callback) => {
    windowListeners[type] = callback;
  };
  global.ResizeObserver = FakeResizeObserver;
  try {
    const dom = new JSDOM("<!doctype html><html><body><button>before</button></body></html>", {
      pretendToBeVisual: true
    });
    const api = createTranslationCard({ documentObject: dom.window.document });
    const card = api.host.shadowRoot.querySelector(".card");
    card.getBoundingClientRect = () => ({
      left: Number.parseFloat(card.style.left) || 450,
      top: Number.parseFloat(card.style.top) || 350,
      width: 300,
      height: 260
    });
    api.begin("source", {
      left: 470,
      right: 490,
      top: 370,
      bottom: 390,
      width: 20,
      height: 20
    });
    api.complete({ kind: "translation", translation: "long result" });
    while (frames.length) frames.shift()();
    const observer = FakeResizeObserver.instances.at(-1);
    assert.ok(observer);
    observer.emit(300, 300);
    while (frames.length) frames.shift()();
    assert.ok(Number.parseFloat(card.style.left) + 300 <= global.innerWidth);
    assert.ok(Number.parseFloat(card.style.top) + 260 <= global.innerHeight);

    const header = api.host.shadowRoot.querySelector(".header");
    header.dispatchEvent(
      new dom.window.WheelEvent("wheel", { bubbles: true, ctrlKey: true, deltaY: -1 })
    );
    while (frames.length) frames.shift()();
    assert.ok(Number.parseFloat(card.style.left) >= 0);
    windowListeners.resize();
    assert.ok(Number.parseFloat(card.style.top) >= 0);

    api.close();
    assert.equal(observer.disconnected, true);
  } finally {
    Object.assign(global, previous);
  }
});

function rangeFor(document, node, selected, occurrence = 0) {
  let offset = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    offset = node.nodeValue.indexOf(selected, offset + 1);
  }
  const range = document.createRange();
  range.setStart(node, offset);
  range.setEnd(node, offset + selected.length);
  return range;
}

test("final: generic context extraction supports div, span and nested inline applications", () => {
  const divDom = new JSDOM(
    `<div>First sentence. The selected bank is beside the river. Last sentence.</div>`
  );
  const div = divDom.window.document.querySelector("div");
  const divRange = rangeFor(divDom.window.document, div.firstChild, "bank");
  assert.match(context.extractContext({ range: divRange, selectedText: "bank" }), /river/);

  const spanDom = new JSDOM(
    `<div><span>The selected </span><span><strong>bank</strong></span><span> is beside the river.</span></div>`
  );
  const strongText = spanDom.window.document.querySelector("strong").firstChild;
  const spanRange = rangeFor(spanDom.window.document, strongText, "bank");
  assert.match(context.extractContext({ range: spanRange, selectedText: "bank" }), /river/);
});

test("final: generic context uses the selected occurrence and rejects page-scale roots", () => {
  const repeated = "The first bank closed. The second bank is beside the river.";
  const repeatedDom = new JSDOM(`<div>${repeated}</div>`);
  const repeatedNode = repeatedDom.window.document.querySelector("div").firstChild;
  const repeatedRange = rangeFor(repeatedDom.window.document, repeatedNode, "bank", 1);
  const selectedContext = context.extractContext({
    range: repeatedRange,
    selectedText: "bank",
    maximum: 45
  });
  assert.match(selectedContext, /river/);
  assert.doesNotMatch(selectedContext, /closed/);

  const largeDom = new JSDOM(`<div>${"unrelated ".repeat(260)} selected text</div>`);
  const largeNode = largeDom.window.document.querySelector("div").firstChild;
  const largeRange = rangeFor(largeDom.window.document, largeNode, "selected");
  assert.equal(context.extractContext({ range: largeRange, selectedText: "selected" }), null);

  const children = Array.from(
    { length: 20 },
    (_, index) => `<div>Unrelated application panel ${index} with separate content.</div>`
  ).join("");
  const appDom = new JSDOM(`<div id="app"><span>selected</span>${children}</div>`);
  const selectedNode = appDom.window.document.querySelector("span").firstChild;
  const appRange = rangeFor(appDom.window.document, selectedNode, "selected");
  assert.equal(context.extractContext({ range: appRange, selectedText: "selected" }), "selected");
});

test("final: semantic paragraph and contenteditable remain preferred context containers", () => {
  for (const html of [
    `<p>Before <span>selected</span> after semantic paragraph.</p>`,
    `<div contenteditable="true">Before <span>selected</span> after editable text.</div>`
  ]) {
    const dom = new JSDOM(html);
    const node = dom.window.document.querySelector("span").firstChild;
    const range = rangeFor(dom.window.document, node, "selected");
    const container = context.findContextContainer({ range, selectedText: "selected" });
    assert.ok(container.matches("p,[contenteditable='true']"));
    assert.match(context.extractContext({ range, selectedText: "selected" }), /after/);
    assert.equal(context.extractContext({ range, selectedText: "absent" }), null);
  }
});

function validationProvider(responseFactory) {
  const requests = [];
  return {
    requests,
    provider: openai.createOpenAiProvider({
      requestClient: {
        async request(url, options) {
          requests.push({ url, options });
          return { response: responseFactory() };
        }
      }
    })
  };
}

test("final: provider validation distinguishes verified and unverified models", async () => {
  for (const [model, compatibility] of [
    ["gpt-4o-mini", "verified"],
    ["custom-existing-model", "unverified"]
  ]) {
    const fixture = validationProvider(() => new Response("{}", { status: 200 }));
    const result = await fixture.provider.validateConfiguration({ apiKey: "test-only", model });
    assert.deepEqual(result, {
      validCredentials: true,
      modelExists: true,
      compatibility
    });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0].options.method, "GET");
    assert.doesNotMatch(JSON.stringify(result), /test-only/);
  }
  assert.match(
    describeConfigurationValidation({
      validCredentials: true,
      modelExists: true,
      compatibility: "verified"
    }),
    /поддерживается Sensemark/
  );
  assert.match(
    describeConfigurationValidation({
      validCredentials: true,
      modelExists: true,
      compatibility: "unverified"
    }),
    /не проверена/
  );
});

test("final: provider validation normalizes key, permission, model, quota and outage errors", async () => {
  for (const [status, body, code] of [
    [401, {}, errors.ERROR_CODE.INVALID_API_KEY],
    [403, {}, errors.ERROR_CODE.PERMISSION_DENIED],
    [404, { error: { code: "model_not_found" } }, errors.ERROR_CODE.MODEL_NOT_FOUND],
    [429, { error: { code: "insufficient_quota" } }, errors.ERROR_CODE.QUOTA_EXHAUSTED],
    [503, {}, errors.ERROR_CODE.SERVICE_UNAVAILABLE]
  ]) {
    const fixture = validationProvider(
      () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    );
    await assert.rejects(
      fixture.provider.validateConfiguration({ apiKey: "test-only", model: "gpt-4o-mini" }),
      (error) => error.code === code
    );
  }
  const missing = validationProvider(() => new Response("{}", { status: 200 }));
  await assert.rejects(
    missing.provider.validateConfiguration({ apiKey: "test-only", model: "" }),
    (error) => error.code === errors.ERROR_CODE.INVALID_REQUEST
  );
  assert.equal(missing.requests.length, 0);
});

test("final: selection candidates are normalized, deduplicated and keep highest trust", () => {
  const deduplicated = scorer.deduplicateCandidates([
    { source: "range", text: "same   words" },
    { source: "native", text: "same words", marker: "trusted" },
    { source: "accessibility", text: "same words" },
    { source: "clone", text: "first paragraph\n\nsecond paragraph" },
    { source: "clone", text: "first paragraph second paragraph" }
  ]);
  assert.equal(deduplicated.length, 3);
  assert.equal(deduplicated[0].source, "native");
  assert.equal(deduplicated[0].marker, "trusted");
  assert.notEqual(deduplicated[1].text, deduplicated[2].text);
  const best = scorer.chooseCandidate([
    { source: "range", text: "Readable duplicate text" },
    { source: "native", text: "Readable duplicate text" }
  ]);
  assert.equal(best.source, "native");
  assert.ok(best.confidence > 0);
});

test("final: manifest requires Chrome 119 and all declared runtime paths exist", () => {
  const root = path.resolve(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "1.4.2");
  assert.equal(manifest.minimum_chrome_version, "119");
  const entry = manifest.content_scripts[0];
  assert.equal(entry.all_frames, true);
  assert.equal(entry.match_about_blank, true);
  assert.equal(entry.match_origin_as_fallback, true);
  for (const file of entry.js) assert.equal(fs.existsSync(path.join(root, file)), true, file);
  assert.equal(fs.existsSync(path.join(root, manifest.side_panel.default_path)), true);
});
