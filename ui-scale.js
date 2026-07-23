(function exposeScale(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkScale = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const DEFAULTS = {
    min: 0.75,
    max: 2.2,
    step: 0.02,
    intervalMs: 70
  };

  function createScaleController(options = {}) {
    const config = { ...DEFAULTS, ...options };
    let lastAppliedAt = -Infinity;

    function reset() {
      lastAppliedAt = -Infinity;
    }

    function next(currentScale, deltaY, now) {
      if (!deltaY) return { changed: false, value: currentScale, reason: "zero" };
      if (now - lastAppliedAt < config.intervalMs) {
        return { changed: false, value: currentScale, reason: "throttled" };
      }
      lastAppliedAt = now;

      const direction = deltaY > 0 ? -1 : 1;
      const value = Math.round(
        Math.min(config.max, Math.max(config.min, currentScale + direction * config.step)) * 100
      ) / 100;
      if (value === currentScale) {
        return { changed: false, value, reason: "limit" };
      }
      return { changed: true, value, reason: "applied" };
    }

    return { next, reset };
  }

  return { DEFAULTS, createScaleController };
});
