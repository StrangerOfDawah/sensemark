const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");

const repo = path.join(__dirname, "..", "..");
const root = path.join(repo, "src");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const readRepo = (file) => fs.readFileSync(path.join(repo, file), "utf8");

test("toolbar action opens the manual popup with only packaged scripts", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.action.default_popup, "popup.html");
  assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
  assert.equal(manifest.default_locale, "ru");

  const document = new JSDOM(read("popup.html")).window.document;
  assert.deepEqual(
    [...document.querySelectorAll("script")].map((script) => script.getAttribute("src")),
    [
      "i18n.js",
      "language-detection.js",
      "word-response.js",
      "text-response.js",
      "builtin-translator.js",
      "manual-translation.js",
      "popup.js"
    ]
  );
  assert.equal(
    [...document.querySelectorAll("script")].some((script) => !script.src),
    false
  );
  assert.equal(document.getElementById("translateButton"), null);
  assert.ok(document.getElementById("activity"));
  assert.equal(document.getElementById("clearButton").getAttribute("data-i18n-aria-label"), "clearAria");
  assert.equal(document.querySelector(".route").getAttribute("data-i18n-aria-label"), "routeAria");

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

  const fontSizes = [...popupStyles.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((match) =>
    Number(match[1])
  );
  assert.ok(fontSizes.length > 0);
  assert.ok(
    fontSizes.every((size) => size >= 10),
    "Popup text must stay at least 10px"
  );
});

test("content runtime declares every helper in manifest and fallback injection", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const files = manifest.content_scripts[0].js;
  assert.deepEqual(files, [
    "i18n.js",
    "language-detection.js",
    "selection-text.js",
    "word-response.js",
    "text-response.js",
    "ui-scale.js",
    "builtin-translator.js",
    "card-theme.js",
    "content/card-styles.js",
    "content/page-text.js",
    "content/placement.js",
    "content/status-pill.js",
    "content/content.js"
  ]);

  const background = read("background.js");
  for (const file of files) assert.match(background, new RegExp(`"${file.replace(".", "\\.")}"`));
  assert.doesNotMatch(background, /chrome\.action\.onClicked/);
});

test("the service worker loads only packaged modules with importScripts", () => {
  const background = read("background.js");
  const call = background.match(/importScripts\(([^)]*)\)/);
  assert.ok(call, "background.js imports its modules");
  const files = [...call[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(files, ["i18n.js", "background/prompts.js", "background/validation.js"]);
  const packageScript = readRepo("scripts/package-extension.sh");
  for (const file of files) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} exists`);
    assert.match(packageScript, new RegExp(`(?:^|\\s)${file.replace(/[./]/g, "\\$&")}(?:\\s|\\\\|$)`, "m"));
  }
});

test("privacy disclosures include selected and manually entered text", () => {
  assert.match(readRepo("PRIVACY.md"), /manually types or pastes/);
  const options = read("options.html");
  assert.match(options, /<!--t:privacyText-->/);
  assert.match(options, /<!--t:consentText-->/);
});

test("CI runs locked tests, coverage gates, and archive validation", () => {
  const workflow = readRepo(".github/workflows/pr-build.yml");
  assert.match(workflow, /npm ci --ignore-scripts/);
  assert.match(workflow, /npm run test:coverage/);
  assert.match(workflow, /node scripts\/validate-extension\.js "\$archive"/);
  assert.match(workflow, /branches: \[main\]/);

  const packageJson = JSON.parse(readRepo("package.json"));
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-lines=90/);
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-branches=75/);
  assert.match(packageJson.scripts["test:coverage"], /test-coverage-functions=95/);
});
