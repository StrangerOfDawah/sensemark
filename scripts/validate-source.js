const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const archive = process.argv[2];
assert.ok(archive, "Usage: node scripts/validate-source.js <source-archive.zip>");
const archivePath = path.resolve(root, archive);
assert.ok(fs.existsSync(archivePath), `Source archive does not exist: ${archive}`);
execFileSync("unzip", ["-t", archivePath], { stdio: "pipe" });
const entries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const entrySet = new Set(entries);

for (const file of [
  "package.json",
  "package-lock.json",
  "manifest.json",
  "PRIVACY.md",
  "PRIVACY.en.md",
  "REFACTOR_NOTES.md",
  "RESEARCH_NOTES.md",
  "TECHNICAL_REVIEW_REPORT.md",
  "BROWSER_ACCEPTANCE.md",
  ".nvmrc",
  ".github/pull_request_template.md"
]) {
  assert.ok(entrySet.has(file), `Source archive omits ${file}`);
}
for (const prefix of [
  "tests/",
  "scripts/",
  "background/",
  "content/",
  "extension/",
  "shared/",
  "popup/",
  "options/",
  "sidepanel/"
]) {
  assert.ok(entries.some((entry) => entry.startsWith(prefix)), `Source archive omits ${prefix}`);
}
for (const prefix of [".git/", "node_modules/", "coverage/", "dist/"]) {
  assert.ok(!entries.some((entry) => entry.startsWith(prefix)), `Source archive contains ${prefix}`);
}
for (const entry of entries) {
  assert.doesNotMatch(
    entry,
    /(?:^|\/)(?:\.DS_Store|[^/]+\.swp|[^/]+\.tmp|[^/]+\.log)$/,
    `Source archive contains a temporary file: ${entry}`
  );
}

function archivedJson(file) {
  return JSON.parse(execFileSync("unzip", ["-p", archivePath, file], { encoding: "utf8" }));
}
const packageJson = archivedJson("package.json");
const packageLock = archivedJson("package-lock.json");
const manifest = archivedJson("manifest.json");
assert.equal(packageJson.version, "1.4.2");
assert.equal(packageLock.version, packageJson.version);
assert.equal(packageLock.packages[""].version, packageJson.version);
assert.equal(manifest.version, packageJson.version);

console.log(`Validated complete Sensemark ${packageJson.version} source archive: ${archive}.`);
