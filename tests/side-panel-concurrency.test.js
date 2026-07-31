const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const { createSidePanelState } = require("../background/side-panel-state.js");
const { createSidePanelHandoff } = require("../background/side-panel-handoff.js");
const {
  createSidePanelConfigurator
} = require("../background/side-panel-configurator.js");
const { createSidePanelController } = require("../background/side-panel-controller.js");
const {
  createSidePanelHandoffClient
} = require("../extension/side-panel-handoff-client.js");

/**
 * Same-tab concurrency and panel identity.
 *
 * These reproduce the four defects found after the READY/CLAIM protocol landed:
 * overlapping same-tab requests deleting each other, a single-character Russian
 * heuristic, `setOptions()` inside the user-action race, and tab identity resolved
 * from whichever tab happened to be active at claim time.
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

/** Only the pending-request records; session storage also holds the durable
 * generation counter and window bindings. */
function pendingRecords(storage) {
  return Object.entries(storage.values)
    .filter(([key]) => key.startsWith(config.SIDE_PANEL_PENDING_PREFIX))
    .map(([, record]) => record);
}

async function flush(rounds = 60) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

function createPortPair(sender) {
  let connected = true;
  const listeners = {
    worker: { message: [], disconnect: [] },
    client: { message: [], disconnect: [] }
  };
  function makePort(side, other) {
    return {
      name: config.PORTS.SIDE_PANEL,
      sender: side === "worker" ? sender : undefined,
      postMessage(message) {
        if (!connected) throw new Error("disconnected port");
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
  return { workerPort: makePort("worker", "client"), clientPort: makePort("client", "worker") };
}

/** Connect a bare panel port and record everything the worker sends it. */
function connectPanel(handoff, { windowId, tabId = null, sender } = {}) {
  const pair = createPortPair(sender);
  handoff.connect(pair.workerPort);
  const received = [];
  pair.clientPort.onMessage.addListener((message) => received.push(message));
  return {
    pair,
    received,
    ready: () => pair.clientPort.postMessage({ type: config.SIDE_PANEL.READY, windowId, tabId }),
    claim: () => pair.clientPort.postMessage({ type: config.SIDE_PANEL.CLAIM, windowId, tabId }),
    delivered: () => received.filter((m) => m.type === config.SIDE_PANEL.REQUEST)
  };
}

function createController({ state, handoff, sidePanel, isTabConfigured, randomIds = [] } = {}) {
  let index = 0;
  return createSidePanelController({
    state,
    handoff,
    isTabConfigured,
    randomId: () => randomIds[index++] || `request-${index}`,
    sidePanel: sidePanel || { async open() {} }
  });
}

// --------------------------------------------------------------- same-tab races

test("overlapping same-tab opens preserve newest pending request", async () => {
  // Pre-fix: store(A), store(B), A-removes-B, B-removes-A left storage EMPTY and
  // both translations were lost.
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  const controller = createController({ state, handoff, randomIds: ["A", "B"] });

  const [first, second] = await Promise.all([
    controller.open(1, { text: "older text", windowId: 1 }),
    controller.open(1, { text: "newer text", windowId: 1 })
  ]);

  const records = pendingRecords(storage);
  assert.equal(records.length, 1, "exactly one request must remain claimable");
  assert.equal(records[0].text, "newer text");
  assert.equal(records[0].requestId, "B");
  assert.equal(first.status, "opened");
  assert.equal(second.status, "opened");

  const panel = connectPanel(handoff, { windowId: 1, tabId: 1 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 1, "exactly one translation starts");
  assert.equal(panel.delivered()[0].pending.text, "newer text");
  assert.deepEqual(pendingRecords(storage), [], "nothing stale is left behind");
});

test("newest same-tab request wins regardless of storage completion order", async () => {
  // The winner must follow the monotonic sequence assigned when the user acted,
  // not whichever storage write happens to resolve last.
  for (const resolveOrder of ["A-then-B", "B-then-A"]) {
    const storage = memoryStorage();
    const state = createSidePanelState(storage);
    const older = state.prepare({ tabId: 3, frameId: 0, windowId: 1, requestId: "A", text: "A" });
    const newer = state.prepare({ tabId: 3, frameId: 0, windowId: 1, requestId: "B", text: "B" });
    assert.ok(newer.sequence > older.sequence, "sequence must be monotonic");

    const pendingA = state.replace(older);
    const pendingB = state.replace(newer);
    if (resolveOrder === "A-then-B") await Promise.all([pendingA, pendingB]);
    else await Promise.all([pendingB, pendingA]);

    const records = pendingRecords(storage);
    assert.equal(records.length, 1, resolveOrder);
    assert.equal(records[0].requestId, "B", `newest must win for ${resolveOrder}`);
  }
});

test("an older request that loses the race never deletes the winner", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const older = state.prepare({ tabId: 4, frameId: 0, windowId: 1, requestId: "old", text: "old" });
  const newer = state.prepare({ tabId: 4, frameId: 0, windowId: 1, requestId: "new", text: "new" });

  await state.replace(newer);
  const outcome = await state.replace(older);

  assert.equal(outcome.stored, false, "the older request declines to store");
  assert.equal(outcome.winner.requestId, "new");
  assert.equal(pendingRecords(storage).length, 1);
  assert.equal(pendingRecords(storage)[0].requestId, "new");
});

test("three rapid same-tab requests leave newest request claimable", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  const controller = createController({ state, handoff, randomIds: ["one", "two", "three"] });

  await Promise.all([
    controller.open(5, { text: "first", windowId: 2 }),
    controller.open(5, { text: "second", windowId: 2 }),
    controller.open(5, { text: "third", windowId: 2 })
  ]);

  const records = pendingRecords(storage);
  assert.equal(records.length, 1, "no empty final state, no duplicates");
  assert.equal(records[0].text, "third");

  const panel = connectPanel(handoff, { windowId: 2, tabId: 5 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 1, "one provider call, not three");
  assert.equal(panel.delivered()[0].pending.text, "third");
});

test("different tabs do not supersede each other", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state });
  const controller = createController({ state, handoff, randomIds: ["tab-a", "tab-b", "tab-c"] });

  await Promise.all([
    controller.open(10, { text: "tab ten", windowId: 1 }),
    controller.open(11, { text: "tab eleven", windowId: 2 }),
    controller.open(12, { text: "tab twelve", windowId: 3 })
  ]);

  const byTab = Object.fromEntries(
    pendingRecords(storage).map((record) => [record.tabId, record.text])
  );
  assert.deepEqual(byTab, { 10: "tab ten", 11: "tab eleven", 12: "tab twelve" });
});

test("a newer request supersedes an in-flight one through the request lifecycle", async () => {
  // Documented policy: the coordinator aborts the superseded request, so a stale
  // result can never overwrite the newer one.
  const { createRequestCoordinator } = require("../background/request-coordinator.js");
  const coordinator = createRequestCoordinator();
  const scope = { surface: "sidepanel", tabId: 7, frameId: 0 };

  const active = coordinator.begin(scope);
  const results = [];
  const older = new Promise((resolve) => {
    active.signal.addEventListener("abort", () => {
      results.push("older-aborted");
      resolve();
    });
  });

  const replacement = coordinator.begin(scope);
  await older;

  assert.equal(active.signal.aborted, true, "the older request is aborted");
  assert.equal(replacement.signal.aborted, false, "the newer request survives");
  assert.deepEqual(results, ["older-aborted"]);
  replacement.finish();
});

// ------------------------------------------------------------- panel identity

test("tab switch before READY does not misroute request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  let activeTab = 20;
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    resolveActiveTab: async () => activeTab
  });
  const controller = createController({ state, handoff, randomIds: ["for-a"] });

  await controller.open(20, { text: "belongs to tab A", windowId: 1 });
  // The user switches to tab B before the panel announces itself.
  activeTab = 21;

  const panel = connectPanel(handoff, { windowId: 1, tabId: 20 });
  panel.ready();
  await flush();

  const delivered = panel.delivered();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].pending.tabId, 20, "the tab token, not the active tab, decides");
  assert.equal(delivered[0].pending.text, "belongs to tab A");
});

test("tab switch before CLAIM does not misroute request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  let activeTab = 30;
  const handoff = createSidePanelHandoff({
    state,
    bindingStore: storage,
    resolveActiveTab: async () => activeTab
  });
  const controller = createController({ state, handoff, randomIds: ["a", "b"] });

  // Tab A's panel resolves its scope first.
  const panel = connectPanel(handoff, { windowId: 1, tabId: 30 });
  panel.ready();
  await flush();
  assert.equal(panel.received[0].type, config.SIDE_PANEL.IDLE);

  // A request lands for tab A, then the user switches to tab B before the claim.
  await controller.open(30, { text: "still tab A", windowId: 1 });
  activeTab = 31;
  await state.replace(
    state.prepare({ tabId: 31, frameId: 0, windowId: 1, requestId: "b", text: "tab B text" })
  );

  panel.claim();
  await flush();

  const delivered = panel.delivered();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].pending.text, "still tab A");
  assert.equal(delivered[0].pending.tabId, 30);
  // Tab B's request is untouched.
  assert.equal((await state.peek({ tabId: 31 })).text, "tab B text");
});

test("two panel ports in one window remain isolated", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });

  await state.replace(
    state.prepare({ tabId: 40, frameId: 0, windowId: 9, requestId: "for-40", text: "text for 40" })
  );
  await state.replace(
    state.prepare({ tabId: 41, frameId: 0, windowId: 9, requestId: "for-41", text: "text for 41" })
  );

  const panelForty = connectPanel(handoff, { windowId: 9, tabId: 40 });
  const panelFortyOne = connectPanel(handoff, { windowId: 9, tabId: 41 });
  panelForty.ready();
  panelFortyOne.ready();
  await flush();

  assert.equal(panelForty.delivered().length, 1);
  assert.equal(panelForty.delivered()[0].pending.text, "text for 40");
  assert.equal(panelFortyOne.delivered().length, 1);
  assert.equal(panelFortyOne.delivered()[0].pending.text, "text for 41");
});

test("worker restart preserves panel identity", async () => {
  const storage = memoryStorage();

  // Generation 1 opens for tab 50 and dies.
  const firstState = createSidePanelState(storage);
  const firstHandoff = createSidePanelHandoff({ state: firstState, bindingStore: storage });
  const controller = createController({
    state: firstState,
    handoff: firstHandoff,
    randomIds: ["survivor"]
  });
  await controller.open(50, { text: "survives restart", windowId: 6 });
  await flush();

  // Generation 2: empty memory, same session storage, and a DIFFERENT active tab.
  const secondState = createSidePanelState(storage);
  const secondHandoff = createSidePanelHandoff({
    state: secondState,
    bindingStore: storage,
    resolveActiveTab: async () => 999
  });
  assert.equal(secondHandoff.intentFor({ tabId: 50 }), null, "intents do not survive");

  // The panel DOCUMENT survives a worker restart, so it still carries its token.
  const panel = connectPanel(secondHandoff, { windowId: 6, tabId: 50 });
  panel.ready();
  await flush();

  const delivered = panel.delivered();
  assert.equal(delivered.length, 1, "the tab token survives the restart");
  assert.equal(delivered[0].pending.tabId, 50);
  assert.equal(delivered[0].pending.text, "survives restart");

  panel.claim();
  await flush();
  assert.equal(panel.delivered().length, 1, "at most once after a restart");
});

test("closed source tab cleans pending request", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const configurator = createSidePanelConfigurator({
    sidePanel: { async setOptions() {} },
    tabs: { async query() { return []; } }
  });
  const controller = createController({ state, handoff, configurator, randomIds: ["doomed"] });

  await controller.open(60, { text: "tab will close", windowId: 7 });
  assert.equal(pendingRecords(storage).length, 1, "one pending record for the tab");

  // What chrome.tabs.onRemoved does in the service worker.
  await state.clearTab(60);
  handoff.forgetTab(60);
  configurator.forget(60);

  assert.equal(await state.peek({ tabId: 60 }), null);
  assert.equal(handoff.intentFor({ tabId: 60 }), null);

  const panel = connectPanel(handoff, { windowId: 7, tabId: 60 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 0, "a closed tab's text is never delivered");
  assert.equal(panel.received[0].type, config.SIDE_PANEL.IDLE);
});

test("an untokenized panel cannot resolve identity through the open binding", async () => {
  // Strict tab-specific model: the open binding is defensive metadata only. It must
  // never promote a global/legacy panel into a supported tab-specific one.
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const controller = createController({ state, handoff, randomIds: ["no-token"] });

  await controller.open(70, { text: "tab 70 only", windowId: 8 });
  const binding = await handoff.bindingFor(8);
  assert.equal(binding.tabId, 70, "the binding still exists as metadata");

  const panel = connectPanel(handoff, { windowId: 8, tabId: null });
  panel.ready();
  await flush();

  assert.equal(panel.delivered().length, 0, "an untokenized panel receives nothing");
  assert.equal(panel.received[0].type, config.SIDE_PANEL.UNSUPPORTED);
  assert.equal(panel.received[0].code, config.SIDE_PANEL_ERROR.NOT_CONFIGURED);
  assert.equal(
    (await state.peek({ tabId: 70 })).text,
    "tab 70 only",
    "the request stays pending for its own configured panel"
  );
});

test("the active tab is never used to resolve panel identity", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  let activeTabLookups = 0;
  const handoff = createSidePanelHandoff({
    state,
    resolveActiveTab: async () => {
      activeTabLookups += 1;
      return 80;
    }
  });
  await state.replace(
    state.prepare({ tabId: 80, frameId: 0, windowId: 3, requestId: "eighty", text: "tab 80" })
  );

  const panel = connectPanel(handoff, { windowId: 3 });
  panel.ready();
  await flush();

  assert.equal(panel.delivered().length, 0, "no identity without a tab token");
  assert.equal(panel.received[0].type, config.SIDE_PANEL.UNSUPPORTED);
  assert.equal(activeTabLookups, 0, "the active tab must not even be consulted");
  assert.equal((await state.peek({ tabId: 80 })).text, "tab 80", "tab 80 keeps its request");
});

// --------------------------------------------------------- combined scenarios

test("delayed storage plus two overlapping requests still delivers the newest once", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const gates = [];
  const slowState = {
    ...state,
    async replace(value) {
      await new Promise((resolve) => gates.push(resolve));
      return state.replace(value);
    }
  };
  const controller = createController({ state: slowState, handoff, randomIds: ["p", "q"] });

  const first = controller.open(90, { text: "slow older", windowId: 4 });
  const second = controller.open(90, { text: "slow newer", windowId: 4 });

  // The panel is ready long before either write lands.
  const panel = connectPanel(handoff, { windowId: 4, tabId: 90 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered().length, 0);
  assert.equal(panel.received[0].type, config.SIDE_PANEL.WAITING);

  for (const release of gates) release();
  await Promise.all([first, second]);
  panel.claim();
  await flush();

  assert.equal(panel.delivered().length, 1);
  assert.equal(panel.delivered()[0].pending.text, "slow newer");
  assert.equal(await state.peek({ tabId: 90 }), null);
});

test("worker restart plus a newer superseding request delivers only the newer text", async () => {
  const storage = memoryStorage();

  const firstState = createSidePanelState(storage);
  const firstHandoff = createSidePanelHandoff({ state: firstState, bindingStore: storage });
  await createController({
    state: firstState,
    handoff: firstHandoff,
    randomIds: ["before-restart"]
  }).open(100, { text: "before restart", windowId: 2 });

  // Restart, then a newer request for the same tab.
  const secondState = createSidePanelState(storage, { startSequence: 0 });
  const secondHandoff = createSidePanelHandoff({ state: secondState, bindingStore: storage });
  await createController({
    state: secondState,
    handoff: secondHandoff,
    randomIds: ["after-restart"]
  }).open(100, { text: "after restart", windowId: 2 });

  const panel = connectPanel(secondHandoff, { windowId: 2, tabId: 100 });
  panel.ready();
  await flush();

  assert.equal(panel.delivered().length, 1);
  assert.equal(panel.delivered()[0].pending.text, "after restart");
  assert.equal(await secondState.peek({ tabId: 100 }), null);
});

test("panel reload after the newer request was consumed starts nothing", async () => {
  const storage = memoryStorage();
  const state = createSidePanelState(storage);
  const handoff = createSidePanelHandoff({ state, bindingStore: storage });
  const controller = createController({ state, handoff, randomIds: ["r1", "r2"] });

  await controller.open(110, { text: "older", windowId: 1 });
  await controller.open(110, { text: "newer", windowId: 1 });

  const panel = connectPanel(handoff, { windowId: 1, tabId: 110 });
  panel.ready();
  await flush();
  assert.equal(panel.delivered()[0].pending.text, "newer");

  const reloaded = connectPanel(handoff, { windowId: 1, tabId: 110 });
  reloaded.ready();
  await flush();
  assert.equal(reloaded.delivered().length, 0, "a reload must not replay the request");
  assert.equal(reloaded.received[0].type, config.SIDE_PANEL.IDLE);
});

test("a timeout followed by a new request still succeeds", async () => {
  let time = 1000;
  let sequence = 0;
  const scheduled = new Map();
  const timers = {
    setTimeout(callback, delay) {
      const id = (sequence += 1);
      scheduled.set(id, { callback, at: time + Number(delay || 0) });
      return id;
    },
    clearTimeout: (id) => scheduled.delete(id)
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

  const storage = memoryStorage();
  const state = createSidePanelState(storage, { now: () => time });
  const handoff = createSidePanelHandoff({ state, bindingStore: storage, now: () => time });
  // Announce a handoff whose storage write never lands.
  handoff.announce({ tabId: 120, frameId: 0, windowId: 5, requestId: "lost" });

  const pair = createPortPair();
  handoff.connect(pair.workerPort);
  const outcomes = [];
  const translated = [];
  const client = createSidePanelHandoffClient({
    runtime: { connect: () => pair.clientPort },
    windows: { getCurrent: async () => ({ id: 5 }) },
    tabToken: "120",
    timers,
    now: () => time,
    onRequest: (pending) => translated.push(pending.text),
    onTimeout: () => outcomes.push("timeout"),
    onIdle: () => outcomes.push("idle")
  });
  await client.start();
  await advance(config.SIDE_PANEL_HANDOFF_TIMEOUT_MS + 50);
  assert.deepEqual(outcomes, ["timeout"], "the lost handoff is visibly reported");

  // A fresh request afterwards must work normally.
  const controller = createController({ state, handoff, randomIds: ["recovered"] });
  await controller.open(120, { text: "recovered request", windowId: 5 });
  await advance(50);

  assert.deepEqual(translated, ["recovered request"]);
  assert.equal(await state.peek({ tabId: 120 }), null);
});

// -------------------------------------------------------------- configuration

test("the panel model is tab-specific and configured off the user-action path", async () => {
  const calls = [];
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions(options) {
        calls.push(options);
      }
    },
    tabs: {
      async query() {
        return [{ id: 1 }, { id: 2 }, { id: 3 }];
      }
    }
  });

  const result = await configurator.configureAll();
  assert.equal(result.configured, 3);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      "sidepanel/sidepanel.html?tab=1",
      "sidepanel/sidepanel.html?tab=2",
      "sidepanel/sidepanel.html?tab=3"
    ]
  );
  assert.ok(calls.every((call) => call.enabled === true && Number.isInteger(call.tabId)));

  // Repeat configuration is a no-op, so lifecycle events stay cheap.
  const before = calls.length;
  await configurator.configure(2);
  assert.equal(calls.length, before, "an already-configured tab is not reconfigured");

  configurator.forget(2);
  await configurator.configure(2);
  assert.equal(calls.length, before + 1, "a closed and reopened tab is reconfigured");
});

test("a failed tab configuration is reported without breaking delivery", async () => {
  const configurator = createSidePanelConfigurator({
    sidePanel: {
      async setOptions() {
        throw new Error("No tab with id: 404");
      }
    },
    tabs: { async query() { return []; } }
  });
  const result = await configurator.configure(404);
  assert.equal(result.status, "configuration-failed");
  assert.match(result.error, /No tab with id/);
  assert.match(configurator.failureFor(404), /No tab with id/);
  assert.equal(configurator.configuredPath(404), null);
});
