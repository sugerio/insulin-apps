---
title: Taxi overview
description: What Taxi does, who it is for, what it doesn't do yet, and how it runs on Insulin Apps.
order: 1
---

Taxi prepares Canadian personal income tax returns. This page explains what it does today, who it is for,
and what it leaves out. Read it first if you are deciding whether Taxi suits you, or if you are an AI agent that
needs the big picture before calling its API.

## What Taxi does

Taxi prepares the T1 return of the person preparing it and, if they choose, of their spouse or common-law
partner. It never files with the CRA. When a return is done, you get the CRA's own forms, filled in, to sign and mail.
You can also copy the numbers into certified tax software.

You and your spouse or partner each have a return. You work on one return at a time, and switch to the other from the
return's name above its steps. Both returns are worked out together, so each can use the other's numbers.

Each return has seven steps:

1. **Personal info.** The facts no document shows.
2. **Upload documents.** Slips and receipts, read by AI. A slip with the other person's name goes to their return.
3. **Income.** Employment, investments and the rest: the slips found, box by box to check and change, and what else
   to add.
4. **Deductions.** RRSP and FHSA contributions, working from home, child care and moving expenses, and what your
   slips already deduct.
5. **Credits.** Tuition, medical expenses, donations, a single parent's child's net income (for the eligible dependant
   amount), and what your slips already claim.
6. **Confirm.** Every number AI read, to check against the papers.
7. **Finish.** The refund or balance owing, what to check before filing, and hints: ways to pay less, such as claiming
   both spouses' donations on one return, each with what it saves. Apply one to change your answers; you can undo it.
   When the return is finished, download its forms: the CRA's T1 and provincial form with your amounts filled in, and
   a worksheet that shows how each amount was worked out.

A step that isn't done says at its top what is left. In Income, Deductions and Credits, add what you have; what you
don't add counts as none. Some items are groups: add self-employment, for example, and its card asks the kind of
income, what you earned and your expenses.

> [!NOTE]
> The forms are filled in with what Taxi knows: in Step 1 of the T1 your name, date of birth, marital status and
> province, and your spouse's first name and net income; then every amount Taxi works out, on the T1, the schedules
> and forms your return uses (such as Schedule 9 for donations), and the provincial forms. Add your social insurance
> number, address and the other Step 1 answers by hand, then sign and mail it, or copy the amounts into
> NETFILE-certified software.

## Who it is for

Residents of every Canadian province and territory, including people who moved to or from Canada during the year,
except in Quebec. For a resident of Quebec, Taxi prepares both returns: the federal return and Revenu Québec's TP-1;
a Quebec return for the year of a move to or from Canada isn't handled yet.

The returns cover:

- Income: employment, pensions (OAS, CPP or QPP, workplace pensions, annuities, RRIFs and RRSP withdrawals), EI and
  parental benefits, investments, self-employment (including farming and fishing), rental income with capital cost
  allowance, income earned abroad, support payments, scholarships and the sale of real estate.
- Deductions: RRSP and FHSA contributions, pension income splitting, child care, moving and home-office expenses,
  support payments, carrying charges, disability supports and losses of other years.
- Credits: tuition, donations, medical expenses, the disability and caregiver amounts, the home buyers' and home
  accessibility amounts, adoption, student loan interest, the Canada workers benefit, and the credits of each
  province and territory.

Taxi doesn't handle a few rare cases, such as property that is treated as sold when you leave Canada, and business and
investment tax credits. The app says so when a case it doesn't handle applies.

## What it stores

For each person: their name, their relationship to you and their birth date. For each tax year: who is in it (your
spouse in it means both returns are prepared together), the marital status on December 31, each adult's province
and whether they lived in Canada all year, their slips and their answers. Every change records who made it and when.

Taxi never asks for a social insurance number (SIN), a home address or bank details, and none of its fields holds
them. You write those on the paper return when you sign it. An uploaded slip is kept as it was uploaded, so the SIN
and address printed on it are in the file until you delete it or upload a new version that Taxi reads.

## On Insulin Apps

Taxi runs at `https://taxi.insulinapps.com`. Sign in to Insulin Apps, create an organization (a
family can be an organization of one), and open the app. People and roles are managed on Insulin Apps; see
[Roles and access](/docs/taxi/roles-and-access). AI agents connect over MCP, and API clients call the same API
as the browser; see [Taxi API](/docs/taxi/api).
