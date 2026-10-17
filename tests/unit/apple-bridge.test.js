const assert = require("node:assert/strict");
const test = require("node:test");
const Builtin = require("../../src/builtin-translator.js");
const language = require("../../src/language-detection.js");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

// A fake of Safari's native part (SafariWebExtensionHandler.swift):
// it answers the same operations as the real Swift code.
function fakeNative({ installed = ["en"], supported = ["en", "ja", "de"], detected = "en" } = {}) {
  const state = { calls: [], installed: new Set(installed), openedFor: [] };
  const send = async (payload) => {
    state.calls.push(payload);
    switch (payload.op) {
      case "availability": {
        const status = state.installed.has(payload.source)
          ? "installed"
          : supported.includes(payload.source)
            ? "supported"
            : "unsupported";
        return { ok: true, status };
      }
      case "translate":
        if (!state.installed.has(payload.source)) return { ok: false, code: "needs-download" };
        return { ok: true, text: `APPLE[${payload.source}] ${payload.text}` };
      case "detect":
        return { ok: true, isReliable: true, languages: [{ language: detected, percentage: 97 }] };
      case "openApp":
        state.openedFor.push(payload.source);
        return { ok: true };
      default:
        return { ok: false, code: "failed" };
    }
  };
  return { state, send };
}

function engineFor(native, options = {}) {
  const bridge = Builtin.createAppleBridge({ send: native.send, sleep: async () => {}, ...options });
  return Builtin.createBuiltinTranslator({
    Translator: bridge.Translator,
    detectLanguage: bridge.detectLanguage,
    labels: Builtin.APPLE_LABELS,
    isRussianOnly: language.isRussianOnly,
    detectScripts: (text) => language.detectSignificantScripts(text)
  });
}

test("Safari is recognised by the extension URL, Chrome is not", () => {
  assert.equal(Builtin.isSafariExtension({ getURL: () => "safari-web-extension://ABC/" }), true);
  assert.equal(Builtin.isSafariExtension({ getURL: () => "chrome-extension://abc/" }), false);
  assert.equal(Builtin.isSafariExtension({}), false);
  assert.equal(
    Builtin.isSafariExtension({
      getURL: () => {
        throw new Error("no runtime");
      }
    }),
    false
  );
});

test("platformDeps: Chrome keeps the built-in Translator API and chrome.i18n", async () => {
  const Translator = { create() {} };
  const api = {
    runtime: { getURL: () => "chrome-extension://abc/" },
    i18n: { detectLanguage: async (text) => ({ languages: [{ language: "en", percentage: 100 }], text }) }
  };
  const deps = Builtin.platformDeps(api, { Translator });
  assert.equal(deps.platform, "chrome");
  assert.equal(deps.Translator, Translator);
  assert.equal(deps.labels, Builtin.CHROME_LABELS);
  assert.equal((await deps.detectLanguage("hello")).languages[0].language, "en");
});

test("platformDeps: Safari routes translation and detection to the native app via background", async () => {
  const sent = [];
  const api = {
    runtime: {
      getURL: () => "safari-web-extension://ABC/",
      sendMessage: async (message) => {
        sent.push(message);
        return { ok: true, isReliable: true, languages: [{ language: "de", percentage: 90 }] };
      }
    }
  };
  const deps = Builtin.platformDeps(api, {});
  assert.equal(deps.platform, "safari");
  assert.equal(deps.labels, Builtin.APPLE_LABELS);
  const detection = await deps.detectLanguage("Guten Morgen");
  assert.equal(detection.languages[0].language, "de");
  assert.deepEqual(sent, [{ type: "native", payload: { op: "detect", text: "Guten Morgen" } }]);
});

test("Safari free mode translates through the Apple translator", async () => {
  const native = fakeNative();
  const engine = engineFor(native);
  const result = await engine.run({ text: "The weather is nice today.", sourceScripts: ["Latin"] });
  assert.equal(result, "[[text]]\nAPPLE[en] The weather is nice today.");
  assert.ok(native.state.calls.some((call) => call.op === "translate" && call.target === "ru"));
});

test("Safari: a language that is not downloaded yet asks for the download button right away", async () => {
  const native = fakeNative({ detected: "ja" });
  const engine = engineFor(native);
  await assert.rejects(
    engine.run({ text: "今日はいい天気ですね。", sourceScripts: ["Japanese"] }),
    (error) => {
      assert.equal(error.code, "needs-download");
      assert.equal(error.language, "ja");
      assert.equal(error.message, t("appleNeedsDownload", RU.langJapaneseGenitive));
      return true;
    }
  );
  assert.equal(
    native.state.calls.some((call) => call.op === "translate"),
    false,
    "no translation without the language"
  );
});

test("Safari: the download button opens the Sensemark app and waits until the language is installed", async () => {
  const native = fakeNative({ detected: "ja" });
  let polls = 0;
  const engine = engineFor(native, {
    sleep: async () => {
      polls += 1;
      if (polls === 3) native.state.installed.add("ja"); // the user downloaded the language in the app
    }
  });
  await engine.prepare("ja");
  assert.deepEqual(native.state.openedFor, ["ja"]);
  assert.equal(polls, 3);
  const result = await engine.run({ text: "今日はいい天気ですね。", sourceScripts: ["Japanese"] });
  assert.match(result, /APPLE\[ja\]/);
});

test("Safari: if the language never arrives, the wait ends with a clear message", async () => {
  const native = fakeNative({ detected: "ja" });
  const engine = engineFor(native, { installTimeoutMs: 0 });
  await assert.rejects(engine.prepare("ja"), (error) => {
    assert.equal(error.code, "download-failed");
    assert.equal(error.message, t("appleDownloadFailed"));
    return true;
  });
});

test("Safari: a language Apple cannot translate suggests OpenAI", async () => {
  const native = fakeNative({ detected: "xx", supported: [] });
  const engine = engineFor(native);
  await assert.rejects(engine.run({ text: "Some text here.", sourceScripts: ["Latin"] }), (error) => {
    assert.equal(error.code, "unsupported");
    assert.ok(error.message.startsWith(t("engineApple")));
    return true;
  });
});

test("Safari: without the native app the card explains what is missing", async () => {
  const engine = engineFor({ send: async () => undefined });
  await assert.rejects(engine.run({ text: "Hello there, friend.", sourceScripts: ["Latin"] }), (error) => {
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, t("appleUnavailable"));
    return true;
  });
});

test("Safari labels: download status has no fake percentage", () => {
  assert.equal(Builtin.APPLE_LABELS.reportsProgress, false);
  assert.equal(Builtin.CHROME_LABELS.reportsProgress, true);
  assert.equal(Builtin.APPLE_LABELS.downloading(RU.langJapanese), t("appleDownloading", RU.langJapanese));
});

test("local port reports the Apple wording when the native call fails unexpectedly", async () => {
  const engine = Builtin.createBuiltinTranslator({
    Translator: {
      availability: async () => "available",
      create: async () => ({
        translate: async () => {
          throw new Error("boom");
        }
      })
    },
    detectLanguage: async () => ({ languages: [{ language: "en", percentage: 100 }] }),
    labels: Builtin.APPLE_LABELS,
    isRussianOnly: language.isRussianOnly
  });
  const port = Builtin.openLocalPort(engine);
  const messages = [];
  const finished = new Promise((resolve) =>
    port.onMessage.addListener((message) => {
      messages.push(message);
      if (message.type === "error" || message.type === "done") resolve();
    })
  );
  port.postMessage({ type: "start", text: "Hello there, friend.", sourceScripts: ["Latin"] });
  await finished;
  assert.equal(messages.at(-1).type, "error");
  assert.equal(messages.at(-1).error, Builtin.APPLE_LABELS.failed);
});

test("Safari: macOS older than 26.4 is explained instead of a generic error", async () => {
  const engine = engineFor({ send: async () => ({ ok: false, code: "unavailable" }) });
  await assert.rejects(engine.run({ text: "Hello there, friend.", sourceScripts: ["Latin"] }), (error) => {
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, t("appleUnavailable"));
    return true;
  });
});

test("Safari: a language removed between checks still leads to the download button", async () => {
  const native = fakeNative();
  const engine = engineFor(native);
  native.state.installed.add("en");
  const bridge = Builtin.createAppleBridge({ send: native.send });
  const translator = await bridge.Translator.create({ sourceLanguage: "en" });
  native.state.installed.delete("en");
  await assert.rejects(translator.translate("Hello"), (error) => {
    assert.equal(error.code, "needs-download");
    return true;
  });
  assert.ok(engine);
});
