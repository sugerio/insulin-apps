---
title: Everyday tasks
description: Step by step, how owners, admins and editors keep the cap table up to date once the company is set up.
order: 3
---

This page walks through the work of keeping a cap table current: stakeholders, option grants, exercises, terminations,
cancellations, 409A valuations, documents, reports and corrections. It is for people who record changes (owners,
admins, editors, or a custom role with **Record changes**). Someone whose custom role only views the cap table sees
everything described here but can't change anything. Holders see only their own holdings; see
[Roles and access](/docs/captable/roles-and-access#the-holder-view).

## How changes work

- **Review, then confirm.** Before anything is saved, Cap Table shows exactly what will change, including any problem
  that stops it. Some changes ask you to type the record's ID (such as `OPT-33`) to confirm.
- **Start from the record.** **+ New** at the top of the navigation records a signed option grant. Most other changes start
  on the page of the thing they concern: record an exercise from the option, terminate someone from their stakeholder
  page, and so on.
- **Not your own holdings.** If you hold equity, someone else who manages the cap table records changes to it, so nobody
  approves their own transactions.
- **Exact numbers.** Quantities and amounts are never rounded behind your back. Percentages and money are rounded only
  for display. Dates are calendar dates in the company's time zone.
- **Tell people yourself.** Cap Table sends no e-mail, collects no signatures and takes no payments. Use your usual
  tools, and record the outcome here.
- **Everything is logged.** **Recent Activity** lists every change with what changed, who made it and when.

## Finding your way around

Cap Table has the two-column navigation every Insulin app shares. The first column lists Cap Table's sections; when
the section you open has pages of its own, the second column lists them, and the header above each page shows where
you are (for example **Cap Table › Share Classes**). The company workspace's sections, under **Essentials**:

- **Dashboard:** company totals, how much of each equity plan is granted, ownership by group, the largest
  stakeholders, recent activity, and **Needs attention** (grants waiting for signatures, scheduled terminations, ISO
  deadlines within 30 days, open repurchase windows, the state of your 409A valuation, and expiry runs to confirm).
- **Cap Table:** ownership by stakeholder and a tab for each kind of security. Beside it: **Share Classes**, **Equity
  Plans**, **Securities Status** (lists that need attention) and **Vesting** (the vesting schedules in use).
- **Compliance & Tax:** your 409A valuations.
- **Hire and Retain:** **Exercise Requests**, **Equity Plans** and **Stakeholder Portal** (what holders see).
- **Stakeholders.**
- **Company:** **Profile & Settings**, **Documents**, **Reports** and **Recent Activity**.
- **Certificates**, with **Legends** and **Terms**.

Then, for everyone:

- **Docs:** how to use Cap Table, what holders see, and the basics of equity.
- **Settings:** Cap Table's **People**, **Integrations**, **API access** and **Connect AI** pages. They are Insulin
  Apps' pages (`https://insulinapps.com/apps/captable/settings/...`), which open with Cap Table's navigation beside
  them; what you can change there follows your role.
- **The organization switcher** at the top: your organization, the others you belong to (choosing one opens Cap Table
  in it, with that organization's company), **All apps** (your home page on Insulin Apps) and a link to create one.
- **You**, at the bottom: your name and role ("Custom role" when your organization narrowed it), with **Account**,
  **Switch theme** and **Sign out**.

Each column collapses to its icons with the button at its edge, and the item names show as tooltips; Cap Table
remembers the choice in your browser. On a narrow screen, the menu button in the top bar opens both columns.

Each section also has an address of its own on Cap Table's host, which leads to that page of your organization's
company: `https://captable.insulinapps.com/vesting` opens **Vesting**, and `/portfolio/documents` a holder's
**Documents**.

## See the cap table as of a date

1. Open **Cap Table**.
2. Pick a date under **As of**. Cap Table replays the full history up to that day and shows the cap table as it stood.
3. Switch tabs for ownership by stakeholder, or for shares, options, SAFEs and warrants.
4. Choose **Download** to save it as a spreadsheet.

![The Cap Table page of a fictional company, showing ownership by stakeholder with issued and fully diluted columns](/docs/assets/screenshots/captable-cap-table.png "The cap table, as of a chosen date")

**Share Classes** shows authorized and outstanding shares and each class's terms. **Equity Plans** shows plan size,
what is available to grant, outstanding and retired, the default exercise windows after someone leaves, and the
return-to-pool rules. Both are view only: classes and plans come in with the import.

## Stakeholders

A stakeholder is anyone who holds, or held, equity: a person or an institution.

![The Stakeholders list of a fictional company with names, relationships and holdings](/docs/assets/screenshots/captable-stakeholders.png "Stakeholders: everyone who holds or held equity")

### Add a stakeholder

1. Open **Stakeholders** and choose **Add stakeholder**.
2. Choose individual or institution, and enter the legal name and the name to show.
3. Choose one or more relationships: founder, employee, officer, board member, advisor, consultant, investor or other.
4. Add any of: e-mail addresses, hire date, phone, address, country of tax residence, external ID.
5. Review and save.

### E-mail addresses

On a stakeholder's page, **Add e-mail** adds:

- the person's **own address**, which connects them to the holder view: it must be the e-mail address of their Insulin
  Apps account;
- an **authorized contact**, for an institution;
- a **representative**, for example for an estate, with a name, a role and the authorizing document.

**Remove** takes an address off. If the address is already on another stakeholder, Cap Table warns you and asks you to
confirm.

### Edit, leave of absence and duplicates

- **Edit stakeholder** changes the details; a new name shows everywhere at once. A change of owner isn't an edit but a
  transfer, which Cap Table doesn't record.
- **Leave of absence** is recorded from **Edit stakeholder** (start, end, whether return is guaranteed). A long leave
  without a guaranteed return can move an ISO deadline.
- **Duplicates:** if the same person or institution appears twice, use **Merge into another stakeholder…**. The preview
  shows both records and the combined result. A merge never changes a number, and **Undo stakeholder merge** reverses
  it.

## Record an option grant

Use this for a grant the board has already approved and both sides have signed. Choose **+ New**, then **Options** (or
**Add options** in the cap table's actions). You'll need:

1. **The equity plan.** The form shows what's available; a grant can't exceed it.
2. **The stakeholder**, or add a new one on the spot.
3. **How many options.**
4. **Board approval:** the approval date and the signed board consent (PDF).
5. **Grant date:** the board approval date unless you give another one, with a reason.
6. **ISO or NSO.** An ISO needs the holder to be an employee on the grant date. You confirm whether they own more than
   10% of the voting power; if so, an ISO needs an exercise price of at least 110% of fair market value and a term of at
   most five years.
7. **Vesting:** a schedule or explicit tranches, the vesting start date, whether early exercise is allowed, and any
   acceleration terms. Tick that the table shown matches the signed agreement.
8. **Exercise price:** filled in from the 409A valuation valid on the grant date. Without a valid valuation, attach
   counsel's memo to go ahead. An ISO can't be priced below fair market value; an NSO priced below it also needs
   counsel's memo.
9. **Expiration:** ten years unless the agreement says otherwise (five for a 10% holder's ISO).
10. **Terms:** exercise windows after leaving (from the plan, or as the agreement says), securities-law exemptions,
    legends and the grant's ID.
11. **The agreement**, signed by both the holder and the company.

Then choose **Record grant**. The grant is outstanding at once, and the plan's availability goes down.

![The record option grant form for a fictional company, with plan, stakeholder, quantity and vesting fields](/docs/assets/screenshots/captable-record-grant.png "Recording a signed option grant")

### Grants waiting for signatures

A grant that isn't fully signed can't be exercised. Such grants are listed under **Securities Status** (Execution
pending). Once both sides have signed, choose **Mark executed**, upload the signed agreement with the signature dates,
and confirm. If it will never be signed, cancel it with the reason "not executed". Imported grants count as signed.

## How vesting is worked out

- **Vesting** lists the schedules in use (percentage, cliff, how often it vests). Open one to preview it on a sample
  grant.
- Tranches fall on the same day of the month as the vesting start (or the month's last day). The running total is
  rounded down to the company's share unit (whole shares unless set otherwise), so the last tranche takes any remainder.
- Grants imported from Pulley keep Pulley's exact vesting dates and amounts. Grants from the spreadsheet template vest
  monthly, quarterly or annually from their vesting start date.
- Vesting stops when someone leaves. An acceleration is recorded during the termination, with the document that grants
  it.

## Record an exercise

Holders don't exercise inside the app: their **How to exercise** page walks them through sending a signed notice and
paying. Once both the notice and the full payment have arrived, open the option and choose **Record exercise**:

1. **Notice of exercise:** upload the signed notice and the date you received it.
2. **Payment:** the amount, the date it arrived, the method (ACH, wire, check or cash) and a reference.
3. **Exercise date:** the later of the notice date and the full-payment date. It can't be in the future or after the
   option's exercise deadline, unless the deadline is extended (you can do that from the same page).
4. **Quantity:** at most what is vested and not yet exercised on that date. Unvested options can't be exercised.
5. **ISO check:** ISO shares exercised after the ISO deadline are recorded as NSO, and the page says so.
6. **Fair market value** on the exercise date, from the valuation valid that day. If none applies, enter it with its
   source and a document.
7. **Tax details:** the treatment (W-2, 1099-NEC, or non-US with local payroll) and the withholding collected. These
   are entered, not calculated.
8. **Resulting shares:** their ID. Cap Table creates them as book entries.

Then choose **Record exercise**. The option goes down, the new shares appear, and the company's capital contribution
goes up. Cap Table doesn't e-mail the holder, so let them know.

### Exercise requests

Holders can't request an exercise in the app. **Exercise Requests** has two tabs: **Exercises**, every exercise with its
quantities, cost, payment and tax treatment; and the exercise requests on record. The import doesn't create exercise
requests, so that tab is normally empty.

## Terminate a stakeholder

From the stakeholder's page, choose **Terminate stakeholder**:

1. **Termination details:** the termination date (today, a past date, or a future date to schedule it), the type
   (voluntary, involuntary, with cause, death, disability, retirement), the date vesting stops (the termination date
   unless you choose an earlier one; never later), and the new relationship (ex-employee unless you say otherwise). For
   disability, say whether it is permanent and total; that affects only the ISO deadline.
2. **Vesting outcome:** for each security, what has vested by the stop date and what will be cancelled. Add an
   acceleration here if the person is entitled to one, with the document.
3. **Exercise and repurchase windows:** for each option, the **exercise deadline** (from the grant or the plan, never
   past the option's expiration) and the **ISO deadline** (normally three months after the termination, twelve for a
   permanent and total disability, none after death, never later than the exercise deadline). Record an extension
   agreed in a separation agreement here, with that agreement.
4. **Review**, then **Terminate** or **Schedule termination**.

A **scheduled** termination shows the person as terminating until the date, and their vesting continues until then. It
is applied when due items are processed on or after the date. Until then you can cancel it, from the stakeholder's page
or from **Securities Status**. To undo a termination that has been applied, use **Reverse termination**.

## Cancel options or warrants

- **Cancel** from the security's page, from the cap table's actions (**Cancel options**, **Cancel warrants**, several at
  once), or from **Securities Status**. Give the date, the quantity (all or part), the reason (holder waiver, not
  executed, mutual agreement, or forfeiture under the agreement) and a document. The review shows what goes back to the
  pool.
- **A mistake is not a cancellation.** If something was recorded wrongly, reverse it instead (see
  [Correct a mistake](#correct-a-mistake)).
- Issued shares are never cancelled in Cap Table.

## Process due items

Nothing is recorded on a timer. Two kinds of work fall due on a date:

- **scheduled terminations** whose date has arrived;
- **expiries:** options past their last exercise day, and warrants past their expiration date.

Opening the dashboard as someone who records changes processes anything that has fallen due (once expiry is automatic,
up to 10 expiries per visit). You can also choose **Process due items** on the dashboard's Needs attention card at any
time. It handles everything due and says what it did, for example "Due items processed: 1 scheduled termination
recorded, 2 expiries waiting for review." or "Nothing was due." It is always safe to run: it never does the same thing
twice.

If nobody opens the app for a while, due items simply wait, so open it on or soon after important dates.

**Expiries are proposed first.** A new company starts in report-only mode: processing records what it would expire as
an **expiry run**, and the dashboard shows "Expiry run to confirm". Open it, review what would be cancelled, and
confirm. When you confirm, you can switch expiry to automatic; from then on, processing due items cancels expired options
and warrants itself.

## Record a 409A valuation

On **Compliance & Tax**:

1. Choose **Record FMV**.
2. Enter the provider, the effective date, the expiration date (twelve months later unless you change it), the fair
   market value per share class (common at least), and attach the report (PDF).
3. Review and save.

Each valuation shows a status: **presumptively valid**, **expiring soon** (60 days or less left), **review required**,
**superseded** (a later valuation took effect) or **expired**.

- **Flag a material event** (for example a new financing or a secondary sale) with its date and a description. The
  valuation then needs review, and new grants are blocked until you record a new valuation or use **Record written
  confirmation** to record that the provider or counsel confirmed the old one still holds. A flag raised by mistake can
  be reversed.
- A recorded valuation is never edited. If one is wrong, record a corrected valuation, or **Void valuation**.

## Documents and what holders see

### Upload and organize

- **Upload** PDF, Word (`.docx`), Excel (`.xlsx`), PNG, JPEG, CSV or plain-text files, up to 10 MiB each, on
  **Documents** or from the record a document belongs to. Each file is stored with a SHA-256 checksum in Cap Table's
  own database.
- On a document's page: **Link to a record** (a grant, a stakeholder, a valuation, a plan), **Move to a folder**, **Edit
  details**, **Upload new version** (earlier versions stay) and archive. **Create folder** is on the Documents page.
- Archiving hides a document from the lists and the holder view. It can be restored; nothing is ever deleted.

### Who can see a document

- A document linked to one holder can be shown in that holder's view or hidden. A holder's own grant agreements, stock
  purchase agreements, notices of exercise and certificates are shown by default.
- A document for every holder (the plan, the notice of exercise form, an FAQ) is a company resource, published from
  **Stakeholder Portal**.
- A document linked to two or more holders can't be shown to holders, so one person's papers never reach another.

### Set up the holder view

**Stakeholder Portal** (under Hire and Retain) decides what holders see: the **company contact** shown on every page,
the **holder documents** (company resources), the **notice of exercise form** and **privacy notice**, and the text of
the **How to exercise** page. The **payment instructions** for exercises (bank details, check payee and the reference
to quote) are set on **Company › Profile & Settings**. Holders see them only inside the app.

### Preview as stakeholder

Open any stakeholder and choose **Preview as stakeholder** to see their holdings, exercise instructions and documents
as they see them, with a banner saying "You are previewing the portal as" their name. Every portal action is disabled.
It is the quickest way to check a holder's view after an import or a change.

## Download reports

**Reports** offers:

| Report | Formats | Choose |
|---|---|---|
| Cap table | Excel | as of a date |
| Raw cap table (one row per security) | CSV or Excel | as of a date |
| Stakeholders | CSV or Excel | as of a date |
| Vesting details | Excel | as of a date |
| Exercise history (with the payroll details) | Excel | |
| Audit log | CSV | |

Each report except the audit log is also available as JSON through the API. Exports include personal details (e-mail
addresses, phone numbers, addresses); everyone who can open Reports is allowed to see them. Every download is recorded
in the activity log.

## Correct a mistake

Cap Table never edits history. To correct something, someone who records changes **reverses** the change that recorded
it, giving a reason, and then records it again correctly if needed.

- A reversal undoes the whole change: reversing an exercise removes the exercise and the shares it created together.
- You can reverse a grant, an exercise, a termination, a cancellation, a **Mark executed**, or a merge. The buttons are
  on the security's page (**Reverse last transaction**, **Reverse the exercise**) and on the stakeholder's page
  (**Reverse termination**, **Undo stakeholder merge**).
- If something later depends on it (an exercise from a grant, say), reverse that first. The reversal preview shows what
  depends on what.
- The original stays visible in the history, marked as reversed, with who reversed it, when and why.
- A 409A valuation isn't reversed: record a corrected one, or void it.
- Imported history can't be reversed in the app.

## Certificates and company settings

- **Certificates** lists the share certificates on record (number, holder, class, quantity, issue date, status); the
  import creates one for each share lot. **Legends** lists the legends used on shares, and **Terms** the certificate
  terms of each class. Cap Table doesn't generate or sign certificates; shares it creates are book entries.
- **Company › Profile & Settings** has the **Company Profile** (company name, legal name, state of incorporation,
  incorporation date, time zone, fiscal year end, EIN, share unit, address), the **Company contact for holders**, the
  **Display** settings (how many decimals to show), the **Signatories** (view only) and the **Payment instructions**.
- The time zone decides when "today" starts for vesting and deadlines. The share unit can't change once the first record
  is in.
- **Recent Activity** lists every change: what changed (before and after), who made it, and when. Nothing in it can be
  edited or removed.
