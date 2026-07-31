const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../shared/config.js");
const contracts = require("../shared/contracts.js");
const errors = require("../shared/errors.js");

test("translation request contract trims, bounds and normalizes metadata", () => {
  const request = contracts.createTranslationRequest({
    text: " hello ",
    mode: "invalid",
    sourceScripts: ["Latin", null, "Arabic"],
    anchorRect: { left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }
  });
  assert.equal(request.text, "hello");
  assert.equal(request.mode, config.TRANSLATION_MODE.TEXT);
  assert.deepEqual(request.sourceScripts, ["Latin", "Arabic"]);
  assert.equal(request.targetLanguage, "ru");
  assert.ok(request.requestId);
  assert.equal(contracts.normalizeRect({ left: 1 }), null);
  assert.throws(() => contracts.createTranslationRequest({ text: "" }), /required/);
  assert.throws(
    () => contracts.createTranslationRequest({ text: "a".repeat(5001) }),
    /Maximum/
  );
  assert.throws(
    () => contracts.createTranslationRequest({ text: "hello", requestId: "bad id" }),
    /requestId/
  );
  assert.equal(
    contracts.createTranslationRequest({ text: "hello", surface: "unknown" }).surface,
    "content"
  );
});

test("translation result contract supports structured fields and rejects emptiness", () => {
  const result = contracts.createTranslationResult({
    kind: "multilingual",
    text: "",
    alternatives: ["one", null, "two"],
    sections: [{ script: "Latin", source: "hello", translation: "привет" }]
  });
  assert.equal(result.kind, "multilingual");
  assert.deepEqual(result.alternatives, ["one", "two"]);
  assert.equal(result.sections[0].translation, "привет");
  assert.throws(() => contracts.createTranslationResult({}), /must contain/);
  assert.equal(
    contracts.isTranslationDelta({ type: "translation.delta", requestId: "1", delta: "a" }),
    true
  );
  assert.equal(contracts.isTranslationDelta({}), false);
});

test("normalized errors are serializable and map to user actions", () => {
  const auth = new errors.SensemarkError(errors.ERROR_CODE.AUTH, "bad", { status: 401 });
  assert.deepEqual(auth.toJSON(), {
    code: "INVALID_API_KEY",
    message: "bad",
    providerId: "",
    providerErrorCode: "",
    httpStatus: 401,
    retryable: false,
    retryAfterMs: 0,
    settingsRelevant: true,
    action: "open-settings"
  });
  assert.equal(errors.userActionForError(auth), "open-settings");
  assert.equal(
    errors.userActionForError(
      new errors.SensemarkError(errors.ERROR_CODE.NETWORK_ERROR, "offline", {
        retryable: true
      })
    ),
    "retry"
  );
  assert.equal(errors.userActionForError({ code: "invalid-request" }), null);
  assert.equal(
    errors.normalizeUnknownError(new DOMException("cancel", "AbortError")).code,
    "CANCELLED"
  );
  assert.equal(errors.normalizeUnknownError(new Error("x")).code, "NETWORK_ERROR");
  assert.equal(errors.normalizeUnknownError(auth), auth);
});
