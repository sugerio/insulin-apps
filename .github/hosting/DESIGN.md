# Accounts, roles and access on insulinapps.com

This is the design of everything the hosting gateway (`.github/hosting/gateway/`) decides about people and machines:
who may sign in and how, which organization they act in, what role they have in each app, and how AI agents and API
clients reach the apps. The apps only receive the result, as request headers. The operator runbook is
[README.md](README.md); the gateway's code map is [gateway/README.md](gateway/README.md); the rules every app follows
are in the repository's [AGENTS.md](../../AGENTS.md).

## 1. Hosts

| Host | Serves |
|---|---|
| `insulinapps.com` | The single entry for everything that is not an app: landing, privacy and terms; the public docs at `/docs/` (generated from `.github/hosting/docs/` and each app's `docs/public/`, with `/docs/llms.txt` for AI agents and the images at `/docs/assets/*` from the static-assets binding), searchable at `/docs/search` and `/docs/search.json` and through the docs' own MCP server at `/docs/mcp`, all public with no sign-in and limited per IP; `/robots.txt` (every crawler, AI crawlers included, may read all but the search results), `/sitemap.xml` (the landing page, privacy, terms and every docs page) and `/llms.txt`; sign-up, sign-in, MFA, Google and enterprise SSO; account and organizations; `/settings/users` and `/settings/roles` (the organization's people and roles); `/settings/organization` (name, who can be invited, leave, delete); `/settings/oauth-clients` (every OAuth client of the organization, §5.4); `/settings/sso` (SAML or OIDC and SCIM); each app's settings: people, integrations, API access and Connect AI at `/apps/<app>/settings/users`, `/integrations`, `/api` and `/connect-ai`; the OAuth authorization server for MCP clients and OAuth clients (service accounts); SCIM; the operator console at `/super` (§11), for Insulin Apps staff only, and the apps' hourly usage reports at `/__insulin/metrics` (§8.6). |
| `auth.insulinapps.com` | A 308 redirect to the same path on the apex, so links in e-mails already sent keep working. |
| `www.insulinapps.com` | A 301 redirect to the apex. |
| `<app>.insulinapps.com` | The app, plus the gateway's endpoints on that host: `/mcp` and its OAuth metadata, and `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`, which only redirect (GET) to the app's settings on the apex. Everything else goes to the app Worker: after sign-in, or, on the paths the app declares public (§8.1), for anyone, with no identity. |

Paths the gateway keeps on every app host, so apps must not use them: `/__insulin/*`, `/settings/users`,
`/settings/integrations`, `/settings/api`, `/settings/connect-ai` (and everything below each), `/mcp`, and
`/.well-known/oauth-*`.

An app's settings pages are served on the apex, never on the app's host: the session cookie is sent to app hosts too,
so code the app serves could otherwise read those pages (secrets shown once included) and post their forms as the
visitor. On the apex they are another origin to the app, and the apex's Origin check refuses a form posted from the
app's pages.

## 2. Roles

### 2.1 Organization roles

Every member of an organization has exactly one organization role, or access to specific apps instead (never both).

| Role | People and roles | In every app |
|---|---|---|
| Owner (the creator, at first) | Invites, changes and removes anyone, owners included; creates, edits and deletes custom roles; sets up SSO and SCIM | Admin |
| Admin | Invites, changes and removes admins, editors, viewers and people with app access; gives custom roles; can't touch owners or edit custom roles | Admin |
| Editor | Sees the organization's people and roles, changes nothing | Editor |
| Viewer | Sees the organization's people and roles, changes nothing | Viewer |
| Specific apps | Sees only the apps they were given; can't see the organization's people list | Their role in each app, or none |

An organization always keeps at least one owner. The Insulin console's old `USER` role is gone: migration
`0003` turned every `USER` membership and invitation into `VIEWER` (Cap Table shows both the holder view, so nobody
sees more or less).

### 2.2 App roles

Each app interprets three built-in roles: **Admin** (everything, including the app's people and integrations),
**Editor** (full functions except people, roles, permissions and integrations), and **Viewer** (read only; what "read"
means is the app's call: Cap Table shows a Viewer their own holdings).

Someone with *specific apps* access has, per app, Admin, Editor, Viewer or a custom role. Granting a person an
organization role removes their app grants in the same statement (a trigger enforces it too); granting app access
requires the membership to be *specific apps* (a trigger refuses it otherwise).

An **app admin** is an organization owner or admin, or someone whose grant for that app is Admin. A custom role never
makes someone an app admin: people and integrations are the platform's, not an app permission. An app's OAuth clients
for API access (§5.3) are managed by the organization's owners and admins only, not by app admins by grant: a
client's secret outlives the person who made it.

### 2.3 Custom roles

An app may declare a permission catalog in its `package.json`:

```json
"insulin": {
  "permissions": [
    { "key": "captable.view", "label": "View the cap table", "description": "…", "role": "EDITOR" }
  ]
}
```

`role` is the least built-in role that has the permission (Viewer < Editor < Admin, and Admin has every permission).
The deploy reads the catalog into `SITE_APPS`. Only the organization's owners create, edit and delete custom roles,
each for one app, choosing permissions from that app's catalog; owners and admins (and app admins, for their app) give
them to people. A custom role can't be deleted while anyone, an invitation or a service account still uses it.

Apps without a catalog have no custom roles.

### 2.4 What the app receives

The gateway forwards each request with the identity contract of `@fours/app` plus three headers. Every incoming
`x-suger-*` header is removed first.

| Header | Value |
|---|---|
| `x-suger-user-id`, `x-suger-user-email`, `x-suger-user-name` | The person (or service account, §5.3) |
| `x-suger-organization-id` | The organization the request acts in |
| `x-suger-app-id` | `insulin-apps-<app>` |
| `x-suger-app-role` | `ADMIN`, `EDITOR` or `VIEWER`. For a custom role: the least built-in role that covers its permissions |
| `x-suger-app-permissions` | Apps with a catalog only: the permissions, space-separated. For built-in roles, every permission at or below the role; for a custom role, its own |
| `x-suger-access-via` | `browser`, `mcp` or `api`; `public` on an app's public paths (§8.1), where it and `x-suger-app-id` are the only headers |

Apps treat `x-suger-app-permissions` as a **narrowing** of the role, never a widening: effective permissions are the
role's permissions intersected with the header. Behind the gateway the header is always set; elsewhere (the Insulin
console) it may be missing, and then the role alone decides. A forged header can only take access away.

Apps refuse mutations of their own people, roles, billing or integrations unless `x-suger-access-via` is `browser`
(§4). The gateway's own pages already never accept a token.

## 3. Organization and app people pages

- `insulinapps.com/settings/users` shows the active organization (or `?org=<id>`): every member with their access,
  pending invitations, and for owners and admins the forms to invite (organization role or specific apps with a role per
  app), change access, resend or revoke invitations, and remove people. Everyone with an organization role can open it;
  people with specific-apps access are told where to go instead.
- `insulinapps.com/settings/roles` lists the built-in roles and each app's custom roles with their permissions; owners
  add, edit and delete custom roles there.
- `insulinapps.com/apps/<app>/settings/users` (where `<app>.insulinapps.com/settings/users` leads) lists everyone who
  can use the app in the active organization: people whose
  access comes from their organization role (marked *from organization role*, not editable here) and people with access
  to this app. App admins invite people to this app (Admin, Editor, Viewer or one of the app's custom roles), change
  their role in this app and remove them from it. Removing someone's last app removes them from the organization.
  Inviting someone who already has specific-apps access adds the app at once; inviting a member with an organization
  role is refused (they already have access).
- `insulinapps.com/apps/<app>/settings/integrations` (where `<app>.insulinapps.com/settings/integrations` leads): §6.
- `insulinapps.com/settings/organization` has the name, leaving and deleting and, for owners, **who can be invited**.
  Once the organization has a verified domain (§7), an owner can invite only people with an address in its verified
  domains; it is off by default. While it is on, every new invitation, from the people page or an app's, must be for an
  address in one of the domains verified now (compared in lower case and punycode), and resending and accepting check
  again, so an invitation sent before it was turned on, or before its domain was removed, is neither sent again (it is
  refused like a new one) nor brings anyone new in. The checks are part of the insert, the resend's claim and the
  acceptance statement, so none races the setting or a domain's removal. People who are
  members already keep their access, and an app admin can still give an existing specific-apps member another app.
  With no verified domain left, nobody can be invited until an owner verifies one or turns the setting off. SCIM keeps
  its own rule (§7).
- `insulinapps.com/apps/<app>/settings/api` (API access; `<app>.insulinapps.com/settings/api` leads there): the app's
  OAuth clients, §5.3.
- `insulinapps.com/apps/<app>/settings/connect-ai` (Connect AI; `<app>.insulinapps.com/settings/connect-ai` leads
  there): the app's MCP server and AI agents, §5.2.

Every change re-checks the actor's role inside the same SQL statement as the change, so a member who was demoted or
removed meanwhile changes nothing (the gateway's existing rule, extended to app grants and custom roles).

### 3.1 Organization limits

- **Owner domain.** Each organization records the registrable domain of its creator's address (the public suffix and
  one label more, from the ICANN section of the Public Suffix List), lower case and in punycode: an address at
  `one.example.com` counts as `example.com`, one at `two.example.co.uk` as `example.co.uk`. The list's private section
  is left out, so free subdomains under a hosting or dynamic-DNS platform count with that platform. An IP address, or a
  name that is itself a public suffix, counts as itself. For an address at a public mail provider it is the address
  itself, lower case and without a +tag, so each person there counts on their own and the provider as a whole isn't
  limited.
  Gmail ignores dots and also answers at googlemail.com, so a Gmail owner domain drops the dots and is at gmail.com;
  other providers keep the dots, as not all of them ignore dots.
- **Public mail providers.** The providers no organization may claim in §7 either: the gateway's own list (gmail.com,
  outlook.com and the like) together with the `email-providers` package's list of some 8,700 free and regional
  providers (hotmail.co.uk, web.de, naver.com, comcast.net …), pinned to an exact version, and any subdomain of one.
  The reserved example domains (example.com, .org, .net) are never a provider. The rules live in
  `gateway/src/owner-domain.ts`, which the gateway and `allow-orgs.mjs` both use.
- **Two per owner domain.** An owner domain may have at most two organizations at a time. The count is part of the
  insert, so concurrent creations can't go past it; deleting an organization frees its place. The count includes the
  organizations recorded under its subdomains, which migrations `0007` and `0009` and the gateway before `0009` wrote
  with the creator's whole domain. Migration `0007` gave existing organizations their creator's owner domain; `0009`
  gave each one still without an owner domain its creator's or, when that account was gone, its earliest current
  owner's, and rewrote Gmail owner domains (and allowances) to the form above. SQL can only approximate that form (it
  can't apply the provider list or the Public Suffix List), so the gateway's daily cron reconciles it with the same code
  the limit counts by: every organization's owner domain from its creator or earliest current owner, and every
  allowance's key, where two allowances meeting under one key keep the larger number. An organization with neither a
  creator nor an owner counts for nobody. The old per-account count (`users.orgs_created`) is kept as a record and
  limits nothing.
- **Allowances.** Operators let a domain (or an address at a provider) have more, or fewer down to none, in
  `org_domain_allowances`, with `.github/hosting/scripts/allow-orgs.mjs` ([runbook](README.md)). It takes the owner
  domain only in the form the gateway counts: a registrable domain that isn't a provider, or an address at a provider.
- **Asking for more.** At the limit, `/orgs/new` shows "Request more organizations" instead of the create form: the
  name wanted and why. It e-mails Insulin Apps support at `ORG_REQUEST_EMAIL` with the requester's name and address,
  their owner domain and how many organizations it has, from `EMAIL_FROM` with Reply-To set to the requester, and the
  `allow-orgs.mjs` command to run: with the owner domain quoted for the shell when it passes the script's own strict
  check, or a `DOMAIN` placeholder to fill in after checking it by hand when it doesn't (an address someone chose can
  hold quotes or `$(…)`). Each day support takes at most three requests per person, three per owner domain (from
  everyone there together) and fifty from everyone, counted in `mail_log` in the statement that records the request;
  `RL_AUTH` applies too. Without `ORG_REQUEST_EMAIL` the page shows the limit and the contact (`SUPPORT_EMAIL`, or the
  repository's issues). Support replies by e-mail; once an allowance is set, the person creates the organization
  themselves.

### 3.2 Navigation: two levels, each collapsible

Every app, and the gateway's signed-in pages, share one navigation, so moving between an app, its settings and the
organization's pages feels like one product (the model is a two-column sidebar: a primary column, and a column for the
section open in it).

- **Level 1, the primary column** (left, 240px; 56px collapsed):
  - at the top, the organization switcher: the mark, the organization's name and a chevron, listing the person's
    organizations and the link to create one. In an app it reads `/__insulin/me` and switches through
    `/__insulin/switch-org`, as the account bar does; on the gateway the page renders it;
  - the app's sections, from its navigation manifest (below), each an icon and a label, under optional group headings;
  - then the platform's items, in every app: **Docs** (the app's in-app Docs) and **Settings**, whose level 2 is
    People, Integrations, API access and Connect AI. Those four stay the gateway's pages on the apex
    (`insulinapps.com/apps/<app>/settings/...`, §3), so an app's code can never read or submit them; the app links to
    them (`/__insulin/me` gives their addresses as `settings: { users, integrations, api, connectAi }`, null where the
    person can't use the app, and the apex's origin as `apex`), and they render with that app's own level 1, so they
    read as part of the app;
  - at the bottom, the person: their initials and name, with Account and Sign out.
- **Level 2, the section column** (224px; 56px collapsed): shown when the open level-1 item has sub-items, which it
  lists under optional group headings, with a header naming the section. The page's own header carries the breadcrumb
  (section › item).
- **Collapsing.** Each level has its own toggle and collapses to its icons; a collapsed item shows its label as a
  tooltip (`title` and `aria-label`), and the organization switcher shows the organization's initial. The choice is
  remembered per browser: apps keep it in `localStorage` (`insulin-nav`: `{"l1":"collapsed"|"expanded","l2":…}`); the
  gateway, which sends no script of its own, keeps it in the `insulin_nav` cookie, set by the toggle's link
  (`/__insulin/nav?l1=collapsed&return=<path>`, same host only, then a 303 back).
- **Narrow screens** (below 768px): a top bar with the organization switcher and a menu button; the menu opens both
  levels stacked in a drawer (a `<details>` element on the gateway).
- **Accessibility.** `<nav aria-label="Primary">` and `<nav aria-label="Section">`, `aria-current="page"` on the
  active item, toggles with `aria-expanded` and `aria-controls`, and a visible focus ring; everything works from the
  keyboard.
- **Look.** The gateway and shadcn apps use shadcn's sidebar colours and spacing; an app with its own design keeps it
  but has the same structure and behaviour.
- **The account bar** (`/__insulin/bar.js`) floats on app pages that have no navigation of their own. An app that
  renders this navigation marks its root with `data-insulin-shell`, and the bar stays out of the way (it also leaves
  when a single-page app renders the mark after the bar's script ran).

**On the gateway** (`gateway/src/navigation.ts`, `components/shell.tsx`). The navigation surrounds the home page, the
account pages, creating an organization, the organization's settings and each app's settings pages; the signed-out
pages (landing, sign-in, the docs), invitations, the consent page and the message pages keep the top bar.

- **The organization's pages**: level 1 is Home; **Apps**, the deployed apps the person can use in that organization,
  each opening on its own host; **Settings**: People and Organization for everyone, Roles for an organization role,
  OAuth clients for owners and admins, Single sign-on for owners; and the platform's Docs at the bottom. No level 2; the breadcrumb is Settings › the page.
- **The account pages**: the organization's level 1, and **Account** in level 2: Profile, Security, AI agents.
- **An app's settings pages**: the app's level 1 with the items the person's role in that app reaches (a custom role
  counts as the built-in role it is sent as, §2.4), consecutive items of one `group` under one heading, and no
  children (they are the app's own level 2); then Docs (`https://<app>.insulinapps.com/docs`) and Settings. The
  breadcrumb starts with the app: Cap Table › Settings › People.
- The open level-1 item whose level 2 holds the page has `aria-current="true"`; the page's own item `"page"`.
- The organization switcher also links **All apps** (the home page). Switching from a page opened with `?org=` comes
  back without it, so the page shows the organization just chosen.
- **The cookie** is `insulin_nav=<l1>.<l2>`, each `expanded` or `collapsed` (anything else reads as both expanded):
  host-only on the apex, `HttpOnly`, `SameSite=Lax`, `Secure` (but on local http), for 400 days, and one of the
  gateway's cookies, so it is never forwarded to an app nor set by one. `GET /__insulin/nav` answers on the apex only.
  It takes `l1`, `l2` (at least one; a level left out keeps its state) and `return`, a path on the same host (`/` when
  left out); an unknown, repeated or invalid parameter, or a `return` that is an absolute URL, another host, `//…` or
  holds a backslash, is a 400 that remembers nothing.
- **The public docs** (`/docs/`, `gateway/scripts/docs/layout.mjs`) keep the top bar and have the same two levels
  below it, drawn at build time: level 1 is Overview, Platform, each app and the files for AI agents; level 2 is the
  open section's pages, so each app's docs are a place of their own at `/docs/<app>/`. There is no organization
  switcher or person (the docs are public) and no collapsing (the pages are static); below 1024px a `<details>` menu
  above the article holds both levels.

**The navigation manifest.** An app declares its level 1 in `package.json`, under `insulin.navigation`, which the app
and the gateway both render from:

```json
"navigation": [
  { "key": "envelopes", "label": "Envelopes", "icon": "inbox", "path": "/envelopes",
    "children": [{ "key": "drafts", "label": "Drafts", "icon": "file-pen", "path": "/envelopes?status=draft" }] },
  { "key": "templates", "label": "Templates", "icon": "files", "path": "/templates", "role": "EDITOR" }
]
```

`key` matches `[a-z0-9-]+` and is unique; `label` is 1 to 40 characters; `icon` is one of the Lucide icons the gateway
bundles (`list-apps.mjs` lists them); `path` starts with `/` on the app's host and isn't one of the gateway's paths
(`/__insulin/*`, `/settings/*`, `/mcp`, `/.well-known/*`); `group` (optional) is a heading shown above the item, which
consecutive items with the same group share (an item without one has none); `role` (optional) is the least app role
that sees it (VIEWER by default), and `maxRole` (optional) the most (ADMIN by default; an item for viewers only, such
as a holder's own pages, says VIEWER); `children` holds level 2, the same fields without `children`. At most 12 items,
and 12 children each. `list-apps.mjs` refuses a malformed manifest, and the deploy passes its level 1 to the gateway
in `SITE_APPS`, without children: the gateway never draws an app's level 2, and a Worker variable holds at most 5 KB
(`deploy-apps.test.mjs` keeps every gateway variable for this repository's apps under it). Docs and Settings are added
by the platform and aren't in the manifest.
In detail: a key has at most 40 characters and is unique across items and children; a `group` is 1 to 40 characters;
any other field is refused; a `path` may carry a query but no fragment, before its query holds no `%`, empty or dot
segment, and stays off `/api/__suger/*` too; `home` and `check-circle`, Lucide's older names for `house` and
`circle-check`, are accepted as well. `check-insulin-app.mjs` checks it as the deploy does; the gateway checks it again
(a malformed one fails it closed, like the other fields), and a `SITE_APPS` from before the manifest loads with none.

## 4. What tokens may reach

Browser sessions reach everything their role allows. Bearer tokens (MCP and OAuth clients) reach only the app's own
API: `/api/*` on the app host, minus the platform's `/api/__suger/*`. They never reach the gateway's pages, so these
stay browser-only and owner/admin-only by construction:

- users, roles, custom roles and invitations (organization and app);
- integrations and API access: stored credentials and OAuth clients (service accounts);
- SSO, SCIM tokens, organization rename and delete;
- billing, when there is any.

Apps keep the same rule for anything of that kind they implement themselves, using `x-suger-access-via`.

## 5. Sign-in and tokens

### 5.1 People

- **E-mail and password**, with the existing confirmation, reset, Turnstile, rate limits and credential versions.
- **Google** (the platform's OAuth client), callback `https://insulinapps.com/auth/google/callback`.
- **MFA with an authenticator app (TOTP).** Turned on under Account → Security with a QR code and a code from the app;
  ten single-use recovery codes are shown once. Turning it on needs the current password (or, for an account without
  one, a sign-in in the last ten minutes), so a stolen session can't put the thief's authenticator on the account. While
  it is on, every sign-in, password, Google, a reset link or enterprise SSO alike, asks for a code (or a recovery code)
  before a session exists. Codes are RFC 6238, SHA-1, 6 digits, 30 seconds, ±1 step, and a used step is never accepted
  twice. Ten wrong app codes in a row, across sign-ins, pause app codes for an hour (recovery codes still work) and
  e-mail the person once. The secret is stored encrypted (AES-256-GCM with `GATEWAY_SECRET_KEY`).
- **Enterprise SSO** (§7): SAML 2.0 or OpenID Connect for an organization's verified e-mail domains. It asks for the
  code too: the organization that verified a domain controls its mailboxes and so could already reset a password, and
  with MFA applied to its identity provider as well, single sign-on is no weaker a way in than a reset.

### 5.2 MCP clients (Claude, Codex, Gemini, opencode, …)

Each app is its own OAuth protected resource, `https://<app>.insulinapps.com/mcp`, and the apex is the one
authorization server for all of them, so a client registers and is authorized separately for each app.

```
client ──► https://captable.insulinapps.com/mcp           401 + resource_metadata
   ├─► /.well-known/oauth-protected-resource/mcp            (app host) authorization_servers: [https://insulinapps.com]
   ├─► https://insulinapps.com/.well-known/oauth-authorization-server
   ├─► POST /oauth/register                                 dynamic registration (public client, PKCE)
   ├─► GET  /oauth/authorize?resource=https://captable…/mcp sign in, choose the organization, Allow
   ├─► POST /oauth/token                                    code + verifier → access (1 h) + refresh (rotating)
   └─► POST https://captable.insulinapps.com/mcp            Bearer token, JSON-RPC (stateless Streamable HTTP)
```

- **Registration** accepts only public clients whose redirect URIs are loopback (`http://localhost`, `127.0.0.1` or
  `[::1]`, any port and path) or a known hosted connector callback; it is rate limited per IP. Clients that never got a
  grant are deleted after a day.
- **Authorization** needs a signed-in session (after MFA) and shows the client's self-given name, the app, the
  organization (chosen from those where the person can use the app) and where the browser returns, warning that any
  program on the computer can listen on a loopback address. **Allow** records a grant for (person, organization, app,
  client) that lasts 30 days; the client is sent back with a code (60 seconds, single use, bound to the PKCE challenge
  and redirect URI).
- **Tokens** are 32 random bytes; only their SHA-256 is stored. Access tokens last an hour. Refresh tokens rotate on
  every use; presenting a used one revokes the whole grant.
- **Each MCP request re-checks** the grant and the person's current access to the app in that organization, so a
  removed or demoted person's agent loses access or power at once. The agent acts with the person's role
  (`x-suger-access-via: mcp`), and the app sees `User-Agent: Insulin Apps MCP: <client name>`, which its audit trail can
  record. Leaving or being removed from an organization deletes the person's grants there, so a later invitation
  doesn't bring old agents back, and a credential change (a password set, changed or reset, two-step sign-in turned
  on or off) deletes all their live ones, so an agent connected by someone who took over the account doesn't outlive
  its recovery (a revoked one, which holds no token, stays on the organization's list, §5.4).
- **Limits.** The token endpoint is limited per IP before anything is checked, and per client only on failed
  attempts, so junk requests naming a public client id can't lock that client out. A JSON-RPC batch holds at most 10
  messages, and every tool call in one counts against the person's app rate.
- **Resources.** Authorization and tokens accept `https://<app>/mcp` and, for clients that read the root
  protected-resource metadata, `https://<app>`. A person's token is refused on `/api/*`, and a service account's on
  `/mcp`.
- **Tools:** `whoami` (person, organization, app, role, permissions), `endpoints` (the app's `GET /api/catalog`, if it
  has one), `read` (GET) and `change` (POST, PUT, PATCH, DELETE) on `/api/*` paths, forwarded to the app as that person,
  with an optional `Idempotency-Key`. Responses larger than 200 KB are cut.
- People see and disconnect their own agents under Account → AI agents, for every app and organization, and on each
  app's Connect AI page.

**Connect AI.** Every app has a Connect AI page, `insulinapps.com/apps/<app>/settings/connect-ai` (in the level 2 of
the app's Settings, §3.2, and a link in the account bar on an app host without the navigation;
`<app>.insulinapps.com/settings/connect-ai` leads there), which everyone who can use the app opens: Viewers and
specific-apps members included.

- **The server.** The app's MCP server URL, and in plain words what connecting does: the agent signs in at the apex,
  the person chooses the organization and allows it, and it then acts as them, with their current role in this app
  (named on the page, from their access), for 30 days.
- **Setup for each client**, as selectable blocks (the page runs no script, so there is no copy button), checked against
  each tool's documentation and `--help`: Claude Code (`claude mcp add --transport http <app> <url>`, then `/mcp`),
  Codex CLI (`codex mcp add <app> --url <url>`, then `codex mcp login <app>`), Gemini CLI (`gemini mcp add --transport
  http <app> <url>`, then `/mcp auth <app>`), opencode (`opencode mcp add <app> --url <url>`, then `opencode mcp auth
  <app>`), and Claude.ai's and ChatGPT's custom connectors, which take the URL.
- **Your agents.** The person's own live grants for this app in the active organization (client name, connected, last
  used, expires), each with Disconnect, which ends the grant and its tokens at once and returns to the page.
- **Everyone's agents**, for the organization's owners and admins only: every live grant for this app in the
  organization, with who connected it, and Disconnect. The list and the disconnect each re-check OWNER or ADMIN inside
  their statement, so a demoted admin sees and ends nothing. An app admin by grant sees only their own.

### 5.3 OAuth clients (API access)

An app's OAuth clients (OAuth 2.0 client credentials; stored as `service_accounts`) are on its API access page,
`insulinapps.com/apps/<app>/settings/api` (`<app>.insulinapps.com/settings/api` leads there). Each has a name and a
role in that app (Admin, Editor, Viewer or a custom role).

- **Who manages them.** Only the organization's owners and admins create, rename, change the role of, rotate and
  delete them; every write re-checks OWNER or ADMIN in its own statement. An app admin by grant can't: a client's
  secret outlives the person who made it, so it is the organization's to manage.
- **Who sees them.** Everyone who can use the app sees the list: name, role, client id, created, last used and when the
  secret was rotated. A secret is shown once, right after it is made, and never again.
- **Getting a token.** A program posts `grant_type=client_credentials` to `https://insulinapps.com/oauth/token` with
  its client id and secret as HTTP Basic (or `client_id` and `client_secret` in the body), optionally with
  `resource=https://<app host>`, and calls `https://<app host>/api/...` with the access token, which lasts an hour.
  The page shows a curl example with placeholder credentials. The app receives the client's id, the name, and the
  address `<id>@service-accounts.invalid` (a reserved domain nobody can own), with `x-suger-access-via: api` and
  `User-Agent: Insulin Apps API: <name>`.
- **Rotating without downtime.** Rotate secret makes a new secret, shown once, and keeps the previous one valid for 24
  hours, so a running program can switch over; the token endpoint accepts either until then. Tokens already issued
  keep working until they expire. Rotating again while a previous secret is still valid replaces it, so at most two
  secrets are ever valid. Revoke previous secret now ends the previous secret at once.
- **Which tokens end.** Each access token records the hash of the secret that issued it, and the token insert checks
  that secret again, so a secret rotated or revoked between the check and the insert issues nothing. When a secret ends
  early (Revoke previous secret now, or pushed out by a second rotation), its tokens are deleted in the same batch;
  the current secret's tokens are untouched. A previous secret that simply reaches its 24 hours issues no more tokens,
  and those it issued run out within the hour. Delete ends the client, its secrets and all its tokens at once. Tokens
  issued before migration `0008` recorded no secret and count as the previous secret's.
- **Revoked.** A client revoked on `/settings/oauth-clients` (§5.4) stays on the page, marked Revoked with the day, and
  can't be renamed, given another role or rotated; Delete still removes it.

### 5.4 OAuth clients across the organization

`insulinapps.com/settings/oauth-clients` (Settings › OAuth clients, §3.2) lists every OAuth client of the organization in
one table, for its owners and admins only: each app's clients for API access (§5.3) and every member's AI agents
(§5.2, a grant each), of every app.

- **Who opens it.** The organization's owners and admins; the item isn't in anyone else's navigation, an editor, viewer
  or specific-apps member (an app admin by grant included) gets 403, and someone outside the organization 404. The
  list and every write re-check OWNER or ADMIN in their own statement, so an admin demoted meanwhile reads and changes
  nothing.
- **What it shows.** For each client: its name (and client id for API access), the app (and role for API access), the
  type (API access, or AI agent (MCP)), who created it (the owner or admin who made an API client; the person who
  connected an agent, as whom it acts), when, when it was last used, and its status: Active (an agent's with the day its
  grant expires) or Revoked, with the day and who revoked it. A creator whose account is gone reads "A deleted
  account". Expired agents aren't listed.
- **No secret, no rotation.** The page never shows a secret, a secret's hash or a way to rotate one. A secret is shown
  once, on the app's API access page, when it is made or rotated (§5.3); the page links there for each app.
- **Revoke** ends a client's access at once and keeps it listed. For an API client, one batch records `revoked_at` and
  `revoked_by`, drops its previous secret and deletes its tokens; the token endpoint then refuses it
  (`invalid_client`), whichever secret it presents, and its API access page shows it Revoked without rename, role or
  rotation (the writes refuse it too). For an agent, one batch records the same on its grant and deletes the grant's
  tokens and codes; its access token gets 401, its refresh token `invalid_grant`, and the person's own lists (Account ›
  AI agents, Connect AI) no longer show it. The person can allow the agent again, which makes a new grant. Every token
  check refuses a revoked client or grant, not only the deleted tokens, so nothing issued in the meantime works.
  Revoking something already revoked or gone changes nothing and answers 409, as does an id from another organization,
  so ids reveal nothing.
- **Delete** removes the client or the grant and, with it, its tokens. A revoked agent is deleted anyway when its grant
  would have expired (the daily cleanup), or when its person leaves the organization. Only the organization's owners
  and admins delete it before then: the person's own Disconnect (Account › AI agents, Connect AI) reaches only live
  agents, and a credential change leaves it.

## 6. Integrations

An app's integrations page, `insulinapps.com/apps/<app>/settings/integrations` (`<app>.insulinapps.com/settings/
integrations` leads there), holds its stored credentials. Only the app's admins (§2.2) create, edit and delete them;
everyone else who can use the app sees names, kinds, hosts and status, never a secret, and tokens never reach it (§4).
The app's API clients are no longer here: they are OAuth clients on the API access page (§5.3), managed by the
organization's owners and admins, and the integrations page links there.

- **Stored credentials** for outside services the app calls through `integrationFetch(key)` of `@fours/app`: a key, a
  name, the base URL, the allowed hosts, and how to send the secret (a bearer token, a named header, or basic auth). The
  secret is encrypted with `GATEWAY_SECRET_KEY` and never shown again. The gateway's proxy,
  `https://insulinapps.com/__insulin/integrations/<key>/proxy/<host>/<path>`, accepts the app's token
  (`SUGER_APP_TOKEN`, an HMAC of the app's name with `GATEWAY_SECRET_KEY`, which the deploy gives each app Worker)
  and the organization in `x-suger-organization-id`, which the app sets from `getCurrentUser()` on the request it is
  serving. It sends the request on only to an allowed `https` host, with the credential added and every `x-suger-*`,
  cookie and authorization header removed, and never follows redirects. Hosts are names, never IP addresses or
  single-label names. Changing a credential's base URL, allowed hosts or the way its secret is sent needs the secret
  entered again in the same save, so an admin can never send a stored secret somewhere new to read it.
- **Known limitation.** `SUGER_APP_TOKEN` is per app, not per organization: the app chooses the organization in each
  proxy call. An app bug, or a leaked token, could therefore use another organization's stored credentials for that
  app through the proxy, though never read them.

## 7. Enterprise SSO and SCIM

An organization's owners set this up under `insulinapps.com/settings/sso`.

- **Domains.** An owner claims an e-mail domain and proves it with a DNS TXT record (`_insulin-apps.<domain>`, value
  `insulin-apps-verification=<token>`), checked over DNS-over-HTTPS. One organization at a time can hold a verified
  domain. A public mail provider (§3.1's list, or a subdomain of one) can't be claimed. Verified domains are also what
  an owner can limit invitations to (§3).
- **Connection.** One per organization, SAML 2.0 or OpenID Connect, with a default role for people it adds (Editor or
  Viewer) and an option to require SSO for the verified domains (password and Google sign-in are then refused for
  those addresses).
  - SAML: SP-initiated, HTTP-Redirect AuthnRequest, HTTP-POST response to
    `/sso/saml/<connection>/acs`; the response or assertion must be signed with the identity provider's certificate
    (RSA-SHA256), the signature must cover the element that is read (against signature wrapping), there must be exactly
    one assertion, and `InResponseTo`, `Destination`, audience, recipient, issuer and validity window are checked. The
    request is single use and bound to a host-only `__Host-insulin_sso` cookie, `SameSite=None` because the identity
    provider posts it from another site; the ACS is the one form exempt from the Origin check. SP metadata at
    `/sso/saml/<connection>/metadata`. Signatures are checked with `xml-crypto` and `@xmldom/xmldom`, which need
    `nodejs_compat`.
  - SAML responses over 256 KB, or nested deeper than 64 elements, are refused before any walk of the document.
  - OIDC: authorization code with PKCE and a nonce, client secret encrypted at rest; the ID token comes straight from the
    token endpoint over TLS, and its issuer, audience, expiry, nonce and `email_verified` are checked. A stored client
    secret belongs to the issuer and client id it was given for: changing either drops it, and the owner enters it
    again, so a changed issuer never receives the old secret.
- **Sign-in.** "Sign in with SSO" asks for the work e-mail, finds the verified domain and starts the connection. The
  address must be in one of the organization's verified domains. An unknown address gets an account (confirmed, no
  password); someone who isn't a member joins with the default role, and the organization becomes the active one. An
  existing account with its own password or Google link is told by e-mail the first time it signs in this way. With
  "require SSO", password sign-in, sign-up, password resets, confirmation links and Google are refused for those
  addresses before any credential is looked at, and again where every sign-in finishes, against the account's stored
  address, so a Google account matched by its subject can't get around it. Domains are compared in punycode.
- **SCIM 2.0** at `https://insulinapps.com/scim/v2` with a bearer token the owner creates (shown once): `Users`
  (list with `userName eq`, create, read, replace, patch, delete), `ServiceProviderConfig`, `ResourceTypes`, `Schemas`.
  Only addresses in a currently verified domain, for every read and write; joining checks that in the same statement.
  Creating adds the person with the default role; `active: false` or delete removes them from the organization (never
  its last owner), which also ends their AI agents' grants there; their sessions stay, since they may belong to other
  organizations, but they can no longer act in this one. `scim_users` remembers whom the identity provider provisioned
  (with its external id), so a deactivated person stays visible to it. Removing a domain removes the non-owner members
  SCIM provisioned on it, and their SCIM links, in the same batch. Roles stay managed on `/settings/users`. SCIM calls
  are rate limited per token.

## 8. What apps can use beyond D1

An app gets one D1 database and static assets, nothing else: no R2, KV, queues, cron triggers or e-mail binding
(`check-insulin-app.mjs` refuses a build that declares one). The only other binding is the deploy's own `SUGER_GATEWAY`,
the way to the gateway's relay and proxy (§8.2). What an app needs beyond that, the gateway provides,
declared in the app's `package.json` under `insulin`:

```json
"insulin": {
  "permissions": [ … ],
  "publicPaths": ["/sign", "/api/public/", "/assets/"],
  "scheduled": "/api/scheduled",
  "secrets": ["ESIGN_OTP_KEY", "ESIGN_FRAME_ANCESTORS"]
}
```

The deploy reads these with `list-apps.mjs` and refuses a malformed list; the gateway checks `publicPaths` and
`scheduled` again and fails closed.

### 8.1 Public paths

Some apps serve people who have no account and never will, such as an Esign recipient who signs on a page that a
host product frames. Such paths are listed in `insulin.publicPaths`, at most ten. A request path matches an entry if
it equals the entry, starts with it when the entry ends in `/`, or starts with `entry/` when it doesn't. A path whose
segments hide a dot segment or a slash in their encoding never matches. An entry may not be `/`, `/api` or `/api/`,
and may not be or cover anything under `/__insulin`, `/settings`, `/mcp`, `/.well-known` or `/api/__suger`, in any
case.

On a public path the gateway looks at no session and no token, and the app gets `x-suger-app-id` and
`x-suger-access-via: public` only: no person, organization, role or permissions, even when a signed-in person or a
token sent the request. Incoming `x-suger-*` headers, the gateway's cookies and `Authorization` are removed as always.
HTML gets no account bar, the app's own headers (its CSP and `frame-ancestors`) are kept, and requests are limited per
IP address (`RL_APP`). A request that isn't GET or HEAD (an Esign code exchange, a code sent or checked) also counts
against a stricter limit per app and IP address, `RL_PUBLIC` (60 a minute suggested), and gets 429
`{ "error": "rate_limited" }` with `Retry-After: 60` past it, while reading goes on. That is defence in depth: the app
still limits what its codes allow. The gateway's own paths always win over a public path.

The app authenticates these requests itself, with its own short-lived codes (an e-mailed one-time code, a code in the
link a member generated), and they reach only what those codes are for. A public path is never a way around sign-in
for the app's members.

### 8.2 Mail relay

Apps have no e-mail binding. An app Worker that must write to someone (a one-time code, a link to a signed copy)
sends one message per request to `POST https://insulinapps.com/__insulin/mail`, with its `SUGER_APP_TOKEN` as a bearer
token and the organization it serves in `x-suger-organization-id`:

```json
{ "to": "one address", "subject": "≤ 200 characters", "text": "≤ 20,000 characters", "html": "optional, ≤ 100,000", "replyTo": "optional address" }
```

- **Sender.** It goes from the gateway's `EMAIL_FROM` address, named "`<App title>` via Insulin Apps", with the app's
  `replyTo` if it gave one.
- **Limits.** Apps' mail has its own per-recipient allowance (ten an hour, all apps together), counted apart from the
  gateway's own sign-in and security mail so an app can never crowd those out; 500 messages a day for each organization
  and app, 5,000 a day for each app across organizations, and `RL_AUTH`
  per app and organization.
- **Responses.** 202 `{ "status": "sent" }`. Otherwise an error: 400 `invalid_request`, 401 `unauthorized`, 404
  `unknown_organization`, 429 `rate_limited`, 502 `send_failed`, or 503 `not_configured` without
  `GATEWAY_SECRET_KEY`.
- **Privacy.** Logs carry the app, the organization and the kind, never an address or the text.
- **Configuration.** The deploy gives each app `SUGER_MAIL_URL` next to `SUGER_INTEGRATIONS_URL` and
  `SUGER_APP_TOKEN`, when `GATEWAY_SECRET_KEY` is set, and with them a service binding to the gateway Worker,
  `SUGER_GATEWAY`. The app sends the request for those URLs over the binding: Cloudflare doesn't let a Worker fetch
  another Worker of the same zone through its public URL, so a plain `fetch` from `<app>.<domain>` never reaches the
  gateway. The gateway routes a request that comes over the binding by its URL, as it does any other. The binding is
  the deploy's, like `DB`; an app's own build still declares none.

As with the integration proxy (§6), the token is per app, so the app chooses the organization.

### 8.3 App secrets

An app lists the secrets it needs at runtime in `insulin.secrets`: at most 30 names, each starting with the app's name
in upper case (`ESIGN_…` for `esign`). The app deploy takes each from the GitHub `production` environment, a secret of
that exact name or else a variable, and uploads it with the Worker's `--secrets-file`; names that aren't set are skipped
and logged by name. The workflow hands the deploy step the environment's secrets and variables as JSON
(`toJSON(secrets)`, `toJSON(vars)`), and the script picks only the declared names: never another app's (a name inside a
longer app's prefix, `ESIGN_PRO_…` next to an app `esign-pro`, is refused), never the platform's (apps can't be named
`cloudflare`, `google`, `turnstile`, `github`, `site`, `suger` and the like, and the platform's setting names are refused
outright), never logged, and never visible to the build, which runs in a job without them. The app reads them with
`readAppEnv(name)`. The gateway never learns an app's secret names.

### 8.4 Integrations

Credentials for outside services are stored by the platform and used through the integration proxy (§6), not kept in
the app.

### 8.5 Scheduled work

Apps have no cron trigger. An app with work that falls due (deadlines that pass, work a request was cut short of,
mail to retry) declares one path in `insulin.scheduled`, and the gateway calls it every five minutes.

- **The path.** One path that starts with `/api/`, without a trailing slash, passing the rules of a public path
  (§8.1: never `/api/__suger/…`, no dot segment, query or percent sign). It must not be one of the app's public paths
  or under one, compared without regard to case. `list-apps.mjs`, `check-insulin-app.mjs` and the gateway's configuration check it; the
  gateway refuses to start with a bad one.
- **The tick.** The gateway's `scheduled` handler runs on the cron `*/5 * * * *`. For every app that declares a path
  and has a service binding it POSTs to `https://<app>.<domain><path>` over the binding, all apps at once (each in
  `waitUntil`, so one failing or slow app never holds up another), with an empty body and a 25-second timeout. The
  request carries `x-suger-app-id` and `x-suger-access-via: schedule` only: no person, organization, role or
  permissions. The log line names the app and the status (the HTTP status, `timeout` or `unreachable`), nothing else.
- **Nobody else can send it.** The gateway removes every incoming `x-suger-*` header (a browser's, a token's, a public
  request's), and app Workers have no public route, so a request marked `schedule` can only be the gateway's own
  tick. The app still checks: it refuses the path unless `x-suger-access-via` is exactly `schedule` and no identity
  is present, and treats a request marked `schedule` as nobody everywhere else.
- **What the app does.** Its due work for every organization, since the tick belongs to none. It must be safe to
  repeat and to overlap with requests (the next tick picks up what one leaves), and should finish well within the
  timeout, doing a bounded amount per tick. An app can keep a route of its own (Esign's `POST /api/process-due`) for
  someone to finish their organization's due work at once.
- **The daily cleanup** keeps its own cron, `17 3 * * *`: the gateway's retention cleanup runs on it and the tick
  doesn't.

### 8.6 Usage reports

The operator console (§11) never reads an app's database. Every app reports a few numbers instead, once an hour, from
its own tick (§8.5): gauges for the app as a whole and for each organization, such as the database's size, the records
of each kind and the bytes of files stored. Counts and sizes only: never a name, an address, an amount or content.

- **Every app reports.** It declares `insulin.scheduled` (§8.5) and, on the first tick of each UTC hour, sends the
  hour's report. It keeps which hours it sent in its own D1 (a table like `metrics_reports`), claims the hour with one
  conditional statement so two overlapping ticks never both send, marks it sent once every request got 202, and
  releases the claim on anything else so the next tick tries again.
- **The request.** `POST https://insulinapps.com/__insulin/metrics` (`SUGER_METRICS_URL`), over the `SUGER_GATEWAY`
  binding, with `SUGER_APP_TOKEN` as a bearer token, and at most 512 KB of JSON:

  ```json
  { "hour": "2026-01-01T10:00:00Z",
    "app": { "database_bytes": 123456, "organizations": 3 },
    "organizations": [ { "id": "<organization id>", "metrics": { "envelopes": 12, "storage_bytes": 2048 } } ] }
  ```

  `hour` is the top of a real UTC hour (one that reads back as sent: no February 30 or 24:00), the one the values were
  measured in, not in the future and at most seven days old. Each
  metrics object holds at most 20 entries, each a name matching `[a-z][a-z0-9_]{0,39}` and a number from 0 to 10^15;
  `organizations` at most 500, each id once. A larger report is several requests for the same hour (`app` in the
  first). Every value is a gauge, the total when measured; activity shows as the difference between reports. A name
  ending in `_bytes` is shown as a size.
- **What the gateway does.** It checks the token (401), the size (413), the shape (400 `invalid_request`, with a
  `detail` naming the rule, never echoing a value) and `RL_APP` per app (429), then stores what the request carries,
  replacing that hour's values, so a resent report changes nothing. Organizations it doesn't know are skipped. It
  answers 202 `{ "status": "accepted", "organizations": <stored>, "skipped": <unknown> }`, and 503 `not_configured`
  without `GATEWAY_SECRET_KEY`. Reports for a suspended organization are still stored. Hourly values are kept three
  days, the last report of each UTC day 400 days; each report also deletes up to 1,000 of its app's expired rows from
  each table, more than one report adds, so an app's reports keep its retention whatever the rest of the traffic.
- **Configuration.** The deploy gives each app `SUGER_METRICS_URL` next to `SUGER_MAIL_URL`, when `GATEWAY_SECRET_KEY`
  is set. Without it (a local preview), an app reports nothing.

## 9. Data

All in the gateway's D1 database; migrations are forward-only.

| Migration | Tables |
|---|---|
| `0003_roles` | `memberships` and `invitations` rebuilt with the role `APPS` (specific apps) and without `USER`; `app_grants`, `invitation_grants`, `custom_roles`, with the triggers of §2.2 |
| `0004_oauth` | `oauth_clients`, `oauth_requests`, `oauth_grants`, `oauth_codes`, `oauth_tokens`, `service_accounts`, `integrations`; a trigger that deletes a person's grants in an organization they leave |
| `0005_mfa` | TOTP columns on `users`, `mfa_recovery_codes`, `mfa_challenges` |
| `0006_sso` | `sso_domains`, `sso_connections`, `sso_requests`, `scim_tokens`, `scim_users` |
| `0007_org_limits` | `orgs.invite_verified_domains_only` (§3) and `orgs.owner_domain`, filled from each creator's address; `org_domain_allowances`; `mail_log.user_id` for the per-person cap on requests (§3.1) |
| `0008_api_clients` | `service_accounts.previous_secret_hash`, `previous_secret_expires_at` and `secret_rotated_at` (rotation with a 24-hour overlap, §5.3); `oauth_tokens.client_secret_hash`, the secret that issued a client's token |
| `0009_owner_domains` | `orgs.owner_domain` filled where it was missing and Gmail owner domains (and allowances) in one form; `mail_log.owner_domain_hash` for the per-domain cap on requests (§3.1) |
| `0010_oauth_client_revocation` | `revoked_at` and `revoked_by` on `service_accounts` and `oauth_grants` (§5.4) |
| `0011_operator_console` | `status`, `status_reason`, `status_changed_at` and `last_active_at` on `users` and `orgs`, and `orgs.created_by_operator` (§11.2–11.4); `app_metrics_hourly` and `app_metrics_daily` (§8.6); `super_operators`, `super_sessions`, `super_saml_requests`, `super_audit`, `super_jobs` and `super_cloudflare_snapshots` (§11) |

## 10. Configuration added

| Name | Kind | Notes |
|---|---|---|
| `GATEWAY_SECRET_KEY` | secret | 32 random bytes, base64. Encrypts TOTP secrets, stored credentials and OIDC client secrets; derives the apps' `SUGER_APP_TOKEN`. Without it MFA, stored credentials and OIDC can't be set up (the rest works) |
| `SITE_APPS[].permissions`, `SITE_APPS[].publicPaths`, `SITE_APPS[].scheduled` | var | From each app's `package.json` (§2.3, §8.1, §8.5) |
| `RL_PUBLIC` | ratelimit | Requests to public paths that aren't GET or HEAD, per app and IP; 60 a minute suggested (§8.1) |
| `ORG_REQUEST_EMAIL` | var | Optional: Insulin Apps support's address for requests for more organizations (§3.1). A GitHub variable, never written in the repository |
| Cron triggers | trigger | `*/5 * * * *` (the apps' tick, §8.5, and the console's hourly work, §11.5) and `17 3 * * *` (the daily cleanup) |
| `SUPER_SAML_IDP_ENTITY_ID`, `SUPER_SAML_IDP_SSO_URL`, `SUPER_SAML_IDP_CERT`, `SUPER_GOOGLE_GROUP` | var | The operator console's Google Workspace SAML app and the operators' group, by its name (§11.1). All four, or the console isn't there. GitHub variables, never written in the repository |
| `SUPER_ADMIN_EMAILS` | var | The console's admins, addresses separated by commas or spaces (§11.1). A GitHub variable, never written in the repository |
| `SUPER_CLOUDFLARE_API_TOKEN` | secret | Optional: a read-only Cloudflare API token for the console's resource snapshot (§11.5). The deploy passes its own account as `SUPER_CLOUDFLARE_ACCOUNT_ID` |
| `SUGER_METRICS_URL` | app var | Where each app sends its hourly usage report (§8.6) |
| App secrets | GitHub environment | Each app's `insulin.secrets`, by name (§8.3) |
| `nodejs_compat` | flag | For SAML's XML signature library |

Changing the domain of sign-in means registering `https://insulinapps.com/auth/google/callback` with Google (the
runbook says so); the old `auth.` callback redirects there but Google checks the exact URI it was given.

## 11. The operator console

`insulinapps.com/super` is for a few Insulin Apps staff: they watch how Insulin Apps is used, catch abuse, suspend or
disable organizations and accounts that break the rules, see a Cloudflare limit coming before it is hit, and see which
apps people use, to decide what to build next. It is part of the gateway, on the apex only, and isn't there (every
path 404) unless it is configured. Customers never see it, and it never sees their data: organizations' and people's
basic facts, and numbers.

### 11.1 Who signs in, and how

- **A Google Workspace SAML app of its own.** The console signs in only through a SAML app in the company's Google
  Workspace, made for it (the runbook says how), never through the customers' sign-in. `GET /super/login` sends an
  AuthnRequest (HTTP-Redirect) to `SUPER_SAML_IDP_SSO_URL`, recorded single use for ten minutes and bound to the
  browser by the host-only `__Host-insulin_super_flow` cookie (`SameSite=None`, because Google posts the answer
  from its own site). Google posts the signed response to `POST /super/saml/acs`, the console's one form exempt from
  the Origin check, which checks it as §7 does: signed with `SUPER_SAML_IDP_CERT` (RSA-SHA256, the signature covering
  what is read), issued by `SUPER_SAML_IDP_ENTITY_ID`, for the audience `https://insulinapps.com/super` and the ACS,
  within its validity window, answering the request this browser started. `GET /super/saml/metadata` is the
  console's SP metadata.
- **The operators' group.** The signed assertion's `groups` attribute must list `SUPER_GOOGLE_GROUP`, the group's
  name, which is what the Workspace app's group membership mapping sends (not its address), compared without regard
  to case. Someone in a group nested in it counts: Google sends the outer group. Renaming the group means setting the
  variable again. The runbook also turns the app on for that
  group only, so Google itself refuses everyone else: two locks. Anyone else is told they aren't an operator; the log
  says so without their address.
- **Operators and admins.** Everyone who gets in is an operator and reads everything below. An operator whose
  address is in `SUPER_ADMIN_EMAILS`, read at every request, is also an admin: suspends, disables and reinstates
  (§11.3) and creates organizations (§11.4). The list is fixed by the deploy, never changeable from the console; the
  addresses are GitHub variables, since this public repository holds no real addresses. `super_operators` records
  each operator at their first sign-in, for the audit log.
- **Its own session.** `__Host-insulin_super`: host-only on the apex (app hosts never receive it, and it is one of the
  gateway's cookies, never forwarded nor set by an app), `Secure`, `HttpOnly`, `SameSite=Lax`, for eight hours from the
  sign-in and never renewed; D1 keeps only its SHA-256. A customer's session opens nothing here, and the console's
  nothing elsewhere. Sign out deletes it. Someone removed from the group can't sign in again, and their session ends
  within eight hours.
- **Pages** are server-rendered like every gateway page, under the same CSP, `noindex` and never cached; their forms
  pass the apex's Origin check, and every admin action checks the admin list again on the server.

### 11.2 What operators see

- **Overview.** Organizations, people and active people (in a day, a week, 30 days), new ones each week, how many are
  suspended or disabled; new accounts and organizations per day for 30 days; the **watch list**: Cloudflare figures
  past 80% of a limit or heading past it this month, apps whose last report is over two hours old, owner domains at
  their organization limit, e-mail domains with ten or more new accounts in a day, accounts still unconfirmed after a
  week, and the day's requests for more organizations; the apps' latest reports; the Cloudflare limits.
- **Organizations**, searched by name, id, owner domain or a member's address, filtered by standing, sorted by
  creation, last activity, name or size. Each one: its name and id, standing (with the operators' reason), when and by
  whom it was created (and by which operator, §11.4), when it was last active, its owner domain with how many
  organizations that domain has and may have; its people (name, address, role, when they joined, last active,
  standing); the gateway's own counts (pending invitations, API clients, live AI agents, stored credentials,
  verified domains, single sign-on, SCIM tokens, mail of the last 48 hours); each app's latest report for it and 30 days
  of one of its numbers; and its history in the audit log.
- **People**, searched by name, address or id: name, address (confirmed or not), when they joined, last active,
  standing, and their organizations with their role in each.
- **Apps**: each app's latest report (§8.6), app-wide and summed over organizations, 30 days of its database's size,
  its organizations ranked by any of its numbers, and those that grew most in a day.
- **Cloudflare** (§11.5) and the **audit log** (§11.6).
- **Last active** is `users.last_active_at` and `orgs.last_active_at`: set at each sign-in and by the hourly session
  touch (the session's active organization), and by an AI agent's or API client's use, at most hourly too. So it is
  right to within an hour.
- **Never shown**: an app's data (the console has no way into an app's database), secrets, tokens or their hashes,
  stored credentials, what any mail said, passwords or how someone signs in, and IP addresses (the gateway stores
  none).

### 11.3 Suspending and disabling

Accounts and organizations have a standing: **active**, **suspended** (access paused while the operators look into
it, everything kept) or **disabled** (access ended for abuse or fraud). An admin changes it with a reason (3 to 500
characters), which only operators see; the change and its audit record are one batch, and asking for the standing it
already has changes and records nothing. **Reinstate** makes it active again.

- **A suspended account** has no session: the session lookup and the session insert both require an active account,
  so it is signed out everywhere at once and stays out. Every sign-in (password, Google, a reset or confirmation link,
  single sign-on, the code step) stops before a session or a second step with "This account is suspended" and whom
  to contact, never the reason. Its AI agents' tokens and refresh tokens are refused, and no app sees it
  (`findAccessRow`). Its sessions and agents are kept, so reinstating gives them back.
- **A disabled account** is refused the same way; disabling also deletes its sessions, its agents' grants (with their
  tokens) and any second step in progress, so reinstating it starts from a fresh sign-in.
- **A suspended organization** gives its members nothing: their memberships of it stop counting (`findMembership`,
  `listMemberships`, the session's active organization, `findAccessRow`), so its settings pages and forms answer 404,
  its apps can't be opened in it (the session moves to another organization, or none), the organization switcher
  leaves it out, and the home page tells its members it is suspended. The actor check every organization change
  repeats in its statement (`orgAdmin`, `appAdmin`, `owner`, and the inline ones of renaming, deleting, roles, access,
  removals, leaving and invitations) counts a membership only in an active organization, so even a change racing the
  suspension writes nothing, and an agent's or API client's use doesn't mark it active. Its agents' and API clients' tokens are refused, and so are refreshing and issuing new ones; SCIM
  gets 401; single sign-on to it shows the suspension; its invitations can't be accepted; the integration proxy finds
  no credential; the mail relay answers 403 `organization_unavailable`. Its usage reports are still stored.
- **A disabled organization** is refused the same way; disabling also deletes its AI agents' grants (with their
  tokens), revokes its API clients (their tokens deleted, a previous secret dropped), revokes its pending invitations
  and deletes its SCIM tokens. Reinstating doesn't bring those back.
- **Data stays.** Neither deletes anything else, and both organizations still count for their owner domain's limit,
  so a disabled organization can't be replaced by a new one. Deleting the account of its only member leaves it in
  place too (the account goes; the organization, without members, stays suspended or disabled). An organization that requires its single sign-on for a
  domain keeps requiring it while suspended, so its people can't sign in with a password either until it is
  reinstated.

### 11.4 Creating an organization past the limit

For someone whose owner domain has all the organizations it may have (§3.1) and who asked support for another, an
admin creates one at `/super/orgs/new`: the owner's address (an existing, confirmed, active account), the name and a
reason. The form carries the id of the organization it creates, so a form sent twice creates one (the second lands
on it), and an id that is already another organization's takes nothing over. One batch writes the organization (its
owner domain as usual, `created_by` the person, `created_by_operator` the admin's address), the OWNER membership and
the audit record, without the domain's count; the organization still
counts for the domain, so the person's own next one is limited as before. The person gets an e-mail from Insulin Apps
support, which doesn't name the operator, linking to the organization's settings. Raising a domain's allowance with
`allow-orgs.mjs` remains the way to let someone create more themselves.

### 11.5 Cloudflare resources

Once an hour, the first five-minute tick of the hour that claims the run in `super_jobs` (a run that failed or read
only part of the account, or one unfinished after 15 minutes, is claimed again by the next tick) reads the Cloudflare
account with `SUPER_CLOUDFLARE_API_TOKEN`, a read-only token with
**Workers Scripts: Read** and **Account Analytics: Read** only, on the account the platform deploys to
(`SUPER_CLOUDFLARE_ACCOUNT_ID`, which the deploy sets from its own `CLOUDFLARE_ACCOUNT_ID`). It never has a D1
permission: Cloudflare's D1 query API takes a read-only D1 token, so one would let the console read every app's
database. So:

- the Worker scripts named `insulin-apps-*`, and from each one's settings the D1 database it binds (named after the
  Worker, as the deploy names it);
- from the GraphQL Analytics API, each Worker's requests, errors and CPU time (median and 99th percentile) for the
  last 24 hours, and its requests and errors since the month began; each database's size, and its rows read and
  written yesterday and this month (D1's analytics count by UTC day, so a whole day is the shortest window).

It stores a snapshot (one an hour, the latest try; kept 90 days) even when a part fails, naming the part: figures
that weren't read are unknown, never zero, so they make no meter (a D1 meter needs every database's figure: a total
that leaves one out would understate), and the overview says part of the read failed. Requests go to `api.cloudflare.com`
only, follow no redirect and time out after 20 seconds; the token is never logged. The console compares the month's
figures with what the Workers Paid plan includes (10 million requests, 25 billion D1 rows read and 50 million written a
month, 5 GB of D1 storage) and the largest database with D1's hard limit of 10 GB, projects the month at the current
pace (from an hour into the month: before that there's too little to go on), and puts anything past 80%, or heading
past a limit, on the watch list. Requests count the gateway's alone:
every request from outside reaches it first, and its calls to the apps go over service bindings, which Cloudflare
doesn't bill as requests. The allowances are the account's, so the meters assume an account that runs Insulin Apps
alone. The figures are in `gateway/src/super/cloudflare.ts` (`PLAN`); without a token the page says how to add one.
The page also lists everything else the platform uses, from the gateway's configuration: its custom domains, each
app's Worker and binding, the Email Service (with the last 48 hours' messages), the rate limiters, the docs' static
assets and the cron triggers.

### 11.6 Audit log

`super_audit` records every sign-in to the console and every action: when, the operator's address, what, the
organization or account (with its name or address at the time) and the reason. It is kept for good, shown at
`/super/audit` and on each organization's and account's page. Reading pages isn't recorded.
