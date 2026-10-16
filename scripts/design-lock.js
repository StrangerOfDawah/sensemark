// Замок дизайна: хранит отпечатки (SHA-256) файлов, отвечающих за внешний вид.
// Проверка: tests/design-lock.test.js. Принять намеренное изменение:
//   npm run design:approve
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const lockFile = path.join(root, "tests", "design-lock.json");

// Каждый элемент — отдельная часть дизайна. Для content.js берём только
// CSS карточки, чтобы правки логики перевода не задевали замок.
const PARTS = {
  "popup.css": (read) => read("popup.css"),
  "popup.html": (read) => read("popup.html"),
  "options.html": (read) => read("options.html"),
  // Все блоки <style> из content.js: карточка и пилюля статуса.
  "content.js (CSS карточки)": (read) => {
    const source = read("content.js");
    const blocks = [...source.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((match) => match[1]);
    if (!blocks.length) throw new Error("В content.js не найден блок <style> карточки.");
    return blocks.join("\n/* --- */\n");
  }
};

function read(file) {
  // Убираем различие переносов строк Windows/Unix, чтобы не было ложных срабатываний.
  return fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n");
}

function currentHashes() {
  const hashes = {};
  for (const [name, extract] of Object.entries(PARTS)) {
    hashes[name] = crypto.createHash("sha256").update(extract(read)).digest("hex");
  }
  return hashes;
}

function lockedHashes() {
  return JSON.parse(fs.readFileSync(lockFile, "utf8"));
}

function changedParts() {
  const locked = lockedHashes();
  const current = currentHashes();
  return Object.keys(current).filter((name) => locked[name] !== current[name]);
}

if (require.main === module) {
  if (!process.argv.includes("--approve")) {
    const changed = changedParts();
    console.log(changed.length ? `Изменено: ${changed.join(", ")}` : "Дизайн не менялся.");
    process.exit(0);
  }
  const before = fs.existsSync(lockFile) ? changedParts() : Object.keys(PARTS);
  fs.writeFileSync(lockFile, `${JSON.stringify(currentHashes(), null, 2)}\n`);
  console.log(
    before.length
      ? `Новая версия дизайна принята: ${before.join(", ")}`
      : "Дизайн не менялся — принимать нечего."
  );
}

module.exports = { currentHashes, lockedHashes, changedParts, PARTS };
