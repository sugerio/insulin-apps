---
title: How Taxi works
description: What Taxi stores, how saves stay consistent, the usage it reports to Insulin Apps, and its limits.
order: 5
---

This page explains what happens behind Taxi's pages. It is for people who want to know what is stored and how,
and for AI agents answering questions about the app.

## What is stored

Taxi keeps its own database. Each organization has one household, with:

- **People:** name, relationship and birth date.
- **Tax years:** the marital status on December 31, whether both returns are prepared together, and a revision number
  that changes with each save.
- **Returns:** for each adult and year, the province on December 31 and whether they lived in Canada all year.
- **History:** who made each change, when, and whether they used the browser, an AI agent or an API client.

It never stores a SIN, a home address or bank details.

## How saves stay consistent

Each change is written in one step with its history entry: either all of it is saved, or none of it. A year's household
facts are saved under the year's revision. A save based on an older revision is refused, so two people editing the same
year never overwrite each other without knowing.

## Usage reports

Once an hour, Taxi sends Insulin Apps a count of its records for each organization (households, people, tax
years and returns) and the size of its database, so that Insulin Apps can watch usage and plan capacity. It never sends
a name, a birth date, an amount or a document.

## Limits today

- Only the household step works; the other steps of a year come later.
- Only the 2025 tax year.
- Ontario, British Columbia and Alberta residents who lived in Canada all year.
