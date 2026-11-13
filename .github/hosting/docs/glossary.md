---
title: Glossary
description: Plain definitions of the terms used across Insulin Apps, from access token to service account and SCIM.
order: 10
---

The terms used across the Insulin Apps platform docs, in alphabetical order, each with a one- or two-sentence
definition. For words specific to an app, see that app's own glossary: [Cap Table](/docs/captable/overview),
[Esign](/docs/esign/overview).

**Access token**: a short-lived secret, valid for one hour, that an AI agent or an OAuth client sends as
`Authorization: Bearer …` to call an app. Insulin Apps stores only its hash.

**Account**: you, as one person signed in with one e-mail address. One account can belong to several organizations.

**Account bar**: the small bar Insulin Apps adds to the pages of an app that has no navigation of its own, with your
organization, the app's people, integrations and Connect AI pages, your account and sign out.

**Active organization**: the organization apps open in right now. You switch it from the organization menu, at the top
of the navigation, or from the account bar.

**Admin**: an organization role that manages people (except owners), every app's integrations and its OAuth clients,
and is Admin in every app. Also an app role: everything in that app, including its people and integrations.

**AI agent**: a program such as Claude Code, Codex, Gemini CLI or opencode that uses an app for you through its MCP
server, with your role. See [AI agents](/docs/platform/ai-agents).

**API access**: an app's settings page, at `insulinapps.com/apps/<app>/settings/api`, with its OAuth clients and how a
program gets a token.

**API catalog**: the list of an app's API endpoints at `GET /api/catalog`, showing only what the caller may use.

**App**: one of the business applications on Insulin Apps, such as Cap Table or Esign, at its own address
`<app>.insulinapps.com`.

**App admin**: someone who manages an app's people and stored credentials: an organization owner or admin, or someone
whose role in that app is Admin. A custom role never makes someone an app admin.

**App role**: the role someone has in one app: Admin, Editor, Viewer or a custom role.

**Assertion consumer service (ACS) URL**: the address on `insulinapps.com` where your identity provider posts a SAML
sign-in response.

**Client credentials**: the OAuth way an OAuth client gets a token, with its client id and client secret and no person
involved.

**Client id and client secret**: an OAuth client's user name and password for getting tokens. The secret is shown once.

**Connect AI**: an app's settings page, at `insulinapps.com/apps/<app>/settings/connect-ai`, with its MCP server, the
setup for each AI client and the agents connected to it.

**Consent page**: the page where you choose **Allow** or **Deny** when an AI agent asks to use an app as you.

**Custom role**: a role an organization's owners build from an app's permissions, for when Admin, Editor and Viewer don't
fit.

**Editor**: an organization role and an app role that uses apps fully, except people, roles and integrations.

**Gateway**: the part of Insulin Apps that serves every address, signs people in, keeps organizations and roles, and
forwards requests to the apps with the caller's identity.

**Grant**: the permission you give an AI agent with **Allow**, for one app in one organization, lasting 30 days unless
it ends sooner.

**Identity headers**: the `x-suger-*` request headers through which an app learns who is calling, in which organization
and with which role.

**Identity provider (IdP)**: your company's sign-in system, such as Okta, Microsoft Entra ID or Google Workspace, used
for single sign-on.

**Integration proxy**: the platform service that adds a stored credential to an app's request to an outside service, so
the app never holds the secret.

**Integrations page**: an app's settings page for its stored credentials, at
`insulinapps.com/apps/<app>/settings/integrations`.

**Invitation**: an e-mailed link to join an organization with given access, valid for 7 days.

**MCP (Model Context Protocol)**: the open protocol AI agents use to call tools. Each Insulin app is an MCP server at
`https://<app>.insulinapps.com/mcp`.

**OAuth**: the standard Insulin Apps uses to give AI agents and OAuth clients tokens without sharing passwords.

**OAuth client**: a program's identity in one app and organization, with a role, a client id and a client secret, used
to call the app's API. Owners and admins manage them on the app's API access page. Also called a service account.

**OpenID Connect (OIDC)**: a sign-in protocol built on OAuth, one of the two ways to connect an identity provider for
single sign-on.

**Organization**: a shared workspace for a team or company. Members, roles and app data belong to it, and organizations
never see each other's data.

**Organization menu**: the button at the top of the navigation with your active organization's name. It lists your
organizations to switch between, and has All apps and Create an organization.

**Organization role**: Owner, Admin, Editor or Viewer, a role that applies in every app.

**Owner**: the organization role with every power, including owners, custom roles, single sign-on, who can be invited,
renaming and deleting the organization. Every organization keeps at least one.

**Owner domain**: the e-mail domain of the person who created an organization, or their address at a public mail provider
like `gmail.com`. Each owner domain can have two organizations; support can allow more.

**Permission**: one thing an app lets a role do, such as `captable.view`. Apps with a permission catalog support custom
roles.

**Permission catalog**: the list of permissions an app declares, each with the least built-in role that has it.

**PKCE**: a check in the OAuth sign-in that ties the returned code to the program that asked for it.

**Public path**: a page of an app that people without an account may open, such as Esign's signing page. It carries no
identity; the app checks its own short-lived codes.

**Recovery code**: one of ten single-use codes that sign you in when you can't use your authenticator app.

**Refresh token**: a secret an AI agent uses to get a new access token without asking you again. It changes on every use.

**SAML 2.0**: an enterprise sign-in protocol, one of the two ways to connect an identity provider for single sign-on.

**SCIM 2.0**: the standard an identity provider uses to add and remove people in your organization automatically.

**Service account**: the earlier name of an OAuth client, and what apps still call one.

**Session**: what keeps you signed in after you sign in, for 30 days while you use it.

**Single sign-on (SSO)**: signing in to Insulin Apps through your company's identity provider.

**Specific apps**: access to chosen apps only, with a role in each, instead of an organization role.

**Stored credential**: a secret for an outside service, kept encrypted for one app and organization and used only through
the integration proxy.

**Two-step sign-in**: a 6-digit code from an authenticator app asked for after your password, Google or single sign-on.

**Verified domain**: an e-mail domain your organization proved it owns with a DNS TXT record, needed for single sign-on
and SCIM, and the only addresses an owner can choose to allow in invitations.

**Viewer**: an organization role and an app role that is read only. Each app decides what that shows.
