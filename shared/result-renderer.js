(function exposeResultRenderer(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkResultRenderer = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  // A structured payload must never reach the user. It can arrive two ways: as an
  // object where a string was expected, or — the case that actually shipped — as a
  // JSON string streamed verbatim when a model answers a text-mode request with
  // structured output. Both are unwrapped here rather than at each call site.
  const DISPLAY_KEYS = ["translation", "text"];
  const MAX_UNWRAP_DEPTH = 4;

  function looksLikeStructuredPayload(value) {
    const trimmed = value.trim();
    if (trimmed.length < 2) return false;
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    return (first === "{" && last === "}") || (first === "[" && last === "]");
  }

  /** Pull the user-facing string out of anything the provider may hand us. */
  function displayText(value, depth = 0) {
    if (value === null || value === undefined) return "";
    if (depth > MAX_UNWRAP_DEPTH) return "";

    if (typeof value === "string") {
      if (!looksLikeStructuredPayload(value)) return value;
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        // Not valid JSON after all — it is ordinary text that merely starts with a
        // brace, so show it.
        return value;
      }
      // Valid JSON: only ever show what we can extract from it, never the payload.
      return displayText(parsed, depth + 1);
    }

    if (Array.isArray(value)) {
      return value
        .map((item) => displayText(item, depth + 1))
        .filter(Boolean)
        .join("\n");
    }

    if (typeof value === "object") {
      for (const key of DISPLAY_KEYS) {
        if (value[key] !== undefined) {
          const extracted = displayText(value[key], depth + 1);
          if (extracted) return extracted;
        }
      }
      if (Array.isArray(value.sections)) {
        const sections = value.sections
          .map((section) => displayText(section?.translation, depth + 1))
          .filter(Boolean);
        if (sections.length) return sections.join("\n");
      }
      // Nothing displayable: show nothing rather than the raw object.
      return "";
    }

    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return "";
  }

  function appendTextNode(documentObject, container, tag, className, value) {
    const text = displayText(value);
    if (!text) return null;
    const node = documentObject.createElement(tag);
    if (className) node.className = className;
    node.textContent = text;
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
    const translation =
      displayText(result.translation) || displayText(result.text) || displayText(fallbackText);
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

  return { displayText, renderResult };
});
