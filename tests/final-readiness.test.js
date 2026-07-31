const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../shared/config.js");
const openai = require("../background/providers/openai-provider.js");
const {
  INCLUDED_FIRST_PARTY_FILES,
  THRESHOLDS
} = require("../scripts/coverage-config.js");
const { coverageScope } = require("../scripts/coverage-scope.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("readiness: workflow uses only current v1.4.2 paths and commands", () => {
  const workflow = read(".github/workflows/pr-build.yml");
  assert.doesNotMatch(workflow, /dist\/unpacked\/popup\.(?:html|css|js)/);
  assert.doesNotMatch(workflow, /manual-translation\.js/);
  for (const command of [
    "npm ci",
    "npm test",
    "npm run check",
    "npm run test:coverage",
    "npm run test:browser:auto",
    "npm run package:extension",
    "npm run verify:reproducible",
    "node scripts/validate-extension.js dist/sensemark-v1.4.2.zip"
  ]) {
    assert.match(workflow, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const file of [
    "background/service-worker.js",
    "popup/popup.html",
    "options/options.html",
    "sidepanel/sidepanel.html"
  ]) {
    assert.match(workflow, new RegExp(file.replaceAll("/", "\\/")));
  }
  assert.match(workflow, /sensemark-v1\.4\.2-production/);
  assert.match(workflow, /dist\/coverage-output\.txt/);
});

test("readiness: package, manifest, Node, and store metadata identify v1.4.2", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(packageJson.version, "1.4.2");
  assert.equal(packageLock.version, "1.4.2");
  assert.equal(packageLock.packages[""].version, "1.4.2");
  assert.equal(manifest.version, "1.4.2");
  assert.equal(manifest.minimum_chrome_version, "119");
  assert.equal(packageJson.engines.node, "24.x");
  assert.equal(read(".nvmrc").trim(), "24");
  assert.match(read("store/CHROME_WEB_STORE.md"), /1\.4\.2/);
});

test("readiness: multilingual prompt names only fields in its strict schema", () => {
  const request = {
    mode: config.TRANSLATION_MODE.MULTILINGUAL,
    text: "Hello مرحبا"
  };
  const prompt = openai.systemPrompt(request);
  const schema = openai.structuredSchema(config.TRANSLATION_MODE.MULTILINGUAL);
  assert.equal(schema.additionalProperties, false);
  assert.doesNotMatch(
    prompt,
    /alternatives|explanation|category|brand|username|typo|unknown[_ ]term|name, title/i
  );
  const namedFields = ["kind", "text", "sections", "script", "source", "translation"];
  const schemaFields = new Set([
    ...Object.keys(schema.properties),
    ...Object.keys(schema.properties.sections.items.properties)
  ]);
  for (const field of namedFields) {
    assert.match(prompt, new RegExp(`\\b${field}\\b`, "i"));
    assert.ok(schemaFields.has(field), `${field} missing from multilingual schema`);
  }
  assert.deepEqual(schema.required, ["kind", "text", "sections"]);
});

test("readiness: coverage command discloses its exact targeted critical scope", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["test:coverage"], "node scripts/run-targeted-coverage.js");
  assert.deepEqual(THRESHOLDS, { lines: 80, functions: 85, branches: 70 });
  assert.equal(INCLUDED_FIRST_PARTY_FILES.length, 14);
  const scope = coverageScope();
  assert.equal(scope.label, "Targeted core-module coverage");
  assert.deepEqual(scope.included, [...INCLUDED_FIRST_PARTY_FILES]);
  assert.ok(scope.includedRuntimeLines > 0);
  assert.ok(scope.totalRuntimeLines > scope.includedRuntimeLines);
  assert.ok(scope.scopePercentage > 0 && scope.scopePercentage < 100);
  assert.ok(scope.excluded.every((item) => item.reason));
});

test("readiness: production packaging is byte-for-byte deterministic", () => {
  const output = execFileSync(process.execPath, ["scripts/verify-reproducible-build.js"], {
    cwd: root,
    encoding: "utf8"
  });
  const first = output.match(/Build A SHA-256: ([a-f0-9]{64})/)?.[1];
  const second = output.match(/Build B SHA-256: ([a-f0-9]{64})/)?.[1];
  assert.ok(first);
  assert.equal(second, first);
});

test("readiness: source and production packaging enforce clean boundaries", () => {
  const sourcePackage = read("scripts/package-source.sh");
  const sourceValidator = read("scripts/validate-source.js");
  const productionPackage = read("scripts/package-extension.sh");
  const productionValidator = read("scripts/validate-extension.js");
  assert.doesNotMatch(sourcePackage, /node_modules|(?:^|\s)dist(?:\s|\\|$)/m);
  assert.match(sourceValidator, /node_modules\//);
  assert.match(sourceValidator, /coverage\//);
  assert.match(sourceValidator, /dist\//);
  assert.doesNotMatch(productionPackage, /(?:^|\s)tests(?:\s|\\|$)/m);
  assert.doesNotMatch(productionPackage, /(?:^|\s)scripts(?:\s|\\|$)/m);
  assert.match(productionValidator, /"tests\/"/);
  assert.match(productionValidator, /"scripts\/"/);
  assert.match(productionValidator, /"package\.json"/);
});

test("readiness: checksum verifier covers both final archives", () => {
  const writer = read("scripts/write-artifact-checksums.js");
  const verifier = read("scripts/verify-artifacts.js");
  assert.match(writer, /sourceName/);
  assert.match(writer, /productionName/);
  assert.match(writer, /SHA256SUMS/);
  assert.match(verifier, /Checksum mismatch/);
  assert.match(verifier, /archivedPackage\.version/);
  assert.match(verifier, /archivedManifest\.version/);
});

test("readiness: browser acceptance and store publication gate are explicit", () => {
  const acceptance = read("BROWSER_ACCEPTANCE.md");
  assert.match(acceptance, /BLOCKED/);
  assert.match(acceptance, /built-in PDF/i);
  assert.match(acceptance, /User-activation timing/);
  assert.match(acceptance, /Not tested/);
  assert.match(acceptance, /must not be described as store-ready/i);
  const packageJson = JSON.parse(read("package.json"));
  assert.equal(packageJson.scripts["test:browser:auto"], "node tests/browser/run-extension-tests.js");
});
