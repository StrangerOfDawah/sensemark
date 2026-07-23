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

const runtimeFiles = [
  "manifest.json",
  "background.js",
  "language-detection.js",
  "selection-text.js",
  "word-response.js",
  "text-response.js",
  "manual-translation.js",
  "ui-scale.js",
  "content.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "options.html",
  "options.js",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png",
  "LICENSE",
  "PRIVACY.md",
  "PRIVACY.en.md"
];

assert.equal(manifest.manifest_version, 3, "Manifest V3 is required");
assert.equal(manifest.version, packageJson.version, "package.json and manifest versions differ");
assert.equal(manifest.action?.default_popup, "popup.html", "Toolbar action must open popup.html");
assert.equal(manifest.options_ui?.page, "options.html", "Options page is missing");
assert.equal(manifest.background?.service_worker, "background.js", "Service worker is missing");
assert.ok(
  manifest.host_permissions?.includes("https://api.openai.com/*"),
  "OpenAI API host permission is missing"
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
    assert.ok(exists(source), `${file} references a missing script: ${source}`);
  }

  for (const element of document.querySelectorAll("[src], link[href]")) {
    const reference = element.getAttribute("src") || element.getAttribute("href");
    if (!reference || /^(?:https?:|data:|#)/i.test(reference)) continue;
    assert.ok(exists(reference), `${file} references a missing asset: ${reference}`);
  }
}

validateHtml("popup.html", [
  "sourceText",
  "translateButton",
  "clearButton",
  "settingsButton",
  "setupBanner",
  "result",
  "resultBody",
  "copyButton",
  "status"
]);
validateHtml("options.html", ["apiKey", "model", "autoTranslate", "dataConsent", "test"]);

const javascriptFiles = runtimeFiles.filter((file) => file.endsWith(".js"));
for (const file of javascriptFiles) {
  new vm.Script(read(file), { filename: file });
}

for (const file of ["popup.css", "options.html"]) {
  assert.doesNotMatch(read(file), /url\(\s*['"]?https?:/i, `${file} loads a remote asset`);
}

const packageScript = read("scripts/package-extension.sh");
for (const file of runtimeFiles.filter((item) => !item.startsWith("icons/"))) {
  assert.match(
    packageScript,
    new RegExp(`(?:^|\\s)${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|\\\\|$)`, "m"),
    `Packaging script omits ${file}`
  );
}
assert.match(packageScript, /(?:^|\s)icons(?:\s|\\|$)/m, "Packaging script omits icons");

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
  for (const prefix of [".git/", ".github/", "tests/", "node_modules/", "dist/"]) {
    assert.ok(!entries.some((entry) => entry.startsWith(prefix)), `Archive contains ${prefix}`);
  }
}

console.log(
  archive
    ? `Validated extension source and ${archive}.`
    : `Validated ${runtimeFiles.length} runtime files and extension metadata.`
);
