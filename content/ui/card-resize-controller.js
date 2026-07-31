(function exposeCardResizeController(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkCardResizeController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  function createCardResizeController({
    element,
    handle,
    minimumWidth = 280,
    minimumHeight = 150,
    scheduleFrame = requestAnimationFrame,
    onSize
  }) {
    let resize = null;
    let frame = 0;
    let pending = null;

    function apply() {
      frame = 0;
      if (!pending) return;
      const width = Math.min(innerWidth - 16, Math.max(minimumWidth, pending.width));
      const height = Math.min(innerHeight - 16, Math.max(minimumHeight, pending.height));
      element.style.width = `${Math.round(width)}px`;
      element.style.height = `${Math.round(height)}px`;
      pending = null;
      onSize?.({ width: Math.round(width), height: Math.round(height) });
    }

    function move(event) {
      if (!resize || event.pointerId !== resize.pointerId) return;
      pending = {
        width: resize.width + event.clientX - resize.x,
        height: resize.height + event.clientY - resize.y
      };
      if (!frame) frame = scheduleFrame(apply);
    }

    function stop(event) {
      if (!resize || event.pointerId !== resize.pointerId) return;
      resize = null;
      handle.releasePointerCapture?.(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    }

    function start(event) {
      if (event.button !== 0) return;
      const rect = element.getBoundingClientRect();
      resize = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        height: rect.height
      };
      handle.setPointerCapture?.(event.pointerId);
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
      event.preventDefault();
      event.stopPropagation();
    }

    handle.addEventListener("pointerdown", start);
    return {
      destroy() {
        handle.removeEventListener("pointerdown", start);
      }
    };
  }

  return { createCardResizeController };
});
