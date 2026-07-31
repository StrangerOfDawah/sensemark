(function exposeCardDragController(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("./card-positioner.js")
      : root.SensemarkCardPositioner;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkCardDragController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (positioner) => {
  function createCardDragController({
    element,
    handle,
    viewport = () => ({ width: innerWidth, height: innerHeight }),
    scheduleFrame = requestAnimationFrame,
    onPosition,
    onReset
  }) {
    let drag = null;
    let frame = 0;
    let pending = null;

    function apply() {
      frame = 0;
      if (!pending) return;
      const size = element.getBoundingClientRect();
      const next = positioner.clampPosition(
        pending,
        { width: size.width, height: size.height },
        viewport()
      );
      element.style.left = `${next.left}px`;
      element.style.top = `${next.top}px`;
      pending = null;
      onPosition?.(next);
    }

    function pointerMove(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      pending = {
        left: drag.left + event.clientX - drag.x,
        top: drag.top + event.clientY - drag.y
      };
      if (!frame) frame = scheduleFrame(apply);
    }

    function stop(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      handle.releasePointerCapture?.(event.pointerId);
      handle.removeEventListener("pointermove", pointerMove);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
    }

    function start(event) {
      if (event.button !== 0 || event.target.closest?.("button,a,input,select,textarea")) return;
      const rect = element.getBoundingClientRect();
      drag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: rect.left,
        top: rect.top
      };
      handle.setPointerCapture?.(event.pointerId);
      handle.addEventListener("pointermove", pointerMove);
      handle.addEventListener("pointerup", stop);
      handle.addEventListener("pointercancel", stop);
      event.preventDefault();
    }

    handle.addEventListener("pointerdown", start);
    handle.addEventListener("dblclick", (event) => {
      if (event.target.closest?.("button,a,input,select,textarea")) return;
      onReset?.();
    });

    return {
      destroy() {
        handle.removeEventListener("pointerdown", start);
      }
    };
  }

  return { createCardDragController };
});
