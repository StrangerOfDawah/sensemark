const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sensemark-reproducible-"));
const sourceArchiveItems = [
  ".github",
  "AGENTS.md",
  "BROWSER_ACCEPTANCE.md",
  "CHANGELOG.md",
  "LICENSE",
  "PRIVACY.md",
  "PRIVACY.en.md",
  "README.md",
  "README.en.md",
  "REFACTOR_NOTES.md",
  "RESEARCH_NOTES.md",
  "TECHNICAL_REVIEW_REPORT.md",
  ".nvmrc",
  "manifest.json",
  "package.json",
  "package-lock.json",
  "background",
  "content",
  "docs",
  "extension",
  "icons",
  "options",
  "popup",
  "scripts",
  "shared",
  "sidepanel",
  "store",
  "tests"
];

function copySource(destination) {
  for (const item of sourceArchiveItems) {
    const target = path.join(destination, item);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(root, item), target, { recursive: true });
  }
}

function walk(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function build(sourceDirectory, archive) {
  execFileSync("bash", ["scripts/package-extension.sh", archive], {
    cwd: sourceDirectory,
    stdio: "pipe"
  });
}

function buildSource(sourceDirectory, archive) {
  execFileSync("bash", ["scripts/package-source.sh", archive], {
    cwd: sourceDirectory,
    stdio: "pipe"
  });
}

try {
  const firstSource = path.join(temporaryRoot, "source-a");
  const secondSource = path.join(temporaryRoot, "source-b");
  fs.mkdirSync(firstSource, { recursive: true });
  fs.mkdirSync(secondSource, { recursive: true });
  copySource(firstSource);
  copySource(secondSource);

  const differentTime = new Date("2037-06-15T12:34:56Z");
  for (const file of walk(secondSource)) {
    fs.chmodSync(file, 0o600);
    fs.utimesSync(file, differentTime, differentTime);
  }

  const firstArchive = path.join(temporaryRoot, "build-a.zip");
  const secondArchive = path.join(temporaryRoot, "build-b.zip");
  build(firstSource, firstArchive);
  build(secondSource, secondArchive);

  const firstHash = sha256(firstArchive);
  const secondHash = sha256(secondArchive);
  assert.equal(secondHash, firstHash, "Production ZIP hashes differ across clean builds");
  assert.deepEqual(
    fs.readFileSync(secondArchive),
    fs.readFileSync(firstArchive),
    "Production ZIP bytes differ across clean builds"
  );

  const firstSourceArchive = path.join(temporaryRoot, "source-build-a.zip");
  const secondSourceArchive = path.join(temporaryRoot, "source-build-b.zip");
  buildSource(firstSource, firstSourceArchive);
  buildSource(secondSource, secondSourceArchive);
  const firstSourceHash = sha256(firstSourceArchive);
  const secondSourceHash = sha256(secondSourceArchive);
  assert.equal(
    secondSourceHash,
    firstSourceHash,
    "Source ZIP hashes differ across clean builds"
  );
  assert.deepEqual(
    fs.readFileSync(secondSourceArchive),
    fs.readFileSync(firstSourceArchive),
    "Source ZIP bytes differ across clean builds"
  );

  const entries = execFileSync("unzip", ["-Z1", firstArchive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const zipVersion = execFileSync("zip", ["-v"], { encoding: "utf8" })
    .split("\n")
    .find((line) => /Zip \d/.test(line))
    ?.trim();
  const result = {
    buildA: firstHash,
    buildB: secondHash,
    bytes: fs.statSync(firstArchive).size,
    entries: entries.length,
    sourceBuildA: firstSourceHash,
    sourceBuildB: secondSourceHash,
    sourceBytes: fs.statSync(firstSourceArchive).size,
    sourceEntries: execFileSync("unzip", ["-Z1", firstSourceArchive], {
      encoding: "utf8"
    })
      .split("\n")
      .filter(Boolean).length,
    packagingTool: zipVersion || "Info-ZIP",
    supportedEnvironment: "Ubuntu 24.04 GitHub Actions runner with Info-ZIP 3.0 and Node 24"
  };
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "dist", "reproducible-build.json"),
    `${JSON.stringify(result, null, 2)}\n`
  );
  console.log(`Build A SHA-256: ${result.buildA}`);
  console.log(`Build B SHA-256: ${result.buildB}`);
  console.log(`Archive byte size: ${result.bytes}`);
  console.log(`ZIP entry count: ${result.entries}`);
  console.log(`Source build A SHA-256: ${result.sourceBuildA}`);
  console.log(`Source build B SHA-256: ${result.sourceBuildB}`);
  console.log(`Source archive byte size: ${result.sourceBytes}`);
  console.log(`Source ZIP entry count: ${result.sourceEntries}`);
  console.log(`Packaging tool: ${result.packagingTool}`);
  console.log(`Supported environment: ${result.supportedEnvironment}`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
