const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const positioner = require("../content/ui/card-positioner.js");
const intent = require("../content/selection/selection-intent.js");
const { createCardDragController } = require("../content/ui/card-drag-controller.js");
const { createCardResizeController } = require("../content/ui/card-resize-controller.js");

test("card position flips above and clamps inside the viewport", () => {
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(
    positioner.positionCard(
      { left: 350, right: 450, top: 100, bottom: 120, width: 100, height: 20 },
      { width: 300, height: 200 },
      viewport
    ),
    { left: 250, top: 130 }
  );
  assert.equal(
    positioner.positionCard(
      { left: 790, right: 800, top: 560, bottom: 580, width: 10, height: 20 },
      { width: 300, height: 200 },
      viewport
    ).top,
    350
  );
  assert.deepEqual(
    positioner.clampPosition({ left: -50, top: 900 }, { width: 300, height: 200 }, viewport),
    { left: 8, top: 392 }
  );
  assert.deepEqual(
    positioner.positionCard(null, { width: 200, height: 100 }, viewport),
    { left: 300, top: 310 }
  );
  assert.equal(positioner.clamp(5, 0, 3), 3);
});

test("copy shortcuts suppress automatic translation", () => {
  assert.equal(intent.isCopyShortcut({ key: "c", ctrlKey: true }), true);
  assert.equal(intent.isCopyShortcut({ key: "C", metaKey: true }), true);
  assert.equal(intent.isCopyShortcut({ key: "c", ctrlKey: true, altKey: true }), false);
  assert.equal(intent.modifierMatches("alt", { altKey: true }), true);
  assert.equal(intent.modifierMatches("shift", { shiftKey: true }), true);
  assert.equal(intent.modifierMatches("meta", { ctrlKey: true }), true);
  assert.equal(intent.modifierMatches("none", {}), true);
});

test("intent controller waits for stable selection and supports all modes", () => {
  const jobs = [];
  const events = [];
  const controller = intent.createIntentController({
    mode: config.SELECTION_MODE.AUTOMATIC,
    stableDelayMs: 600,
    schedule(fn, delay) {
      jobs.push({ fn, delay, cancelled: false });
      return jobs.at(-1);
    },
    cancelSchedule(job) {
      job.cancelled = true;
    },
    onAutomatic: () => events.push("automatic"),
    onButton: () => events.push("button"),
    onDismiss: () => events.push("dismiss")
  });
  controller.handlePointerDown();
  controller.evaluate({});
  assert.equal(jobs.length, 0);
  controller.handlePointerUp({});
  assert.equal(jobs.at(-1).delay, 600);
  jobs.at(-1).fn();
  assert.deepEqual(events, ["automatic"]);

  controller.update({ mode: "button", stableDelayMs: 700, requiredModifier: "alt" });
  assert.equal(events.at(-1), "dismiss");
  controller.evaluate({});
  assert.equal(jobs.at(-1).delay, 600);
  controller.evaluate({ altKey: true });
  assert.equal(jobs.at(-1).delay, 700);
  jobs.at(-1).fn();
  assert.equal(events.at(-1), "button");

  controller.handleKeyDown({ key: "c", ctrlKey: true });
  assert.equal(events.at(-1), "button");
  controller.cancel();
  controller.update({ mode: "manual" });
  controller.evaluate({});
  assert.equal(events.at(-1), "dismiss");
});

function pointerEvent(window, type, values) {
  const event = new window.MouseEvent(type, {
    bubbles: true,
    button: values.button ?? 0,
    clientX: values.clientX,
    clientY: values.clientY
  });
  Object.defineProperty(event, "pointerId", { value: values.pointerId ?? 1 });
  return event;
}

test("drag controller uses pointer capture, rAF batching, clamping and reset", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<div id="card"><header></header></div>`);
  const card = dom.window.document.getElementById("card");
  const handle = card.querySelector("header");
  let captured = 0;
  let reset = 0;
  handle.setPointerCapture = (id) => {
    captured = id;
  };
  handle.releasePointerCapture = () => {};
  card.getBoundingClientRect = () => ({
    left: Number.parseFloat(card.style.left) || 10,
    top: Number.parseFloat(card.style.top) || 10,
    width: 200,
    height: 100
  });
  createCardDragController({
    element: card,
    handle,
    viewport: () => ({ width: 500, height: 400 }),
    scheduleFrame: (callback) => {
      callback();
      return 1;
    },
    onReset: () => {
      reset += 1;
    }
  });
  handle.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 20, clientY: 20 }));
  handle.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: 700, clientY: 600 }));
  assert.equal(captured, 1);
  assert.equal(card.style.left, "292px");
  assert.equal(card.style.top, "292px");
  handle.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 700, clientY: 600 }));
  handle.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(reset, 1);
});

test("resize controller clamps size and reports the persisted geometry", () => {
  const { JSDOM } = require("jsdom");
  const dom = new JSDOM(`<div id="card"><i></i></div>`);
  const card = dom.window.document.getElementById("card");
  const handle = card.querySelector("i");
  handle.setPointerCapture = () => {};
  handle.releasePointerCapture = () => {};
  card.getBoundingClientRect = () => ({ width: 320, height: 180 });
  const previousWidth = global.innerWidth;
  const previousHeight = global.innerHeight;
  global.innerWidth = 800;
  global.innerHeight = 600;
  let size = null;
  createCardResizeController({
    element: card,
    handle,
    scheduleFrame: (callback) => {
      callback();
      return 1;
    },
    onSize: (next) => {
      size = next;
    }
  });
  handle.dispatchEvent(pointerEvent(dom.window, "pointerdown", { clientX: 0, clientY: 0 }));
  handle.dispatchEvent(pointerEvent(dom.window, "pointermove", { clientX: -500, clientY: -500 }));
  assert.deepEqual(size, { width: 280, height: 150 });
  handle.dispatchEvent(pointerEvent(dom.window, "pointerup", { clientX: 0, clientY: 0 }));
  global.innerWidth = previousWidth;
  global.innerHeight = previousHeight;
});
