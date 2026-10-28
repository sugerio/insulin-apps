// /__insulin/bar.css: the account bar's styles, linked from inside its shadow root (no inline styles anywhere, so it works
// under an app CSP of `style-src 'self'`).
export const BAR_CSS = String.raw`:host {
  all: initial;
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  display: block;
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light dark;
}
:host([hidden]), [hidden] { display: none !important; }

.bar {
  --bg: #ffffff;
  --text: #1d1d1f;
  --muted: #5c6066;
  --border: #c9c9c4;
  --accent: #2f5d8a;
  --accent-text: #ffffff;
  --focus: #1a5fb4;
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
  color: var(--text);
}
@media (prefers-color-scheme: dark) {
  .bar {
    --bg: #1f2226;
    --text: #e8e8e6;
    --muted: #a6aab0;
    --border: #3f444a;
    --accent: #8db6e6;
    --accent-text: #0e1a27;
    --focus: #8db6e6;
  }
}

button, select, a { font: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(22rem, calc(100vw - 32px));
  padding: 5px 12px 5px 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
  cursor: pointer;
}
.mark {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-size: 12px;
  font-weight: 600;
}
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.panel {
  width: min(20rem, calc(100vw - 32px));
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg);
  color: var(--text);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.22);
}
h2 { margin: 0 0 8px; font-size: 14px; }
p { margin: 0 0 10px; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
label { display: block; margin: 0 0 4px; font-weight: 600; }
.switch { display: flex; gap: 6px; margin: 0 0 10px; }
select {
  flex: 1;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
}
.links { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0 0 12px; padding: 0; list-style: none; }
a { color: var(--accent); }
.button {
  padding: 4px 10px;
  border: 1px solid var(--accent);
  border-radius: 6px;
  background: var(--accent);
  color: var(--accent-text);
  cursor: pointer;
}
.button.secondary { background: transparent; color: var(--accent); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.status { margin: 8px 0 0; color: var(--muted); }
.status:empty { margin: 0; }

@media print { :host { display: none !important; } }
`
