# Taxi

Taxi prepares a Canadian household's income tax returns (the T1): yours, and your spouse's or common-law
partner's if you prepare them together. It never files with the CRA. When a return is done, you get the CRA's own
forms, filled in, to sign and mail, or numbers to copy into certified software.

It is an Insulin app: you start from it in the Insulin console, change it with the AppBuilder if you want to, preview it
and publish it. It brings its own database.

**Status: early.** It is being built in parts. Today it has the household step; the rest of the year's steps say what
they will do.

## What it does today

- **Tax years.** Start a year (2025) and follow its six steps: household, upload documents, what applies, confirm,
  deductions, finish.
- **The household.** Add yourself, your spouse or common-law partner, and your children and other dependants, with
  their birth dates, on the Household page. Starting a year asks who is in it: your spouse in it means both returns are
  prepared together. Each year then records your marital status on December 31, and each adult's province and whether
  they lived in Canada all year. The app says what is still missing, and what it
  can't prepare (another province, or someone who moved to or from Canada during the year).
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
```

`AGENTS.md` has the layout, the access rules and what to run before finishing a change.
