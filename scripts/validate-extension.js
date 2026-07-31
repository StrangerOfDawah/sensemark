const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const exists = (file) => fs.existsSync(path.join(root, file));
const manifest = JSON.parse(read("manifest.json"));
const packageJson = JSON.parse(read("package.json"));
const runtimeDirectories = [
  "background",
  "shared",
  "content",
  "extension",
  "popup",
  "options",
  "sidepanel",
  "icons"
];
const rootRuntimeFiles = ["manifest.json", "LICENSE", "PRIVACY.md", "PRIVACY.en.md"];

function walk(relativeDirectory) {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relativeDirectory), {
    withFileTypes: true
  })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) output.push(...walk(relative));
    else output.push(relative);
  }
  return output;
}

const runtimeFiles = [
  ...rootRuntimeFiles,
  ...runtimeDirectories.flatMap(walk)
].sort();

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.equal(manifest.version, packageJson.version, "package.json and manifest versions differ");
assert.equal(manifest.version, "1.4.2", "Release readiness remediation must ship as 1.4.2");
assert.equal(manifest.minimum_chrome_version, "119", "Chrome 119 is required");
assert.equal(manifest.action?.default_popup, "popup/popup.html", "Toolbar popup is missing");
assert.equal(manifest.options_ui?.page, "options/options.html", "Options page is missing");
assert.equal(
  manifest.background?.service_worker,
  "background/service-worker.js",
  "Modular service worker is missing"
);
assert.equal(
  manifest.side_panel?.default_path,
  "sidepanel/sidepanel.html",
  "Protected-page side-panel fallback is missing"
);
assert.deepEqual(
  [...manifest.host_permissions].sort(),
  ["https://api.openai.com/*"],
  "Only the OpenAI host permission is expected"
);
assert.ok(manifest.permissions.includes("sidePanel"), "sidePanel permission is missing");
assert.deepEqual(
  [...manifest.permissions].sort(),
  ["activeTab", "contextMenus", "sidePanel", "scripting", "storage"].sort(),
  "Unexpected extension permission"
);
assert.ok(manifest.content_scripts.every((entry) => entry.all_frames), "Content script must run in frames");
assert.ok(
  manifest.content_scripts.every((entry) => entry.match_about_blank && entry.match_origin_as_fallback),
  "Nested about/srcdoc frames must be covered"
);

for (const file of runtimeFiles) {
  assert.ok(exists(file), `Required runtime file is missing: ${file}`);
}

const declaredScripts = new Set([
  manifest.background.service_worker,
  ...manifest.content_scripts.flatMap((entry) => entry.js || [])
]);
for (const file of declaredScripts) {
  assert.ok(exists(file), `Manifest references a missing script: ${file}`);
}

const serviceWorkerSource = read(manifest.background.service_worker);
const importBlock = serviceWorkerSource.match(/^importScripts\(([\s\S]*?)\);/);
assert.ok(importBlock, "Service worker must declare imports with importScripts()");
for (const match of importBlock[1].matchAll(/["']([^"']+\.js)["']/g)) {
  const imported = localReference(manifest.background.service_worker, match[1]);
  assert.ok(exists(imported), `Service worker imports a missing script: ${imported}`);
}

function localReference(htmlFile, reference) {
  const withoutHash = reference.split(/[?#]/, 1)[0];
  return path.posix.normalize(path.posix.join(path.posix.dirname(htmlFile), withoutHash));
}

function validateHtml(file, requiredIds = []) {
  const dom = new JSDOM(read(file));
  const document = dom.window.document;
  for (const id of requiredIds) {
    assert.ok(document.getElementById(id), `${file} is missing #${id}`);
  }

  for (const script of document.querySelectorAll("script")) {
    assert.ok(script.src, `${file} contains inline executable JavaScript`);
    const source = script.getAttribute("src");
    assert.ok(!/^(?:https?:)?\/\//i.test(source), `${file} loads remote code: ${source}`);
    assert.ok(exists(localReference(file, source)), `${file} references a missing script: ${source}`);
  }

  for (const element of document.querySelectorAll("[src], link[href]")) {
    const reference = element.getAttribute("src") || element.getAttribute("href");
    if (!reference || /^(?:https?:|data:|#)/i.test(reference)) continue;
    assert.ok(
      exists(localReference(file, reference)),
      `${file} references a missing asset: ${reference}`
    );
  }
}

validateHtml("popup/popup.html", ["source", "translate", "copy", "result", "status"]);
validateHtml("options/options.html", [
  "apiKey",
  "model",
  "customModel",
  "selectionMode",
  "stableDelay",
  "modifier",
  "consent",
  "deleteKey",
  "test"
]);
validateHtml("sidepanel/sidepanel.html", ["source", "translate", "copy", "result", "status"]);

const javascriptFiles = runtimeFiles.filter((file) => file.endsWith(".js"));
for (const file of javascriptFiles) {
  new vm.Script(read(file), { filename: file });
}

for (const file of runtimeFiles.filter((item) => /\.(?:css|html)$/.test(item))) {
  assert.doesNotMatch(read(file), /url\(\s*['"]?https?:/i, `${file} loads a remote asset`);
}

const contentSource = runtimeFiles
  .filter((file) => file.startsWith("content/") && file.endsWith(".js"))
  .map(read)
  .join("\n");
assert.doesNotMatch(contentSource, /chrome\.storage\.local/, "Content script reads private storage");
assert.doesNotMatch(contentSource, /\bapiKey\b/, "Content script can observe the API key");

const runtimeSource = runtimeFiles
  .filter((file) => file.endsWith(".js"))
  .map(read)
  .join("\n");
for (const forbidden of [
  /location\.hostname/,
  /data-word-location/,
  /data-font/,
  /code_v/i,
  /repairResponse/,
  /\[\[translation\]\]/i
]) {
  assert.doesNotMatch(runtimeSource, forbidden, `Forbidden site/legacy branch remains: ${forbidden}`);
}

const packageScript = read("scripts/package-extension.sh");
for (const item of [...runtimeDirectories, ...rootRuntimeFiles]) {
  assert.match(
    packageScript,
    new RegExp(`(?:^|\\s)${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|\\\\|$)`, "m"),
    `Packaging script omits ${item}`
  );
}

const archive = process.argv[2];
if (archive) {
  const archivePath = path.resolve(root, archive);
  assert.ok(fs.existsSync(archivePath), `Archive does not exist: ${archive}`);
  execFileSync("unzip", ["-t", archivePath], { stdio: "pipe" });
  const entries = execFileSync("unzip", ["-Z1", archivePath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const entrySet = new Set(entries);
  for (const file of runtimeFiles) {
    assert.ok(entrySet.has(file), `Archive omits ${file}`);
  }
  for (const prefix of [
    ".git/",
    ".github/",
    "tests/",
    "scripts/",
    "node_modules/",
    "coverage/",
    "dist/",
    "docs/"
  ]) {
    assert.ok(!entries.some((entry) => entry.startsWith(prefix)), `Archive contains ${prefix}`);
  }
  for (const file of [
    "package.json",
    "package-lock.json",
    "REFACTOR_NOTES.md",
    "RESEARCH_NOTES.md",
    "TECHNICAL_REVIEW_REPORT.md"
  ]) {
    assert.ok(!entrySet.has(file), `Archive contains source-only file: ${file}`);
  }
}

console.log(
  archive
    ? `Validated extension source and ${archive}.`
    : `Validated ${runtimeFiles.length} runtime files and extension metadata.`
);
