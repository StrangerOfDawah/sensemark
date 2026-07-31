const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../shared/config.js");
const language = require("../shared/language-utils.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelHandoff } = require("../background/side-panel-handoff.js");
const { createSidePanelController } = require("../background/side-panel-controller.js");
const {
  createSidePanelHandoffClient
} = require("../extension/side-panel-handoff-client.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * These tests reproduce the v1.4.2 side-panel handoff races.
 *
 * On the pre-fix implementation they fail: the panel performed a single pending
 * lookup keyed by a request identity carried in a dynamically assigned side-panel
 * URL, so a panel that loaded before `state.store()` resolved received null and
 * never retried, and an `open()` that won the race against `setOptions()` opened a
 * panel with no identity at all.
 */

function memoryStorage() {
  const values = {};
  return {
    values,
    async get(key) {
      await Promise.resolve();
      if (key === null || key === undefined) return { ...values };
      if (Array.isArray(key)) {
        return Object.fromEntries(key.filter((item) => item in values).map((item) => [item, values[item]]));
      }
      return key in values ? { [key]: values[key] } : {};
    },
    async set(next) {
      Object.assign(values, next);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

async function flush(rounds = 40) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

/** Deterministic clock so every retry budget in these tests is explicit. */
function createClock() {
  let time = 1000;
  let sequence = 0;
  const scheduled = new Map();
  const api = {
    setTimeout(callback, delay) {
      const id = (sequence += 1);
      scheduled.set(id, { callback, at: time + Number(delay || 0) });
      return id;
    },
    clearTimeout(id) {
      scheduled.delete(id);
    }
  };
  async function advance(ms) {
    const target = time + ms;
    for (;;) {
      const due = [...scheduled.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((left, right) => left[1].at - right[1].at);
      if (!due.length) break;
      const [id, entry] = due[0];
      scheduled.delete(id);
      time = entry.at;
      entry.callback();
      await flush();
    }
    time = target;
    await flush();
  }
  return { advance, api, now: () => time, pending: () => scheduled.size };
}

/** A Chrome-like message port pair with asynchronous delivery. */
function createPortPair(name, sender) {
  let connected = true;
  const listeners = {
    worker: { message: [], disconnect: [] },
    client: { message: [], disconnect: [] }
  };
  function makePort(side, other) {
    return {
      name,
      sender: side === "worker" ? sender : undefined,
      postMessage(message) {
        if (!connected) throw new Error("Attempting to use a disconnected port object");
        queueMicrotask(() => {
          if (!connected) return;
          for (const listener of [...listeners[other].message]) listener(message);
        });
      },
      disconnect() {
        if (!connected) return;
        connected = false;
        for (const listener of [...listeners[other].disconnect]) listener();
      },
      onMessage: { addListener: (fn) => listeners[side].message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners[side].disconnect.push(fn) }
    };
  }
  return {
    workerPort: makePort("worker", "client"),
    clientPort: makePort("client", "worker"),
    isConnected: () => connected
  };
}

/**
 * Wire a real state + handoff registry + panel client together.
 * `storeDelay` lets a test hold the storage write open across the panel load.
 */
function createHarness({ storeDelay = 0, senderTab, resolveActiveTab } = {}) {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const releases = [];
  const slowState = {
    ...state,
    async store(value) {
      if (storeDelay > 0) {
        await new Promise((resolve) => {
          releases.push(resolve);
          clock.api.setTimeout(resolve, storeDelay);
        });
      }
      return state.store(value);
    }
  };
  const handoff = createSidePanelHandoff({
    state,
    now: clock.now,
    resolveActiveTab
  });
  const opened = [];
  const controller = createSidePanelController({
    state: slowState,
    handoff,
    randomId: () => `request-${opened.length + 1}`,
    detectLanguage: async () => ({ isReliable: false, languages: [] }),
    sidePanel: {
      async setOptions(options) {
        opened.push({ type: "setOptions", ...options });
      },
      async open(options) {
        opened.push({ type: "open", ...options });
      }
    }
  });

  const panels = [];
  function attachPanel({ windowId = 1 } = {}) {
    const pair = createPortPair(config.PORTS.SIDE_PANEL, senderTab ? { tab: senderTab } : undefined);
    const translated = [];
    const outcomes = [];
    const client = createSidePanelHandoffClient({
      runtime: {
        connect() {
          handoff.connect(pair.workerPort);
          return pair.clientPort;
        }
      },
      windows: { getCurrent: async () => ({ id: windowId }) },
      timers: clock.api,
      now: clock.now,
      onRequest: (pending) => translated.push(pending),
      onTimeout: () => outcomes.push("timeout"),
      onIdle: () => outcomes.push("idle")
    });
    const panel = { client, outcomes, pair, translated };
    panels.push(panel);
    return panel;
  }

  return {
    attachPanel,
    clock,
    controller,
    handoff,
    opened,
    panels,
    state,
    storage
  };
}

test("handoff: a panel ready before the storage write still receives the request", async () => {
  // Race A. The panel loads, asks for its pending request and finds nothing, because
  // state.store() has not resolved yet. Pre-fix this ended with an empty panel and a
  // stale record left in session storage.
  const harness = createHarness({ storeDelay: 500 });
  const opening = harness.controller.open(1, { text: "hello", windowId: 1, frameId: 0 });

  const panel = harness.attachPanel({ windowId: 1 });
  await panel.client.start();
  await flush();

  // Storage has genuinely not landed yet.
  assert.deepEqual(harness.storage.values, {});
  assert.equal(panel.translated.length, 0);
  // ...but the panel was told a handoff is coming, so it is waiting rather than idle.
  assert.deepEqual(panel.outcomes, []);

  await harness.clock.advance(600);
  assert.equal((await opening).status, "opened");
  await harness.clock.advance(200);

  assert.equal(panel.translated.length, 1, "exactly one translation must start");
  assert.equal(panel.translated[0].text, "hello");
  assert.deepEqual(harness.storage.values, {}, "no stale pending record may remain");
  assert.deepEqual(panel.outcomes, [], "a delivered handoff is neither idle nor a timeout");
  assert.equal(panel.client.outcome(), "delivered");
});

test("handoff: storage landing before the panel is ready hands off exactly once", async () => {
  const harness = createHarness();
  assert.equal((await harness.controller.open(1, { text: "already stored", windowId: 1 })).status, "opened");
  assert.equal(Object.keys(harness.storage.values).length, 1);

  const panel = harness.attachPanel({ windowId: 1 });
  await panel.client.start();
  await flush();

  assert.equal(panel.translated.length, 1);
  assert.equal(panel.translated[0].text, "already stored");
  assert.deepEqual(harness.storage.values, {});
});

test("handoff: request identity never travels in the side-panel URL", async () => {
  // Race B. With a per-request query string, an open() that beat setOptions() opened
  // the manifest default path and the panel could not identify its request at all.
  const harness = createHarness();
  await harness.controller.open(4, { text: "static path", windowId: 2, requestId: "abc" });
  const options = harness.opened.find((entry) => entry.type === "setOptions");
  assert.equal(options.path, "sidepanel/sidepanel.html");
  assert.doesNotMatch(options.path, /[?&]/, "no query string may be assigned");

  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(options.path, manifest.side_panel.default_path, "must equal the manifest default");

  // The panel page must not read identity out of its own location.
  const panelSource = read("sidepanel/sidepanel.js");
  assert.doesNotMatch(panelSource, /location\.search|URLSearchParams/);
  assert.doesNotMatch(read("extension/side-panel-handoff-client.js"), /location\.search|URLSearchParams/);
});

test("handoff: open resolving before setOptions still delivers the request", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const handoff = createSidePanelHandoff({ state, now: clock.now });
  const order = [];
  let releaseOptions;
  const optionsGate = new Promise((resolve) => {
    releaseOptions = resolve;
  });
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "out-of-order",
    sidePanel: {
      async setOptions() {
        await optionsGate;
        order.push("setOptions");
      },
      async open() {
        order.push("open");
      }
    }
  });
  const opening = controller.open(6, { text: "out of order", windowId: 3 });
  await flush();
  assert.deepEqual(order, ["open"], "open must settle first in this scenario");
  releaseOptions();
  assert.equal((await opening).status, "opened");
  assert.deepEqual(order, ["open", "setOptions"]);

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 3 });
  await flush();

  assert.equal(received.length, 1);
  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "out of order");
});

test("handoff: concurrent ready and claim events produce exactly one consumer", async () => {
  const harness = createHarness();
  await harness.controller.open(1, { text: "only once", windowId: 1 });

  const first = harness.attachPanel({ windowId: 1 });
  const second = harness.attachPanel({ windowId: 1 });
  await Promise.all([first.client.start(), second.client.start()]);
  await flush();

  const total = first.translated.length + second.translated.length;
  assert.equal(total, 1, "exactly one provider call may start");
  assert.deepEqual(harness.storage.values, {});
});

test("handoff: a claim is single-use even under simultaneous state.claim calls", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  await state.set({ tabId: 5, frameId: 0, windowId: 1, requestId: "single", text: "one" });
  const claims = await Promise.all([
    state.claim({ tabId: 5 }),
    state.claim({ tabId: 5 }),
    state.claim({ tabId: 5 })
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await state.claim({ tabId: 5 }), null);
});

test("handoff: reloading the panel does not translate a consumed request again", async () => {
  const harness = createHarness();
  await harness.controller.open(1, { text: "translate once", windowId: 1 });

  const first = harness.attachPanel({ windowId: 1 });
  await first.client.start();
  await flush();
  assert.equal(first.translated.length, 1);

  // A reload is a brand new panel document against the same worker.
  first.client.stop();
  const reloaded = harness.attachPanel({ windowId: 1 });
  await reloaded.client.start();
  await harness.clock.advance(config.SIDE_PANEL_HANDOFF_TIMEOUT_MS + 100);

  assert.equal(reloaded.translated.length, 0, "a consumed request must not reappear");
  assert.deepEqual(reloaded.outcomes, ["idle"], "a reload is an ordinary manual panel");
});

test("handoff: a service-worker restart keeps the request claimable exactly once", async () => {
  const clock = createClock();
  const storage = memoryStorage();

  // Worker generation 1 stores the request, then dies before the panel claims it.
  const firstState = createSidePanelState(storage, { now: clock.now });
  const firstHandoff = createSidePanelHandoff({ state: firstState, now: clock.now });
  const controller = createSidePanelController({
    state: firstState,
    handoff: firstHandoff,
    randomId: () => "survives-restart",
    sidePanel: { async setOptions() {}, async open() {} }
  });
  await controller.open(8, { text: "survives restart", windowId: 4 });
  assert.equal(Object.keys(storage.values).length, 1);

  // Worker generation 2: fresh in-memory registry, same session storage.
  const secondState = createSidePanelState(storage, { now: clock.now });
  const secondHandoff = createSidePanelHandoff({ state: secondState, now: clock.now });
  assert.equal(secondHandoff.intentFor({ windowId: 4 }), null, "intents do not survive a restart");

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  secondHandoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 4 });
  await flush();

  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "survives restart");
  assert.deepEqual(storage.values, {}, "the record is consumed, not duplicated");

  pair.clientPort.postMessage({ type: config.SIDE_PANEL.CLAIM, windowId: 4 });
  await flush();
  assert.equal(received[1].type, config.SIDE_PANEL.IDLE, "no duplicate translation after restart");
});

test("handoff: a failed panel opening cleans pending state and leaks nothing later", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const handoff = createSidePanelHandoff({ state, now: clock.now });
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "doomed",
    sidePanel: {
      async setOptions() {},
      async open() {
        throw new Error("`sidePanel.open()` may only be called in response to a user gesture.");
      }
    }
  });
  const result = await controller.open(3, { text: "never shown", windowId: 5 });
  assert.equal(result.status, "open-failed");
  assert.match(result.error, /user gesture/);
  assert.deepEqual(storage.values, {}, "pending state must be cleaned");
  assert.equal(handoff.intentFor({ windowId: 5 }), null, "the handoff intent must be dropped");

  // A panel opened later by the user must not pick up the abandoned text.
  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 5 });
  await flush();
  assert.equal(received[0].type, config.SIDE_PANEL.IDLE);
});

test("handoff: a lost handoff times out visibly with bounded retries", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const handoff = createSidePanelHandoff({ state, now: clock.now });

  // Announce an intent whose storage write never lands: the worst case the panel
  // must survive without hanging on an empty screen.
  handoff.announce({ tabId: 2, frameId: 0, windowId: 7, requestId: "lost" });

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  let claims = 0;
  handoff.connect(pair.workerPort);
  pair.workerPort.onMessage.addListener((message) => {
    if (message.type === config.SIDE_PANEL.CLAIM) claims += 1;
  });

  const outcomes = [];
  const client = createSidePanelHandoffClient({
    runtime: { connect: () => pair.clientPort },
    windows: { getCurrent: async () => ({ id: 7 }) },
    timers: clock.api,
    now: clock.now,
    onRequest: () => outcomes.push("request"),
    onTimeout: () => outcomes.push("timeout"),
    onIdle: () => outcomes.push("idle")
  });
  await client.start();
  await clock.advance(config.SIDE_PANEL_HANDOFF_TIMEOUT_MS + 50);

  assert.deepEqual(outcomes, ["timeout"], "the user must see a typed failure, not a blank panel");
  assert.ok(claims > 1, "the panel retries rather than giving up after one lookup");
  const maxAttempts = Math.ceil(
    config.SIDE_PANEL_HANDOFF_TIMEOUT_MS / config.SIDE_PANEL_CLAIM_RETRY_MS
  ) + 2;
  assert.ok(claims <= maxAttempts, `retries must be bounded, saw ${claims}`);

  const before = claims;
  await clock.advance(10_000);
  assert.equal(claims, before, "polling must stop at the deadline, never run unbounded");
  assert.deepEqual(outcomes, ["timeout"], "no repeated failures after the deadline");
});

test("handoff: the timeout message is user-visible and wired to the panel view", () => {
  const panelSource = read("sidepanel/sidepanel.js");
  assert.match(panelSource, /onTimeout/);
  assert.match(panelSource, /Не удалось получить выделенный текст/);
  assert.match(panelSource, /view\.failed/);
});

test("handoff: two tabs stay isolated", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  await state.set({ tabId: 11, frameId: 0, windowId: 1, requestId: "tab-a", text: "text A" });
  await state.set({ tabId: 22, frameId: 0, windowId: 2, requestId: "tab-b", text: "text B" });

  const forTabA = await state.claim({ tabId: 11, windowId: 1 });
  assert.equal(forTabA.text, "text A");
  // Tab B's request is untouched by tab A's panel.
  assert.equal(await state.claim({ tabId: 11, windowId: 1 }), null);
  const forTabB = await state.claim({ tabId: 22, windowId: 2 });
  assert.equal(forTabB.text, "text B");
});

test("handoff: a panel never claims another window's request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  await state.set({ tabId: 30, frameId: 0, windowId: 100, requestId: "w100", text: "window 100" });

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 200 });
  await flush();

  assert.equal(received[0].type, config.SIDE_PANEL.IDLE, "window 200 must not see window 100's text");
  assert.equal(Object.keys(storage.values).length, 1, "the other window's record is untouched");
});

test("handoff: a mismatched tab identity claims nothing", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  await state.set({ tabId: 40, frameId: 0, windowId: 9, requestId: "real", text: "tab 40" });
  assert.equal(await state.claim({ tabId: 41, windowId: 9 }), null, "tab id wins over window id");
  assert.equal(await state.claim({ tabId: 40, windowId: 9 }).then((item) => item.text), "tab 40");
});

test("handoff: frames within one tab share the tab's newest request", async () => {
  const storage = memoryStorage();
  let now = 1000;
  const state = createSidePanelState(storage, { now: () => now });
  await state.set({ tabId: 50, frameId: 0, windowId: 1, requestId: "frame-0", text: "main frame" });
  now += 10;
  const newest = state.prepare({
    tabId: 50,
    frameId: 7,
    windowId: 1,
    requestId: "frame-7",
    text: "child frame"
  });
  await state.store(newest);
  const claimed = await state.claim({ tabId: 50, windowId: 1 });
  assert.equal(claimed.text, "child frame");
  assert.equal(claimed.frameId, 7);
});

test("handoff: a newer request in one tab supersedes the older unclaimed one", async () => {
  // Documented policy: newest wins. A stale selection can never be handed to the
  // panel in place of the one the user just made.
  const storage = memoryStorage();
  let now = 1000;
  const state = createSidePanelState(storage, { now: () => now });
  await state.set({ tabId: 60, frameId: 0, windowId: 1, requestId: "older", text: "older text" });
  now += 50;
  const newer = state.prepare({
    tabId: 60,
    frameId: 0,
    windowId: 1,
    requestId: "newer",
    text: "newer text"
  });
  await state.store(newer);
  assert.equal(await state.supersede(newer), 1, "the older record is dropped");
  assert.equal(Object.keys(storage.values).length, 1);
  const claimed = await state.claim({ tabId: 60, windowId: 1 });
  assert.equal(claimed.text, "newer text");
  assert.equal(await state.claim({ tabId: 60, windowId: 1 }), null, "no stale record survives");
});

test("handoff: a stale request id is expired rather than delivered", async () => {
  const storage = memoryStorage();
  let now = 1000;
  const state = createSidePanelState(storage, { now: () => now, ttlMs: 100 });
  await state.set({ tabId: 70, frameId: 0, windowId: 1, requestId: "stale", text: "old news" });
  now += 500;
  assert.equal(await state.claim({ tabId: 70, windowId: 1 }), null);
  assert.deepEqual(storage.values, {});
});

test("handoff: sender.tab identity is preferred over the reported window", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  await state.set({ tabId: 80, frameId: 0, windowId: 1, requestId: "sender", text: "from sender tab" });

  const pair = createPortPair(config.PORTS.SIDE_PANEL, { tab: { id: 80, windowId: 1 } });
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  // A deliberately wrong windowId must not matter when the sender tab is known.
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 999 });
  await flush();
  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "from sender tab");
});

test("handoff: the active tab of the panel's window resolves the claim scope", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    resolveActiveTab: async (windowId) => (windowId === 12 ? 90 : null)
  });
  await state.set({ tabId: 90, frameId: 0, windowId: null, requestId: "active", text: "active tab" });

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 12 });
  await flush();
  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "active tab");
});

test("handoff: a selection made while the panel is already open is pushed to it", async () => {
  const harness = createHarness();
  const panel = harness.attachPanel({ windowId: 1 });
  await panel.client.start();
  await harness.clock.advance(config.SIDE_PANEL_HANDOFF_TIMEOUT_MS + 50);
  assert.deepEqual(panel.outcomes, ["idle"], "an unprompted panel is idle, not an error");

  await harness.controller.open(1, { text: "later selection", windowId: 1 });
  await harness.clock.advance(50);
  assert.equal(panel.translated.length, 1);
  assert.equal(panel.translated[0].text, "later selection");
});

/**
 * User-activation adapter tests.
 *
 * These assert call ORDERING only. Node cannot model Chrome's transient user
 * activation, so a green run here is not evidence that `sidePanel.open()` succeeds
 * in a real browser — that remains a manual Chrome gate.
 */
test("activation adapter: no awaited work precedes sidePanel.open() for any script", async () => {
  for (const text of [
    "foreign text",
    "Як справи",
    "Как си",
    "Добар дан",
    "Сәлем",
    "こんにちは",
    "مرحبا"
  ]) {
    const order = [];
    const controller = createSidePanelController({
      randomId: () => "activation",
      detectLanguage: async () => {
        order.push("detect");
        return { isReliable: true, languages: [{ language: "ru", percentage: 99 }] };
      },
      state: {
        prepare: (value) => ({ ...value, createdAt: 1 }),
        store: async (value) => {
          order.push("store");
          return value;
        },
        clear: async () => {}
      },
      handoff: {
        announce: () => order.push("announce"),
        publish: () => {},
        abandon: () => {}
      },
      sidePanel: {
        setOptions: async () => order.push("setOptions"),
        open: async () => order.push("open")
      }
    });
    const opening = controller.open(1, { text, windowId: 1 });
    // Synchronously after the call, open() has already been reached.
    assert.deepEqual(
      order,
      ["announce", "setOptions", "open", "store"],
      `unexpected ordering for: ${text}`
    );
    assert.ok(!order.includes("detect"), `${text} must not await detection before open`);
    await opening;
  }
});

test("activation adapter: only a confident synchronous Russian verdict skips opening", () => {
  for (const text of [
    "Это русский текст",
    "APP_ENV должен быть production",
    "Сейчас нужно проверить очень внимательно"
  ]) {
    assert.equal(language.synchronousRussianVerdict(text), "russian", text);
  }
  for (const text of [
    "Як справи",
    "Как си",
    "Добар дан",
    "Сәлем",
    "Кароткі тэкст",
    "Короткий текст",
    "Привет hello world together"
  ]) {
    assert.notEqual(language.synchronousRussianVerdict(text), "russian", text);
  }
  for (const text of ["foreign text", "こんにちは", ""]) {
    assert.equal(language.synchronousRussianVerdict(text), "not-russian", text);
  }
});

test("activation adapter: a confident Russian selection never opens the panel", async () => {
  const events = [];
  const controller = createSidePanelController({
    randomId: () => "russian",
    detectLanguage: async () => {
      events.push("detect");
      return { isReliable: true, languages: [{ language: "ru", percentage: 99 }] };
    },
    state: {
      prepare: (value) => ({ ...value, createdAt: 1 }),
      store: async (value) => {
        events.push("store");
        return value;
      },
      clear: async () => events.push("clear")
    },
    sidePanel: {
      setOptions: async () => events.push("setOptions"),
      open: async () => events.push("open")
    }
  });
  assert.deepEqual(await controller.open(7, { text: "Это русский текст" }), {
    status: "skipped-russian"
  });
  assert.deepEqual(events, [], "no extension API call and no detection round-trip");
});
