---
title: Setting up Cap Table
description: Create your company in Cap Table, either empty or by importing Pulley's reports or the Cap Table spreadsheet template.
order: 2
---

This page takes you from a new Insulin Apps organization to a working cap table. It is for whoever sets up the
company: a founder, or someone in finance, legal or people operations. It covers the three ways to start, the
spreadsheet template column by column, Pulley's reports, the preview and its problems, and what to do after the import.

## Before you start

1. **Create an account and an organization** at `https://insulinapps.com`, if you haven't yet. See
   [Getting started](/docs/platform/getting-started).
2. **Make sure you can record changes.** You need to be an organization Owner, Admin or Editor, an Admin or Editor of
   Cap Table, or have a custom role with **Record changes**. Your profile also needs an e-mail address, so that every
   change in the history names who made it.
3. **Pick a quiet moment.** If you are coming from Pulley, ask everyone to stop making changes there until you are
   done, so that all the reports describe the same day.

> [!IMPORTANT]
> An import is permanent. Cap Table keeps a permanent history, so an import can't be taken back. Check the preview
> carefully before you choose **Import**. To practise first, create a second organization just for practice and import
> there: each organization has its own company, so nothing you do in it reaches your real one.

## Choose how to start

Open `https://captable.insulinapps.com`. The first person in your organization who can record changes sees **Set up
your company**, with three ways to start:

- **Start with an empty company.** Enter the company's details yourself. You can still import into it later, as long as
  nothing has been added to it.
- **Import from Pulley.** Upload Pulley's standard reports.
- **Import from a spreadsheet.** Fill in the Cap Table spreadsheet template and upload it. **Download the template**
  is next to this choice.

New to cap tables? **Learn about cap tables** on the same page opens the built-in Docs.

![The Set up your company page with three choices: Start with an empty company, Import from Pulley and Import from a spreadsheet](/docs/assets/screenshots/captable-setup.png "Set up your company: the three ways to start")

Everyone else who opens Cap Table before it is set up sees **Cap Table isn't set up yet**, and is asked to wait for an
owner or admin. They can open the Docs meanwhile.

Each organization has its own company. Switching organizations switches the company Cap Table opens, and each
organization sets up or imports its own company independently.

## Start with an empty company

**Start with an empty company** asks for:

| Field | Notes |
|---|---|
| **Company name** | Required, up to 100 characters. |
| **Legal name** | Up to 200 characters. Defaults to the company name. |
| **State of incorporation** | Defaults to Delaware (`US-DE`). |
| **Incorporation date** | Optional. |
| **Time zone** | Required. Decides when "today" starts for vesting and deadlines. |
| **Fiscal year end** | Defaults to December 31. |

Choose **Set up company**. The company opens empty: the dashboard says nothing is recorded yet and offers **Import the
cap table**. You can import into this company as long as it has no stakeholders and no recorded transactions, and none
of these saved yet: documents, document folders, payment instructions, signatories, legends or valuations. The imported
company then takes its place and keeps its name, time zone, fiscal year end and other settings. A currency stated in
the import files takes precedence, so imported and future amounts use the same currency.

## The import, step by step

Both import sources go through the same five steps in your browser, shown along the top of the page:

1. **Choose the source.** Pulley or the spreadsheet. If you picked a source on the setup page, the import starts at the
   next step.
2. **Upload the files.** Drag them onto the page, or choose **Choose files** (Pulley) or **Choose a file** (the
   spreadsheet).
3. **Review the preview.** See exactly what Cap Table will create, and fix any problem.
4. **Import.** One step, all or nothing.
5. **Done.** A summary of what was imported.

There is nothing to install, no command line, and no keys or passwords to look after.

## Fill in the spreadsheet template

Choose **Download the template** on the setup page or in the import. You get `cap-table-template.xlsx`, an Excel
workbook with an **Instructions** sheet, which explains every column with an example, and eight data sheets that each
have one header row. Leave the sheet names and column headings as they are, and save the workbook as `.xlsx`.

### Company

Exactly one row.

| Column | Required | Notes |
|---|---|---|
| Company name | yes | |
| As-of date | yes | The date every balance in the workbook represents. Nothing in the workbook may be dated after it. |
| Currency | no | A three-letter code such as `USD`. Blank means USD. |

### Stakeholders

| Column | Required | Notes |
|---|---|---|
| Stakeholder ID | yes | Your own unique ID. The security sheets use it to name the holder. |
| Name | yes | Up to 200 characters. |
| Type | yes | `Individual` or `Organization`. |
| Relationship | yes | `Founder`, `Employee`, `Investor`, `Advisor`, `Consultant`, `Board member` or `Other`. |
| Email | no | Holders are matched to their account by this address. |
| Termination date | no | For someone who has left. |
| Termination type | with a termination date | `Voluntary`, `Involuntary`, `With cause`, `Death`, `Disability` or `Retirement`. |

### Share classes

| Column | Required | Notes |
|---|---|---|
| Class ID | yes | |
| Name | yes | Up to 100 characters. |
| Type | yes | `Common` or `Preferred`. |
| Authorized shares | yes | The current authorized number. |
| Conversion ratio | no | For preferred classes. Blank means 1. |
| Original issue price | no | Per share. |

### Equity plans

| Column | Required | Notes |
|---|---|---|
| Plan ID | yes | |
| Name | yes | |
| Share class ID | yes | The class an exercised award delivers. |
| Pool size | yes | The plan's current reserved pool. |
| Effective date | yes | |
| Exercise window after termination (days) | no | Whole days a leaver has to exercise. Blank means 90 days. |

### Shares

One row per certificate or share lot.

| Column | Required | Notes |
|---|---|---|
| Certificate ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Share class ID | yes | |
| Plan ID | no | Only for shares that came from exercised options: the plan of the grant. |
| Shares | yes | |
| Issue date | yes | |
| Price per share | yes | |

### Options

One row per grant.

| Column | Required | Notes |
|---|---|---|
| Grant ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Plan ID | yes | |
| Type | yes | `ISO` or `NSO`. Don't guess. |
| Options granted | yes | The total originally granted. |
| Exercise price | yes | Per option. |
| Grant date | yes | |
| Expiration date | yes | Not before the grant date. |
| Vesting start date | yes | |
| Vesting months | yes | The whole term, from 1 to 240 months. |
| Cliff months | yes | `0` for no cliff; never more than the vesting months. |
| Vest every (months) | yes | `1` (monthly), `3` (quarterly) or `12` (annually). The vesting months and the cliff must both be whole numbers of these periods. |
| Early exercise | yes | `Yes` only if the agreement allows exercise before vesting; otherwise `No`. |
| FMV at grant | no | Fair market value per share on the grant date. |
| Exercised | yes | Options already exercised; `0` if none. |
| Vested | no | If you fill it in, Cap Table checks it against the schedule. |
| Vested outstanding | no | Vested and not exercised; checked the same way. |
| Cancelled | no | Options already cancelled; `0` or blank if none. |
| Cancellation date | when Cancelled is more than 0 | |
| Cancellation reason | when Cancelled is more than 0 | `Unvested forfeiture`, `Expired` (vested options are used up first) or `Other` (Cap Table splits the quantity using the schedule). |

### Warrants

| Column | Required | Notes |
|---|---|---|
| Warrant ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Share class ID | yes | The class a holder can buy. |
| Shares | yes | |
| Exercise price | yes | |
| Issue date | yes | |
| Expiration date | yes | |

### SAFEs

| Column | Required | Notes |
|---|---|---|
| SAFE ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Principal | yes | |
| Issue date | yes | |
| Valuation cap | no | |
| Discount % | no | `20` means 20%. |
| Type | yes | `Post-money` or `Pre-money`. |

### Rules for every sheet

- Give every row its own ID. The IDs of shares, options, warrants and SAFEs must also differ from one another.
- Use those IDs to link rows: a Stakeholder ID, Share class ID or Plan ID must match a row on its sheet.
- Write dates as `YYYY-MM-DD`.
- Type numbers exactly, without formulas, with at most 12 decimal places. Excel keeps only 15 significant digits, so
  check very long numbers against your records.
- For each plan, the options exercised must equal the shares that name that plan in **Plan ID**.
- Exercised plus cancelled can't be more than the options granted.
- Include at least one share, option, warrant or SAFE, and at most 2,000 of them in all.

Where the template is silent, Cap Table uses a stated default and lists it in the preview: the empty company's currency
(or US dollars when there is no company yet), a conversion ratio of 1, a 90-day exercise window, unused plan shares
returning to the pool, and no recorded purchase price for warrants.

### A small example

A fictional company, Acme Robotics, Inc., might fill in one row on each of a few sheets:

| Sheet | Example row |
|---|---|
| Company | `Acme Robotics, Inc.` · `2026-10-27` · `USD` |
| Stakeholders | `holder_1` · `Jordan Park` · `Individual` · `Employee` · `jordan@example.test` |
| Share classes | `common` · `Common Stock` · `Common` · `10000000` · (blank) · `0.001` |
| Equity plans | `plan_2024` · `2024 Equity Plan` · `common` · `1000000` · `2024-01-15` · `90` |
| Shares | `CS-1` · `holder_1` · `common` · (blank) · `100000` · `2024-01-15` · `0.001` |
| Options | `OPT-1` · `holder_1` · `plan_2024` · `ISO` · `48000` · `0.25` · `2024-02-01` · `2034-02-01` · `2024-02-01` · `48` · `12` · `1` · `No` · `0.25` · `0` |

The Instructions sheet in the template carries the same examples.

## Export Pulley's reports

In Pulley, export each report below from the **Reports** page as an Excel file (`.xlsx`), all on the same day, without
renaming their columns. There is no need to rename the files: Cap Table recognizes each report by its sheets and column
headings.

| Report | Required | What Cap Table uses it for | What to choose when you export it |
|---|---|---|---|
| **Raw Cap Table** | yes | The backbone: the company, share classes, equity plans, every security and every stakeholder's totals. Cap Table checks its own numbers against it. | As of today. |
| **Detailed Cap Table** | yes | How holdings came about: exercises, cancellations, conversions. Its summary is compared with Cap Table's numbers too. | Nothing special. |
| **Stakeholders** | yes | Names, e-mail addresses, individual or institution, and relationship to the company. | Everyone. |
| **Vesting Details** | yes | Every vesting date and amount, past and future. | All stakeholders, including terminated ones, with dates from before your first grant to after your last scheduled vesting date. |
| **Exercised Options** | yes | Every option exercise. | Nothing special. |
| **ISO/NSO Details** | yes | How each option grant splits between ISO and NSO. | Nothing special. |
| **Stakeholder Transactions** | no | Read for information only; doesn't change any number. | Nothing special. |

Excel files are best. The single-sheet reports can also be uploaded as comma-separated CSV files (dates written as
`2024-06-12` or `6/12/2024`); semicolon-separated CSV isn't recognized.

## Upload the files

On **Upload the files**:

- **Pulley:** all the reports at once, as Excel or CSV files, up to 5 MiB each and 9.9 MiB together, and at most 25
  files.
- **Spreadsheet:** the one workbook (`.xlsx`), up to 5 MiB.

Cap Table refuses a file that breaks these limits and says why. A file with the same name as one you already chose
replaces it. Then fill in, or check, what the preview needs:

- **As-of date:** the date your files describe. You can leave it empty: Cap Table then uses the date the Pulley exports
  state, or the As-of date on the spreadsheet's Company sheet. After a preview it may offer "Use (date), the date your
  files suggest"; it never fills a date in for you.
- **Company timezone, Jurisdiction and Fiscal year end** (only when the import creates the company from the setup page):
  the time zone decides when "today" starts; the jurisdiction is a code such as `US-DE` or `GB`; the fiscal year end is
  a month and day, such as `12-31`. The company's name comes from the files.

Choose **Check the files**. Nothing is added to the cap table until you import.

## Review the preview

**Review the preview** shows what Cap Table is about to create:

- **Files checked:** each file and what it was recognized as.
- **The review summary:** the as-of date and the currency the imported company will use.
- **Problems to fix**, first. Each one blocks the import, says what is wrong, and shows where (file › sheet › row ›
  column).
- **Warnings**, which don't stop the import. Make sure each is what you expect.
- **Opening balances:** securities imported as a starting balance on a date, each with its reason.
- **Assumptions:** the choices Cap Table made where the files leave something open.
- **What will be imported** (stakeholders, share classes, plans, securities and transactions) and **the company after
  the import** (its fully diluted and its issued and outstanding shares).
- **Totals** that the source states, next to the same totals computed from the import, marked **Matches** or
  **Differs**. For Pulley they must match exactly. The spreadsheet states no totals, so check the figures against your
  own records.

![The import preview of a fictional company: files checked, what will be imported and the company after the import](/docs/assets/screenshots/captable-import-preview.png "The plain-language preview after uploading the spreadsheet")

**Import** stays unavailable while any problem remains.

### Opening balances

The sources describe what everyone holds today very well, but they don't always contain every step of how it got there.
For example, the template records how many options were exercised, but not when. When Cap Table can't rebuild a
holding's history step by step, it records the holding as an **opening balance**: the quantity, vesting and status your
files give, without inventing the steps in between. If you look at the cap table as of an earlier date, Cap Table says
that the history before that date came in with the import as opening balances.

## Fix any problems

| Problem | What to do |
|---|---|
| A required Pulley report is missing ("Add Pulley's Vesting Details report.") | Export it and upload the whole set again. |
| A file isn't one of the supported reports, or two files are the same report | Remove the extra file. Make sure each report is a standard Pulley export with its columns unchanged. |
| A grant names a stakeholder who isn't in the Stakeholders report or sheet | Add the stakeholder, or correct the ID. |
| A record is dated after the as-of date, an exercise before its grant, or the as-of date after today | Correct the date in the source, or the as-of date. |
| Pulley's totals differ from the preview's | Usually reports exported on different days, a Vesting Details report without terminated stakeholders or future dates, or options Pulley let lapse without cancelling. Fix it in Pulley and export again. |
| A value has more than 12 decimal places | Round it in the source. Cap Table never rounds behind your back. |
| A name, ID or e-mail address that is too long or not valid | Names up to 200 characters (share classes 100), certificate and grant IDs up to 40, and real e-mail addresses. |
| An instrument Cap Table doesn't support (RSUs, SARs, phantom stock, convertible notes) | Deal with it outside the app first. |
| Shares that Pulley shows as transferred | Pulley's reports don't say which holding each transfer created, so the import stops. The spreadsheet template lets you enter each holder's current shares directly. |
| A repurchase without its date or the amount paid | Add both in Pulley and export again. |
| No securities at all, or more than 2,000 | Add at least one; a larger cap table can't be imported in one go. |
| A template cell that is blank, invalid or not one of the listed choices | The problem names the sheet, row and column. Correct it in the workbook. |

Correct the problem at the source, choose **Upload corrected files**, and **Check the files** again.

## Import

When no problem is left, choose **Import**. Keep the page open until it finishes; Cap Table won't let you leave it in
the middle.

- **When it's done,** "The cap table is imported" lists what was imported, with **Open the cap table** and **Go to the
  dashboard**.
- **If it fails,** nothing becomes visible. The page says "Nothing was imported" with the reason, and you can import
  again.
- **If the connection drops** before the answer arrives, the page says "The import's outcome isn't known yet". Choose
  **Check the import** to find out what happened, or **Try again**: repeating the same import is safe.
- **If the company changed** in the meantime (someone added a stakeholder, for example), or another import is already
  running, the import is refused and nothing changes.

The import happens once. Cap Table won't import into a company that already has stakeholders or records. Once a company
is set up, the import page says "Import isn't available for this company" and why.

## After the import

1. **Spot-check.** Compare **Cap Table** (as of the import's date) with your source. Open a few stakeholders and choose
   **Preview as stakeholder** to see what they will see.
2. **Upload your documents.** Neither source includes files. Upload agreements, board consents, certificates, plan
   documents and valuation reports on **Documents**, link each to its record, and choose which ones holders may see.
3. **Record your current 409A valuation.** The import doesn't bring valuations in, and new grants need a valid one.
4. **Fill in what holders see:** the company contact, the How to exercise text and the payment instructions.
5. **Give holders access.** Make sure each holder's stakeholder record has, as their own address, the e-mail address of
   their Insulin Apps account. Then give them the Viewer role, or a custom role with **See own holdings**. See
   [Roles and access](/docs/captable/roles-and-access).

## What isn't imported

- **Documents and files.** Upload them after the import. Each imported share lot does get a certificate record with its
  number.
- **Valuations.** Record your 409A valuations yourself.
- **Signatures.** Cap Table can't tell which agreements were still waiting for signatures, so imported grants count as
  signed.
- **Some history.** Steps the sources can't express become opening balances. Transfers can't be imported from Pulley's
  reports.
- **Workflow records:** exercise requests, 83(b) elections and notes kept in Pulley.
- **Pulley's own accounts and settings.** People get access to Cap Table through their role on Insulin Apps.

## Where your data goes

- **Only to this app.** Cap Table reads the files you upload and stores what it imports in its own database. Nothing is
  sent to Pulley or any other service, and Cap Table never signs in to Pulley.
- **The files themselves aren't kept.** Each check or import sends the files to Cap Table to be read. It keeps each
  file's name and fingerprint, the import's details, and where each imported record came from (sheet and row), but not
  the files.
- You can delete the exported files from your computer once the import is done.
