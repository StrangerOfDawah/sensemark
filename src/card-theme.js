// "Chameleon" card styling: page-matched colours and where the card goes on screen.
// Pure DOM-free functions covered by unit tests; content.js only measures
// the page's background colour, text colour and the selection size.
(function exposeCardTheme(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkCardTheme = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const WHITE = { r: 255, g: 255, b: 255 };
  const BLACK = { r: 0, g: 0, b: 0 };

  // Ready-made palettes for the manual "Light" / "Dark" choice.
  const LIGHT = {
    surface: "#ffffff",
    border: "#e3e3e8",
    text: "#16171c",
    sec: "#62646f",
    fill: "rgba(22, 23, 28, 0.06)",
    fillHover: "rgba(22, 23, 28, 0.11)",
    accent: "#5e5ce6",
    track: "#e6e6ef",
    shadow: "0 14px 36px rgba(0, 0, 0, 0.14), 0 2px 4px rgba(0, 0, 0, 0.05)",
    scheme: "light"
  };
  const DARK = {
    surface: "#1c1f26",
    border: "#30363d",
    text: "#eef2f7",
    sec: "#a3adbb",
    fill: "rgba(255, 255, 255, 0.07)",
    fillHover: "rgba(255, 255, 255, 0.12)",
    accent: "#9d9bff",
    track: "#313744",
    shadow: "0 16px 40px rgba(0, 0, 0, 0.5), 0 1px 2px rgba(0, 0, 0, 0.3)",
    scheme: "dark"
  };

  const FONTS = {
    system: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif',
    golos: '"Sensemark Golos", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    literata: '"Sensemark Literata", Georgia, "Times New Roman", serif'
  };

  // "Long" selection threshold: 300+ characters, or two or more paragraphs
  // with at least 120 characters together. A short paragraph (or a couple of short
  // lines like "Hello / World") stays a card under the text.
  const LONG_CHARS = 300;
  const LONG_PARAGRAPHS_CHARS = 120;
  const NOTE = { min: 300, max: 400, gap: 28, edge: 16 };
  const DRAWER = { max: 420, min: 320 };
  const NARROW_VIEWPORT = 640;

  function parseColor(value) {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/i);
    if (!match) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((part) => !Number.isFinite(part))) return null;
    const alpha = parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  }

  function channel(value) {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }

  function luminance({ r, g, b }) {
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  }

  function contrast(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  // Mix colour b into a by the given share.
  function mix(a, b, share) {
    return {
      r: Math.round(a.r + (b.r - a.r) * share),
      g: Math.round(a.g + (b.g - a.g) * share),
      b: Math.round(a.b + (b.b - a.b) * share)
    };
  }

  function hex({ r, g, b }) {
    return `#${[r, g, b].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }

  function rgba({ r, g, b }, alpha) {
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function saturation({ r, g, b }) {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    return max === 0 ? 0 : (max - min) / max;
  }

  // Page-matched palette: on a dark site the card is one step lighter than the background,
  // on a warm (sepia) page it takes the same tint, on a plain white page it is white.
  function adaptivePalette(background, pageText) {
    const bg = background;
    if (luminance(bg) < 0.3) {
      const surface = mix(bg, WHITE, 0.07);
      const text = hexToRgb(DARK.text);
      return {
        ...DARK,
        surface: hex(surface),
        border: hex(mix(bg, WHITE, 0.17)),
        sec: hex(mix(surface, text, 0.66)),
        track: hex(mix(bg, WHITE, 0.2))
      };
    }
    if (luminance(bg) > 0.88 && saturation(bg) < 0.06) return { ...LIGHT };

    const surface = mix(bg, WHITE, 0.55);
    let text = hexToRgb(LIGHT.text);
    if (pageText && luminance(pageText) < 0.2) {
      const candidate = mix(pageText, BLACK, 0.2);
      if (contrast(candidate, surface) >= 7) text = candidate;
    }
    const shade = mix(bg, BLACK, 0.6);
    return {
      ...LIGHT,
      surface: hex(surface),
      border: hex(mix(bg, BLACK, 0.1)),
      text: hex(text),
      sec: hex(mix(surface, text, 0.66)),
      fill: rgba(text, 0.06),
      fillHover: rgba(text, 0.11),
      track: hex(mix(bg, BLACK, 0.08)),
      shadow: `0 14px 34px ${rgba(shade, 0.16)}, 0 2px 4px ${rgba(shade, 0.06)}`
    };
  }

  function hexToRgb(value) {
    const raw = value.replace("#", "");
    return {
      r: parseInt(raw.slice(0, 2), 16),
      g: parseInt(raw.slice(2, 4), 16),
      b: parseInt(raw.slice(4, 6), 16)
    };
  }

  // mode: "auto" (match the page), "light" or "dark".
  // background/text: the page colours (rgb), when they could be read.
  function buildPalette({ mode = "auto", background = null, text = null, prefersDark = false } = {}) {
    if (mode === "light") return { ...LIGHT };
    if (mode === "dark") return { ...DARK };
    if (!background) return prefersDark ? { ...DARK } : { ...LIGHT };
    return adaptivePalette(background, text);
  }

  // CSS custom properties for the card and the pill.
  function cssVariables(palette, { font = "system", fontSize = null } = {}) {
    const vars = {
      "--surface": palette.surface,
      "--border": palette.border,
      "--text": palette.text,
      "--sec": palette.sec,
      "--fill": palette.fill,
      "--fill-hover": palette.fillHover,
      "--hair": palette.fill,
      "--accent": palette.accent,
      "--track": palette.track,
      "--shadow": palette.shadow,
      "--tr-font": FONTS[font] || FONTS.system
    };
    if (fontSize) vars["--tr-size"] = `${fontSize}px`;
    return vars;
  }

  // Translation text size "as on the page", within sensible bounds.
  function readableSize(pagePx, matchPage = true) {
    if (!matchPage) return 15;
    const value = Number.parseFloat(pagePx);
    if (!Number.isFinite(value)) return 15;
    return Math.round(Math.min(22, Math.max(13, value)) * 2) / 2;
  }

  function countParagraphs(text) {
    return String(text || "")
      .split(/\n+/)
      .filter((line) => line.trim()).length;
  }

  function isLongSelection(text) {
    const length = String(text || "").trim().length;
    if (length >= LONG_CHARS) return true;
    return countParagraphs(text) >= 2 && length >= LONG_PARAGRAPHS_CHARS;
  }

  // Where to show the translation:
  //  anchor: a card under (or above) the selection, for words and short phrases;
  //  margin: a note in the right margin of a long selection, the text stays visible;
  //  drawer: a panel at the right window edge when there is no room beside the text.
  function chooseLayout({ text, rect, viewportWidth }) {
    if (!isLongSelection(text) || viewportWidth < NARROW_VIEWPORT) return { kind: "anchor" };
    const space = viewportWidth - rect.right - NOTE.gap - NOTE.edge;
    if (space >= NOTE.min) return { kind: "margin", width: Math.min(NOTE.max, Math.floor(space)) };
    const width = Math.max(DRAWER.min, Math.min(DRAWER.max, Math.round(viewportWidth * 0.4)));
    return { kind: "drawer", width: Math.min(width, viewportWidth - 24) };
  }

  function paragraphsLabel(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    const word =
      mod10 === 1 && mod100 !== 11
        ? "абзац"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "абзаца"
          : "абзацев";
    return `${count} ${word}`;
  }

  // "Перевод · с английского", "Перевод · 3 абзаца с английского".
  function headerLabel({ language = "", paragraphs = 1, long = false } = {}) {
    const parts = [];
    if (long && paragraphs > 1) parts.push(paragraphsLabel(paragraphs));
    if (language) parts.push(`с ${language}`);
    return parts.length ? `Перевод · ${parts.join(" ")}` : "Перевод";
  }

  return {
    DARK,
    FONTS,
    LIGHT,
    LONG_CHARS,
    buildPalette,
    chooseLayout,
    contrast,
    countParagraphs,
    cssVariables,
    headerLabel,
    isLongSelection,
    luminance,
    paragraphsLabel,
    parseColor,
    readableSize
  };
});
