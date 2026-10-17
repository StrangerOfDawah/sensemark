// Design lock: SHA-256 fingerprints of everything that defines how Sensemark
// looks. Checked by tests/integration/design-lock.test.js. To accept an
// intentional, reviewed visual change:
//   npm run design:approve
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lockFile = path.join(root, "tests", "design-lock.json");

// Each entry is one part of the design. The on-page UI lives in its own
// stylesheet module, so changes to the translation logic never touch the lock.
const PARTS = {
  "popup.css": (read) => read("popup.css"),
  "popup.html": (read) => read("popup.html"),
  "options.html": (read) => read("options.html"),
  // Every <style> block of the on-page UI: the status pill and the card.
  "content/card-styles.js": (read) => {
    const source = read("content/card-styles.js");
    const blocks = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
    if (!blocks.length) throw new Error("No <style> blocks found in content/card-styles.js.");
    return blocks.join("\n/* --- */\n");
  }
};

function read(file) {
  // Normalise Windows line endings so a checkout on Windows is not a false alarm.
  return fs.readFileSync(path.join(root, "src", file), "utf8").replace(/\r\n/g, "\n");
}

function currentHashes() {
  const hashes = {};
  for (const [name, extract] of Object.entries(PARTS)) {
    hashes[name] = crypto.createHash("sha256").update(extract(read)).digest("hex");
  }
  return hashes;
}

function lockedHashes() {
  return JSON.parse(fs.readFileSync(lockFile, "utf8"));
}

function changedParts() {
  const locked = lockedHashes();
  const current = currentHashes();
  return Object.keys(current).filter((name) => locked[name] !== current[name]);
}

if (require.main === module) {
  if (!process.argv.includes("--approve")) {
    const changed = changedParts();
    console.log(changed.length ? `Changed: ${changed.join(", ")}` : "Design unchanged.");
    process.exit(0);
  }
  const before = fs.existsSync(lockFile) ? changedParts() : Object.keys(PARTS);
  fs.writeFileSync(lockFile, `${JSON.stringify(currentHashes(), null, 2)}\n`);
  console.log(
    before.length
      ? `New design version accepted: ${before.join(", ")}`
      : "Design unchanged — nothing to accept."
  );
}

module.exports = { currentHashes, lockedHashes, changedParts, PARTS };
