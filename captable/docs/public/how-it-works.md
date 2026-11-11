---
title: How Cap Table works
description: The append-only ledger behind Cap Table, how the cap table is replayed for any date, how corrections work, and how data stays separate.
order: 7
---

This page explains what happens underneath Cap Table's screens: an append-only ledger of facts, replayed to produce the
cap table for any date. It is for anyone who needs to trust the numbers (auditors, counsel, finance teams) and for
developers and AI agents who want to understand why the API works the way it does. You don't need any of it to use the
app day to day.

## The ledger: a permanent record of facts

Cap Table doesn't store "who owns what" as a table that gets edited. It stores a **ledger**: one entry for each fact,
such as "an option grant of 48,000 options to Jordan Park, effective 2024-02-01" or "Jordan Park exercised 12,000
options on 2026-03-15". Positions, vesting, deadlines and the cap table itself are all worked out from the ledger.
Nothing that describes holdings is stored twice, so the numbers can't drift apart.

Every ledger entry carries:

- **what happened**, as a typed transaction with its details;
- **its effective date**, the legal date the fact took effect, in the company's time zone;
- **who recorded it and how**: the person, AI agent or OAuth client, or the import;
- **a fingerprint** (a SHA-256 hash) of its contents, chained to the entry before it.

The ledger is **append-only**. Database rules refuse any edit or deletion of an entry, and each entry must link to the
one before it, so the chain shows at once if anything was ever changed. Transaction types follow the Open Cap Table
Format (OCF) where it has one, and Cap Table's own documented extensions where it doesn't (terminations, leaves of
absence, merges, reversals, opening balances).

Descriptive details that never change a number, such as names, contact details and settings, are kept beside the
ledger. They can be edited, and every edit is in the audit log.

## Replay: the cap table for any date

To show the cap table, Cap Table **replays** the ledger: it takes the entries in order of effective date and applies
them one by one, checking the rules as it goes.

```diagram
title: The ledger and the replay
description: Every change, whether made in the app's forms, by an AI agent or OAuth client through the API, or by an import, is first checked by replaying the whole ledger with the new entry, and refused if a rule breaks. Accepted changes are appended to the ledger, where each entry records what happened, its effective date, who recorded it, and a SHA-256 hash chained to the entry before; a mistake is undone by a reversal entry, never by an edit. Replaying the ledger in date order up to any date produces the cap table, each holder's holdings and vesting, and the reports and deadlines.
size: 740 x 545
box people 20 20 220 56 "People" "forms in the app"
box agents 260 20 220 56 "AI agents, API clients" "ledger commands"
box import 500 20 220 56 "Import" "Pulley or spreadsheet"
box check 170 118 400 70 accent "Check first" "replay the whole ledger with the new entry," "and refuse it if any rule breaks"
group ledger 20 230 700 160 "Ledger, append-only"
box e1 40 272 150 60 "#1 Opening" "balances, imported"
box e2 210 272 150 60 "#2 Grant" "48,000 options"
box e3 380 272 150 60 "#3 Exercise" "12,000 shares"
box e4 550 272 150 60 dashed "#4 Reversal" "undoes #3"
text 370 352 small muted "Each entry: what happened, its effective date and who recorded it,"
text 370 370 small muted "with a SHA-256 hash chained to the entry before it."
box replay 40 425 260 80 accent "Replay as of a date" "entries in date order," "every rule checked again"
box out1 380 420 340 30 pill "The cap table on any date"
box out2 380 457 340 30 pill "Holdings, vesting and positions"
box out3 380 494 340 30 pill "Reports and deadlines"
arrow people.b -> check.t:0.15 mid=97
arrow agents.b -> check.t:0.5
arrow import.b -> check.t:0.85 mid=97
arrow check.b -> ledger.t:0.5 "append"
arrow e1.r -> e2.l
arrow e2.r -> e3.l
arrow e3.r -> e4.l
arrow ledger.b:0.214 -> replay.t:0.5 "read"
arrow replay.r:0.25 -> out1.l mid=340
arrow replay.r:0.59 -> out2.l
arrow replay.r:0.8 -> out3.l mid=340
```

- **As of a date.** Pick any date under **As of**, and the replay stops at entries effective on that day. That is how
  the cap table, a holder's position or a report can be shown for any day in the company's history.
- **As known at a point.** The API can also replay only the entries recorded up to a given position in the ledger
  (`asKnownAt`), to show what the cap table said before a later correction.
- **The rules checked on every replay:** no holding ever goes below zero, shares outstanding stay within what is
  authorized, new grants stay within what the plan has available, exercises stay within what is vested and not yet
  exercised, and dates come in a sensible order.
- **Back-dated changes are checked too.** Before any change is saved, Cap Table replays the whole ledger with the new
  entries at their effective dates. A change dated in the past that would break a rule on some later date is refused.

Replayed results are kept in memory for speed, keyed by the exact state of the ledger, so a newer change always gives a
fresh result.

## Recording a change

Every change to holdings is a **command**, such as recording a grant or terminating a stakeholder. The screens and the
API follow the same steps:

1. **Check access.** The caller must be allowed to record changes, and the change must not touch their own holdings.
2. **Dry run.** Cap Table works out the new entries, replays the ledger with them, and shows exactly what will change,
   with any rule that blocks it and any warning to accept.
3. **Confirm.** The real request carries the position of the ledger and the fingerprint of the change that was
   reviewed. If anyone else changed the cap table in between, the request is refused and the change is reviewed again.
4. **Save all at once.** The new entries, the links to documents and the audit record are written in one step. Either
   all of it is saved or none of it.

Each request carries an idempotency key, so a request repeated after a lost connection never records anything twice.
Two people saving at the same moment can't both win: one change is saved, and the other is refused and reviewed again.

## Corrections: reversal, never rewriting

A mistake is corrected by **reversing** the whole change that recorded it, with a reason. The reversal is itself a new
ledger entry for each entry it undoes.

- The original stays in the history, marked as reversed, with who reversed it, when and why.
- A change can be reversed only once, and only as a whole.
- A change can't be reversed while something that depends on it still stands (an exercise made from a grant, for
  example). Reverse that first; the reversal preview shows what depends on what.
- Imported history can't be reversed.
- Before a reversal is saved, Cap Table replays the ledger without the reversed change and refuses it if any rule would
  break on any date.

Replay skips reversed entries, so the cap table immediately reflects the correction. A view "as known" from before the
reversal still shows the original, which is what an auditor needs.

## Exact numbers and dates

- **No rounding behind your back.** Quantities and amounts are exact decimals, never floating-point numbers. Ratios and
  percentages are calculated exactly. Rounding happens only when a number is displayed or exported.
- **The share unit.** Each company has one (whole shares by default). It decides how vesting rounds, and it can't change
  once the first entry is in.
- **Calendar dates.** Legal dates are calendar dates in the company's time zone, and "today" is the company's local
  date.

## Vesting and deadlines

Vesting, exercise deadlines and expiries are worked out during the replay, not stored.

- **Vesting** comes from each grant's schedule: tranches on the same day of the month as the vesting start (or the
  month's last day), with the running total rounded down to the share unit so the last tranche takes any remainder.
  Grants imported from Pulley keep Pulley's exact dates and amounts.
- **A termination** records the vesting stop date. Unvested awards are cancelled at that date, and each option gets an
  exercise deadline (from the grant or the plan, never past expiration) and, for an ISO, an ISO deadline.
- **The ISO/NSO split** applies the $100,000-a-year limit to a holder's ISO grants in the order they were granted.
- **409A status** (presumptively valid, expiring soon, review required, superseded, expired) is worked out from each
  valuation's dates and any material event flagged.
- **Due items.** Cap Table has no background jobs. Scheduled terminations and expiries are recorded when someone who
  records changes opens the dashboard or chooses **Process due items**. Each due item has a fixed key, so running it
  twice never records it twice.

## The import

An import is a set of commands too, built from your files and replayed before anything is saved.

- The **preview** reads the files, checks every record, maps it to ledger entries, and replays the result through the
  same engine. For Pulley's reports, the replayed company, class, plan, holder and security totals must equal the Raw
  Cap Table's.
- History the files can't express becomes **opening balances**: entries that record a holding as it stands on a date,
  each with its reason.
- The **commit** checks that the files and the as-of date are exactly the ones you reviewed, writes the new company where
  nobody can see it yet, verifies the whole ledger, compares the totals with the preview, and only then switches the
  company on, all in one final step. If anything fails, nothing becomes visible.

## Keeping organizations apart

One copy of Cap Table serves every organization on Insulin Apps, and each organization's data stays its own.

- **One company per organization.** Every company belongs to exactly one Insulin Apps organization, and every query is
  limited to the caller's organization.
- **Records can't point across companies.** Every record carries its company, and links between records include it, so
  a record can never refer to another company's data.
- **Holders see only themselves.** The holder view answers only from the caller's own matched stakeholder records,
  through separate endpoints that return only allowed fields: no cap table, no other holders, no fully diluted
  percentages.
- **Identity comes from the platform.** Cap Table has no passwords or sessions of its own. Insulin Apps signs people
  in and tells Cap Table who is calling, in which organization and with which permissions. Those permissions can only
  narrow a role, never widen it.

## The audit log and verification

- **Recent Activity** lists every change: what changed (before and after), who made it and when. Downloads of reports
  and documents are recorded too. The audit log also keeps each request's user agent, which for an AI agent or an
  OAuth client names the client (`Insulin Apps MCP: <client>` or `Insulin Apps API: <account>`). Nothing in it can
  be edited or removed. The **Audit log** report downloads it as CSV.
- **Ledger verification** re-checks a company's whole ledger from the raw records: every fingerprint, the unbroken
  chain, every command's completeness, every reversal, and a full replay with every rule. Anyone who records changes
  can run it through the API with `POST /api/admin/orgs/{orgId}/verify-ledger`. See [the API](/docs/captable/api).

## Documents

Documents are stored in Cap Table's own database, split into chunks, each file with a SHA-256 checksum checked against
its declared type. Their bytes are never changed or deleted: a document is archived or replaced by a new version, and
the earlier versions stay. Whether a holder can see a document is enforced by the database: a document linked to two or
more holders can never be shown to holders.
