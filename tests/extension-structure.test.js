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
  assert.equal(document.getElementById("translateButton"), null);
  assert.ok(document.getElementById("activity"));
  assert.equal(document.getElementById("clearButton").getAttribute("aria-label"), "Очистить текст");
  assert.match(document.querySelector(".route").getAttribute("aria-label"), /автоматически/);

  const popupRuntime = read("popup.js");
  assert.match(popupRuntime, /insertFromPaste/);
  assert.match(popupRuntime, /autoTranslateDelayMs/);

  const popupStyles = read("popup.css");
  assert.match(popupStyles, /--secondary-label:/);
  assert.match(popupStyles, /border-radius:\s*28px/);
  assert.match(popupStyles, /corner-shape:\s*squircle/);
  assert.match(popupStyles, /\.clear-button\[hidden\]\s*{\s*display:\s*none/);
  assert.match(popupStyles, /@media \(prefers-contrast:\s*more\)/);
  assert.match(popupStyles, /@media \(prefers-reduced-transparency:\s*reduce\)/);
  assert.doesNotMatch(popupStyles, /min-height:\s*470px/);
  assert.doesNotMatch(popupStyles, /text-transform:\s*uppercase/);

  const fontSizes = [...popupStyles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map(
    (match) => Number(match[1])
  );
  assert.ok(fontSizes.length > 0);
  assert.ok(fontSizes.every((size) => size >= 10), "Popup text must stay at least 10px");
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
