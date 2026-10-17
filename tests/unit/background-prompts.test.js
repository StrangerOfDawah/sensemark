const assert = require("node:assert/strict");
const test = require("node:test");
const { loadBackground } = require("../helpers/background.js");

test("text prompt auto-detects the source language", () => {
  const { buildTextMessages } = loadBackground();
  const prompt = buildTextMessages("مرحبا", "русский", ["Arabic"])[0].content;

  assert.match(prompt, /Detect the language of each sentence yourself; never assume English/);
  assert.match(prompt, /Never output \[\[skip\]\]/);
  assert.match(prompt, /\[\[text\]\]/);
  assert.match(prompt, /Keep parts already in Russian verbatim/);
  assert.match(prompt, /Translate directly from the source language into Russian/);
  assert.match(prompt, /Skip leftover page UI/);
  assert.doesNotMatch(prompt, /коранич|Quran/i);
});

test("multiscript prompt requires a section for every detected script", () => {
  const { buildTextMessages } = loadBackground();
  const prompt = buildTextMessages("Hello مرحبا", "русский", ["Latin", "Arabic"])[0].content;

  assert.match(prompt, /Latin, Arabic/);
  assert.match(prompt, /\[\[multilingual\]\]/);
  assert.match(prompt, /\[\[script:SCRIPT\|lang:LANGUAGE\]\]/);
  assert.match(prompt, /Every listed script needs at least one non-empty section/);
  assert.match(prompt, /never write the result in it/);
});

test("instructions are short: English costs about half the tokens of the old Russian prompt", () => {
  const { buildTextMessages, buildWordMessages } = loadBackground();
  // The old Russian instructions took ~2300–2700 characters (430–550 tokens).
  assert.ok(buildTextMessages("Hello there my friend", "русский", ["Latin"])[0].content.length < 1300);
  assert.ok(buildWordMessages("bank", "I went to the bank.", "русский", ["Latin"])[0].content.length < 1500);
});

test("parallel bilingual titles may produce one natural translation", () => {
  const { buildTextMessages, isParallelTitleCandidate, responseIssue } = loadBackground();
  const source = "Japanese Daycares – 日本の保育園";
  const scripts = ["Latin", "Japanese"];
  const prompt = buildTextMessages(source, "русский", scripts)[0].content;

  assert.equal(isParallelTitleCandidate(source, scripts), true);
  assert.match(prompt, /one short title written in two scripts/);
  assert.match(prompt, /one Russian translation below/);
  assert.equal(responseIssue("[[text]]\nЯпонские детские сады", false, scripts, source), "");
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nЯпонские детские сады\n" +
        "[[script:Japanese|lang:японский]]\nЯпонские детские сады",
      false,
      scripts,
      source
    ),
    ""
  );
});

test("ordinary multiscript prose still requires every source section", () => {
  const { isParallelTitleCandidate, responseIssue } = loadBackground();
  const source = "Read this English sentence. ثم اقرأ هذه الجملة العربية.";
  const scripts = ["Latin", "Arabic"];

  assert.equal(isParallelTitleCandidate(source, scripts), false);
  assert.match(
    responseIssue("[[text]]\nПрочитайте эти предложения.", false, scripts, source),
    /\[\[multilingual\]\]/
  );
});

test("response validation rejects skip and missing script sections", () => {
  const { responseIssue } = loadBackground();

  assert.match(responseIssue("[[skip]]", true, ["Arabic"]), /forbidden \[\[skip\]\]/);
  assert.match(
    responseIssue("[[multilingual]]\n[[script:Latin|lang:английский]]\nПеревод.", false, ["Latin", "Arabic"]),
    /Arabic/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nПеревод.\n" +
        "[[script:Arabic|lang:арабский]]\n",
      false,
      ["Latin", "Arabic"]
    ),
    /Arabic/
  );
  assert.equal(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nПеревод.\n" +
        "[[script:Arabic|lang:арабский]]\nДругой перевод.",
      false,
      ["Latin", "Arabic"]
    ),
    ""
  );
});

test("response validation rejects copied instructions, labels and untranslated output", () => {
  const { responseIssue } = loadBackground();
  const arabic = "هذا كتاب جيد جدا";

  assert.match(
    responseIssue(
      "[[text]]\nполный перевод на язык «русский» без пояснений и исходного текста",
      false,
      ["Arabic"],
      arabic
    ),
    /repeats the instructions/
  );
  assert.match(
    responseIssue("[[text]]\nمرحبا بكم في المدينة", false, ["Latin"], "Welcome to the city."),
    /source script/
  );
  assert.match(
    responseIssue(
      "[[multilingual]]\n" +
        "[[script:Latin|lang:английский]]\nДобро пожаловать.\n" +
        "[[script:Arabic|lang:арабский]]\nمرحبا بكم في المدينة.",
      false,
      ["Latin"],
      "Welcome to the city."
    ),
    /scripts that are not in the selection: Arabic/
  );
  assert.match(
    responseIssue("[[text]]\nПеревод:\nБольшое спасибо.", false, ["Arabic"], "شكرا جزيلا"),
    /«Перевод:»/
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
    responseIssue("[[multilingual]]\n[[script:Arabic|lang:арабский]]\nЭто книга.", false, ["Arabic"], arabic),
    /one language/
  );
  assert.equal(responseIssue("[[text]]\nЭто очень хорошая книга.", false, ["Arabic"], arabic), "");
});

test("validation accepts kept names, brands and short terms (no wasted repair request)", () => {
  const { responseIssue } = loadBackground();
  // Each of these correct answers used to trigger a paid retry.
  assert.equal(
    responseIssue(
      "[[text]]\nGitHub Copilot. ИИ-напарник, который помогает писать код.",
      false,
      ["Latin"],
      "GitHub Copilot. The AI pair programmer that helps you write code."
    ),
    ""
  );
  assert.equal(responseIssue("[[translation]]\nOK", true, ["Latin"], "OK"), "");
  assert.equal(responseIssue("[[text]]\nGitHub Copilot", false, ["Latin"], "GitHub Copilot"), "");
  assert.equal(
    responseIssue(
      "[[text]]\nОфис в 東京 открылся сегодня, и сотрудники довольны.",
      false,
      ["Latin"],
      "The 東京 office opened today."
    ),
    ""
  );
});

test("repair request replaces an invalid skip response", async () => {
  const background = loadBackground();
  background.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "[[translation]]\nкнига" } }]
    })
  });

  const repaired = await background.repairResponse(
    { apiKey: "test-key", model: "gpt-6-luna" },
    [{ role: "system", content: "Переведи." }],
    "[[skip]]",
    "Запрещённая метка.",
    true,
    ["Arabic"],
    "كتاب",
    new AbortController().signal
  );

  assert.equal(repaired, "[[translation]]\nкнига");
});

test("word prompt defines a safe unknown-term response", () => {
  const { buildWordMessages } = loadBackground();
  const messages = buildWordMessages("Sensemark", null, "русский", ["Latin"]);
  const prompt = messages[0].content;

  assert.match(prompt, /“Why” is the word «почему»/);
  assert.match(prompt, /\[\[translation\]\]/);
  assert.match(prompt, /\[\[reference\]\]/);
  assert.match(prompt, /A capital letter alone does not make a name/);
  assert.match(prompt, /do not invent facts/);
  assert.match(prompt, /Script: Latin/);
  assert.equal(messages[1].content, "Fragment: Sensemark");
  assert.equal(
    buildWordMessages("bank", "I went to the bank.", "русский", ["Latin"])[1].content,
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
  const { modelParams } = loadBackground();
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
  const { maxOutputTokens } = loadBackground();
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
