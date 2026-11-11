---
title: Cap Table overview
description: What Cap Table does, who it is for, what it leaves to other tools, and how it runs on Insulin Apps.
order: 1
---

Cap Table is your company's equity record. This page explains what it keeps track of, who it is for, what it
deliberately doesn't do, and how it fits into Insulin Apps. Read it first if you are deciding whether Cap Table suits
your company, or if you are an AI agent that needs the big picture before calling its API.

## What Cap Table does

Cap Table keeps track of who owns what in a private company: shares, stock options, warrants and SAFEs. It records how
each holding came about and how it vests, and it lets every holder see their own holdings and nobody else's.

- **The cap table, as of any date.** Issued and outstanding shares, fully diluted ownership, every share class and
  equity plan, and every holder's position, worked out from the full history for whichever date you pick.
- **Set up by import.** Import Pulley's standard reports, or fill in the Cap Table spreadsheet template. You check a
  plain-language preview, then import your cap table in one step.
- **Stakeholders.** Founders, employees, advisors, investors and institutions, with their details and e-mail
  addresses.
- **Option grants and vesting.** Record a signed ISO or NSO grant from an equity plan, with its vesting schedule and
  exercise price. Cap Table works out vesting, what can be exercised, and every deadline.
- **Exercises.** Record an exercise a holder reports, with the payment, the fair market value and the tax details. Cap
  Table creates the resulting shares.
- **Terminations.** Stop vesting when someone leaves, today or on a future date. Cap Table shows what is cancelled,
  what goes back to the pool, and how long the person has to exercise.
- **409A valuations.** Record each valuation. Cap Table tracks when it expires or needs review, and won't price a new
  grant without a valid one (or counsel's memo).
- **Documents.** Keep agreements, board consents, certificates and valuation reports with the records they belong to,
  and choose which ones a holder can see.
- **Reports.** Download the cap table, the raw cap table, stakeholders, vesting details, exercise history and the audit
  log.
- **A permanent history.** Every change is recorded with who made it and when. A mistake is corrected by reversing the
  change, never by rewriting history.
- **Built-in Docs.** **Docs**, in everyone's navigation, explains how to use Cap Table and covers the basics of equity,
  with a glossary.

![The Cap Table dashboard of a fictional company, with company totals, plan usage and a Needs attention card](/docs/assets/screenshots/captable-dashboard.png "The dashboard of a company imported from the spreadsheet template")

## Who it is for

Cap Table is for private companies that keep their own equity records: founders, and the finance, legal or people team
who look after the cap table. Companies leaving Pulley can import Pulley's reports directly; everyone else fills in the
spreadsheet template.

Everyone who holds equity (employees, former employees, advisors and investors) can be given a view of their own
holdings. They see their shares, options, warrants and SAFEs, their vesting, their deadlines and the documents you
share with them. They never see the full cap table, other holders or ownership percentages.

## What Cap Table doesn't do

Cap Table is a record, not a full equity platform. Knowing its limits up front saves surprises.

- **Classes, plans and holdings come in with the import.** Share classes, equity plans, issued shares, option grants,
  warrants and SAFEs are set up by importing Pulley's reports or the spreadsheet template into a new company. After
  that, Cap Table records new option grants, exercises, terminations and cancellations. It has no forms to add share
  classes or plans, or to issue shares.
- **No e-mail.** Cap Table doesn't send messages. Tell people yourself when something changes for them.
- **No signatures or payments.** Agreements are signed elsewhere and uploaded. Payments happen outside the app and are
  recorded in it.
- **No background jobs.** Scheduled terminations and option expiries take effect when an owner, admin or editor opens
  the dashboard, or chooses **Process due items** there.
- **Not a valuation, tax or legal service.** Cap Table records 409A valuations but doesn't perform them. It doesn't file
  tax forms or give advice.
- **One company per organization.** Each Insulin Apps organization has one company in Cap Table. Switching
  organizations switches the company Cap Table opens.
- **Not supported:** RSUs, SARs, phantom stock, convertible notes and profits interests.

## How it runs on Insulin Apps

Cap Table runs at `https://captable.insulinapps.com`. It has no sign-in screens, passwords or accounts of its own.

1. You create an account and an organization at `https://insulinapps.com`, and invite your team there. See
   [Getting started](/docs/platform/getting-started).
2. Each person gets a role: an organization role (Owner, Admin, Editor or Viewer) that reaches every app, or access to
   Cap Table alone with a role in it. An organization owner can also make custom roles for Cap Table. See
   [Organizations and roles](/docs/platform/organizations-and-roles) and
   [Roles and access in Cap Table](/docs/captable/roles-and-access).
3. When someone opens Cap Table, the platform signs them in and tells Cap Table who they are, which organization they
   act in and what their role allows. Cap Table keeps each organization's company apart from every other one.
4. AI agents connect to `https://captable.insulinapps.com/mcp`, set up from Cap Table's **Connect AI** page, and other
   systems call `https://captable.insulinapps.com/api/...` with an OAuth client from its **API access** tab. Both act
   with a role, exactly like a person. See [AI agents](/docs/platform/ai-agents),
   [API access with OAuth clients](/docs/platform/api-and-service-accounts) and
   [Cap Table's API](/docs/captable/api).

Cap Table is open source under the MIT License. The same app can also be started from a template in the Insulin
console, where it runs with the console's own sign-in.

## Where to go next

| If you want to | Read |
|---|---|
| Set up your company and import your cap table | [Setting up Cap Table](/docs/captable/setting-up) |
| Record grants, exercises, terminations and valuations | [Everyday tasks](/docs/captable/everyday-tasks) |
| Decide who sees what | [Roles and access](/docs/captable/roles-and-access) |
| Connect an AI agent or another system | [API](/docs/captable/api) |
| Learn the basics of equity | [Equity basics](/docs/captable/equity-basics) and the [Glossary](/docs/captable/glossary) |
| Understand how the record works | [How it works](/docs/captable/how-it-works) |
