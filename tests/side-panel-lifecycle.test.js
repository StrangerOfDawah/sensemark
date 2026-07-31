const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../shared/config.js");
const errors = require("../shared/errors.js");
const route = require("../background/selection-route.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelHandoff } = require("../background/side-panel-handoff.js");
const {
  createSidePanelConfigurator
} = require("../background/side-panel-configurator.js");
const { createSidePanelController } = require("../background/side-panel-controller.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Restart ordering, durable binding ordering, configuration lifecycle and the
 * ordinary-page fallback policy.
 *
 * These fail on 11b2b10: the in-memory sequence let a stale pending record from a
 * previous worker generation defeat a fresh user action, binding writes were
 * fire-and-forget and could land out of order, the request controller still called
 * configure(), and an ordinary content-script failure silently retried through
 * sidePanel.open() after an awaited round trip.
 */

/** `setDelays` lets a test make the first write slower than the second. */
function memoryStorage({ setDelays = [], failSetFor = null } = {}) {
  const values = {};
  let writes = 0;
  return {
    values,
    async get(key) {
      await Promise.resolve();
      if (key === null || key === undefined) return { ...values };
      if (Array.isArray(key)) {
        return Object.fromEntries(
          key.filter((item) => item in values).map((item) => [item, values[item]])
        );
      }
      return key in values ? { [key]: values[key] } : {};
    },
    async set(next) {
      const index = writes;
      writes += 1;
      if (failSetFor && Object.keys(next).some((key) => key.includes(failSetFor))) {
        throw new Error(`storage unavailable for ${failSetFor}`);
      }
      const delay = setDelays[index] ?? 0;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      Object.assign(values, next);
    },
    async remove(keys) {
      await Promise.resolve();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

const pendingRecords = (storage) =>
  Object.entries(storage.values)
    .filter(([key]) => key.startsWith(config.SIDE_PANEL_PENDING_PREFIX))
    .map(([, record]) => record);

async function flush(rounds = 60) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function createPortPair() {
  let connected = true;
  const listeners = {
    worker: { message: [], disconnect: [] },
    client: { message: [], disconnect: [] }
  };
  const makePort = (side, other) => ({
    name: config.PORTS.SIDE_PANEL,
    postMessage(message) {
      if (!connected) throw new Error("disconnected port");
      queueMicrotask(() => {
        if (!connected) return;
        for (const listener of [...listeners[other].message]) listener(message);
      });
    },
    disconnect() {
      connected = false;
    },
    onMessage: { addListener: (fn) => listeners[side].message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners[side].disconnect.push(fn) }
  });
  return { workerPort: makePort("worker", "client"), clientPort: makePort("client", "worker") };
}

function connectPanel(handoff, { windowId, tabId = null } = {}) {
  const pair = createPortPair();
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  return {
    received,
    ready: () => pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId, tabId }),
    claim: () => pair.clientPort.postMessage({ type: config.SIDE_PANEL.CLAIM, windowId, tabId }),
    delivered: () => received.filter((m) => m.type === config.SIDE_PANEL.REQUEST)
  };
}

/** One worker generation: fresh in-memory state over shared session storage. */
function bootWorker(storage, { randomIds = [], sidePanel, isTabConfigured } = {}) {
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  let index = 0;
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured,
    randomId: () => randomIds[index++] || `request-${index}`,
    sidePanel: sidePanel || { async open() {} }
  });
  return { controller, handoff, state };
}

// ------------------------------------------------------- restart-safe ordering

test("fresh request after worker restart replaces higher old sequence", async () => {
  const storage = memoryStorage();

  // Generation 1 makes five requests, so the surviving record reaches sequence 5.
  const first = bootWorker(storage, { randomIds: ["o1", "o2", "o3", "o4", "o5"] });
  for (let index = 0; index < 5; index += 1) {
    await first.controller.open(1, { text: `old ${index}`, windowId: 1 });
  }
  const stale = pendingRecords(storage)[0];
  assert.equal(stale.sequence, 5, "the stale record must outrank a fresh sequence of 1");

  // Generation 2: the counter restarts at 1.
  const second = bootWorker(storage, { randomIds: ["FRESH"] });
  const result = await second.controller.open(1, { text: "fresh user action", windowId: 1 });

  assert.equal(result.status, "opened", "a fresh user action must never be discarded");
  const records = pendingRecords(storage);
  assert.equal(records.length, 1);
  assert.equal(records[0].text, "fresh user action");
  assert.ok(records[0].generationId > stale.generationId, "generation must advance");

  const panel = connectPanel(second.handoff, { windowId: 1, tabId: 1 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 1);
  assert.equal(panel.delivered()[0].pending.text, "fresh user action");
  assert.deepEqual(pendingRecords(storage), [], "the old request cannot be claimed");
});

test("restart plus delayed storage delivers the fresh request, not the stale one", async () => {
  const storage = memoryStorage();
  const first = bootWorker(storage, { randomIds: ["stale"] });
  await first.controller.open(2, { text: "stale text", windowId: 3 });

  // Generation 2 with a slow replacement write.
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "fresh",
    sidePanel: { async open() {} }
  });
  const slow = {
    ...state,
    async replace(value) {
      await gate;
      return state.replace(value);
    }
  };
  const slowController = createSidePanelController({
    state: slow,
    handoff,
    randomId: () => "fresh",
    sidePanel: { async open() {} }
  });
  void controller;

  const opening = slowController.open(2, { text: "fresh text", windowId: 3 });
  const panel = connectPanel(handoff, { windowId: 3, tabId: 2 });
  panel.ready();
  await flush();

  // While the fresh write is in flight the stale record is still on disk. The panel
  // must not be handed it.
  assert.equal(panel.delivered().length, 0, "the stale record must not be delivered");
  assert.equal(panel.received[0].type, config.SIDE_PANEL.WAITING);

  release();
  await opening;
  panel.claim();
  await flush();

  assert.equal(panel.delivered().length, 1);
  assert.equal(panel.delivered()[0].pending.text, "fresh text");
});

test("rapid requests after restart leave newest pending", async () => {
  const storage = memoryStorage();
  const first = bootWorker(storage, { randomIds: ["old1", "old2", "old3"] });
  for (const text of ["old1", "old2", "old3"]) {
    await first.controller.open(4, { text, windowId: 1 });
  }

  const second = bootWorker(storage, { randomIds: ["A", "B", "C"] });
  await Promise.all([
    second.controller.open(4, { text: "A", windowId: 1 }),
    second.controller.open(4, { text: "B", windowId: 1 }),
    second.controller.open(4, { text: "C", windowId: 1 })
  ]);

  const records = pendingRecords(storage);
  assert.equal(records.length, 1, "no empty state and no duplicates");
  assert.equal(records[0].text, "C");
  assert.equal(records[0].requestId, "C");
});

// ------------------------------------------------- durable binding write order

test("late old binding write cannot overwrite new binding", async () => {
  // The first set() is slow, the second is fast: without serialization the older
  // binding lands last and a restarted worker recovers the wrong tab.
  const storage = memoryStorage({ setDelays: [0, 40, 1] });
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });

  const older = handoff.announce({ tabId: 10, frameId: 0, windowId: 5, requestId: "A" });
  const newer = handoff.announce({ tabId: 11, frameId: 0, windowId: 5, requestId: "B" });
  await Promise.all([older.persisted, newer.persisted]);

  const key = `${config.SIDE_PANEL_BINDING_PREFIX}5`;
  assert.equal(storage.values[key].tabId, 11, "the newer binding must win");
  assert.equal(storage.values[key].requestId, "B");

  // A restarted worker must recover the newer identity.
  const restarted = createSidePanelHandoff({
    state: createSidePanelState(storage),
    bindingStore: storage
  });
  const recovered = await restarted.bindingFor(5);
  assert.equal(recovered.tabId, 11);
});

test("three out-of-order binding writes preserve newest", async () => {
  const storage = memoryStorage({ setDelays: [0, 50, 30, 1] });
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });

  const writes = ["A", "B", "C"].map((requestId, index) =>
    handoff.announce({ tabId: 20 + index, frameId: 0, windowId: 6, requestId })
  );
  await Promise.all(writes.map((entry) => entry.persisted));

  const key = `${config.SIDE_PANEL_BINDING_PREFIX}6`;
  assert.equal(storage.values[key].requestId, "C");
  assert.equal(storage.values[key].tabId, 22);
});

test("window bindings remain isolated", async () => {
  const storage = memoryStorage({ setDelays: [0, 40, 1] });
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });

  const windowOne = handoff.announce({ tabId: 30, frameId: 0, windowId: 100, requestId: "w1" });
  const windowTwo = handoff.announce({ tabId: 31, frameId: 0, windowId: 200, requestId: "w2" });
  await Promise.all([windowOne.persisted, windowTwo.persisted]);

  assert.equal(storage.values[`${config.SIDE_PANEL_BINDING_PREFIX}100`].tabId, 30);
  assert.equal(storage.values[`${config.SIDE_PANEL_BINDING_PREFIX}200`].tabId, 31);
});

test("a failed binding write is typed, not silently swallowed or trusted", async () => {
  const storage = memoryStorage({ failSetFor: config.SIDE_PANEL_BINDING_PREFIX });
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => "binding-fails",
    sidePanel: { async open() {} }
  });

  const result = await controller.open(40, { text: "still delivered", windowId: 8 });
  assert.equal(result.status, "opened", "a binding failure is not an opening failure");
  assert.equal(result.bindingStatus, "failed");
  assert.match(handoff.bindingFailure(8), /storage unavailable/);

  // The stale on-disk binding is not trusted, but the in-memory one still resolves
  // identity for this generation.
  const scope = await handoff.resolveScope({ sender: undefined }, { windowId: 8 });
  assert.equal(scope.tabId, 40);

  // Delivery still works through the deterministic tab token.
  const panel = connectPanel(handoff, { windowId: 8, tabId: 40 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered()[0].pending.text, "still delivered");
});

test("a new request while binding persistence is pending still resolves the newest tab", async () => {
  const storage = memoryStorage({ setDelays: [0, 40, 1] });
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  let index = 0;
  const controller = createSidePanelController({
    state,
    handoff,
    randomId: () => ["first", "second"][index++],
    sidePanel: { async open() {} }
  });

  const older = controller.open(50, { text: "first", windowId: 9 });
  const newer = controller.open(51, { text: "second", windowId: 9 });
  await Promise.all([older, newer]);

  const scope = await handoff.resolveScope({ sender: undefined }, { windowId: 9 });
  assert.equal(scope.tabId, 51, "the newest binding decides");
  assert.equal(storage.values[`${config.SIDE_PANEL_BINDING_PREFIX}9`].tabId, 51);
});

// --------------------------------------------------- configuration lifecycle

test("request controller never calls setOptions", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const calls = [];
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: () => true,
    randomId: () => "no-config",
    sidePanel: {
      async open() {
        calls.push("open");
      },
      async setOptions() {
        calls.push("setOptions");
      }
    }
  });

  await controller.open(60, { text: "hello", windowId: 1 });
  assert.deepEqual(calls, ["open"], "only open() may run on the request path");

  // And structurally: the controller module must not reference the API at all.
  const source = read("background/side-panel-controller.js").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(source, /setOptions/, "no setOptions call site in the controller");
  assert.doesNotMatch(source, /configurator\s*\./, "no configurator invocation");
});

test("tab lifecycle configures the stable tab-specific path", async () => {
  const calls = [];
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions(options) {
        calls.push(options);
      }
    },
    tabs: {
      async query() {
        return [{ id: 7 }, { id: 8 }];
      }
    }
  });

  await configurator.configureAll();
  assert.deepEqual(
    calls.map((call) => call.path),
    ["sidepanel/sidepanel.html?tab=7", "sidepanel/sidepanel.html?tab=8"]
  );
  assert.ok(calls.every((call) => call.enabled === true));
  assert.ok(configurator.isConfigured(7));
  assert.equal(configurator.isConfigured(999), false);

  // Only lifecycle events configure: the service worker wires exactly these.
  const worker = read("background/service-worker.js");
  for (const event of [
    "chrome.tabs.onCreated",
    "chrome.tabs.onActivated",
    "chrome.tabs.onUpdated",
    "chrome.runtime.onInstalled",
    "chrome.runtime.onStartup"
  ]) {
    assert.match(worker, new RegExp(event.replace(/\./g, "\\.")), event);
  }
  assert.doesNotMatch(
    worker.split("chrome.contextMenus.onClicked")[1] || "",
    /configure\(/,
    "the context-menu handler must not configure"
  );
});

test("unconfigured tab returns a typed configuration error and cleans pending state", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: () => false,
    randomId: () => "unconfigured",
    sidePanel: {
      async open() {
        throw new Error("No active side panel for tabId");
      }
    }
  });

  const result = await controller.open(70, { text: "never shown", windowId: 2 });
  assert.equal(result.status, "not-configured");
  assert.equal(result.code, errors.ERROR_CODE.PANEL_NOT_CONFIGURED);
  assert.deepEqual(pendingRecords(storage), [], "pending state must be cleaned");
});

test("a configured tab that fails to open reports an opening error, not a configuration error", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: () => true,
    randomId: () => "open-fails",
    sidePanel: {
      async open() {
        throw new Error("user gesture required");
      }
    }
  });

  const result = await controller.open(71, { text: "never shown", windowId: 2 });
  assert.equal(result.status, "open-failed");
  assert.equal(result.code, errors.ERROR_CODE.PANEL_OPEN_FAILED);
  assert.deepEqual(pendingRecords(storage), []);
});

test("the panel lifecycle error taxonomy is distinct", () => {
  const codes = [
    errors.ERROR_CODE.PANEL_NOT_CONFIGURED,
    errors.ERROR_CODE.PANEL_OPEN_FAILED,
    errors.ERROR_CODE.PANEL_HANDOFF_FAILED,
    errors.ERROR_CODE.PANEL_HANDOFF_TIMEOUT,
    errors.ERROR_CODE.CONTENT_SCRIPT_UNAVAILABLE
  ];
  assert.equal(new Set(codes).size, codes.length, "every lifecycle failure is distinct");
  for (const code of codes) assert.equal(typeof code, "string");
});

// ------------------------------------------------------ ordinary-page fallback

test("known PDF and restricted URLs open the panel directly", () => {
  for (const url of [
    "https://example.test/paper.pdf",
    "https://example.test/paper.PDF?download=1",
    "chrome://settings",
    "chrome-extension://abcdef/page.html",
    "devtools://devtools/bundled/inspector.html",
    "view-source:https://example.test/",
    "about:blank",
    "https://chromewebstore.google.com/detail/x"
  ]) {
    assert.equal(
      route.routeForSelection({ url }).route,
      route.ROUTE.DIRECT_SIDE_PANEL,
      url
    );
  }
});

test("ordinary pages try the content script first", () => {
  for (const url of [
    "https://example.test/article",
    "http://localhost:3000/",
    "https://example.test/report.pdf.html"
  ]) {
    assert.equal(route.routeForSelection({ url }).route, route.ROUTE.CONTENT_SCRIPT, url);
  }
});

test("an unknown URL is treated as a protected context rather than guessed", () => {
  // A missing URL means the tab is one we cannot inspect, which in practice is a
  // restricted page. Routing it directly keeps open() on the gesture stack.
  assert.equal(route.routeForSelection({}).route, route.ROUTE.DIRECT_SIDE_PANEL);
  assert.equal(route.routeForSelection({ url: "" }).reason, "unknown-url");
});

test("ordinary async content-script failure does not claim direct fallback", () => {
  const worker = read("background/service-worker.js");
  const handler = worker.split("chrome.contextMenus.onClicked")[1].split("\n});")[0];

  // The direct branch returns before any await; the content-script branch must not
  // reach openSidePanel afterwards.
  const afterDelivery = handler.split("await deliverSelection")[1] || "";
  assert.doesNotMatch(
    afterDelivery,
    /openSidePanel/,
    "no side-panel fallback after an awaited content-script round trip"
  );
  assert.match(afterDelivery, /showRetryHint/, "the user must be told to retry");

  const command = worker.split("chrome.commands.onCommand")[1].split("\n});")[0];
  const afterScripting = command.split("await translateCurrentSelection")[1] || "";
  assert.doesNotMatch(afterScripting, /openSidePanel/);
  assert.match(afterScripting, /showRetryHint/);
});

test("the direct side-panel path has no awaited work before open()", () => {
  const worker = read("background/service-worker.js");
  const handler = worker.split("chrome.contextMenus.onClicked")[1].split("\n});")[0];
  const beforeDirect = handler.split("DIRECT_SIDE_PANEL")[0];
  assert.doesNotMatch(beforeDirect, /await /, "routing must be synchronous");
  assert.match(handler, /routeForSelection/);
});

test("the retry hint is surfaced without a notifications permission", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.ok(!manifest.permissions.includes("notifications"), "no new permission");
  const worker = read("background/service-worker.js");
  assert.match(worker, /setBadgeText/);
  assert.match(worker, /Повторите команду/);
});
