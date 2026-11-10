# Accounts, roles and access on insulinapps.com

This is the design of everything the hosting gateway (`.github/hosting/gateway/`) decides about people and machines:
who may sign in and how, which organization they act in, what role they have in each app, and how AI agents and API
clients reach the apps. The apps only receive the result, as request headers. The operator runbook is
[README.md](README.md); the gateway's code map is [gateway/README.md](gateway/README.md); the rules every app follows
are in the repository's [AGENTS.md](../../AGENTS.md).

## 1. Hosts

| Host | Serves |
|---|---|
| `insulinapps.com` | The single entry for everything that is not an app: landing, privacy and terms; sign-up, sign-in, MFA, Google and enterprise SSO; account and organizations; `/settings/users` and `/settings/roles` (the organization's people and roles); `/settings/sso` (SAML or OIDC and SCIM); the OAuth authorization server for MCP clients and service accounts; SCIM. |
| `auth.insulinapps.com` | A 308 redirect to the same path on the apex, so links in e-mails already sent keep working. |
| `www.insulinapps.com` | A 301 redirect to the apex. |
| `<app>.insulinapps.com` | The app, plus the gateway's own pages and endpoints on that host: `/settings/users` (the app's people), `/settings/integrations` (service accounts and stored credentials), `/mcp` and its OAuth metadata. Everything else goes to the app Worker. |

Paths the gateway keeps on every app host, so apps must not use them: `/__insulin/*`, `/settings/users`,
`/settings/integrations` (and everything below both), `/mcp`, and `/.well-known/oauth-*`.

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
makes someone an app admin: people and integrations are the platform's, not an app permission.

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
| `x-suger-access-via` | `browser`, `mcp` or `api` |

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
- `<app>.insulinapps.com/settings/users` lists everyone who can use the app in the active organization: people whose
  access comes from their organization role (marked *from organization role*, not editable here) and people with access
  to this app. App admins invite people to this app (Admin, Editor, Viewer or one of the app's custom roles), change
  their role in this app and remove them from it. Removing someone's last app removes them from the organization.
  Inviting someone who already has specific-apps access adds the app at once; inviting a member with an organization
  role is refused (they already have access).
- `<app>.insulinapps.com/settings/integrations`: §6.

Every change re-checks the actor's role inside the same SQL statement as the change, so a member who was demoted or
removed meanwhile changes nothing (the gateway's existing rule, extended to app grants and custom roles).

## 4. What tokens may reach

Browser sessions reach everything their role allows. Bearer tokens (MCP and service accounts) reach only the app's own
API: `/api/*` on the app host, minus the platform's `/api/__suger/*`. They never reach the gateway's pages, so these
stay browser-only and owner/admin-only by construction:

- users, roles, custom roles and invitations (organization and app);
- integrations: service accounts and stored credentials;
- SSO, SCIM tokens, organization rename and delete;
- billing, when there is any.

Apps keep the same rule for anything of that kind they implement themselves, using `x-suger-access-via`.

## 5. Sign-in and tokens

### 5.1 People

- **E-mail and password**, with the existing confirmation, reset, Turnstile, rate limits and credential versions.
- **Google** (the platform's OAuth client), callback `https://insulinapps.com/auth/google/callback`.
- **MFA with an authenticator app (TOTP).** Turned on under Account → Security with a QR code and a code from the app;
  ten single-use recovery codes are shown once. While it is on, every password or Google sign-in asks for a code (or a
  recovery code) before a session exists. Codes are RFC 6238, SHA-1, 6 digits, 30 seconds, ±1 step, and a used step is
  never accepted twice. The secret is stored encrypted (AES-256-GCM with `GATEWAY_SECRET_KEY`).
- **Enterprise SSO** (§7): SAML 2.0 or OpenID Connect for an organization's verified e-mail domains; the identity
  provider is responsible for MFA there.

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
  (`x-suger-access-via: mcp`).
- **Tools:** `whoami` (person, organization, app, role, permissions), `endpoints` (the app's `GET /api/catalog`, if it
  has one), `read` (GET) and `change` (POST, PUT, PATCH, DELETE) on `/api/*` paths, forwarded to the app as that person,
  with an optional `Idempotency-Key`. Responses larger than 200 KB are cut.
- People see and disconnect their own agents under Account → AI agents.

### 5.3 Service accounts (API access)

App admins create service accounts under `<app>.insulinapps.com/settings/integrations`, each with a role in that app
(Admin, Editor, Viewer or a custom role). The client secret is shown once and can be rotated. A program gets a token
with `client_credentials` at `https://insulinapps.com/oauth/token` (HTTP Basic, optional `resource=https://<app host>`)
and calls `https://<app host>/api/...` with it. The app receives the service account's id, the name, and the address
`<id>@service-accounts.invalid` (a reserved domain nobody can own), with `x-suger-access-via: api`.

## 6. Integrations

`<app>.insulinapps.com/settings/integrations` has two parts; app admins create, edit and delete, everyone else who can
use the app sees names, kinds, hosts and status, never a secret, and tokens never reach them (§4).

- **Service accounts** (§5.3).
- **Stored credentials** for outside services the app calls through `integrationFetch(key)` of `@fours/app`: a key, a
  name, the base URL, the allowed hosts, and how to send the secret (a bearer token, a named header, or basic auth). The
  secret is encrypted with `GATEWAY_SECRET_KEY` and never shown again. The gateway's proxy,
  `https://insulinapps.com/__insulin/integrations/<key>/proxy/<host>/<path>`, accepts the app's token
  (`SUGER_APP_TOKEN`, an HMAC of the app's name with `GATEWAY_SECRET_KEY`, which the deploy gives each app Worker)
  and the organization in `x-suger-organization-id`, which the app sets from `getCurrentUser()` on the request it is
  serving. It sends the request on only to an allowed `https` host, with the credential added and every `x-suger-*`,
  cookie and authorization header removed, and never follows redirects.

## 7. Enterprise SSO and SCIM

An organization's owners set this up under `insulinapps.com/settings/sso`.

- **Domains.** An owner claims an e-mail domain and proves it with a DNS TXT record (`_insulin-apps.<domain>`, value
  `insulin-apps-verification=<token>`), checked over DNS-over-HTTPS. One organization at a time can hold a verified
  domain.
- **Connection.** One per organization, SAML 2.0 or OpenID Connect, with a default role for people it adds (Editor or
  Viewer) and an option to require SSO for the verified domains (password and Google sign-in are then refused for
  those addresses).
  - SAML: SP-initiated, HTTP-Redirect AuthnRequest, HTTP-POST response to
    `/sso/saml/<connection>/acs`; the response or assertion must be signed with the identity provider's certificate
    (RSA-SHA256), and `InResponseTo`, `Destination`, audience, recipient and validity window are checked. SP metadata at
    `/sso/saml/<connection>/metadata`.
  - OIDC: authorization code with PKCE and a nonce, client secret encrypted at rest; the ID token comes straight from the
    token endpoint over TLS, and its issuer, audience, expiry, nonce and `email_verified` are checked.
- **Sign-in.** "Sign in with SSO" asks for the work e-mail, finds the verified domain and starts the connection. The
  address must be in one of the organization's verified domains. An unknown address gets an account (confirmed, no
  password); someone who isn't a member joins with the default role.
- **SCIM 2.0** at `https://insulinapps.com/scim/v2` with a bearer token the owner creates (shown once): `Users`
  (list with `userName eq`, create, read, replace, patch, delete), `ServiceProviderConfig`, `ResourceTypes`, `Schemas`.
  Only addresses in verified domains. Creating adds the person with the default role; `active: false` or delete removes
  them from the organization (never its last owner). Roles stay managed on `/settings/users`.

## 8. Data

All in the gateway's D1 database; migrations are forward-only.

| Migration | Tables |
|---|---|
| `0003_roles` | `memberships` and `invitations` rebuilt with the role `APPS` (specific apps) and without `USER`; `app_grants`, `invitation_grants`, `custom_roles`, with the triggers of §2.2 |
| `0004_oauth` | `oauth_clients`, `oauth_requests`, `oauth_grants`, `oauth_codes`, `oauth_tokens`, `service_accounts`, `integrations` |
| `0005_mfa` | TOTP columns on `users`, `mfa_recovery_codes`, `mfa_challenges` |
| `0006_sso` | `sso_domains`, `sso_connections`, `sso_requests`, `scim_tokens` |

## 9. Configuration added

| Name | Kind | Notes |
|---|---|---|
| `GATEWAY_SECRET_KEY` | secret | 32 random bytes, base64. Encrypts TOTP secrets, stored credentials and OIDC client secrets; derives the apps' `SUGER_APP_TOKEN`. Without it MFA, stored credentials and OIDC can't be set up (the rest works) |
| `SITE_APPS[].permissions` | var | From each app's `package.json` (§2.3) |
| `nodejs_compat` | flag | For SAML's XML signature library |

Changing the domain of sign-in means registering `https://insulinapps.com/auth/google/callback` with Google (the
runbook says so); the old `auth.` callback redirects there but Google checks the exact URI it was given.
