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

// Request identity deliberately does not come from the URL. The panel claims its
// pending request over the handoff port, so it does not matter whether the panel
// loaded before or after the worker stored the request.
const handoff = SensemarkSidePanelHandoffClient.createSidePanelHandoffClient({
  onRequest(pending) {
    source.value = pending.text;
    controller.translate();
  },
  onTimeout() {
    view.failed(
      {
        message: "Не удалось получить выделенный текст. Попробуйте ещё раз.",
        code: "SIDE_PANEL_HANDOFF_TIMEOUT",
        action: "retry"
      },
      () => {
        view.clear();
        handoff.openClaimWindow({ expecting: true });
        handoff.claimNow();
      }
    );
  }
});

handoff.start();
