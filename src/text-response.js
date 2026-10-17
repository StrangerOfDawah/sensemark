(function exposeTextResponseParser(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkTextResponse = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const TEXT_MARKER = "[[text]]";
  const MULTILINGUAL_MARKER = "[[multilingual]]";
  const SKIP_MARKER = "[[skip]]";
  const LANGUAGE_MARKER = /^\[\[lang\s*:\s*(.+?)\]\]$/i;
  const SCRIPT_LANGUAGE_MARKER =
    /^\[\[script\s*:\s*([^|\]]+)\s*\|\s*lang\s*:\s*(.+?)\]\]$/i;

  function afterFirstLine(text) {
    const newline = text.indexOf("\n");
    return newline === -1 ? "" : text.slice(newline + 1).trim();
  }

  function parseSections(text) {
    const lines = text.split("\n");
    const sections = [];
    let current = null;

    for (const rawLine of lines) {
      const scriptMarker = rawLine.trim().match(SCRIPT_LANGUAGE_MARKER);
      const languageMarker = rawLine.trim().match(LANGUAGE_MARKER);
      const marker = scriptMarker || languageMarker;
      if (marker) {
        if (current) {
          current.text = current.lines.join("\n").trim();
          delete current.lines;
          sections.push(current);
        }
        current = scriptMarker
          ? { script: scriptMarker[1].trim(), language: scriptMarker[2].trim(), lines: [] }
          : { script: "", language: languageMarker[1].trim(), lines: [] };
      } else if (current) {
        current.lines.push(rawLine);
      }
    }

    if (current) {
      current.text = current.lines.join("\n").trim();
      delete current.lines;
      sections.push(current);
    }
    return sections;
  }

  function parse(text) {
    const value = String(text || "").trim();
    if (!value) return { mode: "pending", text: "", sections: [] };

    const normalized = value.toLowerCase();
    const markers = [TEXT_MARKER, MULTILINGUAL_MARKER, SKIP_MARKER];
    if (markers.some((marker) => marker.startsWith(normalized) && marker !== normalized)) {
      return { mode: "pending", text: "", sections: [] };
    }

    const firstLine = normalized.split("\n", 1)[0].trim();
    if (firstLine.startsWith("[[") && !firstLine.endsWith("]]")) {
      return { mode: "pending", text: "", sections: [] };
    }
    if (firstLine === SKIP_MARKER) return { mode: "skip", text: "", sections: [] };
    if (firstLine === TEXT_MARKER) {
      return { mode: "text", text: afterFirstLine(value), sections: [] };
    }
    if (firstLine === MULTILINGUAL_MARKER) {
      const sections = parseSections(afterFirstLine(value));
      return {
        mode: sections.length ? "multilingual" : "pending",
        text: "",
        sections
      };
    }

    // Совместимость с ответами до появления служебных меток.
    return { mode: "text", text: value, sections: [] };
  }

  return { parse, TEXT_MARKER, MULTILINGUAL_MARKER, SKIP_MARKER };
});
