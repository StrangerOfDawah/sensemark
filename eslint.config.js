// ESLint flat config. Extension code runs as classic scripts in the browser;
// tooling and tests are CommonJS on Node.
const js = require("@eslint/js");
const globals = require("globals");

module.exports = [
  { ignores: ["dist/", "node_modules/", "store/"] },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.webextensions,
        // UMD wrappers check `typeof module` so the same file runs in Node tests.
        module: "readonly",
        require: "readonly"
      }
    }
  },
  {
    files: ["scripts/**/*.js", "tests/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      // Tests also run callbacks inside the page and the service worker.
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions }
    }
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }]
    }
  }
];
