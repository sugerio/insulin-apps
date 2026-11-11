---
title: Integrations
description: An app's integrations page, stored credentials for outside services, and the platform services apps use beyond their database.
order: 6
---

This page covers what an app connects to beyond its own data: the app's **Integrations** page, with its service accounts
and its stored credentials for outside services, and the services the platform gives every app (public pages, mail,
scheduled work and secrets). The first part is for app admins; the last part is for people who build or change apps.

## The Integrations page

Each app has an **Integrations** page on the apex: `https://insulinapps.com/apps/<app>/settings/integrations`, for
example `https://insulinapps.com/apps/esign/settings/integrations`. The app's own
`https://<app>.insulinapps.com/settings/integrations` leads there, and so does **Integrations** in the app's account bar.

It has two parts:

- **Service accounts**: programs that call the app's API in your organization, each with a role in the app. See
  [The API and service accounts](/docs/platform/api-and-service-accounts).
- **Stored credentials**: secrets for outside services that the app calls, such as another company's API.

![The Integrations page with the Service accounts and Stored credentials cards](/docs/assets/screenshots/platform-integrations.png "An app's Integrations page")

### Who can see and change it

| Who | What they can do |
|---|---|
| App admins: the organization's owners and admins, and people whose role in the app is **Admin** | Create, edit and delete service accounts and stored credentials |
| Everyone else who can use the app | See names, kinds, hosts and when each was last used. Never a secret. |
| AI agents and service accounts | Nothing: tokens never reach this page |

The page lives on `insulinapps.com`, not on the app's own address, so no code an app serves can read it or post its forms.
Secrets are shown once, right after they are made, and never again.

## Stored credentials

A stored credential keeps an outside service's secret (an API key, a token, a user name and password) for one app in one
organization. Insulin Apps keeps the secret encrypted and adds it to the app's requests to that service, so the app itself
never sees it, and it is sent only to the hosts you list.

### Add a credential

1. On the app's **Integrations** page, under **Stored credentials**, find **New stored credential**.
2. Fill in:
   - **Key**: the name the app uses for it, in lower-case letters, digits, `-` and `_`, for example `payroll`. The app's
     documentation says which key it expects.
   - **Name**: a label for people, such as "Payroll provider".
   - **Base URL**: where the app's calls with this key go. `https` only.
   - **Other hosts (optional)**: other host names the app may call with this credential, separated by commas.
   - **Send the secret as**: **Bearer token** (`Authorization: Bearer …`), **Named header** (give the **Header name (for a
     named header)**), or **Basic authentication** (the secret is `user:password`).
   - **Secret**: the value itself. It is encrypted and never shown again.
3. Choose **Save credential**.

### Change or delete a credential

Open **Edit** under the credential. Leave **New secret (leave empty to keep the current one)** empty to keep the secret.
Changing the **Base URL**, the hosts or how the secret is sent needs the secret entered again in the same save, so nobody
can send a stored secret to a new place to read it. **Delete** removes the credential at once.

> [!NOTE]
> If the site's operator hasn't configured the key that encrypts stored secrets, the page says "Stored credentials
> aren't set up on this site yet" and offers no form.

### How an app uses a credential

For app builders: the app calls the outside service with `integrationFetch(key)` from `@fours/app/server`, passing the
request's `x-suger-organization-id`, so the organization it is serving is the one whose credential is used. The call goes
through the platform's integration proxy, `https://insulinapps.com/__insulin/integrations/<key>/proxy/<host>/<path>`,
which:

- accepts only the app's own platform token (`SUGER_APP_TOKEN`), and uses the credential stored under that key for that
  app in the organization the app names;
- sends the request on only over `https`, and only to the credential's base URL host or one of its other hosts (names,
  never IP addresses or single-label names, and never Insulin Apps' own hosts);
- adds the stored secret the way the credential says, and removes every `x-suger-*`, cookie and authorization header the
  app sent;
- never follows redirects, and refuses paths that hide `.` or `..` segments.

Never keep an outside service's secret in an app's database or source code: store it here instead.

### Known limitation

The app's platform token is per app, not per organization: the app chooses the organization in each proxy call. A bug in
an app, or a leaked app token, could therefore make that app use another organization's stored credentials through the
proxy, though never read them.

## What apps get from the platform

Every app gets one database and its static files, and nothing else directly: no file storage, queues, cron jobs or mail
of its own. What an app needs beyond that, the platform provides. An app declares these in its `package.json` under
`insulin`:

```json
"insulin": {
  "permissions": [ "…the app's permission catalog…" ],
  "publicPaths": ["/sign", "/api/public/"],
  "scheduled": "/api/scheduled",
  "secrets": ["ESIGN_OTP_KEY"]
}
```

### Sign-in, people and roles

Apps never build their own sign-in, sessions, people or role management. Every request reaches the app with the
caller's identity and role as headers (see [How it works](/docs/platform/how-it-works#the-identity-headers)), and the
app reads them with `getCurrentUser(request)` from `@fours/app/server`. An app that wants custom roles declares a
`permissions` catalog (see [Organizations and roles](/docs/platform/organizations-and-roles#custom-roles)).

### Public pages for people without an account

Some people never get an account, such as someone who receives a document to sign in E-sign. An app lists the paths
they may open in `publicPaths` (at most ten). On those paths Insulin Apps forwards the request with no identity at all
(`x-suger-access-via: public`), and the app authenticates the visitor with its own short-lived codes, such as a code
e-mailed to them. These requests are rate limited per IP address, and requests that change something more strictly.
A public path is never a way around sign-in for members.

### Mail

Apps send e-mail through the platform's mail relay, one message per request, to `POST https://insulinapps.com/__insulin/mail`
with the app's platform token and the organization it is serving. Messages come from Insulin Apps' address, named
"*app name* via Insulin Apps", with the app's reply-to address if it gives one. Limits keep apps from flooding anyone:
ten messages an hour per recipient across all apps, 500 a day per organization and app, and 5,000 a day per app.

### Scheduled work

Apps have no cron jobs. An app with work that falls due (deadlines, retries) declares one `scheduled` path under `/api/`,
and the platform calls it every five minutes, with no identity (`x-suger-access-via: schedule`), an empty body and a
25-second timeout. The app does every organization's due work there, safely repeatable. For example, E-sign expires
envelopes past their deadline this way.

### Secrets

An app lists the runtime secrets it needs by name in `secrets` (each starting with the app's name in capitals, such as
`ESIGN_`). The site's operator sets their values, and the deploy gives each app only its own. Apps read them with
`readAppEnv(name)` and never put a value in source code.
