const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

function eventHub() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    }
  };
}

function createPort() {
  const onMessage = eventHub();
  const onDisconnect = eventHub();
  return {
    disconnected: false,
    onDisconnect,
    onMessage,
    posted: [],
    disconnect() {
      if (this.disconnected) return;
      this.disconnected = true;
      onDisconnect.emit();
    },
    postMessage(message) {
      this.posted.push(message);
    },
    serverMessage(message) {
      onMessage.emit(message);
    }
  };
}

async function setupContent(markup, options = {}) {
  const dom = new JSDOM(markup, {
    pretendToBeVisual: true,
    runScripts: "outside-only",
    url: "https://page.test/article"
  });
  const { window } = dom;
  const runtimeMessages = eventHub();
  const ports = [];
  const rectangle = {
    bottom: 130,
    height: 24,
    left: 40,
    right: 260,
    top: 106,
    width: 220,
    x: 40,
    y: 106,
    ...options.rect,
    toJSON() {
      return this;
    }
  };
  const sentMessages = [];

  window.Range.prototype.getBoundingClientRect = () => rectangle;
  window.Range.prototype.getClientRects = () => [rectangle];
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.tagName === "IMG") return { ...rectangle, width: 80, height: 40 };
    return rectangle;
  };

  window.chrome = {
    i18n: {
      async detectLanguage(text) {
        // Как настоящий CLD: одно слово «bank» он путает с себуано.
        if (text.trim() === "bank") {
          return { isReliable: false, languages: [{ language: "ceb", percentage: 100 }] };
        }
        return {
          // Настоящий CLD считает «ненадёжным» и верный ответ на короткой фразе.
          isReliable: text.length > 60,
          languages: [
            {
              language: /^[А-Яа-яЁё\s.,!?—-]+$/u.test(text) ? "ru" : "en",
              percentage: 100
            }
          ]
        };
      }
    },
    runtime: {
      onMessage: runtimeMessages,
      connect() {
        const port = createPort();
        ports.push(port);
        return port;
      },
      async sendMessage(message) {
        sentMessages.push(message);
        return { ok: false, faces: [] };
      }
    },
    storage: {
      local: {
        async get(defaults) {
          return { ...defaults, autoTranslate: false, provider: "openai", ...options.settings };
        },
        async set() {}
      },
      onChanged: eventHub()
    }
  };

  if (options.Translator) window.Translator = options.Translator;
  const context = dom.getInternalVMContext();
  for (const file of [
    "language-detection.js",
    "selection-text.js",
    "word-response.js",
    "text-response.js",
    "ui-scale.js",
    "builtin-translator.js",
    "card-theme.js",
    "content.js"
  ]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    vm.runInContext(source, context, { filename: file });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  function select(element) {
    const selection = window.getSelection();
    const range = window.document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  async function translateSelection() {
    runtimeMessages.emit({ type: "translate-selection" }, null, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return { document: window.document, dom, ports, select, sentMessages, translateSelection, window };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const STATUS_HOST = "__sensemark_status_host__";
const CARD_HOST = "__gpt_translate_popup_host__";

test("content script makes no API request and leaves no card for Russian text", async () => {
  const context = await setupContent('<p id="russian">Этот текст уже на русском языке.</p>');
  context.select(context.document.getElementById("russian"));
  await context.translateSelection();

  assert.equal(context.ports.length, 0);
  assert.equal(context.document.getElementById("__gpt_translate_popup_host__"), null);
});

test("content card appears only after visible streamed translation", async () => {
  const context = await setupContent('<p id="english">Why</p>');
  context.select(context.document.getElementById("english"));
  await context.translateSelection();

  assert.equal(context.ports.length, 1);
  assert.equal(context.document.getElementById("__gpt_translate_popup_host__"), null);

  const port = context.ports[0];
  assert.equal(port.posted[0].wordMode, true);
  port.serverMessage({ type: "chunk", text: "[[translation]]\n" });
  assert.equal(context.document.getElementById("__gpt_translate_popup_host__"), null);

  port.serverMessage({ type: "chunk", text: "[[translation]]\nпо" });
  const host = context.document.getElementById("__gpt_translate_popup_host__");
  assert.ok(host);
  assert.equal(host.shadowRoot.querySelector(".live").textContent, "по");
});

test("content card renders multilingual sections and copy-ready completion", async () => {
  const context = await setupContent('<p id="mixed">Hello مرحبا</p>');
  context.select(context.document.getElementById("mixed"));
  await context.translateSelection();
  context.ports[0].serverMessage({
    type: "done",
    text:
      "[[multilingual]]\n" +
      "[[script:Latin|lang:английский]]\nПривет.\n" +
      "[[script:Arabic|lang:арабский]]\nДобро пожаловать."
  });

  const host = context.document.getElementById("__gpt_translate_popup_host__");
  assert.equal(host.shadowRoot.querySelector(".badge").textContent, "Несколько языков");
  assert.deepEqual(
    [...host.shadowRoot.querySelectorAll(".segment-lang")].map((item) => item.textContent),
    ["английский → русский", "арабский → русский"]
  );
  assert.equal(host.shadowRoot.querySelector(".acts").classList.contains("pending"), false);
});

test("content scale rate limit is wired to the visible card", async () => {
  const context = await setupContent('<p id="english">Why</p>');
  context.select(context.document.getElementById("english"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[translation]]\nпочему" });

  const host = context.document.getElementById("__gpt_translate_popup_host__");
  const card = host.shadowRoot.querySelector(".card");
  for (let index = 0; index < 20; index++) {
    card.dispatchEvent(
      new context.window.WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -12
      })
    );
  }
  assert.equal(host.shadowRoot.querySelector(".zoom").textContent, "102%");
});

test("image-only selections are stopped locally without spending tokens", async () => {
  const context = await setupContent(
    '<div id="image"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==" alt="Подпись"><span>Подпись</span></div>'
  );
  context.select(context.document.getElementById("image"));
  await context.translateSelection();

  assert.equal(context.ports.length, 0);
  const host = context.document.getElementById("__gpt_translate_popup_host__");
  assert.match(host.shadowRoot.querySelector(".err-t").textContent, /изображение/);
});

test("links inside a paragraph stay in the translated text", async () => {
  const context = await setupContent(
    '<p id="x">Paris is the capital of <a href="#">France</a>, home to <a href="#">2.1 million</a> people.</p>'
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();

  assert.equal(
    context.ports[0].posted[0].text,
    "Paris is the capital of France, home to 2.1 million people."
  );
});

test("inline formatting does not split words and paragraphs are kept", async () => {
  const context = await setupContent(
    '<div id="x"><p>This is un<em>believ</em>able.</p><p>Second<br>line.</p></div>'
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();

  assert.equal(context.ports[0].posted[0].text, "This is unbelievable.\nSecond\nline.");
});

test("whole-page selection keeps the article and drops site noise", async () => {
  const context = await setupContent(`<div id="x">
    <header><nav><a href="/">Home</a> | <a href="/news">News</a></nav><button>Sign in</button></header>
    <main><article>
      <header><h1>City council approves new park</h1></header>
      <p>The council voted<sup><a href="#n1">[1]</a></sup> to build a park near the <a href="/r">river</a>.</p>
      <p>Area is 5 km<sup>2</sup>.</p>
      <div><button> Share</button> <span role="button">12 comments</span></div>
    </article></main>
    <aside><a href="#">Trending celebrity news</a></aside>
    <footer>Daily News · <a href="#">Privacy</a></footer>
  </div>`);
  context.select(context.document.getElementById("x"));
  await context.translateSelection();

  assert.equal(
    context.ports[0].posted[0].text,
    "City council approves new park\n" +
      "The council voted to build a park near the river.\n" +
      "Area is 5 km2."
  );
});

test("a selected menu item alone is still translated", async () => {
  const context = await setupContent('<nav><a id="x" href="#">Download the report</a></nav>');
  context.select(context.document.getElementById("x"));
  await context.translateSelection();

  assert.equal(context.ports[0].posted[0].text, "Download the report");
});

function fakeChromeTranslator({ needsGesture = false } = {}) {
  const state = { gesture: !needsGesture };
  return {
    state,
    async availability() {
      return "available";
    },
    async create({ sourceLanguage }) {
      if (!state.gesture) {
        const error = new Error("Requires a user gesture");
        error.name = "NotAllowedError";
        throw error;
      }
      return {
        async translate(text) {
          return `RU[${sourceLanguage}] ${text}`;
        }
      };
    }
  };
}

test("free mode translates on the device: card appears, nothing goes to OpenAI", async () => {
  const context = await setupContent('<p id="x">The weather is nice today, let us go out.</p>', {
    settings: { provider: "builtin" },
    Translator: fakeChromeTranslator()
  });
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(context.ports.length, 0, "к OpenAI ничего не отправлено");
  const host = context.document.getElementById("__gpt_translate_popup_host__");
  assert.equal(
    host.shadowRoot.querySelector(".live").textContent,
    "RU[en] The weather is nice today, let us go out."
  );
});

test("free mode: a missing language pack is downloaded by one click on the card", async () => {
  const Translator = fakeChromeTranslator({ needsGesture: true });
  const context = await setupContent('<p id="x">The weather is nice today, let us go out.</p>', {
    settings: { provider: "builtin" },
    Translator
  });
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  await new Promise((resolve) => setTimeout(resolve, 20));

  const host = context.document.getElementById("__gpt_translate_popup_host__");
  assert.match(host.shadowRoot.querySelector(".err-t").textContent, /скачать языковой пакет для перевода с английского/);
  const button = host.shadowRoot.querySelector("[data-act=options]");
  assert.equal(button.textContent, "Скачать");

  Translator.state.gesture = true; // клик — это жест пользователя
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const card = context.document.getElementById("__gpt_translate_popup_host__");
  assert.equal(
    card.shadowRoot.querySelector(".live").textContent,
    "RU[en] The weather is nice today, let us go out."
  );
});

// ---------- «Хамелеон»: пилюля статуса, место и цвет карточки ----------

test("while waiting: a small pill, then a circle, and no empty card", async () => {
  const context = await setupContent('<p id="x">Paris is the capital and largest city of France.</p>');
  context.select(context.document.getElementById("x"));
  await context.translateSelection();

  assert.equal(context.document.getElementById(STATUS_HOST), null, "быстрый ответ — без пилюли");
  await wait(260);
  const pillHost = context.document.getElementById(STATUS_HOST);
  assert.ok(pillHost, "ответа нет дольше 200 мс — пилюля появилась");
  const pill = pillHost.shadowRoot.querySelector(".status");
  assert.equal(pill.querySelector(".lbl").textContent, "Перевожу с английского…");
  assert.equal(pill.classList.contains("mini"), false);
  assert.equal(context.document.getElementById(CARD_HOST), null, "пустой карточки нет");

  await wait(1250);
  assert.equal(pill.classList.contains("mini"), true, "через секунду — кружок");

  context.ports[0].serverMessage({ type: "chunk", text: "[[text]]\nПариж — столица" });
  const card = context.document.getElementById(CARD_HOST);
  assert.ok(card);
  assert.equal(card.shadowRoot.querySelector(".badge").textContent, "Перевод · с английского");
  await wait(200);
  assert.equal(context.document.getElementById(STATUS_HOST), null, "кружок уступил место карточке");
});

test("a single word gets its source language from the sentence, not a wrong guess", async () => {
  const context = await setupContent('<p>I went to the <span id="w">bank</span> yesterday to deposit a check.</p>');
  context.select(context.document.getElementById("w"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[translation]]\nбанк\nдругие значения: берег, вал" });

  const badge = context.document.getElementById(CARD_HOST).shadowRoot.querySelector(".badge");
  assert.equal(badge.textContent, "Перевод · с английского");
});

test("an unreliable language guess is not shown at all", async () => {
  const context = await setupContent('<p id="w">bank</p>');
  context.select(context.document.getElementById("w"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[translation]]\nбанк" });

  const badge = context.document.getElementById(CARD_HOST).shadowRoot.querySelector(".badge");
  assert.equal(badge.textContent, "Перевод");
});

test("Esc while the pill is waiting cancels the request and removes the pill", async () => {
  const context = await setupContent('<p id="x">Paris is the capital and largest city of France.</p>');
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  await wait(260);
  assert.ok(context.document.getElementById(STATUS_HOST));

  context.document.dispatchEvent(new context.window.KeyboardEvent("keydown", { key: "Escape" }));
  await wait(200);
  assert.equal(context.document.getElementById(STATUS_HOST), null);
  assert.equal(context.ports[0].disconnected, true, "запрос оборван — токены не тратятся");
});

test("free mode: language pack download shows the language and real progress", async () => {
  let finish;
  const Translator = {
    async availability() {
      return "downloadable";
    },
    create({ sourceLanguage, monitor }) {
      monitor?.({ addEventListener: (_name, listener) => listener({ loaded: 0.42 }) });
      return new Promise((resolve) => {
        finish = () => resolve({ translate: async (text) => `RU[${sourceLanguage}] ${text}` });
      });
    }
  };
  const context = await setupContent('<p id="x">The weather is nice today, let us go out.</p>', {
    settings: { provider: "builtin" },
    Translator
  });
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  await wait(20);

  const pill = context.document.getElementById(STATUS_HOST).shadowRoot.querySelector(".status");
  assert.equal(pill.querySelector(".lbl").textContent, "Скачиваю английский · 42%");
  assert.equal(pill.classList.contains("determinate"), true);
  assert.equal(pill.style.getPropertyValue("--progress"), "42");
  assert.match(pill.title, /один раз/, "полное объяснение — во всплывающей подсказке");

  finish();
  await wait(30);
  assert.ok(context.document.getElementById(CARD_HOST));
});

test("a short paragraph stays a card under the selection", async () => {
  const context = await setupContent('<p id="x">Paris is the capital and largest city of France.</p>');
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж — столица Франции." });

  const card = context.document.getElementById(CARD_HOST).shadowRoot.querySelector(".card");
  assert.equal(card.classList.contains("anchor"), true);
  assert.equal(card.classList.contains("margin"), false);
});

test("several paragraphs go to the margin on the right, with a bracket along the text", async () => {
  const context = await setupContent(
    '<div id="x"><p>Paris is the capital and largest city of France.</p><p>The bakery on the corner opens at seven every morning.</p><p>Most tourists come later in the day.</p></div>'
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж.\nПекарня.\nТуристы." });

  const root = context.document.getElementById(CARD_HOST).shadowRoot;
  const card = root.querySelector(".card");
  assert.equal(card.classList.contains("margin"), true);
  assert.equal(card.style.width, "400px");
  assert.equal(root.querySelector(".bracket").hidden, false);
  assert.equal(root.querySelector(".badge").textContent, "Перевод · 3 абзаца с английского");
  // Абзацы перевода разделены пустой строкой, чтобы не слипаться.
  assert.equal(root.querySelector(".tr .live").textContent, "Париж.\n\nПекарня.\n\nТуристы.");
  await wait(40);
  // Заметка справа от выделения (правый край 260 px + отступ под скобку).
  assert.equal(card.style.left, "288px");
});

test("a long selection with no room on the right opens a drawer at the window edge", async () => {
  const context = await setupContent(
    '<div id="x"><p>Paris is the capital and largest city of France.</p><p>The bakery on the corner opens at seven every morning and closes at noon.</p></div>',
    { rect: { left: 24, right: 1000, width: 976 } }
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж.\nПекарня." });

  const root = context.document.getElementById(CARD_HOST).shadowRoot;
  assert.equal(root.querySelector(".card").classList.contains("drawer"), true);
  assert.equal(root.querySelector(".bracket").hidden, true);
});

test("scrolling the page no longer closes the card", async () => {
  const context = await setupContent('<p id="x">Paris is the capital and largest city of France.</p>');
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж — столица Франции." });

  context.window.dispatchEvent(new context.window.Event("scroll"));
  context.document.dispatchEvent(new context.window.Event("scroll", { bubbles: true }));
  await wait(20);
  assert.ok(context.document.getElementById(CARD_HOST), "карточка осталась у текста");
  assert.equal(context.ports[0].disconnected, true, "ответ уже получен целиком");
});

test("the card takes the colors of a dark page", async () => {
  const context = await setupContent(
    '<body style="background-color: rgb(13, 17, 23); color: rgb(201, 209, 217)"><p id="x">Paris is the capital of France, they say.</p></body>'
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж — столица Франции." });

  const host = context.document.getElementById(CARD_HOST);
  assert.equal(host.shadowRoot.querySelector(".card").dataset.scheme, "dark");
  assert.notEqual(host.style.getPropertyValue("--surface"), "#ffffff");
});

test("manual light theme ignores a dark page; chosen font is loaded from the extension", async () => {
  const context = await setupContent(
    '<body style="background-color: rgb(13, 17, 23)"><p id="x" style="font-size: 18px">Paris is the capital of France, they say.</p></body>',
    { settings: { cardTheme: "light", cardFont: "literata" } }
  );
  context.select(context.document.getElementById("x"));
  await context.translateSelection();
  context.ports[0].serverMessage({ type: "done", text: "[[text]]\nПариж — столица Франции." });

  const host = context.document.getElementById(CARD_HOST);
  assert.equal(host.shadowRoot.querySelector(".card").dataset.scheme, "light");
  assert.equal(host.style.getPropertyValue("--surface"), "#ffffff");
  assert.match(host.style.getPropertyValue("--tr-font"), /Sensemark Literata/);
  assert.equal(host.style.getPropertyValue("--tr-size"), "18px", "размер как на странице");
  assert.deepEqual(JSON.parse(JSON.stringify(context.sentMessages)), [{ type: "get-font", font: "literata" }]);
});
