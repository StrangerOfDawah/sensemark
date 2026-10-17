const assert = require("node:assert/strict");
const test = require("node:test");

const Theme = require("../../src/card-theme.js");

const rgb = (value) => Theme.parseColor(value);

test("parses computed colors, including transparent and invalid ones", () => {
  assert.deepEqual(rgb("rgb(13, 17, 23)"), { r: 13, g: 17, b: 23, a: 1 });
  assert.deepEqual(rgb("rgba(0, 0, 0, 0)"), { r: 0, g: 0, b: 0, a: 0 });
  assert.deepEqual(rgb("rgb(244 236 216 / 0.5)"), { r: 244, g: 236, b: 216, a: 0.5 });
  assert.equal(rgb("transparent"), null);
  assert.equal(rgb(""), null);
});

test("white page gets the plain light card", () => {
  const palette = Theme.buildPalette({ background: rgb("rgb(255, 255, 255)"), text: rgb("rgb(34, 34, 34)") });
  assert.equal(palette.surface, "#ffffff");
  assert.equal(palette.scheme, "light");
});

test("dark page gets a dark card one step lighter than the page", () => {
  const background = rgb("rgb(13, 17, 23)");
  const palette = Theme.buildPalette({ background, text: rgb("rgb(201, 209, 217)") });
  assert.equal(palette.scheme, "dark");
  const surface = Theme.parseColor(`rgb(${hexParts(palette.surface)})`);
  assert.ok(Theme.luminance(surface) > Theme.luminance(background), "карточка светлее фона");
  assert.ok(Theme.luminance(surface) < 0.05, "но остаётся тёмной");
  assert.ok(Theme.contrast(surface, hexRgb(palette.text)) >= 7, "текст читается");
});

test("sepia page gets a warm card with readable text", () => {
  const background = rgb("rgb(244, 236, 216)");
  const palette = Theme.buildPalette({ background, text: rgb("rgb(59, 47, 32)") });
  const surface = hexRgb(palette.surface);
  assert.notEqual(palette.surface, "#ffffff");
  assert.ok(surface.r > surface.b, "тёплый оттенок сохраняется");
  assert.ok(Theme.contrast(surface, hexRgb(palette.text)) >= 7);
});

test("manual theme ignores the page; unknown page follows the system", () => {
  const dark = rgb("rgb(13, 17, 23)");
  assert.equal(Theme.buildPalette({ mode: "light", background: dark }).surface, Theme.LIGHT.surface);
  assert.equal(
    Theme.buildPalette({ mode: "dark", background: rgb("rgb(255,255,255)") }).surface,
    Theme.DARK.surface
  );
  assert.equal(Theme.buildPalette({ background: null, prefersDark: true }).scheme, "dark");
  assert.equal(Theme.buildPalette({ background: null }).scheme, "light");
});

test("css variables carry the palette, the font and the size", () => {
  const vars = Theme.cssVariables(Theme.LIGHT, { font: "literata", fontSize: 17 });
  assert.equal(vars["--surface"], "#ffffff");
  assert.match(vars["--tr-font"], /^"Sensemark Literata"/);
  assert.equal(vars["--tr-size"], "17px");
  assert.equal(Theme.cssVariables(Theme.DARK, { font: "unknown" })["--tr-font"], Theme.FONTS.system);
  assert.equal(Theme.cssVariables(Theme.DARK)["--tr-size"], undefined);
});

test("translation size follows the page within readable limits", () => {
  assert.equal(Theme.readableSize("17px"), 17);
  assert.equal(Theme.readableSize("9px"), 13);
  assert.equal(Theme.readableSize("40px"), 22);
  assert.equal(Theme.readableSize("16.3px"), 16.5);
  assert.equal(Theme.readableSize("abc"), 15);
  assert.equal(Theme.readableSize("20px", false), 15);
});

test("long selection: more than one paragraph or at least 300 characters", () => {
  assert.equal(Theme.isLongSelection("One short paragraph."), false);
  assert.equal(Theme.isLongSelection("First.\nSecond."), false, "два коротких абзаца остаются карточкой");
  assert.equal(
    Theme.isLongSelection(`${"a".repeat(70)}\n${"b".repeat(60)}`),
    true,
    "два абзаца от 120 символов"
  );
  assert.equal(Theme.isLongSelection("a".repeat(299)), false);
  assert.equal(Theme.isLongSelection("a".repeat(300)), true);
  assert.equal(Theme.countParagraphs("A\n\nB\n  \nC"), 3);
});

test("layout: short text under the selection, long text on the margin or in a drawer", () => {
  const long = `${"First paragraph is long enough. ".repeat(3)}\n${"Second one too. ".repeat(3)}`;
  const column = { left: 90, right: 690, top: 100, bottom: 400 };

  assert.deepEqual(Theme.chooseLayout({ text: "Hello world", rect: column, viewportWidth: 1200 }), {
    kind: "anchor"
  });
  assert.deepEqual(Theme.chooseLayout({ text: long, rect: column, viewportWidth: 1200 }), {
    kind: "margin",
    width: 400
  });
  // Текст на всю ширину — справа места нет.
  assert.deepEqual(
    Theme.chooseLayout({ text: long, rect: { ...column, right: 1164 }, viewportWidth: 1200 }),
    {
      kind: "drawer",
      width: 420
    }
  );
  // На узком экране панель закрыла бы почти весь текст — оставляем карточку.
  assert.deepEqual(Theme.chooseLayout({ text: long, rect: { ...column, right: 560 }, viewportWidth: 600 }), {
    kind: "anchor"
  });
  // Немного места: заметка уже, но не меньше 300 px.
  assert.deepEqual(Theme.chooseLayout({ text: long, rect: { ...column, right: 850 }, viewportWidth: 1200 }), {
    kind: "margin",
    width: 306
  });
});

test("header label names paragraphs and the source language", () => {
  assert.equal(Theme.headerLabel({ language: "английского" }), "Перевод · с английского");
  assert.equal(
    Theme.headerLabel({ language: "английского", paragraphs: 3, long: true }),
    "Перевод · 3 абзаца с английского"
  );
  assert.equal(Theme.headerLabel({ paragraphs: 5, long: true }), "Перевод · 5 абзацев");
  assert.equal(Theme.headerLabel({ paragraphs: 3 }), "Перевод");
  assert.equal(Theme.paragraphsLabel(21), "21 абзац");
  assert.equal(Theme.paragraphsLabel(12), "12 абзацев");
});

function hexRgb(value) {
  const raw = value.replace("#", "");
  return {
    r: parseInt(raw.slice(0, 2), 16),
    g: parseInt(raw.slice(2, 4), 16),
    b: parseInt(raw.slice(4, 6), 16)
  };
}

function hexParts(value) {
  const { r, g, b } = hexRgb(value);
  return `${r}, ${g}, ${b}`;
}
