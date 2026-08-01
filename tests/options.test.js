const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const config = require("../shared/config.js");
const { createPrivateSettingsClient } = require("../extension/private-settings-client.js");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("options stay compact: no modifier control, automatic offered first", () => {
  const dom = new JSDOM(read("options/options.html"));
  const document = dom.window.document;
  assert.deepEqual(
    Array.from(document.querySelectorAll("#selectionMode option"), (option) => option.value),
    ["automatic", "button", "manual"]
  );
  for (const id of ["apiKey", "model", "consent", "stableDelay", "deleteKey", "test"]) {
    assert.ok(document.getElementById(id), `missing #${id}`);
  }
  // The required-modifier control is gone from the product entirely.
  assert.equal(document.getElementById("modifier"), null);
  assert.doesNotMatch(read("options/options.html"), /модификатор/i);
  assert.equal(document.querySelectorAll("script:not([src])").length, 0);
});

test("private settings client uses background messages, never direct local storage", async () => {
  const sent = [];
  const client = createPrivateSettingsClient({
    async sendMessage(message) {
      sent.push(message);
      if (message.type === config.MESSAGE.SETTINGS_TEST) return { ok: true, text: "Привет" };
      return { ok: true, settings: { schemaVersion: 3 } };
    }
  });
  assert.deepEqual(await client.get(), { schemaVersion: 3 });
  assert.deepEqual(await client.patch({ ui: { scale: 1.2 } }), { schemaVersion: 3 });
  assert.equal((await client.test()).text, "Привет");
  assert.deepEqual(
    sent.map((message) => message.type),
    [
      config.MESSAGE.PRIVATE_SETTINGS_GET,
      config.MESSAGE.PRIVATE_SETTINGS_PATCH,
      config.MESSAGE.SETTINGS_TEST
    ]
  );
  assert.doesNotMatch(read("options/options.js"), /chrome\.storage\.local/);
});

test("private settings client surfaces normalized background errors", async () => {
  const client = createPrivateSettingsClient({
    sendMessage: async () => ({ ok: false, error: { message: "forbidden" } })
  });
  await assert.rejects(client.get(), /forbidden/);
});
