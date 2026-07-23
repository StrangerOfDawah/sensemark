const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULTS, createScaleController } = require("../ui-scale.js");

test("scale controller applies small steps in both directions", () => {
  const controller = createScaleController();
  assert.deepEqual(controller.next(1, -10, 0), {
    changed: true,
    value: 1.02,
    reason: "applied"
  });
  assert.deepEqual(controller.next(1.02, 10, DEFAULTS.intervalMs), {
    changed: true,
    value: 1,
    reason: "applied"
  });
});

test("scale controller rate-limits trackpad bursts", () => {
  const controller = createScaleController();
  let scale = 1;
  const first = controller.next(scale, -10, 100);
  scale = first.value;
  for (let index = 0; index < 20; index++) {
    const result = controller.next(scale, -10, 100 + index);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "throttled");
  }
  assert.equal(scale, 1.02);
  assert.equal(controller.next(scale, -10, 170).value, 1.04);
});

test("scale controller enforces limits and ignores zero delta", () => {
  const controller = createScaleController();
  assert.equal(controller.next(DEFAULTS.max, -10, 0).reason, "limit");
  controller.reset();
  assert.equal(controller.next(DEFAULTS.min, 10, 0).reason, "limit");
  assert.equal(controller.next(1, 0, 100).reason, "zero");
});

test("scale controller reset accepts the next gesture immediately", () => {
  const controller = createScaleController();
  controller.next(1, -10, 100);
  assert.equal(controller.next(1.02, -10, 110).changed, false);
  controller.reset();
  assert.equal(controller.next(1.02, -10, 110).changed, true);
});
