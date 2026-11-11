# Insulin Apps gateway

A Cloudflare Worker (`insulin-apps-gateway`) that signs people in, keeps their organizations and roles, and puts each
app on its own subdomain. It plays the part the Insulin console's entry worker plays in production: it authenticates
the user, picks their active organization, works out their role in the app, and forwards the request to the app Worker
over a service binding with the console identity headers. The apps need no hosting-specific code.

| Host | What it serves |
|---|---|
| `SITE_DOMAIN` (e.g. `insulinapps.com`) | `/` (the landing page, public and indexable, or the home page once signed in), `/privacy`, `/terms`; sign-up, sign-in and `/login/mfa`; the account, `/account/security`, `/account/agents`; organizations, `/settings/users`, `/settings/roles`, `/settings/organization`; each app's `/apps/<app>/settings/users`, `/apps/<app>/settings/integrations`, `/apps/<app>/settings/api` (API access) and `/apps/<app>/settings/connect-ai` (Connect AI); invitations; the OAuth authorization server (`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`); `/favicon.ico`, `/apple-touch-icon.png` |
| `www.SITE_DOMAIN` | a 301 to the apex, same path and query |
| `auth.SITE_DOMAIN` | a 308 to the apex, same path and query: sign-in used to live here, and e-mails already sent link to it |
| `<app>.SITE_DOMAIN` | the app, through its `APP_<APP>` service binding (its own favicon included), except the gateway's `/mcp` and `/.well-known/oauth-*`, and `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`, which redirect (GET only) to the app's settings on the apex; `/api/*` with a service account's Bearer token goes to the app as that account; the app's public paths (`insulin.publicPaths`) go to it for anyone, with no identity (DESIGN.md §8.1); every five minutes the gateway POSTs to the app's `insulin.scheduled` path, if it has one (DESIGN.md §8.5) |
| `/__insulin/*` on every host | reserved, never forwarded: stylesheet, favicon (`icon.svg`), account bar, `me`, `switch-org`, `logout`; on the apex, the integration proxy `/__insulin/integrations/*` and the apps' mail relay `/__insulin/mail` (DESIGN.md §8.2) |

The design of accounts, roles and access is `.github/hosting/DESIGN.md`. The operator runbook (setup, secrets, adding an
app) is `.github/hosting/README.md`. This file is for developers.

## Code

TypeScript on the Workers runtime (Web Crypto, `HTMLRewriter`, D1, fetch). The entry is `src/index.ts`.

The pages are React components rendered to HTML on the server (`renderToStaticMarkup` from `react-dom/server`, the
edge build wrangler picks for workerd), built from [shadcn/ui](https://ui.shadcn.com) components and styled with
Tailwind CSS. There is no client-side React: no hydration and no script bundle, and every form is a plain HTML POST.
The runtime dependencies are only `react`, `react-dom`, `class-variance-authority`, `clsx`, `tailwind-merge`,
`lucide-react` (icons, rendered to inline SVG), `qrcode-generator` (the authenticator-app QR code, also rendered to
inline SVG), `xml-crypto` with `@xmldom/xmldom` (SAML signatures, which need the `nodejs_compat` flag), and `tldts`
(the Public Suffix List) with `email-providers` (public mail providers) for owner domains; wrangler bundles them.

| Path | What |
|---|---|
| `src/router.ts` | host and path dispatch; the Origin and content-type checks for auth POSTs; HSTS and cookies on the way out |
| `src/config.ts`, `src/env.ts` | the bindings and vars, checked once per isolate; anything missing fails closed (503) |
| `src/context.ts` | per-request state: site, public scheme and origins, clock, form, cookies to set |
| `src/crypto.ts` | random tokens and ids, SHA-256, PBKDF2 hashes, constant-time comparison |
| `src/http/` | cookies, security headers, request parsing, responses, `return_to`, what is forwarded to apps |
| `src/db/` | D1 queries, one module per table group; every race-sensitive rule is a single statement or batch |
| `src/auth/` | sessions, email and password accounts, Google sign-in, the account page; `sign-in.ts`, where every sign-in becomes a session; `totp.ts` (RFC 6238 codes, recovery codes), `mfa.ts` (the second step at `/login/mfa`) and `security.ts` (Account → Security at `/account/security`) |
| `src/roles.ts` | organization roles, app roles, permissions and who may give what |
| `src/owner-domain.ts` | owner domains (registrable domain, or a provider address in Gmail's form), the public mail providers, and the strict check `allow-orgs.mjs` and the request to support apply; pure, so the script imports it too |
| `src/access.ts` | someone's role and permissions in one app, from their organization role or their grant; every way into an app ends here |
| `src/orgs/` | organizations and the settings pages (`orgs.ts`), invitations, custom roles (`custom-roles.ts`), an app's people page (`app-users.ts`), access in forms and words (`access-forms.ts`) |
| `src/proxy.ts` | the app proxy: identity headers, header and cookie stripping, the account bar on HTML |
| `src/scheduled.ts` | the crons: the apps' five-minute tick to their `insulin.scheduled` path, and which cron runs the daily cleanup |
| `src/oauth/` | the authorization server: metadata, registration, authorize and consent, token, revoke; token formats and lifetimes, `resolveBearer`, and calls to an app with a token (`app-api.ts`) |
| `src/mcp/server.ts` | each app's `/mcp` (stateless JSON-RPC; tools `whoami`, `endpoints`, `read`, `change`) and its protected-resource metadata |
| `src/mcp/connect-ai.ts` | an app's Connect AI page (`/apps/<app>/settings/connect-ai`): its MCP server and each client's setup, the person's agents for the app, and everyone's for owners and admins, with Disconnect |
| `src/integrations/` | an app's integrations page (`settings.ts`, stored credentials), its API access page (`api-clients.ts`, OAuth clients: owners and admins manage them, rotation with a 24-hour overlap) and the integration proxy (`proxy.ts`) |
| `src/auth/agents.ts` | Account → AI agents (`/account/agents`): a person's grants, disconnecting them, and links to each app's Connect AI |
| `src/sso/` | enterprise sign-in and provisioning: `/settings/sso` (`settings.ts`), the flow cookie and requests (`flow.ts`), SAML (`saml.ts`, with the XML libraries loaded through `xml-deps.js`), OIDC (`oidc.ts`), SCIM 2.0 at `/scim/v2` (`scim.ts`) |
| `src/reserved.ts` | `/__insulin/me`, `switch-org`, `logout`, and the local captured-mail page |
| `src/mail/` | the transport (Email Service binding, or the `mail_capture` table in test mode), the messages, and the apps' mail relay (`relay.ts`) |
| `src/turnstile.ts`, `src/ratelimit.ts` | bot checks and rate limits |
| `src/pages/` | the pages, as React components; `pages/document.tsx` is the shared document (top bar, footer, favicon links); `settings.tsx` the organization's settings; `app-settings.tsx` an app's settings frame and People tab, with `integrations.tsx`, `api-access.tsx` and `connect-ai.tsx` its other tabs |
| `src/pages/html.ts` | the `html` tag, which escapes the HTML of the e-mails (React escapes the pages) |
| `src/components/ui/` | shadcn/ui components (new-york style), as the shadcn CLI writes them; see "shadcn/ui" below |
| `src/components/` | the gateway's own pieces: top bar, footer, `<details>` menus, form fields, brand marks |
| `src/lib/utils.ts` | `cn()`, shadcn's class-name helper (`clsx` and `tailwind-merge`) |
| `src/styles/gateway.css` | the Tailwind CSS source: shadcn's neutral theme tokens, light and dark |
| `src/assets/` | what the Worker serves itself: the compiled stylesheet (`gateway-css.ts`, generated), the mark (`icon.ts`) and its PNG renderings (`icons.ts`, generated), and the account bar (script and stylesheet) |
| `scripts/build-css.mjs`, `scripts/build-icons.mjs` | `npm run build:css` and `npm run build:icons`: regenerate those two modules |
| `components.json` | the shadcn CLI's settings, for adding a component later |
| `migrations/` | D1 migrations (wrangler format) |
| `../scripts/allow-orgs.mjs` | the operator's command that lets an owner domain have more organizations (its tests are `test/allow-orgs.test.mjs`) |

## Configuration

The deploy pipeline generates the production wrangler config from this list; keep the names in step with it.

| Name | Kind | Notes |
|---|---|---|
| `DB` | D1 | migrations in `migrations/` |
| `EMAIL` | `send_email` | Cloudflare Email Service; restrict it to the `EMAIL_FROM` address |
| `RL_AUTH` | ratelimit | suggested `limit: 10, period: 60`; keys per action and IP, and per action and email (hashed) |
| `RL_APP` | ratelimit | suggested `limit: 600, period: 60`; keyed per user (and per IP on public paths) |
| `RL_PUBLIC` | ratelimit | suggested `limit: 60, period: 60`; requests to an app's public paths that aren't GET or HEAD, keyed per app and IP (`public-post:<app>:<ip>`), on top of `RL_APP` |
| crons | trigger | `*/5 * * * *` (the apps' tick, `src/scheduled.ts`) and `17 3 * * *` (the daily cleanup) |
| `APP_<APP>` | service | one per app, e.g. `APP_CAPTABLE` → `insulin-apps-captable` |
| `SITE_DOMAIN` | var | e.g. `insulinapps.com` |
| `SITE_APPS` | var | JSON list (a string, or an already-parsed array): `[{ "name", "title", "summary", "binding", "source", "permissions", "publicPaths", "scheduled" }]`; `permissions` is the app's catalog from its `package.json` (`insulin.permissions`), `publicPaths` its paths for people without an account (`insulin.publicPaths`) and `scheduled` the path its tick goes to, or null (`insulin.scheduled`); a malformed list fails closed |
| `GOOGLE_CLIENT_ID` | var | optional; empty hides Google sign-in |
| `GOOGLE_CLIENT_SECRET` | secret | required when `GOOGLE_CLIENT_ID` is set |
| `TURNSTILE_SITE_KEY` | var | required |
| `TURNSTILE_SECRET_KEY` | secret | required |
| `EMAIL_FROM` | var | `Name <address>` or a bare address (the name then is "Insulin Apps") |
| `SUPPORT_EMAIL` | var | optional contact on the landing, privacy and terms pages; empty points to the repository's issues |
| `ORG_REQUEST_EMAIL` | var | optional; Insulin Apps support's address, which gets requests for more organizations (DESIGN.md §3.1) with Reply-To the requester. Empty: the page at the limit shows the contact above instead. An unusable value is ignored and logged by name |
| `GATEWAY_SECRET_KEY` | secret | optional, base64 of 32 random bytes; seals stored secrets (AES-256-GCM, a key per purpose) and derives per-app secrets. A value that isn't 32 bytes fails closed |
| `SITE_ENV` | var | **local development and tests only**: `test` captures mail and relaxes cookies on `http://*.localhost`. Any non-empty value is a configuration error unless it is `test` and `SITE_DOMAIN` ends in `.localhost` |

The app Worker gets `x-suger-user-id`, `x-suger-organization-id`, `x-suger-app-id` (`insulin-apps-<app>`),
`x-suger-app-role` and the URL-encoded `x-suger-user-email` and `x-suger-user-name`, as `@fours/app` reads them with
`SUGER_ACCESS_MODE=console`, plus `x-suger-access-via` (`browser`, `mcp` or `api`) and, for an app with a permission
catalog, `x-suger-app-permissions` (space-separated). A request on a public path carries only `x-suger-app-id` and
`x-suger-access-via: public`, and the five-minute tick only `x-suger-app-id` and `x-suger-access-via: schedule`. The
app role is `ADMIN`, `EDITOR` or `VIEWER`: organization owners and admins are admins in every app, and a custom role is
sent as the least built-in role that has its permissions (DESIGN.md §2.4). Every incoming `x-suger-*` header and the gateway's cookies are removed first. User, organization and
invitation ids are random UUIDs (`crypto.randomUUID()`), so apps receive UUIDs as user and organization ids.

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

- `http://insulinapps.localhost:8787/`: the landing page, sign-in, accounts, organizations and their settings
- `http://captable.insulinapps.localhost:8787/`: the app (the stub echoes the identity headers it receives); its
  people and integrations are at `http://insulinapps.localhost:8787/apps/captable/settings/users` and `.../integrations`
- `http://insulinapps.localhost:8787/__insulin/dev/mail`: mail captured instead of sent (`?format=json` for JSON)

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
- **OAuth for agents and service accounts.** Each app's `/mcp` is its own protected resource, so a client registers and
  is authorized per app; tokens are 32 random bytes stored as SHA-256, access tokens last an hour, refresh tokens rotate
  and a replayed one ends its grant, and codes and refresh tokens are bound to their client. Every MCP call and every
  service-account call re-checks the grant or account and the current role (`access.ts`) before it is forwarded with
  no cookies, `Origin` set to the app (tokens aren't ambient credentials, so the app's CSRF check has nothing to
  protect), `x-suger-access-via: mcp` or `api`, and a `User-Agent` naming the client (`Insulin Apps MCP: <client>`,
  `Insulin Apps API: <account>`). Leaving or being removed from an organization deletes one's grants in it, and a
  credential change deletes all of them (triggers), so neither a later invitation nor an intruder's agent survives.
  Token requests are limited per IP before any check, and per client only when they fail; an MCP batch holds at most
  10 messages, each tool call counted against the app rate. A person's token never works on `/api/*`, and a service
  account's never on `/mcp`.
- **OAuth clients for API access** (service accounts, DESIGN.md §5.3) are managed by the organization's owners and
  admins only; each write re-checks OWNER or ADMIN in its statement (`orgAdmin` in `db/grants.ts`), never the app-admin
  rule. A rotation keeps the previous secret valid for 24 hours (`previous_secret_hash`, `previous_secret_expires_at`),
  so at most two secrets work; each access token records the hash of the secret that issued it (`client_secret_hash`),
  and the token insert re-checks that secret, so ending a secret early (Revoke previous secret now, or a second
  rotation) deletes exactly its tokens, in the same batch. Tokens issued before migration 0008 have no hash and count
  as the previous secret's.
- **Public paths** (DESIGN.md §8.1) are checked before any session or token: a match is forwarded with only
  `x-suger-app-id` and `x-suger-access-via: public`, without the caller's `Authorization`, with no account bar, and
  limited per IP (`RL_APP`); anything but GET and HEAD also per app and IP, more strictly (`RL_PUBLIC`). Reserved
  paths are routed first, and a path that hides a dot segment or a slash in its encoding is never public, so a trick in
  the path can only fall back to the normal checks.
- **The tick** (DESIGN.md §8.5). On the five-minute cron the `scheduled` handler POSTs to each app's declared
  `insulin.scheduled` path over its binding, every app in its own `waitUntil`, with `x-suger-app-id` and
  `x-suger-access-via: schedule` only, an empty body and a 25-second timeout, and logs the app and the status. The
  daily cron runs the cleanup instead. Since every incoming `x-suger-*` header is removed and app Workers have no
  public route, nothing from outside can pass for the tick.
- **The mail relay** (DESIGN.md §8.2) takes one message per request from an app with its `SUGER_APP_TOKEN`, for an
  existing organization, and sends it from `EMAIL_FROM` named after the app. Its slot in `mail_log` (`kind` `app:<name>`)
  is taken by one statement that checks the per-recipient cap and the app's 500 a day for the organization.
- **The integration proxy** only forwards to the stored base URL's host or an allowed host, over https, never to the
  site's own hosts, without following redirects, with every `x-suger-*`, cookie and authorization header removed and
  the stored credential added; a path segment that decodes to `.` or `..` or holds an encoded slash is refused.
- **Enterprise SSO.** An owner's verified domains decide where "Sign in with SSO" goes; the SAML ACS is the only form
  exempt from the Origin check (the identity provider posts it from another site), so its request is single use and
  bound to a host-only `__Host-insulin_sso` cookie (`SameSite=None`), and the signature must cover the element that is
  read. Responses over 256 KB or nested deeper than 64 elements are refused before parsing. SCIM has its own JSON
  dispatch with per-organization bearer tokens, and reaches only addresses in a currently verified domain. "Require
  SSO" is checked early in each form, and again in `finishSignIn` and the code step (`src/sso/required.ts`) against the
  account's stored address. Domain verification and OIDC discovery and token calls are the gateway's only outside
  fetches besides Google, Turnstile and the integration proxy; none follows a redirect.
- **Two-step sign-in.** With an authenticator app turned on, `finishSignIn` gives the browser a 10-minute challenge and
  a host-only `__Host-insulin_mfa` cookie instead of a session; only a code (or a recovery code) at `/login/mfa` starts
  the session, under the credential version the first step verified. A used time step, a recovery code and a
  challenge are each spent by one conditional statement, so two concurrent answers can't both pass; five wrong answers
  end a challenge, and ten wrong app codes in a row, across challenges, pause app codes for an hour (`users.totp_failures`,
  `totp_locked_until`, one statement). The secret is sealed with `GATEWAY_SECRET_KEY` (purpose `totp`); turning the
  feature on needs the password (or a sign-in in the last ten minutes for an account without one), and turning it on
  or off raises the credential version, which ends every other session. Enterprise SSO asks for the code too, and the
  challenge carries its organization.
- **Credential version.** Every password set, change or reset (and clearing a password when Google takes over an
  unconfirmed account) raises `users.credential_version`. A session is valid only while its version matches, and
  session inserts and password writes are conditional on the version the request verified, so a sign-in or password
  change that verified the old password before a reset changes nothing.
- **Links are staged.** A new confirmation or reset token is stored next to the older ones; only after its e-mail goes
  out do the older links stop working. A capped or failed send drops the new token, so flooding requests cannot
  invalidate the links someone already received.
- **Organization changes re-check the actor in SQL.** Rename, delete, invite, revoke, resend, role and app-access
  changes, removals and custom roles carry an `EXISTS` on the actor's current role (with the OWNER and ADMIN limits, the
  app-admin rule in `db/grants.ts` `appAdmin`, and owner-only custom roles) in the same statement, and the
  50-pending-invitation cap sits inside the insert. A member whose role is lowered, or who is removed, mid-request
  changes nothing.
- **Invite only verified domains** (DESIGN.md §3). `orgs.invite_verified_domains_only`, which an OWNER sets on
  `/settings/organization` (the statement re-checks OWNER, and turning it on needs a verified domain), is checked inside
  the invitation insert, the resend's claim and the acceptance's membership insert (`db/orgs.ts` `invitableDomain`),
  against the domain `owner-domain.ts` `domainOf` gives (lower case, punycode). An invitation from before, or one whose
  domain was since removed, can't be sent again or bring anyone new in; an existing member is already in. The page code
  checks first, before claiming a resend, to word the refusal as for a new invitation.
- **Organizations per owner domain** (DESIGN.md §3.1). `orgs.owner_domain` is the registrable domain of the creator's
  address (`tldts`, the Public Suffix List's ICANN section), or their address without a +tag at a public mail provider
  (Gmail without dots, at gmail.com). The providers are the gateway's list and `email-providers`; `src/owner-domain.ts`
  holds the rules and is pure, so `allow-orgs.mjs` imports it too. The org insert is an `INSERT … SELECT … WHERE
  (SELECT COUNT(*) …) < COALESCE(allowance, 2)`, batched with the OWNER membership, which is written only if the org
  was, so concurrent creations can't pass the limit. Migrations 0007 and 0009 filled rows in SQL, which can't write
  punycode or read the suffix list, so the count also takes the as-typed form of a non-ASCII domain and, for a
  domain, rows under its subdomains (`LIKE '%.' || domain`, escaped). `users.orgs_created` is a record only. At the
  limit, `/orgs/new` asks support for more (`POST /orgs/request`, mail kind `org_request`, Reply-To the requester,
  `RL_AUTH`; a day's requests capped at three per person in `mail_log.user_id`, three per owner domain in
  `mail_log.owner_domain_hash` and fifty in all, in the insert's own statement). The message's `allow-orgs.mjs`
  command quotes the owner domain only when `checkOwnerDomain` takes it unchanged. Operators raise a domain's limit
  with `.github/hosting/scripts/allow-orgs.mjs`.
- **One kind of access or the other.** Triggers keep `app_grants` to specific-apps (`APPS`) memberships and drop a
  member's grants the moment they get an organization role; composite foreign keys keep a grant's custom role in the
  same organization and app, and stop a custom role from being deleted while anything uses it.
- **An app's settings live on the apex** (`/apps/<app>/settings/...`); the app's host only redirects there. The
  session cookie reaches app hosts, so a page served there could be read, and its forms posted, by code the app serves.
- **Forms on an app's settings pages carry the organization's id**, so switching the active organization in another
  tab can't redirect a change made on a page that was showing the previous one.
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
  of at most 200 per table after each POST (`src/housekeeping.ts`). The daily cron (`17 3 * * *`) runs the same
  cleanup in bigger batches.

## shadcn/ui

The components in `src/components/ui/` come from [shadcn/ui](https://ui.shadcn.com) (MIT License, copyright shadcn),
new-york style, as `npx shadcn@4.23.0 add button card input label alert badge separator table avatar native-select
field textarea` wrote them. Two changes, for pages that render only on the server:

- `cn` comes from `@/lib/utils` (clsx and tailwind-merge) rather than the young `cn` package the CLI now imports.
- The Radix primitives, which need client-side React, are replaced by the elements they render: `<label>` (Label), a
  `<div>` with the same role and orientation (Separator), `<span>`s (Avatar, without AvatarImage), and no `asChild`
  on Button and Badge (links take `buttonVariants()` as their class instead).

The theme in `src/styles/gateway.css` is shadcn's neutral base colour, with dark mode on `prefers-color-scheme`
instead of a `.dark` class, and `--ring` set to the primary colour so focus rings keep a 3:1 contrast. Icons are from
[Lucide](https://lucide.dev) (ISC). `NOTICE` has the licences.
