# Insulin Apps gateway

A Cloudflare Worker (`insulin-apps-gateway`) that signs people in, keeps their organizations, and puts each app on its
own subdomain. It plays the part the Insulin console's entry worker plays in production: it authenticates the user,
picks their active organization and role, and forwards the request to the app Worker over a service binding with the
console identity headers. The apps need no hosting-specific code.

| Host | What it serves |
|---|---|
| `SITE_DOMAIN` (e.g. `insulinapps.com`) | landing page, `/privacy`, `/terms` (public, indexable), `/favicon.ico`, `/apple-touch-icon.png` |
| `www.SITE_DOMAIN` | a 301 to the apex, same path and query |
| `auth.SITE_DOMAIN` | accounts, organizations, members, invitations; `/favicon.ico`, `/apple-touch-icon.png` |
| `<app>.SITE_DOMAIN` | the app, through its `APP_<APP>` service binding (its own favicon included) |
| `/__insulin/*` on every host | reserved, never forwarded: stylesheet, favicon (`icon.svg`), account bar, `me`, `switch-org`, `logout` |

The operator runbook (setup, secrets, adding an app) is `.github/hosting/README.md`. This file is for developers.

## Code

TypeScript on the Workers runtime (Web Crypto, `HTMLRewriter`, D1, fetch). The entry is `src/index.ts`.

The pages are React components rendered to HTML on the server (`renderToStaticMarkup` from `react-dom/server`, the
edge build wrangler picks for workerd), built from [shadcn/ui](https://ui.shadcn.com) components and styled with
Tailwind CSS. There is no client-side React: no hydration and no script bundle, and every form is a plain HTML POST.
The runtime dependencies are only `react`, `react-dom`, `class-variance-authority`, `clsx`, `tailwind-merge` and
`lucide-react` (icons, rendered to inline SVG); wrangler bundles them.

| Path | What |
|---|---|
| `src/router.ts` | host and path dispatch; the Origin and content-type checks for auth POSTs; HSTS and cookies on the way out |
| `src/config.ts`, `src/env.ts` | the bindings and vars, checked once per isolate; anything missing fails closed (503) |
| `src/context.ts` | per-request state: site, public scheme and origins, clock, form, cookies to set |
| `src/crypto.ts` | random tokens and ids, SHA-256, PBKDF2 hashes, constant-time comparison |
| `src/http/` | cookies, security headers, request parsing, responses, `return_to`, what is forwarded to apps |
| `src/db/` | D1 queries, one module per table group; every race-sensitive rule is a single statement or batch |
| `src/auth/` | sessions, email and password accounts, Google sign-in, the account page |
| `src/orgs/` | organizations, roles and members; invitations |
| `src/proxy.ts` | the app proxy: identity headers, header and cookie stripping, the account bar on HTML |
| `src/reserved.ts` | `/__insulin/me`, `switch-org`, `logout`, and the local captured-mail page |
| `src/mail/` | the transport (Email Service binding, or the `mail_capture` table in test mode) and the messages |
| `src/turnstile.ts`, `src/ratelimit.ts` | bot checks and rate limits |
| `src/pages/` | the pages, as React components; `pages/document.tsx` is the shared document (top bar, footer, favicon links) |
| `src/pages/html.ts` | the `html` tag, which escapes the HTML of the e-mails (React escapes the pages) |
| `src/components/ui/` | shadcn/ui components (new-york style), as the shadcn CLI writes them; see "shadcn/ui" below |
| `src/components/` | the gateway's own pieces: top bar, footer, `<details>` menus, form fields, brand marks |
| `src/lib/utils.ts` | `cn()`, shadcn's class-name helper (`clsx` and `tailwind-merge`) |
| `src/styles/gateway.css` | the Tailwind CSS source: shadcn's neutral theme tokens, light and dark |
| `src/assets/` | what the Worker serves itself: the compiled stylesheet (`gateway-css.ts`, generated), the mark (`icon.ts`) and its PNG renderings (`icons.ts`, generated), and the account bar (script and stylesheet) |
| `scripts/build-css.mjs`, `scripts/build-icons.mjs` | `npm run build:css` and `npm run build:icons`: regenerate those two modules |
| `components.json` | the shadcn CLI's settings, for adding a component later |
| `migrations/` | D1 migrations (wrangler format) |

## Configuration

The deploy pipeline generates the production wrangler config from this list; keep the names in step with it.

| Name | Kind | Notes |
|---|---|---|
| `DB` | D1 | migrations in `migrations/` |
| `EMAIL` | `send_email` | Cloudflare Email Service; restrict it to the `EMAIL_FROM` address |
| `RL_AUTH` | ratelimit | suggested `limit: 10, period: 60`; keys per action and IP, and per action and email (hashed) |
| `RL_APP` | ratelimit | suggested `limit: 600, period: 60`; keyed per user |
| `APP_<APP>` | service | one per app, e.g. `APP_CAPTABLE` → `insulin-apps-captable` |
| `SITE_DOMAIN` | var | e.g. `insulinapps.com` |
| `SITE_APPS` | var | JSON list (a string, or an already-parsed array): `[{ "name", "title", "summary", "binding", "source" }]` |
| `GOOGLE_CLIENT_ID` | var | optional; empty hides Google sign-in |
| `GOOGLE_CLIENT_SECRET` | secret | required when `GOOGLE_CLIENT_ID` is set |
| `TURNSTILE_SITE_KEY` | var | required |
| `TURNSTILE_SECRET_KEY` | secret | required |
| `EMAIL_FROM` | var | `Name <address>` or a bare address (the name then is "Insulin Apps") |
| `SUPPORT_EMAIL` | var | optional contact on the landing, privacy and terms pages; empty points to the repository's issues |
| `SITE_ENV` | var | **local development and tests only**: `test` captures mail and relaxes cookies on `http://*.localhost`. Any non-empty value is a configuration error unless it is `test` and `SITE_DOMAIN` ends in `.localhost` |

The app Worker gets `x-suger-user-id`, `x-suger-organization-id`, `x-suger-app-id` (`insulin-apps-<app>`),
`x-suger-app-role` and the URL-encoded `x-suger-user-email` and `x-suger-user-name`, as `@fours/app` reads them with
`SUGER_ACCESS_MODE=console`. Every incoming `x-suger-*` header and the `insulin_session` cookie are removed first.
User, organization and invitation ids are random UUIDs (`crypto.randomUUID()`), so apps receive UUIDs as user and
organization ids.

## Develop

Node 22 or newer.

```bash
npm ci
npm run typecheck
npm test                       # builds with wrangler, then runs the tests in Miniflare; offline
npm run dev                    # the gateway with the stub app, on port 8787
npm run build:css              # after changing a class in src/components or src/pages, or src/styles/gateway.css
npm run check:css              # fails while src/assets/gateway-css.ts is stale (npm test checks it too)
npm run build:icons            # after changing the mark in src/assets/icon.ts (renders the PNGs with resvg)
```

The stylesheet is compiled ahead of time and committed as a module (`src/assets/gateway-css.ts`), so the deploy needs
no CSS step: wrangler bundles it with everything else. Tailwind scans only `src/components` and `src/pages` for
classes. The favicon PNGs are committed the same way (`src/assets/icons.ts`), because the Worker has no static-assets
binding.

`npm run dev` writes `.dev/app.wrangler.json` (the app Worker's config), applies the D1 migrations locally and runs
`wrangler dev --local` with both configs. Open:

- `http://insulinapps.localhost:8787/`: the landing page
- `http://auth.insulinapps.localhost:8787/`: accounts and organizations
- `http://captable.insulinapps.localhost:8787/`: the app (the stub echoes the identity headers it receives)
- `http://auth.insulinapps.localhost:8787/__insulin/dev/mail`: mail captured instead of sent (`?format=json` for JSON)

Browsers and curl resolve `*.localhost` to your machine. The local config uses Cloudflare's public Turnstile test
keys: in a browser the widget loads from `challenges.cloudflare.com` and always passes; with curl, send
`cf-turnstile-response=XXXX.DUMMY.TOKEN.XXXX`. With `SITE_ENV=test` that token is checked locally, with no network
call. Google sign-in is off locally.

### With Cap Table

```bash
(cd ../../../captable && npm ci && NITRO_PRESET=cloudflare_module npm run build)
npm run dev -- --app captable
```

or by hand, which is what the script does:

```bash
node scripts/app-config.mjs --app captable        # writes .dev/app.wrangler.json
npx wrangler d1 migrations apply DB --local -c wrangler.local.jsonc --persist-to .dev/state
npx wrangler d1 migrations apply DB --local -c .dev/app.wrangler.json --persist-to .dev/state
npx wrangler dev -c wrangler.local.jsonc -c .dev/app.wrangler.json --local --persist-to .dev/state
```

Both Workers bind `DB`, so each local config gives its database a distinct `database_id`; without one, wrangler keys
local D1 state by binding name and the two databases would be the same file.

### Cookies on localhost

Production cookies are `insulin_session=…; Domain=SITE_DOMAIN; Path=/; Secure; HttpOnly; SameSite=Lax` and, for a
Google sign-in, `__Host-insulin_oauth=…; Path=/; Secure; HttpOnly; SameSite=Lax`. With `SITE_ENV=test` on
`http://*.localhost` only, they drop `Secure` and the `__Host-` prefix. Chromium would accept the production
attributes there anyway (it treats `*.localhost` as secure), but curl's cookie engine and other browsers do not.

## Design notes

- **POSTs must come from the host's own origin** (the `Origin` header, and `Sec-Fetch-Site` when present), as small
  url-encoded forms; `/__insulin/switch-org` also takes JSON.
- **`Referrer-Policy: strict-origin`**, not `no-referrer`: with `no-referrer` browsers send `Origin: null` on form
  POSTs, which the Origin check must refuse. `strict-origin` still never sends a path or query, so the tokens in
  verification and reset links never leave in a `Referer`.
- **After a POST, a cross-origin destination is a page, not a redirect**: the CSP's `form-action 'self'` makes
  browsers block a redirect to another origin that follows a form submission, so the gateway answers with a short
  "Continue" page (meta refresh and a link). Same-origin destinations get a 303.
- **The account bar** runs under the apps' CSP (`script-src 'self'; style-src 'self'; connect-src 'self';
  form-action 'self'`): a same-origin script builds a closed shadow root with DOM calls only and links
  `/__insulin/bar.css`; it switches organization and signs out with same-origin `fetch`, then navigates with
  `location.assign`.
- Session ids and email tokens are 32 random bytes; D1 stores only their SHA-256. Passwords are PBKDF2-SHA256
  (100,000 iterations, the workerd maximum).
- **Credential version.** Every password set, change or reset (and clearing a password when Google takes over an
  unconfirmed account) raises `users.credential_version`. A session is valid only while its version matches, and
  session inserts and password writes are conditional on the version the request verified, so a sign-in or password
  change that verified the old password before a reset changes nothing.
- **Links are staged.** A new confirmation or reset token is stored next to the older ones; only after its e-mail goes
  out do the older links stop working. A capped or failed send drops the new token, so flooding requests cannot
  invalidate the links someone already received.
- **Organization changes re-check the actor in SQL.** Rename, delete, invite, revoke, resend, role changes and removals
  carry an `EXISTS` on the actor's current role (with the OWNER and ADMIN limits) in the same statement, and the
  50-pending-invitation cap sits inside the insert. A member whose role is lowered, or who is removed, mid-request
  changes nothing.
- **Turnstile tokens are per form** (`data-action` signup, login, resend or forgot, required in `siteverify`).
  Google's callback checks `state` before it handles an error or clears the flow cookie. Only real navigations
  (`Sec-Fetch-Mode: navigate`, or HTML in `Accept` when fetch metadata is missing) are sent to sign in; everything
  else on an app host gets 401 JSON.
- **One outer layer** (`src/http/secure.ts`) gives every response HSTS over https and the common security headers;
  app responses keep their own headers and gain only HSTS. Plain http on any non-`.localhost` host is redirected
  before anything else is served.
- **Pages without scripts.** React renders each page once, on the server; the page itself runs no JavaScript (the
  Turnstile widget on the forms that need it is the only script, from Cloudflare). The CSP is unchanged: no inline
  script, no inline style or `style` attribute, and no outside fonts (the system font stack). React escapes every
  value; `dangerouslySetInnerHTML` is never used, and a test checks it. The top bar's organization switcher and
  account menu are `<details>`/`<summary>` menus styled like shadcn's DropdownMenu: keyboard-operable, exclusive
  (`<details name>`), and closed by a click anywhere outside (the open trigger's `::before` covers the window).
- **Logs** carry event names, ids, error class names and identifier-like codes; never exception messages.
- **Retention.** Expired sessions, used or expired links and mail-log rows older than two days are deleted in batches
  of at most 200 per table after each POST (`src/housekeeping.ts`). The Worker also has a `scheduled` handler that
  runs the same cleanup in bigger batches if the deploy adds a cron trigger (optional).

## shadcn/ui

The components in `src/components/ui/` come from [shadcn/ui](https://ui.shadcn.com) (MIT License, copyright shadcn),
new-york style, as `npx shadcn@4.23.0 add button card input label alert badge separator table avatar native-select
field` wrote them. Two changes, for pages that render only on the server:

- `cn` comes from `@/lib/utils` (clsx and tailwind-merge) rather than the young `cn` package the CLI now imports.
- The Radix primitives, which need client-side React, are replaced by the elements they render: `<label>` (Label), a
  `<div>` with the same role and orientation (Separator), `<span>`s (Avatar, without AvatarImage), and no `asChild`
  on Button and Badge (links take `buttonVariants()` as their class instead).

The theme in `src/styles/gateway.css` is shadcn's neutral base colour, with dark mode on `prefers-color-scheme`
instead of a `.dark` class, and `--ring` set to the primary colour so focus rings keep a 3:1 contrast. Icons are from
[Lucide](https://lucide.dev) (ISC). `NOTICE` has the licences.
