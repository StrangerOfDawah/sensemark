(function exposeCardGrowthController(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkCardGrowthController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function createCardGrowthController({
    element,
    isVisible = () => true,
    isManual = () => false,
    onAnchored,
    onManual,
    ResizeObserverClass = globalThis.ResizeObserver,
    scheduleFrame = globalThis.requestAnimationFrame,
    cancelFrame = globalThis.cancelAnimationFrame,
    minimumDelta = 1
  }) {
    if (!element) throw new TypeError("Card element is required.");
    let observer = null;
    let frame = 0;
    let active = false;
    let lastSize = null;

    function run() {
      frame = 0;
      if (!active || !isVisible()) return;
      if (isManual()) onManual?.();
      else onAnchored?.();
    }

    function schedule() {
      if (frame || typeof scheduleFrame !== "function") return;
      frame = scheduleFrame(run) || 1;
    }

    function observed(entries) {
      const rect = entries?.at?.(-1)?.contentRect || element.getBoundingClientRect();
      const size = { width: Number(rect?.width) || 0, height: Number(rect?.height) || 0 };
      if (
        lastSize &&
        Math.abs(size.width - lastSize.width) < minimumDelta &&
        Math.abs(size.height - lastSize.height) < minimumDelta
      ) {
        return;
      }
      lastSize = size;
      schedule();
    }

    function start() {
      if (active || typeof ResizeObserverClass !== "function") return false;
      active = true;
      const rect = element.getBoundingClientRect();
      lastSize = { width: Number(rect.width) || 0, height: Number(rect.height) || 0 };
      observer = new ResizeObserverClass(observed);
      observer.observe(element);
      return true;
    }

    function stop() {
      active = false;
      observer?.disconnect?.();
      observer = null;
      lastSize = null;
      if (frame && typeof cancelFrame === "function") cancelFrame(frame);
      frame = 0;
    }

    return {
      isActive: () => active,
      start,
      stop
    };
  }

  return { createCardGrowthController };
});
