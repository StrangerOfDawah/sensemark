#!/usr/bin/env node
// Собирает «набор для Safari»: dist/sensemark-safari-vX.Y.Z.zip.
//
// Внутри:
//   extension/  — то же расширение, что для Chrome, но с манифестом для Safari;
//   native/     — Swift-файлы приложения Sensemark (переводчик Apple, окно языков);
//   install.sh  — на Mac создаёт Xcode-проект и подставляет эти файлы;
//   README.md   — пошаговая инструкция.
//
// Chrome-сборка не меняется: разрешение nativeMessaging добавляется только
// в Safari-манифест.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

// Манифест Chrome → манифест Safari.
function safariManifest(chromeManifest) {
  const manifest = JSON.parse(JSON.stringify(chromeManifest));
  // Мост к приложению Sensemark (переводчик Apple, определение языка).
  manifest.permissions = [...new Set([...(manifest.permissions || []), "nativeMessaging"])];
  // Ключ только для Chrome; Safari его не знает.
  delete manifest.minimum_chrome_version;
  return manifest;
}

function build() {
  const chromeManifest = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "manifest.json"), "utf8"));
  const version = chromeManifest.version;
  const archive = path.join(ROOT, "dist", `sensemark-v${version}.zip`);
  if (!fs.existsSync(archive)) {
    throw new Error(`Сначала соберите расширение: bash scripts/package-extension.sh (нет ${archive})`);
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
