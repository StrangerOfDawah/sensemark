// Status pill: while no translation has arrived yet, a small pill
// "Перевожу с английского…" appears next to the selection, then shrinks into
// a circle with a running arc. It lives apart from the card: the card itself
// is never shown empty, only with the first visible piece of translation.
(function exposeStatusPill(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkStatusPill = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const HOST_ID = "__sensemark_status_host__";
  // The free mode answers in ~30 ms — the pill only shows for slower answers.
  const SHOW_DELAY = 200;
  // How long the full label stays before the pill shrinks into a circle.
  const COLLAPSE_AFTER = { translate: 1200, info: 4000, download: 3000 };

  /**
   * @param {object} deps
   * @param {(id: number) => boolean} deps.isCurrent  is this still the active request?
   * @param {() => boolean} deps.hasCard              is the card already on screen?
   * @param {(info: object) => DOMRect} deps.liveRect current selection rectangle
   * @param {(element: HTMLElement, look: object) => void} deps.applyLook
   * @param {string} deps.style                       <style> markup (card-styles.js)
   * @param {object} deps.placement                   placement.js API
   */
  function createStatusPill({ isCurrent, hasCard, liveRect, applyLook, style, placement }) {
    let host = null;
    let element = null;
    let info = null;
    let showTimer = null;
    let collapseTimer = null;
    // Point the card grows from when it replaces the pill.
    let origin = null;

    function schedule(nextInfo, id, status) {
      clearTimeout(showTimer);
      showTimer = setTimeout(() => {
        showTimer = null;
        if (isCurrent(id) && !hasCard()) show(nextInfo, id, status);
      }, SHOW_DELAY);
    }

    function show(nextInfo, id, { label, kind = "translate", progress = null, hint = "" }) {
      if (!isCurrent(id)) return;
      clearTimeout(showTimer);
      showTimer = null;
      const fresh = !element;
      if (fresh) {
        host = document.createElement("div");
        host.id = HOST_ID;
        host.style.cssText = "all: initial; position: absolute; z-index: 2147483647; top: 0; left: 0;";
        const shadow = host.attachShadow({ mode: "open" });
        shadow.innerHTML = `${style}
        <div class="status" role="status" aria-live="polite">
          <svg class="ring" viewBox="0 0 20 20" aria-hidden="true">
            <circle class="track" cx="10" cy="10" r="7.5"/>
            <circle class="arc" cx="10" cy="10" r="7.5" pathLength="100"/>
          </svg>
          <span class="lbl"></span>
        </div>`;
        document.documentElement.appendChild(host);
        element = shadow.querySelector(".status");
      }
      info = nextInfo;
      applyLook(host, info.look);
      element.dataset.scheme = info.look?.scheme || "light";
      element.classList.toggle("drawer", info.layout?.kind === "drawer");

      const labelEl = element.querySelector(".lbl");
      const changedKind = element.dataset.kind !== kind;
      labelEl.textContent = label;
      element.title = hint || label;
      element.setAttribute("aria-label", label);
      element.dataset.kind = kind;
      // A real percentage (language pack download) fills the ring; otherwise it spins.
      const determinate = typeof progress === "number";
      element.classList.toggle("determinate", determinate);
      if (determinate) element.style.setProperty("--progress", String(Math.round(progress * 100)));

      if (fresh || changedKind) {
        element.classList.remove("mini");
        clearTimeout(collapseTimer);
        collapseTimer = setTimeout(() => element?.classList.add("mini"), COLLAPSE_AFTER[kind] || 1200);
      }
      place();
      if (fresh) requestAnimationFrame(() => element?.classList.add("in"));
    }

    function place() {
      if (!element || !info) return;
      const spot = placement.statusPlacement({
        rect: liveRect(info),
        kind: info.layout?.kind || "anchor",
        viewport: { width: window.innerWidth, height: window.innerHeight }
      });
      origin = spot.origin;
      if (spot.fixed) return; // the drawer pill is pinned by CSS
      element.style.left = `${spot.x + window.scrollX}px`;
      element.style.top = `${spot.y + window.scrollY}px`;
    }

    function hide({ animate = true } = {}) {
      clearTimeout(showTimer);
      clearTimeout(collapseTimer);
      showTimer = null;
      collapseTimer = null;
      if (!host) {
        origin = null;
        return;
      }
      const dying = host;
      if (animate && element) {
        element.classList.add("out");
        setTimeout(() => dying.remove(), 160);
      } else {
        dying.remove();
      }
      host = null;
      element = null;
      info = null;
    }

    // The card takes the origin once, when it first appears.
    function takeOrigin() {
      const point = origin;
      origin = null;
      return point;
    }

    return {
      schedule,
      show,
      place,
      hide,
      takeOrigin,
      get visible() {
        return Boolean(host);
      }
    };
  }

  return { createStatusPill, HOST_ID };
});
