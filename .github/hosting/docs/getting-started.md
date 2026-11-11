---
title: Getting started
description: Create an Insulin Apps account, set up your organization, invite your team and open your first app.
order: 1
---

This page takes you from nothing to a working organization: an account, an organization, your teammates invited with
the right access, and your first app open. It is written for whoever sets up Insulin Apps for a team, usually a founder
or an operations, finance or IT lead. Each step takes a minute or two.

Insulin Apps is one place to sign in for every app on `insulinapps.com`. You sign in once at `https://insulinapps.com`,
and the same account, organization and teammates work in every app, such as [Cap Table](/docs/captable/overview) and
[E-sign](/docs/esign/overview). Each app runs at its own address, like `https://captable.insulinapps.com`.

![The Insulin Apps landing page, with Create an account and Sign in buttons above the list of apps](/docs/assets/screenshots/platform-landing.png "The landing page at insulinapps.com")

## The words you need

- **Account**: you, signed in with an e-mail address. One account can belong to several organizations.
- **Organization**: a shared workspace for a team or company, such as "Northwind Robotics". Data in an app belongs to
  an organization, and one organization never sees another's.
- **Role**: what you may do. Most people get an organization role (Owner, Admin, Editor or Viewer) that applies in every
  app. Others get access to specific apps only, with a role in each. See
  [Organizations and roles](/docs/platform/organizations-and-roles).

## Step 1: Create your account

You can create an account in three ways. Use the one your company prefers.

### With your e-mail address and a password

1. Go to `https://insulinapps.com` and choose **Create an account**.
2. Enter your **Name**, your **Email address** and a **Password** of at least 10 characters.
3. Complete the security check, then choose **Create account**.
4. You see **Check your inbox**. Open the e-mail from Insulin Apps and follow its link.
5. On **Confirm your email**, choose **Confirm my email**. You are signed in.

The confirmation link works once and expires after 24 hours. If it has expired, or the e-mail never arrived, choose
**ask for a new confirmation link** on the **Check your inbox** page, or go to **Sign in**: if your password is right but
the address isn't confirmed yet, you are offered **Send a new link**.

![The Create an account form with Name, Email address and Password fields and a Continue with Google button](/docs/assets/screenshots/platform-sign-up.png "Create an account")

### With Google

On **Create an account** or **Sign in**, choose **Continue with Google** and pick your Google account. If you don't have
an Insulin Apps account yet, one is created for you, already confirmed. If you already have an account with the same
e-mail address, Google is linked to it, and from then on either way signs you in.

### With your company's single sign-on

If your company has set up single sign-on (SSO) with Insulin Apps, choose **Sign in** and then **Sign in with SSO**,
enter your **Work email address** and choose **Continue**. You sign in with your company's identity provider, and you
join your company's organization automatically. See [Sign-in and security](/docs/platform/sign-in-and-security) for how
an owner sets this up.

![The Sign in page with Email address and Password fields, Continue with Google, and Sign in with SSO](/docs/assets/screenshots/platform-sign-in.png "Sign in")

> [!TIP]
> Once you are in, turn on two-step sign-in under **Account** → **Security**. It takes a minute with an authenticator
> app on your phone, and a stolen password is then no longer enough to get into your account.

## Step 2: Create your organization

If someone has already invited you, skip to [Step 4](#step-4-accept-an-invitation): you join their organization instead.

1. When you are signed in, choose **Create an organization**. Before you belong to any organization, your home page
   offers it. It is also in the organization menu at the top of the navigation (see [Your home page and the
   organization menu](#your-home-page-and-the-organization-menu)). You can also go to
   `https://insulinapps.com/orgs/new`.
2. Enter the **Organization name**, for example "Northwind Robotics". You can rename it later.
3. Choose **Create organization**.

You are the organization's **Owner**: you can do everything, in every app. The new organization becomes your active
organization, and you land on its **People** page.

![The Create an organization form with the Organization name field](/docs/assets/screenshots/platform-new-organization.png "Create an organization")

### How many organizations you can create

There can be at most **two organizations per owner email domain**. The count goes by the domain of the address of the
person who created each organization: everyone at `example.com` shares two. For public mail providers like `gmail.com`,
it goes by address instead, so each person there has their own two. Deleting an organization frees its place.

To have more, ask support. Once your domain has two, **Create an organization** shows **Request more organizations**
instead of the usual form:

1. Enter the **Organization name you want** and, under **Why you need it**, a few words about what it is for.
2. Choose **Send request**.

The request goes by e-mail to Insulin Apps support, with your name, your e-mail address, your e-mail domain and how many
organizations it has. Support replies to your address. Once they have raised the limit, you create the organization
yourself, as above. You can send three requests a day. If the site has no address for these requests, the page shows
who to contact instead.

![The Request more organizations form with the organization name wanted and why it is needed](/docs/assets/screenshots/platform-request-organizations.png "Asking for more organizations")

## Step 3: Invite your team

Owners and admins invite people from the organization's **People** page, at `https://insulinapps.com/settings/users`.

1. Open **People**, under **Settings** in the navigation on the left of `insulinapps.com`.
2. Under **Invite people**, enter the person's **Email address**.
3. Choose their **Access**:
   - an organization role, **Owner**, **Admin**, **Editor** or **Viewer**, which applies in every app; or
   - **Specific apps**, then under **Apps, for "Specific apps" access** choose a role for each app they need (**Admin**,
     **Editor**, **Viewer** or a custom role) and leave **No access** on the others.
4. Choose **Send invitation**.

The person gets an e-mail with a link. An invitation is valid for 7 days. Until it is accepted, it is listed under
**Pending invitations**, where you can **Resend** it (once every 10 minutes) or **Revoke** it.

![The People page with the member list, the Invite people form and Pending invitations](/docs/assets/screenshots/platform-people.png "The People page of an organization")

Which access should you choose? A quick guide:

| The person | Give them |
|---|---|
| A co-founder or someone who manages the whole setup | **Owner** |
| Someone who manages people and integrations | **Admin** |
| Someone who does the day-to-day work in every app | **Editor** |
| Someone who only needs to look, such as a board member | **Viewer** |
| An outside lawyer who only needs E-sign, or an employee who only needs to see their own equity | **Specific apps** |

Admins can invite anyone except owners. The details are in
[Organizations and roles](/docs/platform/organizations-and-roles).

> [!NOTE]
> Each app decides what its roles mean. For example, in Cap Table a **Viewer** sees only their own holdings, matched by
> their e-mail address. Check the app's own docs before you choose.

## Step 4: Accept an invitation

If you were invited:

1. Open the e-mail "… invited you to … on Insulin Apps" and choose **Open the invitation**.
2. If you aren't signed in, choose **Create an account** or **Sign in**, using the address the invitation was sent to.
   The invitation is tied to that address: signed in as someone else, you are asked to sign out first.
3. On **You're invited**, check the organization and the access offered, then choose **Accept invitation**.

You join the organization, and it becomes your active organization. Invitations also show on your home page, under
**Invitations**, with **Accept** and **Decline** buttons. If the link says **This invitation is no longer valid**, it has
expired, was revoked or was already answered: ask the person who invited you to send a new one. If it says the
organization only invites people with an address in its verified domains, its owners have limited invitations to their
company's e-mail domains: ask them about it.

![The You're invited page showing who invited you, the organization, the access offered and the Accept invitation button](/docs/assets/screenshots/platform-invitation.png "Accepting an invitation")

## Step 5: Open an app

Your home page at `https://insulinapps.com`, **Apps in** your active organization, shows the apps you can use there.
Choose the app's **Open** button on its card (for example **Open Cap Table**), or go straight to its address, such as
`https://captable.insulinapps.com`.

![The signed-in home page, Apps in Northwind Robotics, with a card for Cap Table and one for E-sign](/docs/assets/screenshots/platform-home.png "Your home page")

Inside an app, the same navigation runs down the left: the organization menu at the top (with **All apps**, to come
back here), the app's own pages, then **Docs** and **Settings**, whose pages are the app's **People**,
**Integrations**, **API access** and **Connect AI**, and you at the bottom, with **Account** and **Sign out**. An app
without this navigation shows a small account bar from Insulin Apps instead, with the same links.

The first time you open an app, it may ask you to set it up for your organization. For example, Cap Table asks how to
start your company's records. The app's own docs explain this: [Cap Table](/docs/captable/overview),
[E-sign](/docs/esign/overview).

If you see **You don't have access to** an app, your access in that organization is to specific apps only, and that app
isn't one of them. Ask one of the organization's owners or admins.

## Your home page and the organization menu

Once you are signed in, `https://insulinapps.com` is your home page. It shows:

- **Apps in** your active organization: a card for each app you can use there, with a button to open it. With access
  to specific apps, you see only those apps.
- **Invitations** waiting for your address, if any, with **Accept** and **Decline**.
- If you don't belong to any organization yet, **You're not in an organization yet**, with **Create an organization**.

The navigation on the left of every page, once you are signed in, holds:

- at the top, the **organization menu**: your active organization's name and your role. Open it to see your
  organizations, with your role in each and a check mark next to the active one; choose another organization to switch
  to it; go to **All apps** (this home page); or **Create an organization**;
- **Home**, this page;
- **Apps**: the apps you can use in the active organization, each opening on its own address;
- **Settings**: the organization's **People**, **Roles** (for everyone with an organization role), **Organization**
  and, for owners, **Single sign-on**;
- **Docs**, these pages;
- at the bottom, you: your initials and name, opening **Account** and **Sign out**. **Account** has its own pages,
  **Profile**, **Security** and **AI agents**, in a second column.

**Collapse**, above your name, narrows the navigation to its icons (point at one to see its name), and the button at
the top of the second column does the same for that column. Your browser remembers the choice. On a phone, the menu
button at the top opens the whole navigation.

![The home page with the organization menu open at the top of the navigation, listing two organizations, All apps and Create an organization](/docs/assets/screenshots/platform-org-menu.png "The organization menu")

## Switching organizations

Every app opens in your **active organization**. If you belong to more than one:

- open the organization menu at the top of the navigation, on `insulinapps.com` or inside an app, and choose another
  organization; or
- inside an app with the account bar instead, use its **Organization** list and choose **Switch**.

The app then shows that organization's data. Apps keep each organization's data apart.

## What to do next

- Set up roles that fit your team: [Organizations and roles](/docs/platform/organizations-and-roles).
- Protect your account and your organization: [Sign-in and security](/docs/platform/sign-in-and-security).
- Let an AI agent such as Claude Code or Codex work in an app for you: open the app's **Connect AI** page, and see
  [AI agents](/docs/platform/ai-agents).
- Connect your own software to an app: [API access with OAuth clients](/docs/platform/api-and-service-accounts).
- Learn an app: [Cap Table](/docs/captable/overview), [E-sign](/docs/esign/overview).
