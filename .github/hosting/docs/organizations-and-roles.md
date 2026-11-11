---
title: Organizations and roles
description: Organization roles, access to specific apps, custom roles, and the pages where owners and admins manage people.
order: 2
---

This page explains who can do what on Insulin Apps: the organization roles, access to specific apps, custom roles, and
the pages where you manage people. It is for owners and admins who decide on access, and for anyone who wants to know
why they can or can't do something.

## How access works

Every member of an organization has exactly one of two kinds of access:

- **An organization role**: Owner, Admin, Editor or Viewer. It applies in every app, including apps added later.
- **Specific apps**: access to the apps they were given and no others, with a role in each app (Admin, Editor, Viewer or
  a custom role).

Never both at once. Giving someone an organization role removes their app-by-app access in the same step, and app-by-app
access needs the member to be on **Specific apps**.

```diagram
title: From a member's access to their role in an app
description: Every member has one kind of access. An organization role applies in every app: owners and admins are Admin in every app, editors are Editor and viewers are Viewer. Access to specific apps gives a role in each chosen app: Admin, Editor, Viewer or one of that app's custom roles, which owners build from the app's permission catalog. The gateway sends the app the role and the permissions in the x-suger-app-role and x-suger-app-permissions headers.
size: 740 x 500
box member 260 20 220 60 "Member" "of an organization," "with one kind of access"
box orgrole 40 130 300 80 accent "Organization role" "Owner or Admin: Admin in every app" "Editor: Editor; Viewer: Viewer"
box specific 400 130 300 80 accent "Specific apps" "only the apps chosen, with a role" "in each, possibly a custom role"
group inapp 20 250 700 130 "Role in an app"
box admin 40 290 150 70 "Admin" "everything, people" "and integrations too"
box editor 210 290 150 70 "Editor" "every function but" "people and roles"
box viewer 380 290 150 70 "Viewer" "read only, as the" "app defines it"
box custom 550 290 150 70 dashed "Custom role" "built by owners from" "the app's catalog"
box headers 140 420 460 62 muted "Sent to the app with every request" "x-suger-app-role and x-suger-app-permissions"
arrow member.b:0.25 -> orgrole.t:0.6 "or" mid=105
arrow member.b:0.75 -> specific.t:0.4 mid=105
arrow orgrole.b -> inapp.t:0.271 "same role in every app"
arrow specific.b -> inapp.t:0.786 "a role per app"
arrow inapp.b:0.529 -> headers.t:0.543
```

Insulin Apps works out your role in an app and passes it to the app with every request. The app then decides what that
role lets you see and do. The rules are checked on the server, every time: hiding a button is never the only protection.

## Organization roles

| Role | Manages people and roles | In every app |
|---|---|---|
| **Owner** | Invites, changes and removes anyone, owners included. Creates, edits and deletes custom roles. Sets up single sign-on and SCIM, and chooses who can be invited. Renames and deletes the organization. | Admin |
| **Admin** | Invites, changes and removes admins, editors, viewers and people with specific apps. Gives custom roles. Can't change owners or edit custom roles. Manages every app's integrations and its OAuth clients for API access. | Admin |
| **Editor** | Nothing. Can see the organization's people and roles. | Editor |
| **Viewer** | Nothing. Can see the organization's people and roles. | Viewer |
| **Specific apps** | In an app where they are Admin: that app's people and stored credentials (not its OAuth clients). Can't see the organization's people list. | Their role in each app they were given, or no access |

The person who creates an organization is its first owner. An organization always keeps at least one owner: the last
owner can't be removed, can't be given another role, and can't leave.

## App roles

Each app interprets three built-in roles:

| App role | What it means |
|---|---|
| **Admin** | Everything in the app, including its people and integrations. |
| **Editor** | Uses the app fully, except its people, roles and integrations. |
| **Viewer** | Read only. The app decides what that shows. |

What "read only" shows is up to each app. For example, a Viewer in [Cap Table](/docs/captable/overview) sees only their
own holdings, while a Viewer in [E-sign](/docs/esign/overview) sees the organization's templates and envelopes.

Owners and admins of the organization are **Admin** in every app. Editors are **Editor** and viewers are **Viewer** in
every app.

### App admins

An **app admin** for an app is an organization owner or admin, or someone with specific-apps access whose role in that
app is **Admin**. App admins manage that app's people (invite, change roles, remove) and its integrations (stored
credentials). A custom role never makes someone an app admin, whatever permissions it has: people and integrations
belong to the platform, not to an app's permissions.

The app's **OAuth clients** for API access are different: only the organization's owners and admins create, change,
rotate and delete them, on the app's **API access** page, because a client's secret outlives whoever made it. An app
admin through specific apps sees the list but can't change it. See
[API access with OAuth clients](/docs/platform/api-and-service-accounts).

## Access to specific apps

Use **Specific apps** for people who need one or two apps and nothing else, such as an outside counsel who only uses
E-sign, or an employee who only looks at their own equity in Cap Table.

- They see only the apps they were given, on their home page and when they open an app.
- They don't see the organization's people list. On **People** they see **Your apps** instead, with a link to each app's
  own people page.
- Their role can differ per app, for example Editor in E-sign and Viewer in Cap Table.
- Taking away their last app removes them from the organization.

## Custom roles

A custom role is a role you build from an app's permissions, for when Admin, Editor and Viewer don't fit. For example, a
"Board observer" in Cap Table who may view the whole cap table but not record changes.

- **Only apps with a permission catalog have custom roles.** An app lists its permissions in its code, and the platform
  reads them when the app is deployed.
- **Owners create, edit and delete custom roles**, one app at a time, on `https://insulinapps.com/settings/roles`.
- **Owners and admins give them**, and so do each app's admins for their app: when inviting someone with **Specific
  apps**, when changing their access, or on the app's people page. Owners and admins also give them to OAuth clients.
- **A custom role can't be deleted while it is in use** by anyone, by a pending invitation or by an OAuth client. The
  **Roles** page shows **Not used**, **Used once** or how many times.

### The permission catalogs

These are the permissions each app offers today. The last column is the least built-in role that already has the
permission: a role higher up has it too, and Admin has every permission.

| App | Permission | Label | What it allows | Least built-in role |
|---|---|---|---|---|
| Cap Table | `captable.manage` | Record changes | Record and reverse equity changes, run imports and manage documents. Includes viewing the whole cap table. | Editor |
| Cap Table | `captable.view` | View the cap table | See the whole cap table, stakeholders, reports and documents, read only. | Editor |
| Cap Table | `portfolio.view` | See own holdings | See their own holdings in the holder view, matched by their e-mail address. | Viewer |
| E-sign | `esign.manage` | Send and manage envelopes | Upload templates and place their fields, send envelopes, void them, open signing pages for recipients and finish due work. Includes viewing. | Editor |
| E-sign | `esign.view` | View envelopes | See templates, envelopes and their status, the audit trail, signed documents and certificates of completion. | Viewer |

### How an app sees a custom role

An app receives two things: a built-in role and a list of permissions.

- The **role** sent for a custom role is the least built-in role that covers all of its permissions. A Cap Table custom
  role with only **View the cap table** is sent as Editor, because `captable.view` needs at least Editor. One with only
  **See own holdings** is sent as Viewer.
- The **permissions** are exactly the custom role's own. The app allows only what both the role and the permissions
  allow, so the "Board observer" above can view the cap table but can't record changes, even though its role is Editor.

Permissions can only narrow a role, never widen it.

### Create a custom role

1. Go to **Roles** (`https://insulinapps.com/settings/roles`). You must be an owner to see the forms.
2. Find the app's card. It shows each permission and which built-in roles have it, then the app's custom roles.
3. Under **New custom role for** the app, enter a **Name** and, if you want, a **Description (optional)**.
4. Tick the **Permissions** the role should have.
5. Choose **Create role**.

To change a role, open **Edit** under it, change its name, description or permissions, and choose **Save role**.
Changes apply to everyone who has the role at their next request. **Delete** is available only while the role isn't used.

![The Roles page with the organization roles, the app roles and Cap Table's permissions and custom roles](/docs/assets/screenshots/platform-roles.png "The Roles page")

## The people pages

People are managed on `insulinapps.com`, never inside an app, so that no app can read or change these pages.

### The organization's People page

`https://insulinapps.com/settings/users` shows your active organization (add `?org=<id>` for another one). The settings
have four pages, under **Settings** in the navigation: **People**, **Roles** (for everyone with an organization role),
**Organization** and, for owners, **Single sign-on**.

On **People**, everyone with an organization role sees every member and their access. Owners and admins also see:

- **Change access** under each member they may change: choose the **Access** and, for **Specific apps**, a role per
  app, then **Save access**;
- **Remove** next to each member they may remove;
- **Invite people**, to send invitations with an organization role or specific apps;
- **Pending invitations**, with **Resend** and **Revoke**.

People with specific-apps access see **Your apps** instead of the member list.

### The Roles page

`https://insulinapps.com/settings/roles` describes the organization roles and the app roles, and for each app with a
permission catalog, which built-in roles have each permission and the organization's custom roles. Everyone with an
organization role can open it; only owners see the forms to create, edit and delete custom roles.

### An app's People page

Each app has its own people page on the apex: `https://insulinapps.com/apps/<app>/settings/users`, for example
`https://insulinapps.com/apps/captable/settings/users`. The app's own address `https://<app>.insulinapps.com/settings/users`
leads there too, and so does **Settings** in the app's navigation. It is the first of the app's settings pages, which
the second column of the navigation lists: **People**, **Integrations** (stored credentials, see
[Integrations](/docs/platform/integrations)), **API access** (OAuth clients, see
[API access with OAuth clients](/docs/platform/api-and-service-accounts)) and **Connect AI** (see
[AI agents](/docs/platform/ai-agents#the-connect-ai-page)). These pages are on `insulinapps.com`, but the
navigation's first column is the app's own, so they read as part of the app.

It lists everyone who can use the app in your active organization:

- **With access to** the app: people given this app specifically. App admins change their **Role in** the app (Admin,
  Editor, Viewer or one of the app's custom roles) with **Change**, or take the app away with **Remove**.
- **From the organization**: people whose organization role gives them access, with their role in the app. These are
  changed on the organization's People page, not here.

App admins also see **Invite people to** the app. The person gets that app only, with the role chosen:

- someone who already has specific apps in the organization gets the app at once, with no e-mail;
- someone new gets an e-mail with a link, valid for 7 days;
- a member with an organization role already has every app, so inviting them here is refused.

Everyone who can use the app can open its people page and see who else uses it. Only app admins see the forms.

![An app's People page with the people given the app, the people with access from their organization role, and the invite form](/docs/assets/screenshots/platform-app-people.png "Cap Table's People page")

## Changing and removing people

- **Change someone's access** on the organization's People page with **Change access**. Moving someone from specific
  apps to an organization role drops their per-app roles; moving them to specific apps needs at least one app.
- **Remove someone from the organization** with **Remove** on the organization's People page. Their AI agents lose access
  to the organization at once.
- **Remove someone from one app only** on that app's People page, if they have specific-apps access. If it was their last
  app, they leave the organization.
- **Admins can't touch owners**: they can't invite, change or remove an owner, or give the Owner role.

Every change is checked again against your current role at the moment it is saved. If your role was lowered or you
were removed while the page was open, nothing changes.

## Who can be invited

By default, owners and admins can invite anyone, at any e-mail address. An owner can limit invitations to the
organization's **verified domains**: the e-mail domains it has proved it owns, under **Single sign-on** (see
[Sign-in and security](/docs/platform/sign-in-and-security#step-1-verify-your-domain)). It is off by default.

The setting is under **Invitations** on the **Organization** page (`https://insulinapps.com/settings/organization`), for
owners only:

- Until the organization has a verified domain, the card explains that you can limit invitations to your own e-mail
  domains once you verify one under **Single sign-on**.
- With a verified domain, it shows **Any address** and **Invite only my verified domains**. Choose it to turn the limit
  on; **Allow any address** turns it off again.

![The Organization page with the organization's name, the Invitations card and Leave](/docs/assets/screenshots/platform-organization.png "The Organization page")

While the limit is on:

- every new invitation, from the organization's People page or from an app's, must be for an address in one of the
  domains verified right now. Others are refused with "This organization only invites people with an address in its
  verified domains";
- an invitation sent earlier to another address can no longer be accepted: the person sees the same message;
- people who are already members keep their access, and an app admin can still give an existing member with specific
  apps another app;
- if no verified domain is left, nobody can be invited until an owner verifies a domain or turns the limit off.

SCIM provisioning and single sign-on already work only for addresses in verified domains.

## Leaving an organization

Go to the **Organization** page (`https://insulinapps.com/settings/organization`) and choose **Leave this
organization**. You lose access to it in every app, and your AI agents' access there ends. A member who manages the
organization can invite you again. The only owner can't leave: make another member an owner first, or delete the
organization.

## Renaming and deleting an organization

Both are on the **Organization** page, for owners only.

- **Rename**: change the **Organization name** and choose **Rename**.
- **Delete**: under **Danger zone**, type the organization's name exactly as shown and choose **Delete organization**.
  This removes the organization, its people, roles, invitations and connections from Insulin Apps sign-in. Apps keep the
  data they stored for it, but nobody can reach that data again, because the organization's id is never issued again.
  This can't be undone. To remove an app's data, delete it in the app first.

## Limits

| Limit | Value |
|---|---|
| Members per organization | 100 |
| Pending invitations per organization | 50 |
| Invitation e-mails per organization per day | 30 |
| Resending one invitation | once every 10 minutes |
| How long an invitation is valid | 7 days |
| Organizations per owner e-mail domain (by address at public mail providers like `gmail.com`) | 2; [ask support for more](/docs/platform/getting-started#how-many-organizations-you-can-create) |
| Custom role name / description | 60 / 200 characters |
| Organization name | 80 characters |
