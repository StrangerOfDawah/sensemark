// Everything in the repository is in English except a short list of files
// that exist to hold Russian text. See "Language" in AGENTS.md.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..", "..");
const ALLOWED = new Set([
  "README.md",
  "src/_locales/ru/messages.json",
  "tests/fixtures/russian.json",
  "store/listing.ru.txt"
]);
const TEXT_FILE = /\.(?:js|json|html|css|md|txt|yml|yaml|sh|swift)$/;
const DOTFILES = new Set([
  "LICENSE",
  ".editorconfig",
  ".gitignore",
  ".nvmrc",
  ".prettierignore",
  ".prettierrc.json"
]);
const CYRILLIC = /\p{Script=Cyrillic}/u;

function repositoryFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8"
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(root, file)));
}

test("Russian text lives only in the files meant for it", () => {
  const files = repositoryFiles().filter((file) => TEXT_FILE.test(file) || DOTFILES.has(path.basename(file)));
  assert.ok(files.length > 50, "the repository file list is available");
  const offenders = [];
  for (const file of files) {
    if (ALLOWED.has(file)) continue;
    fs.readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .forEach((line, index) => {
        if (CYRILLIC.test(line)) offenders.push(`${file}:${index + 1}`);
      });
  }
  assert.deepEqual(
    offenders,
    [],
    "Move these strings to src/_locales/ru/messages.json or tests/fixtures/russian.json, or translate them."
  );
});

test("every message key used in the extension exists, and every message is used", () => {
  const messages = JSON.parse(fs.readFileSync(path.join(root, "src/_locales/ru/messages.json"), "utf8"));
  const sources = repositoryFiles()
    .filter(
      (file) => file.startsWith("src/") && /\.(?:js|html|json)$/.test(file) && !file.includes("_locales")
    )
    .map((file) => fs.readFileSync(path.join(root, file), "utf8"))
    .join("\n");
  const used = new Set();
  for (const pattern of [
    /\bt\(\s*"([A-Za-z0-9_]+)"/g,
    /<!--t:([A-Za-z0-9_]+)-->/g,
    /data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g,
    /__MSG_([A-Za-z0-9_]+)__/g,
    /\bprefix\(\s*"([A-Za-z0-9_]+)"/g
  ]) {
    for (const match of sources.matchAll(pattern)) used.add(match[1]);
  }
  // Plural forms are picked by Intl.PluralRules from this table.
  for (const table of sources.matchAll(/PARAGRAPH_FORMS = \{([^}]+)\}/g)) {
    for (const key of table[1].matchAll(/"([A-Za-z0-9_]+)"/g)) used.add(key[1]);
  }
  const missing = [...used].filter((key) => !messages[key]);
  const unused = Object.keys(messages).filter((key) => !used.has(key));
  assert.deepEqual(missing, [], "keys used in code but missing from messages.json");
  assert.deepEqual(unused, [], "messages that nothing uses");
});
