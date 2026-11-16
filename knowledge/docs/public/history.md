---
title: History and going back
description: Every change to a Knowledge collection saves a restore point: go back to an earlier version, undo it, and see why an old version may not come back.
order: 7
---

This page explains restore points, going back, undo and backups. It is for collection owners, admins and editors,
and for AI agents that read a collection's history.

## Restore points

Every change to what a collection knows saves a **restore point** automatically: files and web pages added, notes,
corrections, a file stopped or used again, going back. A collection's **History** lists them, newest first, with when
each was saved, what changed and how many documents it held. Changes made within 5 minutes of each other share one
restore point, so a few quick changes come back, or are taken back, together. Restore points are kept 30 days.

Sharing and settings aren't part of a restore point: who has access never changes by going back.

## Go back to an earlier version

The collection's owner, admins and editors can choose **Go back to this version** on an earlier restore point. Before
anything happens, Knowledge explains what it will do: what the collection will know, which files added later will be
**set aside, not deleted** (they can be added again from Sources), and how many later corrections will be undone.

Going back takes about a minute, and questions wait meanwhile. Then the collection answers from that version, and going
back is itself a new restore point. **Undo** brings everything back as it was before.

Through the API: `GET /api/collections/{id}/history`, then `GET /api/collections/{id}/history/{version}/preview` for
the explanation, then `POST /api/collections/{id}/history/{version}/go-back`; `POST /api/collections/{id}/history/undo`
undoes it. Going back and undo need the collection's Editor role and an `Idempotency-Key`.

## Versions that can't be brought back

| Reason | What it means |
|---|---|
| A file was removed for good | A file it held was removed for good after it, so no earlier version can bring the file back. |
| Expired | Restore points last 30 days. |
| Upgraded | Insulin Knowledge was upgraded since it was saved, and that version can no longer be opened. The collection itself came across from its latest backup. |
| Newly hidden | It holds text that a stricter hiding rule now hides. |
| Damaged | It was found damaged when Insulin checked it, twice. |

Over the API, going back to such a version answers 409 `not_restorable`.

## Backups

Besides restore points, every collection is backed up daily. Daily backups are kept for the organization's days of
daily backups (30 by default; History's footer and Health say how many), and the latest one as long as the collection
exists, so a collection is never lost by sitting unused. Admins see each collection's last restore
point and last backup on **Health**. See [Your data](/docs/knowledge/your-data).
