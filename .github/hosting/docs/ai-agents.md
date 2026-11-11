---
title: AI agents over MCP
description: Connect Claude Code, Codex, Gemini CLI, opencode or a hosted connector to an app's MCP server, and what an agent may do there.
order: 4
---

This page shows how to let an AI agent work in an Insulin app for you: Claude Code, Codex, Gemini CLI, opencode, or a
hosted connector such as Claude or ChatGPT. It gives the exact commands, explains the sign-in step, lists the tools the
agent gets, and sets out what an agent may and may not do. It is for anyone who uses an AI agent, and for the agents
themselves.

## How it works

Every app is its own MCP server, at `/mcp` on the app's address:

| App | MCP server |
|---|---|
| Cap Table | `https://captable.insulinapps.com/mcp` |
| E-sign | `https://esign.insulinapps.com/mcp` |
| Any app | `https://<app>.insulinapps.com/mcp` |

You add the server to your agent once. The first time the agent connects, it opens `insulinapps.com` in your browser.
You sign in (with two-step sign-in, if you use it), choose the organization, and choose **Allow**. From then on the
agent works in that app, in that organization, **as you**: with your role there, re-checked on every call.

Each app is connected separately. Connecting Cap Table doesn't connect E-sign, and an agent you connect in one
organization can't see another.

## Connect your agent

The examples use Cap Table. For another app, change both the name and the address, for example `esign` and
`https://esign.insulinapps.com/mcp`.

### Claude Code

```bash
claude mcp add --transport http captable https://captable.insulinapps.com/mcp
```

Then start Claude Code, run `/mcp`, choose `captable` and authenticate. Your browser opens the consent page. Add
`--scope user` to the command to have the server in every project, not only the current one.

### Codex CLI

```bash
codex mcp add captable --url https://captable.insulinapps.com/mcp
codex mcp login captable
```

`codex mcp login` opens your browser to sign in and allow the connection. The same server in `~/.codex/config.toml`:

```toml
[mcp_servers.captable]
url = "https://captable.insulinapps.com/mcp"
```

Older Codex releases needed `experimental_use_rmcp_client = true` at the top of `config.toml` for servers reached by
URL. If `codex mcp login` isn't available, update Codex.

### Gemini CLI

```bash
gemini mcp add --transport http captable https://captable.insulinapps.com/mcp
```

Then start Gemini CLI and run `/mcp auth captable` to sign in and allow the connection. The same server in
`.gemini/settings.json` (this project) or `~/.gemini/settings.json` (every project):

```json
{
  "mcpServers": {
    "captable": {
      "httpUrl": "https://captable.insulinapps.com/mcp"
    }
  }
}
```

### opencode

Add the server to `opencode.json` in your project, or to `~/.config/opencode/opencode.json` for every project:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "captable": {
      "type": "remote",
      "url": "https://captable.insulinapps.com/mcp",
      "enabled": true
    }
  }
}
```

Then run:

```bash
opencode mcp auth captable
```

### Hosted connectors: Claude and ChatGPT

Claude (on claude.ai and claude.com) and ChatGPT can connect to an app as a custom connector, from their own servers.
Add a custom connector and give it the app's MCP address, such as `https://captable.insulinapps.com/mcp`. The connector
sends you to `insulinapps.com` to sign in and allow it, like any other agent.

Insulin Apps accepts these connectors' registered callbacks:

- `https://claude.ai/api/mcp/auth_callback`
- `https://claude.com/api/mcp/auth_callback`
- `https://chatgpt.com/connector_platform_oauth_redirect`

Other agents must run on your computer and receive the sign-in on a loopback address (`http://localhost`,
`http://127.0.0.1` or `http://[::1]`, any port), which is what the command-line agents above do.

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
[Cap Table](/docs/captable/overview), [E-sign](/docs/esign/overview).

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
- **Never people, roles, integrations or billing.** Inviting people, changing roles, custom roles, service accounts,
  stored credentials, single sign-on and organization settings are browser-only. Apps also refuse their own changes of
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

**Account** → **AI agents** (`https://insulinapps.com/account/agents`) lists every agent you connected, with its app,
organization, when it was connected, until when, and when it was last used. **Disconnect** stops it at once.

![The AI agents page listing a connected agent with its app, organization and a Disconnect button](/docs/assets/screenshots/platform-agents.png "Account → AI agents")

A grant also ends when:

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
- A person's token works only on `/mcp`, never directly on `/api/*`. Programs that call the API directly use a
  [service account](/docs/platform/api-and-service-accounts).
