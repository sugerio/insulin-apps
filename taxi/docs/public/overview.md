---
title: Taxi overview
description: What Taxi does, who it is for, what it doesn't do yet, and how it runs on Insulin Apps.
order: 1
---

Taxi prepares Canadian personal income tax returns, and United States federal returns with the California or New York
return. This
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
3. **Income.** Employment, investments and the rest: the slips found, open box by box to check, change or remove, and
   what else to add.
4. **Deductions.** RRSP and FHSA contributions, working from home, child care and moving expenses, and what your
   slips already deduct.
5. **Credits.** Tuition, medical expenses, donations, a single parent's child's net income (for the eligible dependant
   amount), and what your slips already claim.
6. **Confirm.** Every number AI read, to check against the papers. Save and continue on Income, Deductions and Credits
   confirms the forms that step showed, so Confirm lists first what is still to check.
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

## United States

When you start a year, you choose Canada or the United States. A year is of one country. A US year prepares the
federal Form 1040 of a U.S. citizen or resident alien for the whole year, and Personal info asks each person's state on
December 31. For a California resident, Taxi also prepares the California return (Form 540), and for a New York
resident the New York return (Form IT-201). For another state, Taxi
prepares the federal return only, and says to file the state return with other software. A state with no income tax
return (such as Texas or Florida) needs none.

The US return covers:

- Income: wages on Form W-2, and interest on Form 1099-INT (with savings bond and Treasury interest, and tax-exempt
  interest).
- Investments: dividends on Form 1099-DIV, and sales of stocks, bonds and funds on Form 1099-B. A broker's 1099-B is
  entered as one summary for each part of Form 8949 (box A, B, D or E). Sales whose basis was reported to the IRS (box A
  or D) and that need no adjustment go on Schedule D, lines 1a and 8a. A capital loss is deducted up to $3,000 ($1,500
  filing separately), and a loss carried over from 2024 is asked. Qualified dividends and long-term gains are taxed at
  0%, 15% or 20% (the Qualified Dividends and Capital Gain Tax Worksheet). Foreign tax on these forms of $300 or less
  ($600 jointly) is a credit, without Form 1116.
- Retirement income: IRA distributions and pensions on Form 1099-R, with the taxable amount in box 2a and the
  distribution code in box 7 (codes 1, 2, 3, 4 and 7, and direct rollovers G and H). An early distribution (code 1)
  adds the 10% additional tax. Social security benefits on Form SSA-1099 are taxed by the Social Security Benefits
  Worksheet: none, up to 50% or up to 85% of them.
- Self-employment: one business for each person, as a sole proprietor (Schedule C). Its income is each Form 1099-NEC
  you add plus what you enter, and its expenses are asked line by line, with half of business meals. The app works out
  the self-employment tax (Schedule SE), deducts half of it (Schedule 1), and takes the qualified business income
  deduction (Form 8995) when taxable income is at or below $197,300 ($394,600 jointly). The profit counts as earned
  income for the earned income credit, the child tax credit and the care credit. A loss, depreciation, a home office,
  inventory and more than one business come in later versions.
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
- The education credits (Form 8863), for you, your spouse filing jointly, or a dependant 14 or older. You enter each
  student's tuition and required fees, less tax-free scholarships, and choose the credit. The American opportunity
  credit is all of the first $2,000 and 25% of the next $2,000 for each student, and 40% of it is refundable. The
  lifetime learning credit is 20% of up to $10,000 for the return. Both are smaller from $80,000 of modified AGI
  ($160,000 jointly), and none is left at $90,000 ($180,000). They come after the care credit and before the child tax
  credit. Filing separately, or if someone can claim you, you can't take them.
- Deductions: the standard deduction, with the additional amounts at 65 or older and for blindness, the smaller
  deduction of someone who can be claimed as a dependent, or itemized deductions (Schedule A) when they are larger:
  medical expenses over 7.5% of AGI, state and local taxes up to the 2025 limit of $40,000 (less at a higher income),
  mortgage interest and points on Form 1098, and gifts to charity. Filing separately, you itemize when your spouse
  does. Also the 2025 deductions on Schedule 1-A: for seniors, for
  qualified tips (up to $25,000), for the "half" of time-and-a-half overtime pay (up to $12,500, or $25,000 jointly),
  and for interest on a loan for a new car assembled in the U.S. (up to $10,000). Each is smaller at a higher income.
  Filing separately, the tips and overtime deductions can't be taken. The tips amount starts from box 7 of the W-2.
- Student loan interest: up to $2,500 (Schedule 1, line 21), smaller from $85,000 of modified AGI ($170,000 jointly).
  It lowers the AGI. Filing separately, or if someone can claim you, you can't deduct it.
- Adjustments: contributions to a traditional IRA (up to $7,000, $8,000 at 50 or older), smaller in the phase-out
  when you or your spouse are covered by a retirement plan at work; and contributions to a health savings account
  (Form 8889), up to the 2025 limit less what your employer put in (box 12 of the W-2, code W).
- Tax: the IRS Tax Table under $100,000 and the Tax Computation Worksheet from $100,000, the capital gain rates, the
  alternative minimum tax (Form 6251, with private activity bond interest), the Additional Medicare Tax, the net
  investment income tax on interest, dividends and gains, and a credit for excess social security tax withheld by two
  or more employers.

These come in later versions: a parent's release of the claim to a child (Form 8332), allocated tips (box 8 of the
W-2) and unreported tips (Form 4137), a business loss, a household employee (Schedule H), other income (unemployment,
rent, alimony and the like: asked on Income), sales that need Form 8949, the 28% and section 1250 rates (the Schedule D
Tax Worksheet), foreign tax over $300 (Form 1116), a 1099-R code other than those above or a taxable amount the payer
didn't figure, nondeductible IRA contributions (Form 8606), an exception to the 10% tax (Form 5329), HSA coverage for
part of the year, mortgage interest on more than $750,000 of debt, and noncash gifts over $500 (Form 8283). The app
says so when one of them applies, instead of giving a wrong amount. A finished US return downloads as one PDF: the
IRS's Form 1040 and the schedules and forms it uses (Schedules 1, 1-A, 2, 3, A, C, D, SE, 8812 and EIC, and Forms 2441,
6251, 8863, 8889, 8995, 8959 and 8960), filled in, then a worksheet. Schedule B (more than $1,500 of interest or
dividends) is named on the worksheet for you to fill in.

### California

For a person who lived in California all year, Taxi also prepares Form 540, from the federal return:

- Schedule CA (540): what California taxes differently. It subtracts social security benefits and interest on U.S.
  savings bonds and Treasury obligations. It adds tax-exempt interest from other states' bonds (you say how much of it
  is from California bonds), and the health savings account: the HSA deduction, your employer's contributions and what
  the HSA earned. Itemized deductions leave out the state income tax and have no $40,000 limit.
- The California standard deduction ($5,706, or $11,412 jointly or as head of household), or itemized deductions when
  they are larger, whatever the federal return does. Both are limited over $252,203 of federal AGI ($504,411 jointly).
- The tax from the California Tax Table or Tax Rate Schedules, the exemption credits ($153 each, $475 for each
  dependent, smaller at a high income), the Behavioral Health Services Tax over $1,000,000, the 2.5% tax on an early
  retirement distribution, and the California alternative minimum tax (Schedule P).
- Credits: the renter's credit ($60, or $120 jointly or as head of household, under an income limit); the child and
  dependent care credit (form FTB 3506, up to $100,000 of federal AGI, for care in California); and the refundable
  California earned income tax credit, Young Child Tax Credit and Foster Youth Tax Credit (form FTB 3514).
- Payments: California tax withheld on each W-2 and 1099 whose state box says CA, and California estimated payments.
  The use tax is asked, as Form 540 can't leave it blank.

Married filing separately in a community property state (California, Texas and seven others) needs Form 8958, which
Taxi doesn't prepare: the federal return says so. On the California return, Taxi says so instead of giving a wrong
amount for: a part-year resident or a spouse in another state (Form 540NR), tax withheld for another state, a year
without health coverage (form FTB 3853), and the Young Child Tax Credit with no earned income. The California forms are
printed after the federal ones, from ftb.ca.gov: Form 540, Schedule CA (540), Schedule P (540), FTB 3506 and FTB 3514.

### New York

For a person who lived in New York State all year, Taxi also prepares Form IT-201, from the federal return. It includes
the New York City tax for a New York City resident and the Yonkers surcharge for a Yonkers resident. Personal info asks
where in New York you lived.

- Additions and subtractions: interest from other states' bonds is added (you say how much is from New York bonds), and
  414(h) retirement contributions of a public employee. Social security benefits, interest on U.S. obligations, a New
  York State, local or federal government pension, and New York 529 contributions (up to $5,000 for each owner) are
  subtracted. Someone who was 59½ or older can exclude up to $20,000 of other pension and IRA income.
- The New York standard deduction ($8,000, $16,050 jointly, $11,200 as head of household, $3,100 for someone another
  person can claim), or Form IT-196 itemized deductions when they are larger, whatever the federal return does. Form
  IT-196 has no limit on property taxes, leaves out income taxes, uses a 10% floor for medical expenses, and is limited
  at a high income. Each dependent gives a $1,000 exemption.
- The New York State tax from the Tax Table, the tax rate schedule, or the tax computation worksheets over $107,650 of
  New York AGI. The New York City tax from its own table and rate schedule.
- Credits: the household credits; the Empire State child credit ($1,000 for each child under 4, $330 for each child of 4
  to 16, Form IT-213); the earned income credits (30% of the federal credit for New York State, 10% to 30% for New York
  City, Form IT-215); the child and dependent care credits (Form IT-216); the college tuition credit (Form IT-272); the
  New York City school tax credits; and the New York City income tax elimination credit (Form IT-270).
- The MCTMT for net earnings from self-employment over $50,000 in New York City or the seven counties near it.
- Payments: New York State tax withheld on each W-2 and 1099 whose state box says NY, New York City and Yonkers tax
  withheld (box 19 of a W-2 with box 20 NYC or YONKERS), and New York estimated payments. The sales or use tax is asked,
  as Form IT-201 can't leave it blank.

On the New York return, Taxi says so instead of giving a wrong amount for: a part-year resident or a spouse in another
state (Form IT-203), a part-year New York City or Yonkers resident (Form IT-360.1), spouses who lived in different
places, tax withheld for another state (Form IT-112-R), Yonkers earnings of a nonresident (Form Y-203), a business both
inside and outside the MCTMT zones, other additions and subtractions (Form IT-225), and the real property tax credit
(Form IT-214). The New York forms are printed after the federal ones, from tax.ny.gov: Form IT-201, Forms IT-196, IT-213,
IT-215, IT-216, IT-270 and IT-272 when they apply, and Form IT-2 with a record for each W-2 (and Form IT-1099-R for each
1099-R with New York tax withheld).

AI reads the US forms you upload: Forms W-2, 1099-INT, 1099-DIV, 1099-B (a broker's summary, one for each part of Form
8949), 1099-R, 1099-NEC, SSA-1099, 1098, 1098-T and 1098-E, with their state boxes. Each one goes to the return of the person named on it. A 1098-E is added to the student loan interest. A 1098-T is not added to the
credit as it is: its box 1, less boxes 5 and 10, is offered as the start of that person's education expenses on
Personal info. A 1098-T for a dependant is not added, because a dependant has no return here: enter its amounts on the
dependant's card. You can also type each form in on Income or Confirm.

Hints on Finish for a US year: what filing jointly or separately would save a married couple, worked out from what you
entered (you change the filing status on Personal info); a possible penalty for paying too little tax during the year;
and interest that is taxable without a 1099-INT.

## What it stores

For each person: their name, their relationship to you and their birth date. For each tax year: who is in it (your
spouse in it means both returns are prepared together), the marital status on December 31, each adult's province (or
US state) and whether they lived in the country all year, their slips and their answers. Every change records who made it and when.

Taxi never asks for a social insurance number (SIN), a home address or bank details, and none of its fields holds
them. You write those on the paper return when you sign it. An uploaded slip is kept as it was uploaded, so the SIN
and address printed on it are in the file until you delete it or upload a new version that Taxi reads.

## On Insulin Apps

Taxi runs at `https://taxi.insulinapps.com`. Sign in to Insulin Apps, create an organization (a
family can be an organization of one), and open the app. People and roles are managed on Insulin Apps; see
[Roles and access](/docs/taxi/roles-and-access). AI agents connect over MCP, and API clients call the same API
as the browser; see [Taxi API](/docs/taxi/api).
