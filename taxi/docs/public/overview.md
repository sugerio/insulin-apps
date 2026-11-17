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

A tax year has six steps:

1. **Household.** Who is in the household, and the facts no document shows.
2. **Upload documents.** One folder of slips and receipts, read by AI.
3. **What applies.** What the documents show, and anything missing.
4. **Confirm.** One table of every number AI read, to check against the papers.
5. **Deductions.** Deductions and credits, and who claims each one.
6. **Finish.** The results, and the filled-in forms to download.

> [!NOTE]
> Taxi is being built in parts. Today only step 1, the household, works. Steps 2 to 6 show what they will do.

## Who it is for

Residents of Ontario, British Columbia and Alberta who lived in Canada all year. The returns it will prepare cover
employment income, investment slips, RRSP contributions, donations and medical expenses.

It doesn't handle self-employment, rental income, income from outside Canada, or Quebec returns. The household step says
so when one of these applies.

## What it stores

For each person: their name, their relationship to you and their birth date. For each tax year: the marital status on
December 31, whether both returns are prepared together, and each adult's province and whether they lived in Canada all
year. Every change records who made it and when.

Taxi never stores a social insurance number (SIN), a home address or bank details. You write those on the paper
return when you sign it.

## On Insulin Apps

Taxi runs at `https://taxi.insulinapps.com`. Sign in to Insulin Apps, create an organization (a
household can be an organization of one), and open the app. People and roles are managed on Insulin Apps; see
[Roles and access](/docs/taxi/roles-and-access). AI agents connect over MCP, and API clients call the same API
as the browser; see [Taxi API](/docs/taxi/api).
