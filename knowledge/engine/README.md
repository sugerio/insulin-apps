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
   starts from the last restore point. An import is tried three times, then the failing file is named.
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
  at a time, so a collection's container is never driven twice at once.
- **Changes within 5 minutes share one restore point** (the earlier one folds into the new one; undo takes both back).
- **Remove for good** deletes the document's text and its facts (in every stored facts file) at once, blocks every
  restore point and daily backup that holds it, goes ahead of every other import to delete it from the databases,
  and writes a new latest backup without it. An export or a re-read running at that moment is redone without it.
- **Hiding fails closed**: any detector error stops the import before anything is stored. Once every file and note
  of an import is read and hidden, their redacted texts are saved and the originals, and notes as written, are
  deleted; a later try learns from the saved texts. Queued imports and saved texts are hidden with the rules in
  force when learning starts, and stricter rules re-read every document, those of imports running at the time
  included. When stricter rules change a text, the facts files, ready exports and backups of earlier versions that
  hold its old words are deleted (tried again from the alarm until they are), and a new latest backup is written;
  earlier restore points are blocked. Only redacted text is stored, in the container, R2, backups and exports. The
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
  the same snapshot (matched by snapshot id, not the version) in the running image's database format
  (`KNOWLEDGE_DATA_FORMAT`); the files put back must then match the backup's manifest. Otherwise every document is learned again from its saved text; an import waiting
  meanwhile gives way to that and isn't charged a try, and a removal for good learns the other documents itself.
  A repair that answers from an earlier restore point then learns everything again, bringing back the files added
  after it.
- **Waking is never stuck**: each wake step that takes longer than 10 minutes is stopped and started again; after
  three timeouts in a row the collection stops trying (and paying) until someone asks again, and says so with a
  `state` event. A snapshot is given up as gone only after three failed starts in a row. Running time is charged from
  the moment a container starts (waking, going back, coming back from a backup, learning).
- **Questions are never kept**: Cognee's search history is off (`COGNEE_LOG_SEARCH_HISTORY=false`, in the image and
  forced by `query.py`), so no question reaches the databases, snapshots or backups, and the query process logs at
  WARNING.
- **Backups belong to a snapshot**: a backup records the snapshot its container started from, and is used for that
  snapshot's restore points in the same database format; restoring checks the files against the backup's own list.
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
  guard unreachable for a moment) is tried again on the next step.
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
the planned time for a large import), 5 minutes for shared restore points, 30 days of snapshots, 7 days of outbox
and exports, the planning times from the PoC (43 s per
import plus 5.3 s per document; about a minute to wake) and the built-in model. The container instance is chosen
when the Durable Object starts it: `standard-4` for learning and, until Phase 0 shows a snapshot taken on
`standard-4` starts on `standard-1` (design Q10), for questions too. A deployment can set `ENGINE_QUESTIONS_INSTANCE`
and `ENGINE_LEARNING_INSTANCE` as vars to change them without a code change.

Daily backups are kept for the collection's `backupDays` (its settings; the organization's backup_days limit,
30 by default); the latest backup is kept for the collection's life.

Uploads are streamed to R2 in 8 MB parts and hashed on the way (`src/sha256.ts`), so a file is never held whole in
memory; a file whose SHA-256 doesn't match is not kept. Readers stop a little past the 2 MB text limit (a spreadsheet
also keeps at most 64 blank cells between two values), so a small file can't expand into gigabytes.

Each document keeps at most 2,000 passages (`PASSAGE_CAP` in `container/passages.py`, design section 11's cap on
passages per document). The 2 MB text limit makes about a thousand of Cognee's chunks, so the cap binds only for
unusual files; passages past it are not cited, and the file says so.

The "won't guess" threshold is `container/calibration.json` (0.70, a placeholder: the PoC graded retrieval but did
not record scores). Phase 0 sets it with the harness (`--calibrate`, plan ASK-02).

## Running the checks

From `knowledge/engine/`:

```sh
npm ci --ignore-scripts
npm run typecheck
npm test                  # the Worker logic, with a fake container (Node 22's TypeScript stripping)
npm run test:python       # extract.py, hide.py, ranking, passages, facts; the PDF tests need pypdf from
                          # test/python/requirements.lock (pip install --require-hashes -r …)
npm run test:container    # the real server.py and the import's fail paths in the base image (needs Docker)
npm run check             # typecheck and bundle (wrangler deploy --dry-run, without building the image)
```

`npm test` runs the whole engine in memory: the router, all four Durable Object classes on fake storage, fake R2 and
Workers AI, and fake containers that answer like `server.py` (jobs, quiesce, the query process, files) with
`ctx.container`'s start, destroy and snapshot calls. Test names carry the design's plan ids (IMP-03, HIS-01, …).
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
(backups hold vectors from that model). From then on the image never touches the network. A changed image makes the engine's snapshots
unusable; collections move from their backups on their next wake (HIS-03), and History marks the older restore
points as unavailable.

The release builds and pushes the image (DESIGN.md §10.1 "Images"). Wrangler's own build is not used for a release.

## The Engine-lane harness

`harness/` runs the design's GATE plans on Cloudflare: a throwaway engine (`insulin-apps-knowledge-engine-e2e-<run>`,
its own two buckets, `ENGINE_TEST_CONTROLS=1`) behind a tiny harness Worker (`harness/worker.ts`) that checks a
bearer token and passes `/v1/*` to the engine over a service binding, as the app does.

```sh
node harness/run.mjs prepare --run <id>    # writes harness/.run/<id>/ and prints the deploy steps
# deploy the engine and the harness as printed, set HARNESS_TOKEN, then:
HARNESS_URL=… HARNESS_TOKEN=… node harness/run.mjs test [--calibrate] [--wakes 20] [--fix-runs 10] [--soak 10]
node harness/run.mjs cleanup --run <id>    # prints the commands that delete the run's Workers and buckets
```

Plans: IMP-03, IMP-04, IMP-05, IMP-06, ASK-01, ASK-02, ASK-06, ASK-07, FIX-01, FIX-02, HIS-01, HIS-02, HIS-03
(simulated; a real image change needs a second deploy and `--only HIS-03`), HIS-04, HIS-05, HIS-07, HID-01 (with
HID-03), HID-02, HID-04, DEL-01, DEL-03, the PoC's soak (`--soak`), and with flags IMP-07 (`--size`) and IMP-10
(`--capacity`). The report goes to `harness/report/` (git-ignored): each plan's checks and evidence, what still
needs a person (near misses in ASK-02, wake times per instance type), and the running time the run caused for
LIM-09's comparison with Cloudflare's own figures. Test controls (`/v1/collections/:cid/__test/*`,
`/v1/__test/objects`) exist only when `ENGINE_TEST_CONTROLS=1`; production never sets it.

The runner has been rehearsed against the in-memory engine over HTTP; it has not run against Cloudflare yet.

## Build gotchas

- **Registry credential lifetime.** `wrangler deploy` pushes the image with a registry credential that lasts
  15 minutes. The dependency layer is about 2.5 GB; on a slow uplink it doesn't finish in time and every retry is
  refused. Push with a longer-lived credential first (the release does, §10.1), then deploy with the digest.
- **LanceDB needs AVX2.** Apple Silicon builds amd64 images under Rosetta, which has no AVX/AVX2; LanceDB crashes
  there. So the build's warm-up only loads the models, and nothing that opens a database can run in a local amd64
  build. `test/container-smoke.sh` covers the control server and the import's fail paths locally; the databases run
  only on Cloudflare (the harness).
- **`wrangler deploy --dry-run` builds the image** when the config names a Dockerfile; `npm run check` passes
  `--containers-rollout none` so it only bundles the Worker. It also passes `--config wrangler.jsonc`: otherwise
  Wrangler may pick up the app's generated `../.wrangler/deploy/config.json` and refuse.
- **Durable Object-managed containers** (needed for `snapshotContainer`) take only `images.<name>.dockerfile` in the
  config, not `image` or `instance_type`; the instance is passed to `ctx.container.start()`.
- **Snapshots are tied to the image** and expire 30 days after their creation or last restore.
