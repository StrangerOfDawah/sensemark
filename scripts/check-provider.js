#!/usr/bin/env node
// Checks how well an OpenAI-compatible provider follows Sensemark's answer
// format before we add it to the extension. Sends the real prompts from
// src/background/prompts.js and validates every answer with the same
// responseIssue() the extension uses.
//
// This costs a few cents per run and needs your own keys; it is a manual tool,
// not part of CI. Keys come from environment variables and are never printed
// or written to the report.
//
//   YANDEX_API_KEY=... YANDEX_FOLDER_ID=... node scripts/check-provider.js yandex
//   DEEPSEEK_API_KEY=... node scripts/check-provider.js deepseek
//   OPENAI_API_KEY=... node scripts/check-provider.js openai      (baseline)
//
// Optional: MODELS=model-a,model-b to override the models, RUNS=2 to repeat.
// The report goes to dist/provider-check/<provider>.json.

const fs = require("node:fs");
const path = require("node:path");
const {
  buildTextMessages,
  buildWordMessages,
  maxOutputTokens,
  modelParams
} = require("../src/background/prompts.js");
const { responseIssue } = require("../src/background/validation.js");
const { detectSignificantScripts } = require("../src/language-detection.js");

const PROVIDERS = {
  yandex: {
    url: "https://llm.api.cloud.yandex.net/v1/chat/completions",
    env: ["YANDEX_API_KEY", "YANDEX_FOLDER_ID"],
    headers: (env) => ({
      Authorization: `Bearer ${env.YANDEX_API_KEY}`,
      "OpenAI-Project": env.YANDEX_FOLDER_ID
    }),
    models: (env) => [
      `gpt://${env.YANDEX_FOLDER_ID}/yandexgpt/latest`,
      `gpt://${env.YANDEX_FOLDER_ID}/yandexgpt-lite/latest`
    ],
    params: (model, max) => ({ temperature: 0.2, max_tokens: max })
  },
  deepseek: {
    url: "https://api.deepseek.com/chat/completions",
    env: ["DEEPSEEK_API_KEY"],
    headers: (env) => ({ Authorization: `Bearer ${env.DEEPSEEK_API_KEY}` }),
    models: () => ["deepseek-flash"],
    params: (model, max) => ({ thinking: { type: "disabled" }, temperature: 0.2, max_tokens: max })
  },
  openai: {
    url: "https://api.openai.com/v1/chat/completions",
    env: ["OPENAI_API_KEY"],
    headers: (env) => ({ Authorization: `Bearer ${env.OPENAI_API_KEY}` }),
    models: () => ["gpt-6-luna"],
    params: (model, max) => modelParams(model, max)
  }
};

// Each case mirrors a real selection: text mode for sentences and paragraphs,
// word mode for a short fragment with its sentence as context.
const CASES = [
  {
    id: "en-spring",
    text: "Spring Boot auto-configures a DataSource when it finds a JDBC driver on the classpath, so in most cases you do not need to declare the bean yourself."
  },
  {
    id: "en-ml",
    text: "A drawback of supervision is that data labeling is expensive and time-consuming. If you want two people to label each image, it costs twice as much."
  },
  {
    id: "en-code",
    text: "Call useEffect with an empty dependency array to run the effect only once after the first render."
  },
  {
    id: "en-paragraphs",
    text: "Install the CLI first.\n\nThen run the init command in an empty folder. It creates a config file and a sample test."
  },
  {
    id: "de",
    text: "Die Konfiguration wird beim Start geladen und kann zur Laufzeit nicht mehr geändert werden."
  },
  { id: "fr", text: "Le cache est vidé automatiquement lorsque le navigateur est fermé." },
  {
    id: "es",
    text: "La nueva versión mejora el rendimiento y corrige un error al importar archivos grandes."
  },
  { id: "ja", text: "この設定を有効にすると、アプリの起動が速くなります。" },
  { id: "zh", text: "如果连接超时，客户端会自动重试三次。" },
  { id: "ar", text: "يتم حفظ الإعدادات محلياً على جهازك ولا يتم إرسالها إلى أي خادم." },
  { id: "title-en-ja", text: "Japanese Daycares – 日本の保育園" },
  { id: "mixed-en-zh", text: "The service returns an error code. 服务器返回错误代码时，请检查日志。" },
  { id: "w-bank-river", word: "bank", context: "We sat on the river bank and watched the sunset." },
  {
    id: "w-bean-spring",
    word: "bean",
    context: "If you define your own bean of the same type, the auto-configured one backs off."
  },
  { id: "w-why", word: "Why", context: "Why does the build fail on the second run?" },
  {
    id: "w-kubernetes",
    word: "Kubernetes",
    context: "We deploy every service to Kubernetes with a Helm chart."
  },
  {
    id: "w-lag",
    word: "lag",
    context: "Watch consumer lag to see how far a group is behind the latest messages."
  },
  {
    id: "w-supervision",
    word: "supervision",
    context: "A drawback of supervision is that data labeling is expensive."
  },
  {
    id: "w-rule-of-thumb",
    word: "rule of thumb",
    context: "As a rule of thumb, keep functions shorter than one screen."
  },
  { id: "w-de-word", word: "Feierabend", context: "Nach dem Meeting mache ich Feierabend." }
];

async function run() {
  const name = process.argv[2];
  const provider = PROVIDERS[name];
  if (!provider) {
    console.error(`Usage: node scripts/check-provider.js <${Object.keys(PROVIDERS).join("|")}>`);
    process.exit(2);
  }
  const missing = provider.env.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(`Set ${missing.join(", ")} first.`);
    process.exit(2);
  }

  const models = process.env.MODELS
    ? process.env.MODELS.split(",").map((m) => m.trim())
    : provider.models(process.env);
  const runs = Math.max(1, Number(process.env.RUNS) || 1);
  const report = { provider: name, date: new Date().toISOString(), models: [] };

  for (const model of models) {
    const label = model.replace(/^gpt:\/\/[^/]+\//, "gpt://<folder>/");
    const results = [];
    for (let round = 0; round < runs; round++) {
      for (const item of CASES) {
        const wordMode = Boolean(item.word);
        const text = item.word || item.text;
        const scripts = detectSignificantScripts(text);
        const messages = wordMode
          ? buildWordMessages(text, item.context, "ru", scripts)
          : buildTextMessages(text, "ru", scripts);
        const body = { model, ...provider.params(model, maxOutputTokens(text, wordMode)), messages };
        const started = Date.now();
        let answer = "";
        let error = "";
        let usage = null;
        try {
          const response = await fetch(provider.url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...provider.headers(process.env) },
            body: JSON.stringify(body)
          });
          const json = await response.json().catch(() => ({}));
          if (!response.ok)
            error = `HTTP ${response.status}: ${JSON.stringify(json.error || json).slice(0, 300)}`;
          answer = json.choices?.[0]?.message?.content || "";
          usage = json.usage || null;
        } catch (failure) {
          error = String(failure.message || failure);
        }
        const issue = error ? "request failed" : responseIssue(answer, wordMode, scripts, text);
        results.push({
          id: item.id,
          round,
          ok: !issue,
          issue: issue || "",
          error,
          ms: Date.now() - started,
          usage,
          answer
        });
        process.stdout.write(issue ? "x" : ".");
      }
    }
    const ok = results.filter((r) => r.ok).length;
    const tokens = results.reduce(
      (sum, r) => ({
        in: sum.in + (r.usage?.prompt_tokens || 0),
        out: sum.out + (r.usage?.completion_tokens || 0)
      }),
      { in: 0, out: 0 }
    );
    const avgMs = Math.round(results.reduce((sum, r) => sum + r.ms, 0) / results.length);
    console.log(
      `\n${label}: ${ok}/${results.length} answers pass the format check, avg ${avgMs} ms, tokens in/out ${tokens.in}/${tokens.out}`
    );
    for (const r of results.filter((x) => !x.ok)) console.log(`  ${r.id}: ${r.error || r.issue}`);
    report.models.push({ model: label, passed: ok, total: results.length, avgMs, tokens, results });
  }

  const dir = path.join(__dirname, "..", "dist", "provider-check");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`Report: ${path.relative(process.cwd(), file)}`);
}

run();
