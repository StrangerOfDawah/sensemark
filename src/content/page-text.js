// Reading the selection from the page: visible text only, interface noise
// removed, paragraphs kept, plus the sentence around a single word and the
// page colours the card adapts to.
//
// These functions run in the page (content script) and use the page DOM
// directly; content.js wires them into the translation flow.
(function exposePageText(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkPageText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  // A selection inside an input or editor is editing, not reading.
  function isEditableSelection() {
    const active = document.activeElement;
    if (active && (/^(?:INPUT|TEXTAREA|SELECT)$/.test(active.tagName) || active.isContentEditable)) {
      return true;
    }
    const anchor = window.getSelection()?.anchorNode;
    const element = anchor?.nodeType === Node.TEXT_NODE ? anchor.parentElement : anchor;
    return Boolean(element?.isContentEditable);
  }

  // Background and text colour where the user is reading: the card
  // adapts to the page from them. Transparent layers are skipped to the first background.
  function samplePage(range) {
    const node = range.startContainer;
    const start = (node.nodeType === Node.TEXT_NODE ? node.parentElement : node) || document.body;
    let background = null;
    for (let element = start; element; element = element.parentElement) {
      const color = globalThis.SensemarkCardTheme.parseColor(getComputedStyle(element).backgroundColor);
      if (color && color.a >= 0.5) {
        background = color;
        break;
      }
    }
    if (!background) {
      // The page has no background of its own: Chrome paints white, and dark only
      // if the site itself declares a dark colour scheme.
      const scheme = getComputedStyle(document.documentElement).colorScheme || "";
      const dark = /dark/.test(scheme) && !/light/.test(scheme);
      background = dark ? { r: 18, g: 18, b: 18, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
    }
    const style = getComputedStyle(start);
    return {
      background,
      text: globalThis.SensemarkCardTheme.parseColor(style.color),
      fontSize: style.fontSize
    };
  }

  function extractVisibleRangeText(range) {
    const root = range.commonAncestorContainer;
    const nodes = [];
    // Per-selection caches: when the whole page is selected, getComputedStyle would
    // otherwise run again for every ancestor of every text node.
    const cache = { visible: new Map(), block: new Map(), noise: new Map() };

    if (root.nodeType === Node.TEXT_NODE) {
      nodes.push(root);
    } else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
        acceptNode: (node) =>
          node.nodeType === Node.TEXT_NODE || node.nodeName === "BR"
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_SKIP
      });
      let node;
      while ((node = walker.nextNode())) nodes.push(node);
    }

    const parts = [];
    for (const node of nodes) {
      try {
        if (!range.intersectsNode(node)) continue;
        const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
        if (!element) continue;

        if (node.nodeName === "BR") {
          if (!isVisibleElement(element, cache.visible)) continue;
          parts.push({
            lineBreak: true,
            block: blockOf(element, cache.block),
            noise: isNoiseElement(element, cache.noise)
          });
          continue;
        }

        if (!isVisibleTextNode(node, cache.visible)) continue;

        let start = 0;
        let end = node.data.length;
        if (node === range.startContainer) start = range.startOffset;
        if (node === range.endContainer) end = range.endOffset;
        const part = node.data.slice(start, end);
        if (!part) continue;

        parts.push({
          text: part,
          block: blockOf(element, cache.block),
          noise: isNoiseElement(element, cache.noise),
          preserveLines: /^(?:pre|break-spaces)/.test(getComputedStyle(element).whiteSpace || "")
        });
      } catch {
        // Some complex Ranges on dynamic pages cannot be intersected.
      }
    }
    return globalThis.SensemarkSelectionText.joinSelectionParts(parts);
  }

  // Nearest block ancestor: text inside one block is one paragraph.
  function blockOf(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      const display = getComputedStyle(current).display;
      if (display && !display.startsWith("inline") && display !== "contents") break;
      current = current.parentElement;
    }
    const block = current || document.body;
    cache.set(element, block);
    return block;
  }

  // UI noise common to every site: controls, menus and
  // navigation, the site header/footer/sidebar, footnote links.
  // Links inside text are content and are left alone.
  const CONTROL_SELECTOR =
    "button, input, select, textarea, option, summary, nav, menu, " +
    '[role="button"], [role="menuitem"], [role="menu"], [role="menubar"], ' +
    '[role="navigation"], [role="toolbar"], [role="tablist"], [role="tab"], ' +
    '[role="search"], [role="tooltip"]';

  const SITE_CHROME_SELECTOR =
    'header, footer, aside, [role="banner"], [role="contentinfo"], [role="complementary"]';

  const CONTENT_SELECTOR = 'article, main, [role="main"], [role="article"]';

  function isNoiseElement(element, cache) {
    if (cache.has(element)) return cache.get(element);
    let noise = Boolean(element.closest(CONTROL_SELECTOR));
    if (!noise) {
      // An article header with its title is content; the site-wide header is not.
      const chrome = element.closest(SITE_CHROME_SELECTOR);
      noise = Boolean(chrome && !chrome.closest(CONTENT_SELECTOR));
    }
    if (!noise) {
      // A footnote like [1] is a superscript link. A plain x² stays.
      const sup = element.closest("sup");
      noise = Boolean(sup && (sup.querySelector("a") || sup.closest("a")));
    }
    cache.set(element, noise);
    return noise;
  }

  function extractSelectedImages(range) {
    const root =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    if (!root) return [];

    const images = root.matches?.("img") ? [root] : [...root.querySelectorAll("img")];
    return images.filter((image) => {
      try {
        if (!range.intersectsNode(image) || !isVisibleElement(image)) return false;
        const rect = image.getBoundingClientRect();
        return rect.width >= 12 && rect.height >= 12;
      } catch {
        return false;
      }
    });
  }

  function isVisibleElement(element, cache = new Map()) {
    if (!element || element === document.documentElement) return true;
    if (cache.has(element)) return cache.get(element);

    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hidden =
      element.hidden ||
      element.inert ||
      element.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0 ||
      style.clipPath === "inset(50%)" ||
      (style.position === "absolute" && style.overflow === "hidden" && rect.width <= 1 && rect.height <= 1);

    const visible = !hidden && isVisibleElement(element.parentElement, cache);
    cache.set(element, visible);
    return visible;
  }

  function isVisibleTextNode(node, cache) {
    if (!node.parentElement || !isVisibleElement(node.parentElement, cache)) return false;

    const probe = document.createRange();
    probe.selectNodeContents(node);
    return [...probe.getClientRects()].some((rect) => rect.width > 1 && rect.height > 1);
  }

  function isShort(text) {
    return text.length <= 40 && text.split(/\s+/).length <= 3;
  }

  // Nearest block ancestor: the sentence never crosses its boundaries.
  function nearestBlock(node) {
    let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    while (element && element !== document.body) {
      const display = getComputedStyle(element).display;
      if (display && !display.startsWith("inline") && display !== "contents") {
        return element;
      }
      element = element.parentElement;
    }
    return element || document.body;
  }

  function extractContext(range, selectedText) {
    const block = nearestBlock(range.startContainer);
    if (!block) return null;

    let full;
    let offset;
    try {
      const whole = document.createRange();
      whole.selectNodeContents(block);
      full = whole.toString();

      const before = document.createRange();
      before.selectNodeContents(block);
      before.setEnd(range.startContainer, range.startOffset);
      offset = before.toString().length;
    } catch {
      return null; // a selection across nodes that Range could not handle
    }

    if (!full || offset < 0 || offset > full.length) return null;

    const LOOKAROUND = 400;
    const BOUNDARY = /[.!?…\n\r]/;

    let start = offset;
    while (start > 0 && offset - start < LOOKAROUND && !BOUNDARY.test(full[start - 1])) {
      start--;
    }

    let end = offset + selectedText.length;
    const from = end;
    while (end < full.length && end - from < LOOKAROUND && !BOUNDARY.test(full[end])) {
      end++;
    }
    if (end < full.length) end++; // take the sentence-ending mark itself

    const sentence = full.slice(start, end).replace(/\s+/g, " ").trim();

    // Context helps only if it is really wider than the selection and contains it.
    if (sentence.length <= selectedText.length + 5) return null;
    if (!sentence.includes(selectedText)) return null;

    return sentence;
  }

  return {
    extractContext,
    extractSelectedImages,
    extractVisibleRangeText,
    isEditableSelection,
    isShort,
    isVisibleElement,
    samplePage
  };
});
