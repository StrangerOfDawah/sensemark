const { t, localize } = globalThis.SensemarkI18n;
const Providers = globalThis.SensemarkProviders;
const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULTS = {
  ...Providers.SETTINGS_DEFAULTS,
  model: DEFAULT_MODEL,
  targetLang: t("targetLanguage"),
  autoTranslate: true,
  cardTheme: "auto",
  cardFont: "system",
  matchPageSize: true
};
// Where a paid service keeps the data, shown next to what is sent.
const REGION_NOTES = { deepseek: () => t("privacyRegionDeepseek"), yandex: () => t("privacyRegionYandex") };

// Keys, folder and consent of every paid service, edited in one set of
// fields: switching the mode swaps what the fields show.
let stored = { ...Providers.SETTINGS_DEFAULTS };

const fields = {
  apiKey: document.getElementById("apiKey"),
  folderId: document.getElementById("folderId"),
  model: document.getElementById("model"),
  autoTranslate: document.getElementById("autoTranslate"),
  dataConsent: document.getElementById("dataConsent"),
  matchPageSize: document.getElementById("matchPageSize")
};
const themeInputs = [...document.querySelectorAll('input[name="cardTheme"]')];
const fontInputs = [...document.querySelectorAll('input[name="cardFont"]')];
const preview = document.getElementById("preview");
const previewText = document.getElementById("previewText");
const PREVIEW_FONTS = {
  system: "",
  golos: '"Sensemark Golos", sans-serif',
  literata: '"Sensemark Literata", Georgia, serif'
};
const providerInputs = [...document.querySelectorAll('input[name="provider"]')];
const providerSettings = document.getElementById("providerSettings");
const folderRow = document.getElementById("folderRow");
const modelRow = document.getElementById("modelRow");
const testBtn = document.getElementById("test");
const testStatus = document.getElementById("testStatus");
const toastEl = document.getElementById("toast");

// The keyboard shortcut for the current platform.
const isMac = /Mac/i.test(navigator.platform);
document.getElementById("kbd").innerHTML = isMac
  ? "<kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd>"
  : "<kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Y</kbd>";

// A page opened as a plain file (file://) has no access to chrome.*.
// Without this check the script would fail silently and the controls would do nothing.
const inExtension = typeof chrome !== "undefined" && chrome.storage?.local;

if (!inExtension) {
  // Without chrome.i18n there are no messages either, so this one is in English.
  const banner = document.getElementById("banner");
  banner.textContent =
    "This page was opened as a plain file, so settings are unavailable. " +
    "Open the extension popup and click the settings icon in the top right corner.";
  banner.classList.add("show");
  document.querySelectorAll("input, select, button").forEach((el) => (el.disabled = true));
} else {
  localize(document);
  init();
}

// The field must not be wider than its content.
const fitKey = () => {
  // A hidden key is drawn as dots, which are narrower than letters; keep it compact.
  const len = Math.max(8, Math.min([...fields.apiKey.value].length + 1, 26));
  fields.apiKey.style.width = `calc(${len}ch + 44px)`;
};

// In Safari free mode is Apple's translator, not Chrome's: only the labels
// change, the layout stays the same.
function adaptForSafari() {
  let safari;
  try {
    safari = /^safari-web-extension:/i.test(chrome.runtime.getURL(""));
  } catch {
    safari = false;
  }
  if (!safari) return;
  const builtin = document.querySelector('input[name="provider"][value="builtin"]')?.closest(".mode");
  const title = builtin?.querySelector(".mode-title");
  if (title?.firstChild?.nodeType === Node.TEXT_NODE)
    title.firstChild.textContent = `${t("engineAppleTitle")} `;
  const caption = builtin?.querySelector(".row-cap");
  if (caption) {
    caption.textContent = t("appleModeCaption");
  }
}

function init() {
  adaptForSafari();
  chrome.storage.local.get(DEFAULTS).then((settings) => {
    // Old OpenAI models are being retired: show and save the current one.
    if (![...fields.model.options].some((o) => o.value === settings.model)) {
      settings.model = DEFAULT_MODEL;
      chrome.storage.local.set({ model: DEFAULT_MODEL }).catch(() => {});
    }
    for (const key of Object.keys(Providers.SETTINGS_DEFAULTS)) stored[key] = settings[key];
    stored.providerConsent = { ...(settings.providerConsent || {}) };
    fields.model.value = settings.model;
    fields.autoTranslate.checked = settings.autoTranslate;
    setProvider(Providers.normalize(settings.provider));
    checkValue(themeInputs, settings.cardTheme, "auto");
    checkValue(fontInputs, settings.cardFont, "system");
    fields.matchPageSize.checked = settings.matchPageSize !== false;
    updatePreview();
    fitKey();
  });

  // Autosave, as in System Settings: no "Save" button.
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  fields.apiKey.addEventListener("input", () => {
    fitKey();
    remember();
    scheduleSave();
  });
  fields.folderId.addEventListener("input", () => {
    remember();
    scheduleSave();
  });
  fields.model.addEventListener("change", scheduleSave);
  fields.autoTranslate.addEventListener("change", scheduleSave);
  for (const input of [...themeInputs, ...fontInputs, fields.matchPageSize]) {
    input.addEventListener("change", () => {
      updatePreview();
      save();
    });
  }
  for (const input of providerInputs) {
    input.addEventListener("change", () => chooseProvider(input.value));
  }
  fields.dataConsent.addEventListener("change", () => {
    remember();
    save();
    if (!fields.dataConsent.checked) {
      setTestStatus(t("consentRevoked", Providers.get(currentProvider()).label), "err");
    } else {
      setTestStatus("");
    }
  });

  testBtn.addEventListener("click", runTest);

  const toggleKey = document.getElementById("toggleKey");
  toggleKey.addEventListener("click", () => {
    const hidden = fields.apiKey.type === "password";
    fields.apiKey.type = hidden ? "text" : "password";
    toggleKey.title = hidden ? t("hideKey") : t("showKey");
  });
}

function currentProvider() {
  return Providers.normalize(providerInputs.find((input) => input.checked)?.value);
}

// DeepSeek and YandexGPT are optional host permissions: Chrome asks for one
// when the user picks that mode (a click, so the request is allowed). OpenAI
// is granted at install.
async function chooseProvider(provider) {
  const previous = stored.provider;
  const entry = Providers.get(provider);
  if (entry?.optionalPermission && chrome.permissions?.request) {
    const granted = await chrome.permissions.request({ origins: [entry.origin] }).catch(() => false);
    if (!granted) {
      setProvider(Providers.normalize(previous));
      setTestStatus(t("permissionDenied", entry.label), "err");
      return;
    }
  }
  setTestStatus("");
  setProvider(provider);
  save();
}

// The connection block shows the fields of the chosen paid service; free
// mode hides it. Texts name the service, so consent is always to a named
// company.
function setProvider(provider) {
  stored.provider = provider;
  for (const input of providerInputs) input.checked = input.value === provider;
  const entry = Providers.get(provider);
  providerSettings.hidden = !entry;
  if (!entry) return;

  document.getElementById("privacyTitle").textContent = t("privacyTitle", entry.label);
  const region = REGION_NOTES[provider] ? ` ${REGION_NOTES[provider]()}` : "";
  document.getElementById("privacyText").textContent = `${t("privacyText", entry.label)}${region} `;
  document.getElementById("consentText").textContent = t("consentText", entry.label);
  document.getElementById("connectionLabel").textContent = t("groupConnection", entry.label);
  document.getElementById("apiKeyTitle").textContent = t("apiKeyTitle", entry.label);
  document.getElementById("apiKeyCaption").textContent = t("apiKeyCaption", entry.host);

  fields.apiKey.placeholder = entry.keyPlaceholder;
  fields.apiKey.value = stored[entry.keySetting] || "";
  fields.dataConsent.checked = Providers.hasConsent(stored, provider);
  folderRow.hidden = !entry.folderSetting;
  if (entry.folderSetting) fields.folderId.value = stored[entry.folderSetting] || "";
  // Only OpenAI offers a model choice; the others use one fixed model.
  modelRow.hidden = provider !== "openai";
  fitKey();
}

// Copies the visible fields into the chosen service's settings.
function remember() {
  const entry = Providers.get(currentProvider());
  if (!entry) return;
  stored[entry.keySetting] = fields.apiKey.value.trim();
  if (entry.folderSetting) stored[entry.folderSetting] = fields.folderId.value.trim();
  Object.assign(stored, Providers.consentPatch(stored, entry.id, fields.dataConsent.checked));
}

function checkValue(inputs, value, fallback) {
  const known = inputs.some((input) => input.value === value) ? value : fallback;
  for (const input of inputs) input.checked = input.value === known;
}

function checkedValue(inputs, fallback) {
  return inputs.find((input) => input.checked)?.value || fallback;
}

// Card preview: "match the page" is shown on a plain white page.
function updatePreview() {
  const theme = checkedValue(themeInputs, "auto");
  preview.classList.toggle("dark", theme === "dark");
  previewText.style.fontFamily = PREVIEW_FONTS[checkedValue(fontInputs, "system")] || "";
  previewText.style.fontSize = fields.matchPageSize.checked ? "16px" : "15px";
}

function collect() {
  remember();
  return {
    ...stored,
    provider: currentProvider(),
    model: fields.model.value.trim() || DEFAULTS.model,
    // The language is fixed: there is no input, so no arbitrary text reaches the prompt.
    targetLang: DEFAULTS.targetLang,
    autoTranslate: fields.autoTranslate.checked,
    cardTheme: checkedValue(themeInputs, "auto"),
    cardFont: checkedValue(fontInputs, "system"),
    matchPageSize: fields.matchPageSize.checked
  };
}

async function save() {
  try {
    await chrome.storage.local.set(collect());
    toast(t("toastSaved"));
  } catch (error) {
    toast(t("toastSaveFailed", error.message));
  }
}

let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1600);
}

function setTestStatus(message, kind = "") {
  testStatus.textContent = message;
  testStatus.className = `status ${kind}`;
}

async function runTest() {
  const settings = collect();
  const issue = Providers.settingsIssue(settings);
  if (issue === "consent") {
    setTestStatus(t("testNeedsConsent"), "err");
    return;
  }
  if (issue === "api-key") {
    setTestStatus(t("testNeedsKey"), "err");
    return;
  }
  if (issue === "folder") {
    setTestStatus(t("setupFolder"), "err");
    return;
  }

  testBtn.disabled = true;
  setTestStatus(t("testChecking"), "busy");
  // Save before checking so the background sees the same settings.
  await chrome.storage.local.set(settings);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "translate", text: "Hello, world!" });
  } catch {
    response = { ok: false, error: t("testNoConnection") };
  }
  testBtn.disabled = false;

  if (response?.ok) {
    // Internal answer markers ([[text]] and so on) are never shown to the user.
    const shown = String(response.text || "")
      .replace(/^\s*\[\[[^\]]+\]\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    setTestStatus(t("testWorks", shown), "ok");
  } else {
    setTestStatus(response?.error || t("testFailed"), "err");
  }
}
