const assert = require("node:assert/strict");
const test = require("node:test");
const { changedParts, currentHashes, lockedHashes, PARTS } = require("../../scripts/design-lock.js");

test("design lock covers every locked part", () => {
  assert.deepEqual(Object.keys(lockedHashes()).sort(), Object.keys(PARTS).sort());
});

test("design has not changed without explicit approval", () => {
  const changed = changedParts();
  assert.deepEqual(
    changed,
    [],
    `The design changed: ${changed.join(", ")}.\n` +
      "If this is an intentional, reviewed change, accept it with: npm run design:approve\n" +
      "Otherwise revert the changes in these files."
  );
});

test("design lock hashes are stable for unchanged files", () => {
  assert.deepEqual(currentHashes(), currentHashes());
});
