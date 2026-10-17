const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function eventHub() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      return listeners.map((listener) => listener(...args));
    },
    listeners
  };
}

function loadBackground(overrides = {}) {
  const settings = {
    apiKey: "test-key",
    model: "gpt-4o-mini",
    targetLang: "русский",
    autoTranslate: false,
    privacyConsentVersion: 1,
    ...overrides.settings
  };
  const events = {
    command: eventHub(),
    connect: eventHub(),
    contextClick: eventHub(),
    installed: eventHub(),
    message: eventHub()
  };
  const state = {
    executedScripts: [],
    menuItems: [],
    menuUpdates: [],
    optionsOpened: 0,
    sentMessages: [],
    storageWrites: []
  };
  let sendMessage = overrides.sendMessage || (async () => ({}));
  // A shared browser "session": survives a service worker restart in tests.
  const sessionStore = overrides.sessionStore || {};

  const context = {
    AbortController,
    TextDecoder,
    TextEncoder,
    clearTimeout,
    setTimeout,
    fetch: overrides.fetch,
    chrome: {
      runtime: {
        onInstalled: events.installed,
        onMessage: events.message,
        onConnect: events.connect,
        openOptionsPage() {
          state.optionsOpened++;
        },
        // Safari only: the bridge to the Sensemark app.
        ...(overrides.sendNativeMessage ? { sendNativeMessage: overrides.sendNativeMessage } : {})
      },
      contextMenus: {
        onClicked: events.contextClick,
        removeAll(callback) {
          callback?.();
        },
        create(item) {
          state.menuItems.push(item);
        },
        update(id, changes, callback) {
          state.menuUpdates.push({ id, ...changes });
          callback?.();
        }
      },
      action: {},
      commands: { onCommand: events.command },
      storage: {
        local: {
          async get(defaults = {}) {
            return { ...defaults, ...settings };
          },
          async set(value) {
            Object.assign(settings, value);
            state.storageWrites.push(value);
          }
        },
        onChanged: eventHub(),
        session: {
          async get(key) {
            return key in sessionStore ? { [key]: sessionStore[key] } : {};
          },
          async set(value) {
            Object.assign(sessionStore, JSON.parse(JSON.stringify(value)));
          }
        }
      },
      tabs: {
        async sendMessage(...args) {
          state.sentMessages.push(args);
          return sendMessage(...args);
        }
      },
      scripting: {
        async executeScript(details) {
          state.executedScripts.push(details);
        }
      }
    }
  };
  context.globalThis = context;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "src", "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  context.__events = events;
  context.__settings = settings;
  context.__state = state;
  context.__setSendMessage = (handler) => {
    sendMessage = handler;
  };
  return context;
}

module.exports = { eventHub, loadBackground };
