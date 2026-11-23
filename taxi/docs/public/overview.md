---
title: Taxi overview
description: What Taxi does, who it is for, what it doesn't do yet, and how it runs on Insulin Apps.
order: 1
---

Taxi prepares Canadian personal income tax returns, and the first part of the United States federal return. This
page explains what it does today, who it is for, and what it leaves out. Read it first if you are deciding whether Taxi suits you, or if you are an AI agent that
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

## United States (federal)

When you start a year, you choose Canada or the United States. A year is of one country. A US year prepares the
federal Form 1040 of a U.S. citizen or resident alien for the whole year. It prepares no state return.

The US return covers:

- Income: wages on Form W-2, and interest on Form 1099-INT (with savings bond and Treasury interest, and tax-exempt
  interest).
- Filing status: single, married filing jointly, married filing separately, head of household, or qualifying
  surviving spouse. A married couple chooses on Personal info. Jointly, both spouses are on one return, the person
  preparing's: each enters their own W-2s and answers on it. Separately, each spouse prepared here gets their own
  return. Head of household and qualifying surviving spouse apply when the dependants and answers say so.
- Dependants: each dependant in the year gets a few questions on Personal info (relationship, months with you, school,
  support, social security number). The app works out who is a qualifying child or qualifying relative, the child tax
  credit ($2,200 for each child under 17 with a social security number), the credit for other dependents ($500), the
  reduction over $200,000 ($400,000 jointly) of modified AGI, and the additional child tax credit, with Part II-B of
  Schedule 8812 for three or more children.
- The earned income credit, with or without qualifying children, as the IRS's EIC Table gives it: the steps of
  who can take it (income, investment income, valid SSNs, age without a child, filing separately), and the smaller of
  the credits on earned income and on AGI when the worksheet asks for both.
- The credit for child and dependent care expenses (Form 2441): care for a child under 13, or for a dependant who
  can't care for themselves, so you could work. The care for each person is asked on their card. The credit is 35% to
  20% of up to $3,000 of care ($6,000 for two or more people), limited by the earned income of each spouse. It is
  taken before the child tax credit, so more of that one can be refunded. Dependent care benefits from an employer
  (box 10 of the W-2) are excluded up to $5,000, and the rest is taxed as wages. Filing jointly, a spouse who was a
  full-time student or couldn't care for themselves, and had no wages, counts as earning $250 ($500) a month.
- Deductions: the standard deduction, with the additional amounts at 65 or older and for blindness, the smaller
  deduction of someone who can be claimed as a dependent, and the 2025 enhanced deduction for seniors.
- Tax: the IRS Tax Table under $100,000 and the Tax Computation Worksheet from $100,000, the Additional Medicare Tax,
  the net investment income tax, and a credit for excess social security tax withheld by two or more employers.

A parent's release of the claim to a child (Form 8332), itemized deductions, tips and overtime pay, a household
employee (Schedule H), and other income come in later versions. The app says so when one of them applies,
instead of giving a wrong amount. A finished US return downloads as one PDF: the IRS's Form 1040 and the schedules and
forms it uses (Schedules 1-A, 2, 3, 8812 and EIC, and Forms 2441, 8959 and 8960), filled in, then a worksheet. Taxi
doesn't read US forms by AI yet: enter each W-2 and 1099-INT on Income.

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
