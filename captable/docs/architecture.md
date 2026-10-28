# Architecture

How Cap Table works, for developers. For the rules to follow when changing it, see [AGENTS.md](../AGENTS.md); for the
database, its migrations and triggers, see [src/app/db/README.md](../src/app/db/README.md).

- [At a glance](#at-a-glance)
- [Request path](#request-path)
- [Identity and roles](#identity-and-roles)
- [Database](#database)
- [The ledger](#the-ledger)
- [Exact decimals and dates](#exact-decimals-and-dates)
- [Documents](#documents)
- [The import](#the-import)
- [What the platform doesn't provide](#what-the-platform-doesnt-provide)
- [Frontend](#frontend)
- [Tests](#tests)
- [Source layout](#source-layout)

## At a glance

- **One npm package** (`captable/`) on the Insulin app template: a Vite + React single-page app and a Nitro server in
  the same project, with one `package-lock.json` and no workspaces.
- **Production:** an ordinary Cloudflare Worker built by Nitro's `cloudflare_module` preset, with static assets and one
  D1 database bound as `DB`. The platform builds and deploys it; the app carries no Wrangler config.
- **Preview and local development:** the Vite dev server (`npm run dev`, port 3000) with a D1-compatible SQLite file
  (`src/local-d1.ts` over `node:sqlite`). In the AppBuilder it runs in a browser-hosted Node runtime.
- **Shared code:** zod contracts and the cap table engine live in `src/app/shared/` and are imported as `#shared`
  (namespaces `api`, `engine`, `ocf`) by the server, the React app and the import core alike. The engine is pure
  TypeScript with no I/O, so the browser can preview exactly what the server will compute.
- **The source of truth is an append-only ledger.** Positions, vesting, deadlines and the cap table are computed by
  replaying it; nothing that describes holdings is stored twice.

## Request path

```
browser (inside the console's iframe)
  │  /api/**                                        everything else: static assets (the SPA)
  ▼
Nitro route  src/api.ts
  │  withSuger(handleAppRequest, { database: openAppD1 })   the platform's own /api/__suger/* routes
  ▼
src/app/server/router.ts   handleAppRequest(request)       opens D1, calls the Hono app
  ▼
src/app/server/app.ts      createApp()                     middleware, then the route families
```

1. In the console access mode, the platform's entry Worker authenticates the user, checks their organization membership
   and their role on the app, and only then forwards the request to the app's Worker.
2. Nitro sends every `/api/**` request to `src/api.ts`. `withSuger` (from `@fours/app/server`) answers the platform's own
   routes and passes the rest to `handleAppRequest`.
3. `handleAppRequest` opens the database with `openAppD1()` from `#platform` (the Worker's `DB` binding, or the local
   file) and hands the request to the Hono app.
4. The middleware, in order: security headers; `GET /api/health`, the one route that needs no identity; outside the dev
   server, a same-origin check on state-changing requests (the AppBuilder preview relays requests from another origin,
   so the dev server skips it); the identity (below), which answers 401 without one and refuses changes from an owner or
   admin whose console profile has no e-mail address; then the access each route family needs.
5. Route families:
   - `/api/me`: who the caller is, their console role and access, whether this is the preview identity, the company (or
     `null` before the first-run setup) and the stakeholders the caller holds equity as;
   - `/api/orgs`: `POST` is the first-run setup; `GET` returns the one company;
   - `/api/orgs/:orgId/...`: the admin workspace: reads, ledger commands, stakeholders, valuations, documents, payment
     instructions, reports and `POST /api/orgs/:orgId/process-due`. Reads need any admin access; writes need `admin_rw`;
   - `/api/portal/...`: the holder view, answering only for the caller's own stakeholders;
   - `/api/admin/...`: owner and admin tools; today `POST /api/admin/orgs/:orgId/verify-ledger`;
   - the import's routes (see [The import](#the-import)).

Errors are JSON. Mutating requests carry an `Idempotency-Key`; ledger commands also carry the ledger sequence and diff
hash they were reviewed against (see [Commands](#commands)).

## Identity and roles

- **Identity comes from the console.** `getCurrentUser(request)` from `@fours/app/server` returns
  `{ userId, organizationId, appId, role, email, name }` (e-mail and name may be null), or `null`. The app never reads the
  platform's identity headers itself and has no login of its own: no sessions, cookies or passwords.
- **The preview identity.** With no console user and `import.meta.env.DEV` true (the Vite dev server: local
  `npm run dev` and the AppBuilder preview), the app acts as a fixed "Preview admin" with role `OWNER` and the address
  `preview@example.test`, and `/api/me` reports `preview: true` (the web app shows a "Preview mode" strip). Server tests
  turn the fallback off by declaring the console access mode in the environment. A production build has no such
  fallback: without a console user every app route under `/api` except the health check answers 401 with
  `{ "error": "Open this app from the Insulin console" }`, and the page says the same (for example when the app is
  published with public access).
- **A `users` row per console user** (id = the console user id) is upserted on each request, so audit rows and
  `created_by` columns point at a real row. The e-mail is stored the first time (an invalid one as `NULL`) and never
  rewritten; the display name is kept current.
- **Roles:**

  | Console role | Access | Can |
  |---|---|---|
  | `OWNER`, `ADMIN` | `admin_rw` | read and write everything in the company |
  | `EDITOR` | `admin_ro`, with personal data | read everything, change nothing |
  | `USER`, `VIEWER` | holder | the holder view of their own stakeholders, if any |

  There is no owner-only tier: every write, including reversals, merges, deadline extensions, plan terms and expiry
  confirmations, needs `admin_rw`.
- **Holder matching.** The console e-mail is compared, case-insensitively, with the active stakeholder e-mails of kind
  `self` on stakeholders whose portal access isn't closed. One address can match several stakeholders; the holder view
  shows each of them.
- **Self-dealing guard.** An owner or admin can't run a ledger command that touches a stakeholder linked to them: through
  an admin link (`admin_stakeholder_links`), or because their console e-mail is on that stakeholder. They also can't
  remove their own admin link.
- **One company per app.** A company is `active`, `importing` or `archived`, and a partial unique index
  (`orgs_one_active`) allows at most one active company. Only the active one is visible: every company list, read, ledger
  load, access resolution and holder match filters on it. The first-run setup (`POST /api/orgs`, owners and admins, only
  while no company exists) creates it, its ledger head and an audit row in one batch that also asserts it is the only
  active company; an import creates it instead (see [The import](#the-import)).
- **Holder responses are allowlisted.** Portal routes are separate handlers that query only the caller's matched
  stakeholders and answer with the allowlist schemas in `src/app/shared/api/portal/`: no cap table, no other holders, no
  fully diluted percentages. Tests compare the responses against the allowlist recursively.

## Database

[src/app/db/README.md](../src/app/db/README.md) is the reference; in short:

- **One SQLite database:** Cloudflare D1 in production; in the preview and locally, `src/local-d1.ts`, the same interface
  over `node:sqlite` and `.suger/data/app.sqlite`.
- **Schema:** `src/app/db/schema.ts`, Drizzle's SQLite dialect. `getDatabase()` (`src/app/db/client.ts`) gives a
  Drizzle client.
- **Migrations:** `0000_init.sql` and later additive migrations are generated by drizzle-kit 0.31.11 and committed with
  their `meta/` journal. `0001_ledger_triggers.sql` is the custom migration that holds what Drizzle can't express: the
  `transaction_types` seed and the triggers. Every statement in it can run again, because a publish that fails midway
  re-runs the migration from its start. Publishing runs `drizzle-kit generate` again and refuses the app if it would
  write anything, then applies pending migrations to D1 before the new Worker serves traffic. The preview applies them
  when the database opens and whenever the journal changes.
- **The triggers** make the ledger tables append-only, chain each transaction to the previous one, let a command claim
  only the next sequence numbers, allow only legal state transitions on workflow rows, require `version = old + 1` on
  every update of a versioned row, and keep records such as document bytes, certificates, valuations and audit events
  immutable.
- **Additive changes only on tables with triggers.** For many changes, drizzle-kit rebuilds a SQLite table (create a copy,
  copy the rows, drop the original, rename), and dropping the original drops its triggers. `npm run build` runs
  `scripts/check-ledger-triggers.mjs` first: it replays every migration on an empty in-memory database and stops the
  build if a statement fails, a chunk holds more or less than one statement, or a trigger goes missing without an
  explicit `DROP TRIGGER`.
- **No STRICT tables** (a platform rule). Decimal columns are `TEXT` with a canonical-decimal `CHECK`; business rows carry
  `org_id`, and children reference parents through composite foreign keys on `(org_id, id)`, so a row can't point at
  another company's data.
- **No SQL transactions.** D1 has no interactive transactions, so there is no `db.transaction()`, `BEGIN` or `COMMIT`. An
  atomic write is one D1 `batch()`: D1 runs a batch as a single transaction, and any failing statement (a constraint, a
  trigger's `RAISE`, a guarded assertion) rolls back all of it.
- **Raw SQL for the ledger.** The ledger writer uses prepared statements on the D1 binding rather than Drizzle, because it
  needs a precise statement order inside one batch and relies on triggers for its preconditions.

## The ledger

### Tables

| Table | Holds |
|---|---|
| `transactions` | The record: one row per fact, typed (OCF `TX_*` types or the app's documented `X_*` extensions), with a legal effective date, a canonical JSON payload and its SHA-256, the actor and source, and a per-company hash chain. Append-only. |
| `commands` | One row per write that changes holdings, claiming a contiguous range of sequence numbers and declaring how many transactions it writes. |
| `securities` | A thin identity row per lot (family, subtype, holder, class, plan, display ID, parent), written once by the command that creates it. A transfer creates new lots; a lot's holder never changes. |
| `command_dependencies` | Causal edges between commands: `consumes_security`, `relies_on_deadline`, `relies_on_terms`. |
| `idempotency_keys` | One receipt per mutating request, with the request's hash and the stored response. |
| `ledger_heads` | The company's latest sequence number and chain hash; only a trigger moves it. |

Everything that can change a number for some date (authorized shares, pool sizes, plan rules, vesting, a termination, a
deadline extension, a leave of absence, execution status) is either a ledger fact or an immutable row referenced by its
hash. Everything else is descriptive reference data (names, contact details, settings): versioned and audited, and
changing it never changes a number.

### Commands

Every change to holdings is a command, `POST /api/orgs/:orgId/commands/<name>`; the list, with each command's access,
transaction types, violations and warnings, is `COMMANDS` in `src/app/shared/api/commands.ts`. The web app offers all of
them except `set-plan-terms`, which has no screen. The system commands `apply-scheduled-termination` and
`expire-securities` run when due items are processed.

1. **Authorize:** the role, the self-dealing guard, the same-origin check, zod validation of the body.
2. **Idempotency:** a receipt is unique per (scope, actor, route, key). A retry with the same body returns the stored
   response; the same key with a different body is a 409.
3. **Load** the ledger head, the company's transactions and the reference rows (or the cached replay).
4. **Engine:** `apply` builds the new transactions (canonical payloads, hashes, the chain from the head) and their
   dependencies, then replays the whole ledger with them at their effective dates, which catches back-dated conflicts. It
   returns violations, which block, and warnings, which the request must acknowledge.
5. **Freshness:** the review screen first calls the command with `?dryRun=true` and gets the diff and its hash. The real
   call sends `expectedLedgerSeq` and `expectedDiffSha256`; if the ledger moved or the diff changed, it gets 409
   `state_changed` and the user reviews again.
6. **One D1 batch,** in order: receipt; command (claims its sequence numbers); new security identities; transactions
   (chained); dependencies; workflow transitions; document links; audit; and the seal, which asserts that the command
   wrote exactly the transactions it declared (and that a reversal covers its whole target). Any failure rolls back the
   whole batch; the server maps the failure to a 409 (`stale_ledger`, `idempotency_key_reused`, `dependents_exist`,
   `state_changed`) and the client refetches and retries with the same key.

### Concurrency without locks

- **Sequence and chain:** a trigger lets a command claim only `head + 1`, and each transaction must have `seq = head + 1`
  and `prev_hash` equal to the head's hash. Of two writers on the same head, one batch wins and the other rolls back whole.
- **Versioned rows:** workflow and reference rows carry `version`, and a trigger requires every update to set
  `version = old + 1`. Writers update by id with the version they read plus one, so a concurrent change aborts the batch
  instead of being lost.
- **Guarded statements:** where no natural update carries a precondition, the batch includes
  `INSERT INTO batch_assertions (ok) SELECT <condition>`: a false condition raises and rolls the batch back; a true one
  stores nothing.
- Never infer a race's outcome from D1's `meta.changes`: it counts rows written by triggers too.

### Replay

- `engine.replay(reference, transactions, { asOf, asKnownAt })` orders transactions by effective date, then sequence;
  skips reversed transactions; applies opening balances; and checks the invariants as it goes: no lot ever negative,
  class outstanding within authorized, new grants within plan availability, exercises within the vested and unexercised
  quantity, conservation on transfers, dates in order, quantities positive.
- `asOf` filters by effective date (the cap table on a given day); `asKnownAt` filters by sequence (what the cap table said
  at a given point in the ledger, before later corrections).
- `engine.computeMetrics` derives issued and outstanding, fully diluted, plan used, available and retired, per-holder and
  per-security numbers. Other modules compute vesting (`vesting.ts`), exercise deadlines and expiry (`deadlines.ts`), the
  ISO $100,000 split (`iso.ts`), the return-to-pool rules (`plan-rules.ts`) and 409A status (`valuations.ts`).
- **Cache:** the server keeps replayed states in memory (`src/app/server/lib/read/`), in a least-recently-used map bounded
  by estimated bytes, keyed by (company, ledger sequence, head hash, `ENGINE_VERSION`) plus a fingerprint of the reference
  rows. Writes always re-check the head inside their batch, so a stale cache can never produce a write. `ENGINE_VERSION`
  must be bumped by any change that can move a number for some ledger.

### Reversal

A correction reverses a whole command: `reverse-command` appends one `X_REVERSAL` per transaction of the target, newest
first, in one batch. Triggers ensure that a reversal belongs to a reverse command, that a command is reversed at most once
and never partly, that a reversal is never itself reversed, that a command can't be reversed while a command that depends
on it stands (`dependents_exist`), and that imported history (actor `import`) can't be reversed at all. The engine also
replays the ledger without the target and refuses if any invariant would break on any date. Replay skips reversed
transactions; as-known views from before the reversal still show them. Display IDs of reversed lots are never reused.

### Verification

`engine.verifyLedgerRows` checks a company's ledger from raw rows: every payload hashes to its stored SHA-256, the sequence
has no gaps, every chain link recomputes from the genesis and the head agrees with the last link, every command's seal and
every reversal's completeness hold, the replay keeps every invariant, and the recorded dependency edges match the ones
replay derives. Problems are reported by id and code only. There is no nightly job and no button for it in the web app:
owners and admins run it on demand with `POST /api/admin/orgs/:orgId/verify-ledger`.

### OCF alignment

Transaction types named `TX_*` are Open Cap Table Format v1.2.0 objects. Their payload keys are checked against the
vendored OCF schemas (`src/app/shared/ocf/`, see [NOTICE](../NOTICE)); the app's own additions use `x_`-prefixed keys.
`X_*` types are the app's documented extensions (stakeholder termination, leave and merge, plan and class terms, execution
status, security modification, reversal, correction, opening balance). The list in
`src/app/shared/engine/transaction-types.ts` mirrors the database's `transaction_types` seed, and a test compares them.

## Exact decimals and dates

- **Storage:** canonical decimal text: no sign, exponent, leading zeros or trailing fractional zeros; at most 12
  fractional digits and 40 characters. A `CHECK` enforces it on every decimal column.
- **Arithmetic:** `Dec` (`engine/decimal.ts`) is a BigInt mantissa with a scale and no fixed precision, so sums and
  products are exact. Division goes through `Rational` (`engine/rational.ts`, exact fractions for ratios and percentages)
  or through a division with an explicitly named rounding mode and scale. Rounding happens only at the display and export
  edge (`engine/format.ts`).
- **No floats:** amounts travel as strings in the API and in JSON payloads; JavaScript numbers are accepted only as safe
  integers, and canonical JSON refuses anything else.
- **No SQL arithmetic** on decimal text: no `SUM`, no comparison, no `ORDER BY` (as text, `'100' < '9'`).
- **Share unit:** each company has one (whole shares by default). It fixes how vesting and conversions round, and a
  trigger freezes it at the first transaction.
- **Dates:** legal dates are `YYYY-MM-DD` strings in the company's time zone, compared as strings and computed on day
  numbers (`engine/dates.ts`), never with `Date`. "Today" is the company's local date. Instants are epoch milliseconds.

## Documents

There is no object storage, so document bytes live in D1 (`src/app/server/lib/documents/`):

- **Upload:** the server checks the declared type against the file's magic bytes (PDF, PNG, JPEG, CSV, plain text, DOCX,
  XLSX), refuses anything over 10 MiB with a plain message, and computes the SHA-256. It writes the bytes as 256 KiB chunks
  into a staging table, `document_upload_chunks`, at most two chunks per batch. A final batch inserts the document's
  metadata, copies the staged chunks into `document_blobs`, asserts the chunk count and total length, deletes the staging
  rows, adds links and the audit row, and commits the idempotency receipt last. A failed upload leaves only staging rows,
  which nothing can see.
- **Download:** a bounded completeness check, then a stream that reads one chunk per pull. `HEAD` reads no bytes and
  writes no audit row; a document with missing bytes is a 404. A `GET` writes a download audit row.
- **Records:** the bytes are append-only; documents are never deleted, only archived or superseded by a new version.
  Holder visibility is enforced in the database: a document linked to two or more holders can't be visible to holders.
- **Housekeeping:** each due-processing pass deletes at most 100 staging rows older than a day.
- **Limits:** raise the 10 MiB cap only after measuring near-cap uploads and downloads on a real D1 database; the local
  adapter can't reproduce D1's BLOB transport or the Worker's memory cost. The AppBuilder's data panel shows
  `document_blobs` rows with their bytes, another reason to keep chunks at 256 KiB.

## The import

A new company is set up by importing Pulley's standard reports or the app's own spreadsheet template.

- **The core** (`src/app/import/`) is a pure module with no I/O. `buildImportPreview(files, options)` takes Pulley's
  reports; `buildTemplateImportPreview(file, options)` takes a filled-in template, whose blank copy
  `generateCapTableTemplate()` builds at run time (the repository stores no binary files). Both adapters produce the same
  draft, keyed by source ids, in which every record keeps its file, sheet, row and column. The shared path then
  validates it into plain-language problems (`error` blocks the import, `warning` doesn't), maps it to reference rows and
  ledger commands ordered by their dependencies, turns history the source can't express into
  `X_MIGRATION_OPENING_BALANCE` transactions with their reasons, records every default it applied as an assumption, and
  replays the plan through the engine. For Pulley, the replayed company, class, plan, holder and security totals must
  equal the Raw Cap Table's; the template has no totals of its own, so the preview shows the engine's.
- **XLSX** is read directly from the workbook's XML (shared and inline strings, Excel dates, decimals kept exact rather
  than passed through floats), with decompression capped per entry and in total. Single-sheet Pulley reports may also be
  comma-separated CSV.
- **The routes** (`src/app/server/routes/imports.ts`, with `src/app/server/lib/import/`) run before a company exists,
  so they sit outside `/api/orgs/:orgId` and check the console role themselves: owners and admins only; editors and
  holders get 403, a request without a console identity 401.
  - `GET /api/import/template`: the blank workbook, generated per request.
  - `POST /api/import/preview`: a multipart form with the source, the files and an optional as-of date, plus the
    company's time zone, jurisdiction and fiscal year end when no company exists yet.
  - `POST /api/import/runs/:runId/commit`: the same files and as-of date again, with an `Idempotency-Key`.
  - `GET /api/import/runs/:runId`: the run's state and counts.
- **Limits.** The server reads the encoded request with a hard bound of 10 MiB, then checks each file (at most 5 MiB),
  the number of files (at most 25; exactly one workbook for the template) and the source. The web app keeps 64 KiB of
  that request for the multipart encoding, so the files it sends add up to at most about 9.9 MiB. A plan must contain at
  least one security and at most 2,000.
- **Preview.** It hashes each file and builds the core preview with the company's local date as "today" (the existing
  empty company's time zone, or the one entered). Before calling a plan importable it checks every row the writer would
  store against the database's rules (lengths, formats, decimals, uniqueness, references, checks) and D1's limits of 100
  bound parameters and 100,000 bytes per statement, and maps a failure back to its source row as a problem. It stores an
  `import_runs` row (the source, each file's name and SHA-256, the as-of date, the plan's SHA-256, the counts and the
  reviewed profile; never the files or the plan) and returns the preview without the plan or any internal code.
- **Commit:**
  1. A receipt for the same `Idempotency-Key` replays its stored answer. Otherwise the run takes a ten-minute attempt
     lease; an overlapping attempt gets 409 "This import is already running".
  2. The preview is rebuilt from the re-sent files and refused (422) unless the file digests, the as-of date, the profile
     and the plan's SHA-256 all equal the reviewed ones and the plan is still importable.
  3. It is refused (409) when the active company has stakeholders or ledger activity, or documents, document folders,
     payment instructions, signatories, legends or valuations, or when a source id in the plan is already in an active
     company's import provenance (`pulley_id`, `pulley_ref`).
  4. It creates a company in the `importing` state with its genesis ledger head. Every company list, read, ledger load,
     access resolution and holder match sees only `active` companies, so nothing written there is visible.
  5. It writes the reference rows, then the commands in dependency order, through the ledger's own statement builders.
     Each command is an indivisible unit; units are packed into D1 batches of about 250 statements, and a larger command
     stays whole. Deterministic ids and per-command receipts make an interrupted attempt resumable: a retry continues in
     the same invisible company when its stored commands are exactly a prefix of the plan, and otherwise archives that
     company and starts a fresh one.
  6. It runs the ledger verifier on the importing company and compares its company, class, plan and holder totals with
     the reviewed plan's.
  7. One final batch asserts the importing state and the exact ledger head, archives the empty active company if there
     is one (carrying its profile and settings over), activates the imported company, asserts exactly one active company
     and the expected row counts, marks the run committed, writes `import.committed` to the audit log and stores the
     idempotency receipt. Either all of that happens or none of it.
- **Failures.** A failure during the write leaves only immutable rows in the invisible company; the run becomes
  `failed` with a plain message, an `import.failed` audit row and a structured error log (stage and stack, no file
  content), and the answer is a 500 that invites a retry. Mismatches and refusals happen before anything is written.

## What the platform doesn't provide

| Missing on the platform | What Cap Table does instead |
|---|---|
| Cron triggers | Due work runs on demand: when an owner or admin loads the dashboard (a check against the engine's own expiry candidates first, and at most 10 automatic expiries per load), and with `POST /api/orgs/:orgId/process-due`, which has no cap. Deterministic idempotency keys (`system:terminate:<id>`, `system:expire:<company>:<date>:<security>`) make repeated runs harmless. While expiry is report-only, processing records an `expiry_runs` row for an admin to confirm instead of expiring. |
| Object storage (R2) | Document bytes in D1, in chunks. |
| E-mail | No notifications; the UI reminds admins to tell people. |
| Durable Objects | Per-company write serialization from the ledger's triggers in D1. |
| KV, Queues | Not needed: the replay cache lives in the Worker's memory, and work runs inside the request. |
| SQL transactions | One D1 batch per write, with triggers and guarded statements. |
| WebSockets, Server-Sent Events | Plain request and response. |

## Frontend

- React 19 with React Router (`src/app/router.tsx`, one browser router). The admin workspace lives under
  `/companies/:orgId/...`, the holder view under `/portfolio/:orgId/...`, the first-run setup at `/setup` (its three ways
  in as `/setup?start=empty|pulley|spreadsheet`), the import at `/companies/:orgId/import` (beside the workspace, because
  an import replaces the company the address names), and an admin's "Preview as stakeholder" at
  `/companies/:orgId/stakeholders/:stakeholderId/preview`, which renders the portal's pages. `/api/me` decides where a
  user lands; a 401 from any call shows the full-page "Open this app from the Insulin console".
- The import wizard (`components/ImportWizard.tsx`, `ImportPreview.tsx`, `lib/imports.ts`, `lib/useImportFiles.ts`)
  keeps the chosen files in memory only, never in browser storage, and checks the limits before sending anything. The
  server computes the preview; the browser parses nothing. The commit reuses one idempotency key per preview, so after
  a lost answer the admin can check the run or try again safely, and in-app navigation stays blocked while an import
  runs.
- The console shows the app in a sandboxed iframe, so the UI never uses `window.open`, `target="_blank"`, `alert`,
  `confirm`, `prompt`, `print` or top-level navigation. Downloads use a blob URL and `<a download>`. Fonts and images ship
  with the app (no CDNs), and `localStorage` holds only disposable table preferences.
- Writes follow the review pattern: a dry run shows exactly what will change, the user confirms, and the real request
  carries the reviewed sequence number and diff hash, under one idempotency key per intent so that a lost answer can be
  retried safely. While an outcome is unknown, an in-app guard holds navigation (no `beforeunload` prompt).

## Tests

- vitest with two projects (`vitest.config.ts`): `node` for `test/shared`, `test/server`, `test/db` and `test/import`, and
  `web` (jsdom) for `test/web`. `test/support` holds the server harness and fixtures.
- `test/shared`: the engine and the contracts, with unit, property (fast-check) and golden tests on synthetic fixtures (the
  fictional company Acme Robotics).
- `test/server`: requests go through the app (`test/support/server-harness.ts`) against a fresh database built from the
  real migrations, with console identities supplied the way the platform supplies them, and production same-origin
  enforcement.
- `test/db`: the schema against the migrations, trigger behaviour, retry safety of the custom migration, and the trigger
  check.
- `test/import`: synthetic Pulley workbooks and templates built in code (the repository stores text only, so no binary
  fixtures).
- `test/web`: the React app, including a walk through every admin page with each request held back or failing, and a
  scan of the web sources for unfinished-work markers, copy that promises a later version or an e-mail, and links or
  assets from other sites.
- **workerd:** `.github/scripts/workerd-smoke/` at the repository root builds the app for Cloudflare, applies the migrations to a
  local D1 database with a random synthetic id, starts the Worker with `wrangler dev --local` (Wrangler pinned in the
  harness's own lockfile), and drives it with console identity headers and synthetic data: health, a missing identity,
  setup, the SPA fallback, a refused cross-origin write, an empty company, the template download, an import preview and
  commit, the cap table, the dashboard, a matching holder's view, ledger verification, a refused second import, a
  chunked document upload and download, an editor's download and an unmatched viewer's refusal. It catches what Node's
  SQLite can't, such as D1's limits on compound queries. CI runs it after the app job: `node smoke.mjs` there
  (`--skip-build` reuses the last build).

## Source layout

```
src/
  api.ts, main.tsx, platform.*.ts, local-d1.ts,    platform template files (keep them byte-identical)
  cloudflare-workers.d.ts, suger-app-builder-runtime.tsx
  app/
    App.tsx, router.tsx        React root and routes
    pages/, components/, lib/  the React app; components/flows/ holds the review-and-confirm dialogs
    api/, auth/                the typed API client; the console identity, access and guards
    server/
      router.ts                handleAppRequest → createApp() in app.ts
      routes/, middleware/     the HTTP layer
      lib/ledger/              command handlers, the batch writer, reversal, due work, verification
      lib/read/                the replay cache and read models
      lib/access/              roles, holder matching, the self-dealing guard
      lib/documents/           uploads, storage in D1, visibility
      lib/import/              the import's form parsing, preview, database checks and writer
      lib/reports/             CSV and XLSX exports
    db/
      schema.ts, client.ts     the Drizzle schema and client
      migrations/              generated migrations, the custom trigger migration, meta/
      README.md                migrations, triggers and the build check
    shared/
      api/                     zod contracts (requests, responses, routes, commands, portal allowlist)
      engine/                  the cap table engine
      ocf/                     the OCF pin and vendored schemas
    import/                    the import core (Pulley reports and the spreadsheet template)
scripts/check-ledger-triggers.mjs   the build's migration and trigger check
test/                          shared/, server/, db/, import/, web/, support/
docs/                          the guides
```

At the repository root, outside the app, in `.github/scripts/`: the workerd harness (`workerd-smoke/`, with its own
lockfile) and the Insulin-shape and public-content checks.
