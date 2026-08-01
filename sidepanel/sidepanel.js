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
//
// The only thing read from the URL is this panel's own tab id, assigned by the
// configurator on tab lifecycle events. It is stable for the life of the tab and is
// never per-request.
//
// A valid stable tab token is required for request delivery. Without it this
// document is an untokenized global or legacy panel: the worker rejects it and it
// cannot claim a tab-scoped request.
const tabToken = new URLSearchParams(location.search).get("tab");

const handoff = SensemarkSidePanelHandoffClient.createSidePanelHandoffClient({
  tabToken,
  onRequest(pending) {
    source.value = pending.text;
    controller.translate();
  },
  onUnsupported() {
    // A legacy or global default panel: it has no tab token, so it cannot receive
    // translations. Reopening from the tab gets a properly configured instance.
    view.failed(
      {
        message:
          "Эта панель не привязана к вкладке. Закройте её и повторите перевод из нужной вкладки.",
        code: "PANEL_NOT_CONFIGURED",
        action: null
      },
      () => {}
    );
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
