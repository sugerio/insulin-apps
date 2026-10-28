// The gateway's one stylesheet (/__insulin/gateway.css): calm and plain, light and dark through prefers-color-scheme.
export const GATEWAY_CSS = String.raw`:root {
  color-scheme: light dark;
  --bg: #f7f7f5;
  --surface: #ffffff;
  --text: #1d1d1f;
  --muted: #5c6066;
  --border: #d9d9d4;
  --accent: #2f5d8a;
  --accent-hover: #234a70;
  --accent-text: #ffffff;
  --danger: #a3261c;
  --danger-bg: #fbeeec;
  --ok: #1d6b3a;
  --ok-bg: #ecf6ef;
  --info-bg: #edf2f8;
  --focus: #1a5fb4;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16181b;
    --surface: #1f2226;
    --text: #e8e8e6;
    --muted: #a6aab0;
    --border: #3a3e44;
    --accent: #8db6e6;
    --accent-hover: #abc9ee;
    --accent-text: #0e1a27;
    --danger: #f1a399;
    --danger-bg: #3a2320;
    --ok: #92d5a7;
    --ok-bg: #1b3124;
    --info-bg: #1e2936;
    --focus: #8db6e6;
  }
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-size: 1rem;
  line-height: 1.55;
  -webkit-text-size-adjust: 100%;
}

a { color: var(--accent); text-underline-offset: 0.15em; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.skip { position: absolute; left: -9999px; top: 0.5rem; }
.skip:focus { left: 1rem; z-index: 10; background: var(--surface); padding: 0.5rem 1rem; border-radius: 6px; }

.visually-hidden {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
  clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

header.site, main, footer.site { max-width: 46rem; margin: 0 auto; padding: 1rem 1.25rem; }

header.site {
  display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.5rem 1.5rem;
  border-bottom: 1px solid var(--border);
}

.brand { color: var(--text); font-weight: 650; text-decoration: none; font-size: 1.05rem; }
.brand span { color: var(--muted); font-weight: 400; }

nav.account { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 1rem; font-size: 0.95rem; }
nav.account form { margin: 0; }

main { padding-bottom: 2rem; }
h1 { font-size: 1.65rem; line-height: 1.25; margin: 1.5rem 0 1rem; }
h2 { font-size: 1.2rem; line-height: 1.3; margin: 2rem 0 0.75rem; }
h3 { font-size: 1.05rem; margin: 1.5rem 0 0.5rem; }
.card h3 { margin-top: 0; }
p, ul { margin: 0 0 1rem; }
.lead { font-size: 1.1rem; }
.muted { color: var(--muted); }
.small { font-size: 0.9rem; }
code { font-size: 0.92em; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9rem; background: var(--bg); padding: 0.75rem; border-radius: 6px; }

.card {
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  padding: 1rem 1.25rem; margin: 0 0 1rem;
}
.cards { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); margin-bottom: 1rem; }
.cards .card { margin: 0; }
ul.plain { list-style: none; padding: 0; }

label { display: block; font-weight: 600; margin: 1rem 0 0.25rem; }
.hint { display: block; color: var(--muted); font-size: 0.9rem; margin: 0 0 0.3rem; }
input[type="text"], input[type="email"], input[type="password"], select {
  width: 100%; padding: 0.6rem 0.7rem; font: inherit; color: inherit; background: var(--surface);
  border: 1px solid var(--muted); border-radius: 6px;
}
input[aria-invalid="true"] { border-color: var(--danger); border-width: 2px; }
.field-error { color: var(--danger); font-weight: 600; margin: 0.3rem 0 0; font-size: 0.95rem; }

button, .button {
  display: inline-block; font: inherit; font-weight: 600; line-height: 1.3; padding: 0.55rem 1.1rem;
  border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: var(--accent-text);
  cursor: pointer; text-decoration: none; text-align: center;
}
button:hover, .button:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
button.secondary, .button.secondary { background: transparent; color: var(--accent); }
button.secondary:hover, .button.secondary:hover { background: var(--info-bg); }
button.danger { background: var(--danger); border-color: var(--danger); color: var(--surface); }
button.link {
  background: none; border: none; padding: 0; color: var(--accent); font-weight: inherit;
  text-decoration: underline; text-underline-offset: 0.15em;
}
.button.wide { display: block; width: 100%; }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1rem; margin: 1.25rem 0 1rem; }
form.inline, form.inline-form { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin: 0 0.75rem 0.25rem 0; }
form.inline-form select { width: auto; }

.errors, .notice { padding: 0.75rem 1rem; border-radius: 6px; margin: 1rem 0; border-left: 4px solid; }
.errors { border-color: var(--danger); background: var(--danger-bg); }
.errors ul { margin: 0; padding-left: 1.25rem; }
.errors p { margin: 0 0 0.25rem; }
.notice { border-color: var(--accent); background: var(--info-bg); }
.notice.ok { border-color: var(--ok); background: var(--ok-bg); }

.badge {
  display: inline-block; font-size: 0.78rem; font-weight: 600; padding: 0 0.5rem; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted); vertical-align: 0.1em;
}

table { width: 100%; border-collapse: collapse; font-size: 0.95rem; margin: 0 0 1rem; }
th, td { text-align: left; padding: 0.55rem 0.4rem; border-bottom: 1px solid var(--border); vertical-align: top; }
td { overflow-wrap: break-word; }

.divider { display: flex; align-items: center; gap: 0.75rem; color: var(--muted); margin: 1.25rem 0; }
.divider::before, .divider::after { content: ""; flex: 1; border-top: 1px solid var(--border); }

.cf-turnstile { margin: 1.25rem 0 0.5rem; min-height: 65px; }

.legal h2 { margin-top: 1.75rem; }
.legal li { margin-bottom: 0.4rem; }

footer.site { border-top: 1px solid var(--border); color: var(--muted); font-size: 0.9rem; }
footer.site p { margin: 0.25rem 0; }

@media (max-width: 30rem) {
  h1 { font-size: 1.4rem; }
  th, td { padding: 0.45rem 0.25rem; }
}

@media (prefers-reduced-motion: reduce) {
  * { scroll-behavior: auto !important; transition: none !important; }
}
`
