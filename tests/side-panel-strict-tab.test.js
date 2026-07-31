const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../shared/config.js");
const errors = require("../shared/errors.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelHandoff } = require("../background/side-panel-handoff.js");
const {
  createSidePanelConfigurator,
  STATE
} = require("../background/side-panel-configurator.js");
const { createSidePanelController } = require("../background/side-panel-controller.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

/**
 * Strict tab-specific side panel.
 *
 * These fail on b1d010b, where `sidePanel.open()` on an unconfigured tab could
 * succeed by opening Chrome's global default panel, and an untokenized panel could
 * still resolve identity through the window binding or the active tab.
 */

function memoryStorage() {
  const values = {};
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
      await Promise.resolve();
      Object.assign(values, next);
    },
    async remove(keys) {
      await Promise.resolve();
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  };
}

const keysWithPrefix = (storage, prefix) =>
  Object.keys(storage.values).filter((key) => key.startsWith(prefix));

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

// ------------------------------------------- unconfigured tab is rejected early

test("unconfigured tab is rejected before any handoff work happens", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });

  let openCalls = 0;
  let announceCalls = 0;
  let replaceCalls = 0;
  let publishCalls = 0;
  const controller = createSidePanelController({
    state: {
      ...state,
      replace(value) {
        replaceCalls += 1;
        return state.replace(value);
      }
    },
    handoff: {
      ...handoff,
      announce(pending) {
        announceCalls += 1;
        return handoff.announce(pending);
      },
      publish(pending) {
        publishCalls += 1;
        return handoff.publish(pending);
      }
    },
    isTabConfigured: () => false,
    randomId: () => "rejected",
    sidePanel: {
      async open() {
        openCalls += 1;
      }
    }
  });

  const result = await controller.open(1, { text: "never handed off", windowId: 1 });

  assert.equal(result.status, "not-configured");
  assert.equal(result.code, errors.ERROR_CODE.PANEL_NOT_CONFIGURED);
  assert.equal(result.retryable, true);
  assert.ok(result.message, "a user-facing message is required");

  assert.equal(openCalls, 0, "sidePanel.open must not run on an unconfigured tab");
  assert.equal(replaceCalls, 0, "no pending state may be created");
  assert.equal(announceCalls, 0, "no handoff binding may be announced");
  assert.equal(publishCalls, 0, "no panel notification may be sent");
  assert.deepEqual(keysWithPrefix(storage, config.SIDE_PANEL_PENDING_PREFIX), []);
  assert.deepEqual(keysWithPrefix(storage, config.SIDE_PANEL_BINDING_PREFIX), []);
});

test("the configuration check precedes prepare, announce and open", async () => {
  const order = [];
  const controller = createSidePanelController({
    state: {
      prepare(value) {
        order.push("prepare");
        return { ...value, createdAt: 1, sequence: 1 };
      },
      async replace(value) {
        order.push("replace");
        return { stored: true, pending: value };
      },
      async store(value) {
        order.push("store");
        return value;
      },
      async clear() {
        order.push("clear");
      }
    },
    handoff: {
      announce() {
        order.push("announce");
        return {};
      },
      publish() {
        order.push("publish");
      },
      abandon() {},
      bindingPersistence: async () => ({ status: "idle" })
    },
    isTabConfigured: () => {
      order.push("isTabConfigured");
      return false;
    },
    randomId: () => "ordering",
    sidePanel: {
      async open() {
        order.push("open");
      }
    }
  });

  await controller.open(2, { text: "hello", windowId: 1 });
  assert.deepEqual(order, ["isTabConfigured"], "nothing may run after the rejection");

  // And the check is structurally ahead of the handoff in the source.
  const source = read("background/side-panel-controller.js");
  const checkAt = source.indexOf("isTabConfigured(tabId)");
  const invokeAt = source.indexOf("invokeOpen(tabId, value, text)", source.indexOf("function open("));
  assert.ok(checkAt > 0 && invokeAt > 0);
  assert.ok(checkAt < invokeAt, "the guard must precede invokeOpen()");
});

test("a configured tab proceeds normally and is delivered once", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  let openCalls = 0;
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: (tabId) => tabId === 5,
    randomId: () => "allowed",
    sidePanel: {
      async open(options) {
        assert.deepEqual(options, { tabId: 5 });
        openCalls += 1;
      }
    }
  });

  const result = await controller.open(5, { text: "delivered", windowId: 2 });
  assert.equal(result.status, "opened");
  assert.equal(openCalls, 1);

  const panel = connectPanel(handoff, { windowId: 2, tabId: 5 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 1);
  assert.equal(panel.delivered()[0].pending.text, "delivered");
});

// ------------------------------------------------------- configuration state

test("configureAll hydrates tabs and isConfigured reflects only real success", async () => {
  const calls = [];
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions(options) {
        calls.push(options.tabId);
        if (options.tabId === 3) throw new Error("No tab with id: 3");
      }
    },
    tabs: {
      async query() {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      }
    }
  });

  assert.equal(configurator.stateFor(1), STATE.UNKNOWN);
  const result = await configurator.configureAll();

  assert.equal(result.configured, 2, "only the successful tabs count");
  assert.equal(configurator.isConfigured(1), true);
  assert.equal(configurator.isConfigured(2), true);
  assert.equal(configurator.isConfigured(3), false, "a failed tab stays unconfigured");
  assert.equal(configurator.stateFor(3), STATE.FAILED);
  assert.match(configurator.failureFor(3), /No tab with id/);
  assert.equal(configurator.isConfigured(99), false, "an unseen tab is unconfigured");
});

test("duplicate lifecycle events do not issue duplicate setOptions calls", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions() {
        calls += 1;
        await gate;
      }
    },
    tabs: { async query() { return []; } }
  });

  // onCreated, onActivated and onUpdated can all fire before the first resolves.
  const concurrent = [configurator.configure(7), configurator.configure(7), configurator.configure(7)];
  assert.equal(configurator.stateFor(7), STATE.CONFIGURING);
  release();
  await Promise.all(concurrent);

  assert.equal(calls, 1, "one in-flight configuration per tab");
  assert.equal(configurator.isConfigured(7), true);

  await configurator.configure(7);
  assert.equal(calls, 1, "an already-configured tab is not reconfigured");
});

test("a failed configuration can be retried and then succeeds", async () => {
  let attempt = 0;
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions() {
        attempt += 1;
        if (attempt === 1) throw new Error("tab not ready");
      }
    },
    tabs: { async query() { return []; } }
  });

  assert.equal((await configurator.configure(8)).status, "configuration-failed");
  assert.equal(configurator.isConfigured(8), false);
  assert.equal((await configurator.configure(8)).status, "configured");
  assert.equal(configurator.isConfigured(8), true);
});

test("tab removal clears configuration state", async () => {
  const configurator = createSidePanelConfigurator({
    sidePanel: { async setOptions() {} },
    tabs: { async query() { return []; } }
  });
  await configurator.configure(9);
  assert.equal(configurator.isConfigured(9), true);

  configurator.forget(9);
  assert.equal(configurator.isConfigured(9), false);
  assert.equal(configurator.stateFor(9), STATE.UNKNOWN);
});

test("configuration hydration starts on every service-worker initialisation", () => {
  const worker = read("background/service-worker.js");

  // Module scope, not inside a listener: runtime.onStartup fires once per browser
  // session, but the worker is restarted many times within one session.
  const hydration = worker.match(/^const sidePanelConfigurationReady = [\s\S]*?;$/m);
  assert.ok(hydration, "configureAll() must run at module initialisation");
  assert.match(hydration[0], /configureAll\(\)/);

  const beforeHydration = worker.slice(0, worker.indexOf("sidePanelConfigurationReady"));
  assert.doesNotMatch(
    beforeHydration.split("chrome.runtime.onStartup")[1] || "",
    /configureAll/,
    "hydration must not depend on onStartup alone"
  );

  // It must NOT be awaited on the user-action path.
  const handler = worker.split("chrome.contextMenus.onClicked")[1].split("\n});")[0];
  assert.doesNotMatch(handler, /sidePanelConfigurationReady/);
  assert.doesNotMatch(handler, /configure\(/, "the request path never configures");

  // The controller receives the real configuration check.
  assert.match(worker, /isTabConfigured:\s*\(tabId\)\s*=>\s*sidePanelConfigurator\.isConfigured\(tabId\)/);
});

// -------------------------------------------------------- untokenized panels

test("an untokenized panel cannot claim a tab-scoped request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation(),
    resolveActiveTab: async () => 11
  });
  await state.replace(
    state.prepare({ tabId: 11, frameId: 0, windowId: 4, requestId: "owned", text: "tab 11 text" })
  );
  handoff.announce({ tabId: 11, frameId: 0, windowId: 4, requestId: "owned" });

  for (const tabId of [null, undefined, "", "invalid", -1]) {
    const panel = connectPanel(handoff, { windowId: 4, tabId });
    panel.ready();
    await flush();
    assert.equal(panel.delivered().length, 0, `tabId=${String(tabId)} must not claim`);
    assert.equal(panel.received[0].type, config.SIDE_PANEL.UNSUPPORTED);
    assert.equal(panel.received[0].code, config.SIDE_PANEL_ERROR.NOT_CONFIGURED);
  }

  assert.equal(
    (await state.peek({ tabId: 11 })).text,
    "tab 11 text",
    "the request survives for its own configured panel"
  );
});

test("an untokenized panel is never notified when a request lands", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation()
  });
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: () => true,
    randomId: () => "later",
    sidePanel: { async open() {} }
  });

  const panel = connectPanel(handoff, { windowId: 6, tabId: null });
  panel.ready();
  await flush();
  assert.equal(panel.received[0].type, config.SIDE_PANEL.UNSUPPORTED);

  await controller.open(20, { text: "for tab 20", windowId: 6 });
  await flush();

  const notifications = panel.received.filter(
    (message) => message.type === config.SIDE_PANEL.AVAILABLE
  );
  assert.equal(notifications.length, 0, "an unbound panel receives no availability push");
  assert.equal(panel.delivered().length, 0);
});

test("global panel opened for tab A cannot strand tab B's request", async () => {
  // The reproduction: an untokenized panel served tab A, stayed connected, and tab
  // B's request was then never notified and never claimed.
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    generation: () => state.generation(),
    resolveActiveTab: async () => 31
  });
  let index = 0;
  const controller = createSidePanelController({
    state,
    handoff,
    isTabConfigured: () => true,
    randomId: () => ["A", "B"][index++],
    sidePanel: { async open() {} }
  });

  // A legacy untokenized panel is connected in this window.
  const globalPanel = connectPanel(handoff, { windowId: 7, tabId: null });
  globalPanel.ready();
  await flush();
  assert.equal(globalPanel.received[0].type, config.SIDE_PANEL.UNSUPPORTED);

  await controller.open(30, { text: "tab A text", windowId: 7 });
  await controller.open(31, { text: "tab B text", windowId: 7 });
  await flush();

  assert.equal(globalPanel.delivered().length, 0, "the global panel claims neither request");

  // Both tabs' own configured panels get exactly their own request.
  const panelA = connectPanel(handoff, { windowId: 7, tabId: 30 });
  const panelB = connectPanel(handoff, { windowId: 7, tabId: 31 });
  panelA.ready();
  panelB.ready();
  await flush();

  assert.equal(panelA.delivered().length, 1);
  assert.equal(panelA.delivered()[0].pending.text, "tab A text");
  assert.equal(panelB.delivered().length, 1);
  assert.equal(panelB.delivered()[0].pending.text, "tab B text");
  assert.deepEqual(
    keysWithPrefix(storage, config.SIDE_PANEL_PENDING_PREFIX),
    [],
    "no request is left silently pending"
  );
});

test("two configured tabs and two panel ports stay isolated", async () => {
  const storage = memoryStorage();
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
    isTabConfigured: () => true,
    randomId: () => ["first", "second"][index++],
    sidePanel: { async open() {} }
  });

  const panelOne = connectPanel(handoff, { windowId: 1, tabId: 40 });
  const panelTwo = connectPanel(handoff, { windowId: 2, tabId: 41 });
  panelOne.ready();
  panelTwo.ready();
  await flush();

  await controller.open(40, { text: "for forty", windowId: 1 });
  await controller.open(41, { text: "for forty-one", windowId: 2 });
  await flush();

  // Each port is told only about its own tab's request.
  const availableFor = (panel) =>
    panel.received.filter((message) => message.type === config.SIDE_PANEL.AVAILABLE);
  assert.equal(availableFor(panelOne).length, 1);
  assert.equal(availableFor(panelTwo).length, 1);

  // A bare port does not auto-claim the way the real client does.
  panelOne.claim();
  panelTwo.claim();
  await flush();

  assert.equal(panelOne.delivered().length, 1);
  assert.equal(panelOne.delivered()[0].pending.text, "for forty");
  assert.equal(panelTwo.delivered().length, 1);
  assert.equal(panelTwo.delivered()[0].pending.text, "for forty-one");
});

test("the panel surfaces a typed configuration error for an unbound instance", () => {
  const panelSource = read("sidepanel/sidepanel.js");
  assert.match(panelSource, /onUnsupported/);
  assert.match(panelSource, /PANEL_NOT_CONFIGURED/);
  assert.match(panelSource, /не привязана к вкладке/);

  const client = read("extension/side-panel-handoff-client.js");
  assert.match(client, /SIDE_PANEL\.UNSUPPORTED/);
  assert.match(client, /finish\("unsupported"\)/, "retrying must stop");
});

test("the manifest default path exists but is never a delivery target", () => {
  const manifest = JSON.parse(read("manifest.json"));
  // Chrome requires a default_path for the action to be available at all; the strict
  // model simply never treats an instance opened at it as claimable.
  assert.equal(manifest.side_panel.default_path, "sidepanel/sidepanel.html");
  const handoff = read("background/side-panel-handoff.js");
  assert.doesNotMatch(
    handoff.split("async function resolveScope")[1].split("\n    }")[0],
    /readBinding|resolveActiveTab/,
    "identity comes only from sender.tab or the tab token"
  );
});
