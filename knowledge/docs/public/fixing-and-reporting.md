---
title: Fixing and reporting answers
description: Fix a wrong Knowledge answer once so every new question uses the fix, report one when you can only read, and check what a collection knows.
order: 5
---

This page explains how a wrong answer is corrected once for everyone, how people who can only read report one, how
facts are checked, and what **Needs attention** lists. It is for collection owners, admins and editors, for everyone
who asks, and for AI agents that can correct or report.

## Fix a wrong answer once

Under every answer, **Was this right?** offers **Yes** and **Not right**. **Yes** marks the answer right; each
collection's **Overview** shows how many of its answers were marked right. For the collection's owner, admins and
editors, **Not right** opens the fix:

1. Write the right answer.
2. Pick the source that is out of date, or "None of them" if something is missing.
3. If you like, tick **Tell the person who added this file**: whoever added it gets an e-mail saying an answer from their
   file was corrected, with a link to the collection (not the correction), so they can update the file too.
4. **Save the correction.**

Knowledge saves the correction as a note, learns it (about a minute; questions to that collection wait meanwhile) and
saves a restore point. The source picked is marked as corrected, so answers stop using that passage.

- New questions on the site and from every AI assistant use the correction, and cite it.
- Answers already given don't change.
- The correction can be undone by going back in [History](/docs/knowledge/history).
- If the file it corrects is read again later and the words it applies to now read differently, the correction asks to
  be checked under **Needs attention**.

Through the API: `POST /api/collections/{id}/corrections` with `{ "text", "question", "outdated": [{ "documentId",
"textHash" }] }` (the passage's ids from a search), or `"factId"` for a fact, optionally `"notifyAuthors": true`, and
an `Idempotency-Key`. It needs the collection's Editor role.

## Report a wrong answer

Someone who can only read a collection gets **Not right** too, to tell its owner what's wrong: they say what they
expected, then **Send to** the owner. The owner and the collection's admins get an e-mail, and the report waits for
them under **Needs attention**. Until someone checks it, the answer shows that it was reported, to everyone who gets
it. The report is settled when an owner, admin or editor fixes the answer (once Insulin has learned the fix; if learning
it fails, the report stays open), or marks it as right.

Through the API: `POST /api/collections/{id}/reports` with `{ "question", "answer", "note" }`; settling is
`PATCH /api/collections/{id}/reports/{reportId}` with `{ "status": "fixed" }` or `"dismissed"`.

## What it knows

A collection's **What it knows** tab lists the facts Insulin found, each as one sentence taken from a file that a person
can check, with the file it came from. Search them by word: the search looks through the facts shown, and when there
are more, **Show more** at the end of the list adds them.

- **Looks right** (owners, admins and editors) marks a fact as checked, with the person's name.
- **Fix** writes the right sentence. It is saved as a correction named after the file the fact came from ("Correction
  to …"), holding only the new sentence, never the old one, and answers that used the fact use the fix.
- **Report a problem** (everyone else) tells the owner something is wrong, like a reported answer.

Through the API: `POST /api/collections/{id}/facts/{factId}/check` marks a fact as checked, and
`GET /api/collections/{id}/facts` gives each fact's `checked` (who and when, or null).

## Needs attention

**Needs attention**, for Editors and Admins in Knowledge, lists what only a person can settle in the collections where
they are an owner, admin or editor:

- **Files Insulin couldn't read**, with the reason and what to upload instead;
- **values hidden before learning**: which file, and how many values were hidden in all (see
  [Hiding personal data](/docs/knowledge/hiding-personal-data));
- **reported answers waiting**: fix the answer, or say it is right;
- **corrections to check**: a file was read again, and the words a correction applies to now read differently. Check
  that the correction still says the right thing (shown as Insulin learned it, with hidden values hidden): **Still
  right** settles it; **Write it again** opens the correction, ready to change, and settles it once Insulin has learned
  the new one.

Insulin keeps answering while these wait. A file Insulin couldn't read stays listed for 30 days, or until a file with
the same name is learned in that collection.

Every collection you can change is covered. Values hidden before learning are read for the 50 collections changed most
recently; when you can change more, the answer says so, and a collection's own **Overview** lists everything for it.
Through the API: `GET /api/attention`, optionally `?collection=<id>` (always read in full); a collection whose hidden
values weren't read is marked `"partial": true`, and `notice` says how many.
