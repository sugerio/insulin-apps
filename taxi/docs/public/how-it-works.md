---
title: How Taxi works
description: What Taxi stores, how it computes a return, how saves stay consistent, the usage it reports to Insulin Apps, and its limits.
order: 5
---

This page explains what happens behind Taxi's pages. It is for people who want to know what is stored and how,
and for AI agents answering questions about the app.

## What is stored

Taxi keeps its own database. Each organization has one household, with:

- **People:** name, relationship and birth date.
- **Tax years:** who is in each one, the marital status on December 31, and a revision number that changes with each
  save. Both returns are prepared together when your spouse is in the year.
- **Returns:** for each adult and year, the province on December 31 and whether they lived in Canada all year.
- **Slips:** each adult's slips for the year, box by box as printed, and whether someone confirmed them against the
  paper slip (who and when).
- **Answers:** each adult's answers to the year's questions, such as an RRSP deduction or whether they had rental
  income.
- **Uploaded files:** each file uploaded for a year, its name, size and fingerprint (SHA-256), and what reading it
  found. Slips read from a file link to it.
- **History:** who made each change, when, and whether they used the browser, an AI agent or an API client.

It never stores a SIN, a home address or bank details.

## How AI reads a slip

Each uploaded file (PDF, PNG or JPEG, up to 10 MiB) is sent on its own to Anthropic's Claude, with the organization's
own Anthropic credential: an admin stores it on the app's **Integrations** page under the key `anthropic` (base URL
`https://api.anthropic.com`, sent as the named header `x-api-key`). Insulin Apps adds the key to each request, so Taxi
never holds it. Without that credential, files are stored but not read, and slips can be typed in by hand.

With the file, Claude gets the year, the names of the people in the year, and the slip types the app reads with their
boxes. It answers in a fixed shape: each slip's type, the name on it, the issuer, its boxes and the boxes it couldn't
read clearly. It is told never to return a social insurance number. Taxi then checks the answer itself: only known slip
types and boxes are kept, amounts must be numbers, a slip for another year is refused, and a slip already in the year
isn't added again. Every slip read this way starts unconfirmed: someone checks it against the paper slip at Confirm.

Receipts and last year's notice of assessment are read the same way: RRSP contribution receipts (for March 4, 2025 to
March 2, 2026), official donation receipts, medical receipts, and the 2024 notice of assessment. Donation and medical
receipts are added to the amounts claimed; what is entered by hand is what isn't on an uploaded receipt. RRSP receipts
and the notice of assessment give a starting amount for the RRSP deduction (the contributions, up to the deduction
limit) and for unused tuition, which the person checks and saves. Two receipts with the same amount from the same place
are both kept: a receipt is skipped only when the same file is uploaded again.

A file with the name of one already in the same return is a new version, changed or not: once it is read into slips,
it replaces the earlier file and every slip read from it (those start unconfirmed again). If the new version can't be
read into slips, the earlier one is kept. Files of the same name in two people's returns don't replace each other. A
file with the same content (its SHA-256) as one under another name isn't read or saved again. A file that couldn't be read can be read again from what was stored. Deleting a file deletes every slip read from it, confirmed or not, in whichever return
it is; slips typed in by hand stay.

## How a return is computed

All tax knowledge is in rule files, one folder per country and year: the year's numbers (rates, brackets, amounts),
each return line as a formula, the questions a formula can ask, and the slip types with their boxes. Each number names
its source. The rules for a new year list only what changed from the year before. The rules are part of the app's code,
checked when it is built, and every change to them is reviewed.

A formula reads like the CRA's worksheet line, for example `min(param.canadaEmploymentAmount, line.T1.10100)`. Formulas
use a small, fixed set of operations, and the engine reads them itself: a rule file can't run code.

The engine computes all of a year's returns together, because a couple's returns depend on each other. Nothing it
computes is stored: each time a year is read, it computes again from what was entered. Each number is:

- **Complete:** everything it needs was entered.
- **Estimated:** a question it needs has no answer yet, so the question's usual answer was used (for example, no RRSP
  deduction).
- **Missing:** a question it needs has no answer and no usual answer.

Any number can be explained: its formula, the values that went into it, and so on down to the answers and the slip
boxes. Money is computed exactly, without rounding errors, and rounded to the cent where the CRA rounds.

## Hints

Hints are checks on each return, in `rules/ca/2025/hints.yaml` next to the other rules. A hint shows when its condition
holds for the return. It is one of:

- **A saving:** a change of answers, such as claiming both spouses' donations on one return. The engine computes both
  returns again with the change, and the hint shows only when the household's refund, less any balance owing, goes up by
  $1 or more. The saving shown is that difference, never an estimate.
- **Something to know or check:** for example, that interest is taxable even without a T5, or that RRSP contributions
  are over the limit on last year's notice of assessment plus $2,000.

Applying a saving saves its answers, so the return explains the change like any other answer. The answers it changed
are kept, so **Undo** puts them back. A dismissed hint can be shown again.

The 2025 hints: claim both spouses' donations on one return; claim the family's medical expenses on one return (usually
the lower income); transfer this year's tuition the student doesn't need to their spouse; deduct RRSP contributions in a
later year when this year's income is in the lowest bracket; RRSP contributions over the limit; and interest without a
T5. Moving claims between the returns works only when both spouses' returns are prepared here.

## The CRA's forms

A finished return (every slip confirmed, every line worked out from answers, nothing the app doesn't handle) downloads
as one PDF: the CRA's own T1, the schedules and forms the return uses (such as Schedule 9, Schedule 11, Form T2125 or
Form T778, each only when it applies), the provincial forms, then a worksheet.

- The forms are the CRA's print versions. The first time an organization prints a return, Taxi downloads them from
  canada.ca and keeps them in its database. It checks each file against the one it was measured on, and refuses to fill
  a form the CRA has changed, rather than write amounts in the wrong places.
- Each amount is written in its box, by row number, from the same lines as the estimate. A box that is zero is left
  blank. The tax bracket tables are filled in the column of your bracket. A number of children or months is written as
  a whole number.
- Step 1 of the T1 gets the name (split at its last space into first and last name), date of birth, marital status,
  province of residence, the spouse's or partner's first name and net income, and the foreign property answer. Taxi
  never stores a social insurance number, an address or bank details, so those boxes stay blank.
- A couple's returns read each other (the spouse amount reads the other's net income), so a question left on one return
  can hold the other's forms too. Finish then names it under the other person, with a link to it.
- A row Taxi doesn't know (a dependant's details, each expense category, a property's address) is left blank. The
  worksheet lists the slips, the answers, the hints applied and every line with its formula.

## How saves stay consistent

Each change is written in one step with its history entry: either all of it is saved, or none of it. A year's household
facts are saved under the year's revision. A save based on an older revision is refused, so two people editing the same
year never overwrite each other without knowing.

## Usage reports

Once an hour, Taxi sends Insulin Apps a count of its records for each organization (households, people, tax
years and returns) and the size of its database, so that Insulin Apps can watch usage and plan capacity. It never sends
a name, a birth date, an amount or a document.

## Limits today

- The forms leave the social insurance number, address, signature and the other Step 1 answers to fill in by hand.
  Taxi doesn't print Schedule 7 (RRSP contributions), Form T1135 and a few worksheets (such as ON428-A).
- The 2025 rules cover one or two adults in every province and territory:
  - the T1, or the 5005-R for a resident of Quebec, with Schedules 2, 3, 5, 6, 8, 9, 11 and 12 and Forms T2125, T2042,
    T2121, T776, T777, T778, T1-M, T1032, T2091(IND), T2204, T2209, T2036 and T2222;
  - the Form 428 of each province and territory, with its S2 and S11 schedules and its Form 479 credits;
  - for a resident of Quebec, Revenu Québec's TP-1 with Schedules B, C, D, F, J, K, P, Q, R, T and U, from the RL
    slips;
  - people who moved to or from Canada during the year: the personal amounts are reduced by the days in Canada, unless
    at least 90% of their income for the rest of the year came from Canada.
- Not handled, and said so when it applies: property treated as sold when you leave Canada (Forms T1243 and T1161), a
  T4 with both CPP and QPP (Form RC381), capital cost allowance for more than one class, a farming loss, and on the
  TP-1 employment outside Quebec, rental and foreign income and moving expenses.
- Not handled and not asked: electing to stop CPP contributions (Form CPT30), a CPP disability pension (which changes
  the months of CPP), and business, investment, mining and similar tax credits.
- When the rules meet a case they don't handle, the number is shown as missing with the reason, never guessed.
- Only the 2025 tax year.
