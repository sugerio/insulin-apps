---
title: API access with OAuth clients
description: Create an OAuth client on an app's API access tab, get a client-credentials token, rotate its secret without downtime, and call the app's API, starting with GET /api/catalog.
order: 5
---

This page explains how your own software calls an Insulin app's API: create an OAuth client on the app's **API access**
tab, get a token, and call the app's `/api/*` endpoints. It is for developers connecting another system (a script, a
back office, a product that embeds an app) and for the organization's owners and admins who create the clients. To let
an AI agent act as you instead, see [AI agents](/docs/platform/ai-agents).

## What an OAuth client is

An OAuth client is a program's identity in one app, in one organization. (Insulin Apps used to call it a service
account, and the app still sees it as one.) It has a role in that app like a person: **Admin**, **Editor**, **Viewer**
or one of the app's custom roles. It signs in with a client id and a client secret (OAuth 2.0 client credentials), gets
a token that lasts an hour, and calls the app's API with it. The app treats its requests exactly like a person's with
the same role.

An OAuth client reaches only the app's own API, under `/api/`. It can never reach people, roles, integrations, single
sign-on or anything else on `insulinapps.com`.

## The API access tab

Each app's OAuth clients are on its **API access** tab: `https://insulinapps.com/apps/<app>/settings/api`, for example
`https://insulinapps.com/apps/captable/settings/api`. The app's own `https://<app>.insulinapps.com/settings/api` leads
there, and the tab sits next to **People**, **Integrations** and **Connect AI** in the app's settings.

| Who | What they can do |
|---|---|
| The organization's **owners** and **admins** | Create, rename, change the role of, rotate and delete OAuth clients |
| Everyone else who can use the app, including an app's admins through access to specific apps | See the list: each client's name, client id, role, when it was created, last used and last rotated. Never a secret. |
| AI agents and OAuth clients themselves | Nothing: tokens never reach this page |

Only the organization's owners and admins manage OAuth clients, because a client's secret outlives the person who made
it: it belongs to the organization. Everyone else sees the list with the note "Only the owners and admins of …
create, change, rotate and delete OAuth clients."

The tab also shows how a program gets a token: the **Token URL** (`https://insulinapps.com/oauth/token`), the grant type,
the app's **Resource**, and a curl example with placeholders for the client id and secret.

![The API access tab of Cap Table with an OAuth client listed, one whose secret was just rotated, the form for a new client and the token URL with a curl example](/docs/assets/screenshots/platform-api-access.png "An app's API access tab")

## Create an OAuth client

1. Open the app's **API access** tab.
2. Under **New OAuth client**, enter a **Name**, such as "Payroll sync". The app sees this name in its audit trail.
3. Choose its **Role** in the app. Give the least it needs; **Viewer** is the default.
4. Choose **Create**.
5. Copy the **Client id** and the **Client secret** now. The secret isn't shown again. The same box shows a curl example
   with the new client id filled in.

Client ids start with `ia_sa_` and secrets with `ia_sk_`, so a leaked one is easy to recognise in a log or a repository.
Insulin Apps stores only a hash of the secret.

### Rename it or change its role

Open **Edit** under the client's name, change the **Name** or the **Role**, and choose **Save**. A new role applies to
the client's next request.

### Rotate the secret without downtime

**Rotate secret** makes a new secret and shows it once. The previous secret keeps working for **24 hours**, so a running
program can switch to the new one without stopping:

- until then, the token endpoint accepts either secret, and the list shows **The previous secret works until** a date and
  time (in UTC);
- tokens already issued keep working until they expire, within the hour;
- **Revoke previous secret now** ends the previous secret at once, and the tokens it issued with it, once your program
  uses the new one;
- rotating again while a previous secret still works replaces it: at most two secrets work at a time, and the one pushed
  out stops at once, with its tokens.

After 24 hours the previous secret simply stops issuing tokens, and those it issued run out within the hour.

### Delete it

**Delete** removes the client at once: both its secrets and every token it holds stop working.

## Get a token

Ask the token endpoint for a `client_credentials` token, with the client id and secret as HTTP Basic credentials:

```bash
curl -s https://insulinapps.com/oauth/token \
  -u 'ia_sa_EXAMPLEclientid:ia_sk_EXAMPLEsecret' \
  -d grant_type=client_credentials \
  -d resource=https://captable.insulinapps.com
```

- **Token URL**: `https://insulinapps.com/oauth/token`, for every app.
- **Credentials**: HTTP Basic (`-u id:secret`), or `client_id` and `client_secret` in the body.
- **`resource`** (optional): the app's address, `https://<app>.insulinapps.com`. If you send it, it must be the app the
  client belongs to.
- The body can be a form (`application/x-www-form-urlencoded`) or JSON.

The answer:

```json
{
  "access_token": "ia_at_EXAMPLEaccesstoken",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

The token lasts an hour. There is no refresh token: ask for a new token when it expires, or a little before.

| Error | Meaning |
|---|---|
| `401 invalid_client` | The client id or secret is wrong, the client was deleted, or the secret is a previous one whose 24 hours are over or that was revoked. |
| `400 invalid_target` | `resource` names a different app. |
| `400 unsupported_grant_type` | Use `client_credentials`. |
| `415 invalid_request` | Send the parameters as a form or as JSON. |
| `429 slow_down` | Too many token requests; wait for `Retry-After` (60 seconds). |

To revoke a token before it expires, `POST` it as `token` to `https://insulinapps.com/oauth/revoke` with the same
credentials.

## Call the API

Send the token as a bearer token to the app's address:

```bash
curl -s https://captable.insulinapps.com/api/catalog \
  -H 'Authorization: Bearer ia_at_EXAMPLEaccesstoken'
```

```http
POST /api/... HTTP/1.1
Host: captable.insulinapps.com
Authorization: Bearer ia_at_EXAMPLEaccesstoken
Content-Type: application/json
Idempotency-Key: 6f1c2e0a-0b7d-4c55-9a51-2d1f3e4a5b6c

{ "…": "the endpoint's body" }
```

- **Only `/api/*`.** Tokens reach the app's own API, never the platform's `/api/__suger/*`, and never the app's pages.
- **Cookies are never used.** A request with a bearer token never falls back to a browser session, and the app's
  `Set-Cookie` headers are dropped.
- **Idempotency.** Endpoints that need it say so in the catalog (`"idempotencyKey": true`). Send a fresh random
  `Idempotency-Key` for each new change, and the same one again only to retry that change.
- **Same rules as the browser.** The app checks your OAuth client's role and permissions on every request, as it does
  for a person.

### Start with the catalog

Every app that supports agents and API clients publishes its API at `GET /api/catalog`. It lists only what the caller's
role may use. One entry of Cap Table's catalog, for example:

```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/me",
      "summary": "Console identity, company access and holder matches",
      "query": null,
      "body": null,
      "idempotencyKey": false
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `method` | `GET`, `POST`, `PUT`, `PATCH` or `DELETE` |
| `path` | The path under `/api/`, with `{name}` placeholders for its parameters, such as `/api/orgs/{orgId}` |
| `summary` | What it does, in a sentence |
| `query`, `body` | A JSON Schema of the query parameters or of the body, or `null` |
| `idempotencyKey` | Whether the request needs an `Idempotency-Key` header |

Each app's docs describe its API in words: [Cap Table](/docs/captable/overview), [E-sign](/docs/esign/overview).

### Errors from the gateway

The app's own answers pass through unchanged. These come from Insulin Apps before the request reaches the app:

| Status and `error` | Meaning |
|---|---|
| `401 invalid_token` | The token is missing, expired or revoked, or it is a person's agent token (those work only on `/mcp`). The `WWW-Authenticate` header points to `https://<app>.insulinapps.com/.well-known/oauth-protected-resource`. |
| `401 invalid_request` | The path isn't under `/api/`. |
| `403 no_app_access` | The OAuth client no longer has a role in the app. |
| `429 rate_limited` | Too many requests from this OAuth client; wait for `Retry-After` (60 seconds). |
| `502 bad_gateway`, `503 unavailable` | The app can't be reached right now; try again later. |

## What the app sees

The app gets the same identity headers as for a person, with the OAuth client in place of the person. Apps call it a
service account:

| Header | Value |
|---|---|
| `x-suger-user-id` | The OAuth client's id (not its client id) |
| `x-suger-user-name` | The OAuth client's name (URL-encoded) |
| `x-suger-user-email` | `<id>@service-accounts.invalid` (URL-encoded): a reserved domain nobody can own |
| `x-suger-organization-id` | The organization the client belongs to |
| `x-suger-app-role` | `ADMIN`, `EDITOR` or `VIEWER`; for a custom role, the least built-in role that covers it |
| `x-suger-app-permissions` | For apps with a permission catalog: the permissions, space-separated |
| `x-suger-access-via` | `api` |
| `User-Agent` | `Insulin Apps API: <the OAuth client's name>` |

The caller's own `Cookie`, `Authorization`, `Origin`, `Referer`, `User-Agent` and `x-suger-*` headers are removed
first, so a caller can't pose as anyone else.

Apps refuse changes to their own people, roles, billing or integrations unless `x-suger-access-via` is `browser`, so an
OAuth client can't make those changes, whatever its role.

## Good practice

- One OAuth client per system, named after it, so the app's audit trail says which system did what.
- The least role that works: Viewer for reporting, Editor for systems that record changes.
- Keep the secret in your secret store, never in source code. Rotate it with **Rotate secret** when someone who knew it
  leaves, switch your program to the new secret, then choose **Revoke previous secret now**.
- Cache the token for its hour instead of asking for a new one on every call.
