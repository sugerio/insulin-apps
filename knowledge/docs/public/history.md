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

Each restore point also says **who added** its files, web pages, notes and corrections: a person by name, or an API
client by its name. A program that writes what a person approved can say whom it acted for (the `x-on-behalf-of`
header, see [Writing for people](/docs/knowledge/ai-assistants-and-api#writing-for-people-notes-corrections-and-open-questions)),
and History shows it: "By Partner Agent, on behalf of Ana Lee". That is what the program said, a label only: it gives
nobody access. Going back, undo and stopping a file name no one.

Sharing and settings aren't part of a restore point: who has access never changes by going back.

## Go back to an earlier version

The collection's owner, admins and editors can choose **Go back to this version** on an earlier restore point. Before
anything happens, Knowledge explains what it will do: what the collection will know, which files added later will be
**set aside, not deleted** (they can be added again from Sources), and how many later corrections will be undone.

Going back takes about a minute, and questions wait meanwhile. Then the collection answers from that version, and going
back is itself a new restore point. **Undo** brings everything back as it was before.

```diagram
title: Going back, then undo
description: Three changes saved three restore points; going back to the second makes a fourth that answers from that version, with the third's file set aside, not deleted. Undo then makes a fifth with everything as it was in the third.
size: 760 x 330
box p1 20 70 150 70 "Restore point 1" "learned 3 files"
box p2 195 70 150 70 "Restore point 2" "added a note"
box p3 370 70 150 70 "Restore point 3" "learned 1 more file"
box p4 550 70 190 70 accent "Restore point 4" "went back to 2; the file" "from 3 is set aside"
box p5 550 210 190 70 "Restore point 5" "undo: as it was at 3"
arrow p1.r -> p2.l
arrow p2.r -> p3.l
arrow p3.r -> p4.l
arrow p2.t -> p4.t:0.4 dashed mid=36 "answers from version 2"
arrow p4.b -> p5.t "Undo"
arrow p3.b -> p5.l dashed "everything comes back"
text 380 310 small muted "Changes within 5 minutes of each other share one restore point. Who has access never changes."
```

The same steps in a collection's History, before undo: three files learned, a note, one more file, then going back to
the note's version, which can be undone.

![A collection's History after going back: the newest restore point, Went back to the version from earlier today, marked Now with Undo, then Added 1 file, Added a note and Added 3 files, each with Go back to this version](/docs/assets/screenshots/knowledge-history.png "History: restore points, going back and undo")

Through the API: `GET /api/collections/{id}/history` (each restore point with `madeBy`:
`[{ id, type, name, onBehalfOf }]`), then `GET /api/collections/{id}/history/{version}/preview` for the explanation, then `POST /api/collections/{id}/history/{version}/go-back`; `POST /api/collections/{id}/history/undo`
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

![Health, for Admins in Knowledge: each collection they have a role in, asleep or awake, with its documents, last restore point, last backup, repairs and when it was last used, then the organization's totals](/docs/assets/screenshots/knowledge-health.png "Health: how each collection is doing, in plain words")

Health also says when what Knowledge's engine did in a collection is waiting to be recorded, and since when: its lists,
counts, history and usage may be behind until it is. Answers aren't affected, other collections go on, and Knowledge
tries again every five minutes, in the order things happened.
