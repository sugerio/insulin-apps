# Taxi

Taxi prepares Canadian personal income tax returns (the T1): yours, and your spouse's or common-law
partner's if you prepare them together. It never files with the CRA. When a return is done, you get the CRA's own
forms, filled in, to sign and mail, or numbers to copy into certified software.

It is an Insulin app: you start from it in the Insulin console, change it with the AppBuilder if you want to, preview it
and publish it. It brings its own database.

**Status: early.** It is being built in parts. Today a year can be prepared from start to finish: the profile,
uploaded slips read by AI (or typed in), income, deductions, credits, the results, and the filled-in CRA forms.

## What it does today

- **Tax years.** Start a year (2025). You and your spouse or partner each have a return; the app shows one return at a
  time, with a switcher to the other. Each return has seven steps: personal info, upload documents, income,
  deductions, credits, confirm, finish. The steps run in a row above each page, with the return's estimate above them.
- **The profile.** Add yourself, your spouse or common-law partner, and your children and other dependants, with
  their birth dates, on the Profile page. Starting a year asks who is in it (only you, to begin with; change it later on
  the Tax years page): your spouse in it means both returns are
  prepared together. Each year then records your marital status on December 31, and each adult's province and whether
  they lived in Canada all year (for someone who moved, the days in Canada). The app says what is still missing.
- **The tax engine.** All tax rules are YAML files under `rules/`, one folder per year, each number with its source.
  The engine computes every return of the year from them, marks each number complete, estimated (a default stood in
  for an answer) or missing, and explains any number down to the slip boxes. The 2025 rules cover the T1 for
  employment, interest, dividends, trust income and capital gains (T4, T5, T3, T5008), RRSP, FHSA, RPP and union dues,
  the federal credits, transfers between spouses (Schedule 2), the Form 428 and 479 of every province and territory,
  and, for a resident of Quebec, the 5005-R and the TP-1 (`qc.yaml`, `qc-credits.yaml`). Above each step but
  Finish, the estimate shows the refund or balance owing; Details opens each result line, and selecting a line shows why.
- **Step 2, AI reading.** Upload a folder or files into a return; Claude reads each one into slips, receipts (RRSP, donation,
  medical) and last year's notice of assessment (a document with the other person's name goes to their return), using
  the organization's Anthropic credential (Settings › Integrations, key `anthropic`). A file with the same name as one in the
  return replaces it and its slips; the same content under another name, or the same slip, isn't saved twice. Every slip starts
  unconfirmed. A file can be deleted with the slips read from it, and one
  that couldn't be read can be read again.
- **Steps 3 to 7.** Income, Deductions and Credits, each a part of the return: what is on it (the slips found, each
  opening into its boxes to change; amounts; groups such as self-employment or working from home, whose parts are
  asked in their card), what can be added, and what the slips already claim. A case the app doesn't handle (property treated as sold
  when you leave Canada, a T4 with both CPP and QPP) is named, never ignored. Then Confirm (each slip entered box
  by box, then confirmed, or moved to the other return) and Finish (the refund or balance owing, the key lines with why,
  what to check before filing, hints, and the forms).
- **Hints.** Finish checks each return, like a tax program's "check and optimize": claiming both spouses' donations on
  one return, the family's medical expenses on the lower income, transferring tuition to a spouse, deducting RRSP
  contributions later, RRSP contributions over the limit, and interest without a T5. A saving is worked out on both
  returns with and without the change, never guessed (`rules/ca/2025/hints.yaml`); applying it saves answers, and it can
  be undone.
- **The CRA's forms.** A finished return (nothing left on Personal info, every slip there and confirmed, every line
  worked out; for a couple, the other's facts given and slips confirmed too) downloads as one PDF: the CRA's own T1
  and the Form 428 of the province or territory with the amounts written in, then a worksheet with the slips, the
  answers, the applied hints and how each line was worked out. The CRA's print PDFs come from canada.ca on first use
  and are kept in the database; they are never in the repository. Where each amount goes is measured from the PDFs by
  `npm run form-layout` (`rules/ca/2025/form-layout.yaml`); what goes there is in `rules/ca/2025/forms.yaml`. Revenu
  Québec's forms also print in French, on their French versions, each measured on its own.
- **Roles.** Owners, admins and editors prepare returns; viewers see everything and change nothing. Custom roles pick
  from two permissions: Prepare returns and View returns.
- **Built-in Docs.** **Docs**, in everyone's navigation, explains the app and covers Canadian tax basics in plain words,
  with a glossary.

## Who it's for

Residents of every Canadian province and territory, for the 2025 tax year, including people who moved to or from Canada
during the year. A resident of Quebec gets both returns: the federal return (5005-R) and Revenu Québec's TP-1, from
the RL slips. The returns cover employment, pension, benefit, investment, self-employment (with farming and fishing),
rental and foreign income, the sale of real estate, the usual deductions (RRSP, FHSA, pension splitting, child care,
moving, home office, support) and the federal, provincial and territorial credits a family claims. Not handled, and
said so when it applies: property treated as sold when you leave Canada, business and investment tax credits, and a
few Quebec cases (employment outside Quebec, rental and foreign income on the TP-1).

## Good to know

- **No SIN, address or bank details in Taxi's fields.** You write them on the paper return when you sign it. An
  uploaded file is kept as it was uploaded, so a slip's printed SIN and address are in it until the file is deleted or a new version of it is read.
- **Hourly usage counts.** On insulinapps.com, the platform calls Taxi every five minutes, and once an hour it
  sends counts for each organization (profiles, people, tax years, returns and files), the bytes each one stores and
  the database's size. Never names,
  birth dates, amounts or documents.
- **General information, not advice.** The Docs explain tax terms in general; they are not tax advice.

## Run it

```bash
npm ci
npm run dev        # http://localhost:3000, as a stand-in owner
npm test
npm run typecheck
npm run rules      # after changing rules/: check the YAML, write the compiled JSON
npm run rules:try -- test/golden/ca-2025/single-employee-on.json
```

`AGENTS.md` has the layout, the access rules and what to run before finishing a change.
