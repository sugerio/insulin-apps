---
title: How it works
description: The architecture of Insulin Apps: the gateway, the app Workers and their databases, the identity headers and the platform services.
order: 7
---

This page describes how Insulin Apps is built: which address serves what, how a request reaches an app, what the app
learns about the caller, and how sign-in, agents and service accounts fit in. It is for technical readers, IT and
security reviewers, people who build apps, and AI agents that need the exact contract. Everything here is open source.

## The big picture

Every address on `insulinapps.com` is served by one Cloudflare Worker, the **gateway**. It signs people in, keeps
accounts, organizations and roles in its own database, and forwards each request for an app to that app's Worker over a
private service binding, with the caller's identity in request headers. Each app is a separate Worker with its own
D1 database, and has no public address of its own: the gateway is the only way in.

```diagram
todo: platform-overview
```

- **One sign-in for every app.** Sessions, passwords, Google, two-step sign-in, single sign-on, SCIM and OAuth all live
  in the gateway. Apps never see a password or a session cookie.
- **Apps receive the result.** An app reads who is calling, in which organization and with which role, from headers the
  gateway sets. It decides what that role may do with its own data.
- **One deployment, many organizations.** Every organization shares the same app Worker and database; the app scopes
  every query by the organization id it receives, so one organization never reads another's data.

## Hosts

| Host | Serves |
|---|---|
| `insulinapps.com` | Everything that isn't an app: the landing page, these docs, privacy and terms; sign-up, sign-in, two-step sign-in, Google and enterprise SSO; your account and organizations; the organization's people, roles, settings and single sign-on; each app's people and integrations at `/apps/<app>/settings/...`; the OAuth authorization server for AI agents and service accounts; SCIM at `/scim/v2`. |
| `<app>.insulinapps.com` | The app itself, plus the gateway's endpoints there: `/mcp` and its OAuth metadata, and `/settings/users` and `/settings/integrations`, which only redirect to the app's settings on the apex. |
| `www.insulinapps.com` | A permanent redirect to `insulinapps.com`. |
| `auth.insulinapps.com` | A redirect to the same path on `insulinapps.com`, where sign-in used to live, so links in older e-mails keep working. |

The settings pages for an app's people and integrations are served on `insulinapps.com`, never on the app's own host.
The session cookie also reaches app hosts, so code an app serves could otherwise read those pages (including secrets shown
once) or post their forms as you.

### Paths the gateway keeps on every app host

Apps can't use these paths, because the gateway answers them first:

- `/__insulin/*`: the gateway's stylesheet, icon, account bar, and its sign-out and organization switch;
- `/settings/users` and `/settings/integrations` (and everything below them);
- `/mcp` and `/.well-known/oauth-*`.

## How a request reaches an app

When your browser opens a page of an app:

1. The gateway removes every incoming `x-suger-*` header and its own cookies from the request, so nobody can pose as
   someone else.
2. If the path is one of the app's [public paths](#public-paths), it forwards the request with no identity (see below).
3. If the request carries a bearer token, it is an AI agent or a service account: see
   [Tokens](#tokens-for-agents-and-programs).
4. Otherwise it checks your session. Signed out, a page navigation is sent to sign in and comes back; anything else gets
   `401`.
5. It finds your active organization and your role in this app. With no organization you are sent to create one; with
   no access to the app you see **You don't have access to** the app.
6. It forwards the request to the app Worker over its service binding, with the identity headers.
7. On an HTML page, it adds the small account bar (organization switch, the app's people and integrations, your account,
   sign out). The bar runs under the app's own content security policy.

## The identity headers

These headers reach the app on every request from a person, an AI agent or a service account:

| Header | Value |
|---|---|
| `x-suger-user-id` | The person's id, or the service account's |
| `x-suger-user-email` | Their e-mail address, URL-encoded. A service account's is `<id>@service-accounts.invalid` |
| `x-suger-user-name` | Their name, URL-encoded |
| `x-suger-organization-id` | The organization the request acts in |
| `x-suger-app-id` | `insulin-apps-<app>` |
| `x-suger-app-role` | `ADMIN`, `EDITOR` or `VIEWER`. For a custom role, the least built-in role that covers its permissions |
| `x-suger-app-permissions` | Apps with a permission catalog only: the effective permissions, space-separated |
| `x-suger-access-via` | `browser`, `mcp` (an AI agent) or `api` (a service account); `public` and `schedule` are described below |

User and organization ids are random UUIDs. An app reads these with `getCurrentUser(request)` from `@fours/app/server`.

Apps treat `x-suger-app-permissions` as a narrowing of the role, never a widening: what a caller may do is the role's
permissions that are also in the header. Apps also refuse changes to their own people, roles, billing or integrations
unless `x-suger-access-via` is `browser`.

AI agents and service accounts also send a `User-Agent` that names them: `Insulin Apps MCP: <client name>` or
`Insulin Apps API: <service account name>`, for the app's audit trail.

## Sign-in and tokens

There are three kinds of caller, and all of them end up with the same identity headers.

```diagram
todo: sign-in-and-oauth
```

- **People** sign in at `insulinapps.com` with a password, Google or their company's SSO, plus two-step sign-in if they
  turned it on. The session cookie works on every app host. See [Sign-in and security](/docs/platform/sign-in-and-security).
- **AI agents** (MCP clients) register with the authorization server on `insulinapps.com`, send the person through
  sign-in and consent, and get tokens for one app's `/mcp`. They act as that person. See
  [AI agents](/docs/platform/ai-agents).
- **Service accounts** get a token with their client id and secret (`client_credentials`) and call one app's `/api/*`.
  They act with the role an app admin gave them. See [The API and service accounts](/docs/platform/api-and-service-accounts).

### Tokens for agents and programs

- Each app is its own OAuth protected resource: `https://<app>.insulinapps.com/mcp` for agents and
  `https://<app>.insulinapps.com` for service accounts. `insulinapps.com` is the one authorization server for all of them.
- Tokens are 32 random bytes; only their SHA-256 is stored. Access tokens last an hour.
- Every call re-checks the grant or the service account and the caller's current role, so a removed or demoted person's
  agent loses access or power at once.
- Tokens reach only the app's own API, `/api/*` (minus the platform's `/api/__suger/*`). They never reach the gateway's
  pages, so people, roles, integrations and single sign-on stay browser-only by construction.
- A person's token works only on `/mcp`; a service account's only on `/api/*`.

## Public paths

Some apps serve people who have no account, such as a recipient signing a document in E-sign. An app declares those
paths (`insulin.publicPaths` in its `package.json`, at most ten). On a public path the gateway:

- looks at no session and no token, and forwards only `x-suger-app-id` and `x-suger-access-via: public`, even when a
  signed-in person sent the request;
- removes incoming `x-suger-*` headers, the gateway's cookies and `Authorization`;
- keeps the app's own headers (its content security policy and framing rules) and adds no account bar;
- limits requests per IP address, and requests that aren't `GET` or `HEAD` more strictly per app and IP address (they get
  `429` with `Retry-After: 60` past the limit).

The app authenticates these visitors itself with its own short-lived codes, and they reach only what those codes are for.
Paths under `/__insulin`, `/settings`, `/mcp`, `/.well-known` and `/api/__suger` can never be public, and the gateway's
own paths always win.

## Scheduled work

Apps have no cron triggers. An app that has due work declares one path (`insulin.scheduled`, under `/api/`), and every
five minutes the gateway `POST`s to it over the app's service binding:

- with `x-suger-app-id` and `x-suger-access-via: schedule` only: no person, organization or role;
- with an empty body and a 25-second timeout, every app at once, so a slow app never holds up another.

Since every incoming `x-suger-*` header is removed and app Workers have no public route, a request marked `schedule` can
only be the gateway's own. The app still refuses the path otherwise, does every organization's due work there (safe to
repeat), and keeps it out of its API catalog. A separate daily job cleans up the gateway's expired sessions, links and
mail records.

## Mail relay

Apps have no e-mail of their own. An app sends one message per request to `POST https://insulinapps.com/__insulin/mail`
with its platform token and the organization it serves:

```json
{ "to": "ana@example.com", "subject": "Your signing code", "text": "…", "html": "optional", "replyTo": "optional" }
```

It is sent from the platform's address, named "*app title* via Insulin Apps". Apps' mail has its own allowance, separate
from sign-in mail so it can never crowd that out: ten messages an hour per recipient across all apps, 500 a day per
organization and app, and 5,000 a day per app. The relay answers `202 { "status": "sent" }`, or an error such as
`429 rate_limited`. Logs carry the app, the organization and the kind of message, never an address or the text.

## Integrations and secrets

- **Stored credentials** for outside services are kept encrypted by the gateway and added to the app's requests through
  the integration proxy, so the app never holds them. See [Integrations](/docs/platform/integrations).
- **App secrets** are declared by name in the app's `package.json` and set by the operator; each app's deploy gets only
  its own.

## Security in brief

- **One way in.** App Workers have no public address; every request passes the gateway's checks.
- **Pages without scripts.** The gateway's pages, these docs included, are rendered on the server and run no JavaScript
  (the bot check on sign-in forms is the one exception, from Cloudflare). The content security policy allows no inline
  script or style.
- **Forms come from the site itself.** Every form post to `insulinapps.com` must come from its own origin.
- **Secrets are hashed or sealed.** Passwords are salted PBKDF2 hashes; session ids, tokens, client secrets and SCIM
  tokens are stored as SHA-256 hashes; authenticator secrets, stored credentials and OIDC client secrets are encrypted
  with AES-256-GCM.
- **Changes re-check the actor.** Every change to people, roles or settings checks the actor's current role inside the
  same database statement, so someone demoted or removed meanwhile changes nothing.
- **Logs carry ids and event names**, never passwords, tokens, cookies, e-mail addresses or error messages.
- **Open source.** The gateway and every app are public under the MIT License.

## Data

- The gateway's database holds accounts, sessions, organizations, memberships, roles, invitations, AI agent grants,
  service accounts, stored credentials (encrypted), single sign-on settings and a short mail log.
- Each app's database holds what you enter in that app, for every organization, each organization's rows marked with its
  id.
- Nothing is reset. Data stays until you delete it. Deleting an organization removes it from sign-in; the apps keep its
  data, but nobody can reach it again, because its id is never issued again.
