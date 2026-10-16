// E2E: настоящий Chromium с загруженным расширением, настоящие страницы и
// выделения. OpenAI подменяется заглушкой — ключ и деньги не нужны.
// Запуск: npm run test:e2e   Скриншоты для ручного просмотра: dist/e2e-screenshots/
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test, before, after, beforeEach } = require("node:test");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..", "..");
// SENSEMARK_EXTENSION_DIR — проверить распакованный архив релиза вместо исходников.
const EXTENSION = process.env.SENSEMARK_EXTENSION_DIR
  ? path.resolve(process.env.SENSEMARK_EXTENSION_DIR)
  : ROOT;
const SHOTS = path.join(ROOT, "dist", "e2e-screenshots");
const SITE = "https://site.test";
const PLAIN_SITE = "http://plain.test";
const CARD = "#__gpt_translate_popup_host__ .card";

let context;
let worker;
let extensionId;
const pages = {};
const api = { calls: [], reply: null };

// ---------- заглушка OpenAI ----------

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

  await context.route(`${SITE}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"></head>
        <body style="font: 16px/1.5 sans-serif; padding: 24px">${pages[name] || ""}</body></html>`
    });
  });

  await context.route(`${PLAIN_SITE}/**`, async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><head><meta charset="utf-8"></head><body>${pages[name] || ""}</body></html>`
    });
  });

  // При установке расширение открывает настройки (с небольшой задержкой) —
  // дожидаемся этой вкладки и закрываем, чтобы она не мешала первому тесту.
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
  api.calls = [];
  api.reply = null;
  // Свежий service worker без кэша переводов между тестами.
  await worker.evaluate(() => {
    cache.clear();
    return chrome.storage.local.clear();
  });
  await setSettings({});
});

// ---------- помощники ----------

async function setSettings(overrides) {
  await worker.evaluate(
    (settings) => chrome.storage.local.set(settings),
    { provider: "openai", apiKey: "sk-test", privacyConsentVersion: 1, autoTranslate: true, ...overrides }
  );
}

async function openPage(name, html, { colorScheme = "light" } = {}) {
  pages[name] = html;
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme });
  await page.goto(`${SITE}/${name}`);
  // content script стартует на document_idle и читает настройки асинхронно
  await page.waitForFunction(() => document.readyState === "complete");
  await page.waitForTimeout(150);
  return page;
}

// Выделить содержимое элемента и отпустить мышь — как пользователь.
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
  assert.equal(await page.locator(CARD).count(), 0, "карточка не должна появляться");
}

async function shot(page, name) {
  await page.waitForTimeout(500); // дождаться конца анимации появления
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

// ---------- сценарии ----------

test("настоящее выделение мышью: ссылка остаётся в тексте, перевод появляется в карточке", async () => {
  replyWith("[[text]]\nПариж — столица Франции и её крупнейший город.");
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
  assert.equal(await cardText(page, ".live"), "Париж — столица Франции и её крупнейший город.");
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].messages.at(-1).content, "Paris is the capital and largest city of France.");
  assert.equal(
    await page.locator("#__gpt_translate_popup_host__ .term-kind").isVisible(),
    false,
    "пустой бейджик категории не должен быть виден в обычной карточке"
  );
  await shot(page, "01-translation-light");
  await page.close();
});

test("русский текст: ни карточки, ни запроса", async () => {
  replyWith("[[text]]\nне должно быть");
  const page = await openPage("russian", '<p id="p">Этот текст уже на русском языке.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("выделение всей «шумной» страницы: в модель уходит только статья", async () => {
  replyWith("[[text]]\nГорсовет одобрил новый парк.");
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

test("одно слово переводится с учётом предложения и показывает другие значения", async () => {
  replyWith("[[translation]]\nбанк\nдругие значения: берег, вал");
  const page = await openPage(
    "word",
    '<p>I went to the <span id="w">bank</span> yesterday to deposit a check.</p>'
  );
  await selectAndRelease(page, "#w");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();

  const userMessage = api.calls[0].messages.at(-1).content;
  assert.equal(userMessage, "Context: I went to the bank yesterday to deposit a check.\nFragment: bank");
  assert.equal(await cardText(page, ".live"), "банк");
  assert.match(await cardText(page, ".alt"), /берег, вал/);
  await shot(page, "02-word-light");
  await page.close();
});

test("имя или название показывается янтарной карточкой «Объяснение»", async () => {
  replyWith("[[reference]]\nбренд\nНазвание расширения для перевода.");
  const page = await openPage(
    "reference",
    '<p>Use <span id="w">Sensemark</span> to translate the selection.</p>'
  );
  await selectAndRelease(page, "#w");
  await page.locator(`${CARD}.reference`).waitFor();
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".badge"), "ОБЪЯСНЕНИЕ");
  assert.match(await cardText(page, ".alt"), /Название расширения/);
  await shot(page, "03-reference-light");
  await page.close();
});

test("смешанный текст разбивается на секции по языкам, русская часть не переводится", async () => {
  replyWith(
    "[[multilingual]]\n" +
      "[[script:Cyrillic|lang:русский]]\nПривет!\n" +
      "[[script:Latin|lang:английский]]\nКак дела?\n" +
      "[[script:Arabic|lang:арабский]]\nДобро пожаловать."
  );
  const page = await openPage("mixed", '<p id="p">Привет! How are you? مرحبا بك.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD}.multilingual`).waitFor();
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  const labels = await page.locator("#__gpt_translate_popup_host__ .segment-lang").allInnerTexts();
  assert.ok(labels.some((label) => /английский/i.test(label)));
  assert.ok(labels.some((label) => /арабский/i.test(label)));
  assert.equal(api.calls.length, 1, "правильный ответ не должен вызывать повторный запрос");
  await shot(page, "04-multilingual-light");
  await page.close();
});

test("повторное выделение того же текста берётся из кэша без нового запроса", async () => {
  replyWith("[[text]]\nХорошая погода сегодня.");
  const page = await openPage("cache", '<p id="p">The weather is nice today.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.keyboard.press("Escape");
  await page.locator(CARD).waitFor({ state: "detached" });

  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), "Хорошая погода сегодня.");
  assert.equal(api.calls.length, 1);
  await page.close();
});

test("Esc и клик мимо закрывают карточку", async () => {
  replyWith("[[text]]\nПривет, мир.");
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

test("путь горячей клавиши / контекстного меню: перевод по команде без автоперевода", async () => {
  await setSettings({ autoTranslate: false });
  replyWith("[[text]]\nДоброе утро, коллеги. Начинаем встречу.");
  const page = await openPage("command", '<p id="p">Good morning, everyone. Let us start the meeting.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page); // автоперевод выключен — по одному выделению ничего не происходит

  // То же, что делает background при Ctrl/⌘+Shift+Y или пункте меню.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await ping(tab.id);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), "Доброе утро, коллеги. Начинаем встречу.");
  assert.equal(
    await page.locator("#__gpt_translate_popup_host__ [data-act=auto]").isVisible(),
    false,
    "при выключенном автопереводе кнопки паузы нет"
  );
  await page.close();
});

test("неправильный ответ модели: один повторный запрос, затем понятная ошибка", async () => {
  replyWith("[[text]]\nThis is not Russian at all.");
  const page = await openPage("bad-model", '<p id="p">The report is ready for review today.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.match(await cardText(page, ".err-t"), /попробуйте ещё раз/);
  assert.equal(api.calls.length, 2, "ровно один повторный запрос");
  await page.close();
});

test("неверный ключ: понятная ошибка вместо перевода", async () => {
  api.reply = () => ({ status: 401, error: "Incorrect API key" });
  const page = await openPage("error", '<p id="p">Something went wrong here.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.match(await cardText(page, ".err-t"), /Неверный API-ключ/);
  await shot(page, "05-error-light");
  await page.close();
});

test("без согласия на отправку текста запрос в OpenAI не уходит", async () => {
  await setSettings({ privacyConsentVersion: 0 });
  replyWith("[[text]]\nне должно быть");
  const page = await openPage("consent", '<p id="p">Please translate this text.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.match(await cardText(page, ".err-t"), /подтвердите отправку текста/);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("тёмная тема страницы: карточка в тёмном оформлении", async () => {
  replyWith("[[text]]\nПариж — столица Франции.");
  const page = await openPage("dark", '<p id="p">Paris is the capital of France.</p>', {
    colorScheme: "dark"
  });
  await page.evaluate(() => (document.body.style.background = "#111"));
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await shot(page, "06-translation-dark");
  await page.close();
});

test("окно ручного перевода: вставка текста запускает перевод автоматически", async () => {
  replyWith("[[text]]\nНовая версия уже доступна.");
  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 520 });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.locator("#sourceText").fill("The new version is available now.");
  await page.locator("#result:not([hidden])").waitFor();
  await page.locator("#copyButton:not([disabled])").waitFor();
  assert.match(await page.locator("#resultBody").innerText(), /Новая версия уже доступна\./);
  assert.equal(api.calls.length, 1);
  await shot(page, "07-popup-light");

  // Русский текст в окне ручного перевода тоже не уходит в API.
  await page.locator("#sourceText").fill("Это уже русский текст.");
  await page.waitForTimeout(1200);
  assert.equal(api.calls.length, 1);
  await page.close();
});


// ---------- случайные выделения и управление автопереводом ----------

const AUTO_BUTTON = "#__gpt_translate_popup_host__ [data-act=auto]";

async function settings() {
  return worker.evaluate(() => chrome.storage.local.get(null));
}

test("выделил и сразу нажал Ctrl/⌘+C: перевод не запускается", async () => {
  replyWith("[[text]]\nне должно быть");
  const page = await openPage("copy", '<p id="p">Copy this sentence to the clipboard please.</p>');
  await selectAndRelease(page, "#p");
  await page.keyboard.press("Control+KeyC");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);

  // То же на Mac.
  await selectAndRelease(page, "#p");
  await page.keyboard.press("Meta+KeyC");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("выделил и нажал правую кнопку: перевод не запускается, меню Chrome свободно", async () => {
  replyWith("[[text]]\nне должно быть");
  const page = await openPage("rightclick", '<p id="p">Right click on this sentence to open the menu.</p>');
  await selectAndRelease(page, "#p");
  await page.locator("#p").dispatchEvent("contextmenu");
  await expectNoCard(page);
  assert.equal(api.calls.length, 0);
  await page.close();
});

test("выделение внутри поля ввода не переводится автоматически", async () => {
  replyWith("[[text]]\nне должно быть");
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

test("пункт «Перевести на русский» есть в контекстном меню и запускает перевод", async () => {
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
  replyWith("[[text]]\nЭто перевод через контекстное меню.");
  const page = await openPage("ctxmenu", '<p id="p">This is a translation through the context menu.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  // То, что Chrome вызывает при клике по пункту меню.
  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await onMenuClicked({ menuItemId: "translate-selection", frameId: 0 }, tab);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), "Это перевод через контекстное меню.");
  await page.close();
});

test("пауза на 5 минут из карточки: автоперевод молчит, ручной перевод работает", async () => {
  replyWith("[[text]]\nПервый перевод.");
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
  assert.match(note, /на паузе до \d\d:\d\d/);
  assert.match(note, /Перевести на русский/);
  await shot(page, "09-auto-paused-light");
  const paused = (await settings()).autoPausedUntil;
  assert.ok(paused >= before + 5 * 60 * 1000 - 1000 && paused <= Date.now() + 5 * 60 * 1000);

  await page.keyboard.press("Escape");
  await page.locator(CARD).waitFor({ state: "detached" });
  replyWith("[[text]]\nЕщё одно предложение.");
  await selectAndRelease(page, "#q");
  await expectNoCard(page);
  assert.equal(api.calls.length, 1, "во время паузы автозапросов нет");

  await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await onMenuClicked({ menuItemId: "translate-selection", frameId: 0 }, tab);
  });
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), "Ещё одно предложение.");
  await page.close();
});

test("пауза заканчивается сама", async () => {
  await setSettings({ autoPausedUntil: Date.now() + 1500 });
  replyWith("[[text]]\nПосле паузы.");
  const page = await openPage("pause-end", '<p id="p">This sentence comes after the pause ends.</p>');
  await selectAndRelease(page, "#p");
  await expectNoCard(page);
  await page.waitForTimeout(1200);
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  assert.equal(await cardText(page, ".live"), "После паузы.");
  await page.close();
});

test("выключить автоперевод из карточки и включить обратно с иконки расширения", async () => {
  replyWith("[[text]]\nПеревод.");
  const page = await openPage("off", '<p id="p">Here is some text that needs a translation.</p><p id="q">This text should be translated a bit later.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.locator(AUTO_BUTTON).click();
  await page.locator("#__gpt_translate_popup_host__ [data-act=off]").click();
  assert.match(await cardText(page, ".auto-note"), /Автоперевод выключен/);
  await shot(page, "10-auto-off-light");
  assert.equal((await settings()).autoTranslate, false);

  await page.keyboard.press("Escape");
  await selectAndRelease(page, "#q");
  await expectNoCard(page);

  // Правый клик по значку Sensemark → «Включить автоперевод».
  await worker.evaluate(() => onMenuClicked({ menuItemId: "toggle-auto-translate" }, null));
  assert.equal((await settings()).autoTranslate, true);
  await page.waitForTimeout(100);
  replyWith("[[text]]\nПозже.");
  await selectAndRelease(page, "#q");
  await page.locator(`${CARD} .acts:not(.pending)`).waitFor();
  await page.close();
});

test("тёмная тема: меню автоперевода", async () => {
  replyWith("[[text]]\nПариж — столица Франции.");
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


// ---------- бесплатный режим: встроенный переводчик Chrome ----------
// Языковые модели Chrome в облачной машине скачать нельзя (нет доступа к
// серверам Google). Здесь проверяется связка с настоящим API Chrome: после
// выделения мышью Chrome начинает скачивать пакет, и карточка честно это
// показывает, а не молчит. Сам перевод проверяется unit-тестами и вручную.

test("бесплатный режим: в OpenAI ничего не уходит, карточка показывает загрузку языкового пакета", async () => {
  await setSettings({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 });
  replyWith("[[text]]\nне должно быть");
  const page = await openPage("free", '<p id="p">The weather is nice today, let us go for a walk.</p>');
  await selectAndRelease(page, "#p");
  await page.locator(`${CARD} .err-t`).waitFor();
  assert.match(await cardText(page, ".err-t"), /Скачиваю языковой пакет для перевода с английского/);
  assert.equal(await page.locator(`${CARD} .err svg`).count(), 0, "без значка ошибки");
  assert.equal(api.calls.length, 0, "в бесплатном режиме нет запросов к OpenAI");
  await shot(page, "12-free-downloading-light");
  await page.close();
});

test("бесплатный режим на странице без https: понятное объяснение, без запросов", async () => {
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

test("настройки: бесплатный режим скрывает всё про OpenAI, выбор OpenAI показывает ключ", async () => {
  await setSettings({ provider: "builtin", apiKey: "", privacyConsentVersion: 0 });
  const page = await context.newPage();
  await page.setViewportSize({ width: 760, height: 1100 });
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  await page.locator('input[value="builtin"]:checked').waitFor();
  assert.equal(await page.locator("#openaiSettings").isVisible(), false);
  await shot(page, "13-options-free-light");

  await page.locator('input[value="openai"]').check();
  await page.locator("#apiKey").waitFor();
  assert.equal(await page.locator("#openaiSettings").isVisible(), true);
  await page.waitForTimeout(100);
  assert.equal((await settings()).provider, "openai");
  await page.close();
});
