importScripts(
  "../shared/config.js",
  "../shared/contracts.js",
  "../shared/errors.js",
  "../shared/settings-schema.js",
  "../shared/settings-service.js",
  "../shared/language-utils.js",
  "./sse-parser.js",
  "./request-client.js",
  "./provider-registry.js",
  "./translation-cache.js",
  "./request-coordinator.js",
  "./side-panel-state.js",
  "./side-panel-handoff.js",
  "./side-panel-configurator.js",
  "./selection-route.js",
  "./side-panel-controller.js",
  "./providers/openai-provider.js",
  "./translation-service.js"
);

const settingsService = SensemarkSettingsService.createSettingsService(chrome.storage.local);
const requestClient = SensemarkRequestClient.createRequestClient();
const openAiProvider = SensemarkOpenAiProvider.createOpenAiProvider({ requestClient });
const providerRegistry = SensemarkProviderRegistry.createProviderRegistry([openAiProvider]);
const translationCache = SensemarkTranslationCache.createTranslationCache(chrome.storage.session);
const languageDetector = SensemarkLanguageUtils.createChromeLanguageDetector(chrome.i18n);
const translationService = SensemarkTranslationService.createTranslationService({
  settingsService,
  providerRegistry,
  cache: translationCache,
  languageDetector
});
const coordinator = SensemarkRequestCoordinator.createRequestCoordinator();
const sidePanelState = SensemarkSidePanelState.createSidePanelState(chrome.storage.session);
const sidePanelHandoff = SensemarkSidePanelHandoff.createSidePanelHandoff({
  state: sidePanelState,
  bindingStore: chrome.storage.session,
  generation: () => sidePanelState.generation(),
  // Last-resort identity only, and only when the active tab actually owns a pending
  // request. Works without the "tabs" permission: only the tab id is read.
  async resolveActiveTab(windowId) {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    return tab?.id;
  }
});
const sidePanelConfigurator =
  SensemarkSidePanelConfigurator.createSidePanelConfigurator({
    sidePanel: chrome.sidePanel,
    tabs: chrome.tabs
  });
const sidePanelController = SensemarkSidePanelController.createSidePanelController({
  sidePanel: chrome.sidePanel,
  state: sidePanelState,
  handoff: sidePanelHandoff,
  // Read-only: the controller never configures, it only classifies failures.
  isTabConfigured: (tabId) => sidePanelConfigurator.isConfigured(tabId),
  detectLanguage: languageDetector
});

// Strict tab-specific panel model. Hydration starts during module initialisation,
// which is every service-worker start — runtime.onStartup only fires once per
// browser session, so a worker revived later would otherwise have no configured
// tabs and every request would be rejected until the user switched tabs.
const sidePanelConfigurationReady = sidePanelConfigurator
  .configureAll()
  .catch(() => ({ status: "failed", configured: 0 }));

// Deliberately never awaited on the user-action path: awaiting it before
// sidePanel.open() would drop Chrome's transient user activation. An early request
// on a not-yet-configured tab returns PANEL_NOT_CONFIGURED and the user retries.
void sidePanelConfigurationReady;

// Configuration happens ONLY on lifecycle events, so the context-menu path never
// races setOptions() against open().
chrome.tabs.onCreated.addListener((tab) => {
  if (Number.isInteger(tab?.id)) sidePanelConfigurator.configure(tab.id).catch(() => {});
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  sidePanelConfigurator.configure(tabId).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && changeInfo.status !== "loading") return;
  sidePanelConfigurator.configure(tabId).catch(() => {});
});

const CONTEXT_MENU_ID = "sensemark-translate-selection";

SensemarkSettingsService.restrictLocalStorageToTrustedContexts(chrome);

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: "Перевести выделенное",
      contexts: ["selection"]
    });
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  createContextMenu();
  await settingsService.getPrivate();
  await sidePanelConfigurator.configureAll();
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenu();
  SensemarkSettingsService.restrictLocalStorageToTrustedContexts(chrome);
  sidePanelConfigurator.configureAll().catch(() => {});
});

async function openSidePanel(tabId, value = {}) {
  const result = await sidePanelController.open(tabId, value);
  if (result.status === "open-failed") {
    console.warn("Sensemark could not open the side panel:", result.error);
  }
  return result;
}

async function deliverSelection(tabId, frameId, text) {
  if (!Number.isInteger(tabId) || !text) return { status: "no-selection" };
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: SensemarkConfig.MESSAGE.TRANSLATE_SELECTION, text },
      Number.isInteger(frameId) ? { frameId } : undefined
    );
    if (
      [
        "accepted",
        "skipped-russian",
        "unsupported",
        "no-selection",
        "duplicate"
      ].includes(response?.status)
    ) {
      return response;
    }
    return { status: "content-script-unavailable" };
  } catch {
    return { status: "content-script-unavailable" };
  }
}

/**
 * Tell the user a request could not be delivered, without a content script and
 * without asking for a notifications permission. Cleared on the next success.
 */
const RETRY_BADGE_MS = 10000;
let retryBadgeTimer = null;

function clearRetryHint() {
  if (retryBadgeTimer) {
    clearTimeout(retryBadgeTimer);
    retryBadgeTimer = null;
  }
  chrome.action?.setBadgeText?.({ text: "" });
  chrome.action?.setTitle?.({ title: "Sensemark — перевод на русский" });
}

function showRetryHint(message) {
  chrome.action?.setBadgeText?.({ text: "!" });
  chrome.action?.setBadgeBackgroundColor?.({ color: "#b3261e" });
  chrome.action?.setTitle?.({ title: `Sensemark: ${message}` });
  if (retryBadgeTimer) clearTimeout(retryBadgeTimer);
  retryBadgeTimer = setTimeout(clearRetryHint, RETRY_BADGE_MS);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = String(info.selectionText || "").trim();
  if (!text) return;
  const handoffValue = { text, frameId: info.frameId, windowId: tab?.windowId };

  // Synchronous routing decision. Contexts we can recognise from the URL open the
  // panel with no awaited work in front of open(), preserving user activation.
  const routing = SensemarkSelectionRoute.routeForSelection({ url: tab?.url });
  if (routing.route === SensemarkSelectionRoute.ROUTE.DIRECT_SIDE_PANEL) {
    clearRetryHint();
    const result = await openSidePanel(tab?.id, handoffValue);
    if (result.status === "not-configured") {
      // Hydration has not reached this tab yet. Nothing was created, so a retry is
      // clean. Configuration is a lifecycle concern only — the request path never
      // triggers it, so that a request can never race its own tab's setup.
      showRetryHint(result.message || "панель ещё готовится. Попробуйте ещё раз.");
    } else if (result.status === "open-failed") {
      showRetryHint("не удалось открыть панель. Попробуйте ещё раз.");
    }
    return;
  }

  const delivery = await deliverSelection(tab?.id, info.frameId, text);
  if (delivery.status === "unsupported" && delivery.reason === "password-field") return;

  if (
    delivery.status === "content-script-unavailable" ||
    delivery.status === "unsupported"
  ) {
    // Deliberately NOT falling back to sidePanel.open() here. This point is reached
    // only after an awaited tabs.sendMessage() round trip, and Chrome's transient
    // user activation may already have expired — the call would fail silently and
    // the user would see nothing at all. Ask for a fresh gesture instead.
    showRetryHint("не удалось прочитать выделение на этой странице. Повторите команду.");
    return;
  }
  clearRetryHint();
});

async function translateCurrentSelection(tab) {
  if (!Number.isInteger(tab?.id)) return { status: "invalid-tab" };
  try {
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => {
        const active = document.activeElement;
        const safeInputTypes = new Set(["text", "search", "url", "tel", "email"]);
        if (
          active &&
          active.tagName === "INPUT" &&
          String(active.type || "").toLowerCase() === "password"
        ) {
          return { status: "unsupported", reason: "password-field" };
        }
        if (
          active &&
          (active.tagName === "TEXTAREA" ||
            (active.tagName === "INPUT" &&
              safeInputTypes.has(String(active.type || "text").toLowerCase()))) &&
          Number.isInteger(active.selectionStart) &&
          active.selectionEnd > active.selectionStart
        ) {
          return {
            status: "selected",
            text: active.value.slice(active.selectionStart, active.selectionEnd).trim()
          };
        }
        const text = String(document.getSelection?.() || "").trim();
        return text ? { status: "selected", text } : { status: "no-selection" };
      }
    });
    const unsupported = frames.find((item) => item.result?.status === "unsupported");
    if (unsupported) return { ...unsupported.result, frameId: unsupported.frameId };
    const match = frames.find(
      (item) => item.result?.status === "selected" && item.result.text
    );
    if (!match) return { status: "no-selection" };
    return {
      status: "selected",
      frameId: match.frameId,
      text: match.result.text
    };
  } catch {
    return { status: "content-script-unavailable" };
  }
}

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "translate-selection") return;

  // Same routing rule as the context menu: a recognisable protected context opens the
  // panel straight away; an ordinary page must not be silently retried through the
  // panel after an awaited scripting round trip.
  const routing = SensemarkSelectionRoute.routeForSelection({ url: tab?.url });
  if (routing.route === SensemarkSelectionRoute.ROUTE.DIRECT_SIDE_PANEL) {
    clearRetryHint();
    await openSidePanel(tab?.id, { windowId: tab?.windowId });
    return;
  }

  const selected = await translateCurrentSelection(tab);
  if (selected.status === "unsupported") return;
  if (selected.status === "selected") {
    const delivery = await deliverSelection(tab?.id, selected.frameId, selected.text);
    if (delivery.status !== "content-script-unavailable") {
      clearRetryHint();
      return;
    }
  }
  showRetryHint("не удалось прочитать выделение на этой странице. Повторите команду.");
});

function trustedExtensionPage(sender) {
  const extensionRoot = chrome.runtime.getURL("");
  return String(sender?.url || "").startsWith(extensionRoot);
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case SensemarkConfig.MESSAGE.PUBLIC_SETTINGS_GET:
      return { ok: true, settings: await settingsService.getPublic() };
    case SensemarkConfig.MESSAGE.PUBLIC_SETTINGS_PATCH:
      return {
        ok: true,
        settings: SensemarkSettingsSchema.publicSettings(
          await settingsService.patchPublic(message.patch || {})
        )
      };
    case SensemarkConfig.MESSAGE.PRIVATE_SETTINGS_GET:
      if (!trustedExtensionPage(sender)) return { ok: false, error: "forbidden" };
      return { ok: true, settings: await settingsService.getPrivate() };
    case SensemarkConfig.MESSAGE.PRIVATE_SETTINGS_PATCH:
      if (!trustedExtensionPage(sender)) return { ok: false, error: "forbidden" };
      return {
        ok: true,
        settings: await settingsService.patchPrivate(message.patch || {})
      };
    case SensemarkConfig.MESSAGE.SETTINGS_TEST: {
      if (!trustedExtensionPage(sender)) return { ok: false, error: "forbidden" };
      try {
        const settings = await settingsService.getPrivate();
        const provider = providerRegistry.get(settings.activeProviderId);
        const validation = await provider.validateConfiguration(
          settings.providers[settings.activeProviderId]
        );
        return { ok: true, validation };
      } catch (error) {
        return { ok: false, error: SensemarkErrors.normalizeUnknownError(error).toJSON() };
      }
    }
    case SensemarkConfig.MESSAGE.SIDE_PANEL_PENDING_GET:
      if (!trustedExtensionPage(sender)) return { ok: false, error: "forbidden" };
      return {
        ok: true,
        pending: await sidePanelState.consume(message.identity)
      };
    case SensemarkConfig.MESSAGE.SIDE_PANEL_PENDING_CLEAR:
      if (!trustedExtensionPage(sender)) return { ok: false, error: "forbidden" };
      await sidePanelState.clear(message.identity);
      return { ok: true };
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: SensemarkErrors.normalizeUnknownError(error).toJSON()
      })
    );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  // A closed originating tab must not leave a claimable request behind.
  sidePanelState.clearTab(tabId).catch(() => {});
  sidePanelHandoff.forgetTab(tabId);
  sidePanelConfigurator.forget(tabId);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === SensemarkConfig.PORTS.SIDE_PANEL) {
    sidePanelHandoff.connect(port);
    return;
  }
  if (port.name !== SensemarkConfig.PORTS.TRANSLATION) return;
  const scope = {
    surface: port.sender?.tab ? "content" : "extension",
    tabId: port.sender?.tab?.id,
    frameId: port.sender?.frameId
  };
  let activeRequest = null;

  port.onMessage.addListener(async (message) => {
    if (message?.type === "translation.cancel") {
      activeRequest?.abort("cancelled");
      return;
    }
    if (message?.type !== "translation.start") return;
    activeRequest?.abort("superseded");
    activeRequest = coordinator.begin({ ...scope, surface: message.request?.surface || scope.surface });
    let validatedRequest;
    try {
      validatedRequest = SensemarkContracts.createTranslationRequest(message.request);
    } catch (cause) {
      const invalid = new SensemarkErrors.SensemarkError(
        SensemarkErrors.ERROR_CODE.INVALID_REQUEST,
        "Некорректный запрос на перевод.",
        { cause }
      );
      port.postMessage({
        type: "translation.failed",
        requestId: String(message.request?.requestId || ""),
        error: invalid.toJSON()
      });
      activeRequest.finish();
      activeRequest = null;
      return;
    }
    const requestId = validatedRequest.requestId;
    try {
      port.postMessage({ type: "translation.started", requestId });
      const response = await translationService.translate(validatedRequest, {
        signal: activeRequest.signal,
        onDelta(delta) {
          port.postMessage({ type: "translation.delta", requestId, delta });
        }
      });
      port.postMessage({
        type: "translation.completed",
        requestId,
        status: response.status,
        result: response.result,
        cached: response.cached
      });
    } catch (error) {
      const normalized = SensemarkErrors.normalizeUnknownError(error);
      if (normalized.code !== SensemarkErrors.ERROR_CODE.ABORTED) {
        port.postMessage({
          type: "translation.failed",
          requestId,
          error: normalized.toJSON()
        });
      }
    } finally {
      activeRequest?.finish();
      activeRequest = null;
    }
  });

  port.onDisconnect.addListener(() => {
    activeRequest?.abort("disconnected");
    activeRequest?.finish();
    activeRequest = null;
  });
});
