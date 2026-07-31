const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const { createTranslationClient } = require("../content/translation-client.js");

function fakeRuntime() {
  let port;
  return {
    connectOptions: null,
    connect(options) {
      this.connectOptions = options;
      const messageListeners = [];
      const disconnectListeners = [];
      port = {
        sent: [],
        disconnected: false,
        onMessage: { addListener: (listener) => messageListeners.push(listener) },
        onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
        postMessage(message) {
          this.sent.push(message);
        },
        disconnect() {
          this.disconnected = true;
          for (const listener of disconnectListeners) listener();
        },
        emit(message) {
          for (const listener of messageListeners) listener(message);
        }
      };
      return port;
    },
    get port() {
      return port;
    }
  };
}

test("translation client forwards true deltas and one structured completion", () => {
  const runtime = fakeRuntime();
  const client = createTranslationClient(runtime);
  const events = [];
  client.translate(
    { requestId: "request-1", text: "hello" },
    {
      onStarted: () => events.push("started"),
      onDelta: (delta) => events.push(delta),
      onCompleted: (result) => events.push(result.text)
    }
  );
  assert.equal(runtime.connectOptions.name, config.PORTS.TRANSLATION);
  assert.deepEqual(runtime.port.sent, [
    { type: "translation.start", request: { requestId: "request-1", text: "hello" } }
  ]);
  runtime.port.emit({ type: "translation.started", requestId: "request-1" });
  runtime.port.emit({ type: "translation.delta", requestId: "request-1", delta: "При" });
  runtime.port.emit({ type: "translation.delta", requestId: "request-1", delta: "вет" });
  runtime.port.emit({
    type: "translation.completed",
    requestId: "request-1",
    result: { text: "Привет" }
  });
  assert.deepEqual(events, ["started", "При", "вет", "Привет"]);
  assert.equal(runtime.port.disconnected, true);
});

test("new request and explicit cancel stop the previous port", () => {
  const runtime = fakeRuntime();
  const client = createTranslationClient(runtime);
  client.translate({ requestId: "one" });
  const firstPort = runtime.port;
  client.translate({ requestId: "two" });
  assert.deepEqual(firstPort.sent.at(-1), { type: "translation.cancel", requestId: "one" });
  assert.equal(firstPort.disconnected, true);
  client.cancel();
  assert.deepEqual(runtime.port.sent.at(-1), {
    type: "translation.cancel",
    requestId: "two"
  });
});

test("stale and failed messages are scoped to the current request", () => {
  const runtime = fakeRuntime();
  const client = createTranslationClient(runtime);
  const failures = [];
  client.translate(
    { requestId: "current" },
    { onDelta: () => assert.fail("stale delta"), onFailed: (error) => failures.push(error.code) }
  );
  runtime.port.emit({ type: "translation.delta", requestId: "old", delta: "bad" });
  runtime.port.emit({
    type: "translation.failed",
    requestId: "current",
    error: { code: "network", message: "offline" }
  });
  assert.deepEqual(failures, ["network"]);
});
