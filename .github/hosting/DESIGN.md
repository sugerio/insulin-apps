# Accounts, roles and access on insulinapps.com

This is the design of everything the hosting gateway (`.github/hosting/gateway/`) decides about people and machines:
who may sign in and how, which organization they act in, what role they have in each app, and how AI agents and API
clients reach the apps. The apps receive the result as request headers, and ask the gateway, with a token of their
own, for the rest they need: their limits and who is still a member (§8.8, §8.9). The operator runbook is
[README.md](README.md); the gateway's code map is [gateway/README.md](gateway/README.md); the rules every app follows
are in the repository's [AGENTS.md](../../AGENTS.md).

## 1. Hosts

| Host | Serves |
|---|---|
| `insulinapps.com` | The single entry for everything that is not an app: landing, privacy and terms; the public docs at `/docs/` (generated from `.github/hosting/docs/` and each app's `docs/public/`, with `/docs/llms.txt` for AI agents and the images at `/docs/assets/*` from the static-assets binding), searchable at `/docs/search` and `/docs/search.json` and through the docs' own MCP server at `/docs/mcp`, all public with no sign-in and limited per IP; `/robots.txt` (every crawler, AI crawlers included, may read all but the search results), `/sitemap.xml` (the landing page, privacy, terms and every docs page) and `/llms.txt`; sign-up, sign-in, MFA, Google and enterprise SSO; account and organizations; `/settings/users` and `/settings/roles` (the organization's people and roles); `/settings/organization` (name, who can be invited, leave, delete); `/settings/oauth-clients` (every OAuth client of the organization, §5.4); `/settings/sso` (SAML or OIDC and SCIM); each app's settings: people, integrations, API access and Connect AI at `/apps/<app>/settings/users`, `/integrations`, `/api` and `/connect-ai`; the OAuth authorization server for MCP clients and OAuth clients (service accounts); SCIM; the operator console at `/super` (§11), for Insulin Apps staff only; and what app Workers call with their own token: their hourly usage reports at `/__insulin/metrics` (§8.6), their limits at `/__insulin/limits` (§8.8) and their organizations' members at `/__insulin/members`, `/__insulin/members/status` and `/__insulin/member-events` (§8.9). |
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
means is the app's call: Cap Table shows a Viewer their own holdings). In an app whose records have roles of their
own, such as Knowledge's collections, "everything" stops at those records: no app role opens one by itself (§2.5).

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

The gateway forwards each request with the identity contract of `@fours/app` plus headers of its own: the
permissions, how the request came, the person's organization role and, for a browser, the member lookup. Every
incoming `x-suger-*` header is removed first.

| Header | Value |
|---|---|
| `x-suger-user-id`, `x-suger-user-email`, `x-suger-user-name` | The person (or service account, §5.3) |
| `x-suger-organization-id` | The organization the request acts in |
| `x-suger-app-id` | `insulin-apps-<app>` |
| `x-suger-app-role` | `ADMIN`, `EDITOR` or `VIEWER`. For a custom role: the least built-in role that covers its permissions |
| `x-suger-app-permissions` | Apps with a catalog only: the permissions, space-separated. For built-in roles, every permission at or below the role; for a custom role, its own |
| `x-suger-access-via` | `browser`, `mcp` or `api`; `public` on an app's public paths (§8.1), where it and `x-suger-app-id` are the only headers; `schedule` on the gateway's tick (§8.5) |
| `x-suger-org-role` | The person's organization role: `OWNER`, `ADMIN`, `EDITOR`, `VIEWER` or `APPS` (specific apps), on `browser` and `mcp` requests. Absent for API clients, which have none, on public paths and on the tick |
| `x-suger-member-lookup` | `browser` requests only, when `GATEWAY_SECRET_KEY` is set: the organization, the person and an expiry five minutes ahead, signed for this app, which the app passes back to look up members (§8.9) |

Apps treat `x-suger-app-permissions` as a **narrowing** of the role, never a widening: effective permissions are the
role's permissions intersected with the header. Behind the gateway the header is always set; elsewhere (the Insulin
console) it may be missing, and then the role alone decides. A forged header can only take access away.

**The organization role can give powers**, unlike the other headers. An app may give the organization's owners or
admins powers over its records that no app role gives (Knowledge lets owners see every collection's basic information,
turn keeping one ready off and delete one; Esign lets owners take over what someone owns, and owners and admins choose
who sees an API client's documents), and still enforces them on the server. An app Admin by a specific-apps grant is
`ADMIN` in `x-suger-app-role` but `APPS` here. So an app honours `x-suger-org-role` only when its deploy sets
`SUGER_TRUST_ORG_ROLE` to `true`, as this repository's deploy and local stack do for every app (§10), only for people,
and treats a missing or unknown value as no organization role.

Apps refuse mutations of their own people, roles, billing or integrations unless `x-suger-access-via` is `browser`
(§4), and, in an app with resource roles, sharing, unsharing and deleting a record (§2.5). The gateway's own pages
already never accept a token.

### 2.5 Resource roles inside apps

An app may let people share its own records with people and API clients of the same organization, with roles of its
own on each record (Knowledge's collections: Owner, Admin, Editor and Viewer). That is access to the app's data,
managed in the app; it is not the platform's people, roles or permissions (§3, §4), so app Editors may share what the
app lets them share. For such records these rules narrow §2.2's "Admin can do everything in the app" and add sharing
and deleting to §4's browser-only actions. Every app with resource roles keeps them:

- **An app role opens no record by itself.** An app Admin who has no role on a record can't read it.
- **A Viewer only reads.** Whatever resource role someone holds, they can only read unless their permissions in the
  app allow changes (permissions, not role names, decide).
- **Sharing is browser-only** (§4): AI agents and API clients use what is shared with them, and change its contents as
  their role on it allows, but can't share or unshare a record, or delete it.
- **The organization's owners** may get powers over every record that no app role gives, from `x-suger-org-role`
  (§2.4).
- **Who is still a member** comes from the platform: the member lookup fills the sharing dialog, and member status and
  member events keep the app's roles in step with people and API clients who leave, return or change role (§8.9).
- **Leaving and returning** follow the app's own rule, stated in its Docs. Knowledge keeps a person's shares on hold
  and restores them if they return; the platform's AI agent grants still don't come back (§5.2).

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

Apps keep the same rule for anything of that kind they implement themselves, using `x-suger-access-via`. An app whose
records have roles of their own (§2.5) adds sharing, unsharing and deleting such a record to this list; there the
rule is the app's to enforce, for its own roles, not owner- or admin-only.

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

#### 5.3.1 An app's settings for each client

An app can keep settings of its own for each of its OAuth clients, such as who in the organization sees what the client
creates (Esign's), on a page of its own. It declares the page in `insulin.clientSettings`: its path, or
`{path, description}` with one line (1 to 160 characters of plain text) on what is set there. The API access page shows,
under each live client and for the organization's owners and admins only, an outlined button **<App> settings** to
`https://<app host><path>/<service account id>?name=<client name>`, with that line below it (without one, a generic
line). That is all the gateway does: it neither reads nor stores the settings, and calls nothing.

- **The path.** A page a navigation item could link to (§3.2: on the app's own host, never one of the gateway's
  paths), without a query or a trailing slash, outside `/api/`, and neither one of the app's public paths nor under one,
  so whoever opens it is signed in. `list-apps.mjs`, `check-insulin-app.mjs` and the gateway's configuration check it.
- **The id and the name.** The service account id is the `x-suger-user-id` the client's calls carry, so the app can
  match the settings to them; the name lets the app show a client that hasn't called it yet.
- **What the app checks.** The link is only a way there: anyone could type the address. The app shows and saves the
  settings only for the organization's owners and admins (`x-suger-access-via: browser`), and an id it knows as a
  person's is not a client's. A client deleted on the platform isn't announced; settings left for it are harmless.

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

An app gets one D1 database and static assets: no R2, KV, queues, cron triggers or e-mail binding
(`check-insulin-app.mjs` refuses a build that declares one). The only other bindings are the deploy's own: the way to
the gateway's endpoints, `SUGER_GATEWAY` (§8.2), and, for an app that owns an engine, the way to that second Worker,
which may hold what the app can't, `SUGER_ENGINE` (§8.7). What an app needs beyond that, the gateway provides,
declared in the app's `package.json` under `insulin`:

```json
"insulin": {
  "permissions": [ … ],
  "publicPaths": ["/sign", "/api/public/", "/assets/"],
  "scheduled": "/api/scheduled",
  "clientSettings": { "path": "/client-settings", "description": "Choose who in your organization sees … in Esign." },
  "secrets": ["ESIGN_OTP_KEY", "ESIGN_FRAME_ANCESTORS"]
}
```

The deploy reads these with `list-apps.mjs` and refuses a malformed list; the gateway checks `publicPaths`,
`scheduled` and `clientSettings` again and fails closed. An app may also declare an engine (`engine` and `engineApi`,
§8.7) and limits (`limits`, §8.8), and read its organizations' members (§8.9).

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

### 8.7 App-owned engines

Some apps need compute that D1 and a Worker can't give. Such an app may own one **engine**: a second Worker in the
app's directory, `insulin-apps-<app>-engine`, reached only by the app, over the `SUGER_ENGINE` service binding.
Knowledge's is the first: a Durable Object and a container for each collection.

- **Declaration.** `"insulin": { "engine": "engine/", "engineApi": <n> }` names a directory inside the app and the
  engine API version the app calls, a positive integer that an engine needs and an app without one may not declare. The
  directory has lower-case names and is none of the app's own (`src/`, `public/`, `docs/`) or what builds and tools
  write. It holds one Worker with its own `package.json`, exact `package-lock.json` (registry versions only) and
  `wrangler.jsonc`. Its `package.json` depends on an exact Wrangler, has the scripts the app's pipeline runs
  (`typecheck`, `test`, and `check`, which runs Wrangler's dry run with `--config`; `test:container` with a container;
  `test:python` when the image copies Python files, with the packages its tests install in
  `test/python/requirements.lock`, pinned by version and hash), and declares the engine API versions it serves,
  `"insulin": { "serves": [<min>, <max>] }`, which must cover the app's `engineApi`.
- **Its Wrangler config** is named `insulin-apps-<app>-engine`. Besides `$schema`, `main`, `compatibility_date` and its
  flags, it may declare only: Durable Objects of the engine's own classes (no `script_name`); Durable Object
  `migrations` that only create, rename or delete the engine's own classes (no `transferred_classes` or `from_script`,
  which would take over another Worker's stored objects); Containers of those classes, all built from one Dockerfile in
  the engine's directory (an engine has one image; no image from a registry, no SSH); R2 buckets by binding name alone,
  matching `[A-Z][A-Z0-9]*` (no underscore, no bucket name); the Workers AI binding; `observability`; and plain `vars`
  whose names don't look like secrets, since they are written in the repository. No binding name starts with `SUGER_`.
  It declares no `route`, `routes`, custom domain or `account_id`, and sets `workers_dev: false` and
  `preview_urls: false`: without routes, Wrangler's default is a public workers.dev address. `list-apps.mjs` refuses app
  names ending in `-engine`, which would collide with another app's engine Worker.
- **Checks.** `check-insulin-app.mjs` leaves the engine directory out of the app's rules (no `cloudflare:` imports, no
  Wrangler file, the file limits, one npm package) and checks it with its own (`.github/scripts/engine.mjs`): the
  package and lockfile, the config above, a Dockerfile whose images (`FROM`, `COPY --from`, a `RUN --mount` from an
  image) are pinned by digest and which fetches nothing with `ADD` from a URL, no binding that would make a bucket name
  past R2's 63 characters (§10.1), and no account id in the config or reference to the engine's own image in the
  registry anywhere in the directory. Every package a `RUN` step installs is pinned: `pip` with `--require-hashes` (or
  only local files), `npm ci` or a frozen `yarn`/`pnpm` install, `apt-get`/`apk` with exact versions, and `curl` or
  `wget` only in a step that also checks a checksum; `npm install`, `npx` and installers it can't check are refused.
  What a script fetches by itself (Knowledge's model download at build time) is out of the check's sight. The deploy
  checks the config again and never trusts it: it writes the deployed one itself (§10.1).
- **The seam.** The engine trusts only its binding: every call names the organization the app is acting for, and the
  app checks access, roles and limits before calling. The app's own build declares no binding; the deploy adds
  `SUGER_ENGINE`, as it adds `SUGER_GATEWAY`.
- **Releases.** The deploy builds, versions and deploys the engine with its app (§10.1): before the app, with a check
  that the two serve each other's engine API version, and with its container image built and pushed only when it
  changed.
- **Stub.** An app with an engine ships a stub that answers from memory, used by `npm run dev`, the AppBuilder's
  preview, the local stack and the workerd smoke test (§10.2).
- **AppBuilder.** The Insulin console publishes D1-only apps, so an app with an engine stays out of the template
  catalog until the console can publish engines too.
- **Operator console.** An engine Worker is one of the `insulin-apps-*` Workers on the console's Cloudflare page; what
  it holds (containers, R2, Durable Objects, Workers AI) isn't metered there yet (§11.5).

### 8.8 App limits

An app with real running costs may limit each organization's use. Console admins (§11.1) set the limits (§11.7); the
app enforces them.

- **Catalog.** `insulin.limits` lists at most 20 limits: `{ key, label, unit, default }`, where `key` follows the rule
  for usage metric names (§8.6) and appears once, `label` is 1 to 80 characters, `unit` is `count`, `bytes`, `hours` or
  `days`, and `default` is a whole number from 0 to 10^15; any other field is refused. `list-apps.mjs` and
  `check-insulin-app.mjs` check it, and the gateway's `scripts/limits-catalog.mjs` again before writing it.
- **The catalog in the gateway.** It may not fit `SITE_APPS` (5 KB), so the deploy writes each app's catalog to the
  gateway's D1 (`app_limit_catalog`), replacing the app's whole catalog: a key the app no longer lists goes, and a
  default or override set for it stays stored, unused, and applies again if the key returns. It writes the catalog of
  the app version in production. The deploy job of every app writes its catalog (an empty one for an app without limits)
  right after the app's deploy and before the public-access check, so the version now running has its catalog even if
  that check fails, once the gateway's tables exist; and the gateway's step writes those of every app its run deployed
  (emptying the catalog of one that lists none), after the gateway's migrations, so the first release with the tables
  writes them there: the apps' jobs run first. An app held back, or whose deploy failed, keeps the catalog of the
  version it still runs. So the console manages the limits the running app enforces, after every deploy that changes an
  app, a rollback or a deploy of apps alone included, and whether or not the gateway Worker is deployed too.
- **Delivery.** On its tick the app calls `GET https://insulinapps.com/__insulin/limits?since=<cursor>`
  (`SUGER_LIMITS_URL`), one of the app endpoints of §8.9 (its token, over `SUGER_GATEWAY`), and gets
  `{ "defaults": { key: value }, "organizations": [ { "id", "limits": { key: { "value", "until" } } } ], "cursor", "more" }`.
  - `defaults` holds every key's default in force: the console admins', where they set one, else the catalog's.
    `value` is a number, or `null` for unlimited; `until` is an ISO time or `null`.
  - An organization is listed when any of its overrides changed after the cursor (every organization with an
    override, without `since`), with all its current overrides. The app replaces that organization's overrides with
    them, so `{}` clears them. A key without an override takes the default. Only organizations where the app is used
    are listed (§8.9); one that starts using the app is listed at the app's next read, with overrides set before.
  - Pages hold at most 500 organizations, oldest change first. The app saves `cursor` after applying each page and
    asks again while `more` is true, so an interrupted tick resumes where it stopped. A cursor that isn't a whole
    number gets 400.
  - The app keeps the effective limits in its own D1, so a change applies within five minutes, and an override past
    its `until` falls back to the default.
  - On anything but 200 (503 `not_configured` without `GATEWAY_SECRET_KEY`, or 404 from an older gateway), the app
    keeps what it stored, and uses the catalog's defaults only where it has stored nothing.
- **Usage beside limits.** An app with a catalog reports usage under the same keys (§8.6). A monthly count is a
  month-to-date gauge that drops to 0 on the first of the month, UTC; its key ends in `_month`, which the console reads
  as "this month".
- **Messages.** A limit's message names Insulin Apps support. The deploy gives each app the platform's `SUPPORT_EMAIL`
  as `SUGER_SUPPORT_EMAIL`; no address is written in the repository. API and MCP callers get 429
  `{ "error": "quota_exceeded", "limit": "<key>", "resets_at": "<time>", "message": "…" }`, where `resets_at` is
  `null` for a limit that doesn't reset by itself (stored bytes, a count of records). An AI agent gets the app's answer
  as a failed tool call, message included.
- **Self-hosted.** A deployment starts with the catalog's defaults; its own operators change them.

### 8.9 Organization members

Apps that let people share their records (§2.5), or pick people of the organization at all, need to know who is in
it: an app has no directory of its own, since the gateway tells it who calls at each request. The gateway answers them
on three endpoints, which, with the limits of §8.8, are the **app endpoints**:

- **Who may call.** An app Worker, with its own `SUGER_APP_TOKEN` as a bearer token, over `SUGER_GATEWAY`, on the apex
  only. The gateway takes the app from the token and accepts no session, OAuth or client token (401). Without
  `GATEWAY_SECRET_KEY` there are no app tokens, and they answer 503 `not_configured`. Each is limited per app on
  `RL_APP`, except the member lookup, limited per person.
- **Where each app is used.** They answer only about organizations where the app is used: `app_orgs` records the
  gateway's first request to the app for an organization (a page, an AI agent or an API client; never a public path or
  the tick), written before that request goes on, so an app never serves an organization these endpoints don't yet
  answer for. Migration `0012` fills it for the organizations that used an app before it, from what the gateway held
  of the app there (its usage reports, its mail through the relay, its API clients and AI agents' grants, its stored
  credentials, specific-apps members given it), so an app that acts without a request (Esign's scheduled sends) has
  its answers at once; any other organization gets a row at its next request. Deleting an organization forgets its
  rows.
- **Member lookup.** `GET https://insulinapps.com/__insulin/members?q=<text>` (`SUGER_MEMBERS_URL`), with the
  `x-suger-member-lookup` header of the browser request the app is serving. The gateway adds that header to every
  request with `x-suger-access-via: browser`: `v1.<organization>.<person>.<expiry>.<signature>`, the expiry five
  minutes ahead and the signature an HMAC-SHA256 over the version, the app, the organization, the person and the expiry,
  with a key derived from `GATEWAY_SECRET_KEY` for this purpose alone. Like every `x-suger-*` header it is removed from
  incoming requests, and MCP, API, public and tick requests carry none. Without `GATEWAY_SECRET_KEY` (§10), the gateway
  leaves the header out and forwards browser requests as usual. The gateway checks the signature with the app the
  token names (403 `invalid_member_lookup` otherwise), takes the organization and the person from the header, never
  from the app, checks again that the person can use the app there (403 `no_app_access`), and returns
  `{ "members": [ … ] }`: at most 20 matches, whose name or address contains the text (1 to 100 characters), among
  people who can use the app now with an active account (`type: "person"`, id, name, address, app role) and the app's
  live API clients (`type: "client"`, id, name). The app's token alone reads no one. It fills a sharing dialog and shows
  no more than that dialog needs; an app may also check that addresses someone typed are its people, one lookup each
  (Esign: who sees an API client's documents, `422 not_members` otherwise). Requests by AI agents and API clients
  carry no header, so there the app falls back on the people it has seen. (Before this lookup was built, the same
  address answered with up to 500 of the organization's people for the app's token and an organization the app named
  in `x-suger-organization-id`; the lookup replaced that answer, and an app calling it so now gets 403
  `invalid_member_lookup`.)
- **Member status.** `POST https://insulinapps.com/__insulin/members/status` (`SUGER_MEMBER_STATUS_URL`) with
  `{ "org", "ids" }`, at most 100 people or API clients the app already holds, returns
  `{ "org", "standing", "owners", "members" }`.
  Each id comes back with its `type` and `status`: `member`, with its app role (and, for a person, organization role;
  permissions for an app with a catalog); `left` for a person who can no longer use the app; `revoked` for a revoked
  API client; or `gone` (no type) for an id that is neither an account nor one of the app's API clients there. A
  suspended account or organization still counts as a member: suspension is the gateway's to enforce, not a
  departure. Each person who is a member also has `standing`, the account's (`active`, `suspended` or `disabled`,
  §11.3), and the answer the organization's `standing`, for an app that acts for someone later, without a request of
  theirs: Esign sends a scheduled envelope only while whoever scheduled it is a member who may still send, with an
  active account, and holds it while the organization isn't active. `owners` are the organization's owners and since
  when, the time their membership last changed role. An organization that no longer exists answers 404 `org_deleted`,
  and one where the app isn't used 404 `unknown_organization`. It returns no names or addresses. Apps use it to resync
  and to check someone they hold, never to search.
- **Member events.** `GET https://insulinapps.com/__insulin/member-events?since=<cursor>` (`SUGER_MEMBER_EVENTS_URL`)
  returns `{ "events": [ { "id", "type", "org", "at", … } ], "cursor", "more" }`, oldest first, at most 1,000 a page:
  - `left` (`user`): removed from the organization or from the app, moved to specific apps without this one, or the
    account deleted;
  - `returned` (`user`, `orgRole`, `appRole`): any gain of access to the app, the first included (apps ignore ids
    they don't hold);
  - `role_changed` (the same fields): a new organization role, role in the app, or set of permissions of the custom
    role someone has;
  - `owners` (`owners`, each `user` and `since`): the organization's owners after any change of them;
  - `client_revoked` (`client`): an API client revoked, deleted while live, or revoked when the organization was
    disabled;
  - `org_deleted`, sent only to the apps the organization used, and the only event its deletion sends.

  `returned` and `role_changed` carry `permissions` too for an app with a catalog, as `x-suger-app-permissions` does.
  A change of an API client's role, and a suspension or reinstatement, send none. Triggers of migration `0012` write
  each event in the same transaction as the change it records, however it is made (a page, an invitation, single
  sign-on, SCIM, a domain's removal, an account's deletion, the console), stored once for every app or for one, and
  the gateway puts it in each app's terms when it is read: a move between an organization role and specific apps that
  keeps this app is one `role_changed`, not a departure and a return.

  The app saves `cursor` after applying each page and asks again while `more` is true. A call without `since` returns
  the current cursor and no events. Events are kept 90 days; housekeeping deletes older ones and remembers the highest
  id it deleted. A cursor below that, or ahead of anything the gateway has given, gets 410 `cursor_expired`, and the
  app resyncs: it first takes a fresh cursor (a call without `since`) and saves it together with a mark that a resync
  is under way, treats everyone it holds as away until checked, and checks them with the member status endpoint,
  saving its progress as it goes, so a tick that times out resumes the resync where it stopped. Only when everyone is
  checked does it clear the mark and read events from the saved cursor as usual, so nothing that happened during the
  resync is lost. If that cursor expires too, it starts again.

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
| `0012_limits_and_members` | `app_limit_catalog`, `app_limit_defaults` and `org_app_limits`, each change stamped with the next number of `app_limit_sequence`, and `org_app_limit_changes`, each organization's latest change in an app (§8.8, §11.7); `app_orgs`, where each app is used (filled for the organizations that already used it, §8.9), with a trigger that sends an organization's overrides to an app it starts using; `member_events` and `member_events_pruned`, with the triggers on memberships, app grants, custom roles, API clients and organizations that write the events (§8.9); `member_event_moves`, a move to specific apps open only within the batch that makes it, which its grants join |

## 10. Configuration added

| Name | Kind | Notes |
|---|---|---|
| `GATEWAY_SECRET_KEY` | secret | 32 random bytes, base64. Encrypts TOTP secrets, stored credentials and OIDC client secrets; derives the apps' `SUGER_APP_TOKEN`; signs `x-suger-member-lookup` (§8.9). Without it MFA, stored credentials and OIDC can't be set up, browser requests carry no member lookup and the apps' endpoints answer 503 (the rest works) |
| `SITE_APPS[].permissions`, `SITE_APPS[].publicPaths`, `SITE_APPS[].scheduled`, `SITE_APPS[].clientSettings` | var | From each app's `package.json` (§2.3, §8.1, §8.5, §5.3.1). An app's engine and limits stay out of it: the limits go to the gateway's D1 (§8.8) |
| `RL_PUBLIC` | ratelimit | Requests to public paths that aren't GET or HEAD, per app and IP; 60 a minute suggested (§8.1) |
| `ORG_REQUEST_EMAIL` | var | Optional: Insulin Apps support's address for requests for more organizations (§3.1). A GitHub variable, never written in the repository |
| Cron triggers | trigger | `*/5 * * * *` (the apps' tick, §8.5, and the console's hourly work, §11.5) and `17 3 * * *` (the daily cleanup) |
| `SUPER_SAML_IDP_ENTITY_ID`, `SUPER_SAML_IDP_SSO_URL`, `SUPER_SAML_IDP_CERT`, `SUPER_GOOGLE_GROUP` | var | The operator console's Google Workspace SAML app and the operators' group, by its name (§11.1). All four, or the console isn't there. GitHub variables, never written in the repository |
| `SUPER_ADMIN_EMAILS` | var | The console's admins, addresses separated by commas or spaces (§11.1). A GitHub variable, never written in the repository |
| `SUPER_CLOUDFLARE_API_TOKEN` | secret | Optional: a read-only Cloudflare API token for the console's resource snapshot (§11.5), never with a D1 or R2 permission. The deploy passes its own account as `SUPER_CLOUDFLARE_ACCOUNT_ID` |
| `SUGER_METRICS_URL` | app var | Where each app sends its hourly usage report (§8.6) |
| `SUGER_LIMITS_URL`, `SUGER_MEMBERS_URL`, `SUGER_MEMBER_STATUS_URL`, `SUGER_MEMBER_EVENTS_URL` | app var | Where each app reads its limits (§8.8) and its organizations' members (§8.9); like the other gateway URLs, only when `GATEWAY_SECRET_KEY` is set |
| `SUGER_SUPPORT_EMAIL` | app var | The platform's `SUPPORT_EMAIL`, which an app's limit messages name (§8.8); absent when that isn't set |
| `SUGER_TRUST_ORG_ROLE` | app var | `true`, for every app: the gateway sets `x-suger-org-role` (§2.4). Esign reads only exactly `true` |
| `SUGER_ENGINE` | app binding | An app with an engine: the service binding to `insulin-apps-<app>-engine` (§8.7) |
| `SUGER_ENGINE_API`, `SUGER_ENGINE_SERVES` | app var, engine var | The engine API version the app calls, and the versions its engine serves (`<min>-<max>`), which a later deploy reads back from production (§10.1) |
| `CLOUDFLARE_API_TOKEN` | secret | The deploy's token. For an app's engine it also needs Workers R2 Storage: Edit (its buckets) and Containers: Edit (its image's registry credential and its containers) (§10.1) |
| App secrets | GitHub environment | Each app's `insulin.secrets`, by name (§8.3) |
| `nodejs_compat` | flag | For SAML's XML signature library |

Changing the domain of sign-in means registering `https://insulinapps.com/auth/google/callback` with Google (the
runbook says so); the old `auth.` callback redirects there but Google checks the exact URI it was given.

### 10.1 Deploying an app's engine

A release deploys an app's engine (§8.7) with the app, in the app's own jobs of `deploy-release.yml`.

- **Build.** The build job, which has no deploy settings, also installs the engine's exact lockfile without scripts,
  runs its build if it has one, and bundles its Worker with its own Wrangler into `<engine>/.output/worker`. The archive
  it hands the production job may hold the app's `.output` and the engine's, nothing else. The app's own pipeline
  (`app.yml`) builds and bundles the engine the same way on every pull request and push, typechecks and tests it, and
  runs its Wrangler dry run (`npm run check`), and its Python tests and container test when the engine declares them.
- **Deploy.** The production job deploys the engine Worker, `insulin-apps-<app>-engine`, before the app. It writes the
  engine's deployed config itself, as it does the app's: the bundle uploaded as it was built, the engine's classes,
  migrations and bindings, the image by digest, the API versions it serves in `SUGER_ENGINE_SERVES`, both public
  switches false, and each R2 binding pointed at a bucket the deploy creates when it is missing and names,
  `insulin-apps-<app>-engine-<binding in lower case>`, never a name from the repository. Binding names have no hyphen or
  underscore, so no two apps' bucket names can meet. It removes and verifies any custom domain, route, workers.dev or
  preview URL, as `removeAppPublicAccess` does for apps, and fails the deploy if one remains. Then it deploys the app
  with a service binding to the engine, `SUGER_ENGINE`, and the API version it calls in `SUGER_ENGINE_API`. Each
  engine version is tagged with the release, like the app's.
- **Versions.** Before deploying either Worker, and before an app's D1 migrations, so a refused pair changes nothing,
  the deploy checks the pair it would leave running, the new one with the other's version actually in production (every
  version of the Worker's latest deployment, read from Cloudflare), and refuses a pair that doesn't match. Before the
  engine, every app version in production must call an API version the new engine serves (an app version from before its
  engine calls none); before the app, the engine in production must serve the one the app calls, and with no engine in
  production the app isn't deployed. So the check holds after a failed or held-back app deploy, several releases later,
  and in a rollback too, and a breaking change ships in steps: an engine that serves the old and new versions, then the
  app, then an engine that drops the old one. A `wrangler rollback` by hand checks nothing: the runbook says to roll
  back with the Deploy workflow. The engine's Durable Object migrations are forward-only: `check-deploy.mjs` refuses
  going back to a release whose engine has other migrations than the latest's, as it does for D1.
- **Images.** The engine's container image is tagged with a hash of its inputs (`inputs-<sha-256>` of the Dockerfile,
  its build variables and the files of the build context it copies), and the release job (`check-deploy.mjs`, which
  already reads the workflow runs, with no credential) finds the last release whose deploy of the app succeeded, from
  the deploy jobs named `Deploy <app> <version>` in the runs of `release.yml` and `deploy.yml`, and computes the tag at
  its commit. The build job builds the image, for linux/amd64 from a context that holds exactly the files the tag
  covers, only when this release's tag differs from that one (or there is none), with a job timeout that allows a full
  build (two hours), and passes it to the production job as an artifact of the same run: no image comes from a cache or
  from another run, which other workflows could write. A deploy by hand always builds it. The production job pushes it,
  without running it, only when the registry lacks that tag, with a registry credential of its own that lasts 240
  minutes and a job timeout of three hours, both outlasting the upload (Wrangler's own credential lasts 15 minutes, too
  short for a large dependency layer), then deploys the engine with the digest that tag resolves to. If the registry
  lacks the tag all the same (an earlier push failed), the production job fails and asks for a deploy by hand, which
  builds the image. So a release that doesn't change the image neither builds nor pushes it, a change to the engine's
  Worker alone keeps the digest, and a rollback finds its image. The account id and the digest come from CI. A changed
  image makes the engine's container snapshots unusable, which the app must handle (Knowledge restores from its own
  backups).

### 10.2 The local stack

`npm run dev` in `.github/hosting/gateway/` runs the gateway and the built apps it is given (`--app <name>`) in one
local `wrangler dev`, with local D1 databases. Each app gets what the deploy gives it (`platformAppBindings` in
`deploy-apps.mjs`): the `SUGER_GATEWAY` binding and the gateway's URLs on `insulinapps.localhost`, an app token derived
as the deploy derives it from a fixed local `GATEWAY_SECRET_KEY` (public, since it only seals local, synthetic data),
so the mail relay, usage reports, limits and member endpoints work locally, and `SUGER_TRUST_ORG_ROLE`. The apps'
limit catalogs go to the gateway's local D1 after its migrations. An app with an engine runs with its stub engine
(`<engine>/src/stub/worker.ts`) beside it as `insulin-apps-<app>-engine`, bound as `SUGER_ENGINE`. The workerd smoke
test (`.github/scripts/workerd-smoke/smoke.mjs --app <app>`) runs one app's production build the same way, with its
stub engine and without a gateway.

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
  past 80% of a limit or heading past it this month, apps whose last report is over two hours old, organizations at
  80% or more of an app's limit (§11.7), owner domains at their organization limit, e-mail domains with ten or more
  new accounts in a day, accounts still unconfirmed after a week, and the day's requests for more organizations; the
  apps' latest reports; the Cloudflare limits.
- **Organizations**, searched by name, id, owner domain or a member's address, filtered by standing, sorted by
  creation, last activity, name or size. Each one: its name and id, standing (with the operators' reason), when and by
  whom it was created (and by which operator, §11.4), when it was last active, its owner domain with how many
  organizations that domain has and may have; its people (name, address, role, when they joined, last active,
  standing); the gateway's own counts (pending invitations, API clients, live AI agents, stored credentials,
  verified domains, single sign-on, SCIM tokens, mail of the last 48 hours); each app's latest report for it and 30 days
  of one of its numbers; its limits in each app that has them (§11.7); and its history in the audit log.
- **People**, searched by name, address or id: name, address (confirmed or not), when they joined, last active,
  standing, and their organizations with their role in each.
- **Apps**: each app's latest report (§8.6), app-wide and summed over organizations, 30 days of its database's size,
  its organizations ranked by any of its numbers, and those that grew most in a day; and its limits (§11.7).
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
**Workers Scripts: Read**, **Account Analytics: Read** and **Containers: Read** only, on the account the platform
deploys to (`SUPER_CLOUDFLARE_ACCOUNT_ID`, which the deploy sets from its own `CLOUDFLARE_ACCOUNT_ID`). It never has a
D1 permission: Cloudflare's D1 query API takes a read-only D1 token, so one would let the console read every app's
database. Nor an R2 one: Workers R2 Storage: Read reads every object in an app engine's buckets (§8.7). So:

- the Worker scripts named `insulin-apps-*`, and from each one's settings the D1 database it binds (named after the
  Worker, as the deploy names it) and, for an engine Worker (`insulin-apps-<app>-engine`), its Durable Object
  namespaces;
- from the GraphQL Analytics API, each Worker's requests, errors and CPU time (median and 99th percentile) for the
  last 24 hours, and its requests and errors since the month began; each database's size, and its rows read and
  written yesterday and this month (D1's analytics count by UTC day, so a whole day is the shortest window);
- when there is an engine Worker: from the Containers API, the account's container applications with the instances
  each has running or starting, an engine's being those of its Durable Object namespaces (or named after it, as
  Wrangler names them); and from the GraphQL Analytics API, as Cloudflare documents the datasets, the container
  applications' vCPU, memory and disk time this month (`containersUsageAdaptiveGroups`), the `insulin-apps-*` R2
  buckets' storage over the last day and their Class A and Class B operations this month (`r2StorageAdaptiveGroups`,
  `r2OperationsAdaptiveGroups`; deleting is free and counts in neither), and the account's Durable Object requests
  this month (`durableObjectsInvocationsAdaptiveGroups`). The page lists each engine Worker with its container
  instances, container time and buckets.

Two figures the plan bills aren't read, because Cloudflare documents no source for them: Durable Objects' duration
(GB-s; the documented fields are requests, CPU time and storage) and Workers AI's neurons (no GraphQL dataset is
documented). They are unknown, never guessed, and the page says so. Nor does any API list container snapshots: their
count comes from the app's usage report (§8.6).

It stores a snapshot (one an hour, the latest try; kept 90 days) even when a part fails, naming the part: figures
that weren't read are unknown, never zero, so they make no meter (a D1 meter needs every database's figure: a total
that leaves one out would understate), and the overview says part of the read failed. The engines' parts are named
`containers`, `r2`, `durable_objects` and `container_usage`. Requests go to `api.cloudflare.com`
only, follow no redirect and time out after 20 seconds; the token is never logged. The console compares the month's
figures with what the Workers Paid plan includes (10 million requests, 25 billion D1 rows read and 50 million written a
month, 5 GB of D1 storage; 1 million Durable Object requests; 375 vCPU-minutes, 25 GiB-hours of memory and 200 GB-hours
of disk for Containers; 10 GB of R2 storage, 1 million Class A and 10 million Class B operations) and the largest
database with D1's hard limit of 10 GB, projects the month at the current
pace (from an hour into the month: before that there's too little to go on), and puts anything past 80%, or heading
past a limit, on the watch list. Requests count the gateway's alone:
every request from outside reaches it first, and its calls to the apps go over service bindings, which Cloudflare
doesn't bill as requests. The allowances are the account's, so the meters assume an account that runs Insulin Apps
alone. The figures are in `gateway/src/super/cloudflare.ts` (`PLAN`); without a token the page says how to add one.
The page also lists everything else the platform uses, from the gateway's configuration: its custom domains, each
app's Worker and binding, the Email Service (with the last 48 hours' messages), the rate limiters, the docs' static
assets and the cron triggers, and each engine Worker the latest snapshot found.

### 11.6 Audit log

`super_audit` records every sign-in to the console and every action: when, the operator's address, what, the
organization, account or app (with its name or address at the time) and the reason. It is kept for good, shown at
`/super/audit` and on each organization's and account's page, and an app's limit changes on its limits page (§11.7).
Reading pages isn't recorded.

### 11.7 App limits

The limits of each app with a catalog (§8.8) are set here, by admins; every operator sees them.

- **An app's limits**, `/super/apps/<app>/limits` (linked from Apps): each limit of the catalog of the version in
  production, with its unit, the catalog's default and the default in force. An admin changes a default (a whole
  number in the limit's unit, a size such as 25 MB or 2 GB for bytes, or unlimited) or puts the catalog's back, with a
  reason (3 to 500 characters). The page lists the app's limit changes from the audit log.
- **An organization's Limits**, a section of its page: for each app with a catalog, the usage from the app's latest
  report beside each limit in force, and the organization's overrides with who set them, when and why. An admin
  overrides a limit (a number or unlimited, an optional last day, a reason) or removes the override. The last day is a
  UTC date: the override ends at the start of the next day, UTC, and the default applies again. A day already past, or
  more than ten years ahead, is refused.
- **Every change** is one batch with its `super_audit` record, written only when it changes something (the same form
  sent twice records nothing more), and stamped with the next number of the limits' sequence, so the app gets it at
  its next tick (§8.8), within five minutes. The server checks the admin list on every change.
- **The watch list** (§11.2) names each organization whose usage in its app's latest report is at 80% or more of a
  limit in force; unlimited limits, and limits the app doesn't report, are left out.
