---
title: Taxi overview
description: What Taxi does, who it is for, what it doesn't do yet, and how it runs on Insulin Apps.
order: 1
---

Taxi prepares a Canadian household's income tax returns. This page explains what it does today, who it is for,
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
5. **Credits.** Tuition, medical expenses, donations, and what your slips already claim.
6. **Confirm.** Every number AI read, to check against the papers.
7. **Finish.** The refund or balance owing, what to check before filing, and hints: ways to pay less, such as claiming
   both spouses' donations on one return, each with what it saves. Apply one to change your answers; you can undo it.
   When the return is finished, download its forms: the CRA's T1 and provincial form with your amounts filled in, and
   a worksheet that shows how each amount was worked out.

A step that isn't done says at its top what is left. In Income, Deductions and Credits, add what you have; what you
don't add counts as none. Some items are groups: add self-employment, for example, and its card asks the kind of
income, what you earned and your expenses.

> [!NOTE]
> The forms are filled in from Step 2 on. Fill in Step 1 of the T1 (your name, address, social insurance number and
> the other identification) by hand, then sign and mail it, or copy the amounts into NETFILE-certified software.
> Schedules, such as Schedule 9 for donations, aren't filled in: the worksheet shows their lines to copy.

## Who it is for

Residents of Ontario, British Columbia and Alberta who lived in Canada all year. The returns it prepares cover
employment income, pensions (OAS, CPP, workplace pensions and annuities, RRIFs), EI benefits, investment slips, self-employment (including farming and fishing) and rental income with capital cost allowance, income earned abroad with its foreign tax credit, and the sale of real estate; RRSP and FHSA contributions, child care, moving and home-office expenses; tuition, donations and
medical expenses.

It doesn't handle Quebec returns or pension income splitting. The
app says so when a case it doesn't handle applies.

## What it stores

For each person: their name, their relationship to you and their birth date. For each tax year: who is in it (your
spouse in it means both returns are prepared together), the marital status on December 31, each adult's province
and whether they lived in Canada all year, their slips and their answers. Every change records who made it and when.

Taxi never stores a social insurance number (SIN), a home address or bank details. You write those on the paper
return when you sign it.

## On Insulin Apps

Taxi runs at `https://taxi.insulinapps.com`. Sign in to Insulin Apps, create an organization (a
household can be an organization of one), and open the app. People and roles are managed on Insulin Apps; see
[Roles and access](/docs/taxi/roles-and-access). AI agents connect over MCP, and API clients call the same API
as the browser; see [Taxi API](/docs/taxi/api).
