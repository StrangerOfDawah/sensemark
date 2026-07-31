const client = SensemarkPrivateSettingsClient.createPrivateSettingsClient();
const fields = {
  apiKey: document.getElementById("apiKey"),
  model: document.getElementById("model"),
  customModel: document.getElementById("customModel"),
  consent: document.getElementById("consent"),
  selectionMode: document.getElementById("selectionMode"),
  stableDelay: document.getElementById("stableDelay"),
  modifier: document.getElementById("modifier"),
  scale: document.getElementById("scale")
};
const saveStatus = document.getElementById("saveStatus");
const testStatus = document.getElementById("testStatus");
let settings = null;
let saveTimer = 0;

function patchFromFields() {
  const model =
    fields.model.value === "__custom__"
      ? fields.customModel.value.trim()
      : fields.model.value;
  return {
    providers: {
      openai: {
        apiKey: fields.apiKey.value.trim(),
        model: model || "gpt-4o-mini"
      }
    },
    privacyConsentVersion: fields.consent.checked
      ? SensemarkConfig.PRIVACY_CONSENT_VERSION
      : 0,
    selection: {
      mode: fields.selectionMode.value,
      stableDelayMs: Number(fields.stableDelay.value),
      requiredModifier: fields.modifier.value
    },
    ui: {
      scale: Number(fields.scale.value),
      cardWidth: settings?.ui.cardWidth || 0,
      cardHeight: settings?.ui.cardHeight || 0
    }
  };
}

async function save() {
  clearTimeout(saveTimer);
  try {
    settings = await client.patch(patchFromFields());
    saveStatus.textContent = "Сохранено";
    setTimeout(() => {
      if (saveStatus.textContent === "Сохранено") saveStatus.textContent = "";
    }, 1200);
  } catch (error) {
    saveStatus.textContent = error.message;
    saveStatus.className = "status error";
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 350);
}

async function initialize() {
  settings = await client.get();
  fields.apiKey.value = settings.providers.openai.apiKey;
  const savedModel = settings.providers.openai.model;
  if (Array.from(fields.model.options).some((option) => option.value === savedModel)) {
    fields.model.value = savedModel;
    fields.customModel.hidden = true;
  } else {
    fields.model.value = "__custom__";
    fields.customModel.value = savedModel;
    fields.customModel.hidden = false;
  }
  fields.consent.checked =
    settings.privacyConsentVersion === SensemarkConfig.PRIVACY_CONSENT_VERSION;
  fields.selectionMode.value = settings.selection.mode;
  fields.stableDelay.value = settings.selection.stableDelayMs;
  fields.modifier.value = settings.selection.requiredModifier;
  fields.scale.value = settings.ui.scale;
}

for (const field of Object.values(fields)) {
  field.addEventListener(field.type === "text" || field.type === "password" ? "input" : "change", scheduleSave);
}

fields.model.addEventListener("change", () => {
  fields.customModel.hidden = fields.model.value !== "__custom__";
  if (!fields.customModel.hidden) fields.customModel.focus();
});

document.getElementById("toggleKey").addEventListener("click", () => {
  const hidden = fields.apiKey.type === "password";
  fields.apiKey.type = hidden ? "text" : "password";
  document.getElementById("toggleKey").textContent = hidden ? "Скрыть" : "Показать";
});

document.getElementById("deleteKey").addEventListener("click", async () => {
  if (!fields.apiKey.value || !confirm("Удалить сохранённый API‑ключ OpenAI?")) return;
  fields.apiKey.value = "";
  await save();
});

document.getElementById("resetSize").addEventListener("click", async () => {
  settings.ui.cardWidth = 0;
  settings.ui.cardHeight = 0;
  await save();
});

document.getElementById("test").addEventListener("click", async () => {
  testStatus.className = "status";
  testStatus.textContent = "Проверяю…";
  await save();
  try {
    const response = await client.test();
    testStatus.textContent = SensemarkConfigurationStatus.describeConfigurationValidation(
      response.validation
    );
  } catch (error) {
    testStatus.className = "status error";
    testStatus.textContent = error.message;
  }
});

initialize().catch((error) => {
  saveStatus.className = "status error";
  saveStatus.textContent = error.message;
});
