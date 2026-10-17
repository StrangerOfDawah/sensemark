const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const requiredDocs = [
  "AGENTS.md",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/DECISIONS.md",
  "docs/PRODUCT_DIRECTION.md",
  "docs/RELEASING.md",
  ".github/pull_request_template.md"
];

test("canonical project guidance exists and is discoverable", () => {
  for (const file of requiredDocs) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `Missing ${file}`);
  }

  const agents = read("AGENTS.md");
  for (const file of [
    "docs/ARCHITECTURE.md",
    "docs/DECISIONS.md",
    "docs/PRODUCT_DIRECTION.md",
    "docs/RELEASING.md",
    "CHANGELOG.md"
  ]) {
    assert.match(agents, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  for (const readme of ["README.md", "README.en.md"]) {
    assert.match(read(readme), /\(AGENTS\.md\)/);
    assert.match(read(readme), /\(CHANGELOG\.md\)/);
  }
});

test("agent policy requires regression tests and documentation updates", () => {
  const agents = read("AGENTS.md");
  const template = read(".github/pull_request_template.md");

  assert.match(agents, /Каждая новая функция и каждое исправление бага \*\*обязаны\*\*/);
  assert.match(agents, /регрессионный тест/);
  assert.match(agents, /актуализируйте их в том же commit\/PR/);
  assert.match(agents, /npm run test:coverage/);
  assert.match(agents, /height: 100%/);
  assert.match(agents, /один API-запрос/);

  assert.match(template, /New behaviour has an automated test/);
  assert.match(template, /every fixed bug has a regression test/);
  assert.match(template, /Affected docs are updated/);
  assert.match(template, /npm run design:status/);
});

test("changelog contains the package version and documented release history", () => {
  const manifest = JSON.parse(read("src/manifest.json"));
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const changelog = read("CHANGELOG.md");

  assert.equal(packageJson.version, manifest.version);
  assert.equal(packageLock.version, manifest.version);
  assert.equal(packageLock.packages[""].version, manifest.version);
  assert.match(changelog, new RegExp(`^## \\[${manifest.version.replaceAll(".", "\\.")}\\]`, "m"));
  assert.match(changelog, /^## \[1\.2\.0\]/m);
  assert.match(changelog, /^## \[1\.1\.0\]/m);
});

test("local Markdown links in project guidance resolve to existing files", () => {
  const markdownFiles = [...requiredDocs, "README.md", "README.en.md"];

  for (const file of markdownFiles) {
    const source = read(file);
    const links = [...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1].trim());

    for (const link of links) {
      if (/^(?:https?:|mailto:|#)/i.test(link)) continue;
      const target = decodeURIComponent(link.split("#", 1)[0]);
      if (!target) continue;
      const resolved = path.resolve(root, path.dirname(file), target);
      assert.equal(fs.existsSync(resolved), true, `${file} references missing local file: ${link}`);
    }
  }
});
