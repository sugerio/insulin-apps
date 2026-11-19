---
title: Collections and sources
description: What a Knowledge collection holds, which files, web pages and notes it can learn, how learning works, and what happens when it goes wrong.
order: 3
---

This page explains what a collection is, how files, web pages and notes are added and learned, and the difference
between stopping using a file and removing it for good. It is for owners, admins and editors of collections, and for
AI agents adding sources through the API.

## Collections

A collection is files, web pages and notes about one subject, such as "Partner Programs" or "Product FAQ". Each has a
name (1 to 200 characters), a one-sentence purpose (up to 500), an owner, its own sharing and its own history. Whoever
starts it owns it, and it is private to them until they share it.

A collection's **Overview** says what state it is in:

| State | What it means |
|---|---|
| Ready | Answers in a few seconds. |
| Asleep | Nobody asked for 10 minutes, so it sleeps to keep Knowledge free. The first question wakes it up, in about a minute. |
| Waking up | Starting from its last restore point, checking nothing changed while it slept, and opening what it knows. |
| Coming back from its backup | It wasn't used for over 30 days, so it comes back from its latest backup, in a few minutes. It is never lost by sitting unused. |
| Learning | Reading new files. Questions to it wait until it finishes. |
| Saving a restore point | So you can always come back to this version. |
| Going back | Answering from an earlier restore point soon; about a minute. |
| Repairing | It couldn't open its latest restore point, so it answers from an earlier version while Insulin repairs it. |
| Stopped until the 1st | The organization has used this month's awake hours (see [Limits](/docs/knowledge/limits)). Everything learned is kept; removing a file for good still works. |

Most of the time a collection is asleep or ready. It wakes for a question, learns when something is added, and saves a
restore point after every change:

```diagram
title: A collection's day: asleep, waking, ready, learning
description: A collection sleeps after 10 minutes without a question and wakes in about a minute when asked again, or in a few minutes from its backup after 30 days unused. While it learns, questions wait; after each change it saves a restore point and is ready again.
size: 780 x 380
box asleep 20 150 140 64 muted "Asleep" "nobody asked for" "10 minutes"
box waking 210 150 140 64 "Waking up" "for a question:" "about a minute"
box ready 400 150 150 64 accent "Ready" "answers in seconds"
box learning 400 290 150 64 "Learning" "new files or notes;" "questions wait"
box saving 610 290 150 64 "Saving" "a restore point" "of this version"
box backup 190 30 180 70 dashed "Back from its backup" "unused over 30 days:" "a few minutes"
box goingback 600 30 160 70 "Going back or undo" "to a restore point:" "about a minute"
arrow asleep.r -> waking.l
arrow waking.r -> ready.l
arrow ready.b:0.1 -> asleep.b mid=264 "10 minutes without a question"
arrow ready.b:0.6 -> learning.t:0.6
arrow learning.r -> saving.l
arrow saving.t -> ready.r:0.75 "ready again" label=0.35
arrow asleep.t -> backup.l
arrow backup.r -> ready.t:0.3
arrow ready.r:0.3 -> goingback.b:0.3
arrow goingback.l -> ready.t:0.8
```

## Add files, web pages and notes

On a collection's **Sources** tab, its owner, admins and editors can add three kinds of source:

- **Upload files**: PDF (with text), Word (`.docx`), PowerPoint (`.pptx`), Excel (`.xlsx`), Markdown (`.md`), plain
  text (`.txt`) and web pages saved as HTML, up to 100 at a time. Each file can be up to the organization's
  largest-file limit, 25 MB by default. At most 2 MB of text is learned from one file; if a file has more, Knowledge
  says so.
- **Add a web page**: the address of a public page (http or https). Knowledge reads it at once; add it again to read
  it again. Pages on private or local networks can't be added.
- **Write a note**: a few lines in your own words, up to 20,000 characters (add a longer text as a file). A note is
  learned like a file and cited as a note. Notes go ahead of files waiting to be learned.

Before Insulin reads anything, it hides e-mail addresses, phone numbers, card numbers, API keys and values labelled as
passwords or secrets. See [Hiding personal data](/docs/knowledge/hiding-personal-data).

A new collection can instead **Start from an export**: the `.zip` file a collection's **Export** made, from this
organization or another. It brings back the same sources, the files it stopped using, its notes and corrections, so it
answers the same; its history starts afresh with one restore point. Only an empty collection starts from an export,
and what it holds counts toward the organization's limits before anything starts.

What waits for the 1st (the organization has learned this month's documents) is listed on **Sources**, under
**Waiting for the 1st**, with who added it and when it starts; its editors can **Cancel** it, and it is never learned.
What Insulin has but hasn't started learning yet (sent on the 1st, or waiting its turn behind other imports) is
listed under **Waiting to be learned**, and its editors can **Cancel** it too. Once learning has started, it leaves
that list and can't be cancelled, also while Insulin tries it again after an interruption: Knowledge says so, and it
is learned. One that had to wait again (a removal for good went first, or the organization used this month's awake
hours) is back on the list, and can be cancelled again.

## Files that can't be learned

Before anything starts, Knowledge checks every file and names the ones it can't learn, with the reason and what to do
instead. Only the others are learned:

![A collection's Sources tab after choosing three files: 2 of 3 files can't be learned, a scanned PDF and a workbook with macros, each with what to do instead, the button Learn 1 file, then the files and notes the collection holds](/docs/assets/screenshots/knowledge-sources.png "Files that can't be learned are named before anything starts")

- **A type Insulin can't read**, such as an Excel workbook with macros (`.xlsm`), an older Word or PowerPoint file
  (`.doc`, `.ppt`) or an image. Save it in one of the types above and add it again.
- **An empty file**, or one **larger than the organization's largest file**. Split it, or save it smaller.
- **A scanned PDF**: a PDF whose pages draw only images, with no text, is named when it is uploaded, before learning,
  even when it lists a font. Insulin names a PDF only when it is sure there is no text: one whose pages it can't look
  into for certain while it uploads (an unusual compression, an encrypted file, a very large or unusual layout) is
  accepted, and if it has no text after all, its import fails and names it.
- **The organization's limits**: if the files would go past its documents or stored files, nothing starts and
  Knowledge says which limit. Past this month's documents learned, they are taken and wait for the 1st. See
  [Limits](/docs/knowledge/limits).

## Learning

Learning is how Insulin reads each file and works out the facts in it. Each file goes **Waiting → Reading →
Understanding → learned**, with the time left in real minutes. When it ends, Knowledge saves a restore point and says
how many files it learned and how many new facts it found.

![Learning your files, step 3 of New collection: three files being understood, about 2 minutes left, and a note that questions wait and Insulin e-mails you when it is done](/docs/assets/screenshots/knowledge-learning.png "Learning: each file's progress and the time left")

- **Questions wait.** While a collection learns, questions to it wait until it finishes; assistants are told to ask
  again in a minute.
- **You can leave.** Learning goes on without the page, and Knowledge e-mails whoever added the files when they are
  learned, or if they couldn't be. If Insulin Knowledge never received an import (a connection dropped), it says so
  after an hour, by e-mail too; an import that waited for the 1st is sent again instead.
- **Waiting your turn.** An organization learns two imports at a time, and the service has a limit for everyone
  together; a new import waits behind them and says when it should start. Notes and corrections go first.

## When learning goes wrong

An import is all or nothing: a collection never answers from half-learned files.

- **Interrupted.** If an import stops part-way, nothing from it is kept, so the collection is exactly as it was
  before, and Insulin tries again by itself, up to 3 times.
- **Failed.** After 3 tries Knowledge names the file that keeps failing. Nothing from that import was kept: add the
  other files again without it.
- **Already here.** Files with the same content as files the collection has already learned change nothing, and no
  restore point is saved.

Files Insulin couldn't read also show under **Needs attention**.

## Stop using, or remove for good

| | Stop using | Remove for good |
|---|---|---|
| What it does | Keeps the file, but answers no longer use it. **Use again** brings it back. | Deletes the file and its text from the collection and its latest backup. |
| Who can | The collection's owner, admins and editors | The collection's owner and admins |
| History | A restore point, like any change | Earlier restore points that held the file can't be brought back any more |
| Space and limits | Still counts as a document and as stored files | Frees the space it took |
| Undo | Use again, or go back in History | Can't be undone |

## Through the API

Adding files takes three calls, each needing the collection's Editor role (see
[AI assistants and the API](/docs/knowledge/ai-assistants-and-api)):

1. `POST /api/collections/{id}/preflight` with `{ "files": [{ "name", "bytes" }] }`: each file is accepted, with a
   `fileId`, or refused with a `reason`.
2. `PUT /api/collections/{id}/uploads/{fileId}` with the file's bytes as the body (it keeps the name preflight was
   given) and optionally its SHA-256 in `x-file-sha256`. A scanned PDF answers `accepted: false` with its reason.
3. `POST /api/collections/{id}/imports` with `{ "fileIds": [...] }` and an `Idempotency-Key`: the import's progress is
   at `GET /api/collections/{id}/imports/{importId}`. When the organization has learned this month's documents, the
   import answers `state: "waiting"` with `waiting: { until, message }`, and starts by itself then. A file Insulin
   couldn't keep until then (uploaded more than a day before) is named in `message` and listed as `failed`: add it
   again.

A note is `POST /api/collections/{id}/notes` with `{ "title", "text" }` (text up to 20,000 characters), and a web page
`POST /api/collections/{id}/web-pages` with `{ "url" }`, each with an `Idempotency-Key`.
