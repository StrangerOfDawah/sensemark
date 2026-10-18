const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MAX_CHARS,
  PRIVACY_CONSENT_VERSION,
  createRequestPlan,
  isShortText,
  parseManualResponse,
  settingsIssue
} = require("../../src/manual-translation.js");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

test("manual translation validates setup before a request", () => {
  const openai = { provider: "openai" };
  assert.equal(settingsIssue({ ...openai, apiKey: "key", privacyConsentVersion: 0 }).code, "consent");
  assert.equal(
    settingsIssue({ ...openai, apiKey: "  ", privacyConsentVersion: PRIVACY_CONSENT_VERSION }).code,
    "api-key"
  );
  assert.equal(
    settingsIssue({ ...openai, apiKey: "key", privacyConsentVersion: PRIVACY_CONSENT_VERSION }),
    null
  );
  // Chrome's free translator needs neither a key nor consent.
  assert.equal(settingsIssue({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 }), null);
});

test("manual translation names the paid service that needs setup", () => {
  const deepseek = {
    provider: "deepseek",
    privacyConsentVersion: PRIVACY_CONSENT_VERSION,
    deepseekApiKey: "sk"
  };
  const consent = settingsIssue(deepseek);
  assert.equal(consent.code, "consent", "OpenAI consent does not cover DeepSeek");
  assert.equal(consent.message, t("setupConsent", "DeepSeek"));
  assert.equal(
    settingsIssue({ ...deepseek, deepseekApiKey: "", providerConsent: { deepseek: 1 } }).message,
    t("setupApiKey", "DeepSeek")
  );

  const yandex = { provider: "yandex", yandexApiKey: "AQVN", providerConsent: { yandex: 1 } };
  assert.deepEqual(settingsIssue(yandex), { code: "folder", message: t("setupFolder") });
  assert.equal(settingsIssue({ ...yandex, yandexFolderId: "b1g" }), null);
});

test("manual request plan rejects empty, oversized, and non-word input", () => {
  assert.equal(createRequestPlan("   ").kind, "error");
  assert.equal(createRequestPlan("• — 123").kind, "error");
  assert.match(createRequestPlan("a".repeat(MAX_CHARS + 1)).message, /5000/);
});

test("manual request plan skips Russian and technical insertions locally", () => {
  assert.equal(createRequestPlan(RU.alreadyRussianShort).kind, "russian");
  assert.equal(
    createRequestPlan(RU.devSecretShort, {
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
  assert.deepEqual(parseManualResponse(`[[text]]\n${RU.readyTranslation}`, false), {
    visible: true,
    kind: "translation",
    text: RU.readyTranslation,
    detail: "",
    detailLabel: "",
    copyText: RU.readyTranslation
  });

  assert.deepEqual(
    parseManualResponse(
      `[[translation]]\n${RU.why}\n${t("protocolOtherMeanings")}: ${RU.whatFor}`,
      true,
      "Why"
    ),
    {
      visible: true,
      kind: "translation",
      text: RU.why,
      detail: RU.whatFor,
      detailLabel: t("labelOtherMeanings"),
      copyText: RU.why
    }
  );
});

test("manual response preserves multilingual order and builds copy text", () => {
  const view = parseManualResponse(
    "[[multilingual]]\n" +
      `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.helloDot}\n` +
      `[[script:Arabic|lang:${RU.langArabic}]]\n${RU.welcome}`,
    false
  );

  assert.equal(view.kind, "multilingual");
  assert.deepEqual(
    view.sections.map((section) => section.language),
    [RU.langEnglish, RU.langArabic]
  );
  assert.equal(view.copyText, `${RU.helloDot}\n\n${RU.welcome}`);
});

test("manual response gives unknown terms a separate reference view", () => {
  assert.deepEqual(
    parseManualResponse(`[[reference]]\n${RU.title}\n${RU.probablyProjectName}`, true, "Sensemark"),
    {
      visible: true,
      kind: "reference",
      title: "Sensemark",
      category: RU.title,
      detail: RU.probablyProjectName,
      detailLabel: t("labelWhatItMayBe"),
      copyText: `Sensemark\n${RU.probablyProjectName}`
    }
  );
});
