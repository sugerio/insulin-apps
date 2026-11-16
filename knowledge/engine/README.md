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
  included. Only redacted text is stored, in the container, R2, backups and exports.
- **Corrections follow their passage** when a file is re-read. If the passage's words changed (or it can't be found),
  the correction keeps applying and a `needs_check` event asks a person to check it.
- **Waking from the backup**: when a restore point's snapshot expired (30 days), the engine image changed, or it
  failed its check twice (`damaged`), the collection comes back from its latest backup if that holds the same files
  (matched by their checksum list, not the version) in the running image's database format
  (`KNOWLEDGE_DATA_FORMAT`). Otherwise every document is learned again from its saved text; an import waiting
  meanwhile gives way to that and isn't charged a try, and a removal for good learns the other documents itself.
  A repair that answers from an earlier restore point then learns everything again, bringing back the files added
  after it.
- **Waking is never stuck**: each wake step that takes longer than 10 minutes is stopped and started again; a
  snapshot is given up as gone only after three failed starts in a row. Running time is charged from the moment a
  container starts (waking, going back, coming back from a backup, learning).

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

The models (GLiNER for the graph, fastembed `BAAI/bge-small-en-v1.5` for passages) are downloaded at build time by
`warmup.py`; from then on the image never touches the network. A changed image makes the engine's snapshots
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
