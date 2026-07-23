const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("toolbar action opens the manual popup with only packaged scripts", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.action.default_title, "Sensemark — ручной перевод");

  const document = new JSDOM(read("popup.html")).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("script")].map((script) => script.getAttribute("src")),
    [
      "language-detection.js",
      "word-response.js",
      "text-response.js",
      "manual-translation.js",
      "popup.js"
    ]
  );
  assert.equal([...document.querySelectorAll("script")].some((script) => !script.src), false);
});

test("content runtime declares every helper in manifest and fallback injection", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const files = manifest.content_scripts[0].js;
  assert.deepEqual(files, [
    "language-detection.js",
    "selection-text.js",
    "word-response.js",
    "text-response.js",
    "ui-scale.js",
    "content.js"
  ]);

  const background = read("background.js");
  for (const file of files) assert.match(background, new RegExp(`"${file.replace(".", "\\.")}"`));
  assert.doesNotMatch(background, /chrome\.action\.onClicked/);
});

test("privacy disclosures include selected and manually entered text", () => {
  assert.match(read("PRIVACY.md"), /вручную ввёл или вставил/);
  assert.match(read("PRIVACY.en.md"), /manually types or pastes/);
  assert.match(read("options.html"), /выделенный или вручную введённый текст/);
});

test("CI runs locked tests, coverage gates, and archive validation", () => {
  const workflow = read(".github/workflows/pr-build.yml");
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run test:coverage/);
  assert.match(workflow, /node scripts\/validate-extension\.js "\$archive"/);
  assert.match(workflow, /branches: \[main\]/);

  const packageJson = JSON.parse(read("package.json"));
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-lines=90/);
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-branches=75/);
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-functions=95/);
});
