const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { safariManifest } = require("../../scripts/build-safari-kit.js");

const ROOT = path.resolve(__dirname, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));

test("the Chrome manifest never asks for nativeMessaging", () => {
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
});

test("the Safari manifest adds nativeMessaging and drops Chrome-only keys", () => {
  const safari = safariManifest(manifest);
  assert.ok(safari.permissions.includes("nativeMessaging"));
  assert.equal("minimum_chrome_version" in safari, false);
  assert.equal(safari.version, manifest.version);
  assert.deepEqual(safari.content_scripts, manifest.content_scripts);
  // The source manifest is untouched.
  assert.equal(manifest.permissions.includes("nativeMessaging"), false);
});

test("Safari kit ships the native Swift sources, the installer and the guide", () => {
  for (const file of [
    "platforms/safari/native/SafariWebExtensionHandler.swift",
    "platforms/safari/native/ViewController.swift",
    "platforms/safari/install.sh",
    "platforms/safari/README.md"
  ]) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  }
  const handler = fs.readFileSync(
    path.join(ROOT, "platforms/safari/native/SafariWebExtensionHandler.swift"),
    "utf8"
  );
  // Swift answers the same operations that createAppleBridge sends.
  for (const op of ["detect", "availability", "translate", "openApp"]) {
    assert.match(handler, new RegExp(`case "${op}"`), op);
  }
  for (const code of ["needs-download", "unavailable"]) {
    assert.match(handler, new RegExp(`"code": "${code}"`), code);
  }
  const bridge = fs.readFileSync(path.join(ROOT, "src", "builtin-translator.js"), "utf8");
  for (const op of ["detect", "availability", "translate", "openApp"]) {
    assert.match(bridge, new RegExp(`op: "${op}"`), op);
  }
});

test("install.sh survives macOS bash 3.2: every variable is written as ${NAME}", () => {
  const script = fs.readFileSync(path.join(ROOT, "platforms/safari/install.sh"), "utf8");
  // bash 3.2 counts the bytes of Cyrillic letters as part of a variable name:
  // "$PROJECT_DIR…" turned into a non-existent "PROJECT_DIR?".
  const code = script
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  const unbraced = code.match(/\$[A-Za-z_][A-Za-z0-9_]*/g) || [];
  assert.deepEqual(unbraced, [], `variables without braces: ${unbraced.join(", ")}`);
});
