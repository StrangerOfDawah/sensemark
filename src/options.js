const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULTS = {
  provider: "builtin",
  apiKey: "",
  model: DEFAULT_MODEL,
  targetLang: "русский",
  autoTranslate: true,
  privacyConsentVersion: 0,
  cardTheme: "auto",
  cardFont: "system",
  matchPageSize: true
};
const PRIVACY_CONSENT_VERSION = 1;

const fields = {
  apiKey: document.getElementById("apiKey"),
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
const openaiSettings = document.getElementById("openaiSettings");
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
  document.getElementById("banner").classList.add("show");
  document.querySelectorAll("input, select, button").forEach((el) => (el.disabled = true));
} else {
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
  if (title?.firstChild?.nodeType === Node.TEXT_NODE) title.firstChild.textContent = "Переводчик Apple ";
  const caption = builtin?.querySelector(".row-cap");
  if (caption) {
    caption.textContent =
      "Работает прямо на Mac: без ключа и без оплаты, текст никуда не отправляется. " +
      "Языки скачиваются один раз в приложении Sensemark. Слово переводится без учёта контекста.";
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
    setProvider(settings.provider === "openai" ? "openai" : "builtin");
    fields.apiKey.value = settings.apiKey;
    fields.model.value = settings.model;
    fields.autoTranslate.checked = settings.autoTranslate;
    fields.dataConsent.checked = settings.privacyConsentVersion === PRIVACY_CONSENT_VERSION;
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
    input.addEventListener("change", () => {
      setProvider(input.value);
      save();
    });
  }
  fields.dataConsent.addEventListener("change", () => {
    save();
    if (!fields.dataConsent.checked) {
      setTestStatus("Согласие отозвано — запросы в OpenAI заблокированы", "err");
    } else {
      setTestStatus("");
    }
  });

  testBtn.addEventListener("click", runTest);

  const toggleKey = document.getElementById("toggleKey");
  toggleKey.addEventListener("click", () => {
    const hidden = fields.apiKey.type === "password";
    fields.apiKey.type = hidden ? "text" : "password";
    toggleKey.title = hidden ? "Скрыть ключ" : "Показать ключ";
  });
}

function currentProvider() {
  return providerInputs.find((input) => input.checked)?.value === "openai" ? "openai" : "builtin";
}

// OpenAI settings (key, model, consent) are visible only in OpenAI mode.
function setProvider(provider) {
  for (const input of providerInputs) input.checked = input.value === provider;
  openaiSettings.hidden = provider !== "openai";
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
  return {
    provider: currentProvider(),
    apiKey: fields.apiKey.value.trim(),
    model: fields.model.value.trim() || DEFAULTS.model,
    // The language is fixed: there is no input, so no arbitrary text reaches the prompt.
    targetLang: DEFAULTS.targetLang,
    autoTranslate: fields.autoTranslate.checked,
    privacyConsentVersion: fields.dataConsent.checked ? PRIVACY_CONSENT_VERSION : 0,
    cardTheme: checkedValue(themeInputs, "auto"),
    cardFont: checkedValue(fontInputs, "system"),
    matchPageSize: fields.matchPageSize.checked
  };
}

async function save() {
  try {
    await chrome.storage.local.set(collect());
    toast("Сохранено");
  } catch (error) {
    toast(`Не удалось сохранить: ${error.message}`);
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
  if (settings.privacyConsentVersion !== PRIVACY_CONSENT_VERSION) {
    setTestStatus("Сначала подтвердите согласие на отправку текста", "err");
    return;
  }
  if (!settings.apiKey) {
    setTestStatus("Сначала введите ключ", "err");
    return;
  }

  testBtn.disabled = true;
  setTestStatus("Проверяю…", "busy");
  // Save before checking so the background sees the same settings.
  await chrome.storage.local.set(settings);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "translate", text: "Hello, world!" });
  } catch {
    response = { ok: false, error: "Не удалось связаться с расширением" };
  }
  testBtn.disabled = false;

  if (response?.ok) {
    // Internal answer markers ([[text]] and so on) are never shown to the user.
    const shown = String(response.text || "")
      .replace(/^\s*\[\[[^\]]+\]\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    setTestStatus(`Работает — «${shown}»`, "ok");
  } else {
    setTestStatus(response?.error || "Не удалось выполнить запрос", "err");
  }
}
