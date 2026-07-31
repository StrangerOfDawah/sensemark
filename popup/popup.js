const source = document.getElementById("source");
const translateButton = document.getElementById("translate");
const copyButton = document.getElementById("copy");
const view = SensemarkResultView.createResultView({
  resultElement: document.getElementById("result"),
  statusElement: document.getElementById("status"),
  actionsElement: document.getElementById("actions"),
  openSettings: () => chrome.runtime.openOptionsPage()
});
const controller = SensemarkTranslatorController.createTranslatorController({
  getText: () => source.value,
  surface: "popup",
  view
});

translateButton.addEventListener("click", () => controller.translate());
copyButton.addEventListener("click", () => view.copy());
document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
source.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    controller.translate();
  }
});
source.addEventListener("input", () => controller.cancel());
source.addEventListener("paste", () => {
  setTimeout(() => {
    if (source.value.trim()) controller.translate();
  }, 0);
});
