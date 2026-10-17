const assert = require("node:assert/strict");
const test = require("node:test");

const Theme = require("../../src/card-theme.js");
const { t } = require("../helpers/i18n.js");
const RU = require("../fixtures/russian.json");

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
  assert.ok(
    Theme.luminance(surface) > Theme.luminance(background),
    "the card is lighter than the background"
  );
  assert.ok(Theme.luminance(surface) < 0.05, "but stays dark");
  assert.ok(Theme.contrast(surface, hexRgb(palette.text)) >= 7, "the text is readable");
});

test("sepia page gets a warm card with readable text", () => {
  const background = rgb("rgb(244, 236, 216)");
  const palette = Theme.buildPalette({ background, text: rgb("rgb(59, 47, 32)") });
  const surface = hexRgb(palette.surface);
  assert.notEqual(palette.surface, "#ffffff");
  assert.ok(surface.r > surface.b, "the warm tint is kept");
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
  assert.equal(Theme.isLongSelection("First.\nSecond."), false, "two short paragraphs stay a card");
  assert.equal(
    Theme.isLongSelection(`${"a".repeat(70)}\n${"b".repeat(60)}`),
    true,
    "two paragraphs of 120+ characters"
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
  // Full-width text: no room on the right.
  assert.deepEqual(
    Theme.chooseLayout({ text: long, rect: { ...column, right: 1164 }, viewportWidth: 1200 }),
    {
      kind: "drawer",
      width: 420
    }
  );
  // On a narrow screen a panel would cover most of the text, so keep the card.
  assert.deepEqual(Theme.chooseLayout({ text: long, rect: { ...column, right: 560 }, viewportWidth: 600 }), {
    kind: "anchor"
  });
  // A little room: the note is narrower, but not below 300 px.
  assert.deepEqual(Theme.chooseLayout({ text: long, rect: { ...column, right: 850 }, viewportWidth: 1200 }), {
    kind: "margin",
    width: 306
  });
});

test("header label names paragraphs and the source language", () => {
  const label = t("labelTranslation");
  const fromEnglish = t("fromLanguage", RU.langEnglishGenitive);
  assert.equal(Theme.headerLabel({ language: RU.langEnglishGenitive }), `${label} · ${fromEnglish}`);
  assert.equal(
    Theme.headerLabel({ language: RU.langEnglishGenitive, paragraphs: 3, long: true }),
    `${label} · ${t("paragraphsFew", 3)} ${fromEnglish}`
  );
  assert.equal(Theme.headerLabel({ paragraphs: 5, long: true }), `${label} · ${t("paragraphsMany", 5)}`);
  assert.equal(Theme.headerLabel({ paragraphs: 3 }), label);
  // Russian plural forms: 21 takes "one", 12 takes "many", 22 takes "few".
  assert.equal(Theme.paragraphsLabel(21), t("paragraphsOne", 21));
  assert.equal(Theme.paragraphsLabel(12), t("paragraphsMany", 12));
  assert.equal(Theme.paragraphsLabel(22), t("paragraphsFew", 22));
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
