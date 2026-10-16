const assert = require("node:assert/strict");
const test = require("node:test");
const { changedParts, currentHashes, lockedHashes, PARTS } = require("../scripts/design-lock.js");

test("design lock covers every locked part", () => {
  assert.deepEqual(Object.keys(lockedHashes()).sort(), Object.keys(PARTS).sort());
});

test("design has not changed without explicit approval", () => {
  const changed = changedParts();
  assert.deepEqual(
    changed,
    [],
    `Изменился дизайн: ${changed.join(", ")}.\n` +
      "Если это намеренная правка, подтверди её командой: npm run design:approve\n" +
      "Если нет — откати изменения в этих файлах."
  );
});

test("design lock hashes are stable for unchanged files", () => {
  assert.deepEqual(currentHashes(), currentHashes());
});
