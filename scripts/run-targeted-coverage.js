const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const {
  INCLUDED_FIRST_PARTY_FILES,
  THRESHOLDS
} = require("./coverage-config.js");
const { printCoverageScope } = require("./coverage-scope.js");

const root = path.resolve(__dirname, "..");
const tests = fs
  .readdirSync(path.join(root, "tests"))
  .filter((file) => file.endsWith(".test.js"))
  .sort()
  .map((file) => path.join("tests", file));
const arguments = [
  "--experimental-test-coverage",
  `--test-coverage-lines=${THRESHOLDS.lines}`,
  `--test-coverage-functions=${THRESHOLDS.functions}`,
  `--test-coverage-branches=${THRESHOLDS.branches}`,
  ...INCLUDED_FIRST_PARTY_FILES.map((file) => `--test-coverage-include=${file}`),
  "--test",
  ...tests
];

printCoverageScope();
const result = spawnSync(process.execPath, arguments, { cwd: root, stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
