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
    toJSON() {
      return this;
    }
  };

  window.Range.prototype.getBoundingClientRect = () => rectangle;
  window.Range.prototype.getClientRects = () => [rectangle];
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.tagName === "IMG") return { ...rectangle, width: 80, height: 40 };
    return rectangle;
  };

  window.chrome = {
    i18n: {
      async detectLanguage(text) {
        return {
          isReliable: true,
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
      async sendMessage() {}
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

  return { document: window.document, dom, ports, select, translateSelection, window };
}

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
