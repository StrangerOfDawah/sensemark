#!/usr/bin/env node
// Builds the Safari kit: dist/sensemark-safari-vX.Y.Z.zip.
//
// Contents:
//   extension/  the same extension as for Chrome, with a Safari manifest;
//   native/     Swift files of the Sensemark app (Apple translator, language window);
//   install.sh  creates the Xcode project on a Mac and drops these files in;
//   README.md   the step-by-step guide (in Russian).
//
// The Chrome build is unchanged: the nativeMessaging permission is added only
// to the Safari manifest.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Chrome manifest → Safari manifest.
function safariManifest(chromeManifest) {
  const manifest = JSON.parse(JSON.stringify(chromeManifest));
  // Bridge to the Sensemark app (Apple translator, language detection).
  manifest.permissions = [...new Set([...(manifest.permissions || []), "nativeMessaging"])];
  // Chrome-only key; Safari does not know it.
  delete manifest.minimum_chrome_version;
  return manifest;
}

function build() {
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));
  const version = chromeManifest.version;
  const archive = path.join(ROOT, "dist", `sensemark-v${version}.zip`);
  if (!fs.existsSync(archive)) {
    throw new Error(`Build the extension first: npm run package (missing ${archive})`);
  }

  const kitName = `sensemark-safari-v${version}`;
  const kit = path.join(ROOT, "dist", kitName);
  fs.rmSync(kit, { recursive: true, force: true });
  fs.mkdirSync(path.join(kit, "extension"), { recursive: true });
  execFileSync("unzip", ["-q", archive, "-d", path.join(kit, "extension")]);

  fs.writeFileSync(
    path.join(kit, "extension", "manifest.json"),
    `${JSON.stringify(safariManifest(chromeManifest), null, 2)}\n`
  );

  fs.mkdirSync(path.join(kit, "native"));
  for (const file of fs.readdirSync(path.join(ROOT, "platforms", "safari", "native"))) {
    fs.copyFileSync(path.join(ROOT, "platforms", "safari", "native", file), path.join(kit, "native", file));
  }
  fs.copyFileSync(path.join(ROOT, "platforms", "safari", "install.sh"), path.join(kit, "install.sh"));
  fs.chmodSync(path.join(kit, "install.sh"), 0o755);
  fs.copyFileSync(path.join(ROOT, "platforms", "safari", "README.md"), path.join(kit, "README.md"));

  const zip = path.join(ROOT, "dist", `${kitName}.zip`);
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-r", zip, kitName], { cwd: path.join(ROOT, "dist") });
  return zip;
}

if (require.main === module) {
  console.log(build());
}

module.exports = { safariManifest, build };
