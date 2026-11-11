---
title: FAQ
description: Short answers to the questions people ask most about accounts, organizations, roles, AI agents and data on Insulin Apps.
order: 8
---

Short, direct answers to common questions about Insulin Apps, with links to the page that explains each one in full. It
is for everyone: members, owners and admins, and AI agents looking for a quick fact.

## Accounts and sign-in

### Do I need a separate account for each app?

No. One account at `insulinapps.com` works in every app. You sign in once, and every app at `<app>.insulinapps.com`
knows who you are. See [Getting started](/docs/platform/getting-started).

### I didn't get the confirmation e-mail. What now?

Wait a few minutes and check your spam folder. Then ask for a new link at `https://insulinapps.com/resend-verification`,
or sign in: if your password is right, you are offered **Send a new link**. Links work once and expire after 24 hours.

### I signed up with Google. Can I also use a password?

Yes. On **Account**, use **Set a password**, or choose **Forgot your password?** on the sign-in page. Either way works
afterwards. See [Sign-in and security](/docs/platform/sign-in-and-security#passwords).

### I lost my phone with my authenticator app. How do I get in?

On the **Two-step sign-in** page, enter one of the recovery codes you saved when you turned it on. Each works once. Once
you are in, turn two-step sign-in off and on again with your new phone, and save the new recovery codes. Without a
recovery code there is no other way to switch it off on the site, so keep them safe.

### Why does "Sign in with SSO" say there's no single sign-on for my address?

Single sign-on works only for addresses in a domain your organization's owners verified, with an identity provider
connected and turned on. Ask them, or sign in with your password or Google meanwhile.

## Organizations and roles

### What is the difference between an organization role and specific apps?

An organization role (Owner, Admin, Editor or Viewer) applies in every app, including apps added later. **Specific
apps** gives access only to the apps chosen, with a role in each. A person has one or the other, never both. See
[Organizations and roles](/docs/platform/organizations-and-roles).

### How do I remove someone from one app only?

If they have specific-apps access, open that app's people page (`https://insulinapps.com/apps/<app>/settings/users`) and
choose **Remove** next to them. If it was their last app, they leave the organization. If they have an organization role,
change their access to **Specific apps** on the organization's **People** page and leave out that app.

### Why can't an admin change an owner?

Owners are the top of the organization: only an owner can invite, change or remove another owner, give the Owner role,
edit custom roles, set up single sign-on, choose who can be invited, rename the organization or delete it. An organization always keeps at least one
owner.

### I was given Viewer in Cap Table but see only my own holdings. Is that a bug?

No. Each app decides what its Viewer role shows. In Cap Table, a Viewer sees their own holdings, matched by their e-mail
address. To see the whole cap table without changing it, ask an owner for a custom role with **View the cap table**. See
[Cap Table](/docs/captable/overview).

### Can I be in more than one organization?

Yes. Apps open in your active organization. Switch it from the organization menu in the top bar of `insulinapps.com`, or
from the account bar inside an app. The same menu has **Create an organization**.

### How many organizations can we create?

Two per owner e-mail domain, counted by the domain of the creator's address (for public mail providers like
`gmail.com`, by address). Deleting one frees its place. For more, ask support: at the limit, **Create an organization**
shows a **Request more organizations** form that e-mails Insulin Apps support, who reply to you. See
[Getting started](/docs/platform/getting-started#how-many-organizations-you-can-create).

### Can we stop people outside our company from being invited?

Yes. Once your organization has verified its e-mail domain under **Single sign-on**, an owner can choose **Invite only
my verified domains** on the **Organization** tab. It is off by default. See
[Organizations and roles](/docs/platform/organizations-and-roles#who-can-be-invited).

## AI agents and the API

### How do I connect my AI agent to an app?

Open the app's **Connect AI** page, from **Connect AI** in the account bar inside the app or from **Account** → **AI
agents**. It has the command for Claude Code, Codex, Gemini CLI and opencode, and the steps for Claude.ai and ChatGPT.
See [AI agents](/docs/platform/ai-agents#the-connect-ai-page).

### Why do I sign in again for each app my agent uses?

Each app is its own MCP server with its own permission. Allowing an agent in Cap Table doesn't let it into E-sign, and
each connection is for one organization. That keeps an agent to exactly what you meant to give it. See
[AI agents](/docs/platform/ai-agents).

### Can a Viewer's agent change data?

No. An agent has its person's current role in that app, checked on every call. It can't do anything its person can't, and
if the person's role is lowered, so is the agent's.

### Can an agent invite people or change roles?

No. People, roles, custom roles, integrations, API access, single sign-on and organization settings are browser-only.
Tokens never reach those pages.

### How do I stop an agent?

Go to **Account** → **AI agents**, or the app's **Connect AI** page, and choose **Disconnect**. It stops at once. The
organization's owners and admins can disconnect anyone's agent on an app's Connect AI page. Changing your password or
turning two-step sign-in on or off disconnects all your agents.

### What is the difference between an AI agent and an OAuth client?

An AI agent acts as you, with your role, and you allow it in your browser. An OAuth client (once called a service
account) is a program's own identity in one app, with a role and a client secret instead of a person. The organization's
owners and admins create it on the app's **API access** tab. Use an OAuth client for integrations between systems. See
[API access with OAuth clients](/docs/platform/api-and-service-accounts).

### How do I change an OAuth client's secret without breaking the program that uses it?

Choose **Rotate secret** on the app's **API access** tab. The previous secret keeps working for 24 hours, so you can
switch the program over; then choose **Revoke previous secret now**, or let the 24 hours run out.

## Data

### Is my data reset?

No. Data is kept until you delete it. Nothing on Insulin Apps is a demo that resets.

### Can other organizations see our data?

No. Every app scopes its data by organization, and the gateway sends each request with exactly one organization's id.
Members of your organization see what their role in each app allows.

### What happens to app data when an organization is deleted?

Deleting an organization removes it, its people, roles and invitations from Insulin Apps sign-in. The apps keep the data
they stored for it, but nobody can reach it again, because the organization's id is never issued again. To remove an
app's data, delete it in the app first.

### What happens when I delete my account?

**Delete my account** on your **Account** page deletes your account, signs you out everywhere and deletes every
organization where you are the only member. If you are the only owner of an organization that has other members, make
someone else an owner first, or remove the other members.

### Is the source code available?

Yes. The gateway and every app are open source under the MIT License, and each app's card links to its source.
