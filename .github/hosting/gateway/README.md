# Insulin Apps gateway

A Cloudflare Worker (`insulin-apps-gateway`) that signs people in, keeps their organizations, and puts each app on its
own subdomain. It plays the part the Insulin console's entry worker plays in production: it authenticates the user,
picks their active organization and role, and forwards the request to the app Worker over a service binding with the
console identity headers. The apps need no hosting-specific code.

| Host | What it serves |
|---|---|
| `SITE_DOMAIN` (e.g. `insulinapps.com`) | landing page, `/privacy`, `/terms` (public, indexable) |
| `www.SITE_DOMAIN` | a 301 to the apex, same path and query |
| `auth.SITE_DOMAIN` | accounts, organizations, members, invitations |
| `<app>.SITE_DOMAIN` | the app, through its `APP_<APP>` service binding |
| `/__insulin/*` on every host | reserved, never forwarded: stylesheet, account bar, `me`, `switch-org`, `logout` |

The operator runbook (setup, secrets, adding an app) is `.github/hosting/README.md`. This file is for developers.

## Code

TypeScript with zero runtime dependencies (Web Crypto, `HTMLRewriter`, D1, fetch). The entry is `src/index.ts`.

| Path | What |
|---|---|
| `src/router.ts` | host and path dispatch; the Origin and content-type checks for auth POSTs; HSTS and cookies on the way out |
| `src/config.ts`, `src/env.ts` | the bindings and vars, checked once per isolate; anything missing fails closed (503) |
| `src/context.ts` | per-request state: site, public scheme and origins, clock, form, cookies to set |
| `src/crypto.ts` | random tokens and ids, SHA-256, PBKDF2 hashes, constant-time comparison |
| `src/http/` | cookies, security headers, request parsing, responses, `return_to` |
| `src/db/` | D1 queries, one module per table group; every race-sensitive rule is a single statement or batch |
| `src/auth/` | sessions, email and password accounts, Google sign-in, the account page |
| `src/orgs/` | organizations, roles and members; invitations |
| `src/proxy.ts` | the app proxy: identity headers, header and cookie stripping, the account bar on HTML |
| `src/reserved.ts` | `/__insulin/me`, `switch-org`, `logout`, and the local captured-mail page |
| `src/mail/` | the transport (Email Service binding, or the `mail_capture` table in test mode) and the messages |
| `src/turnstile.ts`, `src/ratelimit.ts` | bot checks and rate limits |
| `src/pages/` | server-rendered pages; `pages/html.ts` is the one place HTML is escaped |
| `src/assets/` | the stylesheet and the account bar (script and stylesheet) as strings |
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
```

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
- **Logs** carry event names, ids, error class names and identifier-like codes; never exception messages.
- **Retention.** Expired sessions, used or expired links and mail-log rows older than two days are deleted in batches
  of at most 200 per table after each POST (`src/housekeeping.ts`). The Worker also has a `scheduled` handler that
  runs the same cleanup in bigger batches if the deploy adds a cron trigger (optional).
