const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { safariManifest } = require("../scripts/build-safari-kit.js");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

test("the Chrome manifest never asks for nativeMessaging", () => {
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
});

test("the Safari manifest adds nativeMessaging and drops Chrome-only keys", () => {
  const safari = safariManifest(manifest);
  assert.ok(safari.permissions.includes("nativeMessaging"));
  assert.equal("minimum_chrome_version" in safari, false);
  assert.equal(safari.version, manifest.version);
  assert.deepEqual(safari.content_scripts, manifest.content_scripts);
  // Исходный манифест не испорчен.
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
});

test("Safari kit ships the native Swift sources, the installer and the guide", () => {
  for (const file of [
    "safari/native/SafariWebExtensionHandler.swift",
    "safari/native/ViewController.swift",
    "safari/install.sh",
    "safari/README.md"
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  const handler = fs.readFileSync(path.join(ROOT, "safari/native/SafariWebExtensionHandler.swift"), "utf8");
  // Swift отвечает на те же операции, что посылает createAppleBridge.
  for (const op of ["detect", "availability", "translate", "openApp"]) {
    assert.match(handler, new RegExp(`case "${op}"`), op);
  }
  for (const code of ["needs-download", "unavailable"]) {
    assert.match(handler, new RegExp(`"code": "${code}"`), code);
  }
  const bridge = fs.readFileSync(path.join(ROOT, "builtin-translator.js"), "utf8");
  for (const op of ["detect", "availability", "translate", "openApp"]) {
    assert.match(bridge, new RegExp(`op: "${op}"`), op);
  }
});
