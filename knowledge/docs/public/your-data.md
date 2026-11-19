---
title: Your data in Knowledge
description: Export a Knowledge collection, delete one, what Knowledge keeps and for how long, and the counts it reports to Insulin Apps every hour.
order: 11
---

This page explains how a collection is exported and deleted, what Knowledge keeps, and which numbers it sends Insulin
Apps. It is for collection owners and admins, organization owners, and anyone who wants to know where their data goes.

## Where Knowledge runs and keeps your data

Knowledge runs on Cloudflare, in three parts. Insulin Apps signs people in and knows their organization and role. The
Knowledge app checks every request against that role, the collection's sharing and the limits. Its engine, which only
the app can reach, keeps each collection apart from every other.

```diagram
title: Where Knowledge runs and where your data lives
description: People, AI assistants and programs reach Knowledge through Insulin Apps at insulinapps.com, which signs people in, keeps organizations, people and roles, and passes each request on with who is asking. The Knowledge app checks the caller's role, the collection's sharing and the limits, and keeps sharing, the lists, questions asked and logs in its own database. Only the app reaches the engine, which runs one Durable Object and one container for each collection, asleep when nobody asks. It saves a restore point after every change, kept 30 days, keeps the learned text with hidden values removed in storage (original files are deleted once read), and takes daily backups, the latest kept as long as the collection exists. The built-in model, Gemma 4, writes the answers on the site, unless an Admin chose the organization's own model, which is reached through the organization's integration on Insulin Apps. An export is a zip file of the learned text, notes, facts, corrections, history and settings, never the original files.
size: 760 x 600
box people 20 20 230 50 "People" "in a web browser"
box assistants 265 20 230 50 "AI assistants" "over MCP, as their person"
box programs 510 20 230 50 "Programs" "the API, with an OAuth client"
box gateway 20 100 720 60 accent "Insulin Apps (insulinapps.com)" "signs people in; keeps organizations, people and roles"
group app 20 190 720 104 "Knowledge app"
box check 36 224 420 54 "Checks every request" "your role, the collection's sharing, the limits"
box appdb 480 220 244 62 db "Knowledge's database" "sharing, lists, questions, logs"
group engine 20 320 720 128 "Knowledge engine, private: only the app reaches it"
box collection 36 354 280 70 "One engine per collection" "a Durable Object and a container," "asleep when nobody asks"
box restore 356 352 184 74 db "Restore points" "a copy after each" "change, kept 30 days"
box model 566 352 158 74 muted "Built-in model" "Gemma 4 writes the" "site's answers"
group storage 20 480 470 100 "Storage"
box text 36 512 200 56 "Stored text" "hidden values removed," "originals deleted once read"
box backups 252 512 222 56 "Daily backups" "the latest kept as long" "as the collection exists"
box export 510 480 230 100 dashed "An export (.zip)" "the learned text, notes, facts," "corrections, history, settings;" "never the original files"
arrow people.b -> gateway.t:0.16
arrow assistants.b -> gateway.t:0.5
arrow programs.b -> gateway.t:0.84
arrow gateway.b:0.314 -> check.t "who is asking, and their role" label=0.3
arrow check.r -> appdb.l
arrow check.b:0.3333 -> collection.t "names the organization" label=0.3
arrow collection.r -> restore.l
arrow collection.b:0.357 -> text.t
arrow collection.b:0.964 -> backups.t:0.243 "daily"
arrow engine.b:0.8403 -> export.t dashed "owner or admin"
```

## Export a collection

A collection's owner and admins export it from its **Sharing** tab: **Export** prepares a download, which stays
available for 7 days. Exports are per collection: nobody, not even an owner of the organization, can export every
collection at once, and an owner of the organization can't export a collection they have no role in. Export is done on
the site only.

An export is a zip file in open formats, with:

- the text Knowledge learned from each file, web page or note, with hidden values shown as `[hidden]`, and each
  document's page map;
- the notes people wrote, the facts Knowledge found (each with the sentence it came from), the corrections and the
  history;
- the collection's settings and counts.

Original files are never part of an export: Knowledge doesn't keep them after reading them. A new collection can
**Start from an export** (in this organization or another): it brings back the same sources, the files it stopped
using, its notes and corrections, so it answers the same. See
[Collections and sources](/docs/knowledge/collections-and-sources).

## Delete a collection

A collection's owner, or an owner of the organization, deletes it from **Delete…** after typing its name. Its files,
notes, facts and backups are removed at once, and everyone it was shared with loses access. Saved restore points can't
be opened afterwards and expire within 30 days. When an owner of the organization deletes someone else's collection,
its owner gets an e-mail.

Knowledge's own records of it go too: the questions asked of it, its reports and corrections, the names of its files,
its history and who it was shared with. What stays is a line in the organization's activity log: that a collection with
that name was deleted, by whom and when.

Nobody deletes collections in bulk. When an organization is deleted on insulinapps.com, everything Knowledge kept for
it is deleted too, the activity log included: only a note that its data was removed, with no names, stays.

## What Knowledge keeps

| What | How long |
|---|---|
| Original files | Only until they are read: then deleted |
| The text learned, with hidden values removed, and the facts | As long as the collection exists, or until the file is removed for good |
| Restore points | 30 days |
| Daily backups | The organization's days of daily backups (30 by default); the latest as long as the collection exists |
| Exports | 7 days |
| Who may do what: sharing, the list of collections, questions asked, reports and corrections (kept as learned, with hidden values hidden) | In Knowledge's own database, for the organization only, until the collection (or the organization) is deleted |
| Notes waiting for the 1st (the month's documents learned used up), with hidden values hidden | Until they are learned |
| The activity log: collections deleted or transferred, by whom and when | As long as the organization uses Knowledge |
| Answers to changes, kept so a change sent twice isn't done twice | A day |
| What the engine did that couldn't be recorded yet (file names and counts, never what the files say) | Until it is recorded, or the collection is deleted |

Each collection is kept apart from every other, and one organization never sees another's.

## The numbers Knowledge sends to Insulin Apps

Every hour, Knowledge sends Insulin Apps a few numbers, so that Insulin Apps can see usage beside each organization's
limits and plan its capacity. For each organization, exactly these:

| Key | What it counts |
|---|---|
| `collections` | How many collections the organization has |
| `documents` | How many files, web pages and notes they hold |
| `storage_bytes` | The size of the text kept |
| `learned_month` | Documents learned this month |
| `questions_month` | Questions asked this month, on the site, from AI assistants and from API clients |
| `answers_month` | Answers written by the built-in model this month |
| `awake_hours_month` | Hours collections were awake this month |
| `ready_collections` | Collections kept ready |

And for Knowledge as a whole, `database_bytes`: the size of its database. The monthly numbers drop to 0 on the 1st.

These are counts and sizes only. Knowledge never sends names, e-mail addresses, questions, answers, the text of files
or anything else from a collection.
