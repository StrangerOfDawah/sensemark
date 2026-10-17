const assert = require("node:assert/strict");
const test = require("node:test");

const { eventHub, loadBackground } = require("../helpers/background.js");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");
const { normalizeSourceScripts } = require("../../src/background/prompts.js");

const sseChunk = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

function createPort() {
  const onDisconnect = eventHub();
  return {
    messages: [],
    onDisconnect,
    postMessage(message) {
      this.messages.push(message);
    },
    disconnect() {
      onDisconnect.emit();
    }
  };
}

function jsonResponse(content, status = 200, detail = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return status >= 200 && status < 300
        ? { choices: [{ message: { content } }] }
        : { error: { message: detail } };
    }
  };
}

function sseResponse(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(chunks[index++]) };
          }
        };
      }
    }
  };
}

test("request preparation blocks missing consent, key, and empty text", async () => {
  await assert.rejects(loadBackground({ settings: { privacyConsentVersion: 0 } }).prepareRequest("Hello"), {
    message: t("errorConsentRequired")
  });
  await assert.rejects(loadBackground({ settings: { apiKey: "" } }).prepareRequest("Hello"), {
    message: t("errorNoApiKey")
  });
  await assert.rejects(loadBackground().prepareRequest("   "), { message: t("errorNothingSelected") });
});

test("source scripts are sanitized, deduplicated, and included in cache identity", async () => {
  const background = loadBackground();
  assert.deepEqual(
    [...normalizeSourceScripts(["Latin", "Arabic", "Latin", "bad-script", 4])],
    ["Latin", "Arabic"]
  );

  const request = await background.prepareRequest("Hello مرحبا", null, false, ["Latin", "Arabic", "Latin"]);
  assert.match(request.cacheKey, /\|text\|Latin,Arabic\|/);
  assert.deepEqual([...request.sourceScripts], ["Latin", "Arabic"]);
});

test("non-streaming translation caches repeated requests", async () => {
  let fetchCount = 0;
  const background = loadBackground({
    fetch: async () => {
      fetchCount++;
      return jsonResponse(`[[text]]\n${RU.helloWorld}`);
    }
  });

  const first = await background.translate("Hello, world!", null, false);
  const second = await background.translate("Hello, world!", null, false);
  assert.equal(first, `[[text]]\n${RU.helloWorld}`);
  assert.equal(second, first);
  assert.equal(fetchCount, 1);
});

test("streaming translation emits cumulative chunks, completion, and cache hits", async () => {
  let fetchCount = 0;
  const background = loadBackground({
    fetch: async () => {
      fetchCount++;
      return sseResponse([
        sseChunk(`[[text]]\n${RU.helloFirstHalf}`),
        `${sseChunk(RU.helloSecondHalf)}data: [DONE]\n\n`
      ]);
    }
  });
  const firstPort = createPort();
  await background.streamTranslate(firstPort, "Hello.", null, false, ["Latin"]);

  assert.deepEqual(
    firstPort.messages.map((message) => message.type),
    ["chunk", "chunk", "done"]
  );
  assert.equal(firstPort.messages[0].text, `[[text]]\n${RU.helloFirstHalf}`);
  assert.equal(firstPort.messages.at(-1).text, `[[text]]\n${RU.helloDot}`);

  const cachedPort = createPort();
  await background.streamTranslate(cachedPort, "Hello.", null, false, ["Latin"]);
  assert.equal(fetchCount, 1);
  assert.equal(cachedPort.messages.length, 1);
  assert.equal(cachedPort.messages[0].type, "done");
  assert.equal(cachedPort.messages[0].text, `[[text]]\n${RU.helloDot}`);
});

test("parallel bilingual title accepts one streamed translation without a repair request", async () => {
  let fetchCount = 0;
  const background = loadBackground({
    fetch: async () => {
      fetchCount++;
      return sseResponse([sseChunk(`[[text]]\n${RU.japaneseDaycares}`), "data: [DONE]\n\n"]);
    }
  });
  const port = createPort();

  await background.streamTranslate(port, "Japanese Daycares – 日本の保育園", null, false, [
    "Latin",
    "Japanese"
  ]);

  assert.equal(fetchCount, 1);
  assert.equal(port.messages.at(-1).type, "done");
  assert.equal(port.messages.at(-1).text, `[[text]]\n${RU.japaneseDaycares}`);
  assert.equal(
    port.messages.some((message) => message.type === "error"),
    false
  );
});

test("disconnecting a stream aborts the fetch without surfacing an error", async () => {
  let capturedSignal = null;
  const background = loadBackground({
    fetch: async (_url, options) => {
      capturedSignal = options.signal;
      return {
        ok: true,
        status: 200,
        body: {
          getReader() {
            return {
              read() {
                return new Promise((_resolve, reject) => {
                  options.signal.addEventListener("abort", () => {
                    const error = new Error("aborted");
                    error.name = "AbortError";
                    reject(error);
                  });
                });
              }
            };
          }
        }
      };
    }
  });
  const port = createPort();
  const pending = background.streamTranslate(port, "Hello.", null, false, ["Latin"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  port.disconnect();
  await pending;

  assert.equal(capturedSignal.aborted, true);
  assert.deepEqual(port.messages, []);
});

test("failed repair is rejected instead of displaying malformed output", async () => {
  const background = loadBackground({
    fetch: async () => jsonResponse("[[skip]]")
  });

  await assert.rejects(
    background.repairResponse(
      { apiKey: "key", model: "gpt-4o-mini" },
      [{ role: "system", content: RU.translateIt }],
      "[[skip]]",
      RU.forbiddenLabel,
      true,
      ["Latin"],
      "Why",
      new AbortController().signal
    ),
    { message: t("errorIncompleteTranslation") }
  );
});

test("API errors receive actionable descriptions", async () => {
  const background = loadBackground();
  assert.equal(await background.describeError(jsonResponse("", 401)), t("errorApi401"));
  assert.equal(await background.describeError(jsonResponse("", 403)), t("errorApi403"));
  assert.match(await background.describeError(jsonResponse("", 404, "unknown model")), /unknown model/);
  assert.equal(await background.describeError(jsonResponse("", 429)), t("errorApi429"));
  assert.match(await background.describeError(jsonResponse("", 500, "server")), /500.*server/);
});

test("old tabs receive all content helpers after an initial ping failure", async () => {
  let attempts = 0;
  const background = loadBackground({
    sendMessage: async () => {
      attempts++;
      if (attempts === 1) throw new Error("missing receiver");
      return { received: true };
    }
  });

  await background.ping(42, 7);
  assert.equal(background.__state.executedScripts.length, 1);
  assert.deepEqual(
    [...background.__state.executedScripts[0].files],
    [
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
  );
  assert.equal(background.__state.sentMessages.length, 2);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("installation creates the context menu and opens the mode choice", async () => {
  const background = loadBackground({ settings: { apiKey: "", provider: "" } });
  background.__events.installed.emit({ reason: "install" });
  await tick();
  assert.equal(background.__state.menuItems[0].id, "translate-selection");
  assert.equal(background.__state.optionsOpened, 1);
  assert.equal(background.__settings.provider, "builtin", "new users start in free mode");
});

test("an update keeps OpenAI for users who already have a key", async () => {
  const withKey = loadBackground({ settings: { provider: "", apiKey: "sk-old", privacyConsentVersion: 0 } });
  withKey.__events.installed.emit({ reason: "update" });
  await tick();
  assert.equal(withKey.__settings.provider, "openai");
  assert.equal(withKey.__state.optionsOpened, 1, "OpenAI mode needs consent");

  const free = loadBackground({ settings: { provider: "", apiKey: "", privacyConsentVersion: 0 } });
  free.__events.installed.emit({ reason: "update" });
  await tick();
  assert.equal(free.__settings.provider, "builtin");
  assert.equal(free.__state.optionsOpened, 0, "free mode does not open settings");
});

test("runtime translate messages keep the response channel open", async () => {
  const background = loadBackground({
    fetch: async () => jsonResponse(`[[text]]\n${RU.helloDot}`)
  });
  let response = null;
  const returns = background.__events.message.emit({ type: "translate", text: "Hello." }, {}, (value) => {
    response = value;
  });
  assert.equal(returns[0], true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(response.ok, true);
  assert.equal(response.text, `[[text]]\n${RU.helloDot}`);
});

test("toolbar icon menu toggles auto-translation and lifts an active pause", async () => {
  const background = loadBackground({ settings: { autoTranslate: true, autoPausedUntil: 0 } });
  background.__events.installed.emit({ reason: "update" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(background.__state.menuItems.map((item) => [item.id, item.contexts[0]]))),
    [
      ["translate-selection", "selection"],
      ["toggle-auto-translate", "action"]
    ]
  );

  await background.onMenuClicked({ menuItemId: "toggle-auto-translate" }, null);
  assert.equal(background.__settings.autoTranslate, false);

  await background.onMenuClicked({ menuItemId: "toggle-auto-translate" }, null);
  assert.equal(background.__settings.autoTranslate, true);

  background.__settings.autoPausedUntil = Date.now() + 60_000;
  await background.onMenuClicked({ menuItemId: "toggle-auto-translate" }, null);
  assert.equal(background.__settings.autoTranslate, true, "lifting the pause keeps auto-translate on");
  assert.equal(background.__settings.autoPausedUntil, 0);
});

test("toolbar icon menu title reflects off, paused and on states", async () => {
  const background = loadBackground({ settings: { autoTranslate: false, autoPausedUntil: 0 } });
  const titles = [];
  const record = async () => {
    await background.refreshAutoMenuTitle();
    titles.push(background.__state.menuUpdates.at(-1).title);
  };
  await record();
  background.__settings.autoTranslate = true;
  background.__settings.autoPausedUntil = Date.now() + 60_000;
  await record();
  background.__settings.autoPausedUntil = 0;
  await record();
  assert.deepEqual(titles, [t("autoMenuEnable"), t("autoMenuResume"), t("autoMenuDisable")]);
});

test("selection context menu item runs the same translation path as the hotkey", async () => {
  const background = loadBackground();
  await background.onMenuClicked({ menuItemId: "translate-selection", frameId: 3 }, { id: 7 });
  assert.deepEqual(JSON.parse(JSON.stringify(background.__state.sentMessages[0])), [
    7,
    { type: "translate-selection" },
    { frameId: 3 }
  ]);
});

test("translation cache survives a service worker restart", async () => {
  const sessionStore = {};
  let calls = 0;
  const fetch = async () => {
    calls++;
    return jsonResponse(`[[text]]\n${RU.helloFriends}`);
  };
  const first = loadBackground({ fetch, sessionStore });
  assert.equal(await first.translate("Hello, my dear friends.", null, false), `[[text]]\n${RU.helloFriends}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Chrome put the service worker to sleep: memory is gone, the browser session stays.
  const restarted = loadBackground({ fetch, sessionStore });
  assert.equal(
    await restarted.translate("Hello, my dear friends.", null, false),
    `[[text]]\n${RU.helloFriends}`
  );
  assert.equal(calls, 1);
});

test("toolbar icon menu offers to turn auto-translate off on a fresh install (on by default)", async () => {
  const background = loadBackground();
  delete background.__settings.autoTranslate;
  await background.refreshAutoMenuTitle();
  assert.equal(background.__state.menuUpdates.at(-1).title, t("autoMenuDisable"));
  await background.onMenuClicked({ menuItemId: "toggle-auto-translate" }, null);
  assert.equal(background.__settings.autoTranslate, false, "the first click turns it off");
});

test("an update never touches a saved OpenAI key, consent or retired model's key", async () => {
  const background = loadBackground({
    settings: { provider: "openai", apiKey: "sk-saved", model: "gpt-4o-mini", privacyConsentVersion: 1 }
  });
  background.__events.installed.emit({ reason: "update" });
  await tick();
  assert.equal(background.__settings.apiKey, "sk-saved");
  assert.equal(background.__settings.provider, "openai");
  assert.equal(background.__settings.privacyConsentVersion, 1);
  assert.equal(background.__state.optionsOpened, 0, "consent already given, settings stay closed");
  for (const write of background.__state.storageWrites) {
    assert.equal("apiKey" in write, false, "an update never overwrites the key");
  }
});

// ---------- Safari: the bridge to the Sensemark app ----------

function askBackground(background, message) {
  return new Promise((resolve) => {
    const results = background.__events.message.emit(message, {}, resolve);
    if (!results.includes(true)) resolve(undefined);
  });
}

test("Safari: native messages go to the Sensemark app and the reply comes back", async () => {
  const calls = [];
  const background = loadBackground({
    sendNativeMessage: async (application, payload) => {
      calls.push({ application, payload });
      return { ok: true, text: RU.hello };
    }
  });
  const reply = await askBackground(background, {
    type: "native",
    payload: { op: "translate", text: "Hello", source: "en", target: "ru" }
  });
  assert.equal(reply.ok, true);
  assert.equal(reply.text, RU.hello);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.op, "translate");
});

test("Safari: a failing native call is reported, not thrown", async () => {
  const background = loadBackground({
    sendNativeMessage: async () => {
      throw new Error("extension host is not running");
    }
  });
  const reply = await askBackground(background, { type: "native", payload: { op: "detect", text: "Hi" } });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "failed");
});

test("Chrome has no native app: native messages answer «unavailable» right away", async () => {
  const background = loadBackground();
  const reply = await askBackground(background, { type: "native", payload: { op: "detect", text: "Hi" } });
  assert.deepEqual(JSON.parse(JSON.stringify(reply)), { ok: false, code: "unavailable" });
});
