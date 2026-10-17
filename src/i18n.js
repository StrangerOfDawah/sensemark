// User-facing strings live in _locales/<lang>/messages.json, never in code.
//
// t(key, ...values) returns a message with its $PLACEHOLDERS$ filled in.
// In the extension it uses chrome.i18n; under Node (unit tests, build scripts)
// it reads the same messages.json, so tests see exactly what users see.
//
// localize(document) fills static HTML: every <!--t:…--> comment becomes a
// text node, and a data-i18n-<attribute> holding a key sets that attribute. Comments keep
// the DOM shape and whitespace of the page identical to hand-written text.
(function exposeI18n(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkI18n = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (root) => {
  const LOCALE = "ru";
  let bundled = null;

  // Same substitution rules as chrome.i18n.getMessage, in one pass: "$$" is a
  // literal dollar, $NAME$ is a placeholder, and Chrome drops any other "$".
  function format(entry, values) {
    if (!entry) return "";
    const placeholders = entry.placeholders || {};
    const fill = (content) => content.replace(/\$(\d)/g, (_, index) => String(values[index - 1] ?? ""));
    return entry.message.replace(/\$\$|\$([a-z0-9_@]+)\$|\$/gi, (match, name) => {
      if (match === "$$") return "$";
      const placeholder = name && placeholders[name.toLowerCase()];
      return placeholder ? fill(placeholder.content) : "";
    });
  }

  function messages() {
    if (!bundled) bundled = require(`./_locales/${LOCALE}/messages.json`);
    return bundled;
  }

  function t(key, ...values) {
    const getMessage = root.chrome?.i18n?.getMessage;
    if (typeof getMessage === "function") {
      const text = getMessage.call(root.chrome.i18n, key, values.map(String));
      if (text) return text;
    }
    if (typeof module === "object" && module.exports) {
      const text = format(messages()[key], values);
      if (text) return text;
    }
    return key;
  }

  const ATTRIBUTES = ["title", "aria-label", "placeholder"];

  function localize(doc) {
    const walker = doc.createTreeWalker(doc.documentElement, 128 /* NodeFilter.SHOW_COMMENT */);
    const comments = [];
    while (walker.nextNode()) {
      if (walker.currentNode.data.startsWith("t:")) comments.push(walker.currentNode);
    }
    const parents = new Set();
    for (const comment of comments) {
      parents.add(comment.parentNode);
      comment.replaceWith(doc.createTextNode(t(comment.data.slice(2).trim())));
    }
    // Merge the text with the whitespace around it into one node, exactly as if
    // it had been written in the HTML; text shaping then matches to the pixel.
    for (const parent of parents) parent.normalize();
    for (const attribute of ATTRIBUTES) {
      for (const element of doc.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    const title = doc.querySelector("title[data-i18n]");
    if (title) title.textContent = t(title.dataset.i18n);
  }

  return { LOCALE, format, localize, messages, t };
});
