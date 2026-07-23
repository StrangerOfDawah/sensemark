const assert = require("node:assert/strict");
const test = require("node:test");

const { eventHub, loadBackground } = require("./helpers/background.js");

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
  await assert.rejects(
    loadBackground({ settings: { privacyConsentVersion: 0 } }).prepareRequest("Hello"),
    /подтвердите отправку/i
  );
  await assert.rejects(
    loadBackground({ settings: { apiKey: "" } }).prepareRequest("Hello"),
    /Не задан API-ключ/
  );
  await assert.rejects(loadBackground().prepareRequest("   "), /Ничего не выделено/);
});

test("source scripts are sanitized, deduplicated, and included in cache identity", async () => {
  const background = loadBackground();
  assert.deepEqual(
    [...background.normalizeSourceScripts(["Latin", "Arabic", "Latin", "bad-script", 4])],
    ["Latin", "Arabic"]
  );

  const request = await background.prepareRequest(
    "Hello مرحبا",
    null,
    false,
    ["Latin", "Arabic", "Latin"]
  );
  assert.match(request.cacheKey, /\|text\|Latin,Arabic\|/);
  assert.deepEqual([...request.sourceScripts], ["Latin", "Arabic"]);
});

test("non-streaming translation caches repeated requests", async () => {
  let fetchCount = 0;
  const background = loadBackground({
    fetch: async () => {
      fetchCount++;
      return jsonResponse("[[text]]\nПривет, мир!");
    }
  });

  const first = await background.translate("Hello, world!", null, false);
  const second = await background.translate("Hello, world!", null, false);
  assert.equal(first, "[[text]]\nПривет, мир!");
  assert.equal(second, first);
  assert.equal(fetchCount, 1);
});

test("streaming translation emits cumulative chunks, completion, and cache hits", async () => {
  let fetchCount = 0;
  const background = loadBackground({
    fetch: async () => {
      fetchCount++;
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"[[text]]\\nПри"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"вет."}}]}\n\ndata: [DONE]\n\n'
      ]);
    }
  });
  const firstPort = createPort();
  await background.streamTranslate(firstPort, "Hello.", null, false, ["Latin"]);

  assert.deepEqual(
    firstPort.messages.map((message) => message.type),
    ["chunk", "chunk", "done"]
  );
  assert.equal(firstPort.messages[0].text, "[[text]]\nПри");
  assert.equal(firstPort.messages.at(-1).text, "[[text]]\nПривет.");

  const cachedPort = createPort();
  await background.streamTranslate(cachedPort, "Hello.", null, false, ["Latin"]);
  assert.equal(fetchCount, 1);
  assert.equal(cachedPort.messages.length, 1);
  assert.equal(cachedPort.messages[0].type, "done");
  assert.equal(cachedPort.messages[0].text, "[[text]]\nПривет.");
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
      [{ role: "system", content: "Переведи." }],
      "[[skip]]",
      "Запрещённая метка.",
      true,
      ["Latin"],
      "Why",
      new AbortController().signal
    ),
    /Не удалось получить полный перевод/
  );
});

test("API errors receive actionable Russian descriptions", async () => {
  const background = loadBackground();
  assert.match(await background.describeError(jsonResponse("", 401)), /Неверный API-ключ/);
  assert.match(await background.describeError(jsonResponse("", 403)), /Доступ запрещён/);
  assert.match(
    await background.describeError(jsonResponse("", 404, "unknown model")),
    /unknown model/
  );
  assert.match(await background.describeError(jsonResponse("", 429)), /баланс/);
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
      "language-detection.js",
      "selection-text.js",
      "word-response.js",
      "text-response.js",
      "ui-scale.js",
      "content.js"
    ]
  );
  assert.equal(background.__state.sentMessages.length, 2);
});

test("installation creates the context menu and opens mandatory consent settings", async () => {
  const background = loadBackground();
  background.__events.installed.emit({ reason: "install" });
  assert.equal(background.__state.menuItems[0].id, "translate-selection");
  assert.equal(background.__state.optionsOpened, 1);

  const updated = loadBackground({ settings: { privacyConsentVersion: 0 } });
  updated.__events.installed.emit({ reason: "update" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(updated.__state.optionsOpened, 1);
});

test("runtime translate messages keep the response channel open", async () => {
  const background = loadBackground({
    fetch: async () => jsonResponse("[[text]]\nПривет.")
  });
  let response = null;
  const returns = background.__events.message.emit(
    { type: "translate", text: "Hello." },
    {},
    (value) => {
      response = value;
    }
  );
  assert.equal(returns[0], true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(response.ok, true);
  assert.equal(response.text, "[[text]]\nПривет.");
});
