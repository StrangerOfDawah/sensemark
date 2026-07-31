(function exposeResultView(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          errors: require("../shared/errors.js"),
          renderer: require("../shared/result-renderer.js")
        }
      : {
          errors: root.SensemarkErrors,
          renderer: root.SensemarkResultRenderer
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkResultView = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ errors, renderer }) => {
  function createResultView({ resultElement, statusElement, actionsElement, openSettings }) {
    let output = "";

    function clear() {
      output = "";
      resultElement.replaceChildren();
      actionsElement.replaceChildren();
      statusElement.textContent = "";
      statusElement.className = "status";
      resultElement.hidden = true;
    }

    function start() {
      clear();
      statusElement.textContent = "Перевожу…";
    }

    function delta(value) {
      output += String(value || "");
      resultElement.textContent = output;
      resultElement.hidden = !output.trim();
      if (output.trim()) statusElement.textContent = "";
    }

    function completed(result) {
      output = result.translation || result.text || output;
      renderer.renderResult({
        documentObject: resultElement.ownerDocument || document,
        container: resultElement,
        result,
        fallbackText: output
      });
      resultElement.hidden = false;
      statusElement.textContent = "";
    }

    function failed(error, retry) {
      resultElement.hidden = true;
      statusElement.textContent = error?.message || "Не удалось перевести.";
      statusElement.className = "status error";
      actionsElement.replaceChildren();
      const action = errors.userActionForError(error);
      if (action === "retry") {
        const button = document.createElement("button");
        button.className = "secondary";
        button.textContent = "Повторить";
        button.addEventListener("click", retry);
        actionsElement.append(button);
      }
      if (action === "open-settings") {
        const button = document.createElement("button");
        button.className = "primary";
        button.textContent = "Открыть настройки";
        button.addEventListener("click", openSettings);
        actionsElement.append(button);
      }
    }

    function skipped() {
      clear();
      statusElement.textContent = "Текст уже на русском.";
    }

    async function copy() {
      const value = output || resultElement.textContent || "";
      if (value) await navigator.clipboard.writeText(value);
    }

    return { clear, completed, copy, delta, failed, skipped, start };
  }

  return { createResultView };
});
