# Insulin Knowledge: the engine

The engine is the part of Insulin Knowledge that learns a collection's files and answers questions from them. It is
an app-owned engine as `.github/hosting/DESIGN.md` §8.7 describes: a second Worker,
`insulin-apps-knowledge-engine`, with no public address. Only the Knowledge app reaches it, over its `SUGER_ENGINE`
service binding, and every call names the organization it acts for in `x-knowledge-org`. The app checks who may do
what before it calls; the engine keeps one organization's collections apart from another's (an id from another
organization answers 404, exactly like an unknown one).

The API is `src/contract.ts` (fixed; the in-memory engine in `src/stub/`, which the app's local stack and tests use,
implements the same).

## What is in it

| Piece | Where | What it does |
| --- | --- | --- |
| Router | `src/router.ts`, `src/routes.ts` | Every route of the contract; the organization header; sends each call to the collection's Durable Object, the registry, the outbox or the answer model |
| `CollectionEngine` Durable Object | `src/collection.ts`, `src/imports.ts`, `src/history.ts`, `src/backup.ts`, `src/exporter.ts` | One per collection (named `<organization>:<collection>`): its container, imports and their queue, restore points, backups, keep-ready window, exports, deletion and running-time ledger |
| `Capacity` Durable Object | `src/capacity.ts` | Imports at once: 20 across the service, 2 per organization, notes and corrections first |
| `Outbox` Durable Object | `src/outbox.ts` | Events the app pulls with `GET /v1/outbox?since=` (committed versions, imports, usage, states, backups, deletions), kept 7 days |
| `Registry` Durable Object | `src/registry.ts` | Which collections each organization has (ids and states only), for purging an organization, answering `deleted` and counting collections |
| Answer model | `src/answer.ts` | `POST /v1/answer`: Gemma 4 (`@cf/google/gemma-4-26b-a4b-it`) on Workers AI, from the given passages only, with `[n]` citations |
| Container | `container/` | Cognee 1.6.8, offline, with its models baked in. `server.py` (control server), `ops.py` (one operation per process), `query.py` (the query process), `extract.py`, `hide.py`, `passages.py`, `rank.py`, `facts.py`, `calibration.json` |

R2: `FILES` holds `inbox/<org>/<collection>/` (originals while they wait to be read; deleted as soon as every file
of the import is read and hidden; files no import names are deleted after a day, but the originals of an import
that waits, for the documents-learned limit to reset on the 1st, are kept until it starts or until the date given
with `POST /v1/collections/:cid/inbox/keep` passes, at most 45 days; deleting the collection deletes them all),
`text/<org>/<collection>/` (the redacted text and page map of every document, and
each version's facts) and
`exports/`; `BACKUPS` holds `backups/<org>/<collection>/` (content-addressed files, daily indexes and the latest).
The deploy names both buckets; the repository never does.

## The consistency rules

The PoC (design section 13: 13 of 13 recoveries, nothing lost or duplicated)
proved these; the engine keeps them all.

1. **One op, one process.** The container's main process never imports Cognee. Each import, removal, re-read and
   count runs as `python ops.py <op>` in its own process group, finished only when the whole group has exited. The
   query process is the one Cognee process that stays loaded; anything that opens the databases refuses to start
   while it runs, and it is stopped before every snapshot.
2. **Quiesce before snapshot.** No job, no query process, no stray process, no open file under `/data` and nothing
   staged. Then counts and the full checksum manifest of `/data`, quiescence again, the snapshot.
3. **Commit = checkpoint.** The snapshot handle, its manifest, the counts and everything that changes answers
   (documents, stop-using flags, corrections and outdated marks, facts) are written in one storage transaction.
   That commit is the restore point. Every restore point keeps its own full manifest (through its snapshot).
4. **Never reuse a dirty container.** A container that held an import that didn't commit is destroyed; the next try
   starts from the last restore point. An import is tried three times, then the failing file is named. Its first try
   learns the documents together, in groups; a later try learns them one at a time, so a file that stops the
   learning itself (the process crashes on it) is the one named, as one that fails to be read always is.
5. **Verify before opening.** After a start from a snapshot, `/data` is checked against that snapshot's own
   manifest before anything opens a database (the models load meanwhile). A mismatch is tried once more; then that
   snapshot is marked damaged (every restore point on it is not restorable, reason `damaged`), and the collection
   answers from its latest backup (if it holds that version), the previous restore point, or else learns everything
   again from its stored text.
6. **Idempotent imports.** An import id answers its existing import; a file whose content (SHA-256) is already in
   the collection is "already here"; the container's ledger refuses an import it already holds.

And from the design:

- **Questions never wait for a wake.** A search on an asleep collection answers `waking` at once and wakes it in the
  Durable Object's alarm; during an import it answers `learning`. All container work happens in the alarm, one step
  at a time, so a collection's container is never driven twice at once. The alarm never waits on the container's
  monitor (handed to `waitUntil`, it held every alarm open a minute): the alarm comes back at least once a minute
  while a container runs and notices one that stopped.
- **A dropped call is sent again.** On Cloudflare a call from the Durable Object to its container's port can drop
  (`Network connection lost.`) while the container still runs, about a second after a container or a job process
  starts or ends (38% of the tries in the first Engine-lane run). Every call is sent again then, up to five more times
  over about 30 seconds (a question: twice, over 3 seconds), with a body made again from R2 for a file; a file copied
  to a backup is read again from the start when its stream breaks. Only a container that stopped, an answer from the
  server, or a run of drops past that ends a try, a wake step or a backup. It relies on every call being safe to send
  twice (`container.ts`): the Durable Object names each job (`POST /jobs` with `id`), and the server answers an id it
  already has with that job and never starts a second one; writing an inbox file again replaces it; opening the
  databases again finds them opening. Each drop is logged (`container-call-dropped`). An answer cut short on the way
  counts as a drop too: a stream can end early without an error (the first run's two backup refusals were the first
  10,037 bytes of a 671,744-byte database file), so an answer shorter than the length the server gave, an answer or a
  learned text that isn't whole JSON, is asked for again, never read or stored as it came.
- **A start Cloudflare has no container for waits.** A start can be refused when the account's containers at once
  are used up, or too many are asked for in the same second (Cloudflare's words: "there is no container instance that
  can be provided", "you are requesting too many containers per second"; below, "Containers at once"). That is no
  failure of the collection: nothing is charged (the time spent asking is dropped, however long the refusal took; a
  container it was to replace is charged up to the start), no import's try is counted, no snapshot is given up (a
  wake's failed starts otherwise count towards it) and no go back or repair is dropped. No container is asked for
  again for 30 seconds (`noContainerRetryMs`); meanwhile an import goes back to the head of the queue and gives its
  capacity slot back, and the app hears it is queued, waiting for the service ("Insulin Knowledge is busy"), and
  once it starts its job is polled every 3 seconds like any other's (a try's wait ends when it starts); a question
  answers `waking`; a go back or repair waits, and a backup while asleep is taken later. Each refusal is logged
  (`no-container`).
- **Changes within 5 minutes share one restore point** (the earlier one folds into the new one; undo takes both back).
- **Remove for good** deletes the document's text and its facts (in every stored facts file) at once, blocks every
  restore point and daily backup that holds it, goes ahead of every other import to delete it from the databases,
  and writes a new latest backup without it. An export or a re-read running at that moment is redone without it.
  Deleting it from the databases reaches every byte of them: before its restore point is saved, the removal rewrites
  every store under `/data` without what it deleted, checks that none keeps a deleted row, and reads what the stores
  hold for every piece of the removed text ("What a removal leaves" below); a piece left fails the try, so nothing
  is committed or backed up.
- **Hiding fails closed**: any detector error stops the import before anything is stored. Once every file and note
  of an import is read and hidden, their redacted texts are saved and the originals, and notes as written, are
  deleted; a later try learns from the saved texts. Queued imports and saved texts are hidden with the rules in
  force when learning starts, and stricter rules re-read every document, those of imports running at the time
  included. When stricter rules change a text, the facts files, ready exports and backups of earlier versions that
  hold its old words are deleted (tried again from the alarm until they are), and a new latest backup is written;
  earlier restore points are blocked. Only redacted text is stored, in the container, R2, backups and exports: a
  re-read that hid more rewrites every store under `/data` the same way as a removal for good, and reads what the
  stores hold for every value it newly hid, matched as the rule matches it (a document's name, which hiding doesn't
  change, aside). The
  detectors run in time linear in the text (a 2 MB text built to make them backtrack takes under a second); the
  app's "Try it" box (`hiding.ts`) uses the same patterns, checked against the shared fixtures.
- **The newest correction of a passage wins**: a correction written again for a passage takes it over from the
  earlier one, and an earlier correction left correcting nothing is kept but no longer used. The same holds when
  stricter hiding makes two corrected passages read the same: the newer correction keeps the passage. Each
  correction is numbered in the order corrections were made, exports carry the number and imports restore it, so
  the order survives any number of export and import round trips.
- **An import id is claimed once**: every submission (imports, corrections, import-export) ends in one storage
  transaction that answers the import another submission with the id already made, or `cancelled` when the id was
  cancelled, and only otherwise writes the record and its place in the queue; the same id answers the existing import
  before anything else a submission finds wrong. `DELETE .../imports/:importId` cancels a queued import that hasn't
  started learning (409 `busy_learning` once it has, or once it finished); an id the engine has no import with is
  remembered as cancelled for 30 days, so a send still in flight learns nothing and its staged files are deleted.
  The alarm takes a queued import only in one transaction with `meta.active`, after the capacity guard answers: if a
  cancel or the organization's hold won meanwhile, the slot (or the place in the guard's waiting list) is given back
  and nothing starts (a removal for good still starts while held). A cancel always tells the guard to give back what
  it holds for the import; when the guard can't be told (a cancel, a stop for the hold or a removal, the import's end),
  or the answer to the alarm's `/acquire` was lost, the alarm tells it again until the guard confirms, so a slot is
  never kept for an import that doesn't use it until its lease lapses. Only an import running with the slot it was
  granted, or the one the alarm asks the guard for next (the head of the queue, or while held the first removal for
  good in it, with nothing running or going back ahead of it), takes over what the guard holds instead; any other
  queued import (held, behind a removal or another import, or waiting to be tried again later) can't, so the guard is
  told again on every alarm.
- **The app follows each import**: besides its end, an `import` event says when the alarm starts it (from then on it
  can't be cancelled), when it goes back to the queue (a removal for good or the hold came first; it can be cancelled
  again), when a try is interrupted (nothing kept; it stays the import being learned and is tried again in place,
  15 seconds later for each try made) and when the next try starts. The in-memory engine says the same. Events reach
  the outbox in the order they happened: each is numbered from one counter the collection keeps in storage, so two in
  the same millisecond (a start, then a hold that sends it back to the queue) keep their order, across restarts too.
- **Corrections follow their passage** when a file is re-read. If the passage's words changed (or it can't be found),
  the correction keeps applying and a `needs_check` event asks a person to check it; its `previousTextHash` is the hash
  the mark had before this re-read moved it (null when it couldn't follow) and `previousNoteId` the correction it
  belonged to (the retired one when merged passages went to a newer correction), so each check replaces the one before
  and a dropped mark leaves none behind. A mark that loses its passage that way without moving has its event too,
  under the newer correction, with its own unchanged hash as `previousTextHash` and its retired correction as
  `previousNoteId`.
- **Waking from the backup**: when a restore point's snapshot expired (30 days), the engine image changed, or it
  failed its check twice (`damaged`), the collection comes back from its latest backup if that backup was taken from
  the same snapshot (matched by snapshot id, not the version), or holds exactly its files (the snapshot taken right
  after coming back from that backup), in the running image's database format (`KNOWLEDGE_DATA_FORMAT`); the files
  put back must then match the backup's manifest. Otherwise every document is learned again from its saved text; an
  import waiting meanwhile gives way to that and isn't charged a try, and a removal for good learns the other
  documents itself.
  A repair that answers from an earlier restore point then learns everything again, bringing back the files added
  after it. One container can't answer and learn at once, so that re-learning waits while people ask: it starts once
  nobody has asked for the collection's `awakeMinutes`, after an hour at most, or at once when anything else is
  queued behind it. While it waits it holds no capacity: a place it took in the capacity guard's list (or a slot the
  guard granted it there) goes back when people ask again, so another import can have it. Going back waits for it
  (409 `busy_learning`): it would add files on top of the version gone back to.
- **Waking is never stuck**: each wake step that takes longer than 10 minutes is stopped and started again; after
  three timeouts in a row the collection stops trying (and paying) until someone asks again, and says so with a
  `state` event. A snapshot is given up as gone only after three failed starts in a row. Running time is charged from
  the moment a container starts (waking, going back, coming back from a backup, learning).
- **Questions are never kept**: Cognee's search history is off (`COGNEE_LOG_SEARCH_HISTORY=false`, in the image and
  forced by `query.py`), so no question reaches the databases, snapshots or backups, and the query process logs at
  WARNING.
- **Backups belong to a snapshot**: a backup records the snapshot its container started from, and is used for that
  snapshot's restore points (and a snapshot whose files are exactly the backup's) in the same database format;
  restoring checks the files against the backup's own list.
- **A backup copies the files its manifest names**: R2 checks each file's bytes against the manifest's SHA-256. The
  first run's two refusals were streams cut short, not files that changed: R2 received 10,037 bytes both times, of the
  671,744-byte `system/databases/cognee_db` in HID-04, whose next backup holds the very bytes the refused one's
  manifest named, whole. Nothing can write under `/data` between the manifest and the copy (the quiesce check finds no
  job, no query process and no open file there, and only the alarm starts one), so a cut stream is read again from the
  start; a file whose length isn't the manifest's changed after all, and fails the backup at once with its name.
- **Removals for good finish**: a removal whose restore point can't be started learns the other documents again
  without every pending removal's documents. One that keeps failing is reported (an `import` event, failed) and tried
  again after 1 minute, 10 minutes, an hour, then every 6 hours. Its clean-up of older facts files and backups is
  kept with the commit and retried from the alarm until it is done.
- **The organization hold** (`POST /v1/orgs/:org/hold`, the app's hard stop on awake hours): while held, the engine
  starts no container for the organization's collections except to remove a file for good or delete; running
  containers stop, an import in progress stops, keeps nothing and waits, questions answer `held`, and the collection's
  state is `held`. Imports and corrections are queued; stop using / use again commits at once (it needs no
  container); go back, undo and new exports answer 429 `capacity` with `retryAfterSeconds` until the hold ends; a go
  back asked for before the hold is dropped (a `state` event says `held`). Nothing but a removal for good or a stop
  using / use again commits while held: an import whose hold arrived as it saved keeps nothing and waits, and one
  whose hold arrived while the capacity guard answered, or before its container or its job started, starts nothing
  and waits (the hold is checked again after each of those waits). Every container start (learning, questions, going
  back, a repair, coming back from a backup, a backup while asleep) reads the hold again after the container it
  replaces has stopped, right before it starts, so a hold that landed meanwhile starts nothing and counts as no failed
  try (a repair tries the same restore point again once the hold ends). An import waiting in the capacity guard's
  list gives up its place when the hold lands (told again until the guard confirms), so the guard never grants the
  held organization's imports a slot nobody uses; it asks again when the hold ends. A removal
  for good starts wherever it waits in the queue, ahead of a re-learning and of a pending wake from a backup or repair (it brings the files back
  itself). The hold lifts at its `until` time or with `until: null`. A collection made while held is held. The
  registry keeps the hold and tells every collection; one it can't reach is told again every minute until it has.
  Every hold change (a lift too) is numbered, and a collection refuses a delivery older than the change it holds, so
  two calls whose deliveries overlap leave every collection with the newer one. Each request carries the app's
  `version` of its hold wish: the registry and every collection keep the highest, and a request with a lower one
  (delayed, or sent again after a lost answer) changes nothing and is answered with the current state.
- **Imports hold their capacity slot or stop**: an import whose slot the capacity guard says has lapsed stops, keeps
  nothing and waits for a new slot, so no more than the allowed imports ever run. A renewal call that fails (the
  guard unreachable for a moment) is tried again on the next step. The slot lapses after 30 minutes without a renewal,
  and an import renews it at every step (every 3 seconds while its job runs), so one that learns for hours keeps it.
- **Settings carry the app's revision**: a PUT with a lower revision than the engine holds answers 409
  `stale_settings` and changes nothing; the same revision again changes nothing.
- **An export starts a new collection** (`POST .../import-export`, DEL-03): an empty collection learns a Knowledge
  export staged in its inbox like an import. Each document's redacted text and page map come back under the same
  document id, hidden again with the new collection's rules; stopped sources stay stopped; notes and corrections come
  back with their outdated marks, which follow their passage if hiding again changed it (the correction then asks to
  be checked, as after a re-read). Facts are found again as it learns, and History starts with one restore point. Its
  ImportStatus lists the export's files in `files` (by document id) and counts its notes, corrections included, in
  `notes`; the zip itself isn't listed. The request names the staged zip by its SHA-256, which is checked again
  whenever the zip is read: a file staged under that id since isn't learned. A collection that isn't empty, a file
  that isn't an export, or another file than the one named answers 409 `bad_request`; an export over 32 MB, 413.
- **Every export can be imported again**: the exporter and the import share one set of bounds (`EXPORT_LIMITS` in
  `src/exportfile.ts`): a stored text is at most 3 MiB (the container cuts one that hiding lengthened past it, never
  inside a `[hidden]`) and a page map at most 20,000 pages (`extract.py`); each `documents/<id>.json` holds its page
  map and hidden values compactly (under 4 MiB for the densest text) and, for a note, its id and the passages it
  corrects, so the import reads neither `notes.json` nor `corrections.json` (they are for people). The import
  inflates no entry past those bounds, and counts a document's hidden values and checks their order (each a
  `[hidden]` after the last) before building anything from them, so a forged zip costs little memory.

## Service settings

`src/settings.ts`: imports at once (20, 2 per organization), three tries, a job time limit (an hour, or three times
the planned time for a large import), 5 minutes for shared restore points, 30 days of snapshots, 7 days of outbox and
exports, the planning times and the built-in model. The planning times come from the first Engine-lane run on
`standard-4`, where documents were learned one at a time: a try took about 30 s to start its container, then 105 s
plus 5.3 s per document plus 860 s per MiB of text from its job's start to its commit (one short note: 110-116 s; 20
short documents: 211 s; 41 learned again: 317 s; one 2 MiB text of 848 passages: 1,835 s); about a minute to wake.
Documents are now learned in groups (below), in about three quarters of the time per document Cognee takes one at a
time, so a document is planned at 4.1 s; a later try of an import, which learns them one at a time, at 5.3 s. A file's
text is planned from its size until it is read (its bytes for plain text and Markdown, a quarter of them for PDF,
Office and HTML, at most the 2 MB the readers keep), then from the text read; a re-read or re-learning counts the
saved texts. The collection's size is not in the plan (below). The plan sets the time left (`etaSeconds`, counted down
from the try's job start), when a question during learning is told to come back, and the job time limit. Each job's
own time is logged with its plan (`job-done`: the job, Cognee's share of it and its groups), for the next run to check
these numbers against. The container instance is chosen when the Durable Object starts it: `standard-4` for learning
and, until Phase 0 shows a snapshot taken on `standard-4` starts on `standard-1` (design Q10), for questions too. A
deployment can set `ENGINE_QUESTIONS_INSTANCE` and `ENGINE_LEARNING_INSTANCE` as vars to change them without a code
change.

**Learning in groups.** `container/ops.py` learns an import's documents with one `cognify` per group of at most 20
documents and 4 MiB of text (`LEARN_GROUP_DOCUMENTS`, `LEARN_GROUP_BYTES`; a longer text is a group of its own), each
document still its own data item with its own passages, and the passage cap and all-or-nothing as before. Measured
with Cognee itself (1.6.8 with the lock's versions, natively on arm64 with 4 CPUs, IMP-07's documents):

- `cognify`'s cost per call grows little with the collection. One document at a time, the median call took 3.25, 3.22,
  3.39, 3.52 and 3.61 s over five imports of 50 into one collection (from 0 to 250 documents, 11% more), and the
  imports took 194, 189, 206, 203 and 214 s. Learned in groups, an import of 50 took 149-157 s whether the collection
  held 0 or 250 documents. So the collection's size isn't in the plan.
- Learning in groups is faster: imports of 50 short documents took 149-157 s in groups (seven imports) against
  174-222 s one at a time (ten), so about three quarters of the time per document (an import of one document takes
  about 30 s either way). Groups of 20 were as fast as one of 50 (149 and 152 s against 149 and 151 s, in the same
  run): Cognee works on 20 documents of a call side by side, so a group is 20.
- In the first run on Cloudflare, IMP-07's imports of 50 took 413 s into an empty collection and 795 to 823 s into
  one of 50 to 150 documents. Cognee doesn't explain that: per-document times there ranged from 5 to 22 s between
  containers of the same type (20 documents took 211 s in one and 409 s in another), and one-note corrections took the
  same 110-116 s in a 35-document collection as in an empty one. The `job-done` log of the next run says which it is.
- A later try learns one document at a time, so a file that crashes the learning is named on the try after, and the
  import fails naming it after three (IMP-05); learning in a group, the progress can't say which file stopped it.
  Files turn "learned" a group at a time, so the app's progress moves in steps of up to 20 documents.

### Containers at once

The engine's containers are started by its Durable Object (`scheduling_policy: "durable_object"`), and such a
container application has no `max_instances`: Wrangler refuses the key there ("Unsupported fields for Durable
Object-managed Containers", Wrangler 4.149), and Cloudflare's documentation says the policy doesn't support it. Its
running containers count against the account's limits instead, by default 15,000 vCPU, 60 TiB of memory and 300 TB
of disk at once: 3,750 `standard-4` containers (4 vCPU, 12 GiB and 20 GB each). Wrangler's default of 20 instances
applies only to an application with the default policy (Wrangler skips Durable Object-managed ones when it writes
the application), so the first run's reading that the service could run only 20 containers doesn't hold: in IMP-10
the 21st import waited, as it should, for the capacity guard's own limit of 20 imports while 20 containers ran.

So, at once: at most 20 imports (the capacity guard, `importsAtOnce`; 2 per organization), each one container; and
one container per awake collection, which the engine doesn't count or cap: questions are never kept from a container
by imports, which can take at most 20. The account's limit is shared with everything else the account runs. When
Cloudflare has no container to give, the start waits and asks again ("A start Cloudflare has no container for
waits", above). The repository's engine check (`.github/scripts/engine.mjs`) refuses `max_instances` and
`instance_type` on a container its Durable Object starts, as Wrangler would at deploy, and the deploy writes
`scheduling_policy` and the pinned image into the deployed config (`deployedEngineConfig`, tested on this engine's
own `wrangler.jsonc`).

Daily backups are kept for the collection's `backupDays` (its settings; the organization's backup_days limit,
30 by default); the latest backup is kept for the collection's life.

Uploads are streamed to R2 in 8 MB parts and hashed on the way (`src/sha256.ts`), so a file is never held whole in
memory; a file whose SHA-256 doesn't match is not kept. Readers stop a little past the 2 MB text limit (a spreadsheet
also keeps at most 64 blank cells between two values), so a small file can't expand into gigabytes.

Each document keeps at most 2,000 passages (`PASSAGE_CAP` in `container/passages.py`, design section 11's cap on
passages per document). The 2 MB text limit makes about a thousand of Cognee's chunks, so the cap binds only for
unusual files; passages past it are not cited, and the file says so.

Each document is its own data item in Cognee, under an id made from its document id (`data_id_of` in
`container/ops.py`), and its chunks are found by that id. Cognee otherwise finds data by its content, so a document
whose text equals another's (the same deck saved as PDF and as PowerPoint) joined the other's data item and got no
passages while it counted as learned (IMP-06). Cognee keeps one copy of a text, under its hash, for every data item
that has it; removing one of two such documents keeps the copy. A data item is never found by its name: in a database
from before data ids, one item carried one document's name for two, and removing that document took both. So the
layout is part of the image's database format (`KNOWLEDGE_DATA_FORMAT` ends in `knowledge-2`, `DATA_LAYOUT` in
`ops.py`; a test keeps them equal): a snapshot from before it belongs to another image, and a backup in another format
is never put back, so such a collection learns everything again from its saved text, as after an image change.

The "won't guess" threshold is `container/calibration.json`: 0.68, set from the first Engine-lane run on
Cloudflare (2026-11-17, `--calibrate`, plans ASK-01 and ASK-02). The top scores there were 0.637-0.895 for the
answerable questions and 0.466-0.701 for those nothing covers; the ranges overlap, so no threshold passes both plans
in full. At 0.68 ASK-02 declines 19 of its 20 uncovered questions (its bar) and ASK-01 answers 37 of its 40. Run
`--calibrate` again whenever the embedding model or the passages change. (`container/rank.py` falls back to the same
value when the file can't be read.)

## Running the checks

From `knowledge/engine/`:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test                  # the Worker logic, with a fake container (Node 22's TypeScript stripping)
npm run test:python       # extract.py, hide.py, ranking, passages, facts, the control server over sockets, data
                          # items, learning in groups and the clean-up's search; the PDF tests need pypdf from
                          # test/python/requirements.lock (pip install --require-hashes -r …)
npm run test:container    # the real server.py and the import's fail paths in the base image, and 1,500 calls
                          # back to back from workerd (needs Docker and node_modules)
npm run check             # typecheck and bundle (wrangler deploy --dry-run, without building the image)
```

`npm test` runs the whole engine in memory: the router, all four Durable Object classes on fake storage, fake R2 and
Workers AI, and fake containers that answer like `server.py` (jobs, quiesce, the query process, files) with
`ctx.container`'s start, destroy and snapshot calls, drop calls or cut their answers short on cue as Cloudflare did
(`FakeCloud.drops`), and have no container to give a start (`FakeCloud.noContainer`). Test names carry the design's
plan ids (IMP-03, HIS-01, …).
The Python tests read the shared fixtures in `test/fixtures/`; `test/python/make_fixtures.py` builds the PDF, Word,
PowerPoint, Excel and HTML versions of the corpus at test time, so no binary file is in the repository.

### Fixtures

- `test/fixtures/corpus/`: the PoC's 30 synthetic Markdown documents, with names that resembled real products or
  companies replaced by made-up ones.
- `test/fixtures/questions/`: 30 answerable questions (one per document), 10 paraphrases, 20 that nothing covers,
  20 near misses, and the PoC's 30 probes.
- `test/fixtures/hiding-cases.json`: inputs, the spans hidden in them, the redacted text and where each `[hidden]`
  is (UTF-16 positions, as JavaScript counts). Both `container/hide.py` and the app's "Try it" preview are tested
  against it (HID-05). Key-shaped values are made up and carry one `\u` escape, so secret scanners pass the file.

## The container image

`container/Dockerfile` is built from `python:3.12-slim-bookworm`, pinned by digest, and installs
`container/requirements.lock`: the PoC's resolved dependency set, every package pinned by version and SHA-256
(`pip install --require-hashes`). The only new direct dependency is `pypdf` (already in Cognee's set). Office files
and HTML are read with the standard library. To change a dependency, edit `requirements.in` and regenerate the lock
with exactly this (from `container/`):

```sh
uv pip compile requirements.in --python-version 3.12 --python-platform x86_64-manylinux_2_28 \
  --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cpu \
  --index-strategy unsafe-best-match --exclude-newer 2026-11-13 --generate-hashes -o requirements.lock
```

The models (GLiNER `fastino/gliner2.5-base-v1` for the graph; fastembed's quantized `BAAI/bge-small-en-v1.5`,
`Qdrant/bge-small-en-v1.5-onnx-Q`, for passages) are pinned in `container/models.py`: each repo at one commit, every
file by SHA-256. The build fetches those commits, warms up with the hub offline so Cognee's loaders find only them,
and fails if the cache differs from the pins or if `KNOWLEDGE_DATA_FORMAT` doesn't name the embedding model's pin
(backups hold vectors from that model). The format also names, last, how the engine lays out documents in Cognee
(`knowledge-2`: each document its own data item). From then on the image never touches the network. A changed image makes the engine's snapshots
unusable; collections move from their backups on their next wake (HIS-03), and History marks the older restore
points as unavailable.

The release builds and pushes the image (DESIGN.md §10.1 "Images"). Wrangler's own build is not used for a release.

**What a removal leaves.** Cognee deletes a document's data by marking it deleted, and the files keep it: after a
removal for good (HIS-07) or a stricter re-read (HID-04) the first Engine-lane run found the words in `/data` and in
the backup taken from it. So `remove` and `reread` run the op itself in a child process (when it exits, nothing holds
a database open), then `container/purge.py` cleans each store, checks it, and reads what the stores hold:

- LanceDB (chunks, summaries, entity, entity type and relationship names, document names): a deleted row stays in its
  data file until the fragment is rewritten, which LanceDB's own optimize does once a tenth of its rows are deleted
  and Cognee's compaction once a fifth; old versions keep the files they used. Every table is compacted with deleted
  rows materialized at any share, then every older version and unreferenced file is removed. Each table must then
  have one version, no deleted rows and no data file its fragments don't use.
- The graph (Ladybug, one file): deleted nodes' strings stay in its pages. It is exported and imported into a new
  file, which replaces it only when it holds as many nodes and edges.
- SQLite (Cognee's relational database): it held none of the text in any run (names, ids, paths, runs); it is
  vacuumed anyway, its write-ahead log folded in, and must then have no free page and an empty log.
- Cognee's copies of the texts (`/data/documents`): deleted with the document's data, unless another document with
  the same text still uses the copy. Cognee's cache (`/data/cache`) is never made, and questions leave nothing.
- Cognee's logs (`/var/log/cognee`, outside `/data`, so in a snapshot but not a backup): they held none of the text;
  they are deleted anyway, since nothing reads them.

Then what the stores hold now is read, decoded, for every piece of the removed documents' text (runs of words of at
least 24 characters) or every newly hidden value, each matched as the hiding detector matches a word: ignoring case
exactly as Python's `re.IGNORECASE` does (`fold()` in `purge.py` uses the regular expression engine's own rule, so
`Éclair` finds `éclair`, an entity name kept in lower case, and `Pin` finds `pın`; a test checks every character with
a case against `re`) and whole. Only values made from the documents are read, never keys, schemas or bookkeeping (a
hidden word "text" is no JSON key's or column's): the stored texts (not their names), Cognee's copies of them, the
chunks and entity names, the summaries and relations in LanceDB and the graph, and the facts. Cognee also writes
values of its own, from fixed words: with no LLM, GLiNER takes entity labels and relation names only from Cognee's
label banks, never from a document, and Cognee links its records with four relations of its own (`ENTITY_LABELS` and
`RELATIONS` in `purge.py`, for the Cognee the image pins; a test ties them to the pin). An entity type's name or a
relation's name is skipped when it is one of those words; a summary, a relation's text or a fact's sentence is
skipped only when it is exactly what Cognee's templates make from the graph's live records (whose own values, the
entities' names, chunks and summaries, are read where they stand). Anything else is read in full, whatever words it
shares with a label: a summary that isn't Cognee's ("The project uses Part Of as its supplier.") counts, even though
the graph has `is_part_of`. So a hidden word that is also one of Cognee's labels or relation names (`person`,
`headquartered_in`) doesn't count where Cognee wrote it as its label for other documents, and counts wherever a
document wrote it: a chunk, an entity's name, a sentence a fact was taken from. On the 30-document corpus every
summary, relation text and fact Cognee wrote is recognised as its own. A file under `/data` none of these covers is
read whole. A probe a kept document's text also holds may stay. Anything left fails the try with the number of places
(logged by name, never the text). All the values and pieces are looked for at once, by Aho-Corasick over the folded
text's words and the runs between them (pure Python, so no new dependency in the image), so the cost is the text's
length plus the matches, whatever the probes share: 32 MiB of kept text takes 3 to 5 s, with 20,000 removed
addresses all at `example.com` or 1,000 removed lines "the the … and" of every length (looking for each probe, or
each length, wherever their word stood took ten minutes for the first at 2 MiB, and 106 minutes for the second). On the 30-document corpus (34 MB under `/data`)
cleaning and reading take about a second.

**The control server's connections.** `server.py` serves one request per connection and says so in every answer
(`connection: close`). Without that, the Durable Object's fetch, which keeps connections for the next call, sent a
call made right after another on the connection the server was closing, and lost it (`Network connection lost.`).
That matches every drop of the first Engine-lane run: they came where the Durable Object makes calls back to back (a
container or a job starting or ending, an inbox filling, a wake step), never between a running job's polls, seconds
apart; workerd against the old server loses 1-3% of such calls, the current one none. A request's body is read to
its end before the answer (a body sent chunked too), and a connection is read until the client closes its side, so
it never ends with a reset. Every call is safe to send twice: `POST /jobs` with an `id` the server already has
answers that job and starts nothing (409 if that id was used for another request); an inbox or `/files` write goes
to a file of its own, renamed into place only once whole, so a repeated or interrupted write leaves one complete
copy; deleting a batch, cleanup and the query process's start, stop and open (`query.py`) change nothing when
repeated.

## The Engine-lane harness

`harness/` runs the design's GATE plans on Cloudflare: a throwaway engine (`insulin-apps-knowledge-engine-e2e-<run>`,
its own two buckets, `ENGINE_TEST_CONTROLS=1`) behind a tiny harness Worker (`harness/worker.ts`) that checks a
bearer token and passes `/v1/*` to the engine over a service binding, as the app does.

```sh
node harness/run.mjs prepare --run <id>    # writes harness/.run/<id>/ and prints the deploy steps
# deploy the engine and the harness as printed, set HARNESS_TOKEN, then:
HARNESS_URL=… HARNESS_TOKEN=… node harness/run.mjs test [--calibrate] [--wakes 20] [--fix-runs 10] [--soak 10]
node harness/run.mjs cleanup --run <id>    # prints the commands that delete the run's Workers, containers
                                           # application, buckets and image tags
```

Plans: IMP-03, IMP-04, IMP-05, IMP-06, ASK-01, ASK-02, ASK-06, ASK-07, FIX-01, FIX-02, HIS-01, HIS-02, HIS-03
(simulated), HIS-04, HIS-05, HIS-07, HID-01 (with HID-03), HID-02, HID-04, DEL-01, DEL-03, the PoC's soak
(`--soak`), and with flags IMP-07 (`--size`), IMP-10 (`--capacity`) and HIS-03-real, the real image change, in two
runs around a second deploy: `--only HIS-03-real --image-change before` learns and backs up a collection of its own
and keeps its answers in `harness/report/his03-real.json`; deploy the engine again with a changed image (the same one
with a layer added will do), then `--only HIS-03-real --image-change after` asks again and checks it came back from its
backup. The report goes to `harness/report/` (git-ignored): each plan's checks and evidence, what still
needs a person (near misses in ASK-02, wake times per instance type), and the running time the run caused for
LIM-09's comparison with Cloudflare's own figures. Test controls (`/v1/collections/:cid/__test/*`,
`/v1/__test/objects`) exist only when `ENGINE_TEST_CONTROLS=1`; production never sets it.

The runner ran once on Cloudflare (2026-11-17, on `standard-4`), and is rehearsed against the in-memory engine over
HTTP (the Worker tests' fakes behind a local server, the clock 50 times faster, `HARNESS_SHARE_WINDOW_MS` short). What
that run found wrong in the plans themselves is fixed:

- FIX-02 learns a second document with the one it corrects: on Cloudflare a short document is one passage, so no word
  of its own file lies outside the corrected passage for the first, gentler re-read to hide.
- HIS-04 looks for the version named on the restore point the repair makes ("Answering from version …" or "Came back
  from its backup"), not only on the newest point: a repair that answers from an earlier point then learns
  everything again, and that point comes after it.
- HIS-03 (simulated): a point an earlier plan damaged or blocked keeps its reason (HIS-04's damaged point stays
  `damaged`); every other point, restorable or expired, must become `engine_changed`.
- HIS-03 for real is a plan of its own, HIS-03-real: the run scripted it by hand, since `--only HIS-03` after a second
  deploy starts a new organization, with nothing made before the change.
- IMP-07 compares each import with the engine's own plan (its `etaSeconds` as it starts), not a fixed formula.
- IMP-03 destroys the container while the files are being understood: they are learned in groups now, and turn
  "learned" together.
- A plan that needs a backup checks it was taken, and asks again: one lost at sleep left HIS-02 nothing to come back
  from.
- `cleanup` prints the containers application too (it outlives the engine Worker) and why the run's container
  snapshots stay: Cloudflare keeps them as tags in the image's repository, refuses to delete them, and lets them
  expire 30 days after they were made or last restored.

In memory, ASK-01, IMP-03, IMP-06, IMP-07, IMP-10 and HID-01 can't pass: the fakes don't rank, answer, hide or read
PDF and Office files as the container and Gemma do, their times aren't Cloudflare's, and their jobs finish between two
of the harness's polls (with the fake jobs slowed down, IMP-03 destroys the container while files are understood, and
its next try commits).

## Build gotchas

- **Registry credential lifetime.** `wrangler deploy` pushes the image with a registry credential that lasts
  15 minutes. The dependency layer is about 2.5 GB; on a slow uplink it doesn't finish in time and every retry is
  refused. Push with a longer-lived credential first (the release does, §10.1), then deploy with the digest.
- **LanceDB needs AVX2.** Apple Silicon builds amd64 images under Rosetta, which has no AVX/AVX2; LanceDB crashes
  there. So the build's warm-up only loads the models, and nothing that opens a database can run in a local amd64
  build. `test/container-smoke.sh` covers the control server and the import's fail paths locally; in CI the
  databases run only on Cloudflare (the harness). On an arm64 machine they do run natively: a `linux/arm64`
  `python:3.12-slim-bookworm` container with `cognee[gliner]` and `pypdf` installed under the lock's versions as
  constraints (`uv pip install -c`; its hashes are for x86-64 only) and the image's `/opt/models` copied out ran
  `ops.py` and `query.py` for the data-item and removal checks above.
- **`wrangler deploy --dry-run` builds the image** when the config names a Dockerfile; `npm run check` passes
  `--containers-rollout none` so it only bundles the Worker. It also passes `--config wrangler.jsonc`: otherwise
  Wrangler may pick up the app's generated `../.wrangler/deploy/config.json` and refuse.
- **Durable Object-managed containers** (needed for `snapshotContainer`) take only `images.<name>.dockerfile` in the
  config, not `image` or `instance_type`; the instance is passed to `ctx.container.start()`.
- **Snapshots are tied to the image** and expire 30 days after their creation or last restore.
