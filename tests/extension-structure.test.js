const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const manifest = JSON.parse(read("manifest.json"));

test("manifest is universal, frame-aware and exposes protected-page fallback", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "1.4.2");
  assert.equal(manifest.minimum_chrome_version, "119");
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
  assert.equal(manifest.side_panel.default_path, "sidepanel/sidepanel.html");
  assert.deepEqual(manifest.host_permissions, ["https://api.openai.com/*"]);
  assert.ok(manifest.permissions.includes("sidePanel"));
  assert.ok(manifest.content_scripts[0].all_frames);
  assert.ok(manifest.content_scripts[0].match_about_blank);
  assert.ok(manifest.content_scripts[0].match_origin_as_fallback);
  assert.ok(manifest.content_scripts[0].matches.includes("<all_urls>"));
});

test("content runtime contains no private settings or site-specific branches", () => {
  const files = manifest.content_scripts.flatMap((entry) => entry.js);
  const source = files.map(read).join("\n");
  assert.doesNotMatch(source, /chrome\.storage\.local|\bapiKey\b/);
  assert.doesNotMatch(
    source,
    /location\.hostname|data-word-location|data-font|code_v|quran|exact selector/i
  );
  assert.match(source, /getComposedRanges/);
  assert.match(source, /selectionStart/);
});

test("background treats context-menu selectionText as authoritative", () => {
  const source = read("background/service-worker.js");
  assert.match(source, /info\.selectionText/);
  assert.match(source, /info\.frameId/);
  assert.match(source, /chrome\.storage\.session/);
  assert.doesNotMatch(source, /repairResponse|\[\[translation\]\]/i);
});

test("extension pages contain no remote executable code", () => {
  for (const file of [
    "popup/popup.html",
    "options/options.html",
    "sidepanel/sidepanel.html"
  ]) {
    const source = read(file);
    assert.doesNotMatch(source, /<script(?![^>]*\bsrc=)/i);
    assert.doesNotMatch(source, /<script[^>]+src=["']https?:/i);
  }
});
