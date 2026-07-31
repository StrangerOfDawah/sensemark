const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const packageJson = require(path.join(root, "package.json"));
const version = packageJson.version;
const dist = path.join(root, "dist");
const sourceName = `sensemark-v${version}-source.zip`;
const productionName = `sensemark-v${version}.zip`;
const checksumName = `sensemark-v${version}-SHA256SUMS.txt`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function entries(archive) {
  return execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

const checksumPath = path.join(dist, checksumName);
assert.ok(fs.existsSync(checksumPath), `Missing checksum handoff: ${checksumName}`);
const expected = new Map(
  fs
    .readFileSync(checksumPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})  (.+)$/);
      assert.ok(match, `Invalid checksum line: ${line}`);
      return [match[2], match[1]];
    })
);

for (const name of [sourceName, productionName]) {
  const file = path.join(dist, name);
  assert.ok(fs.existsSync(file), `Missing artifact: ${name}`);
  assert.equal(sha256(file), expected.get(name), `Checksum mismatch: ${name}`);
  execFileSync("unzip", ["-t", file], { stdio: "pipe" });
}

const sourceEntries = entries(path.join(dist, sourceName));
const productionEntries = entries(path.join(dist, productionName));
for (const file of [
  "package.json",
  "package-lock.json",
  ".github/workflows/pr-build.yml",
  "tests/final-readiness.test.js",
  "scripts/verify-artifacts.js",
  "BROWSER_ACCEPTANCE.md"
]) {
  assert.ok(sourceEntries.includes(file), `Source archive omits ${file}`);
}
for (const prefix of ["node_modules/", "coverage/", "dist/"]) {
  assert.ok(!sourceEntries.some((entry) => entry.startsWith(prefix)), `Source contains ${prefix}`);
}
for (const prefix of [
  "tests/",
  "scripts/",
  ".github/",
  "node_modules/",
  "coverage/"
]) {
  assert.ok(
    !productionEntries.some((entry) => entry.startsWith(prefix)),
    `Production contains ${prefix}`
  );
}
for (const file of [
  "package.json",
  "package-lock.json",
  "REFACTOR_NOTES.md",
  "RESEARCH_NOTES.md",
  "TECHNICAL_REVIEW_REPORT.md"
]) {
  assert.ok(!productionEntries.includes(file), `Production contains ${file}`);
}

const archivedPackage = JSON.parse(
  execFileSync("unzip", ["-p", path.join(dist, sourceName), "package.json"], {
    encoding: "utf8"
  })
);
const archivedManifest = JSON.parse(
  execFileSync("unzip", ["-p", path.join(dist, productionName), "manifest.json"], {
    encoding: "utf8"
  })
);
assert.equal(archivedPackage.version, version);
assert.equal(archivedManifest.version, version);
assert.equal(archivedManifest.background.service_worker, "background/service-worker.js");
assert.equal(archivedManifest.action.default_popup, "popup/popup.html");
assert.equal(archivedManifest.options_ui.page, "options/options.html");
assert.equal(archivedManifest.side_panel.default_path, "sidepanel/sidepanel.html");

console.log(`Verified ${sourceName}: ${sourceEntries.length} entries.`);
console.log(`Verified ${productionName}: ${productionEntries.length} entries.`);
console.log(`Verified checksums from ${checksumName}.`);
