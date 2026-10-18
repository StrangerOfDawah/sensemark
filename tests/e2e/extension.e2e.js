/* global cache, ping, onMenuClicked -- service-worker globals used inside worker.evaluate() */
// E2E: real Chromium with the extension loaded, real pages and real
// selections. OpenAI is replaced by a stub: no key and no money needed.
// Run: npm run test:e2e   Screenshots for a manual look: dist/e2e-screenshots/
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after, beforeEach } = require("node:test");
const { chromium } = require("playwright");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

// Headless Chromium on Linux is not a Mac, so the card names this shortcut.
const HOTKEY = "Ctrl+Shift+Y";

const ROOT = path.resolve(__dirname, "..", "..");
// SENSEMARK_EXTENSION_DIR: test an unpacked release zip instead of src/.
const EXTENSION = process.env.SENSEMARK_EXTENSION_DIR
  ? path.resolve(process.env.SENSEMARK_EXTENSION_DIR)
  : path.join(ROOT, "src");
const SHOTS = path.join(ROOT, "dist", "e2e-screenshots");
const SITE = "https://site.test";
const PLAIN_SITE = "http://plain.test";
const CARD = "#__gpt_translate_popup_host__ .card";

let context;
let worker;
let extensionId;
const pages = {};
const api = { calls: [], reply: null, delayMs: 0 };
const paidCalls = [];
const STATUS = "#__sensemark_status_host__ .status";

// ---------- OpenAI stub ----------

function sse(chunks) {
  return (
    chunks.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") +
    "data: [DONE]\n\n"
  );
}

function replyWith(text, chunkSize = 6) {
  api.reply = () => {
    const chunks = [];
    for (let i = 0; i < text.length; i += chunkSize) chunks.push(text.slice(i, i + chunkSize));
    return { chunks };
  };
}

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 900, height: 600 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`]
  });
  worker = context.serviceWorkers()[0] || (await context.waitForEvent("serviceworker"));
  extensionId = new URL(worker.url()).host;

  await context.route("https://api.openai.com/**", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    api.calls.push(body);
    const answer = api.reply ? api.reply(body) : { status: 500, error: "no reply configured" };
    // A slow answer, to see the status pill and the circle.
    if (api.delayMs) await new Promise((resolve) => setTimeout(resolve, api.delayMs));
    if (answer.status && answer.status !== 200) {
      await route.fulfill({
        status: answer.status,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: answer.error || "" } })
      });
    } else if (body.stream) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sse(answer.chunks) });
    } else {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ choices: [{ message: { content: answer.chunks.join("") } }] })
      });
    }
  });

  // DeepSeek and YandexGPT: any request that reaches them is recorded.
  for (const host of ["https://api.deepseek.com/**", "https://llm.api.cloud.yandex.net/**"]) {
    await context.route(host, async (route) => {
      paidCalls.push(route.request().url());
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    });
  }

  await context.route(`${SITE}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    const page = pages[name] || "";
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      // A full document is served as is, for pages with their own styling.
      body: page.startsWith("<!doctype")
        ? page
        : `<!doctype html><html><head><meta charset="utf-8"></head>
        <body style="font: 16px/1.5 sans-serif; padding: 24px">${page}</body></html>`
    });
  });

  await context.route(`${PLAIN_SITE}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${pages[name] || ""}</body></html>`
    });
  });

  // On install the extension opens settings (after a short delay):
  // wait for that tab and close it so it does not disturb the first test.
  const isOptions = (page) => page.url().startsWith("chrome-extension://");
  if (!context.pages().some(isOptions)) {
    await context.waitForEvent("page", { predicate: isOptions, timeout: 5000 }).catch(() => {});
  }
  for (const page of context.pages()) {
    if (isOptions(page)) await page.close();
  }
});

after(async () => {
  await context?.close();
});

beforeEach(async () => {
  paidCalls.length = 0;
  api.calls = [];
  api.reply = null;
  api.delayMs = 0;
  // A fresh service worker without the translation cache between tests.
  await worker.evaluate(() => {
    cache.clear();
    return chrome.storage.local.clear();
  });
  await setSettings({});
});

// ---------- helpers ----------

async function setSettings(overrides) {
  await worker.evaluate((settings) => chrome.storage.local.set(settings), {
    provider: "openai",
    apiKey: "sk-test",
    privacyConsentVersion: 1,
    autoTranslate: true,
    ...overrides
  });
}

async function openPage(name, html, { colorScheme = "light" } = {}) {
  pages[name] = html;
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme });
  await page.goto(`${SITE}/${name}`);
  // the content script starts at document_idle and reads settings asynchronously
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForTimeout(150);
  return page;
}

// Select an element's content and release the mouse, like a user.
async function selectAndRelease(page, selector) {
  await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  }, selector);
}

async function cardText(page, selector) {
  return page.locator(`#__gpt_translate_popup_host__ ${selector}`).innerText();
}

async function expectNoCard(page) {
  await page.waitForTimeout(800);
  assert.equal(await page.locator(CARD).count(), 0, "no card may appear");
}

async function shot(page, name) {
  await page.waitForTimeout(500); // wait for the reveal animation to finish
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ---------- scenarios ----------

test("a real mouse selection: the link stays in the text and the translation appears in the card", async () => {
  replyWith(`[[text]]\n${RU.parisCapital}`);
  const page = await openPage(
    "drag",
    '<p id="p">Paris is the capital and largest city of <a href="#">France</a>.</p>'
  );

  const box = await page.locator("#p").boundingBox();
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();

  await page.locator(CARD).waitFor();
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.parisCapital);
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].messages.at(-1).content, "Paris is the capital and largest city of France.");
  assert.equal(
    await page.locator("#__gpt_translate_popup_host__ .term-kind").isVisible(),
    false,
    "an empty category badge must not show in an ordinary card"
  );
  await shot(page, "01-translation-light");
  await page.close();
});

test("Russian text: no card and no request", async () => {
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage("russian", `<p id="p">${RU.alreadyRussian}</p>`);
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("selecting a whole noisy page: only the article reaches the model", async () => {
  replyWith(`[[text]]\n${RU.cityCouncil}`);
  const page = await openPage(
    "noisy",
    `<div id="all">
      <header><nav><a href="/">Home</a> | <a href="/news">News</a></nav><button>Sign in</button></header>
      <main><article>
        <header><h1>City council approves new park</h1></header>
        <p>The council voted<sup><a href="#n1">[1]</a></sup> to build a park near the <a href="/r">river</a>.</p>
        <p>Area is 5 km<sup>2</sup>.<br>Work starts in May.</p>
        <div><button> Share</button> <span role="button">12 comments</span></div>
      </article></main>
      <aside><a href="#">Trending celebrity news</a></aside>
      <footer>Daily News · <a href="#">Privacy</a></footer>
    </div>`
  );
  await selectAndRelease(page, "#all");
  await page.locator(CARD).waitFor();
  assert.equal(
    api.calls[0].messages.at(-1).content,
    "City council approves new park\n" +
      "The council voted to build a park near the river.\n" +
      "Area is 5 km2.\n" +
      "Work starts in May."
  );
  await page.close();
});

test("a single word is translated in context and shows other meanings", async () => {
  replyWith(`[[translation]]\n${RU.bank}\n${t("protocolOtherMeanings")}: ${RU.bankMeanings}`);
  const page = await openPage(
    "word",
    '<p>I went to the <span id="w">bank</span> yesterday to deposit a check.</p>'
  );
  await selectAndRelease(page, "#w");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();

  const userMessage = api.calls[0].messages.at(-1).content;
  assert.equal(userMessage, "Context: I went to the bank yesterday to deposit a check.\nFragment: bank");
  assert.equal(await cardText(page, ".live"), RU.bank);
  assert.ok((await cardText(page, ".alt")).includes(RU.bankMeanings));
  await shot(page, "02-word-light");
  await page.close();
});

test("a name or title is shown as an amber explanation card", async () => {
  replyWith(`[[reference]]\n${RU.brand}\n${RU.extensionName}`);
  const page = await openPage(
    "reference",
    '<p>Use <span id="w">Sensemark</span> to translate the selection.</p>'
  );
  await selectAndRelease(page, "#w");
  await page.locator(`${CARD}.reference`).waitFor();
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".badge"), t("labelReference"));
  assert.ok((await cardText(page, ".alt")).includes(RU.extensionName));
  await shot(page, "03-reference-light");
  await page.close();
});

test("mixed text is split into sections by language; the Russian part is not translated", async () => {
  replyWith(
    "[[multilingual]]\n" +
      `[[script:Cyrillic|lang:${RU.langRussian}]]\n${RU.helloExclaim}\n` +
      `[[script:Latin|lang:${RU.langEnglish}]]\n${RU.howAreYou}\n` +
      `[[script:Arabic|lang:${RU.langArabic}]]\n${RU.welcome}`
  );
  const page = await openPage("mixed", `<p id="p">${RU.helloExclaim} How are you? مرحبا بك.</p>`);
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD}.multilingual`).waitFor();
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  const labels = await page.locator("#__gpt_translate_popup_host__ .segment-lang").allInnerTexts();
  // The labels are upper-cased by CSS, and innerText returns them as shown.
  const shown = labels.map((label) => label.toLowerCase());
  assert.ok(
    shown.some((label) => label.includes(RU.langEnglish)),
    labels.join(" | ")
  );
  assert.ok(
    shown.some((label) => label.includes(RU.langArabic)),
    labels.join(" | ")
  );
  assert.equal(api.calls.length, 1, "a correct answer must not trigger a retry");
  await shot(page, "04-multilingual-light");
  await page.close();
});

test("selecting the same text again is served from the cache without a new request", async () => {
  replyWith(`[[text]]\n${RU.goodWeather}`);
  const page = await openPage("cache", '<p id="p">The weather is nice today.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(CARD).waitFor({ state: "detached" });

  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.goodWeather);
  assert.equal(api.calls.length, 1);
  await page.close();
});

test("Esc and an outside click close the card", async () => {
  replyWith(`[[text]]\n${RU.helloWorldDot}`);
  const page = await openPage("close", '<p id="p">Hello, world.</p><p id="other">x</p>');
  await selectAndRelease(page, "#p");
  await page.locator(CARD).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(CARD).waitFor({ state: "detached" });

  await setSettings({ autoTranslate: false });
  await page.waitForTimeout(100);
  await worker.evaluate(() => cache.clear());
  await setSettings({ autoTranslate: true });
  await page.waitForTimeout(100);
  await selectAndRelease(page, "#p");
  await page.locator(CARD).waitFor();
  await page.mouse.click(800, 550);
  await page.locator(CARD).waitFor({ state: "detached" });
  await page.close();
});

test("shortcut / context menu path: translation on command with auto-translate off", async () => {
  await setSettings({ autoTranslate: false });
  replyWith(`[[text]]\n${RU.goodMorning}`);
  const page = await openPage("command", '<p id="p">Good morning, everyone. Let us start the meeting.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page); // auto-translate is off, so a selection alone does nothing

  // What the background does on Ctrl/⌘+Shift+Y or the menu item.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await ping(tab.id);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.goodMorning);
  assert.equal(
    await page.locator("#__gpt_translate_popup_host__ [data-act=auto]").isVisible(),
    false,
    "no pause button while auto-translate is off"
  );
  await page.close();
});

test("an invalid model answer: one retry, then a clear error", async () => {
  replyWith("[[text]]\nThis is not Russian at all.");
  const page = await openPage("bad-model", '<p id="p">The report is ready for review today.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.equal(await cardText(page, ".err-t"), t("errorIncompleteTranslation"));
  assert.equal(api.calls.length, 2, "exactly one retry");
  await page.close();
});

test("a wrong key: a clear error instead of a translation", async () => {
  api.reply = () => ({ status: 401, error: "Incorrect API key" });
  const page = await openPage("error", '<p id="p">Something went wrong here.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.equal(await cardText(page, ".err-t"), t("errorApi401"));
  await shot(page, "05-error-light");
  await page.close();
});

test("without consent to send text, no request goes to OpenAI", async () => {
  await setSettings({ privacyConsentVersion: 0 });
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage("consent", '<p id="p">Please translate this text.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.equal(await cardText(page, ".err-t"), t("errorConsentRequired", "OpenAI"));
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("dark page theme: the card uses the dark look", async () => {
  replyWith(`[[text]]\n${RU.parisShort}`);
  const page = await openPage("dark", '<p id="p">Paris is the capital of France.</p>', {
    colorScheme: "dark"
  });
  await page.evaluate(() => (document.body.style.background = "#111"));
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await shot(page, "06-translation-dark");
  await page.close();
});

test("manual translation popup: pasting text starts translating automatically", async () => {
  replyWith(`[[text]]\n${RU.newVersion}`);
  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 520 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator("#sourceText").fill("The new version is available now.");
  await page.locator("#result:not([hidden])").waitFor();
  await page.locator("#copyButton:not([disabled])").waitFor();
  assert.ok((await page.locator("#resultBody").innerText()).includes(RU.newVersion));
  assert.equal(api.calls.length, 1);
  await shot(page, "07-popup-light");

  // Russian text in the manual popup does not reach the API either.
  await page.locator("#sourceText").fill(RU.alreadyRussianPopup);
  await page.waitForTimeout(1200);
  assert.equal(api.calls.length, 1);
  await page.close();
});

// ---------- accidental selections and auto-translate controls ----------

const AUTO_BUTTON = "#__gpt_translate_popup_host__ [data-act=auto]";

async function settings() {
  return worker.evaluate(() => chrome.storage.local.get(null));
}

test("select and immediately press Ctrl/⌘+C: no translation starts", async () => {
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage("copy", '<p id="p">Copy this sentence to the clipboard please.</p>');
  await selectAndRelease(page, "#p");
  await page.keyboard.press("Control+KeyC");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);

  // The same on a Mac.
  await selectAndRelease(page, "#p");
  await page.keyboard.press("Meta+KeyC");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("select and right-click: no translation starts, Chrome's menu is free", async () => {
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage("rightclick", '<p id="p">Right click on this sentence to open the menu.</p>');
  await selectAndRelease(page, "#p");
  await page.locator("#p").dispatchEvent("contextmenu");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("a selection inside an input is not translated automatically", async () => {
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage(
    "editable",
    '<textarea id="t">Some text I am editing right now.</textarea><div id="d" contenteditable="true">Draft message text here.</div>'
  );
  await page.locator("#t").click();
  await page.keyboard.press("Control+A");
  await page.mouse.up();
  await page.evaluate(() => document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })));
  await selectAndRelease(page, "#d");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("the translate context menu item exists and starts a translation", async () => {
  const exists = await worker.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.contextMenus.update("translate-selection", {}, () =>
          resolve(chrome.runtime.lastError?.message || "ok")
        )
      )
  );
  assert.equal(exists, "ok");

  await setSettings({ autoTranslate: false });
  replyWith(`[[text]]\n${RU.contextMenuTranslation}`);
  const page = await openPage("ctxmenu", '<p id="p">This is a translation through the context menu.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  // What Chrome calls when the menu item is clicked.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await onMenuClicked({ menuItemId: "translate-selection", frameId: 0 }, tab);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.contextMenuTranslation);
  await page.close();
});

test("5-minute pause from the card: auto-translate is silent, manual translation works", async () => {
  replyWith(`[[text]]\n${RU.firstTranslation}`);
  const page = await openPage(
    "pause",
    '<p id="p">This is the first translation of the day.</p><p id="q">Another sentence that we will need later.</p>'
  );
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.locator(AUTO_BUTTON).click();
  await page.locator("#__gpt_translate_popup_host__ .auto-menu").waitFor();
  await shot(page, "08-auto-menu-light");

  const before = Date.now();
  await page.locator("#__gpt_translate_popup_host__ [data-act=pause]").click();
  const note = await cardText(page, ".auto-note");
  const [pausedPrefix] = t("autoPausedUntil", "\u0000", "").split("\u0000");
  assert.ok(note.startsWith(pausedPrefix));
  assert.match(note.slice(pausedPrefix.length), /^\d\d:\d\d/);
  assert.ok(note.endsWith(t("manualHint", HOTKEY)));
  await shot(page, "09-auto-paused-light");
  const paused = (await settings()).autoPausedUntil;
  assert.ok(paused >= before + 5 * 60 * 1000 - 1000 && paused <= Date.now() + 5 * 60 * 1000);

  await page.keyboard.press("Escape");
  await page.locator(CARD).waitFor({ state: "detached" });
  replyWith(`[[text]]\n${RU.anotherSentence}`);
  await selectAndRelease(page, "#q");
  await expectNoCard(page);
  assert.equal(api.calls.length, 1, "no auto requests during the pause");

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await onMenuClicked({ menuItemId: "translate-selection", frameId: 0 }, tab);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.anotherSentence);
  await page.close();
});

test("the pause ends by itself", async () => {
  await setSettings({ autoPausedUntil: Date.now() + 1500 });
  replyWith(`[[text]]\n${RU.afterPause}`);
  const page = await openPage("pause-end", '<p id="p">This sentence comes after the pause ends.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  await page.waitForTimeout(1200);
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), RU.afterPause);
  await page.close();
});

test("turn auto-translate off from the card and back on from the extension icon", async () => {
  replyWith(`[[text]]\n${RU.translationWord}`);
  const page = await openPage(
    "off",
    '<p id="p">Here is some text that needs a translation.</p><p id="q">This text should be translated a bit later.</p>'
  );
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.locator(AUTO_BUTTON).click();
  await page.locator("#__gpt_translate_popup_host__ [data-act=off]").click();
  assert.equal(await cardText(page, ".auto-note"), t("autoTurnedOff", t("manualHint", HOTKEY)));
  await shot(page, "10-auto-off-light");
  assert.equal((await settings()).autoTranslate, false);

  await page.keyboard.press("Escape");
  await selectAndRelease(page, "#q");
  await expectNoCard(page);

  // Right click on the Sensemark icon → "turn auto-translate on".
  await worker.evaluate(() => onMenuClicked({ menuItemId: "toggle-auto-translate" }, null));
  assert.equal((await settings()).autoTranslate, true);
  await page.waitForTimeout(100);
  replyWith(`[[text]]\n${RU.later}`);
  await selectAndRelease(page, "#q");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.close();
});

test("dark theme: the auto-translate menu", async () => {
  replyWith(`[[text]]\n${RU.parisShort}`);
  const page = await openPage("dark-menu", '<p id="p">Paris is the capital of France.</p>', {
    colorScheme: "dark"
  });
  await page.evaluate(() => (document.body.style.background = "#111"));
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.locator(AUTO_BUTTON).click();
  await page.locator("#__gpt_translate_popup_host__ .auto-menu").waitFor();
  await shot(page, "11-auto-menu-dark");
  await page.close();
});

// ---------- free mode: Chrome's built-in translator ----------
// Chrome's language models cannot be downloaded on a cloud machine (no access
// to Google's servers). This checks the wiring with the real Chrome API: after
// a mouse selection Chrome starts downloading the pack, and the card honestly
// shows that instead of staying silent. Translation itself is unit-tested and checked by hand.

test("free mode: nothing goes to OpenAI, the card shows the language pack download", async () => {
  await setSettings({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 });
  replyWith(`[[text]]\n${RU.mustNotAppear}`);
  const page = await openPage("free", '<p id="p">The weather is nice today, let us go for a walk.</p>');
  await selectAndRelease(page, "#p");
  // While Chrome downloads the pack, the pill with the language is visible, not an empty card.
  await page.locator(STATUS).waitFor();
  const withoutEllipsis = (text) => text.replace(/…$/, "");
  const label = await page.locator(`${STATUS} .lbl`).innerText();
  assert.ok(label.startsWith(withoutEllipsis(t("chromeDownloading", RU.langEnglish))), label);
  const title = await page.locator(STATUS).getAttribute("title");
  assert.ok(title.startsWith(withoutEllipsis(t("downloadingPack", RU.langEnglishGenitive))), title);
  assert.equal(await page.locator(CARD).count(), 0);
  assert.equal(api.calls.length, 0, "free mode makes no OpenAI requests");
  await shot(page, "12-free-downloading-light");
  await page.close();
});

test("free mode on a non-https page: a clear explanation, no requests", async () => {
  await setSettings({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 });
  pages["plain"] = '<p id="p">The weather is nice today, let us go for a walk.</p>';
  const page = await context.newPage();
  await page.goto(`${PLAIN_SITE}/plain`);
  await page.waitForTimeout(150);
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.match(await cardText(page, ".err-t"), /https/);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("settings: free mode hides everything about OpenAI, choosing OpenAI shows the key", async () => {
  await setSettings({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 });
  const page = await context.newPage();
  await page.setViewportSize({ width: 760, height: 1100 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('input[value="builtin"]:checked').waitFor();
  assert.equal(await page.locator("#providerSettings").isVisible(), false);
  await shot(page, "13-options-free-light");

  await page.locator('input[value="openai"]').check();
  await page.locator("#apiKey").waitFor();
  assert.equal(await page.locator("#providerSettings").isVisible(), true);
  await page.waitForTimeout(100);
  assert.equal((await settings()).provider, "openai");
  await page.close();
});

// ---------- chameleon: status, page-matched colour, long text ----------

function article({
  background = "#ffffff",
  color = "#222222",
  font = "17px/1.65 Georgia, serif",
  width = 600,
  body
}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head>
    <body style="margin: 0; background: ${background}; color: ${color}; font: ${font}">
      <div style="width: ${width}px; margin: 34px 0 0 90px">${body}</div>
    </body></html>`;
}

const PARIS =
  "Paris is the capital and largest city of France, and on Sunday mornings its streets feel surprisingly quiet.";

test("status: the translating pill shrinks into a circle, then the card opens", async () => {
  replyWith(`[[text]]\n${RU.parisLong}`);
  api.delayMs = 2600;
  const page = await openPage("status", article({ body: `<p id="p">${PARIS}</p>` }));
  await selectAndRelease(page, "#p");

  await page.locator(STATUS).waitFor();
  assert.equal(
    await page.locator(`${STATUS} .lbl`).innerText(),
    t("statusTranslatingFrom", RU.langEnglishGenitive)
  );
  assert.equal(await page.locator(CARD).count(), 0, "no empty card");
  const fontSize = await page.locator(STATUS).evaluate((element) => getComputedStyle(element).fontSize);
  assert.equal(fontSize, "12px", "the label is small and calm");
  await shot(page, "14-status-pill");

  await page.locator(`${STATUS}.mini`).waitFor({ timeout: 3000 });
  await shot(page, "15-status-circle");

  await page.locator(`${CARD} .acts:not(.pending)`).waitFor({ timeout: 6000 });
  assert.equal(await page.locator(STATUS).count(), 0, "the circle gave way to the card");
  assert.equal(
    await cardText(page, ".badge"),
    `${t("labelTranslation")} · ${t("fromLanguage", RU.langEnglishGenitive)}`
  );
  await shot(page, "16-status-card");
  await page.close();
});

test("dark page: the pill and the card are dark, matching the site", async () => {
  replyWith(`[[text]]\n${RU.updateNotes}`);
  api.delayMs = 1800;
  const page = await openPage(
    "dark-status",
    article({
      background: "#0d1117",
      color: "#c9d1d9",
      font: "16px/1.6 -apple-system, BlinkMacSystemFont, sans-serif",
      body: '<p id="p">The update improves startup time and fixes a crash when importing large files.</p>'
    })
  );
  await selectAndRelease(page, "#p");
  await page.locator(STATUS).waitFor();
  const pillBackground = await page
    .locator(STATUS)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(pillBackground, "rgb(255, 255, 255)", "the pill is not white on a dark site");
  await shot(page, "17-status-dark");

  await page.locator(`${CARD} .acts:not(.pending)`).waitFor({ timeout: 6000 });
  assert.equal(await page.locator(CARD).getAttribute("data-scheme"), "dark");
  const cardBackground = await page
    .locator(CARD)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(cardBackground, "rgb(255, 255, 255)", "the card is dark");
  assert.equal(cardBackground, pillBackground, "the circle and the card share a colour");
  await shot(page, "17b-card-dark");
  await page.close();
});

test("sepia: a warm card and translation text sized as on the page", async () => {
  replyWith(`[[text]]\n${RU.lateEvening}`);
  const page = await openPage(
    "sepia",
    article({
      background: "#f4ecd8",
      color: "#3b2f20",
      font: "19px/1.6 Georgia, serif",
      body: '<p id="p">It was late in the evening when the letter finally arrived at the house.</p>'
    })
  );
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  const size = await page.locator(`${CARD} .tr`).evaluate((element) => getComputedStyle(element).fontSize);
  assert.equal(size, "19px");
  const background = await page
    .locator(CARD)
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.notEqual(background, "rgb(255, 255, 255)", "the card is warm, not white");
  await shot(page, "18-sepia");
  await page.close();
});

const LONG_BODY = `
  <div style="font: 700 30px/1.2 -apple-system, sans-serif; margin-bottom: 18px">A slow morning in the city</div>
  <p>I woke up early, made coffee, and decided to walk before the city did.</p>
  <div id="sel">
    <p>${PARIS} The bakery on the corner opens at seven and sells out of croissants before nine.</p>
    <p>Most tourists arrive later, so early walks are the best way to see the old town. In the evening the river fills with boats, music and people sitting along the banks.</p>
    <p>By noon the cafés are full, and the quiet city I saw at dawn is gone until next Sunday.</p>
  </div>
  <p>On the way home I bought flowers at the market near the bridge.</p>
  <div style="height: 1400px"></div>`;

const LONG_REPLY = `[[text]]\n${RU.parisLong} ${RU.bakery}\n${RU.tourists} ${RU.evening}\n${RU.noon}`;

test("long text: a margin note on the right that keeps the text visible and moves on scroll", async () => {
  replyWith(LONG_REPLY, 40);
  const page = await openPage("long", article({ body: LONG_BODY }));
  await page.setViewportSize({ width: 1200, height: 720 });
  await selectAndRelease(page, "#sel");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();

  assert.equal(await page.locator(CARD).evaluate((element) => element.classList.contains("margin")), true);
  assert.equal(
    await cardText(page, ".badge"),
    `${t("labelTranslation")} · ${t("paragraphsFew", 3)} ${t("fromLanguage", RU.langEnglishGenitive)}`
  );
  const text = await page.locator("#sel").boundingBox();
  const before = await page.locator(CARD).boundingBox();
  assert.ok(before.x >= text.x + text.width, "the note is right of the text, the text stays visible");
  await shot(page, "19-long-margin");

  await page.mouse.move(300, 300);
  await page.mouse.wheel(0, 150);
  await page.waitForTimeout(400);
  assert.equal(await page.locator(CARD).count(), 1, "scrolling does not close the translation");
  const after = await page.locator(CARD).boundingBox();
  assert.ok(Math.abs(before.y - 150 - after.y) <= 2, "the note moved with the text");
  await shot(page, "20-long-margin-scrolled");
  await page.close();
});

test("full-width long text: a panel at the right window edge", async () => {
  replyWith(LONG_REPLY, 40);
  const page = await openPage(
    "drawer",
    article({
      background: "#0d1117",
      color: "#c9d1d9",
      font: "16px/1.6 -apple-system, BlinkMacSystemFont, sans-serif",
      width: 1080,
      body: LONG_BODY
    })
  );
  await page.setViewportSize({ width: 1200, height: 720 });
  await selectAndRelease(page, "#sel");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await page.locator(CARD).evaluate((element) => element.classList.contains("drawer")), true);
  const box = await page.locator(CARD).boundingBox();
  assert.equal(Math.round(box.x + box.width), 1200, "the panel sticks to the right edge");
  assert.equal(Math.round(box.height), 720, "full window height");
  await shot(page, "21-long-drawer");
  await page.close();
});

test("the Golos Text font from settings is loaded from the extension, offline", async () => {
  await setSettings({ cardFont: "golos" });
  replyWith(`[[text]]\n${RU.parisLargest}`);
  const page = await openPage("font", article({ body: `<p id="p">${PARIS}</p>` }));
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.waitForFunction((sample) => document.fonts.check('16px "Sensemark Golos"', sample), RU.paris);
  const family = await page
    .locator(`${CARD} .tr`)
    .evaluate((element) => getComputedStyle(element).fontFamily);
  assert.match(family, /Sensemark Golos/);
  await shot(page, "22-font-golos");
  await page.close();
});

test("appearance settings: theme, font and size are saved", async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('input[name="cardTheme"][value="auto"]:checked').waitFor({ state: "attached" });
  await page.locator("#appearanceGroup").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.locator("#appearanceGroup").screenshot({ path: path.join(SHOTS, "23-options-appearance.png") });

  await page.locator('label:has(input[name="cardTheme"][value="dark"])').click();
  await page.locator('label:has(input[name="cardFont"][value="literata"])').click();
  await page.locator("#matchPageSize").click();
  await page.waitForTimeout(150);
  const saved = await settings();
  assert.equal(saved.cardTheme, "dark");
  assert.equal(saved.cardFont, "literata");
  assert.equal(saved.matchPageSize, false);
  await page.close();
});

// ---------- DeepSeek and YandexGPT ----------

test("DeepSeek mode without the browser's permission: the card explains, nothing is sent", async () => {
  await setSettings({ provider: "deepseek", deepseekApiKey: "sk-ds", providerConsent: { deepseek: 1 } });
  const page = await openPage("deepseek", '<p id="p">Please translate this text.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.equal(await cardText(page, ".err-t"), t("errorPermissionRequired", "DeepSeek"));
  assert.deepEqual(paidCalls, []);
  assert.equal(api.calls.length, 0, "nothing goes to OpenAI either");
  await page.close();
});

test("settings: YandexGPT mode shows its own key, folder and privacy text", async () => {
  await setSettings({ provider: "yandex", apiKey: "sk-openai", yandexApiKey: "", providerConsent: {} });
  const page = await context.newPage();
  await page.setViewportSize({ width: 760, height: 1100 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('input[value="yandex"]:checked').waitFor();
  assert.equal(await page.locator("#providerSettings").isVisible(), true);
  assert.equal(await page.locator("#folderRow").isVisible(), true);
  assert.equal(await page.locator("#modelRow").isVisible(), false);
  assert.equal(await page.locator("#privacyTitle").textContent(), t("privacyTitle", "YandexGPT"));
  assert.equal(await page.locator("#apiKey").inputValue(), "", "the OpenAI key is not shown for Yandex");
  assert.equal(await page.locator("#dataConsent").isChecked(), false);
  await shot(page, "14-options-yandex-light");
  await page.close();
});
