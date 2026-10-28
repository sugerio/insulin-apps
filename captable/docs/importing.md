# Importing your cap table

A new company is set up by importing its cap table, from one of two sources:

- **Pulley:** the standard reports you export from Pulley;
- **the Cap Table spreadsheet template:** a workbook you download from Cap Table and fill in, for companies that don't
  use Pulley.

Both go through the same steps in your web browser: upload, review the preview, fix any problems, and click **Import**.
There is nothing to install, no command line, and no keys or passwords to look after.

- [Before you start](#before-you-start)
- [Where to find the import](#where-to-find-the-import)
- [From Pulley: export the reports](#from-pulley-export-the-reports)
- [From the spreadsheet template: download it and fill it in](#from-the-spreadsheet-template-download-it-and-fill-it-in)
- [Upload the files](#upload-the-files)
- [Review the preview](#review-the-preview)
- [Fix any problems](#fix-any-problems)
- [What an opening balance is](#what-an-opening-balance-is)
- [Import](#import)
- [After the import](#after-the-import)
- [What isn't imported](#what-isnt-imported)
- [Where your data goes](#where-your-data-goes)
- [Questions](#questions)

## Before you start

- **You need to be an owner or admin** of the Cap Table app in the Insulin console, with an e-mail address on your
  console profile.
- **The import sets up an empty company.** It works only while the company has no stakeholders and no recorded
  transactions, and none of these saved yet: documents, document folders, payment instructions, signatories, legends or
  valuations. If you chose to start with an empty company and haven't added any of those, you can still import: the
  imported company takes its place and keeps its non-financial profile and settings (names, time zone, fiscal year end
  and the rest). The files' stated currency takes precedence so imported and future amounts use the same currency.
- **Pick a quiet moment.** If you're coming from Pulley, ask everyone to stop making changes there until you're done,
  so that all the reports describe the same day.
- **Practise in the preview first (recommended).** The AppBuilder's preview has its own practice database. Run the
  whole import there, look around, and only then repeat it in the published app. An import in the published app is
  permanent.

## Where to find the import

- **The first time an owner or admin opens Cap Table**, the setup page says "Choose how to start" and offers three ways:
  **Start with an empty company**, **Import from Pulley**, and **Import from a spreadsheet** (which also has **Download the
  template**). Editors and holders see that Cap Table isn't set up yet, and are asked to wait for an owner or admin.
- **Later**, while nothing is recorded, an owner's or admin's dashboard shows "Nothing is recorded in this cap table
  yet" with **Import the cap table**. If the company already has stakeholders or recorded transactions, the import page
  says "Import isn't available for this company" and why.

The import has five steps, shown along the top: **Choose the source**, **Upload the files**, **Review the preview**,
**Import**, **Done**. If you picked a source on the setup page, it starts at the upload.

## From Pulley: export the reports

In Pulley, export each report below from the **Reports** page as an Excel file (.xlsx), all on the same day, without
renaming their columns. There's no need to rename the files: Cap Table recognizes each report by its sheets and column
headings.

**Required:**

| Report | What Cap Table uses it for | What to choose when you export it |
|---|---|---|
| **Raw Cap Table** | The backbone: the company, share classes, equity plans, every security and every stakeholder's totals. Cap Table checks its own numbers against this report. | As of today. |
| **Detailed Cap Table** | How holdings came about: exercises, cancellations, conversions. Its summary is compared with Cap Table's numbers too. | Nothing special. |
| **Stakeholders** | Names, e-mail addresses, individual or institution, and relationship to the company. | Everyone. |
| **Vesting Details** | Every vesting date and amount, past and future. | All stakeholders, including terminated ones, with dates from before your first grant to after your last scheduled vesting date. |
| **Exercised Options** | Every option exercise. | Nothing special. |
| **ISO/NSO Details** | How each option grant splits between ISO and NSO. | Nothing special. |

**Optional:** **Stakeholder Transactions** reports. Cap Table accepts them but reads them for information only; they
don't change any number.

Excel files are best. The single-sheet reports can also be uploaded as comma-separated CSV files (dates written as
2024-06-12 or 6/12/2024); semicolon-separated CSV isn't recognized.

## From the spreadsheet template: download it and fill it in

Choose **Download the template** on the setup page or in the import. It's an Excel workbook with an **Instructions**
sheet, which explains every column with an example, and eight data sheets that each have one header row:

**Company** (exactly one row)

| Column | Required | Notes |
|---|---|---|
| Company name | yes | |
| As-of date | yes | The date every balance in the workbook represents. Nothing in the workbook may be dated after it. |
| Currency | no | A three-letter code such as USD. Blank means USD. |

**Stakeholders**

| Column | Required | Notes |
|---|---|---|
| Stakeholder ID | yes | Your own unique ID; the security sheets use it to name the holder. |
| Name | yes | Up to 200 characters. |
| Type | yes | Individual or Organization. |
| Relationship | yes | Founder, Employee, Investor, Advisor, Consultant, Board member or Other. |
| Email | no | Holders are matched to their console account by e-mail (see [After the import](#after-the-import)). |
| Termination date | no | For someone who has left. |
| Termination type | with a termination date | Voluntary, Involuntary, With cause, Death, Disability or Retirement. |

**Share classes**

| Column | Required | Notes |
|---|---|---|
| Class ID | yes | |
| Name | yes | Up to 100 characters. |
| Type | yes | Common or Preferred. |
| Authorized shares | yes | The current authorized number. |
| Conversion ratio | no | For preferred classes; blank means 1. |
| Original issue price | no | Per share. |

**Equity plans**

| Column | Required | Notes |
|---|---|---|
| Plan ID | yes | |
| Name | yes | |
| Share class ID | yes | The class an exercised award delivers. |
| Pool size | yes | The plan's current reserved pool. |
| Effective date | yes | |
| Exercise window after termination (days) | no | Whole days a leaver has to exercise. Blank means 90 days. |

**Shares** (one row per certificate or share lot)

| Column | Required | Notes |
|---|---|---|
| Certificate ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Share class ID | yes | |
| Plan ID | no | Only for shares that came from exercised options: the plan of the grant. |
| Shares | yes | |
| Issue date | yes | |
| Price per share | yes | |

**Options** (one row per grant)

| Column | Required | Notes |
|---|---|---|
| Grant ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Plan ID | yes | |
| Type | yes | ISO or NSO. Don't guess. |
| Options granted | yes | The total originally granted. |
| Exercise price | yes | Per option. |
| Grant date | yes | |
| Expiration date | yes | Not before the grant date. |
| Vesting start date | yes | |
| Vesting months | yes | The whole term, from 1 to 240 months. |
| Cliff months | yes | 0 for no cliff; never more than the vesting months. |
| Vest every (months) | yes | 1 (monthly), 3 (quarterly) or 12 (annually). The vesting months and the cliff must both be whole numbers of these periods. |
| Early exercise | yes | Yes only if the agreement allows exercise before vesting; otherwise No. |
| FMV at grant | no | Fair market value per share on the grant date. |
| Exercised | yes | Options already exercised; 0 if none. |
| Vested | no | If you fill it in, Cap Table checks it against the schedule. |
| Vested outstanding | no | Vested and not exercised; checked the same way. |
| Cancelled | no | Options already cancelled; 0 or blank if none. |
| Cancellation date | when Cancelled is more than 0 | |
| Cancellation reason | when Cancelled is more than 0 | Unvested forfeiture, Expired (vested options are used up first) or Other (Cap Table splits the quantity using the schedule). |

**Warrants**

| Column | Required | Notes |
|---|---|---|
| Warrant ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Share class ID | yes | The class a holder can buy. |
| Shares | yes | |
| Exercise price | yes | |
| Issue date | yes | |
| Expiration date | yes | |

**SAFEs**

| Column | Required | Notes |
|---|---|---|
| SAFE ID | yes | Up to 40 characters. |
| Stakeholder ID | yes | |
| Principal | yes | |
| Issue date | yes | |
| Valuation cap | no | |
| Discount % | no | 20 means 20%. |
| Type | yes | Post-money or Pre-money. |

Rules for every sheet:

- Give every row its own ID. The IDs of shares, options, warrants and SAFEs must also differ from one another.
- Use those IDs to link rows: a Stakeholder ID, Share class ID or Plan ID must match a row on its sheet.
- Write dates as YYYY-MM-DD.
- Type numbers exactly, without formulas, with at most 12 decimal places. Excel keeps only 15 significant digits, so
  check very long numbers against your records.
- For each plan, the options exercised must equal the shares that name that plan in **Plan ID**.
- Exercised plus cancelled can't be more than the options granted.
- Include at least one share, option, warrant or SAFE, and at most 2,000 of them in all.

Leave the sheet names and column headings as they are, and save the workbook as .xlsx. Where the template is silent,
Cap Table uses a stated default and lists it in the preview: the empty company's currency (or US dollars when there is
no company yet), a conversion ratio of 1, a 90-day exercise window, unused plan shares returning to the pool, and no
recorded purchase price for warrants.

## Upload the files

On **Upload the files**, drag the files onto the page, or choose **Choose files** (Pulley) or **Choose a file** (the
spreadsheet):

- **Pulley:** all the reports at once, as Excel or CSV files, up to 5 MiB each and 9.9 MiB together, and at most 25
  files.
- **Spreadsheet:** the one workbook (.xlsx), up to 5 MiB.

Cap Table refuses a file that breaks these limits and says why; a file with the same name as one you already chose
replaces it.

Then fill in, or check, the details the preview needs:

- **As-of date:** the date your files describe. You can leave it empty: Cap Table then uses the date the Pulley exports
  state, or the As-of date on the spreadsheet's Company sheet. After a preview, it may offer "Use (date), the date your
  files suggest"; it never fills a date in for you. If the files state no date, the preview asks you to enter one.
- **Company timezone, Jurisdiction and Fiscal year end** (only when the import creates the company from the setup
  page): the time zone decides when "today" starts for vesting and deadlines; the jurisdiction is a code such as US-DE
  or GB; the fiscal year end is a month and day, such as 12-31. The company's name comes from the files. A currency
  stated in the files wins; otherwise Cap Table uses the empty company's currency, then USD.

Choose **Check the files**. Checking, and later importing, sends the files to the app's server to be read; the source
file bytes are not retained (see [Where your data goes](#where-your-data-goes)). Nothing is added to the cap table until
you import.

## Review the preview

**Review the preview** shows what Cap Table is about to create:

- **Files checked:** each file and what it was recognized as.
- **The review summary:** the as-of date and the currency the imported company will use.
- **Problems to fix**, first. Each one blocks the import, says what is wrong, and shows where (file › sheet › row ›
  column).
- **Warnings**, which don't stop the import; make sure each is what you expect.
- **Opening balances**: securities imported as a starting balance on a date, each with its reason (see
  [What an opening balance is](#what-an-opening-balance-is)).
- **Assumptions**: the choices Cap Table made where the files leave something open.
- **What will be imported** (how many stakeholders, share classes, plans, securities and transactions) and **the company
  after the import** (its fully diluted and its issued and outstanding shares).
- **Totals** that the source states, next to the same totals computed from the import, marked **Matches** or **Differs**:
  for the company, each share class, each plan, each holder and each security. For Pulley they must match exactly. The
  spreadsheet states no totals, so check the figures against your own records.

**Import** stays unavailable while any problem remains.

## Fix any problems

Some problems you may see:

| Problem | What to do |
|---|---|
| A required Pulley report is missing ("Add Pulley's Vesting Details report.") | Export it and upload the whole set again. |
| A file isn't one of the supported reports, or two files are the same report | Remove the extra file; make sure each report is a standard Pulley export with its columns unchanged. |
| A grant names a stakeholder who isn't in the Stakeholders report or sheet | Add the stakeholder, or correct the ID. |
| A record is dated after the as-of date, an exercise before its grant, or the as-of date after today | Correct the date in Pulley or the spreadsheet, or the as-of date. |
| "Pulley reports 4,200,000 fully diluted shares; this preview produces 4,199,000." | Usually reports exported on different days, a Vesting Details report without terminated stakeholders or future dates, or options that Pulley let lapse without cancelling. Fix it in Pulley and export again. |
| A value has more than 12 decimal places | Round it in the source; Cap Table never rounds behind your back. |
| A name, ID or e-mail address that is too long or not valid | Shorten or correct it: names up to 200 characters (share classes 100), certificate and grant IDs up to 40, and real e-mail addresses. |
| An instrument Cap Table doesn't support (RSUs, SARs, phantom stock, convertible notes) | Deal with it outside the app first; Cap Table imports shares, options, warrants and SAFEs only. |
| Shares that Pulley shows as transferred | Pulley's reports don't say which holding each transfer created, so the import stops there. The spreadsheet template lets you enter each holder's current shares directly. |
| A repurchase without its date or the amount paid | Add both in Pulley and export again. |
| No securities at all, or more than 2,000 | Add at least one share, option, warrant or SAFE; a larger cap table can't be imported in one go. |
| A template cell that is blank, invalid or not one of the listed choices | The problem names the sheet, row and column; correct it in the workbook. |

To fix a problem, correct it at the source: in Pulley (then export the affected report again) or in your workbook. You
can also correct an obvious mistake in an exported Pulley file with Excel, as long as you keep its sheets and column
headings. Then choose **Upload corrected files**, which takes you back to the upload, and **Check the files** again.

## What an opening balance is

The sources describe what everyone holds today very well, but they don't always contain every step of how it got
there. For example, Pulley's exercise report may not say exactly which share certificate an exercise created, and the
template records how many options were exercised, but not when.

When Cap Table can't rebuild a holding's history step by step, it records the holding as an **opening balance**: the
quantity, vesting and status your files give, as Cap Table reads them on the import date, without inventing the steps
in between, so check them in the preview. Only the history is shorter: the opening balance is dated where the source
allows (for example at the first exercise it couldn't match), and if you look at the cap table as of an earlier date,
it says that the history before that date came in with the import as opening balances.

The preview lists every opening balance with its reason before you import.

## Import

When no problem is left, choose **Import**. Keep the page open until it finishes; the app won't let you leave it in the
middle.

Behind the scenes, Cap Table checks that these are exactly the files and the date you reviewed, writes the company where
nobody can see it yet, checks the result against the preview, and only then switches the company on, all at once.

- **When it's done**, "The cap table is imported" lists what was imported, with **Open the cap table** and **Go to the
  dashboard**. The result stays on screen until you leave it; leaving it any other way also opens the new company.
- **If it fails**, nothing becomes visible. The page says "Nothing was imported" with the reason, and you can import
  again.
- **If the connection drops** before the answer arrives, the page says "The import's outcome isn't known yet". Choose
  **Check the import** to find out what happened, or **Try again**: repeating the same import is safe.
- **If the company changed** in the meantime (someone added a stakeholder, for example), or another import is already
  running, the import is refused and nothing changes.

The import happens once. Cap Table won't import records it has already imported, and it won't import into a company
that already has stakeholders or records.

## After the import

1. **Spot-check.** Compare **Cap Table** (as of the import's date) with your source. Open a few stakeholders and choose
   **Preview as stakeholder** to see what they will see.
2. **Upload your documents.** Neither source includes files. Upload agreements, board consents, certificates, plan
   documents and valuation reports on the **Documents** page, link each one to the record it belongs to, and choose
   which ones holders may see.
3. **Record your current 409A valuation.** The import doesn't bring valuations in, and new grants need a valid one.
4. **Fill in what holders see:** the company contact, the How to exercise text and the payment instructions.
5. **Give holders access.** Make sure each holder's stakeholder record has, as their own address, the e-mail address of
   their Insulin console account, then give them the User or Viewer role on the app in the console.

## What isn't imported

- **Documents and files:** agreements, board consents, certificate PDFs, plan documents and valuation reports. Upload
  them after the import. (Each imported share lot does get a certificate record with its number.)
- **Valuations:** record your 409A valuations yourself.
- **Signatures:** Cap Table can't tell which agreements were still waiting for signatures, so imported grants count as
  signed.
- **Some history:** steps the sources can't express become opening balances. Transfers can't be imported from Pulley's
  reports at all (see [Fix any problems](#fix-any-problems)).
- **Workflow records:** exercise requests, 83(b) elections and notes kept in Pulley.
- **Pulley's own accounts and settings:** who could sign in to Pulley, notification settings, templates. People get
  access to Cap Table through their role in the Insulin console.

## Where your data goes

- **Only to this app.** Cap Table reads the files you upload and stores what it imports in the app's own database.
  Nothing is sent to Pulley or to any other service.
- **What the app keeps.** Your browser tab holds the files until you import, and each check or import sends them to the
  app's server to be read. The source file bytes are not retained. The app keeps each file's name and fingerprint,
  import-run metadata, and source locations such as sheet and row with imported ledger facts. The fingerprints make the
  import match exactly what you reviewed, and the locations show where each imported record came from.
- **No extra encryption, keys or tokens.** Your browser talks to the app over its normal secure connection, and the
  imported records are protected like everything else in the app: only people with a role on the app in the Insulin
  console can open it.
- **Cap Table never signs in to Pulley.** You export the reports yourself.
- You can delete the exported files from your computer once the import is done.

## Questions

**Can I import from another tool?**
Fill in the Cap Table spreadsheet template from it.

**Why does Cap Table complain about a number?**
Cap Table works with exact numbers and never rounds behind your back. If a value has more than 12 decimal places, or
totals don't add up, the preview asks you to fix it rather than guess.

**Can I add more holdings after the import?**
Cap Table records new option grants, exercises, terminations and cancellations. It has no forms to add share classes or
plans, or to issue shares, so put everything you have into the import.

**The import in the published app went wrong. Can I undo it?**
No. The cap table keeps a permanent history, so an import can't be taken back. That's why practising in the preview
first is worth it. If you do need to start again, create a new app from Cap Table in the Insulin console, which comes
with a new, empty database, and import there.
