const assert = require("node:assert/strict");
const test = require("node:test");
const { loadBackground } = require("../helpers/background.js");
const Prompts = require("../../src/background/prompts.js");
const Validation = require("../../src/background/validation.js");
const pure = () => ({ ...Prompts, ...Validation });
const RU = require("../fixtures/russian.json");

test("text prompt auto-detects the source language", () => {
  const { buildTextMessages } = pure();
  const prompt = buildTextMessages("مرحبا", RU.langRussian, ["Arabic"])[0].content;

  assert.match(prompt, /Detect the language of each sentence yourself; never assume English/);
  assert.match(prompt, /Never output \[\[skip\]\]/);
  assert.match(prompt, /\[\[text\]\]/);
  assert.match(prompt, /Keep parts already in Russian verbatim/);
  assert.match(prompt, /Translate directly from the source language into Russian/);
  assert.match(prompt, /Skip leftover page UI/);
  assert.doesNotMatch(prompt, new RegExp(`${RU.removedTopicStem}|Quran`, "i"));
});

test("multiscript prompt requires a section for every detected script", () => {
  const { buildTextMessages } = pure();
  const prompt = buildTextMessages("Hello مرحبا", RU.langRussian, ["Latin", "Arabic"])[0].content;

  assert.match(prompt, /Latin, Arabic/);
  assert.match(prompt, /\[\[multilingual\]\]/);
  assert.match(prompt, /\[\[script:SCRIPT\|lang:LANGUAGE\]\]/);
  assert.match(prompt, /Every listed script needs at least one non-empty section/);
  assert.match(prompt, /never write the result in it/);
});

test("instructions are short: English costs about half the tokens of the old Russian prompt", () => {
  const { buildTextMessages, buildWordMessages } = pure();
  // The old Russian instructions took ~2300–2700 characters (430–550 tokens).
  assert.ok(buildTextMessages("Hello there my friend", RU.langRussian, ["Latin"])[0].content.length < 1300);
  assert.ok(
    buildWordMessages("bank", "I went to the bank.", RU.langRussian, ["Latin"])[0].content.length < 1500
  );
});

test("parallel bilingual titles may produce one natural translation", () => {
  const { buildTextMessages, isParallelTitleCandidate, responseIssue } = pure();
  const source = "Japanese Daycares – 日本の保育園";
  const scripts = ["Latin", "Japanese"];
  const prompt = buildTextMessages(source, RU.langRussian, scripts)[0].content;

  assert.equal(isParallelTitleCandidate(source, scripts), true);
  assert.match(prompt, /one short title written in two scripts/);
  assert.match(prompt, /one Russian translation below/);
  assert.equal(responseIssue(`[[text]]\n${RU.japaneseDaycares}`, false, scripts, source), "");
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.japaneseDaycares}\n` +
        `[[script:Japanese|lang:${RU.langJapanese}]]\n${RU.japaneseDaycares}`,
      false,
      scripts,
      source
    ),
    ""
  );
});

test("ordinary multiscript prose still requires every source section", () => {
  const { isParallelTitleCandidate, responseIssue } = pure();
  const source = "Read this English sentence. ثم اقرأ هذه الجملة العربية.";
  const scripts = ["Latin", "Arabic"];

  assert.equal(isParallelTitleCandidate(source, scripts), false);
  assert.match(
    responseIssue(`[[text]]\n${RU.readSentences}`, false, scripts, source),
    /\[\[multilingual\]\]/
  );
});

test("response validation rejects skip and missing script sections", () => {
  const { responseIssue } = pure();

  assert.match(responseIssue("[[skip]]", true, ["Arabic"]), /forbidden \[\[skip\]\]/);
  assert.match(
    responseIssue(`[[multilingual]]\n[[script:Latin|lang:${RU.langEnglish}]]\n${RU.translationWord}`, false, [
      "Latin",
      "Arabic"
    ]),
    /Arabic/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.translationWord}\n` +
        `[[script:Arabic|lang:${RU.langArabic}]]\n`,
      false,
      ["Latin", "Arabic"]
    ),
    /Arabic/
  );
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.translationWord}\n` +
        `[[script:Arabic|lang:${RU.langArabic}]]\n${RU.anotherTranslation}`,
      false,
      ["Latin", "Arabic"]
    ),
    ""
  );
});

test("response validation rejects copied instructions, labels and untranslated output", () => {
  const { responseIssue } = pure();
  const arabic = "هذا كتاب جيد جدا";

  assert.match(
    responseIssue(`[[text]]\n${RU.copiedInstruction}`, false, ["Arabic"], arabic),
    /repeats the instructions/
  );
  assert.match(
    responseIssue("[[text]]\nمرحبا بكم في المدينة", false, ["Latin"], "Welcome to the city."),
    /source script/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.welcome}\n` +
        `[[script:Arabic|lang:${RU.langArabic}]]\nمرحبا بكم في المدينة.`,
      false,
      ["Latin"],
      "Welcome to the city."
    ),
    /scripts that are not in the selection: Arabic/
  );
  assert.match(
    responseIssue(`[[text]]\n${RU.translationLabelLine}\n${RU.thanks}`, false, ["Arabic"], "شكرا جزيلا"),
    /translation label/
  );
  assert.match(
    responseIssue(
      "[[text]]\nThe report is ready for review today.",
      false,
      ["Latin"],
      "The report is ready for review today."
    ),
    /not translated into Russian/
  );
  assert.match(
    responseIssue(
      `[[multilingual]]\n[[script:Arabic|lang:${RU.langArabic}]]\n${RU.isBook}`,
      false,
      ["Arabic"],
      arabic
    ),
    /one language/
  );
  assert.equal(responseIssue(`[[text]]\n${RU.goodBook}`, false, ["Arabic"], arabic), "");
});

test("validation accepts kept names, brands and short terms (no wasted repair request)", () => {
  const { responseIssue } = pure();
  // Each of these correct answers used to trigger a paid retry.
  assert.equal(
    responseIssue(
      `[[text]]\n${RU.copilot}`,
      false,
      ["Latin"],
      "GitHub Copilot. The AI pair programmer that helps you write code."
    ),
    ""
  );
  assert.equal(responseIssue("[[translation]]\nOK", true, ["Latin"], "OK"), "");
  assert.equal(responseIssue("[[text]]\nGitHub Copilot", false, ["Latin"], "GitHub Copilot"), "");
  assert.equal(
    responseIssue(`[[text]]\n${RU.tokyoOffice}`, false, ["Latin"], "The 東京 office opened today."),
    ""
  );
});

test("repair request replaces an invalid skip response", async () => {
  const background = loadBackground();
  background.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: `[[translation]]\n${RU.book}` } }]
    })
  });

  const repaired = await background.repairResponse(
    { apiKey: "test-key", model: "gpt-6-luna" },
    [{ role: "system", content: RU.translateIt }],
    "[[skip]]",
    RU.forbiddenLabel,
    true,
    ["Arabic"],
    "كتاب",
    new AbortController().signal
  );

  assert.equal(repaired, `[[translation]]\n${RU.book}`);
});

test("word prompt defines a safe unknown-term response", () => {
  const { buildWordMessages } = pure();
  const messages = buildWordMessages("Sensemark", null, RU.langRussian, ["Latin"]);
  const prompt = messages[0].content;

  assert.match(prompt, new RegExp(`“Why” is the word «${RU.why}»`));
  assert.match(prompt, /\[\[translation\]\]/);
  assert.match(prompt, /\[\[reference\]\]/);
  assert.match(prompt, /A capital letter alone does not make a name/);
  assert.match(prompt, /do not invent facts/);
  assert.match(prompt, /Script: Latin/);
  assert.equal(messages[1].content, "Fragment: Sensemark");
  assert.equal(
    buildWordMessages("bank", "I went to the bank.", RU.langRussian, ["Latin"])[1].content,
    "Context: I went to the bank.\nFragment: bank"
  );
});

test("word mode is explicit even when sentence context is unavailable", async () => {
  const { prepareRequest } = loadBackground();
  const wordRequest = await prepareRequest("Sensemark", null, true);
  const textRequest = await prepareRequest("Sensemark", null, false);

  assert.match(wordRequest.cacheKey, /\|word\|/);
  assert.match(wordRequest.messages[0].content, /\[\[reference\]\]/);
  assert.match(textRequest.cacheKey, /\|text\|/);
  assert.doesNotMatch(textRequest.messages[0].content, /\[\[reference\]\]/);
});

test("new reasoning models get reasoning_effort none and no temperature", () => {
  const { modelParams } = pure();
  assert.deepEqual(JSON.parse(JSON.stringify(modelParams("gpt-6-luna", 300))), {
    reasoning_effort: "none",
    max_completion_tokens: 300
  });
  assert.equal(modelParams("gpt-5-nano", 300).reasoning_effort, "minimal");
  assert.deepEqual(JSON.parse(JSON.stringify(modelParams("gpt-4o-mini", 300))), {
    temperature: 0.2,
    max_tokens: 300
  });
});

test("output is capped by the length of the selection", () => {
  const { maxOutputTokens } = pure();
  assert.equal(maxOutputTokens("bank", true), 300);
  assert.equal(maxOutputTokens("x".repeat(100), false), 380);
  assert.equal(maxOutputTokens("x".repeat(5000), false), 4096);
});

test("retired models are switched to the current cheapest model", async () => {
  const { prepareRequest } = loadBackground({ settings: { model: "gpt-4o-mini" } });
  const request = await prepareRequest("Hello there, my friend.", null, false, ["Latin"]);
  assert.equal(request.settings.model, "gpt-6-luna");
  assert.match(request.cacheKey, /^gpt-6-luna\|/);
});
