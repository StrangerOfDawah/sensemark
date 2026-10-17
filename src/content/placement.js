// Where the card, the status pill and the margin bracket go on screen.
//
// Pure geometry: every function takes rectangles in viewport coordinates and
// returns numbers, so it is unit-tested without a browser. content.js adds the
// page scroll offset when it applies the result.
(function exposePlacement(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkPlacement = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const CARD_GAP = 12; // between the selection and the card
  const SCREEN_MARGIN = 10; // keep the card this far from the window edges
  const NOTCH_INSET = 18; // the notch never sits in the rounded corner
  const MARGIN_NOTE_GAP = 28; // margin note: room for the bracket
  const BRACKET_GAP = 10;
  const PILL_HEIGHT = 28;
  const PILL_GAP = 8;

  // Card under (or above) a short selection, with a notch pointing at it.
  // side: "below" | "above" | "free" (fits neither way — kept on screen
  // without a notch). offset lets the card follow the text while scrolling.
  function anchorPlacement({ rect, box, viewport }) {
    let top;
    let side;
    if (rect.bottom + CARD_GAP + box.height <= viewport.height - SCREEN_MARGIN) {
      side = "below";
      top = rect.bottom + CARD_GAP;
    } else if (rect.top - CARD_GAP - box.height >= SCREEN_MARGIN) {
      side = "above";
      top = rect.top - CARD_GAP - box.height;
    } else {
      side = "free";
      top = Math.max(
        SCREEN_MARGIN,
        Math.min(rect.bottom + CARD_GAP, viewport.height - box.height - SCREEN_MARGIN)
      );
    }
    // A selection wider than the card: align to its start; otherwise centre.
    const wide = rect.width > box.width;
    const pointX = wide ? rect.left + 28 : rect.left + rect.width / 2;
    let left = wide ? rect.left - 6 : pointX - box.width / 2;
    left = Math.max(SCREEN_MARGIN, Math.min(left, viewport.width - box.width - SCREEN_MARGIN));
    const notchX = Math.max(NOTCH_INSET, Math.min(pointX - left, box.width - NOTCH_INSET));
    const offset = {
      x: left - rect.left,
      y: side === "above" ? top + box.height - rect.top : top - rect.bottom,
      side
    };
    return { top, left, side, notchX, offset };
  }

  // The same card on later scrolls: keep the side and offset chosen before,
  // so it moves together with the text instead of jumping around.
  function followAnchor({ rect, box, offset }) {
    const left = rect.left + offset.x;
    const top = offset.side === "above" ? rect.top + offset.y - box.height : rect.bottom + offset.y;
    return { top, left };
  }

  // Margin note to the right of a long selection. While the selection is on
  // screen the note stays next to it, but never runs past its end.
  function marginPlacement({ rect, box }) {
    return {
      left: rect.right + MARGIN_NOTE_GAP,
      top: Math.max(rect.top, Math.min(16, rect.bottom - box.height)),
      bracket: {
        left: rect.right + BRACKET_GAP,
        top: rect.top,
        height: Math.max(16, rect.height)
      }
    };
  }

  // Where the status pill sits for each layout. `origin` is the point the
  // card later grows from, so the pill visually turns into the card.
  function statusPlacement({ rect, kind, viewport }) {
    if (kind === "drawer") {
      return { fixed: true, origin: { x: viewport.width - 16, y: 16, fixed: true } };
    }
    let x;
    let y;
    if (kind === "margin") {
      x = rect.right + MARGIN_NOTE_GAP;
      y = Math.max(rect.top, Math.min(16, rect.bottom - PILL_HEIGHT));
    } else {
      x = Math.max(SCREEN_MARGIN, Math.min(rect.left, viewport.width - 200));
      y =
        rect.bottom + PILL_GAP + PILL_HEIGHT > viewport.height
          ? rect.top - PILL_GAP - PILL_HEIGHT
          : rect.bottom + PILL_GAP;
    }
    return { fixed: false, x, y, origin: { x, y: y + PILL_HEIGHT / 2 } };
  }

  return { anchorPlacement, followAnchor, marginPlacement, statusPlacement };
});
