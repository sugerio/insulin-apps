---
title: Sign-in and security
description: Passwords, Google, two-step sign-in, enterprise single sign-on with SAML or OIDC, and SCIM provisioning.
order: 3
---

This page covers every way to sign in to Insulin Apps and how to protect accounts: passwords, Google, two-step sign-in
with an authenticator app, and, for companies, single sign-on (SSO) with SAML 2.0 or OpenID Connect and automatic
provisioning with SCIM 2.0. The first half is for everyone; the second half is for the organization owners and IT admins
who connect an identity provider.

All sign-in happens at `https://insulinapps.com`. Apps never ask for your password: they receive who you are from
Insulin Apps.

## Passwords

- A password has 10 to 200 characters. It is stored only as a salted hash, never as the password itself.
- **Confirming your address.** A new account gets a confirmation e-mail. Its link works once and expires after 24 hours.
  You can ask for a new one at any time: **Get a new confirmation link** at `https://insulinapps.com/resend-verification`.
- **Forgot your password?** On **Sign in**, choose **Forgot your password?**, enter your address and choose **Send link**.
  The link expires after 1 hour. On **Choose a new password**, enter a **New password** and choose **Save password**. This
  also works for an account that has only signed in with Google so far: it gives the account a password.
- **Changing your password.** On **Account** (`https://insulinapps.com/account`), under **Change password**, enter your
  **Current password** and a **New password**, then **Save password**. An account that signs in with Google only sees
  **Set a password** instead.

Each sign-in form has a bot check and a rate limit. Too many attempts get "Too many attempts. Please wait a minute and try
again."

## Google

Choose **Continue with Google** on **Sign in** or **Create an account**. Insulin Apps asks Google only for your basic
profile and e-mail address.

- No account yet: one is created for you, already confirmed.
- An account with the same address already exists: Google is linked to it. If that account was never confirmed, linking
  confirms it and removes its password, so nobody who registered your address before you can keep a way in.
- An address that is already linked to a different Google account can't be linked again.

## Sessions

- Signing in starts a session that lasts 30 days and renews while you use it. It works on `insulinapps.com` and in every
  app.
- **Sign out** is under your name at the bottom of the navigation, on `insulinapps.com` and inside each app (or in the
  account bar, in an app without the navigation).
- **A change of credentials signs you out everywhere else.** Setting, changing or resetting your password, and turning
  two-step sign-in on or off, end all your other sessions. They also disconnect all your AI agents, so an agent connected
  by someone who got into your account doesn't outlive your recovery. Reconnect the agents you still want.

## Two-step sign-in

Two-step sign-in asks for a 6-digit code from an authenticator app on your phone after your password, Google, a reset
link or single sign-on. A stolen password is then not enough to get in. Any standard authenticator app works, such as
Google Authenticator, Microsoft Authenticator, 1Password or Authy.

### Turn it on

1. Go to **Account** → **Security** (`https://insulinapps.com/account/security`).
2. Under **Two-step sign-in**, enter **Your password** and choose **Set up two-step sign-in**. An account without a
   password can do this within ten minutes of signing in instead, so that a session left open on someone else's computer
   can't be used.
3. Scan the QR code with your authenticator app, or type the key shown under it (time-based, 6 digits, every 30 seconds).
4. Enter the **Code from your app** (and your password again, if asked) and choose **Turn on**.
5. **Save your recovery codes.** You get ten single-use recovery codes, shown only this once. Keep them somewhere safe,
   away from your phone.

![The Security page with two-step sign-in, its status and the button to set it up](/docs/assets/screenshots/platform-security.png "Account → Security")

### Signing in with it

After your password (or Google, a reset link or single sign-on), the **Two-step sign-in** page asks for the **Code** from
your app. Choose **Continue**. No session exists until the code is accepted.

- **Lost your phone?** Enter one of your recovery codes in the same box. Each works once.
- The code step lasts 10 minutes. Five wrong answers end it, and you sign in again.
- Ten wrong app codes in a row, across sign-ins, pause app codes for an hour and send you an e-mail. Recovery codes still
  work while app codes are paused.
- A code that was already used is never accepted twice.

### Manage it

On **Account** → **Security**, while two-step sign-in is on:

- **Make new recovery codes** with a code from your app. The new codes replace all the old ones. The page shows how many
  recovery codes you have left.
- **Turn off two-step sign-in** with a code from your app or a recovery code, then **Turn off**. Your other sessions are
  signed out.

> [!NOTE]
> If the site's operator hasn't configured the key that encrypts authenticator secrets, the Security page says
> "Two-step sign-in isn't available on this site right now."

## Enterprise single sign-on

Single sign-on lets your company's identity provider, such as Okta, Microsoft Entra ID or Google Workspace, sign people
in to Insulin Apps with their work accounts. It works for addresses in e-mail domains your organization has verified.
Only the organization's **owners** can set it up, under **Single sign-on** in the organization's settings
(`https://insulinapps.com/settings/sso`).

![The Single sign-on settings with Domains, Identity provider, What your identity provider needs and SCIM provisioning](/docs/assets/screenshots/platform-sso.png "Single sign-on settings")

### Step 1: Verify your domain

1. Under **Domains**, enter the part of your work addresses after the @ in **Add a domain**, for example `example.com`,
   and choose **Add domain**.
2. Add the DNS TXT record shown on the page to your domain's DNS (see the table below).
3. When the record is live, choose **Verify**. The status changes from **Waiting for the DNS record** to **Verified**.

| Record | Value |
|---|---|
| **TXT record name** | `_insulin-apps.example.com` (your domain after `_insulin-apps.`) |
| **TXT record value** | `insulin-apps-verification=` followed by the token shown on the page |

One organization at a time can hold a verified domain. **Remove** takes a domain away; it also removes from the
organization the members (other than owners) that SCIM added with addresses in that domain.

A verified domain also lets an owner limit invitations to it: **Invite only my verified domains**, on the
**Organization** page, off by default. See
[Organizations and roles](/docs/platform/organizations-and-roles#who-can-be-invited).

### Step 2: Connect your identity provider

Under **Identity provider**, choose the **Protocol** and the **Role for new members**, fill in the protocol's settings,
and choose **Save**. You can save it switched off first, to get the addresses your identity provider needs.

- **Role for new members**: **Viewer** or **Editor**. People who sign in through SSO and aren't members yet join with this
  role. Owners and admins change it later on the People page.
- **Turn single sign-on on**: shows your identity provider to people who choose **Sign in with SSO**.
- **Require single sign-on for the verified domains**: password, Google, password reset, sign-up and confirmation links
  are then refused for addresses in those domains. People see **Use single sign-on** and are sent to **Sign in with SSO**.

One organization has one connection. **Delete the connection** removes it.

### SAML 2.0 settings

In your identity provider, create a SAML app with the values under **What your identity provider needs**:

| Insulin Apps shows | Value |
|---|---|
| **Entity ID (audience)** | `https://insulinapps.com/sso/saml/<connection id>` |
| **Assertion consumer service (ACS) URL** | `https://insulinapps.com/sso/saml/<connection id>/acs` |
| **Metadata URL** | `https://insulinapps.com/sso/saml/<connection id>/metadata` |
| **Name ID format** | Email address |

Then copy these from your identity provider into Insulin Apps:

- **Identity provider entity ID (issuer)**;
- **Identity provider sign-in URL**: its single sign-on URL for the HTTP-Redirect binding;
- **Signing certificate**: the certificate it signs with, in PEM form. During a certificate rotation, paste both the old
  and the new one. Leave the box empty later to keep the saved certificates.

What Insulin Apps expects of the SAML response:

- sign-in starts from Insulin Apps (service-provider initiated), with an HTTP-Redirect request and an HTTP-POST response
  to the ACS URL;
- the response or the assertion is signed with the configured certificate (RSA-SHA256), and the signature covers what
  is read;
- exactly one assertion, with the right audience, recipient, destination, issuer and validity window, answering the
  request that was sent;
- a response of at most 256 KB.

### OpenID Connect settings

In your identity provider, create a web application that uses the authorization code flow, with the redirect URI shown
under **What your identity provider needs**:

| Insulin Apps shows | Value |
|---|---|
| **Redirect URI (sign-in redirect URL)** | `https://insulinapps.com/sso/oidc/<connection id>/callback` |

Then copy these into Insulin Apps:

- **Issuer**, such as `https://login.example.com`. Its discovery document must be at
  `/.well-known/openid-configuration`.
- **Client ID** and **Client secret**. The secret is stored encrypted and never shown again; leave it empty later to keep
  it. Changing the issuer or the client ID drops the stored secret, so you enter it again.

Insulin Apps asks for the scopes `openid email profile`, uses PKCE and a nonce, and requires the ID token's
`email_verified` claim to be true.

### How people sign in with SSO

1. On **Sign in**, they choose **Sign in with SSO**, enter their **Work email address** and choose **Continue**.
2. Insulin Apps finds the verified domain and sends them to your identity provider.
3. After they sign in there, they are back on Insulin Apps, signed in, in your organization.

What happens to the account:

- **No account yet**: one is created, confirmed, without a password.
- **Not a member yet**: they join your organization with the **Role for new members**, and it becomes their active
  organization.
- **An existing account with its own password or Google link**: they get an e-mail the first time they sign in through
  SSO, so they know.

Your identity provider asks for whatever it requires, including its own second factor if it has one. Back on Insulin
Apps, someone who has turned on [two-step sign-in](#two-step-sign-in) for their Insulin Apps account then sees the
**Two-step sign-in** page and enters the code from their authenticator app (or a recovery code), as after a password.
They are signed in only once the code is accepted. Someone who hasn't turned it on is signed in straight away.

## SCIM provisioning

SCIM lets your identity provider add and remove people in your organization automatically. It is set up by owners under
**SCIM provisioning** on the same **Single sign-on** page.

1. Copy the **SCIM base URL**: `https://insulinapps.com/scim/v2`.
2. Under **New token name**, name the system that will use it (for example "Identity provider") and choose **Create
   token**. Copy the token into your identity provider now: it isn't shown again.
3. In your identity provider, set the SCIM base URL and use the token as a bearer token.

The token list shows when each token was created and last used. **Revoke** stops a token at once.

### What SCIM supports

| Endpoint | Operations |
|---|---|
| `/scim/v2/Users` | `GET` (list, with the filter `userName eq "…"`, `startIndex` and `count` up to 100), `POST` (create) |
| `/scim/v2/Users/{id}` | `GET`, `PUT` (replace), `PATCH`, `DELETE` |
| `/scim/v2/ServiceProviderConfig`, `/scim/v2/ResourceTypes`, `/scim/v2/Schemas` | `GET` |

A user has `userName` (the e-mail address), `name` (`formatted`, `givenName`, `familyName`), `displayName`, `emails`,
`externalId` and `active`.

### What SCIM does

- **Only addresses in a currently verified domain**, for every read and every write.
- **Creating a user** adds the person to the organization with the **Role for new members**. An address without an
  account gets one, confirmed.
- **`active: false` or `DELETE`** removes the person from the organization (never its last owner) and ends their AI
  agents' access there. Their sessions stay, because they may belong to other organizations, but they can no longer act
  in this one. Your identity provider can still see them, so it can turn them back on.
- **Roles stay on the People page.** SCIM never changes a role; owners and admins do.
- SCIM calls are rate limited per token.

## Security at a glance

| What | How long |
|---|---|
| Session | 30 days, renewed while used |
| Confirmation link | 24 hours, single use |
| Password reset link | 1 hour, single use |
| Two-step sign-in code step | 10 minutes, five wrong answers |
| App codes paused after ten wrong codes | 1 hour |
| Invitation | 7 days |
| AI agent permission | 30 days (see [AI agents](/docs/platform/ai-agents)) |
| Access token for an agent or service account | 1 hour |
