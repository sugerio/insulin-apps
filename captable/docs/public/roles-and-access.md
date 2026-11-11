---
title: Roles and access
description: What Admins, Editors and Viewers can do in Cap Table, how custom roles narrow it, and what holders see.
order: 4
---

This page explains who can see and change what in Cap Table. It is for organization owners and admins deciding what
access to give, for holders wondering why they see what they see, and for AI agents working out what their connection
allows. Cap Table has no accounts of its own: it uses the role each person has on Insulin Apps.

## Where roles come from

People, roles and invitations are managed on Insulin Apps, not in Cap Table:

- **An organization role** (Owner, Admin, Editor or Viewer) applies in every app of the organization, Cap Table
  included. Organization owners and admins are Admins in Cap Table.
- **Access to specific apps** gives someone a role in Cap Table alone: Admin, Editor, Viewer or one of Cap Table's
  custom roles.

The organization's people and roles are at `https://insulinapps.com/settings/users` and `/settings/roles`. Cap Table's
own people page is at `https://insulinapps.com/apps/captable/settings/users`, and
`https://captable.insulinapps.com/settings/users` leads there. See
[Organizations and roles](/docs/platform/organizations-and-roles).

## What each role can do in Cap Table

| Role in Cap Table | What they see | What they can do |
|---|---|---|
| **Admin** (and organization Owners and Admins) | The whole company workspace | Everything: set up and import, stakeholders, grants, exercises, terminations, cancellations, valuations, documents, settings, reports, reversals and due items. On Insulin Apps, also Cap Table's people and integrations; organization Owners and Admins also manage its OAuth clients for API access. |
| **Editor** | The whole company workspace | The same changes as an Admin inside Cap Table. Not Cap Table's people or integrations, which belong to the platform. |
| **Viewer** | The holder view | See only their own holdings: the stakeholder records that carry the e-mail address of their account. |

> [!WARNING]
> An Editor changes the cap table just as an Admin does. Give the role only to people you would trust with the whole cap
> table. For read-only access to the whole cap table, use a custom role with **View the cap table** instead.

Some rules apply to everyone who records changes:

- **Making changes needs an e-mail address** on the person's profile, so that every change in the history names who made
  it.
- **Nobody records changes to their own holdings.** Cap Table refuses a change to a stakeholder, or to their holdings,
  when the record carries the e-mail address of the person making it. Someone else who manages the cap table has to
  record it.
- **People who manage the cap table see their own holdings in the cap table itself.** The holder view is for Viewers.

## Custom roles

An organization's owner can make custom roles for Cap Table on `https://insulinapps.com/settings/roles`, from the three
permissions Cap Table declares:

| Permission | Key | Least built-in role that has it | What it allows |
|---|---|---|---|
| **Record changes** | `captable.manage` | Editor | Record and reverse equity changes, run imports and manage documents. Includes viewing the whole cap table. |
| **View the cap table** | `captable.view` | Editor | See the whole cap table, stakeholders, reports and documents, read only. Personal details are shown; bank account numbers and the EIN are partly hidden. |
| **See own holdings** | `portfolio.view` | Viewer | See their own holdings in the holder view, matched by their e-mail address. |

Admins and Editors have all three permissions; Viewers have **See own holdings**. How custom roles behave:

- **Record changes** gives the full company workspace, read and write.
- **View the cap table** without **Record changes** opens the company workspace and changes nothing. Payment
  instructions are shown masked.
- **See own holdings** alone gives the holder view.
- **The levels don't stack.** Someone who can view or manage the whole cap table isn't also shown the holder view.
- **Permissions only narrow.** A custom role can never give more than the built-in role it is based on.
- Cap Table shows "Custom role" under the person's name for anyone whose role was narrowed this way.

There is no owner-only tier inside Cap Table: every change, including the first-run setup, the import, reversals,
merges, deadline extensions and expiry confirmations, needs **Record changes**.

## The holder view

Employees, former employees, advisors and investors open Cap Table like everyone else, with their Insulin Apps account.
With the Viewer role (or a custom role with **See own holdings**), they see:

- **Portfolio:** a summary of their shares, options, warrants and SAFEs, vesting status and upcoming vesting dates, a
  table of their grants and shares, and the company resources. Each SAFE shows its status and, once converted, the
  shares it became.
- **A grant's page:** granted, vested, unvested, exercised and exercisable now, the exercise price, ISO or NSO, the
  expiration date, a vesting timeline, the ISO/NSO split, the exercise windows after leaving, the exercise history and
  the grant's documents.
- **How to exercise:** the company's instructions, the notice of exercise form, who to send it to and how to pay.
- **Documents:** their own documents and the company resources.
- **Docs:** what they see and how to read it, how exercising works, and the basics of equity.

![The holder view of a fictional employee: their options, vesting progress and upcoming vesting dates](/docs/assets/screenshots/captable-holder-view.png "What a Viewer sees: their own holdings, and nothing else")

They never see the cap table, other holders or ownership percentages. If they have left the company, a banner says how
many vested options they can still exercise and until when.

### How holders are matched

- A Viewer sees a stakeholder record when it lists the e-mail address of their account as the person's **own** address
  (not as a contact for an institution). Capital letters don't matter.
- One person can match several records, for example someone who holds equity personally and through a trust. They see
  all of them and can switch between them.
- Someone who matches no record sees **No access**, with a note to ask the company to add their e-mail address to
  their stakeholder record.

### Give a holder access

1. On the holder's stakeholder page, choose **Add e-mail** and add, as their own address, the e-mail address of their
   Insulin Apps account.
2. On Insulin Apps, invite them with the Viewer role: as an organization Viewer, or with access to Cap Table alone as a
   Viewer. See [Getting started](/docs/platform/getting-started).
3. Choose **Preview as stakeholder** on their page to check what they will see.

Cap Table doesn't e-mail holders. Tell them yourself when something changes for them.

## AI agents and API clients

On Insulin Apps, anyone who can use Cap Table can connect an AI agent, such as Claude Code or Codex, to
`https://captable.insulinapps.com/mcp`, with the setup on Cap Table's **Connect AI** page. The organization's owners and
admins can create OAuth clients for other systems on Cap Table's **API access** tab.

- **An AI agent acts with the role and permissions of the person who connected it**, re-checked on every request. If
  the person is demoted or removed, their agent loses that access at once.
- **An OAuth client has the role an owner or admin gave it** (Admin, Editor, Viewer or a custom role). An OAuth client
  with only **See own holdings** sees nothing, because no stakeholder carries its address; give it **View the cap
  table** for read-only access, or **Record changes** to make changes.
- **The same rules apply as in the browser.** Neither can do anything its role can't, and an agent can't record
  changes to its person's own holdings any more than the person can.
- **Their changes are in the history** under the person's or the OAuth client's name, like any other change.

See [AI agents](/docs/platform/ai-agents), [API access with OAuth clients](/docs/platform/api-and-service-accounts) and
[Cap Table's API](/docs/captable/api).

## Before the company is set up

- The first person who can record changes sees **Set up your company**. See [Setting up](/docs/captable/setting-up).
- Everyone else sees **Cap Table isn't set up yet**, with a link to the Docs.
- **Docs** is open to every role at all times, before setup too. It covers getting started, importing, everyday tasks,
  what holders see, equity basics and a glossary.

![Cap Table's built-in Docs, with the list of topics and the Getting started topic open](/docs/assets/screenshots/captable-docs.png "The built-in Docs, open to every role")
