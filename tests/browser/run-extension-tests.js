const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const evidenceDirectory = path.join(root, "dist", "browser-evidence");
const startedAt = Date.now();
const results = [];
const consoleErrors = [];
const evidenceWarnings = [];
const providerRequests = [];

const fixture = `<!doctype html>
<html><body>
  <p id="paragraph">This ordinary paragraph contains enough foreign words to exercise streaming translation in the extension card today.</p>
  <p id="russian">Это полностью русский текст без иностранных слов</p>
  <div id="nested"><span>The selected </span><span><strong>bank</strong></span><span> is beside the river in this nested interface.</span></div>
  <input id="input" type="text" value="Input selection text">
  <textarea id="textarea">Textarea selection text</textarea>
  <input id="password" type="password" value="secret password">
  <div id="editable" contenteditable="true">Editable foreign sentence</div>
  <div id="shadow"></div>
  <iframe src="/frame.html"></iframe>
  <script>
    const root = document.getElementById("shadow").attachShadow({mode:"open"});
    root.innerHTML = "<p id='shadowText'>Open shadow foreign sentence</p>";
  </script>
</body></html>`;

function startServer() {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(
      request.url === "/frame.html"
        ? "<!doctype html><p id='frameText'>Same origin frame foreign sentence</p>"
        : fixture
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, url: `http://127.0.0.1:${server.address().port}/` });
    });
  });
}

function recordError(source, error) {
  consoleErrors.push(`${source}: ${error?.message || error}`);
}

async function check(name, action) {
  const start = Date.now();
  try {
    await action();
    results.push({ name, status: "passed", durationMs: Date.now() - start });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({
      name,
      status: "failed",
      durationMs: Date.now() - start,
      error: error?.stack || String(error)
    });
    console.error(`FAIL ${name}: ${error?.stack || error}`);
  }
}

async function captureEvidence(subject, filename) {
  const destination = path.join(evidenceDirectory, filename);
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await subject.screenshot({ path: destination });
      return true;
    } catch (error) {
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const warning = `${filename}: ${error?.message || error}`;
      evidenceWarnings.push(warning);
      console.warn(`WARN screenshot evidence unavailable: ${warning}`);
    }
  }
  return false;
}

async function selectText(page, selector, value) {
  await page.evaluate(
    ({ selector, value }) => {
      const element = document.querySelector(selector);
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && !node.nodeValue.includes(value)) {}
      if (!node) throw new Error(`Text not found: ${value}`);
      const offset = node.nodeValue.indexOf(value);
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + value.length);
      const selection = document.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    },
    { selector, value }
  );
}

async function selectFormText(page, selector, start, end) {
  await page.locator(selector).evaluate(
    (element, selection) => {
      element.focus();
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      element.setSelectionRange(selection.start, selection.end);
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    },
    { start, end }
  );
}

async function setSelectionMode(optionsPage, page, mode, stableDelayMs = 250) {
  const response = await optionsPage.evaluate(
    async ({ mode, stableDelayMs }) =>
      chrome.runtime.sendMessage({
        type: "settings.public.patch",
        patch: {
          selection: { mode, stableDelayMs, requiredModifier: "none" }
        }
      }),
    { mode, stableDelayMs }
  );
  assert.equal(response.ok, true);
  await page.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
  await page.waitForTimeout(50);
}

(async () => {
  fs.mkdirSync(evidenceDirectory, { recursive: true });
  const { server, url } = await startServer();
  const userDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "sensemark-browser-"));
  let context;
  try {
    const launchOptions = {
      headless: false,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    };
    if (process.env.SENSEMARK_CHROME_EXECUTABLE) {
      launchOptions.executablePath = process.env.SENSEMARK_CHROME_EXECUTABLE;
    }
    context = await chromium.launchPersistentContext(userDataDirectory, launchOptions);
    context.on("page", (page) => {
      page.on("pageerror", (error) => recordError(`page ${page.url()}`, error));
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(`page ${page.url()}: ${message.text()}`);
      });
    });

    await context.route("https://api.openai.com/**", async (route) => {
      const request = route.request();
      if (request.method() !== "POST") {
        await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
        return;
      }
      const body = JSON.parse(request.postData() || "{}");
      const userPayload = JSON.parse(body.messages?.[1]?.content || "{}");
      providerRequests.push({ text: userPayload.text, body });
      if (userPayload.text.includes("slow request")) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      if (body.stream) {
        const translated = userPayload.text.includes("ordinary paragraph")
          ? "Потоковый тестовый перевод обычного абзаца."
          : `Тестовый перевод: ${userPayload.text}`;
        const middle = Math.ceil(translated.length / 2);
        const stream = [
          `data: ${JSON.stringify({ choices: [{ delta: { content: translated.slice(0, middle) } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: { content: translated.slice(middle) }, finish_reason: "stop" }] })}\n\n`,
          "data: [DONE]\n\n"
        ].join("");
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: stream });
        return;
      }
      const schema = body.response_format?.json_schema?.schema;
      const value = schema?.properties?.sections
        ? {
            kind: "multilingual",
            text: `Тестовый перевод: ${userPayload.text}`,
            sections: [
              { script: "Latin", source: userPayload.text, translation: "Тестовый перевод" }
            ]
          }
        : {
            kind: "translation",
            translation: `Тестовый перевод: ${userPayload.text}`,
            alternatives: [],
            category: "",
            explanation: ""
          };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(value) } }]
        })
      });
    });

    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
    worker.on("close", () => consoleErrors.push("service worker closed during smoke suite"));
    const extensionId = new URL(worker.url()).host;
    const chromeVersion = await worker.evaluate(() => navigator.userAgent);
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options/options.html`);
    const settingsResponse = await optionsPage.evaluate(async () =>
      chrome.runtime.sendMessage({
        type: "settings.private.patch",
        patch: {
          providers: { openai: { apiKey: "browser-test-only", model: "gpt-4o-mini" } },
          privacyConsentVersion: 2,
          selection: { mode: "manual", stableDelayMs: 250, requiredModifier: "none" }
        }
      })
    );
    assert.equal(settingsResponse.ok, true);

    const page = await context.newPage();
    await page.goto(url);
    await page.waitForSelector("sensemark-translation", {
      state: "attached",
      timeout: 10000
    });

    async function sendSelection(text) {
      await page.bringToFront();
      return optionsPage.evaluate(async (text) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return chrome.tabs.sendMessage(
          tab.id,
          { type: "selection.translate", text },
          { frameId: 0 }
        );
      }, text);
    }

    async function closeCard() {
      await page.bringToFront();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(50);
    }

    await check("unpacked extension and service worker load", async () => {
      assert.match(worker.url(), /^chrome-extension:/);
      assert.match(chromeVersion, /Chrome|Chromium/);
      const manifest = await optionsPage.evaluate(() => chrome.runtime.getManifest());
      assert.equal(manifest.version, "1.4.2");
    });

    await check("options and popup pages open", async () => {
      assert.equal(await optionsPage.locator("#model").count(), 1);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/popup.html`);
      assert.equal(await popup.locator("#translate").count(), 1);
      await captureEvidence(popup, "popup.png");
      await popup.close();
    });

    await check("content script injects into top frame, iframe, and open Shadow DOM page", async () => {
      assert.equal(await page.locator("sensemark-translation").count(), 1);
      const child = page.frames().find((frame) => frame !== page.mainFrame());
      await child.waitForSelector("sensemark-translation", { state: "attached" });
      assert.equal(await child.locator("sensemark-translation").count(), 1);
      assert.equal(
        await page.evaluate(() => document.querySelector("#shadow").shadowRoot.mode),
        "open"
      );
    });

    await check("ordinary selection streams into a visible card", async () => {
      const text = await page.locator("#paragraph").textContent();
      await selectText(page, "#paragraph", text);
      assert.equal((await sendSelection(text)).status, "accepted");
      const card = page.locator("sensemark-translation .card.visible");
      await card.waitFor();
      await page.waitForFunction(() =>
        document
          .querySelector("sensemark-translation")
          .shadowRoot.querySelector(".translation")
          .textContent.includes("Потоковый")
      );
      await captureEvidence(card, "streaming-card.png");
    });

    await check("card drag and Escape work", async () => {
      const card = page.locator("sensemark-translation .card.visible");
      const header = page.locator("sensemark-translation .header");
      const before = await card.boundingBox();
      const box = await header.boundingBox();
      await page.mouse.move(box.x + 20, box.y + 15);
      await page.mouse.down();
      await page.mouse.move(box.x + 80, box.y + 55, { steps: 4 });
      await page.mouse.up();
      const after = await card.boundingBox();
      assert.ok(Math.abs(after.x - before.x) > 10 || Math.abs(after.y - before.y) > 10);

      const grip = page.locator("sensemark-translation .grip");
      const sizeBefore = await card.boundingBox();
      const gripBox = await grip.boundingBox();
      await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(gripBox.x + 45, gripBox.y + 35, { steps: 4 });
      await page.mouse.up();
      const sizeAfter = await card.boundingBox();
      assert.ok(sizeAfter.width > sizeBefore.width || sizeAfter.height > sizeBefore.height);

      const scaleBefore = await page.evaluate(() =>
        getComputedStyle(document.querySelector("sensemark-translation"))
          .getPropertyValue("--sm-scale")
          .trim()
      );
      await header.dispatchEvent("wheel", { deltaY: -100, ctrlKey: true });
      const scaleAfter = await page.evaluate(() =>
        getComputedStyle(document.querySelector("sensemark-translation"))
          .getPropertyValue("--sm-scale")
          .trim()
      );
      assert.notEqual(scaleAfter, scaleBefore);
      await closeCard();
      assert.equal(await page.locator("sensemark-translation .card.visible").count(), 0);
    });

    await check("nested div/span context reaches one structured request", async () => {
      await selectText(page, "#nested", "bank");
      const before = providerRequests.length;
      assert.equal((await sendSelection("bank")).status, "accepted");
      await page.waitForFunction(() =>
        document
          .querySelector("sensemark-translation")
          .shadowRoot.querySelector(".translation")
          .textContent.includes("bank")
      );
      assert.equal(providerRequests.length, before + 1);
      const payload = JSON.parse(providerRequests.at(-1).body.messages[1].content);
      assert.match(payload.context, /river/);
      await closeCard();
    });

    await check("open Shadow DOM selection reaches the provider", async () => {
      const text = "Open shadow foreign sentence";
      await page.evaluate((value) => {
        const element = document.querySelector("#shadow").shadowRoot.querySelector("#shadowText");
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = document.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        element.dispatchEvent(
          new PointerEvent("pointerdown", { bubbles: true, composed: true })
        );
        element.dispatchEvent(
          new PointerEvent("pointerup", { bubbles: true, composed: true })
        );
        if (!selection.toString().includes(value)) throw new Error("Shadow selection failed");
      }, text);
      const before = providerRequests.length;
      assert.equal((await sendSelection(text)).status, "accepted");
      await page.locator("sensemark-translation .card.visible").waitFor();
      assert.equal(providerRequests.length, before + 1);
      await closeCard();
    });

    await check("button selection mode exposes intent before translating", async () => {
      await setSelectionMode(optionsPage, page, "button");
      const before = providerRequests.length;
      await selectText(page, "#paragraph", "enough foreign words");
      const trigger = page.locator("sensemark-translation .trigger.visible");
      await trigger.waitFor();
      assert.equal(providerRequests.length, before);
      await trigger.click();
      await page.locator("sensemark-translation .card.visible").waitFor();
      assert.equal(providerRequests.length, before + 1);
      await closeCard();
    });

    await check("automatic mode translates a stable selection", async () => {
      await setSelectionMode(optionsPage, page, "automatic");
      const before = providerRequests.length;
      await selectText(page, "#paragraph", "streaming translation");
      await page.locator("sensemark-translation .card.visible").waitFor();
      assert.equal(providerRequests.length, before + 1);
      await closeCard();
    });

    await check("copy suppresses pending automatic translation", async () => {
      await setSelectionMode(optionsPage, page, "automatic", 350);
      const before = providerRequests.length;
      await selectText(page, "#paragraph", "extension card today");
      await page.evaluate(() => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true })
        );
        document.dispatchEvent(new Event("copy", { bubbles: true }));
      });
      await page.waitForTimeout(450);
      assert.equal(providerRequests.length, before);
      assert.equal(await page.locator("sensemark-translation .card.visible").count(), 0);
    });

    await check("same-origin iframe selection translates in its own frame", async () => {
      await setSelectionMode(optionsPage, page, "automatic");
      const child = page.frames().find((frame) => frame !== page.mainFrame());
      await child.evaluate(() => globalThis.dispatchEvent(new Event("focus")));
      const before = providerRequests.length;
      await selectText(child, "#frameText", "Same origin frame foreign sentence");
      await child.locator("sensemark-translation .card.visible").waitFor();
      assert.equal(providerRequests.length, before + 1);
      await child.evaluate(() =>
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      );
      await setSelectionMode(optionsPage, page, "manual");
    });

    await check("replacement request cancels stale card output", async () => {
      const before = providerRequests.length;
      assert.equal((await sendSelection("slow request foreign text")).status, "accepted");
      await page.waitForTimeout(50);
      assert.equal((await sendSelection("fresh request foreign text")).status, "accepted");
      await page.waitForFunction(() =>
        document
          .querySelector("sensemark-translation")
          .shadowRoot.querySelector(".translation")
          .textContent.includes("fresh request")
      );
      await page.waitForTimeout(550);
      const visibleText = await page.locator("sensemark-translation .translation").textContent();
      assert.match(visibleText, /fresh request/);
      assert.doesNotMatch(visibleText, /slow request/);
      assert.equal(providerRequests.length, before + 2);
      await closeCard();
    });

    for (const [name, selector, text] of [
      ["input selection", "#input", "Input selection text"],
      ["textarea selection", "#textarea", "Textarea selection text"],
      ["contenteditable selection", "#editable", "Editable foreign sentence"]
    ]) {
      await check(name, async () => {
        await page.locator(selector).focus();
        if (selector !== "#editable") {
          await selectFormText(page, selector, 0, text.length);
        } else {
          await selectText(page, selector, text);
        }
        assert.equal((await sendSelection(text)).status, "accepted");
        await page.locator("sensemark-translation .card.visible").waitFor();
        await closeCard();
      });
    }

    await check("password selection is rejected without provider request", async () => {
      await selectFormText(page, "#password", 0, 6);
      const before = providerRequests.length;
      const response = await sendSelection("secret");
      assert.deepEqual(response, { status: "unsupported", reason: "password-field" });
      assert.equal(providerRequests.length, before);
    });

    await check("reliable Russian selection is skipped locally", async () => {
      const text = await page.locator("#russian").textContent();
      await selectText(page, "#russian", text);
      const before = providerRequests.length;
      const response = await sendSelection(text);
      assert.equal(response.status, "skipped-russian");
      assert.equal(providerRequests.length, before);
    });

    await check("duplicate request is suppressed and later cache hit avoids provider", async () => {
      await selectText(page, "#nested", "bank");
      const first = await sendSelection("bank");
      assert.equal(first.status, "accepted");
      const immediate = await sendSelection("bank");
      assert.equal(immediate.status, "duplicate");
      const count = providerRequests.length;
      await page.waitForTimeout(1600);
      const cached = await sendSelection("bank");
      assert.equal(cached.status, "accepted");
      await page.waitForTimeout(100);
      assert.equal(providerRequests.length, count);
      await closeCard();
    });

    const passed = results.filter((result) => result.status === "passed").length;
    const failed = results.filter((result) => result.status === "failed").length;
    const report = {
      status: failed ? "failed" : "passed",
      browser: chromeVersion,
      operatingSystem: `${os.platform()} ${os.release()}`,
      extensionId,
      extensionPath: root,
      scenarios: results,
      providerRequestCount: providerRequests.length,
      consoleErrors,
      evidenceWarnings,
      durationMs: Date.now() - startedAt
    };
    fs.mkdirSync(path.join(root, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "dist", "browser-results.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(`Browser tests: passed ${passed}, failed ${failed}, skipped 0`);
    console.log(`Duration: ${report.durationMs}ms`);
    console.log(`Console errors: ${consoleErrors.length}`);
    console.log(`Evidence warnings: ${evidenceWarnings.length}`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    server.close();
    fs.rmSync(userDataDirectory, { recursive: true, force: true });
  }
})();
