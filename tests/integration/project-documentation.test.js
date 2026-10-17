const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const adrDir = path.join(root, "docs", "adr");
const adrFiles = fs
  .readdirSync(adrDir)
  .filter((name) => /^\d{4}-[a-z0-9-]+\.md$/.test(name))
  .sort();
const requiredDocs = [
  "AGENTS.md",
  "CLAUDE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "PRIVACY.md",
  "docs/architecture.md",
  "docs/adr/README.md",
  "docs/product-direction.md",
  "docs/releasing.md",
  "platforms/safari/README.md",
  "store/chrome-web-store.md",
  ".github/pull_request_template.md",
  ".github/copilot-instructions.md"
];
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("canonical project guidance exists and is discoverable", () => {
  for (const file of requiredDocs) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `Missing ${file}`);
  }

  const agents = read("AGENTS.md");
  for (const file of [
    "docs/architecture.md",
    "docs/adr/",
    "docs/product-direction.md",
    "docs/releasing.md",
    "CHANGELOG.md"
  ]) {
    assert.match(agents, new RegExp(escape(file)));
  }

  // Claude Code reads CLAUDE.md; it must import the shared agent guidance.
  assert.match(read("CLAUDE.md"), /^@AGENTS\.md$/m);
  assert.match(read(".github/copilot-instructions.md"), /\(\.\.\/AGENTS\.md\)/);

  for (const readme of ["README.md", "README.en.md"]) {
    assert.match(read(readme), /\(AGENTS\.md\)/);
    assert.match(read(readme), /\(CHANGELOG\.md\)/);
    assert.match(read(readme), /\(docs\/architecture\.md\)/);
  }
});

test("every decision record is listed in the ADR index and follows the template", () => {
  assert.ok(adrFiles.length >= 18, "ADR files are missing");
  const index = read("docs/adr/README.md");
  adrFiles.forEach((name, position) => {
    assert.equal(
      name.slice(0, 4),
      String(position + 1).padStart(4, "0"),
      `ADR numbering has a gap at ${name}`
    );
    assert.match(index, new RegExp(`\\(${escape(name)}\\)`), `${name} is not in docs/adr/README.md`);
    const record = read(`docs/adr/${name}`);
    for (const heading of ["## Context", "## Decision", "## Consequences"]) {
      assert.match(record, new RegExp(`^${heading}$`, "m"), `${name} has no "${heading}"`);
    }
    assert.match(record, /^- Status: /m, `${name} has no status`);
  });
});

test("agent policy requires regression tests and documentation updates", () => {
  const agents = read("AGENTS.md");
  const template = read(".github/pull_request_template.md");

  assert.match(agents, /Every new feature and every bug fix \*\*must\*\*/);
  assert.match(agents, /regression test/);
  assert.match(agents, /update them in the same commit\/PR/);
  assert.match(agents, /npm run verify/);
  assert.match(agents, /height: 100%/);
  assert.match(agents, /One user translation means one API request/);
  assert.match(agents, /npm run design:approve/);

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
  const markdownFiles = [
    ...requiredDocs,
    "README.md",
    "README.en.md",
    ...adrFiles.map((name) => `docs/adr/${name}`)
  ];

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
