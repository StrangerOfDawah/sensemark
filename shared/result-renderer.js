(function exposeResultRenderer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkResultRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function appendTextNode(documentObject, container, tag, className, value) {
    if (!value) return null;
    const node = documentObject.createElement(tag);
    if (className) node.className = className;
    node.textContent = value;
    container.append(node);
    return node;
  }

  function renderResult({
    documentObject = document,
    container,
    result = {},
    fallbackText = ""
  }) {
    if (!container) throw new TypeError("A result container is required.");
    const translation = String(result.translation || result.text || fallbackText || "");
    container.replaceChildren();
    if (result.kind === "reference") {
      appendTextNode(
        documentObject,
        container,
        "small",
        "result-kind section-label",
        result.category ? `Справка · ${result.category}` : "Справка"
      );
    }
    appendTextNode(documentObject, container, "div", "result-translation", translation);
    if (result.alternatives?.length) {
      appendTextNode(
        documentObject,
        container,
        "p",
        "alternatives detail",
        `Другие варианты: ${result.alternatives.slice(0, 4).join("; ")}`
      );
    }
    appendTextNode(
      documentObject,
      container,
      "p",
      "explanation detail",
      String(result.explanation || "")
    );
    for (const section of result.sections || []) {
      const wrapper = documentObject.createElement("section");
      wrapper.className = "section result-section";
      appendTextNode(
        documentObject,
        wrapper,
        "small",
        "section-label",
        section.script || "Фрагмент"
      );
      appendTextNode(
        documentObject,
        wrapper,
        "div",
        "section-translation",
        section.translation
      );
      container.append(wrapper);
    }
    return translation;
  }

  return { renderResult };
});
