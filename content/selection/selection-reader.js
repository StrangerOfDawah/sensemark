(function exposeSelectionReader(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          scorer: require("./candidate-scorer.js"),
          text: require("../../shared/text-utils.js")
        }
      : {
          scorer: root.SensemarkCandidateScorer,
          text: root.SensemarkTextUtils
        };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSelectionReader = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ scorer, text }) => {
  const MAX_VISITED_NODES = 2000;
  const MAX_FALLBACK_MILLISECONDS = 25;
  const MAX_FALLBACK_CODE_POINTS = 5000;
  const TRANSLATABLE_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email"]);

  function isPasswordField(element) {
    return Boolean(
      element?.tagName?.toLowerCase() === "input" &&
        String(element.type || "").toLowerCase() === "password"
    );
  }

  function isFormControl(element) {
    return Boolean(
      element &&
        (element.tagName?.toLowerCase() === "textarea" ||
          (element.tagName?.toLowerCase() === "input" &&
            TRANSLATABLE_INPUT_TYPES.has(String(element.type || "text").toLowerCase())))
    );
  }

  function formSelection(element) {
    if (isPasswordField(element)) {
      return { status: "unsupported", reason: "password-field" };
    }
    if (!isFormControl(element)) return null;
    const start = Number(element.selectionStart);
    const end = Number(element.selectionEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) return null;
    return {
      status: "ok",
      source: "form",
      text: String(element.value || "").slice(start, end),
      range: null,
      rect: element.getBoundingClientRect?.() || null,
      target: element
    };
  }

  function selectionRanges(selection, shadowRoots = []) {
    if (!selection || selection.isCollapsed) return [];
    if (typeof selection.getComposedRanges === "function") {
      try {
        const ranges = selection.getComposedRanges({ shadowRoots });
        if (ranges?.length) return Array.from(ranges);
      } catch {
        // Older Chromium prototypes used positional shadow-root arguments.
        try {
          const ranges = selection.getComposedRanges(...shadowRoots);
          if (ranges?.length) return Array.from(ranges);
        } catch {}
      }
    }
    const ranges = [];
    for (let index = 0; index < (selection.rangeCount || 0); index += 1) {
      try {
        ranges.push(selection.getRangeAt(index));
      } catch {}
    }
    return ranges;
  }

  function toLiveRange(range, documentObject) {
    if (!range || typeof range !== "object") return null;
    if (
      typeof range.cloneContents === "function" &&
      typeof range.getClientRects === "function"
    ) {
      return range;
    }
    if (
      !range.startContainer ||
      !range.endContainer ||
      typeof documentObject?.createRange !== "function"
    ) {
      return range;
    }
    try {
      const liveRange = documentObject.createRange();
      liveRange.setStart(range.startContainer, range.startOffset);
      liveRange.setEnd(range.endContainer, range.endOffset);
      return liveRange;
    } catch {
      return range;
    }
  }

  function rangeRect(range) {
    try {
      const rects = Array.from(range.getClientRects?.() || []).filter(
        (rect) => rect.width || rect.height
      );
      return rects.at(-1) || range.getBoundingClientRect?.() || null;
    } catch {
      return null;
    }
  }

  function accessibilityText(element, documentObject) {
    const values = [];
    const labelledBy = element.getAttribute?.("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        const label = documentObject.getElementById?.(id);
        if (label?.textContent) values.push(label.textContent);
      }
    }
    for (const attribute of ["aria-label", "alt", "title"]) {
      const value = element.getAttribute?.(attribute);
      if (value) values.push(value);
    }
    for (const label of element.labels || []) {
      if (label.textContent) values.push(label.textContent);
    }
    if (isFormControl(element) && element.value) values.push(element.value);
    return text.normalizeText(values.join(" "));
  }

  function intersects(range, node) {
    try {
      return typeof range.intersectsNode === "function" && range.intersectsNode(node);
    } catch {
      return false;
    }
  }

  function fallbackCandidates(range, documentObject) {
    range = toLiveRange(range, documentObject);
    const candidates = [];
    try {
      candidates.push({ source: "range", text: range.toString() });
      const clone = range.cloneContents?.();
      if (clone?.textContent) candidates.push({ source: "clone", text: clone.textContent });
    } catch {}

    const ancestor =
      range.commonAncestorContainer?.nodeType === 1
        ? range.commonAncestorContainer
        : range.commonAncestorContainer?.parentElement;
    if (!ancestor || !documentObject?.createTreeWalker) return candidates;

    const walker = documentObject.createTreeWalker(
      ancestor,
      (globalThis.NodeFilter?.SHOW_ELEMENT || 1) | (globalThis.NodeFilter?.SHOW_TEXT || 4)
    );
    const visibleParts = [];
    const accessibleParts = [];
    const visibilityCache = new WeakMap();
    const startedAt = globalThis.performance?.now?.() ?? Date.now();
    let collectedCodePoints = 0;
    let visited = 0;
    let node = walker.currentNode;
    function visible(element) {
      if (!element || element.nodeType !== 1) return true;
      if (visibilityCache.has(element)) return visibilityCache.get(element);
      let value = true;
      try {
        const style = documentObject.defaultView?.getComputedStyle?.(element);
        value =
          style?.display !== "none" &&
          style?.visibility !== "hidden" &&
          style?.contentVisibility !== "hidden" &&
          !element.hidden;
        if (value && element.parentElement && element.parentElement !== ancestor) {
          value = visible(element.parentElement);
        }
      } catch {}
      visibilityCache.set(element, value);
      return value;
    }
    function appendVisible(value) {
      if (!value || collectedCodePoints >= MAX_FALLBACK_CODE_POINTS) return;
      const points = Array.from(value);
      const remaining = MAX_FALLBACK_CODE_POINTS - collectedCodePoints;
      visibleParts.push(points.slice(0, remaining).join(""));
      collectedCodePoints += Math.min(points.length, remaining);
    }
    while (
      node &&
      visited < MAX_VISITED_NODES &&
      (globalThis.performance?.now?.() ?? Date.now()) - startedAt <
        MAX_FALLBACK_MILLISECONDS &&
      collectedCodePoints < MAX_FALLBACK_CODE_POINTS
    ) {
      visited += 1;
      if (intersects(range, node)) {
        const element = node.nodeType === 1 ? node : node.parentElement;
        if (!visible(element)) {
          node = walker.nextNode();
          continue;
        }
        if (node.nodeType === 3 && node.nodeValue) appendVisible(node.nodeValue);
        if (node.nodeType === 1) {
          const tag = node.tagName?.toLowerCase();
          if (tag === "br") appendVisible("\n");
          else if (/^(p|div|li|blockquote|td|th|h[1-6]|section|article)$/.test(tag)) {
            appendVisible("\n");
          }
          const value = accessibilityText(node, documentObject);
          if (value) accessibleParts.push(value);
        }
      }
      node = walker.nextNode();
    }
    if (accessibleParts.length) {
      candidates.push({ source: "accessibility", text: accessibleParts.join(" ") });
    }
    if (visibleParts.length) {
      candidates.push({ source: "bounded", text: visibleParts.join("") });
    }
    return candidates;
  }

  function readSelection({
    documentObject = globalThis.document,
    target = documentObject?.activeElement,
    shadowRoots = []
  } = {}) {
    const fromForm = formSelection(target);
    if (fromForm?.status === "unsupported") return fromForm;
    if (fromForm && text.hasLetters(fromForm.text)) {
      return { ...fromForm, text: text.normalizeText(fromForm.text) };
    }

    const selection =
      target?.getRootNode?.()?.getSelection?.() || documentObject?.getSelection?.() || null;
    if (!selection || selection.isCollapsed) {
      return { status: "unsupported", reason: "empty-selection" };
    }
    const nativeText = text.normalizeText(selection.toString?.());
    const ranges = selectionRanges(selection, shadowRoots).map((range) =>
      toLiveRange(range, documentObject)
    );
    const primaryRange = ranges[0] || null;

    if (nativeText && text.hasLetters(nativeText) && text.privateUseRatio(nativeText) < 0.05) {
      return {
        status: "ok",
        source: "native",
        text: nativeText,
        range: primaryRange,
        rect: primaryRange ? rangeRect(primaryRange) : null,
        target
      };
    }

    const candidates = [{ source: "native", text: nativeText }];
    for (const range of ranges) {
      candidates.push(...fallbackCandidates(range, documentObject));
    }
    const best = scorer.chooseCandidate(candidates);
    if (!best || !text.hasLetters(best.text)) {
      return {
        status: "unsupported",
        reason: nativeText ? "low-confidence-selection" : "no-text-layer"
      };
    }
    return {
      status: "ok",
      source: best.source,
      text: best.text,
      confidence: best.confidence,
      range: primaryRange,
      rect: primaryRange ? rangeRect(primaryRange) : null,
      target
    };
  }

  return {
    MAX_VISITED_NODES,
    MAX_FALLBACK_CODE_POINTS,
    MAX_FALLBACK_MILLISECONDS,
    TRANSLATABLE_INPUT_TYPES,
    fallbackCandidates,
    formSelection,
    isPasswordField,
    readSelection,
    selectionRanges,
    toLiveRange
  };
});
