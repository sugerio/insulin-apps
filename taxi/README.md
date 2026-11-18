# Taxi

Taxi prepares a Canadian household's income tax returns (the T1): yours, and your spouse's or common-law
partner's if you prepare them together. It never files with the CRA. When a return is done, you get the CRA's own
forms, filled in, to sign and mail, or numbers to copy into certified software.

It is an Insulin app: you start from it in the Insulin console, change it with the AppBuilder if you want to, preview it
and publish it. It brings its own database.

**Status: early.** It is being built in parts. Today a year can be prepared from start to finish: the household,
uploaded slips read by AI (or typed in), what applies, deductions and the results. The filled-in CRA forms come later.

## What it does today

- **Tax years.** Start a year (2025). You and your spouse or partner each have a return; the app shows one return at a
  time, with a switcher to the other. Each return has six steps: personal info, upload documents, what applies,
  confirm, deductions, finish.
- **The household.** Add yourself, your spouse or common-law partner, and your children and other dependants, with
  their birth dates, on the Household page. Starting a year asks who is in it: your spouse in it means both returns are
  prepared together. Each year then records your marital status on December 31, and each adult's province and whether
  they lived in Canada all year. The app says what is still missing, and what it
  can't prepare (another province, or someone who moved to or from Canada during the year).
- **The tax engine.** All tax rules are YAML files under `rules/`, one folder per year, each number with its source.
  The engine computes every return of the year from them, marks each number complete, estimated (a default stood in
  for an answer) or missing, and explains any number down to the slip boxes. The 2025 rules cover the T1 for
  employment, interest, dividends, trust income and capital gains (T4, T5, T3, T5008), RRSP, FHSA, RPP and union dues,
  the basic, age, CPP, EI, employment, tuition (T2202), medical and donation credits, the spouse and eligible
  dependant amounts, transfers between spouses (Schedule 2), and provincial tax: ON428 (surtax, tax reduction, LIFT
  credit, health premium), BC428 (BC tax reduction) and AB428 (supplemental credit). Beside steps 2 to 5,
  an estimate shows each return's result lines; select a line to see why.
- **Step 2, AI reading.** Upload a folder or files into a return; Claude reads each one into slips (a slip with the other
  person's name goes to their return), using
  the organization's Anthropic credential (Settings › Integrations, key `anthropic`). Duplicates are skipped, and every
  slip starts unconfirmed.
- **Steps 3 to 6.** What applies (the slips found, the kinds not found and whether you have them, what is still missing, and what the app
  doesn't handle), Confirm (each slip entered box by
  box, then confirmed, or moved to the other return), Deductions (only the questions the return reads), and Finish (the refund or balance owing, the
  key lines with why, and what to check before filing).
- **Roles.** Owners, admins and editors prepare returns; viewers see everything and change nothing. Custom roles pick
  from two permissions: Prepare returns and View returns.
- **Built-in Docs.** **Docs**, in everyone's navigation, explains the app and covers Canadian tax basics in plain words,
  with a glossary.

## Who it's for

Residents of Ontario, British Columbia and Alberta who lived in Canada all year, with employment income, investment
slips, RRSP contributions, donations and medical expenses. Not yet: self-employment, rental income, income from outside
Canada, and Quebec.

## Good to know

- **No SIN, address or bank details are stored.** You write them on the paper return when you sign it.
- **Hourly usage counts.** On insulinapps.com, the platform calls Taxi every five minutes, and once an hour it
  sends counts for each organization (households, people, tax years and returns) and the database's size. Never names,
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
