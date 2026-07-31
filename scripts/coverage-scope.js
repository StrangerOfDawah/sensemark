const fs = require("node:fs");
const path = require("node:path");
const {
  INCLUDED_FIRST_PARTY_FILES,
  RUNTIME_DIRECTORIES,
  THRESHOLDS
} = require("./coverage-config.js");

const root = path.resolve(__dirname, "..");

function walk(relativeDirectory) {
  const output = [];
  for (const entry of fs.readdirSync(path.join(root, relativeDirectory), {
    withFileTypes: true
  })) {
    const relative = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) output.push(...walk(relative));
    else if (entry.name.endsWith(".js")) output.push(relative);
  }
  return output;
}

function physicalLines(file) {
  const value = fs.readFileSync(path.join(root, file), "utf8");
  return value.endsWith("\n") ? value.split("\n").length - 1 : value.split("\n").length;
}

function exclusionReason(file) {
  if (
    [
      "background/service-worker.js",
      "content/index.js",
      "popup/popup.js",
      "options/options.js",
      "sidepanel/sidepanel.js"
    ].includes(file)
  ) {
    return "browser composition root; covered by static, integration, and browser smoke tests";
  }
  return "supporting runtime module outside the explicitly measured critical-module set";
}

function coverageScope() {
  const runtimeFiles = RUNTIME_DIRECTORIES.flatMap(walk).sort();
  const included = [...INCLUDED_FIRST_PARTY_FILES];
  const includedSet = new Set(included);
  const excluded = runtimeFiles
    .filter((file) => !includedSet.has(file))
    .map((file) => ({ file, reason: exclusionReason(file) }));
  const totalRuntimeLines = runtimeFiles.reduce((sum, file) => sum + physicalLines(file), 0);
  const includedRuntimeLines = included.reduce((sum, file) => sum + physicalLines(file), 0);
  return {
    label: "Targeted core-module coverage",
    included,
    excluded,
    totalRuntimeFiles: runtimeFiles.length,
    totalRuntimeLines,
    includedRuntimeLines,
    scopePercentage: Number(((includedRuntimeLines / totalRuntimeLines) * 100).toFixed(2)),
    thresholds: THRESHOLDS,
    lineCountingMethod: "physical JavaScript source lines, including comments and blanks"
  };
}

function printCoverageScope(scope = coverageScope()) {
  console.log(scope.label);
  console.log(`Included first-party files (${scope.included.length}):`);
  for (const file of scope.included) console.log(`  ${file}`);
  console.log(`Excluded first-party files (${scope.excluded.length}):`);
  for (const item of scope.excluded) console.log(`  ${item.file} — ${item.reason}`);
  console.log(`Included runtime lines: ${scope.includedRuntimeLines}`);
  console.log(`Total runtime lines: ${scope.totalRuntimeLines}`);
  console.log(`Coverage-scope percentage: ${scope.scopePercentage}%`);
  console.log(`Line counting: ${scope.lineCountingMethod}`);
}

if (require.main === module) {
  const scope = coverageScope();
  if (process.argv.includes("--json")) console.log(JSON.stringify(scope, null, 2));
  else printCoverageScope(scope);
}

module.exports = { coverageScope, printCoverageScope };
