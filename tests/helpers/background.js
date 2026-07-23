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
    optionsOpened: 0,
    sentMessages: [],
    storageWrites: []
  };
  let sendMessage = overrides.sendMessage || (async () => ({}));

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
        }
      },
      contextMenus: {
        onClicked: events.contextClick,
        removeAll(callback) {
          callback?.();
        },
        create(item) {
          state.menuItems.push(item);
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
  const source = fs.readFileSync(path.join(__dirname, "..", "..", "background.js"), "utf8");
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
