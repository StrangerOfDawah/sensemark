// Styles and icons of the on-page card and the status pill.
//
// Both style blocks are part of the design lock: scripts/design-lock.js hashes
// every style element in this file, in order. Change them only together with
// an approved design change: npm run design:status / npm run design:approve.
(function exposeCardStyles(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.SensemarkCardStyles = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  // Status pill: "Translating from English…" that shrinks into a progress ring.
  const STATUS_STYLE = `
      <style>
        :host { all: initial; }
        .status {
          position: absolute;
          display: inline-flex;
          align-items: center;
          gap: 7px;
          height: 28px;
          padding: 0 12px 0 7px;
          box-sizing: border-box;
          border-radius: 999px;
          background: var(--surface, #fff);
          border: 1px solid var(--border, #e3e3e8);
          box-shadow: var(--shadow, 0 10px 26px rgba(0, 0, 0, 0.12));
          color: var(--sec, #62646f);
          font: 500 12px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          letter-spacing: -0.003em;
          -webkit-font-smoothing: antialiased;
          white-space: nowrap;
          opacity: 0;
          transform: translateY(3px) scale(0.96);
          transform-origin: 14px 50%;
          transition:
            opacity 0.2s ease,
            transform 0.24s cubic-bezier(0.21, 1.02, 0.36, 1),
            padding 0.38s cubic-bezier(0.32, 0.72, 0, 1),
            gap 0.38s cubic-bezier(0.32, 0.72, 0, 1);
        }
        .status.in { opacity: 1; transform: none; }
        .status.out { opacity: 0; transform: scale(0.9); }
        .status.drawer { position: fixed; top: 16px; right: 16px; }
        .lbl {
          display: inline-block;
          max-width: 280px;
          overflow: hidden;
          transition: max-width 0.38s cubic-bezier(0.32, 0.72, 0, 1), opacity 0.18s ease;
        }
        /* Circle: the label slides away, the progress ring stays. */
        .status.mini { gap: 0; padding: 0 6px; }
        .status.mini .lbl { max-width: 0; opacity: 0; }
        .ring { width: 14px; height: 14px; flex: none; animation: spin 0.9s linear infinite; }
        .ring circle { fill: none; stroke-width: 2.4; }
        .track { stroke: var(--track, #e6e6ef); }
        .arc {
          stroke: var(--accent, #5e5ce6);
          stroke-linecap: round;
          stroke-dasharray: 26 100;
          transform: rotate(-90deg);
          transform-origin: 50% 50%;
          transition: stroke-dasharray 0.3s ease;
        }
        .status.determinate .ring { animation: none; }
        .status.determinate .arc { stroke-dasharray: var(--progress, 0) 100; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .status, .lbl { transition: opacity 0.2s ease; }
          .ring { animation-duration: 2.4s; }
        }
        @media (prefers-contrast: more) {
          .status { border-color: var(--text, #16171c); color: var(--text, #16171c); }
        }
      </style>`;

  // Translation card. Colours arrive as CSS variables from card-theme.js.
  const CARD_STYLE = `
      <style>
        /* Colours arrive as variables from card-theme.js (on the host itself):
           page-matched, light or dark. Only fallbacks live here, on :host,
           so they never override the page colours. */
        :host {
          all: initial;
          --surface: #ffffff;
          --border: #e3e3e8;
          --text: #16171c;
          --sec: #62646f;
          --hair: rgba(22, 23, 28, 0.06);
          --fill: rgba(22, 23, 28, 0.06);
          --fill-hover: rgba(22, 23, 28, 0.11);
          --accent: #5e5ce6;
        }
        * { box-sizing: border-box; margin: 0; padding: 0; }

        .card {
          --warn: #ff9500;
          --ok: #34c759;
          --notch-x: 28px;
          position: absolute;
          width: max-content;
          min-width: 240px;
          max-width: 420px;
          border-radius: 16px;
          border: 1px solid var(--border);
          background: var(--surface);
          box-shadow: var(--shadow, 0 14px 36px rgba(0, 0, 0, 0.14), 0 2px 4px rgba(0, 0, 0, 0.05));
          color: var(--text);
          /* Everything inside is in em, so the whole card scales from this size. */
          font: calc(14px * var(--ui-scale, 1)) / 1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
          opacity: 0;
          display: flex;
          flex-direction: column;
        }
        .card[data-scheme="dark"] { --warn: #ff9f0a; --ok: #30d158; }
        .card.in {
          opacity: 1;
          animation: pop 0.34s cubic-bezier(0.21, 1.02, 0.36, 1);
          transition:
            top 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            left 0.28s cubic-bezier(0.32, 0.72, 0, 1),
            font-size 0.09s ease-out;
        }
        /* On scroll the card follows the text without delay. */
        .card.in.tracking { transition: none; }
        .card.out {
          opacity: 0;
          transform: translateY(4px) scale(0.98);
          transition: opacity 0.16s ease, transform 0.16s ease;
        }
        @keyframes pop {
          from { opacity: 0; transform: scale(0.94); }
          to { opacity: 1; transform: none; }
        }

        /* The notch pointing at the selection. */
        .card.anchor::before {
          content: "";
          position: absolute;
          top: -6px;
          left: var(--notch-x);
          width: 11px;
          height: 11px;
          margin-left: -5.5px;
          transform: rotate(45deg);
          background: var(--surface);
          border-left: 1px solid var(--border);
          border-top: 1px solid var(--border);
          border-radius: 2px 0 0 0;
        }
        .card.anchor.above::before {
          top: auto;
          bottom: -6px;
          border: 0;
          border-right: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
          border-radius: 0 0 2px 0;
        }
        .card.anchor.free::before { display: none; }

        /* Margin note to the right of a long selection. */
        .card.margin { max-width: none; }
        .bracket {
          position: absolute;
          width: 10px;
          border: 2px solid var(--accent, #5e5ce6);
          border-left: 0;
          border-radius: 0 8px 8px 0;
          opacity: 0.5;
          pointer-events: none;
        }
        .bracket[hidden] { display: none; }

        /* Panel at the right window edge when there is no room beside the text. */
        .card.drawer {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          max-width: none;
          border-radius: 0;
          border-width: 0 0 0 1px;
        }
        .card.drawer.in { animation: slide 0.32s cubic-bezier(0.21, 1.02, 0.36, 1); }
        @keyframes slide {
          from { opacity: 0; transform: translateX(28px); }
          to { opacity: 1; transform: none; }
        }
        .card.margin .bd, .card.drawer .bd { min-height: 0; }
        .card.drawer .hd { padding-top: 1.1em; padding-bottom: 0.6em; border-bottom: 1px solid var(--hair); }
        .card.drawer .bd { padding-top: 1em; display: flex; flex-direction: column; }
        .card.margin .acts, .card.drawer .acts {
          position: sticky;
          bottom: -0.93em;
          margin: 0.79em -1.14em -0.93em;
          padding: 0.5em 1.14em 0.7em;
          background: var(--surface);
          border-top: 1px solid var(--hair);
        }
        /* In the panel the buttons stick to the bottom of the window. */
        .card.drawer .acts { margin-top: auto; }
        .card.margin .grip, .card.drawer .grip { display: none; }

        .card.reference { --accent: #c56a00; border-color: color-mix(in srgb, var(--accent) 38%, var(--border)); }
        .card.reference[data-scheme="dark"] { --accent: #ff9f0a; }

        .hd {
          display: flex;
          align-items: center;
          flex: none;
          padding: 0.79em 0.71em 0 1.14em;
        }
        .badge {
          display: inline-flex;
          align-items: center;
          gap: 0.5em;
          font-size: 0.86em;
          font-weight: 600;
          color: var(--sec);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .badge::before {
          content: "";
          width: 0.5em;
          height: 0.5em;
          border-radius: 50%;
          background: linear-gradient(135deg, #64d2ff, #8f5bff);
          flex: none;
        }
        .card.reference .badge { color: var(--accent); }
        .card.multilingual .badge { color: var(--accent); }
        .card.reference .badge::before { background: linear-gradient(135deg, #ffd60a, #ff7a00); }
        .sp { flex: 1; }

        .bd {
          flex: 1;
          padding: 0.43em 1.14em 0.93em;
          max-height: var(--bd-max, 340px);
          overflow-y: auto;
          animation: fade 0.22s ease;
        }
        .bd::-webkit-scrollbar { width: 6px; }
        .bd::-webkit-scrollbar-thumb { background: var(--fill-hover); border-radius: 3px; }
        @keyframes fade {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        .tr {
          font-family: var(--tr-font, inherit);
          font-size: calc(var(--tr-size, 15px) * var(--ui-scale, 1));
          line-height: 1.55;
          letter-spacing: -0.003em;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
          cursor: text;
        }
        .card.reference .tr {
          font-size: calc(var(--tr-size, 15px) * 1.08 * var(--ui-scale, 1));
          font-weight: 650;
        }

        .term-kind {
          display: inline-flex;
          width: fit-content;
          margin-bottom: 0.5em;
          padding: 0.24em 0.62em;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 14%, transparent);
          color: var(--accent);
          font-size: 0.72em;
          font-weight: 700;
          letter-spacing: 0.07em;
          text-transform: uppercase;
        }
        /* display: inline-flex above overrides the hidden attribute; without this
           line an empty category badge shows in every ordinary card. */
        .term-kind[hidden] { display: none; }
        .reference-note {
          margin-top: 0.3em;
          color: var(--sec);
          font-size: 0.82em;
        }

        .segments {
          display: grid;
          gap: 0.86em;
        }
        .segment + .segment {
          padding-top: 0.79em;
          border-top: 1px solid var(--hair);
        }
        .segment-lang {
          display: inline-flex;
          width: fit-content;
          margin-bottom: 0.36em;
          padding: 0.22em 0.58em;
          border-radius: 999px;
          background: color-mix(in srgb, var(--accent) 12%, transparent);
          color: var(--accent);
          font-size: 0.7em;
          font-weight: 700;
          letter-spacing: 0.055em;
          text-transform: uppercase;
        }
        .segment-lang.kept {
          background: var(--fill);
          color: var(--sec);
        }
        .segment-text {
          font-family: var(--tr-font, inherit);
          font-size: calc(var(--tr-size, 15px) * var(--ui-scale, 1));
          line-height: 1.55;
          white-space: pre-wrap;
          overflow-wrap: break-word;
          user-select: text;
          -webkit-user-select: text;
        }

        .alt {
          margin-top: 0.79em;
          padding-top: 0.71em;
          border-top: 1px solid var(--hair);
        }
        .cap {
          font-size: 0.75em;
          font-weight: 600;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--sec);
          margin-bottom: 0.21em;
        }
        .alt-t {
          font-family: var(--tr-font, inherit);
          font-size: 0.93em;
          color: var(--sec);
          overflow-wrap: break-word;
        }

        .acts {
          display: flex;
          align-items: center;
          gap: 0.29em;
          margin-top: 0.64em;
          transition: opacity 0.25s ease;
        }
        .acts.pending { opacity: 0; pointer-events: none; }

        .caret {
          display: inline-block;
          width: 2px;
          height: 1.05em;
          margin-left: 1px;
          vertical-align: -0.18em;
          border-radius: 1px;
          background: var(--accent);
          animation: blink 1s steps(2) infinite;
        }
        @keyframes blink { 50% { opacity: 0; } }

        .icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 2.14em;
          height: 2.14em;
          border: none;
          border-radius: 0.57em;
          background: var(--fill);
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease, transform 0.1s ease;
        }
        .icon-btn:hover { background: var(--fill-hover); color: var(--text); }
        .icon-btn:active { transform: scale(0.92); }
        .icon-btn svg { width: 1em; height: 1em; }
        .icon-btn.ok { color: var(--ok); }
        .icon-btn.xs { width: 1.86em; height: 1.86em; border-radius: 0.5em; background: transparent; }
        .icon-btn.xs:hover { background: var(--fill); }
        .icon-btn.xs svg { width: 0.86em; height: 0.86em; }

        .chip {
          display: inline-flex;
          align-items: center;
          gap: 0.21em;
          border: none;
          border-radius: 999px;
          padding: 0.43em 0.86em;
          font: 600 0.86em/1 -apple-system, BlinkMacSystemFont, sans-serif;
          background: var(--fill);
          color: var(--sec);
          cursor: pointer;
          transition: background 0.15s ease, color 0.15s ease;
        }
        .chip:hover { background: var(--fill-hover); color: var(--text); }
        .chip.accent { color: var(--accent); }
        .chip.accent:hover { color: var(--accent); }
        .icon-btn.open { background: var(--fill-hover); color: var(--text); }
        .icon-btn[hidden], .auto-menu[hidden], .auto-note[hidden] { display: none; }

        .auto-menu {
          display: flex;
          flex-wrap: wrap;
          justify-content: flex-end;
          gap: 0.29em;
          margin-top: 0.43em;
        }
        .auto-note {
          margin-top: 0.57em;
          color: var(--sec);
          font-size: 0.82em;
          line-height: 1.45;
        }

        .err {
          display: flex;
          gap: 9px;
          align-items: flex-start;
        }
        .err svg { width: 1.14em; height: 1.14em; flex: none; margin-top: 0.14em; color: var(--warn); }
        .err-t { font-size: 0.96em; color: var(--text); overflow-wrap: break-word; }

        /* Our own resize corner instead of the system resize handle. */
        .grip {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 18px;
          height: 18px;
          cursor: nwse-resize;
          opacity: 0;
          transition: opacity 0.2s ease;
          touch-action: none;
        }
        .card:hover .grip, .grip.active { opacity: 0.55; }
        .grip:hover { opacity: 0.9 !important; }
        .grip::after {
          content: "";
          position: absolute;
          right: 5px;
          bottom: 5px;
          width: 7px;
          height: 7px;
          border-right: 1.5px solid var(--sec);
          border-bottom: 1.5px solid var(--sec);
          border-bottom-right-radius: 3px;
        }

        /* The scale percentage replaces the header while the wheel turns. */
        .zoom {
          font-size: 0.79em;
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--accent);
          font-variant-numeric: tabular-nums;
        }

        @media (prefers-reduced-motion: reduce) {
          .card.in, .card.drawer.in, .bd { animation: none; }
          .card.in { transition: none; }
          .caret { animation: none; }
        }
        @media (prefers-contrast: more) {
          .card { border-color: var(--text); }
          .badge, .cap, .reference-note, .auto-note { color: var(--text); }
        }
      </style>`;

  // Inline SVG icons used by the card buttons.
  const ICONS = {
    close:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    copy: '<svg viewBox="0 0 16 16" fill="none"><rect x="5.2" y="5.2" width="8" height="8.6" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M10.8 3.4v-.2a1.8 1.8 0 0 0-1.8-1.8H4.6a1.8 1.8 0 0 0-1.8 1.8V8a1.8 1.8 0 0 0 1.8 1.8h.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    check:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M3.2 8.6 6.6 12l6.2-7.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    chevron:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M6 4.5 10 8l-4 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    pause:
      '<svg viewBox="0 0 16 16" fill="none"><path d="M6 4.2v7.6M10 4.2v7.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    warn: '<svg viewBox="0 0 16 16" fill="none"><path d="M8 2.4 14.5 13a1 1 0 0 1-.86 1.5H2.36A1 1 0 0 1 1.5 13L8 2.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/><path d="M8 6.4v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.8" r=".9" fill="currentColor"/></svg>'
  };

  return { CARD_STYLE, ICONS, STATUS_STYLE };
});
