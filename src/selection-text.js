(function exposeSelectionText(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkSelectionText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const DIRECTIONAL_CONTROL = /[؜‎‏‪-‮⁦-⁩]/gu;
  // Soft hyphen, zero-width space and BOM are invisible and carry no meaning.
  // ZWJ/ZWNJ (U+200D, U+200C) are kept: Persian, Hindi and emoji need them.
  const INVISIBLE_CHARS = /[\u00AD\u200B\uFEFF]/gu;
  // Private Use Area: icon-font glyphs (arrows, "share" and so on).
  // Real text in any language never falls into these ranges.
  const PRIVATE_USE = /[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

  function stripInvisible(value) {
    return String(value || "")
      .replace(DIRECTIONAL_CONTROL, "")
      .replace(INVISIBLE_CHARS, "")
      .replace(PRIVATE_USE, "");
  }

  // Spaces inside a line collapse; line breaks (paragraphs) are kept.
  function normalizeSelectionText(value) {
    return stripInvisible(value)
      .replace(/[^\S\n]+/gu, " ")
      .replace(/ *\n */gu, "\n")
      .replace(/\n{2,}/gu, "\n")
      .trim();
  }

  function partText(part) {
    if (part?.lineBreak) return "\n";
    const text = stripInvisible(part?.text);
    // In normal layout a line break in the HTML source is just a space.
    // Only in preformatted blocks (code, poetry) is it real.
    return part?.preserveLines ? text.replace(/[^\S\n]+/gu, " ") : text.replace(/\s+/gu, " ");
  }

  // parts: selection fragments in order: { text, noise, block, lineBreak, preserveLines }.
  // Fragments of one block (paragraph) are joined as is; blocks are separated by a line break.
  // Without block (the old format) fragments are separated by a space.
  function joinSelectionParts(parts) {
    const normalized = (Array.isArray(parts) ? parts : []).map((part) => ({
      text: partText(part),
      noise: Boolean(part?.noise),
      block: part?.block,
      lineBreak: Boolean(part?.lineBreak)
    }));

    const meaningful = normalized.filter((part) => !part.lineBreak && part.text.trim());
    if (!meaningful.length) return "";
    // If only a UI element is selected (for example a single button), translate it.
    const keepNoise = meaningful.every((part) => part.noise);
    const kept = normalized.filter((part) => keepNoise || !part.noise);

    let result = "";
    let previous = null;
    for (const part of kept) {
      if (previous) {
        if (part.block === undefined || previous.block === undefined) result += " ";
        else if (part.block !== previous.block) result += "\n";
      }
      result += part.text;
      previous = part;
    }
    return normalizeSelectionText(result);
  }

  return {
    joinSelectionParts,
    normalizeSelectionText
  };
});
