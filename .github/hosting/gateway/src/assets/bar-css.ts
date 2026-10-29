// /__insulin/bar.css: the account bar's styles, linked from inside its shadow root (no inline styles anywhere, so it works
// under an app CSP of `style-src 'self'`). It matches the gateway pages: shadcn/ui's neutral tokens (MIT), a pill like an
// outline Button and a panel like DropdownMenuContent. Written by hand, since the shadow root can't use gateway.css.
export const BAR_CSS = String.raw`:host {
  all: initial;
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  display: block;
  font: 14px/1.43 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color-scheme: light dark;
  -webkit-font-smoothing: antialiased;
}
:host([hidden]), [hidden] { display: none !important; }

.bar {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --accent: oklch(0.97 0 0);
  --primary: oklch(0.205 0 0);
  --primary-foreground: oklch(0.985 0 0);
  --border: oklch(0.922 0 0);
  --input: oklch(0.922 0 0);
  --ring: oklch(0.205 0 0);
  --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
  display: flex;
  flex-direction: column-reverse;
  align-items: flex-end;
  gap: 8px;
  color: var(--foreground);
}
@media (prefers-color-scheme: dark) {
  .bar {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.922 0 0);
    --shadow: 0 4px 6px -1px rgb(0 0 0 / 0.4), 0 2px 4px -2px rgb(0 0 0 / 0.4);
  }
}

*, *::before, *::after { box-sizing: border-box; }
button, select, a { font: inherit; color: inherit; }
button:focus-visible, select:focus-visible, a:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.sr-only {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}
svg { flex: none; }
.icon { width: 16px; height: 16px; color: var(--muted-foreground); }

.pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  max-width: min(22rem, calc(100vw - 32px));
  height: 36px;
  padding: 0 10px 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--popover);
  font-weight: 500;
  box-shadow: var(--shadow);
  cursor: pointer;
  transition: background-color 150ms;
}
.pill:hover { background: var(--accent); }
.mark { width: 24px; height: 24px; }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  flex: none;
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
}

.panel {
  width: min(20rem, calc(100vw - 32px));
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--popover);
  box-shadow: var(--shadow);
}
h2 {
  margin: 0;
  padding: 6px 8px 2px;
  font-size: 12px;
  font-weight: 400;
  color: var(--muted-foreground);
}
.who { display: flex; align-items: center; gap: 10px; padding: 6px 8px; }
.avatar {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-size: 12px;
  font-weight: 500;
}
.who-text { min-width: 0; }
.name, .email { margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { font-weight: 500; }
.email { font-size: 12px; color: var(--muted-foreground); }
.separator { height: 1px; margin: 4px -4px; background: var(--border); }

.org { display: flex; align-items: center; gap: 8px; padding: 6px 8px; }
.org .label { flex: 1; }
form { margin: 0; padding: 2px 8px 8px; }
label { display: block; margin: 4px 0 6px; font-size: 12px; color: var(--muted-foreground); }
.switch { display: flex; gap: 6px; }
.select { position: relative; flex: 1; min-width: 0; }
select {
  width: 100%;
  height: 32px;
  padding: 0 28px 0 10px;
  border: 1px solid var(--input);
  border-radius: 6px;
  background: transparent;
  appearance: none;
  cursor: pointer;
}
option { background: Canvas; color: CanvasText; }
.select .icon { position: absolute; top: 8px; right: 8px; pointer-events: none; }
.button {
  height: 32px;
  padding: 0 12px;
  border: 0;
  border-radius: 6px;
  background: var(--primary);
  color: var(--primary-foreground);
  font-weight: 500;
  cursor: pointer;
}
.button:hover { background: color-mix(in oklab, var(--primary) 90%, transparent); }

.links { margin: 0; padding: 0; list-style: none; }
.item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px;
  border: 0;
  border-radius: 4px;
  background: none;
  text-align: left;
  text-decoration: none;
  cursor: default;
}
.item:hover, .item:focus-visible { background: var(--accent); }
.row { display: flex; align-items: center; gap: 4px; }
.row .item { flex: 1; }
.close {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 6px;
  background: none;
  cursor: pointer;
}
.close:hover { background: var(--accent); }
.status { margin: 4px 8px; font-size: 12px; color: var(--muted-foreground); }
.status:empty { display: none; }

@media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
@media print { :host { display: none !important; } }
`
