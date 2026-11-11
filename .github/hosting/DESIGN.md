# Accounts, roles and access on insulinapps.com

This is the design of everything the hosting gateway (`.github/hosting/gateway/`) decides about people and machines:
who may sign in and how, which organization they act in, what role they have in each app, and how AI agents and API
clients reach the apps. The apps only receive the result, as request headers. The operator runbook is
[README.md](README.md); the gateway's code map is [gateway/README.md](gateway/README.md); the rules every app follows
are in the repository's [AGENTS.md](../../AGENTS.md).

## 1. Hosts

| Host | Serves |
|---|---|
| `insulinapps.com` | The single entry for everything that is not an app: landing, privacy and terms; the public docs at `/docs/` (generated from `.github/hosting/docs/` and each app's `docs/public/`, with `/docs/llms.txt` for AI agents and the images at `/docs/assets/*` from the static-assets binding); sign-up, sign-in, MFA, Google and enterprise SSO; account and organizations; `/settings/users` and `/settings/roles` (the organization's people and roles); `/settings/organization` (name, who can be invited, leave, delete); `/settings/sso` (SAML or OIDC and SCIM); each app's settings: people, integrations, API access and Connect AI at `/apps/<app>/settings/users`, `/integrations`, `/api` and `/connect-ai`; the OAuth authorization server for MCP clients and OAuth clients (service accounts); SCIM. |
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
  owner's, and rewrote Gmail owner domains (and allowances) to the form above. An organization with neither counts for
  nobody. Organizations
  recorded under a provider added to the list since `0007` (as a domain such as `web.de`) count for nobody either. The
  old per-account count (`users.orgs_created`) is kept as a record and limits nothing.
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
  on or off) deletes all of them, so an agent connected by someone who took over the account doesn't outlive its
  recovery.
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

**Connect AI.** Every app has a Connect AI page, `insulinapps.com/apps/<app>/settings/connect-ai` (a tab of the app's
settings, and a link in the account bar on the app's host; `<app>.insulinapps.com/settings/connect-ai` leads there),
which everyone who can use the app opens: Viewers and specific-apps members included.

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
(`check-insulin-app.mjs` refuses a build that declares one). What an app needs beyond that, the gateway provides,
declared in the app's `package.json` under `insulin`:

```json
"insulin": {
  "permissions": [ … ],
  "publicPaths": ["/sign", "/api/public/", "/assets/"],
  "scheduled": "/api/scheduled",
  "secrets": ["ESIGN_KMS_KEY_ARN", "ESIGN_OTP_KEY"]
}
```

The deploy reads these with `list-apps.mjs` and refuses a malformed list; the gateway checks `publicPaths` and
`scheduled` again and fails closed.

### 8.1 Public paths

Some apps serve people who have no account and never will, such as an e-sign recipient who signs on a page that a
host product frames. Such paths are listed in `insulin.publicPaths`, at most ten. A request path matches an entry if
it equals the entry, starts with it when the entry ends in `/`, or starts with `entry/` when it doesn't. A path whose
segments hide a dot segment or a slash in their encoding never matches. An entry may not be `/`, `/api` or `/api/`,
and may not be or cover anything under `/__insulin`, `/settings`, `/mcp`, `/.well-known` or `/api/__suger`, in any
case.

On a public path the gateway looks at no session and no token, and the app gets `x-suger-app-id` and
`x-suger-access-via: public` only: no person, organization, role or permissions, even when a signed-in person or a
token sent the request. Incoming `x-suger-*` headers, the gateway's cookies and `Authorization` are removed as always.
HTML gets no account bar, the app's own headers (its CSP and `frame-ancestors`) are kept, and requests are limited per
IP address (`RL_APP`). A request that isn't GET or HEAD (an e-sign code exchange, a code sent or checked) also counts
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
  `SUGER_APP_TOKEN`, when `GATEWAY_SECRET_KEY` is set.

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
  timeout, doing a bounded amount per tick. An app can keep a route of its own (E-sign's `POST /api/process-due`) for
  someone to finish their organization's due work at once.
- **The daily cleanup** keeps its own cron, `17 3 * * *`: the gateway's retention cleanup runs on it and the tick
  doesn't.

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

## 10. Configuration added

| Name | Kind | Notes |
|---|---|---|
| `GATEWAY_SECRET_KEY` | secret | 32 random bytes, base64. Encrypts TOTP secrets, stored credentials and OIDC client secrets; derives the apps' `SUGER_APP_TOKEN`. Without it MFA, stored credentials and OIDC can't be set up (the rest works) |
| `SITE_APPS[].permissions`, `SITE_APPS[].publicPaths`, `SITE_APPS[].scheduled` | var | From each app's `package.json` (§2.3, §8.1, §8.5) |
| `RL_PUBLIC` | ratelimit | Requests to public paths that aren't GET or HEAD, per app and IP; 60 a minute suggested (§8.1) |
| `ORG_REQUEST_EMAIL` | var | Optional: Insulin Apps support's address for requests for more organizations (§3.1). A GitHub variable, never written in the repository |
| Cron triggers | trigger | `*/5 * * * *` (the apps' tick, §8.5) and `17 3 * * *` (the daily cleanup) |
| App secrets | GitHub environment | Each app's `insulin.secrets`, by name (§8.3) |
| `nodejs_compat` | flag | For SAML's XML signature library |

Changing the domain of sign-in means registering `https://insulinapps.com/auth/google/callback` with Google (the
runbook says so); the old `auth.` callback redirects there but Google checks the exact URI it was given.
