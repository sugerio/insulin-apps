---
title: How it works
description: The architecture of Insulin Apps: the gateway, the app Workers and their databases, the identity headers and the platform services.
order: 7
---

This page describes how Insulin Apps is built: which address serves what, how a request reaches an app, what the app
learns about the caller, and how sign-in, agents and OAuth clients fit in. It is for technical readers, IT and
security reviewers, people who build apps, and AI agents that need the exact contract. Everything here is open source.

## The big picture

Every address on `insulinapps.com` is served by one Cloudflare Worker, the **gateway**. It signs people in, keeps
accounts, organizations and roles in its own database, and forwards each request for an app to that app's Worker over a
private service binding, with the caller's identity in request headers. Each app is a separate Worker with its own
D1 database, and has no public address of its own: the gateway is the only way in.

```diagram
title: How a request reaches an app
description: People, AI agents, OAuth clients and signers all reach Insulin Apps through one gateway Worker. On insulinapps.com it signs people in and keeps accounts, organizations and roles in its own D1 database; on each app's host it checks the session or token, works out the caller's role and forwards the request with the x-suger-* identity headers over a private service binding to the app's Worker, which has its own D1 database. Signers on an app's public paths reach it with no identity.
size: 740 x 545
box people 20 20 160 60 "People" "web browser"
box agents 200 20 160 60 "AI agents" "MCP clients"
box services 380 20 160 60 "OAuth clients" "programs, API"
box signers 560 20 160 60 dashed "Signers" "no account"
group gateway 20 130 700 230 "Gateway Worker"
box apex 40 170 320 76 accent "insulinapps.com" "sign-in, organizations, roles, docs" "OAuth server, SCIM, mail relay"
box apphosts 380 170 320 76 accent "<app>.insulinapps.com" "checks the session or token, works out" "the role and adds the identity headers"
box gwdb 40 268 150 76 db "Gateway D1" "accounts, roles," "grants, tokens"
box cron 210 268 150 76 muted "Crons" "five-minute tick" "daily cleanup"
group apps 20 400 700 125 "App Workers, private"
box captable 40 442 170 58 "Cap Table" "insulin-apps-captable"
box capdb 222 447 52 48 db "D1"
box esign 300 442 170 58 "Esign" "insulin-apps-esign"
box esdb 482 447 52 48 db "D1"
box more 560 442 140 58 dashed "More apps" "the same shape"
arrow people.b -> apex.t:0.1875 "session cookie" label=0.3
arrow agents.b -> apphosts.t:0.12 "token for /mcp" mid=118 label=0.12
arrow services.b -> apphosts.t:0.42 "token for /api/*" mid=118 label=0.12
arrow signers.b -> apphosts.t:0.8 "public paths" mid=118 label=0.12
arrow apphosts.b -> apps.t:0.743 "service binding, identity headers"
arrow cron.b -> apps.t:0.379 dashed "tick" label=0.75
arrow captable.r -> capdb.l
arrow esign.r -> esdb.l
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
| `insulinapps.com` | Everything that isn't an app: the landing page, these docs (with their search and the docs' MCP server, see [Searching the docs](/docs/platform/searching-the-docs)), privacy and terms; sign-up, sign-in, two-step sign-in, Google and enterprise SSO; your account and organizations; the organization's people, roles, settings, OAuth clients and single sign-on; each app's settings at `/apps/<app>/settings/...` (people, integrations, API access and Connect AI); the OAuth authorization server for AI agents and OAuth clients; SCIM at `/scim/v2`. |
| `<app>.insulinapps.com` | The app itself, plus the gateway's endpoints there: `/mcp` and its OAuth metadata, and `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`, which only redirect to the app's settings on the apex. |
| `www.insulinapps.com` | A permanent redirect to `insulinapps.com`. |
| `auth.insulinapps.com` | A redirect to the same path on `insulinapps.com`, where sign-in used to live, so links in older e-mails keep working. |

An app's settings pages (people, integrations, API access and Connect AI) are served on `insulinapps.com`, never on the
app's own host.
The session cookie also reaches app hosts, so code an app serves could otherwise read those pages (including secrets shown
once) or post their forms as you.

### Paths the gateway keeps on every app host

Apps can't use these paths, because the gateway answers them first:

- `/__insulin/*`: the gateway's stylesheet, icon, account bar, and its sign-out and organization switch (and, on
  `insulinapps.com`, what apps call with their platform token: mail, usage reports, limits and members);
- `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai` (and everything below them);
- `/mcp` and `/.well-known/oauth-*`.

## How a request reaches an app

When your browser opens a page of an app:

1. The gateway removes every incoming `x-suger-*` header and its own cookies from the request, so nobody can pose as
   someone else.
2. If the path is one of the app's [public paths](#public-paths), it forwards the request with no identity (see below).
3. If the request carries a bearer token, it is an AI agent or an OAuth client: see
   [Tokens](#tokens-for-agents-and-programs).
4. Otherwise it checks your session. Signed out, a page navigation is sent to sign in and comes back; anything else gets
   `401`.
5. It finds your active organization and your role in this app. With no organization you are sent to create one; with
   no access to the app you see **You don't have access to** the app.
6. It forwards the request to the app Worker over its service binding, with the identity headers.
7. On an HTML page, it adds the small account bar (organization switch, the app's people, integrations and Connect AI
   pages, your account, sign out). The bar runs under the app's own content security policy, and draws nothing on a
   page that has the navigation of its own (marked `data-insulin-shell`).

## The identity headers

These headers reach the app on every request from a person, an AI agent or an OAuth client:

| Header | Value |
|---|---|
| `x-suger-user-id` | The person's id, or the OAuth client's |
| `x-suger-user-email` | Their e-mail address, URL-encoded. An OAuth client's is `<id>@service-accounts.invalid` |
| `x-suger-user-name` | Their name, URL-encoded |
| `x-suger-organization-id` | The organization the request acts in |
| `x-suger-app-id` | `insulin-apps-<app>` |
| `x-suger-app-role` | `ADMIN`, `EDITOR` or `VIEWER`. For a custom role, the least built-in role that covers its permissions |
| `x-suger-app-permissions` | Apps with a permission catalog only: the effective permissions, space-separated |
| `x-suger-access-via` | `browser`, `mcp` (an AI agent) or `api` (an OAuth client); `public` and `schedule` are described below |
| `x-suger-org-role` | A person's organization role: `OWNER`, `ADMIN`, `EDITOR`, `VIEWER`, or `APPS` for access to specific apps. In a browser and through an AI agent; never for an OAuth client |
| `x-suger-member-lookup` | Browser requests only: the organization, the person and an expiry five minutes ahead, signed for this app. The app passes it back to [look up members](#members-and-member-events) |

User and organization ids are random UUIDs. An app reads these with `getCurrentUser(request)` from `@fours/app/server`.

Apps treat `x-suger-app-permissions` as a narrowing of the role, never a widening: what a caller may do is the role's
permissions that are also in the header. Apps also refuse changes to their own people, roles, billing or integrations
unless `x-suger-access-via` is `browser`.

`x-suger-org-role` is the one header that can give a power rather than take one away: an app may let organization
owners or admins do something no app role allows (Knowledge lets owners see every collection's name and delete one;
Esign lets owners take over what someone owns). An Admin of an app by specific-apps access is `APPS` there, not an
organization admin. So an app honours it only when its deploy says to (`SUGER_TRUST_ORG_ROLE`, which Insulin Apps
sets), treats a missing or unknown value as no organization role, and still checks everything on the server. Like
every `x-suger-*` header, both are removed from what the caller sends, so nobody can claim a role or another person's
lookup.

AI agents and OAuth clients also send a `User-Agent` that names them: `Insulin Apps MCP: <client name>` or
`Insulin Apps API: <OAuth client name>`, for the app's audit trail.

## Sign-in and tokens

There are three kinds of caller, and all of them end up with the same identity headers.

```diagram
title: Three kinds of caller, one set of headers
description: A person signs in on insulinapps.com with a password, Google or single sign-on (and a two-step code if it is on) and gets a session cookie for every app host. An AI agent registers with the OAuth server, sends the person through sign-in and consent, and gets an hour-long token for one app's /mcp, where it acts as that person. An OAuth client, created by an owner or admin of the organization, trades its client id and secret for a token and calls the app's /api/*. The app receives the same identity headers in every case, with x-suger-access-via set to browser, mcp or api.
size: 740 x 490
box person 20 20 220 56 "Person" "web browser"
box agent 260 20 220 56 "AI agent" "MCP client"
box account 500 20 220 56 "OAuth client" "a program"
group auth 10 100 720 118 "insulinapps.com"
box signin 20 134 220 72 accent "Sign-in" "password, Google or SSO," "then a two-step code if on"
box consent 260 134 220 72 accent "Authorize and allow" "register, sign in, choose" "the organization, Allow"
box token 500 134 220 72 accent "Token endpoint" "client id and secret," "client credentials"
group host 10 242 720 104 "App host"
box pages 20 276 220 60 "Any app page" "session cookie"
box mcp 260 276 220 60 "/mcp" "whoami, endpoints," "read, change"
box api 500 276 220 60 "/api/*" "Bearer token"
box app 20 386 700 72 "The app" "the same identity headers for every caller, with" "x-suger-access-via set to browser, mcp or api"
arrow person.b -> signin.t
arrow agent.b -> consent.t "PKCE" label=0.35
arrow account.b -> token.t "id, secret" label=0.35
arrow signin.b -> pages.t "cookie" label=0.4
arrow consent.b -> mcp.t "token, 1 h" label=0.4
arrow token.b -> api.t "token, 1 h" label=0.4
arrow pages.b -> app.t:0.157 "browser"
arrow mcp.b -> app.t:0.5 "mcp"
arrow api.b -> app.t:0.843 "api"
text 370 478 small muted "Every request checks the person's or the account's current role in that app again."
```

- **People** sign in at `insulinapps.com` with a password, Google or their company's SSO, plus two-step sign-in if they
  turned it on. The session cookie works on every app host. See [Sign-in and security](/docs/platform/sign-in-and-security).
- **AI agents** (MCP clients) register with the authorization server on `insulinapps.com`, send the person through
  sign-in and consent, and get tokens for one app's `/mcp`. They act as that person. See
  [AI agents](/docs/platform/ai-agents).
- **OAuth clients** (once called service accounts) get a token with their client id and secret (`client_credentials`)
  and call one app's `/api/*`. They act with the role the organization's owners or admins gave them on the app's **API
  access** page. See [API access with OAuth clients](/docs/platform/api-and-service-accounts).

### Tokens for agents and programs

- Each app is its own OAuth protected resource: `https://<app>.insulinapps.com/mcp` for agents and
  `https://<app>.insulinapps.com` for OAuth clients. `insulinapps.com` is the one authorization server for all of them.
- Tokens are 32 random bytes; only their SHA-256 is stored. Access tokens last an hour.
- Every call re-checks the grant or the OAuth client and the caller's current role, so a removed or demoted person's
  agent loses access or power at once.
- Tokens reach only the app's own API, `/api/*` (minus the platform's `/api/__suger/*`). They never reach the gateway's
  pages, so people, roles, integrations, API access and single sign-on stay browser-only by construction.
- A person's token works only on `/mcp`; an OAuth client's only on `/api/*`.

## Public paths

Some apps serve people who have no account, such as a recipient signing a document in Esign. An app declares those
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

## Usage reports

Insulin Apps watches its own usage, to keep the service fair and to add capacity before it runs out, without reading
any app's data. Each app reports a few numbers instead, once an hour, from its scheduled work: `POST
https://insulinapps.com/__insulin/metrics` with its platform token, holding gauges for the app as a whole (its
database's size) and for each organization (how many records of each kind, how many bytes of files):

```json
{ "hour": "2026-01-01T10:00:00Z",
  "app": { "database_bytes": 123456, "organizations": 3 },
  "organizations": [ { "id": "<organization id>", "metrics": { "envelopes": 12, "storage_bytes": 2048 } } ] }
```

Counts and sizes only: never a name, an address, an amount or a document. At most 20 numbers per organization and 500
organizations a request; a report sent twice changes nothing. Each app's own docs list what it sends.

## Limits

An app with real running costs may limit how much each organization uses. It lists its limits in its `package.json`
(`insulin.limits`: a key, a label, a unit of `count`, `bytes`, `hours` or `days`, and a default), the deploy writes
that list to the gateway's database, and Insulin Apps staff set the limits in the [operator console](#the-operator-console):
a default for everyone, or an override for one organization (a number or unlimited, with an optional last day).

The app reads them on its scheduled work with its platform token: `GET https://insulinapps.com/__insulin/limits?since=<cursor>`
answers

```json
{ "defaults": { "questions_month": 5000, "storage_bytes": null },
  "organizations": [ { "id": "<organization id>", "limits": { "questions_month": { "value": 9000, "until": "2026-12-01T00:00:00.000Z" } } } ],
  "cursor": "42", "more": false }
```

- `defaults` holds every limit's default in force; `null` means unlimited.
- `organizations` lists those whose overrides changed after the cursor (without `since`, every organization with an
  override), each with all its current overrides, so `{}` means it has none any more. After `until` the default applies
  again.
- At most 500 organizations a page, oldest change first. The app saves `cursor` after each page and asks again while
  `more` is true. A change applies within five minutes.
- Only organizations where the app is used are listed. Without the platform's key the endpoint answers `503`, and the
  app keeps what it stored, or its own defaults.

The app enforces them. Past one, API and MCP callers get `429` with `{ "error": "quota_exceeded", "limit", "resets_at",
"message" }`, and an AI assistant gets that message as a failed tool call, so it can tell the person. The app reports its
usage under the same keys, so the console shows usage beside each limit.

## Members and member events

Apps that let people share their own records (Knowledge's collections, Esign's templates and envelopes) need to know
who is in the organization: an app has no directory of its own. Three endpoints, called by the app with its platform token over the gateway's service binding, answer only about
organizations where the app is used:

- **Member lookup**, `GET https://insulinapps.com/__insulin/members?q=<text>` with the `x-suger-member-lookup` header of
  the browser request the app is serving: at most 20 people who can use the app (id, name, e-mail address and role in
  the app) and the app's OAuth clients (id and name) whose name or address contains the text. The organization and the
  person come from the signed header, never from the app, and the person must still be able to use the app. It fills a
  sharing dialog (or checks the people someone typed, as Esign does for an OAuth client's people), and is limited per
  person. Requests from AI agents and OAuth clients carry no header, so there an app uses the people it has seen.
- **Member status**, `POST https://insulinapps.com/__insulin/members/status` with `{ "org", "ids" }` (at most 100):
  for each person or OAuth client, whether it can still use the app (`member`, with its roles), has left (`left`, or
  `revoked` for an OAuth client) or no longer exists (`gone`), and the organization's owners and since when; `404
  org_deleted` for a deleted organization. No names or addresses. A suspended account or organization still counts as a
  member: suspension isn't a departure. But each member's `standing` (`active`, `suspended` or `disabled`) and the
  organization's are given, so an app acting for someone later can hold back: Esign sends a scheduled envelope only
  while whoever scheduled it may still send, with an active account in an active organization.
- **Member events**, `GET https://insulinapps.com/__insulin/member-events?since=<cursor>`: what changed, oldest first, at
  most 1,000 a page with `cursor` and `more`. `left` (removed from the organization or the app, or the account deleted),
  `returned` (joined or given the app), `role_changed` (with the new app and organization roles), `owners` (the owners
  and since when), `client_revoked` (an OAuth client revoked, deleted, or revoked with its organization disabled) and
  `org_deleted`. Each event is written in the same database transaction as the change, whichever way it was made: the
  people pages, invitations, single sign-on, SCIM, removing a domain, deleting an account, the operator console. Without
  `since` it returns the current cursor and no events. Events are kept 90 days; an older cursor gets `410
  cursor_expired`, and the app checks everyone it holds with member status before reading events again.

## The operator console

A few Insulin Apps staff use an operator console at `insulinapps.com/super`, separate from everything customers use.
They sign in through Insulin Apps' own company Google account, and only members of one group get in; everything they
do is recorded with the reason they give.

- **What they see:** each organization's name, when it was created and last active, its owner domain, its members
  (name, e-mail address, role, when they joined and were last active, to within an hour) and counts such as pending
  invitations and connected AI agents; each app's usage reports; and the Cloudflare resources the platform runs on.
- **What they never see:** what anyone enters in an app (the console has no way into an app's database), passwords,
  tokens, stored credentials or what any e-mail said.
- **What they can do:** suspend an organization or account that breaks the terms (access paused, everything kept),
  disable it (access ended, with an account's sessions and AI agents, or an organization's AI agents, API clients,
  invitations and SCIM tokens), lift either, create an organization for someone whose e-mail domain has used its
  two, and set apps' [limits](#limits): a default for every organization, or an override for one, each with a reason.
  An organization at 80% or more of a limit, by its app's latest usage report, shows on their watch list.
- **What suspension does:** a suspended or disabled account can't sign in and is signed out everywhere. Nobody can use a
  suspended or disabled organization in any way: apps, settings, AI agents, API clients, single sign-on and SCIM all
  stop, and its members' home page says so. Data is kept.

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
  OAuth clients (hashed secrets), stored credentials (encrypted), single sign-on settings, a short mail log, when each
  account and organization was last active, the apps' usage reports and limits, which apps each organization uses, 90
  days of member events, and the operator console's audit log.
- Each app's database holds what you enter in that app, for every organization, each organization's rows marked with its
  id.
- Nothing is reset. Data stays until you delete it. Deleting an organization removes it from sign-in, and each app it
  used is told (`org_deleted`): an app may then delete the organization's data, as Knowledge does; data an app keeps can't
  be reached again, because the organization's id is never issued again.
