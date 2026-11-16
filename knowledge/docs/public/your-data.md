---
title: Your data in Knowledge
description: Export a Knowledge collection, delete one, what Knowledge keeps and for how long, and the counts it reports to Insulin Apps every hour.
order: 11
---

This page explains how a collection is exported and deleted, what Knowledge keeps, and which numbers it sends Insulin
Apps. It is for collection owners and admins, organization owners, and anyone who wants to know where their data goes.

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

Original files are never part of an export: Knowledge doesn't keep them after reading them.

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
| Daily backups | 30 days; the latest as long as the collection exists |
| Exports | 7 days |
| Who may do what: sharing, the list of collections, questions asked, reports and corrections (kept as learned, with hidden values hidden) | In Knowledge's own database, for the organization only, until the collection (or the organization) is deleted |
| Notes waiting for the 1st (the month's documents learned used up), with hidden values hidden | Until they are learned |
| The activity log: collections deleted or transferred, by whom and when | As long as the organization uses Knowledge |
| Answers to changes, kept so a change sent twice isn't done twice | A day |

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
