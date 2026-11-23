# Insulin Apps gateway

A Cloudflare Worker (`insulin-apps-gateway`) that signs people in, keeps their organizations and roles, and puts each
app on its own subdomain. It plays the part the Insulin console's entry worker plays in production: it authenticates
the user, picks their active organization, works out their role in the app, and forwards the request to the app Worker
over a service binding with the console identity headers. The apps need no hosting-specific code.

| Host | What it serves |
|---|---|
| `SITE_DOMAIN` (e.g. `insulinapps.com`) | `/` (the landing page, public and indexable, or the home page once signed in), `/privacy`, `/terms`; `/robots.txt`, `/sitemap.xml`, `/llms.txt` and `/llms-full.txt`; the public docs at `/docs/` (every page, `/docs/llms.txt`, `/docs/llms-full.txt`, each page's `.md`, the images at `/docs/assets/*`, the search at `/docs/search` and `/docs/search.json`, and the docs' MCP server at `/docs/mcp`); sign-up, sign-in and `/login/mfa`; the account, `/account/security`, `/account/agents`; organizations, `/settings/users`, `/settings/roles`, `/settings/organization`, `/settings/oauth-clients`; each app's `/apps/<app>/settings/users`, `/apps/<app>/settings/integrations`, `/apps/<app>/settings/api` (API access) and `/apps/<app>/settings/connect-ai` (Connect AI); invitations; the OAuth authorization server (`/.well-known/oauth-authorization-server`, `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`); the operator console at `/super` for Insulin Apps staff (DESIGN.md §11; a 404 unless configured); `/favicon.ico`, `/apple-touch-icon.png` |
| `www.SITE_DOMAIN` | a 301 to the apex, same path and query |
| `auth.SITE_DOMAIN` | a 308 to the apex, same path and query: sign-in used to live here, and e-mails already sent link to it |
| `<app>.SITE_DOMAIN` | the app, through its `APP_<APP>` service binding (its own favicon included), except the gateway's `/mcp` and `/.well-known/oauth-*`, and `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`, which redirect (GET only) to the app's settings on the apex; `/api/*` with a service account's Bearer token goes to the app as that account; the app's public paths (`insulin.publicPaths`) go to it for anyone, with no identity (DESIGN.md §8.1); every five minutes the gateway POSTs to the app's `insulin.scheduled` path, if it has one (DESIGN.md §8.5) |
| `/__insulin/*` on every host | reserved, never forwarded: stylesheet, favicon (`icon.svg`), account bar, `me`, `switch-org`, `logout`; on the apex, the navigation's collapse toggles `/__insulin/nav` (DESIGN.md §3.2), the integration proxy `/__insulin/integrations/*`, the apps' mail relay `/__insulin/mail` (DESIGN.md §8.2), their hourly usage reports `/__insulin/metrics` (DESIGN.md §8.6), their limits `/__insulin/limits` (DESIGN.md §8.8), and their members `/__insulin/members`, `/__insulin/members/status` and `/__insulin/member-events` (DESIGN.md §8.9) |

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
| `src/auth/` | sessions, email and password accounts, Google sign-in, the account page; `sign-in.ts`, where every sign-in becomes a session; `standing.ts`, which refuses an account the operators suspended or disabled; `totp.ts` (RFC 6238 codes, recovery codes), `mfa.ts` (the second step at `/login/mfa`) and `security.ts` (Account → Security at `/account/security`) |
| `src/roles.ts` | organization roles, app roles, permissions and who may give what |
| `src/owner-domain.ts` | owner domains (registrable domain, or a provider address in Gmail's form), the public mail providers, and the strict check `allow-orgs.mjs` and the request to support apply; pure, so the script imports it too |
| `src/access.ts` | someone's role and permissions in one app, from their organization role or their grant; every way into an app ends here |
| `src/orgs/` | organizations and the settings pages (`orgs.ts`), invitations, custom roles (`custom-roles.ts`), an app's people page (`app-users.ts`), every OAuth client of the organization (`oauth-clients.ts`), access in forms and words (`access-forms.ts`) |
| `src/proxy.ts` | the app proxy: identity headers, header and cookie stripping, the account bar on HTML |
| `src/scheduled.ts` | the crons: the apps' five-minute tick to their `insulin.scheduled` path, and which cron runs the daily cleanup |
| `src/metrics/report.ts`, `src/db/metrics.ts` | the apps' hourly usage reports (`POST /__insulin/metrics`, DESIGN.md §8.6): checking them, storing them hourly and daily, and reading them back for the console |
| `src/super/` | the operator console (DESIGN.md §11): its routes and actions (`routes.ts`), its Google Workspace SAML sign-in and session (`auth.ts`), its queries, standings and audit log (`db.ts`), the Cloudflare snapshot (`cloudflare.ts`) and the hourly job that takes it (`jobs.ts`), and what admins type into a limit's form (`limits.ts`); its pages are in `src/pages/super/` (`limits.tsx`: an app's limits page and each organization's Limits section) |
| `src/oauth/` | the authorization server: metadata, registration, authorize and consent, token, revoke; token formats and lifetimes, `resolveBearer`, and calls to an app with a token (`app-api.ts`) |
| `src/mcp/server.ts` | each app's `/mcp` (stateless JSON-RPC; tools `whoami`, `endpoints`, `read`, `change`) and its protected-resource metadata |
| `src/mcp/docs.ts` | the docs' MCP server at `/docs/mcp` on the apex: public, no sign-in, tools `search_docs`, `read_doc`, `list_docs` |
| `src/mcp/connect-ai.ts` | an app's Connect AI page (`/apps/<app>/settings/connect-ai`): its MCP server and each client's setup, the person's agents for the app, and everyone's for owners and admins, with Disconnect |
| `src/integrations/` | an app's integrations page (`settings.ts`, stored credentials), its API access page (`api-clients.ts`, OAuth clients: owners and admins manage them, rotation with a 24-hour overlap, and the link to the app's own settings for each client), and the integration proxy (`proxy.ts`) |
| `src/auth/agents.ts` | Account → AI agents (`/account/agents`): a person's grants, disconnecting them, and links to each app's Connect AI |
| `src/sso/` | enterprise sign-in and provisioning: `/settings/sso` (`settings.ts`), the flow cookie and requests (`flow.ts`), SAML (`saml.ts`, with the XML libraries loaded through `xml-deps.js`), OIDC (`oidc.ts`), SCIM 2.0 at `/scim/v2` (`scim.ts`) |
| `src/reserved.ts` | `/__insulin/me` (who is signed in, their organizations, the apex's origin and, in an app, its settings pages), `switch-org`, `logout`, `nav` (the navigation's collapse toggles), and the local captured-mail page; and routes the apps' own endpoints (mail, metrics, limits, members) |
| `src/http/app-caller.ts` | the apps' endpoints of DESIGN.md §8.8 and §8.9: apex only, the app's `SUGER_APP_TOKEN` only (the app is the token's), 503 without `GATEWAY_SECRET_KEY`, and their cursors |
| `src/limits/endpoint.ts`, `src/db/limits.ts`, `scripts/limits-catalog.mjs` | app limits (DESIGN.md §8.8): `GET /__insulin/limits`; the catalog, the admins' defaults and each organization's overrides with their change numbers, and the watch list's query; the SQL the deploy and the local run use to write each app's catalog to D1 |
| `src/members/` | what apps learn about their organizations' people (DESIGN.md §8.9): the signed `x-suger-member-lookup` header (`lookup-token.ts`), where each app is used (`app-use.ts`, one D1 write per app, organization and isolate), member events in one app's terms (`events.ts`), and the lookup, member status and member events endpoints (`endpoints.ts`); their queries are in `src/db/members.ts`, and the events are written by the triggers of migration 0012 |
| `src/navigation.ts` | the two-level navigation of the signed-in pages as data (DESIGN.md §3.2): level 1 and 2 for the organization's pages, the account pages and an app's settings pages (its manifest, by the person's role), the breadcrumb, the `insulin_nav` cookie and `/__insulin/nav`; `src/nav-icons.ts` the icon names an app's manifest may use (list-apps.mjs's) and each app's own icon (also the docs') |
| `src/mail/` | the transport (Email Service binding, or the `mail_capture` table in test mode), the messages, and the apps' mail relay (`relay.ts`) |
| `src/turnstile.ts`, `src/ratelimit.ts` | bot checks and rate limits |
| `src/pages/` | the pages, as React components; `pages/document.tsx` is the shared document (the top bar or, signed in, the navigation; footer, favicon links); `settings.tsx` the organization's settings; `app-settings.tsx` an app's settings frame and People page, with `integrations.tsx`, `api-access.tsx` and `connect-ai.tsx` its other pages |
| `src/pages/html.ts` | the `html` tag, which escapes the HTML of the e-mails (React escapes the pages) |
| `src/docs.ts`, `src/pages/docs.tsx` | `/docs/` on the apex: the pages from `src/assets/docs-content.ts` in the shared document, `llms.txt`, `llms-full.txt`, each page's `.md`, and `/docs/assets/*` from the `DOCS_ASSETS` binding |
| `src/docs-search.ts`, `src/pages/docs-search.tsx` | searching the docs: the passages of the generated index ranked in memory, for `/docs/search` (the page), `/docs/search.json` and the docs' MCP server |
| `src/crawl.ts` | `/robots.txt` and `/sitemap.xml` on the apex |
| `scripts/build-docs.mjs`, `scripts/docs/` | `npm run build:docs`: the Markdown of `.github/hosting/docs/` and every app's `docs/public/` rendered with React (`markdown.mjs`; `layout.mjs`, with the two-level navigation) into `src/assets/docs-content.ts`, with the diagram blocks drawn as SVG (`diagram.mjs`) and the search index (`search-index.mjs`) |
| `src/components/ui/` | shadcn/ui components (new-york style), as the shadcn CLI writes them; see "shadcn/ui" below |
| `src/components/` | the gateway's own pieces: top bar, the navigation (`shell.tsx`, with the manifest's icons in `nav-icon.tsx`), footer, `<details>` menus, form fields, brand marks |
| `src/lib/utils.ts` | `cn()`, shadcn's class-name helper (`clsx` and `tailwind-merge`) |
| `src/styles/gateway.css` | the Tailwind CSS source: shadcn's neutral theme tokens, light and dark |
| `src/assets/` | what the Worker serves itself: the compiled stylesheet (`gateway-css.ts`, generated), the docs (`docs-content.ts`, generated), the mark (`icon.ts`) and its PNG renderings (`icons.ts`, generated), and the account bar (script and stylesheet) |
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
| `DOCS_ASSETS` | assets | Workers Static Assets: `{ directory: .github/hosting/docs/assets, binding: DOCS_ASSETS, run_worker_first: true }`. The docs' images; `run_worker_first` sends every request to the Worker first (Wrangler 4.149 sets `invoke_user_worker_ahead_of_assets`), so the directory is reached only through the binding, which `src/docs.ts` serves at `/docs/assets/*` and nowhere else. Optional: without it the docs show no images |
| crons | trigger | `*/5 * * * *` (the apps' tick, `src/scheduled.ts`) and `17 3 * * *` (the daily cleanup) |
| `APP_<APP>` | service | one per app, e.g. `APP_CAPTABLE` → `insulin-apps-captable` |
| `SITE_DOMAIN` | var | e.g. `insulinapps.com` |
| `SITE_APP_<APP>` | var | one per app, named like its binding (`SITE_APP_CAPTABLE`): JSON (a string, or an already-parsed object) `{ "name", "title", "summary", "binding", "source", "permissions", "publicPaths", "scheduled", "navigation", "clientSettings" }`; `permissions` is the app's catalog from its `package.json` (`insulin.permissions`), `publicPaths` its paths for people without an account (`insulin.publicPaths`), `scheduled` the path its tick goes to, or null (`insulin.scheduled`), `navigation` its level 1, which the app's settings pages show (`insulin.navigation`, DESIGN.md §3.2; missing in an older list, it is empty), and `clientSettings` its page for each OAuth client, `{path, description?}` or null (`insulin.clientSettings`, DESIGN.md §5.3.1), which the API access page links for owners and admins; a malformed list fails closed. The deploy leaves out `binding` (the gateway takes `APP_<APP>` from the name; one given must match) and every field that is null or empty, so the list fits Cloudflare's 5 KB a variable |
| `GOOGLE_CLIENT_ID` | var | optional; empty hides Google sign-in |
| `GOOGLE_CLIENT_SECRET` | secret | required when `GOOGLE_CLIENT_ID` is set |
| `TURNSTILE_SITE_KEY` | var | required |
| `TURNSTILE_SECRET_KEY` | secret | required |
| `EMAIL_FROM` | var | `Name <address>` or a bare address (the name then is "Insulin Apps") |
| `SUPPORT_EMAIL` | var | optional contact on the landing, privacy and terms pages; empty points to the repository's issues |
| `ORG_REQUEST_EMAIL` | var | optional; Insulin Apps support's address, which gets requests for more organizations (DESIGN.md §3.1) with Reply-To the requester. Empty: the page at the limit shows the contact above instead. An unusable value is ignored and logged by name |
| `GATEWAY_SECRET_KEY` | secret | optional, base64 of 32 random bytes; seals stored secrets (AES-256-GCM, a key per purpose), derives per-app secrets and signs the member lookup header. Without it the apps' endpoints (mail, metrics, limits, members) answer 503 and browser requests carry no `x-suger-member-lookup`. A value that isn't 32 bytes fails closed |
| `SITE_ENV` | var | **local development and tests only**: `test` captures mail and relaxes cookies on `http://*.localhost`. Any non-empty value is a configuration error unless it is `test` and `SITE_DOMAIN` ends in `.localhost` |
| `SUPER_SAML_IDP_ENTITY_ID`, `SUPER_SAML_IDP_SSO_URL`, `SUPER_SAML_IDP_CERT`, `SUPER_GOOGLE_GROUP` | var | optional; the operator console's Google Workspace SAML app (entity id, sign-in URL, signing certificate as PEM) and the group whose members may sign in, by its name as Google sends it (DESIGN.md §11.1). All four, or the console is off: set in part or unusable, it stays off and the names are logged, and the rest of the site is unaffected |
| `SUPER_ADMIN_EMAILS` | var | optional; the console's admins, addresses separated by commas or whitespace; an entry that isn't an address is ignored and logged |
| `SUPER_CLOUDFLARE_API_TOKEN`, `SUPER_CLOUDFLARE_ACCOUNT_ID` | secret, var | optional; a Cloudflare API token with Workers Scripts: Read, Account Analytics: Read and Containers: Read only (never D1, which could query the apps' databases, nor R2, which could read every object in the engines' buckets) and the 32-hex account it reads, for the console's hourly resource snapshot (DESIGN.md §11.5). Both, or none |

**One variable per app.** Cloudflare holds a variable to 5 KB, and `deploy-apps.test.mjs` checks every gateway
variable for this repository's apps against 5,000 bytes. All the apps' entries in one `SITE_APPS` list passed that
with a fourth app, so each app has its own `SITE_APP_<APP>`, and the limit is per app: Cap Table's, the largest, is
about 2 KB, most of it its permission catalog and navigation. The gateway reads every `SITE_APP_*` variable and refuses
one whose `name` isn't the app its name is for. An app that outgrows 5 KB alone moves its catalogs and navigation to
the gateway's D1, as the limit catalogs already are (`writeLimitCatalogs`).

The app Worker gets `x-suger-user-id`, `x-suger-organization-id`, `x-suger-app-id` (`insulin-apps-<app>`),
`x-suger-app-role` and the URL-encoded `x-suger-user-email` and `x-suger-user-name`, as `@fours/app` reads them with
`SUGER_ACCESS_MODE=console`, plus `x-suger-access-via` (`browser`, `mcp` or `api`) and, for an app with a permission
catalog, `x-suger-app-permissions` (space-separated). A person's requests (`browser` and `mcp`) also carry
`x-suger-org-role` (`OWNER`, `ADMIN`, `EDITOR`, `VIEWER`, or `APPS` for specific apps; DESIGN.md §2.4), which apps
honour only with `SUGER_TRUST_ORG_ROLE` (the deploy and the local stack set it to `true`), and browser requests, when
`GATEWAY_SECRET_KEY` is set, `x-suger-member-lookup`: `v1.<organization>.<person>.<expiry>.<signature>`,
the expiry five minutes ahead in epoch seconds and the signature an HMAC-SHA256 (base64url) over
`v1|<app>|<organization>|<person>|<expiry>` with a key derived from `GATEWAY_SECRET_KEY` (HKDF-SHA256, info
`insulin-apps:member-lookup`). A request on a public path carries only `x-suger-app-id` and
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
npm run build:docs             # after changing any docs page, image or the renderer (writes src/assets/docs-content.ts)
npm run check:docs             # fails while src/assets/docs-content.ts is stale (npm test checks it too)
npm run build:icons            # after changing the mark in src/assets/icon.ts (renders the PNGs with resvg)
```

The stylesheet is compiled ahead of time and committed as a module (`src/assets/gateway-css.ts`), so the deploy needs
no CSS step: wrangler bundles it with everything else. Tailwind scans `src/components`, `src/pages` and the docs
renderer (`scripts/docs`) for classes. The favicon PNGs are committed the same way (`src/assets/icons.ts`); the
static-assets binding holds only the docs' images.

### The public docs

`https://insulinapps.com/docs/` is generated from Markdown kept next to what it describes: the platform's pages in
`.github/hosting/docs/*.md` and each app's in `<app>/docs/public/*.md` (apps found by `list-apps.mjs`, each its own
section after Platform). A page is front matter (`title`, `description`, `order`) and Markdown: `##` to `####`
headings (the title is the page's only `<h1>`), lists, GFM tables, code, GitHub callouts (`> [!NOTE]`), links to
`/docs/<section>/<page>` (checked: a missing page or heading fails the build), images under `/docs/assets/` (checked
too, and linked with their content hash, so they are cached for good), and ` ```diagram ` blocks: boxes, groups and
arrows in a small language described at the top of `scripts/docs/diagram.mjs`, drawn as inline SVG coloured only by
the stylesheet's `--diagram-*` tokens. Raw HTML fails the build.

`npm run build:docs` renders each page with React in the gateway's shadcn style (`scripts/docs/layout.mjs`: the
navigation, the article, its table of contents, previous and next) and refuses any script, style attribute or event
handler in the result. The navigation has the two levels of DESIGN.md §3.2, in shadcn's sidebar colours, drawn at build
time: level 1 is Overview, Platform, then each app under "Apps" (with the icon the gateway gives it, `appIconName` in
`src/nav-icons.ts`), and "For AI agents" (llms.txt, llms-full.txt) at the bottom; level 2, headed by the section's
title, lists only the open section's pages, the current one with `aria-current="page"` (the open level-1 item has
`aria-current="true"`). `/docs/` has no level 2: its cards list every section. So each app's docs read as a place of
their own at `/docs/<app>/`. The levels don't collapse (the pages are static, with no per-request state), and there is
no organization switcher or person, since the docs are public. Below 1024px a `<details>` menu above the article holds
level 1, the open section's pages and the agents' files. The gateway puts a page into the shared document per request
(`src/pages/docs.tsx`), so the top bar, spanning the window over the navigation, shows the visitor's sign-in links or
account; the pages are public, indexable and under the usual CSP. `/docs/llms.txt` lists every page for AI
agents, `/docs/llms-full.txt` holds all of them, and each page's Markdown is at its address with `.md`. Commit the
regenerated module with the change; `npm test` fails while it is stale, and the gateway workflow runs when a docs page
changes.

**Search, crawlers and agents** (`.github/hosting/docs/searching-the-docs.md` is the page for readers). The build also
cuts each page at its headings into passages of plain text, each under its anchor (`scripts/docs/search-index.mjs`),
and renders the navigation around `/docs/search` with a slot for the results. `src/docs-search.ts` ranks those
passages in memory per request: a word matches the words starting with its stem, a heading counts most, then the
page's title, its description and the passage's text; a passage with every word comes first, and only the pages with
the most of the words are listed. Three entries use it, all public and limited per IP (`allowPublic`, `RL_APP`):
`/docs/search?q=` (a page, not indexed, `robots.txt` keeps crawlers off its results), `/docs/search.json?q=&limit=`
(CORS open) and the docs' MCP server at `/docs/mcp` (`src/mcp/docs.ts`: stateless JSON-RPC like the apps' servers, no
OAuth; `search_docs`, `read_doc`, `list_docs`). Every page has a search box at the top of level 1 (above the menu on
narrow screens), Open Graph tags (`src/pages/document.tsx`, on every page with a description) and schema.org
microdata, `TechArticle` and `BreadcrumbList`, written as attributes because JSON-LD would need a `<script>`.
`/robots.txt` allows every crawler, `/sitemap.xml` lists the landing page, privacy, terms and every docs page, and
`/llms.txt` and `/llms-full.txt` are the docs' own, at the root.

The screenshots in `.github/hosting/docs/assets/screenshots/` come from a real local run, driven in Chrome with
Playwright through synthetic data (`.github/hosting/docs/screenshots.mjs`, a small package with its own lockfile):

```bash
(cd ../../../captable && npm ci && NITRO_PRESET=cloudflare_module npm run build)
(cd ../../../esign && npm ci && NITRO_PRESET=cloudflare_module npm run build)
(cd ../../../knowledge && npm ci && NITRO_PRESET=cloudflare_module npm run build)
(cd ../docs && npm ci && node screenshots.mjs)   # --app, --only <name,...>, --headed, --debug <dir>, --chrome <path>
npm run build:docs
```

It starts the gateway with the three apps over https (`wrangler dev --local-protocol https`, which Esign's embedded
editor needs) in a fresh local state, signs up through the captured-mail page, creates an organization, a custom role
and invitations, stores a credential, creates two OAuth clients and rotates one's secret, connects an MCP client,
imports Cap Table's own spreadsheet template filled with a fictional company, places Esign fields, sends an envelope
and signs it, captures Knowledge with its in-memory engine (`knowledge-screenshots.mjs`), then creates a second
organization under the same email domain so that the next one is a request to support (`ORG_REQUEST_EMAIL` is set to
a synthetic address; mail is captured), with Cloudflare's always-passing Turnstile test widget as the only outside
call. A completed Esign envelope can't be captured locally (its seal needs a seal key
binding `wrangler dev` can't provide, and a timestamp service), so `esign-completed.png` is a labelled placeholder. Nor
can a domain be verified (`wrangler dev` can't stub the DNS-over-HTTPS lookup), so `platform-organization.png` shows
the invitation setting before one is.
`--only` writes just the named images, so a change to a few pages doesn't rewrite the rest, and `--app knowledge` starts
and captures Knowledge alone (`--app captable,esign` the rest). Knowledge's step moves the in-memory engine's clock
between changes, so that History has restore points of their own, through a relay to the engine's control interface
on the next port; the screenshots are written to the run's own folder and copied at the end, since writing into the
assets folder would reload the stack and empty that engine.

`npm run dev` writes `.dev/gateway.wrangler.json` (from `wrangler.local.jsonc`) and the app Worker's config, applies
the D1 migrations locally and runs `wrangler dev --local` with the configs. Open:

- `http://insulinapps.localhost:8787/`: the landing page, sign-in, accounts, organizations and their settings
- `http://insulinapps.localhost:8787/docs/`: the public docs
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

Several built apps run together, each on its own host, with `--app captable --app esign`: the gateway's config then
gets a service binding and a `SITE_APP_<APP>` variable for each, read from its `package.json` as the deploy reads it. Esign
runs as it does when published, so it signs nothing until its settings are configured (the docs' screenshot script
passes local ones). By hand, which is what the script does:

```bash
node scripts/app-config.mjs --app captable        # writes .dev/gateway.wrangler.json and .dev/captable.wrangler.json
npx wrangler d1 migrations apply DB --local -c .dev/gateway.wrangler.json --persist-to .dev/state
npx wrangler d1 migrations apply DB --local -c .dev/captable.wrangler.json --persist-to .dev/state
npx wrangler dev -c .dev/gateway.wrangler.json -c .dev/captable.wrangler.json --local --persist-to .dev/state
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
  `location.assign`. It draws nothing on a page with an element marked `data-insulin-shell` (an app that renders
  the navigation of DESIGN.md §3.2), and a `MutationObserver` sends it away when a single-page app adds one later.
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
  domain, rows under its subdomains (ending in `.` and the domain, compared as text: D1 refuses a LIKE pattern over
  50 bytes, so the gateway's SQL matches bound text with `instr()` or a suffix, never a LIKE pattern).
  `users.orgs_created` is a record only. At the limit, `/orgs/new` asks support for more (`POST /orgs/request`, mail
  kind `org_request`, Reply-To the requester, `RL_AUTH`; a day's requests capped at three per person in
  `mail_log.user_id`, three per owner domain in `mail_log.owner_domain_hash` and fifty in all, in the insert's own
  statement). The message's `allow-orgs.mjs` command quotes the owner domain only when `checkOwnerDomain` takes it
  unchanged. Operators raise a domain's limit with `.github/hosting/scripts/allow-orgs.mjs`.
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
  value; `dangerouslySetInnerHTML` is never used, and a test checks it. The organization switcher and account menu
  (of the top bar, and of the navigation) are `<details>`/`<summary>` menus styled like shadcn's DropdownMenu:
  keyboard-operable, exclusive (`<details name>`), and closed by a click anywhere outside (the open trigger's
  `::before` covers the window).
- **The navigation without a script** (DESIGN.md §3.2). The signed-in pages render both levels on the server, from
  `navigation.ts`; the narrow-screen drawer is another `<details>`, which repeats the navigation (hidden from 768px,
  as the columns are below it, so assistive technology meets one copy), with ids kept unique. A collapse toggle is a
  link to `/__insulin/nav`, which stores both levels in the host-only `insulin_nav` cookie and answers with a 303 to
  the page it names, a path on the same host only (anything else is a 400); the next page renders collapsed or
  expanded from the cookie. Forms shown again after a POST point the toggles at the page's own address instead.
- **The docs are rendered at build time.** A docs page is the one place the gateway puts HTML into a page that React
  didn't render during the request: `src/pages/docs.tsx` renders the shared document around a placeholder element and
  swaps in the page from `src/assets/docs-content.ts`, which React rendered from the repository's Markdown at build
  time. Nothing from a request reaches it, and the build fails on a script, a `style` attribute or an event handler.
  Images are the only thing served from the static-assets binding, at `/docs/assets/*`, as images only.
- **Local https.** With `SITE_ENV=test` on `*.localhost`, origins keep the port over https too, so a local run behind
  `wrangler dev --local-protocol https` (the docs' screenshots) passes the Origin check; production origins never
  carry a port.
- **The operator console** (DESIGN.md §11) lives at `/super` on the apex and is a 404 until configured. It signs in
  only through the platform's own Google Workspace SAML app, with the same SAML checks as enterprise SSO
  (`sso/saml.ts`, which now also returns the signed assertion's attributes) and the operators' group in its `groups`
  attribute; its ACS is the console's one cross-site form, bound to a `__Host-insulin_super_flow` cookie. Its session
  is its own (`__Host-insulin_super`, host-only, eight hours, never renewed, `super_sessions`), so a customer's session
  opens nothing there and its own opens nothing elsewhere. Admins are `SUPER_ADMIN_EMAILS`, read at every request.
  Every action takes a reason and writes its audit record in the same batch, conditional on the change itself, so a
  repeated or stale request records nothing.
- **Suspended and disabled** (DESIGN.md §11.3). `users.status` and `orgs.status` are checked where access is decided,
  so nothing downstream needs to know: the session lookup and insert (an account), `findMembership`,
  `listMemberships` and the session's active organization (an organization's members), `findAccessRow` (every way into
  an app), `findAccessToken`, `redeemRefresh`, `issueServiceToken`, `insertGrantWithCode` and `redeemCode` (tokens and
  consent), `useScimToken`, the invitation acceptance, `joinOrg`, `findIntegrationSecret`, and the actor check every
  organization change repeats (`orgAdmin`, `appAdmin`, `owner` and the inline ones in `db/orgs.ts` and
  `db/invitations.ts`), which counts a membership only in an active organization. Sign-in pages say so (`auth/standing.ts`); the mail relay answers 403.
- **Last active**, to within an hour: the hourly session touch, the sign-in's session insert and the hourly touches of
  an agent's grant and an API client write `users.last_active_at` and `orgs.last_active_at` in the same batch, so
  activity costs no extra write per request.
- **Usage reports** (DESIGN.md §8.6) are stored in a few statements however many organizations they carry: the
  organizations go as one JSON parameter that `json_each` unpacks, so a report of 500 never meets D1's limits on
  statements per invocation or parameters per statement, and only organizations the gateway knows are stored. Each
  report also prunes up to 1,000 of its app's expired rows per table, more than it can add.
- **App limits** (DESIGN.md §8.8). The deploy writes each app's catalog (`insulin.limits`) to `app_limit_catalog` with
  `scripts/limits-catalog.mjs`, which replaces the app's whole catalog. A console admin's default (`app_limit_defaults`)
  or an organization's override (`org_app_limits`, a number or NULL for unlimited, until an optional time) is written in
  one batch with its audit record, conditional on being a change, and stamped with the next number of
  `app_limit_sequence`; `org_app_limit_changes` keeps each organization's latest number, removals included, so
  `GET /__insulin/limits?since=` lists the organizations changed after the cursor with all their current overrides, 500
  a page. An organization's first use of an app moves its number on (a trigger on `app_orgs`), so overrides set before
  reach the app. The watch list compares each app's latest usage report with the limit in force.
- **Where each app is used** (`app_orgs`): the first request the gateway forwards to an app for an organization (a
  page, an AI agent's tool call, an API client) writes a row before the request goes on, once per pair and isolate; if
  the row can't be written, the request doesn't go on (503, "isn't available right now"), and the next one tries again. The
  limits, members and member events an app reads are only those of its organizations; deleting an organization
  forgets its rows.
- **Member events** (DESIGN.md §8.9) are written by triggers (migration 0012), so every path that changes memberships,
  app grants, custom roles' permissions, API clients or organizations records them in its own transaction, however it
  is made, with no code of its own. An event is stored once, for every app (`*`) or one, with the roles after the change
  and, for a move between an organization role and specific apps, the apps before (a `BEFORE UPDATE` trigger, since the
  move drops the grants) or after (the grants of the same batch join the role's event through `member_event_moves`, which
  the move opens and `setAppAccess` closes before its batch commits; a grant joins it only when the membership changed at
  the grant's own time, so a move left open (by the gateway before migration 0012's code, during that release) is
  ignored and deleted by the next grant and by housekeeping, and a grant in any later transaction is an event of its
  own. So an app the person
  keeps sees one `role_changed`, not a departure and a return). `src/members/events.ts` turns it into each app's terms
  when read. Changes the organization's deletion cascades into say nothing; one `org_deleted` per app it used says it
  all. Housekeeping deletes events past 90 days, oldest first through the index on their time (it runs after every
  change, so it must not read the table), and keeps the highest id it deleted
  (`member_events_pruned`): a cursor below it gets 410.
- **The member lookup** takes the organization and person from the signed header, never from the app, checks the
  signature against the app the token names, then that the person can still use the app (`findAccessRow`), and limits
  each person on `RL_APP`. Member status reads no standing: a suspended account or organization is still a member.
- **The Cloudflare snapshot** (DESIGN.md §11.5) is the five-minute tick's: the first tick of each hour to claim the
  run in `super_jobs` reads the account (`api.cloudflare.com` only, no redirects, a 20-second timeout, the token never
  logged), keeps whatever parts it could read and names the rest. It finds each Worker's D1 database in the Worker's
  settings and the database's size in the analytics, so its token needs no D1 permission. For an app's engine
  (`insulin-apps-<app>-engine`) it also reads the container applications and their instances (Containers: Read),
  matched by the engine's Durable Object namespaces, and from the analytics the containers' time, the R2 buckets'
  storage and operations and the Durable Object requests, so it needs no R2 permission either; each such product is
  a part of its own, and Durable Objects' duration and Workers AI's neurons, which Cloudflare documents no source for,
  stay unknown.
- **Logs** carry event names, ids, error class names and identifier-like codes; never exception messages.
- **Retention.** Expired sessions, used or expired links, mail-log rows older than two days, apps' hourly usage
  reports past three days and daily ones past 400, member events past 90 days, and the console's expired sessions and
  sign-ins, job records past a week and Cloudflare snapshots past 90 days are deleted in batches of at most 200 per table after each POST
  (`src/housekeeping.ts`); the console's audit log is kept. The daily cron (`17 3 * * *`) runs the same
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
