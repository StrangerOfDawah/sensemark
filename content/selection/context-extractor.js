(function exposeContextExtractor(root, factory) {
  const dependencies =
    typeof module === "object" && module.exports
      ? {
          config: require("../../shared/config.js"),
          text: require("../../shared/text-utils.js")
        }
      : { config: root.SensemarkConfig, text: root.SensemarkTextUtils };
  const api = factory(dependencies);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkContextExtractor = api;
})(typeof globalThis !== "undefined" ? globalThis : this, ({ config, text: textUtils }) => {
  const BLOCK_SELECTOR =
    "p,li,blockquote,figcaption,dd,dt,td,th,h1,h2,h3,h4,h5,h6,[contenteditable='true']";
  const MAX_ANCESTOR_DEPTH = 8;
  const BLOCK_DISPLAYS = new Set([
    "block",
    "flow-root",
    "flex",
    "grid",
    "list-item",
    "table",
    "table-cell"
  ]);

  function boundedContainerDetails(
    source,
    selectedText,
    maximum = config.MAX_CONTAINER_CODE_POINTS,
    selectedIndexHint = -1
  ) {
    const normalizedSource = textUtils.normalizeText(source);
    const selected = textUtils.normalizeText(selectedText);
    if (!normalizedSource || !selected) return { source: "", selectedIndex: -1 };
    const hintedIndex = Number(selectedIndexHint);
    let selectedIndex = normalizedSource.indexOf(selected);
    if (Number.isInteger(hintedIndex) && hintedIndex >= 0) {
      const occurrences = [];
      let cursor = normalizedSource.indexOf(selected);
      while (cursor >= 0 && occurrences.length < 100) {
        occurrences.push(cursor);
        cursor = normalizedSource.indexOf(selected, cursor + selected.length);
      }
      if (occurrences.length) {
        selectedIndex = occurrences.sort(
          (left, right) =>
            Math.abs(left - hintedIndex) - Math.abs(right - hintedIndex)
        )[0];
      }
    }
    if (selectedIndex < 0) return { source: "", selectedIndex: -1 };
    const sourcePoints = Array.from(normalizedSource);
    if (sourcePoints.length <= maximum) {
      return { source: normalizedSource, selectedIndex };
    }
    const prefixPoints = Array.from(normalizedSource.slice(0, selectedIndex)).length;
    const selectedPoints = Array.from(selected).length;
    const remaining = Math.max(0, maximum - selectedPoints);
    const start = Math.max(0, prefixPoints - Math.floor(remaining / 2));
    const boundedSource = sourcePoints.slice(start, start + maximum).join("");
    const boundedPrefix = sourcePoints.slice(start, prefixPoints).join("");
    return { source: boundedSource, selectedIndex: boundedPrefix.length };
  }

  function boundedContainer(
    source,
    selectedText,
    maximum = config.MAX_CONTAINER_CODE_POINTS,
    selectedIndexHint = -1
  ) {
    return boundedContainerDetails(source, selectedText, maximum, selectedIndexHint).source;
  }

  function sentenceAround(
    source,
    selectedText,
    maximum = config.MAX_CONTEXT_CODE_POINTS,
    selectedIndexHint = -1
  ) {
    const bounded = boundedContainerDetails(
      source,
      selectedText,
      config.MAX_CONTAINER_CODE_POINTS,
      selectedIndexHint
    );
    const normalizedSource = bounded.source;
    const selected = textUtils.normalizeText(selectedText);
    if (!normalizedSource) return null;

    const segments =
      typeof Intl?.Segmenter === "function"
        ? Array.from(
            new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(
              normalizedSource
            ),
            (item) => item.segment
          )
        : normalizedSource.split(/(?<=[.!?。！？])\s+/u);

    const selectedIndex = bounded.selectedIndex;
    if (selectedIndex < 0) return null;
    let cursor = 0;
    let matchIndex = Math.max(
      0,
      segments.findIndex((segment) => {
        const start = cursor;
        cursor += segment.length;
        return selectedIndex >= start && selectedIndex < cursor;
      })
    );

    let output = segments[matchIndex] || normalizedSource;
    for (let distance = 1; textUtils.countCodePoints(output) < maximum; distance += 1) {
      let changed = false;
      if (matchIndex - distance >= 0) {
        const candidate = `${segments[matchIndex - distance]} ${output}`;
        if (textUtils.countCodePoints(candidate) <= maximum) {
          output = candidate;
          changed = true;
        }
      }
      if (matchIndex + distance < segments.length) {
        const candidate = `${output} ${segments[matchIndex + distance]}`;
        if (textUtils.countCodePoints(candidate) <= maximum) {
          output = candidate;
          changed = true;
        }
      }
      if (!changed) break;
    }
    output = textUtils.normalizeText(output);
    if (textUtils.countCodePoints(output) <= maximum) return output;
    const outputPoints = Array.from(output);
    const selectionStart = output.indexOf(selected);
    const prefixPoints = Array.from(output.slice(0, Math.max(0, selectionStart))).length;
    const selectedPoints = Array.from(selected).length;
    const start = Math.max(
      0,
      prefixPoints - Math.floor(Math.max(0, maximum - selectedPoints) / 2)
    );
    return outputPoints.slice(start, start + maximum).join("");
  }

  function elementText(element) {
    if (!element) return "";
    const tagName = element.tagName?.toLowerCase();
    if (tagName === "input" || tagName === "textarea") {
      const labels = Array.from(element.labels || [], (label) => label.textContent || "");
      return [labels.join(" "), element.value].filter(Boolean).join(" ");
    }
    return element.innerText || element.textContent || "";
  }

  function selectionOffset(container, range, documentObject) {
    if (!container || !range?.startContainer || !documentObject?.createRange) return -1;
    try {
      const prefix = documentObject.createRange();
      prefix.selectNodeContents(container);
      prefix.setEnd(range.startContainer, range.startOffset);
      return textUtils.normalizeText(prefix.toString()).length;
    } catch {
      return -1;
    }
  }

  function containsRange(container, range) {
    if (!container || !range?.startContainer || !range?.endContainer) return true;
    const start =
      range.startContainer.nodeType === 1
        ? range.startContainer
        : range.startContainer.parentElement;
    const end =
      range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    return Boolean(container.contains?.(start) && container.contains?.(end));
  }

  function computedDisplay(element) {
    try {
      return (
        element?.ownerDocument?.defaultView?.getComputedStyle?.(element)?.display || ""
      ).toLowerCase();
    } catch {
      return "";
    }
  }

  function hasPageScaleBranches(element, range, normalizedText, selectedText) {
    const startElement =
      range?.startContainer?.nodeType === 1
        ? range.startContainer
        : range?.startContainer?.parentElement;
    let unrelatedBlocks = 0;
    for (const child of element?.children || []) {
      if (startElement && child.contains?.(startElement)) continue;
      if (!BLOCK_DISPLAYS.has(computedDisplay(child))) continue;
      if (textUtils.countCodePoints(elementText(child)) >= 20) unrelatedBlocks += 1;
      if (unrelatedBlocks >= 8) break;
    }
    return (
      unrelatedBlocks >= 8 &&
      textUtils.countCodePoints(normalizedText) >
        Math.max(400, textUtils.countCodePoints(selectedText) * 6)
    );
  }

  function findContextContainer({
    range = null,
    target = null,
    selectedText = "",
    maxAncestorDepth = MAX_ANCESTOR_DEPTH,
    maxContainerCodePoints = config.MAX_CONTAINER_CODE_POINTS
  }) {
    const selected = textUtils.normalizeText(selectedText);
    if (!selected) return null;
    let element =
      target?.nodeType === 1
        ? target
        : range?.commonAncestorContainer?.nodeType === 1
          ? range.commonAncestorContainer
          : range?.commonAncestorContainer?.parentElement;
    let nearestBlock = null;
    let nearestInline = null;

    for (let depth = 0; element && depth < maxAncestorDepth; depth += 1) {
      const tagName = element.tagName?.toLowerCase();
      if (["html", "body", "main"].includes(tagName)) break;
      if (!containsRange(element, range)) {
        element = element.parentElement;
        continue;
      }
      const normalizedText = textUtils.normalizeText(elementText(element));
      const length = textUtils.countCodePoints(normalizedText);
      if (length > maxContainerCodePoints) break;
      if (!normalizedText || !normalizedText.includes(selected)) {
        element = element.parentElement;
        continue;
      }
      if (hasPageScaleBranches(element, range, normalizedText, selected)) {
        element = element.parentElement;
        continue;
      }
      if (element.matches?.(BLOCK_SELECTOR)) return element;
      if (BLOCK_DISPLAYS.has(computedDisplay(element))) {
        nearestBlock ||= element;
      } else {
        nearestInline ||= element;
      }
      element = element.parentElement;
    }
    return nearestBlock || nearestInline;
  }

  function extractContext({
    range = null,
    target = null,
    selectedText = "",
    maximum = config.MAX_CONTEXT_CODE_POINTS
  }) {
    const block = findContextContainer({ range, target, selectedText });
    if (!block) return null;
    const offset = selectionOffset(block, range, block?.ownerDocument);
    return sentenceAround(elementText(block), selectedText, maximum, offset);
  }

  return {
    boundedContainer,
    findContextContainer,
    extractContext,
    MAX_ANCESTOR_DEPTH,
    selectionOffset,
    sentenceAround
  };
});
