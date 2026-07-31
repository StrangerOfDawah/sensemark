const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const version = require(path.join(root, "package.json")).version;
const dist = path.join(root, "dist");
const sourceName = `sensemark-v${version}-source.zip`;
const productionName = `sensemark-v${version}.zip`;
const checksumName = `sensemark-v${version}-SHA256SUMS.txt`;

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

for (const name of [sourceName, productionName]) {
  if (!fs.existsSync(path.join(dist, name))) {
    throw new Error(`Cannot write checksums before the final artifact exists: ${name}`);
  }
}
const content = [
  `${sha256(path.join(dist, sourceName))}  ${sourceName}`,
  `${sha256(path.join(dist, productionName))}  ${productionName}`,
  ""
].join("\n");
const output = path.join(dist, checksumName);
fs.writeFileSync(output, content);
process.stdout.write(content);
