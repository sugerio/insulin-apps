---
title: AI agents over MCP
description: Connect Claude Code, Codex, Gemini CLI, opencode or a hosted connector to an app's MCP server, and what an agent may do there.
order: 4
---

This page shows how to let an AI agent work in an Insulin app for you: Claude Code, Codex, Gemini CLI, opencode, or a
hosted connector such as Claude.ai or ChatGPT. It shows each app's **Connect AI** page, gives the exact commands,
explains the sign-in step, lists the tools the agent gets, and sets out what an agent may and may not do. It is for
anyone who uses an AI agent, and for the agents themselves.

## How it works

Every app is its own MCP server, at `/mcp` on the app's address:

| App | MCP server |
|---|---|
| Cap Table | `https://captable.insulinapps.com/mcp` |
| Esign | `https://esign.insulinapps.com/mcp` |
| Any app | `https://<app>.insulinapps.com/mcp` |

You add the server to your agent once: each app's [Connect AI page](#the-connect-ai-page) has the command for your
client, ready to copy. The first time the agent connects, it opens `insulinapps.com` in your browser.
You sign in (with two-step sign-in, if you use it), choose the organization, and choose **Allow**. From then on the
agent works in that app, in that organization, **as you**: with your role there, re-checked on every call.

Each app is connected separately. Connecting Cap Table doesn't connect Esign, and an agent you connect in one
organization can't see another.

## The Connect AI page

Every app has a **Connect AI** page with everything you need to connect an agent to it:
`https://insulinapps.com/apps/<app>/settings/connect-ai`, for example
`https://insulinapps.com/apps/captable/settings/connect-ai`. You reach it three ways:

- inside the app, from **Settings** → **Connect AI** in its navigation (or **Connect AI** in the account bar, in an
  app without the navigation);
- from **Account** → **AI agents**, with **Connect AI** next to each app you can use in your active organization;
- from the app's settings pages, where it is next to **People**, **Integrations** and **API access**.

Everyone who can use the app can open it, Viewers and people with access to specific apps included. It shows:

- **The app's MCP server**: its address, what connecting does, and your role in the app in your active organization,
  which is what your agent may do there.
- **Set up your AI client**: the commands for Claude Code, Codex CLI, Gemini CLI and opencode, and the steps for
  Claude.ai and ChatGPT, with the app's name and address already filled in. The page runs no script, so there is no
  copy button: select a command and copy it.
- **Your agents**: the agents you connected to this app in this organization, when each was connected, last used and
  when it expires, each with **Disconnect**.
- **Everyone's agents**, for the organization's owners and admins only: every agent anyone in the organization connected
  to this app, with who connected it, each with **Disconnect**.

![The Connect AI page of Cap Table with the MCP server address, the setup for each AI client and the agents connected](/docs/assets/screenshots/platform-connect-ai.png "An app's Connect AI page")

## Connect your agent

These are the commands the Connect AI page shows. The examples use Cap Table; for another app, change both the name and
the address, for example `esign` and `https://esign.insulinapps.com/mcp`, or copy them from that app's Connect AI page.

### Claude Code

```bash
claude mcp add --transport http captable https://captable.insulinapps.com/mcp
```

Then run `/mcp` in Claude Code, choose `captable` and sign in in the browser window it opens. Add `--scope user` to the
command to have the server in every project, not only the current one.

### Codex CLI

```bash
codex mcp add captable --url https://captable.insulinapps.com/mcp
codex mcp login captable
```

The second command opens `insulinapps.com` in your browser to sign in and allow the connection.

### Gemini CLI

```bash
gemini mcp add --transport http captable https://captable.insulinapps.com/mcp
```

Then run `/mcp auth captable` in Gemini CLI to sign in. The command adds the server to the current project; add
`--scope user` for every project.

### opencode

```bash
opencode mcp add captable --url https://captable.insulinapps.com/mcp
opencode mcp auth captable
```

The second command opens `insulinapps.com` in your browser to sign in and allow the connection.

### Claude.ai and ChatGPT

Claude.ai and ChatGPT connect from their own servers, as a custom connector that takes the app's MCP address, such as
`https://captable.insulinapps.com/mcp`.

- **Claude.ai**: **Customize** → **Connectors** → **Add** → **Add custom connector**; paste the address and connect. On
  Team and Enterprise plans an owner adds it under **Organization settings** → **Connectors**, and members then connect
  it.
- **ChatGPT**: where your plan or workspace allows custom MCP servers (**Plugins** → **Add custom MCP server**), paste the
  address and choose OAuth to sign in.

The connector sends you to `insulinapps.com` to sign in and allow it, like any other agent. Insulin Apps accepts these
connectors' registered callbacks:

- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`

### Any other MCP client

Any other MCP client works the same way: Streamable HTTP at the app's MCP address, with OAuth sign-in. Its sign-in has to
return to the same computer, on a loopback address (`http://localhost`, `http://127.0.0.1` or `http://[::1]`, any port),
or to Claude.ai or ChatGPT.

## The consent screen

When the agent connects, your browser shows **Allow** the agent **to use** the app **as you?**

![The consent page asking to allow an MCP client to use Cap Table, with the organization to choose and the Allow and Deny buttons](/docs/assets/screenshots/platform-agent-consent.png "Allowing an agent")

- **App asking** is the name the agent gave itself. Anyone can choose any name, so allow only an agent you just started
  connecting yourself.
- **Returns to** is where your browser goes back to. For a program on your computer, a warning reminds you that any
  program running there could listen on that address.
- **Organization**: the agent works in this organization only. The list shows only organizations where you can use the
  app, with your role there in brackets.
- **Allow** gives the agent access for 30 days. **Deny** sends it away with nothing.

After **Allow**, a **Back to** page returns you to the agent. You can close the tab once the agent says it's connected.

If none of your organizations gives you access to the app, the page says so instead: ask an owner or admin for access,
then connect again.

## The tools an agent gets

Each app's MCP server offers four tools. They all act as you, in the organization you chose.

| Tool | What it does | Arguments |
|---|---|---|
| `whoami` | Who the connection acts as: the person, the organization, the app, the role and the permissions. | none |
| `endpoints` | The app's API, from its `GET /api/catalog`: each endpoint's method, path, summary and query or body schema, as far as your role may use it. | none |
| `read` | A `GET` on a path under `/api/`. | `path` (required, starting with `/api/`), `query` (an object of strings, numbers or booleans) |
| `change` | A `POST`, `PUT`, `PATCH` or `DELETE` on a path under `/api/`. Changes are real and made as you. | `method` and `path` (required), `query`, `body` (any JSON), `idempotencyKey` (1 to 200 visible characters, sent as `Idempotency-Key`) |

A good agent calls `endpoints` first to learn the app's API, then `read` and `change`. Each app's docs describe its API:
[Cap Table](/docs/captable/overview), [Esign](/docs/esign/overview).

An example call, as JSON-RPC over the Streamable HTTP transport:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "read",
    "arguments": { "path": "/api/me" }
  }
}
```

A `read` or `change` result carries the app's answer:

```json
{
  "status": 200,
  "contentType": "application/json",
  "body": { "…": "the app's JSON" }
}
```

A status of 400 or more is marked as a tool error. Bodies over 200 KB are cut, and the result then has
`"truncated": true` (and the body as text).

For a `change` to an endpoint whose catalog entry says `"idempotencyKey": true`, pass a fresh random `idempotencyKey`
for each new change, and the same key again only when you retry that same change.

## What an agent may do

- **Exactly what you may do in the app, no more.** The agent has your current role and permissions in that app and
  organization. If an owner lowers your role, your agent's power drops at its next call; if you lose access, its calls are
  refused (`no_app_access`). A Viewer's agent can't change anything a Viewer can't.
- **Only the app's own API.** Tools reach paths under `/api/` on that app, never the platform's `/api/__suger/`, and never
  the pages of `insulinapps.com`.
- **Never people, roles, integrations or billing.** Inviting people, changing roles, custom roles, OAuth clients for API
  access, stored credentials, single sign-on and organization settings are browser-only. Apps also refuse their own changes of
  that kind unless they come from a browser.
- **The app knows it's an agent.** The app receives `x-suger-access-via: mcp` and a `User-Agent` of
  `Insulin Apps MCP: <the agent's name>`, so its audit trail can record that the agent did it on your behalf.
- **Limits.** Every MCP request, and every tool call inside a batch, counts against your request rate in apps; past it,
  calls get "Too many requests. Try again in a minute." A JSON-RPC batch holds at most 10 messages. A request body is at
  most 1 MB.

## Tokens and how long access lasts

| What | How long |
|---|---|
| The permission you give with **Allow** (the grant) | 30 days |
| An access token | 1 hour |
| A refresh token | Until the grant ends; replaced on every use |
| The sign-in code sent back to the agent | 60 seconds, single use |
| A consent page left open | 10 minutes |

Your agent refreshes its token by itself. A refresh token that is used twice means it was copied, so the whole grant ends
and the agent must connect again. After 30 days, the agent asks you to sign in and allow it again.

## See and disconnect your agents

**Account** → **AI agents** (`https://insulinapps.com/account/agents`) lists every agent you connected, in every app and
organization, with its app, organization, when it was connected, until when, and when it was last used. **Disconnect**
stops it at once. Under **Connect an agent**, it lists the apps you can use in your active organization, each with its
MCP address and a **Connect AI** button that opens that app's Connect AI page.

![The AI agents page listing a connected agent with its app and organization, and the apps to connect an agent to](/docs/assets/screenshots/platform-agents.png "Account → AI agents")

Each app's [Connect AI page](#the-connect-ai-page) lists the same agents for that app and organization under **Your
agents**, with **Disconnect**. The organization's owners and admins also see **Everyone's agents** there: every agent
anyone in the organization connected to the app, with who connected it, and they can disconnect any of them. An admin
of one app only (through access to specific apps) sees just their own.

The organization's owners and admins also see every app's agents, with every OAuth client for API access, on
**Settings › OAuth clients** (`https://insulinapps.com/settings/oauth-clients`), with who connected each, when, and when
it was last used. **Revoke** there ends an agent's access at once and keeps it listed, marked **Revoked** with the day and
who revoked it, until its 30 days would have ended; **Delete** takes it off the list. A revoked agent no longer appears in
its person's lists, and the person can connect it again, which makes a new grant.

A grant also ends when:

- an owner or admin of the organization disconnects it under **Everyone's agents**, or revokes or deletes it on
  **Settings › OAuth clients**;
- 30 days have passed;
- you leave the organization or are removed from it (a later invitation doesn't bring old agents back);
- you set, change or reset your password, or turn two-step sign-in on or off (this ends **all** your agents, so an agent
  connected by someone who took over your account doesn't survive your recovery);
- the agent presents a used refresh token or sign-in code;
- you delete your account.

## For MCP client developers

- **Transport**: stateless Streamable HTTP. `POST` JSON-RPC to `/mcp` and get JSON back (no server-sent events, no
  session). Protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`.
- **Discovery**: an unauthenticated request gets `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://<app>.insulinapps.com/.well-known/oauth-protected-resource/mcp"`.
  That document names the authorization server, `https://insulinapps.com`, whose metadata is at
  `https://insulinapps.com/.well-known/oauth-authorization-server`.
- **Registration**: `POST https://insulinapps.com/oauth/register` (RFC 7591), public clients only
  (`token_endpoint_auth_method: "none"`), grant types `authorization_code` and `refresh_token`, redirect URIs on a loopback
  address or one of the hosted callbacks above. A client that never gets a grant is deleted after a day.
- **Authorization**: `GET https://insulinapps.com/oauth/authorize` with `response_type=code`, PKCE (`S256`) and
  `resource=https://<app>.insulinapps.com/mcp` (the app's origin is accepted too). The answer carries `iss`.
- **Tokens**: `POST https://insulinapps.com/oauth/token` with `authorization_code` or `refresh_token`.
  `POST https://insulinapps.com/oauth/revoke` revokes a token; revoking a refresh token ends the grant.
- A person's token works only on `/mcp`, never directly on `/api/*`. Programs that call the API directly use an
  [OAuth client](/docs/platform/api-and-service-accounts) from the app's **API access** page.
