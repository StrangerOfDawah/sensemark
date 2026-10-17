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

// Горячая клавиша — под текущую платформу.
const isMac = /Mac/i.test(navigator.platform);
document.getElementById("kbd").innerHTML = isMac
  ? "<kbd>⌘</kbd><kbd>⇧</kbd><kbd>Y</kbd>"
  : "<kbd>Ctrl</kbd><kbd>⇧</kbd><kbd>Y</kbd>";

// Страница, открытая как обычный файл (file://), не имеет доступа к chrome.*
// Без этой проверки скрипт молча падал бы и элементы просто ничего не делали.
const inExtension = typeof chrome !== "undefined" && chrome.storage?.local;

if (!inExtension) {
  document.getElementById("banner").classList.add("show");
  document.querySelectorAll("input, select, button").forEach((el) => (el.disabled = true));
} else {
  init();
}

// Поле не должно быть шире того, что в нём написано.
const fitKey = () => {
  // Скрытый ключ рисуется точками — они уже букв, держим компактно.
  const len = Math.max(8, Math.min([...fields.apiKey.value].length + 1, 26));
  fields.apiKey.style.width = `calc(${len}ch + 44px)`;
};

function init() {
  chrome.storage.local.get(DEFAULTS).then((settings) => {
    // Старые модели OpenAI отключаются — показываем и сохраняем актуальную.
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

  // Автосохранение: как в System Settings — без кнопки «Сохранить».
  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  };
  fields.apiKey.addEventListener("input", () => { fitKey(); scheduleSave(); });
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

// Настройки OpenAI (ключ, модель, согласие) видны только в режиме OpenAI.
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

// Предпросмотр карточки: «Под страницу» показываем на обычной белой странице.
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
    // Язык зафиксирован — поля ввода нет, чтобы в промпт не попал произвольный текст.
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
  // Сохраняем перед проверкой, чтобы background видел те же настройки.
  await chrome.storage.local.set(settings);

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: "translate", text: "Hello, world!" });
  } catch {
    response = { ok: false, error: "Не удалось связаться с расширением" };
  }
  testBtn.disabled = false;

  if (response?.ok) {
    // Служебные метки ответа ([[text]] и т. п.) пользователю не показываем.
    const shown = String(response.text || "")
      .replace(/^\s*\[\[[^\]]+\]\]\s*/, "")
      .replace(/\s+/g, " ")
      .trim();
    setTestStatus(`Работает — «${shown}»`, "ok");
  } else {
    setTestStatus(response?.error || "Не удалось выполнить запрос", "err");
  }
}
