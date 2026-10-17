const assert = require("node:assert/strict");
const test = require("node:test");
const Placement = require("../../src/content/placement.js");

const viewport = { width: 1200, height: 800 };
const rectangle = (left, top, width, height) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height
});

test("short selection: card below with the notch pointing at the selection centre", () => {
  const rect = rectangle(100, 100, 60, 20);
  const box = { width: 300, height: 150 };
  const spot = Placement.anchorPlacement({ rect, box, viewport });
  assert.equal(spot.side, "below");
  assert.equal(spot.top, 132); // 120 + 12 gap
  assert.equal(spot.left, 10, "clamped to the screen margin");
  assert.equal(spot.notchX, 120, "points at the middle of the word (130 - 10)");
});

test("no room below: the card goes above the selection", () => {
  const rect = rectangle(400, 700, 80, 20);
  const box = { width: 300, height: 150 };
  const spot = Placement.anchorPlacement({ rect, box, viewport });
  assert.equal(spot.side, "above");
  assert.equal(spot.top, 700 - 12 - 150);
});

test("no room above or below: the card stays on screen without a notch", () => {
  const rect = rectangle(400, 100, 80, 600);
  const box = { width: 300, height: 400 };
  const spot = Placement.anchorPlacement({ rect, box, viewport });
  assert.equal(spot.side, "free");
  assert.ok(spot.top >= 10 && spot.top + box.height <= viewport.height - 10);
});

test("a selection wider than the card aligns the card to its start", () => {
  const rect = rectangle(200, 100, 700, 20);
  const box = { width: 300, height: 150 };
  const spot = Placement.anchorPlacement({ rect, box, viewport });
  assert.equal(spot.left, 194);
  assert.equal(spot.notchX, 34);
});

test("while scrolling the card keeps its side and follows the text", () => {
  const box = { width: 300, height: 150 };
  const first = Placement.anchorPlacement({ rect: rectangle(400, 100, 80, 20), box, viewport });
  const moved = Placement.followAnchor({ rect: rectangle(400, -40, 80, 20), box, offset: first.offset });
  assert.equal(moved.top, first.top - 140);
  assert.equal(moved.left, first.left);

  const above = Placement.anchorPlacement({ rect: rectangle(400, 700, 80, 20), box, viewport });
  const scrolled = Placement.followAnchor({ rect: rectangle(400, 650, 80, 20), box, offset: above.offset });
  assert.equal(scrolled.top, above.top - 50);
});

test("margin note sits right of the selection and never runs past its end", () => {
  const rect = rectangle(90, 120, 600, 200);
  const note = Placement.marginPlacement({ rect, box: { width: 400, height: 300 } });
  assert.equal(note.left, 718);
  assert.equal(note.top, 120, "starts level with the selection");
  assert.deepEqual(note.bracket, { left: 700, top: 120, height: 200 });

  const scrolledAway = Placement.marginPlacement({
    rect: rectangle(90, -150, 600, 200),
    box: { width: 400, height: 300 }
  });
  assert.equal(scrolledAway.top, -150, "a note taller than the rest of the text scrolls with it");
});

test("status pill: under the selection, above it near the bottom, pinned in the drawer", () => {
  const below = Placement.statusPlacement({ rect: rectangle(100, 100, 60, 20), kind: "anchor", viewport });
  assert.deepEqual([below.x, below.y, below.fixed], [100, 128, false]);
  assert.deepEqual(below.origin, { x: 100, y: 142 });

  const nearBottom = Placement.statusPlacement({
    rect: rectangle(100, 770, 60, 20),
    kind: "anchor",
    viewport
  });
  assert.equal(nearBottom.y, 770 - 8 - 28);

  const margin = Placement.statusPlacement({ rect: rectangle(90, 120, 600, 200), kind: "margin", viewport });
  assert.deepEqual([margin.x, margin.y], [718, 120]);

  const drawer = Placement.statusPlacement({ rect: rectangle(0, 0, 10, 10), kind: "drawer", viewport });
  assert.equal(drawer.fixed, true);
  assert.deepEqual(drawer.origin, { x: 1184, y: 16, fixed: true });
});
