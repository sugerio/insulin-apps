# Using Cap Table

Everyday tasks for owners and admins. Editors can see everything described here but can't change anything. Holders see
only their own holdings: see [The holder view](#the-holder-view).

To set up a company in the first place, see [Importing your cap table](importing.md).

- [Finding your way around](#finding-your-way-around)
- [Processing due items](#processing-due-items)
- [Stakeholders](#stakeholders)
- [Share classes and equity plans](#share-classes-and-equity-plans)
- [Recording an option grant](#recording-an-option-grant)
- [Vesting](#vesting)
- [Exercises and exercise requests](#exercises-and-exercise-requests)
- [Cancellations and expiry](#cancellations-and-expiry)
- [Terminations](#terminations)
- [409A valuations](#409a-valuations)
- [Certificates](#certificates)
- [Documents](#documents)
- [Reports and exports](#reports-and-exports)
- [Recent activity](#recent-activity)
- [Correcting a mistake](#correcting-a-mistake)
- [The holder view](#the-holder-view)
- [Previewing as a stakeholder](#previewing-as-a-stakeholder)
- [Company settings](#company-settings)
- [Rules worth knowing](#rules-worth-knowing)

## Finding your way around

The sidebar:

- **Dashboard:** company totals, how much of each equity plan is granted, ownership by group, the largest
  stakeholders, recent activity, and **Needs attention**: grants waiting for signatures, scheduled terminations, ISO
  deadlines within 30 days, repurchase windows that are open, the state of your 409A valuation, and expiry runs to
  confirm. While nothing is recorded yet, it offers **Import the cap table** instead.
- **Cap Table:** ownership by stakeholder, and a tab for each kind of security (shares, options, SAFEs, warrants). Pick
  any date under **As of** to see the cap table as it stood that day, and **Download** it as a spreadsheet. Under it:
  **Share Classes**, **Equity Plans**, **Securities Status** (lists that need attention) and **Vesting** (the vesting
  schedules in use).
- **Compliance & Tax:** your 409A valuations.
- **Hire and Retain:** **Exercise Requests**, **Equity Plans** and **Stakeholder Portal** (what holders see).
- **Stakeholders.**
- **Company:** **Profile & Settings**, and under it **Documents**, **Reports** and **Recent Activity**.
- **Certificates**, with **Legends** and **Terms**.
- **Docs**, last, in a section of its own: how to use Cap Table, what holders see, and the basics of equity (vesting,
  ISOs and NSOs, 409A valuations, SAFEs, dilution and more), with a glossary. Holders have **Docs** in their navigation
  too, and the setup page links to it as **Learn about cap tables**.

**+ New** at the top of the sidebar records a signed option grant. Most other changes are made from the page of the
thing they concern: record an exercise from the option, terminate someone from their stakeholder page, and so on.
Before anything is saved, Cap Table shows a review of exactly what will change, including any problem that stops it.

Your name and role are in the menu at the top right. If you also hold equity, **My portfolio** there opens your own
holder view.

## Processing due items

Cap Table has no background scheduler. Two kinds of work fall due on a date:

- **scheduled terminations** whose date has arrived;
- **expiries:** options past their last exercise day, and warrants past their expiration date.

Opening the dashboard as an owner or admin processes anything that has fallen due (once expiry is automatic, up to 10
expiries per visit). You can also choose **Process due items** on the dashboard's Needs attention card at any time; it
handles everything due and says what it did ("Due items processed: 1 scheduled termination recorded, 2 expiries waiting
for review.", or "Nothing was due."). It's always safe to run: it never does the same thing twice. If nobody opens the app for a while, due items simply wait, so open it on or soon after important
dates, such as a scheduled termination.

**Expiries are proposed first.** A new company starts in report-only mode: processing records what it would expire as
an **expiry run**, and the dashboard shows "Expiry run to confirm". Open it, review what would be cancelled, and confirm.
When you confirm, you can switch expiry to automatic; from then on, processing due items cancels expired options and
warrants itself.

## Stakeholders

A stakeholder is anyone who holds, or held, equity: a person or an institution.

- **Add a stakeholder** (on **Stakeholders**): individual or institution, the legal name, the name to show, one or more
  relationships (founder, employee, officer, board member, advisor, consultant, investor, other), and any of: e-mail
  addresses, hire date, phone, address, country of tax residence, external ID.
- **E-mail addresses.** On a stakeholder's page, **Add e-mail** adds their own address, an authorized contact (for an
  institution), or a representative (for example for an estate, with a name, a role and the authorizing document).
  **Remove** takes one off. The person's own address is what connects them to the holder view: it must be the address of
  their Insulin console account. If the address is already on another stakeholder, Cap Table warns you and asks you to
  confirm.
- **Edit stakeholder** changes the details; a name change shows everywhere at once. A change of owner is not an edit,
  it's a transfer, which the app doesn't record.
- **Leave of absence:** record it from **Edit stakeholder** (start, end, whether return is guaranteed). A long leave
  without a guaranteed return can move an ISO deadline.
- **Duplicates:** if the same person or institution appears twice, use **Merge into another stakeholder…**. The preview
  shows both records and the combined result. A merge never changes a number: it is refused if it would. **Undo
  stakeholder merge** reverses it.

## Share classes and equity plans

- **Share Classes:** authorized and outstanding shares, what's reserved and what's left to issue, and each class's terms
  (type, par value, issue price, conversion ratio, liquidation preference, seniority, voting).
- **Equity Plans:** plan size, available to grant, outstanding and retired, the default exercise windows after someone
  leaves, and the **return-to-pool rules**: for each of cancelled unvested awards, expired vested options, repurchased
  unvested shares, repurchased vested shares and shares withheld for tax, whether they go back to the pool or are
  retired.
- Both are view only. Share classes and plans, with their terms, come in with the import; the app has no forms to add or
  amend them.

## Recording an option grant

Use this for a grant the board has already approved and both sides have signed: **+ New**, then **Options** under "Add a
signed agreement to the cap table" (or **Add options** in the cap table's Actions). You'll need:

1. **The equity plan.** The form shows what's available; a grant can't exceed it.
2. **The stakeholder**, or add a new one on the spot.
3. **How many options.**
4. **Board approval:** the approval date and the signed board consent (PDF).
5. **Grant date:** the board approval date unless you give another one, with a reason.
6. **ISO or NSO.** An ISO needs the holder to be an employee on the grant date. For someone holding more than 10% of the
   voting power, an ISO needs an exercise price of at least 110% of fair market value and a term of at most five years.
7. **Vesting:** a schedule or explicit tranches, the vesting start date, whether early exercise is allowed, and any
   acceleration terms. Tick that the table shown matches the signed agreement.
8. **Exercise price:** filled in from the 409A valuation valid on the grant date. If no valuation is valid on that date,
   attach counsel's memo to go ahead. An ISO can't be priced below fair market value; an NSO priced below it also needs
   counsel's memo.
9. **Expiration:** ten years unless the agreement says otherwise (five for a 10% holder's ISO).
10. **Terms:** exercise windows after leaving (from the plan, or as the agreement says), securities-law exemptions,
    legends and the grant's ID.
11. **The agreement signed by both the holder and the company.**

Then **Record grant**. The grant is outstanding at once, and the plan's availability goes down.

## Vesting

- **Vesting** lists the schedules in use (percentage, cliff, how often it vests); open one to preview it on a sample
  grant.
- Vesting is calculated from each grant's schedule. Tranches fall on the same day of the month as the vesting start (or
  the month's last day), and the running total is rounded down to the company's share unit (whole shares unless you set
  otherwise), so the last tranche takes any remainder.
- Grants imported from Pulley keep Pulley's exact vesting dates and amounts; grants from the spreadsheet template vest
  monthly, quarterly or annually from their vesting start date.
- Vesting stops when someone leaves (see [Terminations](#terminations)). An acceleration is recorded during the
  termination, with the document that grants it.

## Exercises and exercise requests

### How a holder exercises

Holders don't exercise inside the app. Their **How to exercise** page walks them through it:

1. check how many options they can exercise and until when (shown on the page);
2. complete and sign the notice of exercise (the form you provide) and send it to the company contact;
3. pay the exercise price, and any tax withholding you confirm with them, by bank transfer or check, using the payment
   instructions shown on the page;
4. you record the exercise once both the notice and the full payment have arrived; the new shares then show in their
   portfolio.

### Recording an exercise

Open the option and choose **Record exercise**:

1. **Notice of exercise:** upload the signed notice and the date you received it.
2. **Payment:** the amount, the date it arrived, the method (ACH, wire, check or cash) and a reference.
3. **Exercise date:** Cap Table uses the later of the notice date and the full-payment date. It can't be in the future or
   after the option's exercise deadline, unless the deadline is extended (an owner or admin can do that from the same
   page).
4. **Quantity:** at most what is vested and not yet exercised on that date. Unvested options can't be exercised.
5. **ISO check:** ISO shares exercised after the ISO deadline are recorded as NSO, and the page says so.
6. **Fair market value** on the exercise date, from the valuation valid that day; if none applies, enter it with its
   source and a document.
7. **Tax details:** the treatment (W-2, 1099-NEC, or non-US with local payroll) and the withholding collected. These are
   entered, not calculated.
8. **Resulting shares:** their ID; Cap Table creates them as book entries.

Then **Record exercise**. The option goes down, the new shares appear, and the company's capital contribution goes up.
Cap Table doesn't e-mail the holder, so let them know.

### Grants waiting for signatures

A grant that isn't fully signed can't be exercised. Such grants are listed under **Securities Status** (Execution
pending). Once both sides have signed, choose **Mark executed**, upload the signed agreement with the signature dates,
and confirm. If it will never be signed, cancel it with the reason "not executed". Imported grants count as signed.

### Exercise requests

Holders can't request an exercise in the app. **Exercise Requests** has two tabs: **Exercises**, every exercise with its
quantities, cost, payment and tax treatment; and the exercise requests on record, which the import doesn't create, so
that tab is normally empty.

## Cancellations and expiry

- **Cancel options or warrants** from the security's page (**Cancel**), from the cap table's Actions (**Cancel options**,
  **Cancel warrants**, several at once), or from Securities Status: the date, the quantity (all of it, or part), the
  reason (holder waiver, not executed, mutual agreement, or forfeiture under the agreement) and a document. The review
  shows what goes back to the pool.
- **A mistake is not a cancellation.** If something was recorded wrongly, reverse it (see
  [Correcting a mistake](#correcting-a-mistake)).
- **Expiry:** options past their last exercise day and warrants past their expiration date are handled when due items
  are processed (see [Processing due items](#processing-due-items)).
- Issued shares are never "cancelled" in Cap Table.

## Terminations

From the stakeholder's page, choose **Terminate stakeholder**:

1. **Termination details:** the termination date (today, a past date, or a future date to schedule it), the type
   (voluntary, involuntary, with cause, death, disability, retirement), the date vesting stops (the termination date
   unless you choose an earlier one; never later), and the new relationship (ex-employee unless you say otherwise). For
   disability, say whether it is permanent and total; that affects only the ISO deadline.
2. **Vesting outcome:** for each security, what has vested by the stop date and what will be cancelled. Add an
   acceleration here if the person is entitled to one, with the document.
3. **Exercise and repurchase windows:** for each option, the **exercise deadline** (from the grant or the plan, for this
   type of termination, never past the option's expiration) and the **ISO deadline** (normally three months after the
   termination, twelve for a permanent and total disability, none after death, and never later than the exercise
   deadline). An extension agreed in a separation agreement is recorded here with that agreement.
4. **Review**, then **Terminate** or **Schedule termination**.

A **scheduled** termination shows the person as terminating until the date. Their vesting continues until then. It is
applied when due items are processed on or after the date. Until then you can cancel it, from the stakeholder's page or
from Securities Status.

To undo a termination that has been applied, use **Reverse termination** on the stakeholder's page.

## 409A valuations

On **Compliance & Tax**:

- **Record FMV** records a valuation: the provider, the effective date, the expiration date (twelve months later unless
  you change it), the fair market value per share class (common at least), and the report (PDF).
- Each valuation shows a status: **presumptively valid**, **expiring soon** (60 days or less left), **review required**,
  **superseded** (a later valuation took effect) or **expired**.
- **Flag a material event** (for example a new financing or a secondary sale) with its date and a description. The
  valuation then needs review, and new grants are blocked until you record a new valuation or use **Record written
  confirmation** to record that the provider or counsel confirmed the old one still holds. A flag raised by mistake can be
  reversed.
- A recorded valuation is never edited. If one is wrong, record a corrected valuation, or **Void valuation**.

## Certificates

**Certificates** lists the share certificates on record (number, holder, class, quantity, issue date, status); the
import creates one for each share lot. **Legends** lists the legends used on shares, and **Terms** the certificate terms of
each class. Cap Table doesn't generate or sign certificates; shares it creates, such as the shares from an exercise, are
book entries.

## Documents

- **Upload** PDF, Word (.docx), Excel (.xlsx), PNG, JPEG, CSV or plain-text files, up to 10 MiB each, on **Documents** or
  from the record a document belongs to. Each file is stored with a SHA-256 checksum in the app's own database.
- On a document's page: **Link to a record** (a grant, a stakeholder, a valuation, a plan), **Move to a folder**, **Edit
  details**, **Upload new version** (the earlier versions stay) and archive. Archiving hides a document from the lists
  and the portal; it can be restored, and nothing is ever deleted. **Create folder** is on the Documents page.
- **Who can see it.** A document linked to one holder can be shown in that holder's portal or hidden. A holder's own
  grant agreements, stock purchase agreements, notices of exercise and certificates are shown by default. A document for
  every holder (the plan, the notice of exercise form, an FAQ) is a company resource, published from **Stakeholder
  Portal**. A document linked to two or more holders can't be shown to holders, so one person's papers never reach
  another.

## Reports and exports

**Reports** offers:

| Report | Formats | Choose |
|---|---|---|
| Cap table | Excel | as of a date |
| Raw cap table (one row per security) | CSV or Excel | as of a date |
| Stakeholders | CSV or Excel | as of a date |
| Vesting details | Excel | as of a date |
| Exercise history (with the payroll details) | Excel | |
| Audit log | CSV | |

Each report except the audit log is also available as JSON. Exports include personal details (e-mail addresses, phone
numbers, addresses); everyone who can open Reports is allowed to see them. Every download is recorded in the activity
log.

## Recent activity

**Recent Activity** lists every change: what changed (before and after), who made it, and when. Imported records show as
imported. Nothing in it can be edited or removed.

## Correcting a mistake

Cap Table never edits history. To correct something, an owner or admin **reverses** the change that recorded it, giving a
reason, and then records it again correctly if needed.

- A reversal undoes the whole change: reversing an exercise removes the exercise and the shares it created together.
- You can reverse a grant, an exercise, a termination, a cancellation, a Mark executed, or a merge. The buttons are on
  the security's page (**Reverse last transaction**, **Reverse the exercise**) and on the stakeholder's page (**Reverse
  termination**, **Undo stakeholder merge**).
- If something later depends on it (an exercise from a grant, say), reverse that first. The reversal preview shows what
  depends on what.
- The original stays visible in the history, marked as reversed, with who reversed it, when and why.
- A 409A valuation isn't reversed: record a corrected one, or void it.
- Imported history isn't reversible in the app.

## The holder view

Holders open Cap Table from the Insulin console like everyone else. To give someone access:

1. make sure their stakeholder record has, as their own address, the e-mail address of their Insulin console account;
2. give them the **User** or **Viewer** role on the app in the console.

They then see their shares, options, warrants and converted SAFEs; vesting progress and upcoming vesting dates; for each
option what they can exercise now and until when; the **How to exercise** page; their documents and the company
resources; and **Docs**, which opens for them on a topic written for holders. They never see the cap table, other holders or ownership percentages. One person can be matched to more than
one stakeholder (for example someone who also manages an investing entity); they see all of them.

**Stakeholder Portal** (under Hire and Retain) decides what holders see:

- the **company contact** shown on every page;
- the **holder documents**: company resources every holder can open, such as the plan;
- the **notice of exercise form** and the **privacy notice**;
- the text of the **How to exercise** page.

The **payment instructions** for exercises (bank details, check payee and the reference to quote) are set on **Company ›
Profile & Settings**. Holders see them only inside the app; editors see them masked.

## Previewing as a stakeholder

Open any stakeholder and choose **Preview as stakeholder** to see exactly what they see, with a banner saying "You are
previewing the portal as" their name; every portal action is disabled. It's the quickest way to check a holder's view
after an import or a change.

## Company settings

**Company › Profile & Settings** has the **Company Profile** (company name, legal name, state of incorporation,
incorporation date, time zone, fiscal year end, EIN, share unit, address), the **Company contact for holders**, the
**Display** settings (how many decimals to show for share quantities and prices), the **Signatories** (view only) and the
**Payment instructions**. Owners and admins edit them; editors view them.

The time zone decides when "today" starts for vesting and deadlines. The share unit (the smallest fraction of a share)
can't change once the first record is in.

## Rules worth knowing

- **You can't record changes to your own holdings.** If you hold equity, another owner or admin records changes to it, so
  nobody approves their own transactions.
- **Owners and admins need an e-mail address on their console profile** to make changes.
- **Numbers are exact.** Quantities and amounts are never rounded behind your back; percentages and money are rounded
  only for display.
- **Dates are calendar dates** in the company's time zone.
- **Nothing is sent by e-mail** and nothing is signed or paid in the app: tell people yourself, collect signatures with
  your usual tool, and record payments made outside the app.
