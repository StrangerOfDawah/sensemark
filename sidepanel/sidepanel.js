const source = document.getElementById("source");
const view = SensemarkResultView.createResultView({
  resultElement: document.getElementById("result"),
  statusElement: document.getElementById("status"),
  actionsElement: document.getElementById("actions"),
  openSettings: () => chrome.runtime.openOptionsPage()
});
const controller = SensemarkTranslatorController.createTranslatorController({
  getText: () => source.value,
  surface: "sidepanel",
  view
});

document.getElementById("translate").addEventListener("click", () => controller.translate());
document.getElementById("copy").addEventListener("click", () => view.copy());
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
source.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    controller.translate();
  }
});
source.addEventListener("input", () => controller.cancel());

const sidePanelParameters = new URLSearchParams(location.search);
const sidePanelIdentity = {
  tabId: Number(sidePanelParameters.get("tabId")),
  frameId: Number(sidePanelParameters.get("frameId") || 0),
  requestId: sidePanelParameters.get("requestId") || ""
};

chrome.runtime
  .sendMessage({
    type: SensemarkConfig.MESSAGE.SIDE_PANEL_PENDING_GET,
    identity: sidePanelIdentity
  })
  .then(async (response) => {
    if (!response?.pending?.text) return;
    source.value = response.pending.text;
    controller.translate();
  })
  .catch(() => {});
