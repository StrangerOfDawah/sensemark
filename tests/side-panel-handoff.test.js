const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../shared/config.js");
const language = require("../shared/language-utils.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelHandoff } = require("../background/side-panel-handoff.js");
const {
  createSidePanelConfigurator
} = require("../background/side-panel-configurator.js");
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
  const slowState = {
    ...state,
    async replace(value) {
      if (storeDelay > 0) {
        await new Promise((resolve) => {
          clock.api.setTimeout(resolve, storeDelay);
        });
      }
      return state.replace(value);
    }
  };
  const handoff = createSidePanelHandoff({
    state,
    now: clock.now,
    resolveActiveTab
  });
  const opened = [];
  const configured = [];
  let requestCounter = 0;
  const controller = createSidePanelController({
    state: slowState,
    handoff,
    configurator: {
      async configure(tabId) {
        configured.push(tabId);
        return { status: "configured" };
      }
    },
    randomId: () => `request-${(requestCounter += 1)}`,
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
  function attachPanel({ windowId = 1, tabToken = null } = {}) {
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
      tabToken,
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
    configured,
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

test("handoff: request delivery does not depend on per-request setOptions timing", async () => {
  // Race B. Configuration is now a tab-lifecycle concern, so the user-action path
  // touches exactly one extension API.
  const harness = createHarness();
  await harness.controller.open(4, { text: "static path", windowId: 2, requestId: "abc" });
  const apiCalls = harness.opened.map((entry) => entry.type);
  assert.deepEqual(apiCalls, ["open"], "only open() may run on the user-action path");
  assert.ok(
    !harness.opened.some((entry) => entry.type === "setOptions"),
    "setOptions must not be raced against open"
  );

  // A controller with no setOptions available at all must still deliver.
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "no-set-options",
    sidePanel: {
      async open() {},
      setOptions() {
        throw new Error("setOptions must never be called during a handoff");
      }
    }
  });
  const result = await controller.open(9, { text: "no configuration needed", windowId: 4 });
  assert.equal(result.status, "opened");
  assert.equal(Object.keys(storage.values).length, 1);
});

test("handoff: the configured panel path carries tab identity but never request identity", () => {
  const configurator = createSidePanelConfigurator({
    sidePanel: { async setOptions() {} },
    tabs: { async query() { return []; } }
  });
  const manifest = JSON.parse(read("manifest.json"));
  const path = configurator.pathForTab(77);

  assert.equal(path.split("?")[0], "sidepanel/sidepanel.html");
  assert.equal(path.split("?")[0], manifest.side_panel.default_path);
  assert.equal(path, "sidepanel/sidepanel.html?tab=77");
  // Tab identity is stable for the life of the tab; request identity never appears.
  assert.doesNotMatch(path, /requestId|frameId|sequence/);
  assert.equal(configurator.pathForTab(77), path, "the path is stable across requests");

  const panelSource = read("sidepanel/sidepanel.js");
  assert.doesNotMatch(panelSource, /requestId/, "the panel must not read a request id");
  assert.match(panelSource, /get\("tab"\)/, "the panel reads only its own tab id");
});

test("handoff: a late setOptions rejection does not turn a successful open into a failure", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const handoff = createSidePanelHandoff({ state, now: clock.now });
  const controller = createSidePanelController({
    state,
    handoff,
    // Configuration fails after open() has already succeeded.
    configurator: {
      async configure() {
        throw new Error("No tab with id 6");
      }
    },
    randomId: () => "late-options",
    sidePanel: {
      async open() {}
    }
  });

  const result = await controller.open(6, { text: "still delivered", windowId: 3 });
  assert.equal(result.status, "opened", "configuration failure is not an opening failure");
  assert.match(result.configurationError, /No tab with id/);
  assert.equal(Object.keys(storage.values).length, 1, "pending state must survive");

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 3, tabId: 6 });
  await flush();

  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "still delivered");
});

test("handoff: an already-open panel keeps its pending request when open() rejects", async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: clock.now });
  const handoff = createSidePanelHandoff({ state, now: clock.now });

  // A panel for tab 8 is already connected and has resolved its scope.
  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 5, tabId: 8 });
  await flush();
  assert.equal(received[0].type, config.SIDE_PANEL.IDLE);
  assert.ok(handoff.hasPanelFor({ tabId: 8 }));

  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "already-open",
    sidePanel: {
      async open() {
        throw new Error("Side panel is already open");
      }
    }
  });
  const result = await controller.open(8, { text: "claimable anyway", windowId: 5 });
  assert.equal(result.status, "open-failed-panel-available");
  assert.equal(Object.keys(storage.values).length, 1, "a claimable request must not be deleted");

  pair.clientPort.postMessage({ type: config.SIDE_PANEL.CLAIM, windowId: 5, tabId: 8 });
  await flush();
  const delivered = received.find((message) => message.type === config.SIDE_PANEL.REQUEST);
  assert.equal(delivered.pending.text, "claimable anyway");
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
  const firstHandoff = createSidePanelHandoff({
    state: firstState,
    bindingStore: storage,
    now: clock.now
  });
  const controller = createSidePanelController({
    state: firstState,
    handoff: firstHandoff,
    randomId: () => "survives-restart",
    sidePanel: { async setOptions() {}, async open() {} }
  });
  await controller.open(8, { text: "survives restart", windowId: 4 });
  const pendingKeys = () =>
    Object.keys(storage.values).filter((key) =>
      key.startsWith(config.SIDE_PANEL_PENDING_PREFIX)
    );
  assert.equal(pendingKeys().length, 1);

  // Worker generation 2: fresh in-memory registry, same session storage.
  const secondState = createSidePanelState(storage, { now: clock.now });
  const secondHandoff = createSidePanelHandoff({
    state: secondState,
    bindingStore: storage,
    now: clock.now
  });
  assert.equal(secondHandoff.intentFor({ windowId: 4 }), null, "intents do not survive a restart");

  const pair = createPortPair(config.PORTS.SIDE_PANEL);
  secondHandoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId: 4 });
  await flush();

  assert.equal(received[0].type, config.SIDE_PANEL.REQUEST);
  assert.equal(received[0].pending.text, "survives restart");
  assert.deepEqual(pendingKeys(), [], "the record is consumed, not duplicated");

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
    // Synchronously after the call, open() has already been reached, and it is the
    // only extension API touched on that stack.
    assert.deepEqual(
      order,
      ["announce", "open", "store"],
      `unexpected ordering for: ${text}`
    );
    assert.ok(!order.includes("detect"), `${text} must not await detection before open`);
    assert.ok(!order.includes("setOptions"), `${text} must not configure during handoff`);
    await opening;
  }
});

test("non-Russian Cyrillic is never synchronously skipped as Russian", () => {
  // Every one of these was classified "russian" by the single-letter heuristic and
  // its translation request was silently destroyed.
  const mustTranslate = [
    "Сынып",
    "Добры дзень",
    "Кыргыз тили",
    "Бул жакшы",
    "Энэ текст",
    "Мына сынып",
    "Як справи?",
    "Доброго дня",
    "Добар дан",
    "Как си",
    "Сәлем",
    "Кароткі тэкст",
    "Жақсы студент сынып бөлмесінде отыр",
    "Беларуская мова вельмі прыгожая"
  ];
  for (const text of mustTranslate) {
    assert.notEqual(
      language.synchronousRussianVerdict(text),
      "russian",
      `${text} must never be skipped as Russian`
    );
  }
});

test("short Cyrillic remains uncertain", () => {
  for (const text of ["Мы", "Ты", "Это", "Мир", "Да", "Нет", "Привет"]) {
    assert.equal(
      language.synchronousRussianVerdict(text),
      "uncertain",
      `${text} must follow translate-on-uncertainty`
    );
  }
});

test("a confident Russian verdict requires length and multiple function words", () => {
  for (const text of [
    "Это очень длинный русский текст, который нужно проверить.",
    "Если сейчас нужно проверить, то это уже сделано.",
    "Сегодня нужно понять, почему это всегда происходит."
  ]) {
    assert.equal(language.synchronousRussianVerdict(text), "russian", text);
  }
  // Real Russian that is simply too short or too sparse stays uncertain, which costs
  // an extra panel rather than a lost translation.
  for (const text of [
    "Привет, как дела?",
    "APP_ENV должен быть production",
    "Открой URL в браузере"
  ]) {
    assert.equal(language.synchronousRussianVerdict(text), "uncertain", text);
  }
  // Non-Cyrillic and empty input never reach the Russian branch at all.
  for (const text of ["foreign text", "こんにちは", "", "   ", "!!! ???"]) {
    assert.equal(language.synchronousRussianVerdict(text), "not-russian", JSON.stringify(text));
  }
  // Mixed independent language groups are a multilingual request.
  assert.equal(language.synchronousRussianVerdict("Привет hello world together"), "uncertain");
});

test("no provider or network call is used for the synchronous language preflight", () => {
  const verdict = language.synchronousRussianVerdict.toString();
  assert.doesNotMatch(verdict, /await|fetch|async|detectLanguage/);
  assert.notEqual(
    language.synchronousRussianVerdict.constructor.name,
    "AsyncFunction",
    "the preflight must not be async"
  );
  // It returns a plain string, never a thenable.
  const result = language.synchronousRussianVerdict("Привет");
  assert.equal(typeof result, "string");
  assert.doesNotMatch(read("shared/language-utils.js"), /openai|api\.openai\.com/i);
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
  assert.deepEqual(
    await controller.open(7, {
      text: "Это очень длинный русский текст, который нужно проверить."
    }),
    { status: "skipped-russian" }
  );
  assert.deepEqual(events, [], "no extension API call and no detection round-trip");
});
