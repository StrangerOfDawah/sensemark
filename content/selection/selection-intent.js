(function exposeSelectionIntent(root, factory) {
  const dependency =
    typeof module === "object" && module.exports
      ? require("../../shared/config.js")
      : root.SensemarkConfig;
  const api = factory(dependency);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.SensemarkSelectionIntent = api;
})(typeof globalThis !== "undefined" ? globalThis : this, (config) => {
  function modifierMatches(required, event = {}) {
    if (required === "alt") return Boolean(event.altKey);
    if (required === "shift") return Boolean(event.shiftKey);
    if (required === "meta") return Boolean(event.metaKey || event.ctrlKey);
    return true;
  }

  function isCopyShortcut(event = {}) {
    return (
      String(event.key || "").toLowerCase() === "c" &&
      Boolean(event.metaKey || event.ctrlKey) &&
      !event.altKey
    );
  }

  function createIntentController({
    mode = config.SELECTION_MODE.BUTTON,
    stableDelayMs = 600,
    requiredModifier = "none",
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
    getSnapshot,
    validateSnapshot,
    onAutomatic,
    onButton,
    onDismiss
  } = {}) {
    let timer = null;
    let copiedAt = 0;
    let pointerDown = false;
    let generation = 0;

    function cancel() {
      generation += 1;
      if (timer) cancelSchedule(timer);
      timer = null;
    }

    function dismiss() {
      cancel();
      onDismiss?.();
    }

    function handleKeyDown(event) {
      if (isCopyShortcut(event)) {
        copiedAt = Date.now();
        cancel();
      }
    }

    function handlePointerDown() {
      pointerDown = true;
      cancel();
    }

    function handlePointerUp(event = {}) {
      pointerDown = false;
      evaluate(event);
    }

    function evaluate(event = {}) {
      cancel();
      if (
        mode === config.SELECTION_MODE.MANUAL ||
        pointerDown ||
        Date.now() - copiedAt < stableDelayMs ||
        !modifierMatches(requiredModifier, event)
      ) {
        return;
      }
      const snapshot = typeof getSnapshot === "function" ? getSnapshot() : undefined;
      if (typeof getSnapshot === "function" && !snapshot) return;
      const ownGeneration = generation;
      timer = schedule(() => {
        timer = null;
        if (ownGeneration !== generation || pointerDown) return;
        const dispatch = (valid) => {
          if (!valid || ownGeneration !== generation || pointerDown) return;
          if (mode === config.SELECTION_MODE.AUTOMATIC) onAutomatic?.(snapshot);
          else if (mode === config.SELECTION_MODE.BUTTON) onButton?.(snapshot);
        };
        const valid =
          typeof validateSnapshot === "function" ? validateSnapshot(snapshot) : true;
        if (valid && typeof valid.then === "function") {
          valid.then(dispatch).catch(() => {});
        } else {
          dispatch(valid);
        }
      }, stableDelayMs);
    }

    function update(next = {}) {
      mode = next.mode || mode;
      stableDelayMs = Number(next.stableDelayMs) || stableDelayMs;
      requiredModifier = next.requiredModifier || requiredModifier;
      dismiss();
    }

    return {
      cancel,
      cancelPending: cancel,
      dismiss,
      evaluate,
      handleKeyDown,
      handlePointerDown,
      handlePointerUp,
      update
    };
  }

  return { createIntentController, isCopyShortcut, modifierMatches };
});
