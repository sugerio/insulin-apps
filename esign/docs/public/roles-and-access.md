---
title: Roles and access
description: What each role can do in Esign, its two permissions and custom roles, how signers get access, and how AI agents and OAuth clients reach it.
order: 6
---

Your role in your Insulin organization decides what you can do in Esign. This page maps the platform's roles to Esign's
two permissions, explains custom roles, and says what signers, AI agents and OAuth clients can reach. It is for owners
and admins who give access, and for anyone wondering why a button is missing.

## Esign's permissions

Esign has two permissions:

| Permission | Key | What it allows |
| --- | --- | --- |
| **Send and manage envelopes** | `esign.manage` | Upload templates and place their fields, send envelopes, void them, open a signer's signing page, and run due work. It includes viewing. |
| **View envelopes** | `esign.view` | See the organization's templates and envelopes, their statuses and audit trails, and download completed envelopes' signed PDFs and certificates. |

Every role can read the built-in **Docs** and the [public docs](/docs/esign/overview).

## Who can do what

People get access on insulinapps.com in one of two ways: an organization role, which reaches every app, or access to
specific apps, with a role in each. See [Organizations and roles](/docs/platform/organizations-and-roles).

| Access | Role in Esign | Permissions | In Esign |
| --- | --- | --- | --- |
| Organization **Owner** or **Admin** | Admin | Send and manage | Everything in Esign, and they manage Esign's people and integrations on the platform. |
| Organization **Editor** | Editor | Send and manage | Everything in Esign. |
| Organization **Viewer** | Viewer | View | Templates and envelopes, read only. |
| Specific apps, Esign **Admin** | Admin | Send and manage | Everything in Esign, and Esign's people and integrations. |
| Specific apps, Esign **Editor** | Editor | Send and manage | Everything in Esign. |
| Specific apps, Esign **Viewer** | Viewer | View | Templates and envelopes, read only. |
| Specific apps, an Esign custom role | The least built-in role that covers it | Those the custom role has | What those permissions allow. |
| Specific apps, without Esign | None | None | Esign isn't available to them. |

The bottom of Esign's navigation shows your name and role. What your role can't do isn't shown (**New envelope** is
only in the navigation of roles that send), and Esign refuses it on the server too, however it is asked: from the page,
through the API or by an AI agent. A refused request answers `403 forbidden`, and the page
says "Your role in Esign doesn't allow that."

In the Insulin console, the older Owner role works like Admin and the User role like Viewer.

## People and integrations live on the platform

Esign has no people, role, integration, API client or AI agent settings of its own. They are Esign's settings tabs on
the platform, which **Settings** in Esign's navigation links to:

- **People**: `https://insulinapps.com/apps/esign/settings/users` (or `https://esign.insulinapps.com/settings/users`,
  which leads there): Esign's app admins invite someone to Esign with a role, change it, or remove them from Esign.
- **Integrations**: `https://insulinapps.com/apps/esign/settings/integrations`: stored credentials for outside services,
  managed by Esign's app admins. See [Integrations](/docs/platform/integrations).
- **API access**: `https://insulinapps.com/apps/esign/settings/api`: OAuth clients for host products, managed by the
  organization's owners and admins only. See [API access with OAuth clients](/docs/platform/api-and-service-accounts).
- **Connect AI**: `https://insulinapps.com/apps/esign/settings/connect-ai`: Esign's MCP server and the setup for each
  AI client, open to everyone who can use Esign. See [AI agents](/docs/platform/ai-agents).

## Custom roles

Organization owners can create custom roles for Esign on `https://insulinapps.com/settings/roles`, built from Esign's
two permissions. Owners and admins, and Esign's app admins, give them to people with specific-apps access; owners and
admins also give them to OAuth clients.

- A custom role with only **View envelopes** sees everything a Viewer sees and changes nothing.
- A custom role with **Send and manage envelopes** can do everything an Editor can in Esign.
- A custom role never makes someone an app admin: people and integrations stay with admins.

## Signers

Signers don't need an account and don't need to be in your organization. They reach only Esign's public pages:

- their one-time link opens the signing page for their own turn in their own envelope, once, within two minutes;
- the page session it starts lasts 15 minutes;
- the 6-digit code emailed to them confirms they control the signer's email address, and is needed to see previews,
  decline or sign;
- after everyone has signed, a link in their email downloads their copy, once, within 30 days.

None of these reach any other envelope, the members' pages or the management API. Once it is no longer their turn in an
envelope that is out for signature (they signed, or the envelope was voided, declined or expired), their session stops
working.

## AI agents

Anyone who can use Esign can connect an AI agent (Claude Code, Codex, Gemini CLI, opencode, Claude.ai, ChatGPT or
another MCP client) to Esign at `https://esign.insulinapps.com/mcp`. Esign's **Connect AI** page, from **Connect AI**
in the account bar, has the setup for each client and lists your agents. See [AI agents](/docs/platform/ai-agents).

- The agent acts with that person's current role and permissions in the organization they chose, and no more. If their
  role changes or they leave, the agent's access changes with it.
- It can list templates and envelopes, read their status, audit trail and certificate, and, with a role that sends, send
  envelopes from existing templates, void them and run due work. The MCP tools send JSON only, so uploading a PDF (a new
  template, or an editor session's source) is for people on the **Templates** page or for OAuth clients.
- Esign sees the request as coming from an agent (`x-suger-access-via: mcp`), with the agent's name in its user agent.

## OAuth clients

A host product calls Esign's API with an OAuth client (a service account, as Esign sees it) that an owner or admin of
the organization creates on Esign's **API access** tab, with a role of its own (Admin, Editor, Viewer or a custom
role). A host uses one to send envelopes, embed the signing page and the
field editor, follow statuses, and finish due work at once with `POST /api/process-due` when it can't wait for the
platform's five-minute run. **Rotate secret** there keeps the previous secret working for 24 hours, so the host can
switch over without stopping. See [API access with OAuth clients](/docs/platform/api-and-service-accounts).

## What neither can reach

AI agents and OAuth clients call only Esign's management API, under the same rules as the browser. They can't use the
signing page's own API, which answers only a signer's link and session, and they can't reach the platform's people, role
or integration pages. `GET /api/catalog` lists exactly the calls the caller may make, with their fields.
