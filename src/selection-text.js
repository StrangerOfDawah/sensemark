(function exposeSelectionText(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkSelectionText = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const DIRECTIONAL_CONTROL = /[؜‎‏‪-‮⁦-⁩]/gu;
  // Мягкий перенос, zero-width space и BOM не видны и смысла не несут.
  // ZWJ/ZWNJ (‌, ‍) не трогаем: они нужны персидскому, хинди и эмодзи.
  const INVISIBLE_CHARS = /[\u00AD\u200B\uFEFF]/gu;
  // Private Use Area — символы иконочных шрифтов (стрелки, «поделиться» и т. п.).
  // Настоящий текст на любом языке в эти диапазоны не попадает.
  const PRIVATE_USE = /[-\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;

  function stripInvisible(value) {
    return String(value || "")
      .replace(DIRECTIONAL_CONTROL, "")
      .replace(INVISIBLE_CHARS, "")
      .replace(PRIVATE_USE, "");
  }

  // Пробелы внутри строки схлопываются, переводы строк (абзацы) сохраняются.
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
    // В обычной вёрстке перенос строки в исходнике HTML — это просто пробел.
    // Только в preformatted-блоках (код, стихи) он настоящий.
    return part?.preserveLines ? text.replace(/[^\S\n]+/gu, " ") : text.replace(/\s+/gu, " ");
  }

  // parts — фрагменты выделения по порядку: { text, noise, block, lineBreak, preserveLines }.
  // Фрагменты одного блока (абзаца) склеиваются как есть, между блоками — перенос строки.
  // Без block (старый формат) фрагменты разделяются пробелом.
  function joinSelectionParts(parts) {
    const normalized = (Array.isArray(parts) ? parts : []).map((part) => ({
      text: partText(part),
      noise: Boolean(part?.noise),
      block: part?.block,
      lineBreak: Boolean(part?.lineBreak)
    }));

    const meaningful = normalized.filter((part) => !part.lineBreak && part.text.trim());
    if (!meaningful.length) return "";
    // Если выделен только элемент интерфейса (например, одна кнопка), переводим его.
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
