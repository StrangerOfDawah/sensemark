const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_CHARS,
  PRIVACY_CONSENT_VERSION,
  createRequestPlan,
  isShortText,
  parseManualResponse,
  settingsIssue
} = require("../manual-translation.js");

test("manual translation validates setup before a request", () => {
  assert.equal(settingsIssue({ apiKey: "key", privacyConsentVersion: 0 }).code, "consent");
  assert.equal(
    settingsIssue({ apiKey: "  ", privacyConsentVersion: PRIVACY_CONSENT_VERSION }).code,
    "api-key"
  );
  assert.equal(
    settingsIssue({ apiKey: "key", privacyConsentVersion: PRIVACY_CONSENT_VERSION }),
    null
  );
});

test("manual request plan rejects empty, oversized, and non-word input", () => {
  assert.equal(createRequestPlan("   ").kind, "error");
  assert.equal(createRequestPlan("• — 123").kind, "error");
  assert.match(createRequestPlan("a".repeat(MAX_CHARS + 1)).message, /5000/);
});

test("manual request plan skips Russian and technical insertions locally", () => {
  assert.equal(createRequestPlan("Этот текст уже на русском.").kind, "russian");
  assert.equal(
    createRequestPlan("Критичный момент с dev-секретом и APP_ENV.", {
      isReliable: true,
      languages: [{ language: "en", percentage: 60 }]
    }).kind,
    "russian"
  );
});

test("manual request plan selects word and multilingual text modes", () => {
  const word = createRequestPlan("Why");
  assert.equal(word.kind, "request");
  assert.equal(word.wordMode, true);
  assert.deepEqual(word.sourceScripts, ["Latin"]);
  assert.equal(word.context, null);

  const paragraph = createRequestPlan("This sentence is long enough to use regular text mode.");
  assert.equal(paragraph.wordMode, false);

  const mixed = createRequestPlan("Hello مرحبا");
  assert.equal(mixed.wordMode, false);
  assert.deepEqual(mixed.sourceScripts, ["Latin", "Arabic"]);
  assert.equal(isShortText("short phrase"), true);
});

test("manual response hides protocol scaffolding until translated text exists", () => {
  assert.equal(parseManualResponse("[[text]]\n", false).visible, false);
  assert.equal(parseManualResponse("[[translation]]\n", true, "Why").visible, false);
  assert.equal(parseManualResponse("[[reference]]\n", true, "Sensemark").visible, false);
  assert.equal(parseManualResponse("[[skip]]", false).visible, false);
});

test("manual response parses text and word translations", () => {
  assert.deepEqual(parseManualResponse("[[text]]\nГотовый перевод.", false), {
    visible: true,
    kind: "translation",
    text: "Готовый перевод.",
    detail: "",
    detailLabel: "",
    copyText: "Готовый перевод."
  });

  assert.deepEqual(
    parseManualResponse("[[translation]]\nпочему\nдругие значения: зачем", true, "Why"),
    {
      visible: true,
      kind: "translation",
      text: "почему",
      detail: "зачем",
      detailLabel: "Другие значения",
      copyText: "почему"
    }
  );
});

test("manual response preserves multilingual order and builds copy text", () => {
  const view = parseManualResponse(
    "[[multilingual]]\n" +
      "[[script:Latin|lang:английский]]\nПривет.\n" +
      "[[script:Arabic|lang:арабский]]\nДобро пожаловать.",
    false
  );

  assert.equal(view.kind, "multilingual");
  assert.deepEqual(
    view.sections.map((section) => section.language),
    ["английский", "арабский"]
  );
  assert.equal(view.copyText, "Привет.\n\nДобро пожаловать.");
});

test("manual response gives unknown terms a separate reference view", () => {
  assert.deepEqual(
    parseManualResponse(
      "[[reference]]\nназвание\nВероятно, название проекта.",
      true,
      "Sensemark"
    ),
    {
      visible: true,
      kind: "reference",
      title: "Sensemark",
      category: "название",
      detail: "Вероятно, название проекта.",
      detailLabel: "Что это может быть",
      copyText: "Sensemark\nВероятно, название проекта."
    }
  );
});
