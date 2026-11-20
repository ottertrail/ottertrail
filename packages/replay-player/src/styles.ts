/**
 * The player's own look, close to the dashboard's themes
 * (docs/design-system.md): a near-black canvas or a light one, hairline
 * borders, the orchid focus ring. Dark unless the page's <html> says
 * data-theme="light": the API writes the dashboard's theme there
 * (?theme=), and a theme message changes it while the page is open. The
 * recorded page, in rrweb's own frame, keeps its own colors. Written into
 * the page as a <style>, which its Content Security Policy allows
 * ('unsafe-inline' styles), so the player is one file. The values are the
 * dashboard's (apps/web/src/styles/globals.css); tests/styles.test.ts
 * checks their contrast.
 */
export const PLAYER_CSS = `
:root {
  color-scheme: dark;
  --canvas: #010101;
  --surface: #161416;
  --surface-raised: #1a181a;
  --hairline: #282328;
  --hairline-strong: #373338;
  --ink: #f9f7f9;
  --ink-muted: #dad3da;
  --ink-subtle: #938c93;
  --brand: #a557aa;
  --danger: #f47373;
}
:root[data-theme="light"] {
  color-scheme: light;
  --canvas: #f2eff2;
  --surface: #f9f7f9;
  --surface-raised: #ffffff;
  --hairline: #e2dee3;
  --hairline-strong: #d6d1d6;
  --ink: #191419;
  --ink-muted: #3c363c;
  --ink-subtle: #655e65;
  --brand: #a557aa;
  --danger: #a90017;
}
*, *::before, *::after { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body {
  background: var(--canvas);
  color: var(--ink);
  font: 14px/1.4 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
.ot-player { display: flex; flex-direction: column; height: 100%; }
.ot-stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  background: var(--canvas);
}
.ot-stage .replayer-wrapper {
  position: absolute;
  top: 0;
  left: 0;
  transform-origin: 0 0;
  background: #ffffff;
}
.ot-stage iframe { display: block; border: 0; }
.ot-message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--ink-muted);
}
.ot-message[data-tone="error"] { color: var(--danger); }
.ot-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 8px 12px;
  border-top: 1px solid var(--hairline);
  background: var(--surface);
}
.ot-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: 1px solid var(--hairline-strong);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--ink);
  font: inherit;
  cursor: pointer;
}
.ot-button:hover { background: var(--hairline); }
.ot-button[aria-pressed="true"] { background: var(--hairline-strong); border-color: var(--ink-subtle); }
.ot-button:disabled { opacity: 0.5; cursor: default; }
.ot-button:focus-visible, .ot-timeline input:focus-visible, .ot-check input:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}
.ot-play { min-width: 72px; justify-content: center; }
.ot-timeline { position: relative; flex: 1 1 240px; min-width: 160px; display: flex; align-items: center; }
.ot-timeline input { width: 100%; margin: 0; accent-color: var(--brand); }
.ot-marker {
  position: absolute;
  top: 50%;
  width: 3px;
  height: 18px;
  margin-left: -1.5px;
  transform: translateY(-50%);
  border-radius: 2px;
  background: var(--danger);
  pointer-events: none;
}
.ot-swatch {
  display: inline-block;
  width: 3px;
  height: 14px;
  border-radius: 2px;
  background: var(--danger);
}
.ot-jump-time { color: var(--ink-muted); font-variant-numeric: tabular-nums; }
.ot-time { font-variant-numeric: tabular-nums; color: var(--ink-muted); white-space: nowrap; }
.ot-group { display: inline-flex; gap: 4px; border: 0; margin: 0; padding: 0; }
.ot-check { display: inline-flex; align-items: center; gap: 6px; color: var(--ink-muted); }
.ot-check input { accent-color: var(--brand); margin: 0; }
.ot-note {
  margin: 0;
  padding: 0 12px 8px;
  background: var(--surface);
  color: var(--ink-subtle);
  font-size: 12px;
}
.ot-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
`;
