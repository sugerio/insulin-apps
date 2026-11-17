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
- **History:** who made each change, when, and whether they used the browser, an AI agent or an API client.

It never stores a SIN, a home address or bank details.

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

## How saves stay consistent

Each change is written in one step with its history entry: either all of it is saved, or none of it. A year's household
facts are saved under the year's revision. A save based on an older revision is refused, so two people editing the same
year never overwrite each other without knowing.

## Usage reports

Once an hour, Taxi sends Insulin Apps a count of its records for each organization (households, people, tax
years and returns) and the size of its database, so that Insulin Apps can watch usage and plan capacity. It never sends
a name, a birth date, an amount or a document.

## Limits today

- Only the household step works; the other steps of a year come later. Slips can't be entered yet.
- The 2025 rules cover one adult's T1 and Ontario's ON428: employment, interest, dividends, trust income and capital
  gains; RRSP, FHSA, pension plan and union dues; the basic, age, CPP, EI, employment, tuition, medical and donation
  credits. Couples and British Columbia and Alberta tax come next.
- When the rules meet a case they don't handle, such as a CPP overpayment from two jobs, the number is shown as
  missing with the reason, never guessed.
- Only the 2025 tax year.
- Ontario, British Columbia and Alberta residents who lived in Canada all year.
