(function exposeCardPositioner(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkCardPositioner = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function clamp(value, minimum, maximum) {
    return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
  }

  function positionCard(anchor, cardSize, viewport, options = {}) {
    const gap = options.gap ?? 10;
    const margin = options.margin ?? 12;
    const fallbackAnchor = {
      left: viewport.width / 2,
      right: viewport.width / 2,
      top: viewport.height / 2,
      bottom: viewport.height / 2,
      width: 0,
      height: 0
    };
    const target = anchor || fallbackAnchor;
    const below = target.bottom + gap;
    const above = target.top - cardSize.height - gap;
    const fitsBelow = below + cardSize.height <= viewport.height - margin;
    const fitsAbove = above >= margin;
    const top = fitsBelow || !fitsAbove ? below : above;
    const left = target.left + (target.width || target.right - target.left || 0) / 2 - cardSize.width / 2;
    return {
      left: Math.round(clamp(left, margin, viewport.width - cardSize.width - margin)),
      top: Math.round(clamp(top, margin, viewport.height - cardSize.height - margin))
    };
  }

  function clampPosition(position, cardSize, viewport, margin = 8) {
    return {
      left: Math.round(clamp(position.left, margin, viewport.width - cardSize.width - margin)),
      top: Math.round(clamp(position.top, margin, viewport.height - cardSize.height - margin))
    };
  }

  function clampSize(cardSize, viewport, margin = 12) {
    const maximumWidth = Math.max(1, viewport.width - margin * 2);
    const maximumHeight = Math.max(1, viewport.height - margin * 2);
    return {
      width: Math.round(clamp(cardSize.width, Math.min(240, maximumWidth), maximumWidth)),
      height: Math.round(clamp(cardSize.height, Math.min(120, maximumHeight), maximumHeight))
    };
  }

  return { clamp, clampPosition, clampSize, positionCard };
});
