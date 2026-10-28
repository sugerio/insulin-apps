# AGENTS.md

Guidance for AI coding agents (including the Insulin AppBuilder) and for contributors working on Cap Table. Read it
before changing code. [docs/architecture.md](docs/architecture.md) explains how the app works, and
[src/app/db/README.md](src/app/db/README.md) covers the database; this file says what to do and what never to do.

## The app in brief

Cap Table is an equity management app on the Insulin app template: one npm package, Vite + React + Nitro, deployed as a
Cloudflare Worker with one D1 database. Its source of truth is an append-only, hash-chained ledger of transactions;
every number (positions, vesting, deadlines, the cap table) is computed by replaying that ledger with a pure TypeScript
engine shared by the server and the browser. Users and roles come from the Insulin console. A company is set up by
importing Pulley's reports or the app's spreadsheet template.

## Commands

Run from `captable/` unless noted.

| When | Run |
|---|---|
| After any TypeScript change | `npm run typecheck` |
| Before you finish, and after every behaviour change | `npm test` |
| After changing `src/app/db/schema.ts` | `npm run db:generate`, then `npm run build` (its first step checks the migrations) |
| To check what publishing will build | `NODE_ENV=production NITRO_PRESET=cloudflare_module npm run build` |
| To try it | `npm run dev` (port 3000; you are the "Preview admin", a stand-in owner) |
| From the repository root, before you finish | `node .github/scripts/check-insulin-app.mjs captable` and `node .github/scripts/check-public-content.mjs` |
| After server, database or build changes (developers; CI runs it) | `node smoke.mjs` in `.github/scripts/workerd-smoke/` at the repository root, after `npm ci` there and in `captable/`: the production build in workerd with a local D1 |

`npm run db:generate` needs drizzle-kit 0.31.11 with drizzle-orm 0.45.3. The AppBuilder provides them; locally, see the
README's "Database changes".

## Where things live

| Path | What |
|---|---|
| `src/app/App.tsx`, `src/app/router.tsx` | React root and routes: the admin workspace (`/companies/:orgId/...`), the holder view (`/portfolio/:orgId/...`), first-run setup (`/setup`) |
| `src/app/pages/`, `components/`, `lib/` | The React app; `components/flows/` holds the review-and-confirm dialogs |
| `src/app/pages/docs/`, `components/Docs.tsx` | The in-app Docs: one static TSX file per topic, shown by one component in the workspace, the portfolio and before setup |
| `src/app/api/`, `src/app/auth/` | The typed API client; the console identity (`/api/me`), access helpers and route guards |
| `src/app/server/router.ts` | `handleAppRequest(request)`: every app `/api/**` request, handed to `createApp()` in `server/app.ts` |
| `src/app/server/routes/`, `middleware/` | The HTTP layer |
| `src/app/server/lib/` | `ledger/` (commands, the batch writer, reversal, due work, verification), `read/` (replay cache, read models), `access/` (roles, holder matching, self-dealing), `documents/` (uploads, D1 storage, visibility), `import/` (the import's form parsing, preview, database checks and writer), `reports/` (exports), identity |
| `src/app/server/routes/imports.ts`, `src/app/components/ImportWizard.tsx` | The import's routes and its wizard (with `ImportPreview.tsx`, `lib/imports.ts`, `lib/useImportFiles.ts`) |
| `src/app/db/` | `schema.ts`, `client.ts`, `migrations/` (generated, plus the custom `0001_ledger_triggers.sql`) and `README.md` |
| `src/app/shared/api/` | zod contracts: requests, responses, routes, the command index (`commands.ts`), the holder allowlist (`portal/`) |
| `src/app/shared/engine/` | The engine: decimals, dates, replay, metrics, vesting, deadlines, ISO split, verification |
| `src/app/shared/ocf/` | The Open Cap Table Format v1.2.0 pin and vendored schemas (third-party: see `NOTICE`) |
| `src/app/import/` | The import core: pure functions from Pulley's reports or the spreadsheet template to a preview and a write plan |
| `scripts/check-ledger-triggers.mjs` | The build's migration and trigger check |
| `test/shared`, `test/server`, `test/db`, `test/import`, `test/web`, `test/support` | Tests by area (`web` runs under jsdom); `support` holds the server harness |
| `docs/` | User and developer guides |
| `../.github/scripts/workerd-smoke/` | The repository-level workerd harness (its own lockfile) |

`#shared` resolves to `src/app/shared/index.ts` (namespaces `api`, `engine`, `ocf`); `#platform` resolves to the runtime
adapter.

## Platform files: leave them alone

`index.html`, `src/main.tsx`, `src/api.ts`, `src/platform.local.ts`, `src/platform.worker.ts`, `src/local-d1.ts`,
`src/cloudflare-workers.d.ts`, `src/suger-app-builder-runtime.tsx`, `vite.config.ts` and `drizzle.config.ts` come from
the Insulin template and stay byte-identical to it: the platform upgrades them and relies on their behaviour
(`test/server/framework-template.test.ts` pins the ones under `src/`). All app code goes under `src/app/`. In
particular:

- keep `withSuger(...)` in `src/api.ts` and the export of `handleAppRequest` in `src/app/server/router.ts`;
- import `cloudflare:*` modules nowhere but `src/platform.worker.ts`;
- import `@fours/app/server` only from server code (`src/api.ts`, `src/platform.*.ts`, `src/app/server/`, `src/app/db/`);
- read configuration with `readAppEnv(name)` from `#platform`, on the server only. Never put a secret in source.

## Platform limits

- **Runtime:** one D1 database (`DB`), static assets, outbound `fetch`, and environment values. There is no cron, R2, KV,
  Queues, Durable Objects, e-mail binding, Workers AI, WebSockets, Server-Sent Events or service workers. Work runs inside
  a request: due work runs when an owner or admin loads the dashboard and with `POST /api/orgs/:orgId/process-due`.
- **The UI runs in a sandboxed iframe in the console:** no `window.open`, `target="_blank"`, `alert`, `confirm`,
  `prompt`, `print`, `beforeunload` or top-level navigation. Downloads use `<a download>`. No fonts, scripts or images
  from CDNs. `localStorage` only for disposable UI preferences.
- **Stored source:** at most 2,000 files, 1 MiB each and 10 MiB in total, UTF-8 text only. Never commit binary fixtures:
  build XLSX or PDF test inputs in code.
- **Dependencies:** npm and `package-lock.json` only, exact versions from registry.npmjs.org, pure JavaScript that runs
  in both Cloudflare Workers and the browser-hosted preview, no install scripts. Add one only when you must.

## The ledger

1. **Append-only.** Never `UPDATE` or `DELETE` rows of `transactions`, `commands`, `securities`, `command_dependencies`
   or `idempotency_keys` (triggers refuse it anyway). Never write to them except through the ledger writer.
2. **Every change to holdings is a command.** Anything that can move issued and outstanding, fully diluted, plan
   availability, vesting, exercisability or a deadline is recorded as ledger transactions by a command, or lives in an
   immutable row referenced by hash. Never store a derived number (a position, a vested amount, a total): compute it by
   replay.
3. **Never edit history.** A correction is `reverse-command`: it reverses a whole command, needs a reason, and is refused
   while dependent commands stand (reverse those first) and for imported history. A change going forward is a new
   effective-dated fact, such as `set-plan-terms`.
4. **One batch per write.** A command writes in a single D1 `batch()`, in the writer's fixed order (receipt, command,
   securities, transactions, dependencies, workflow, documents, audit, seal). Never use `db.transaction()`, `BEGIN` or
   `COMMIT`. Express preconditions with triggers or a guarded statement (`INSERT INTO batch_assertions (ok) SELECT
   <condition>`), and never infer success from `meta.changes`, which counts trigger writes.
5. **Adding a command:** its contract in `src/app/shared/api/commands.ts` (schema, dry-run schema, access, transaction
   types, violations, warnings), its handler next to the others in `src/app/server/lib/ledger/commands/`, its payloads
   and replay rules in the engine (`engine/payloads.ts`, `engine/replay.ts`), and tests at each level. A command with a
   dry-run schema answers `?dryRun=true` with the diff the review screen shows; real calls carry `Idempotency-Key` and,
   where `ledgerGuard` is set, `expectedLedgerSeq` and `expectedDiffSha256`.
6. **Adding a transaction type:** add it to `engine/transaction-types.ts` and to the `transaction_types` seed together
   (a test compares them). The seed lives in a custom migration, so that part is a developer's job (see below). An OCF
   `TX_*` type keeps exactly the keys its vendored schema allows; the app's own fields use `x_`-prefixed keys, and
   app-specific types are `X_*`.
7. **The engine is pure and deterministic:** no I/O, no clock (pass dates in), no randomness. Bump `ENGINE_VERSION`
   (`engine/version.ts`) with any change that can move a number for some ledger: it keys the replay cache.
8. **Don't change hashing or canonical JSON** (`engine/hashing.ts`, `engine/canonical.ts`): existing chains would stop
   verifying.

## Database and migrations

[src/app/db/README.md](src/app/db/README.md) is the reference. The rules:

1. **Generated, never hand-edited.** Edit `src/app/db/schema.ts`, run `npm run db:generate`, commit the SQL and the
   `meta/` files. Never edit a generated migration or `meta/_journal.json`, and never delete, rename or reorder a
   migration: published apps have already applied them. Publishing refuses the app if `drizzle-kit generate` would write
   anything, so commit the schema and its migrations together.
2. **Tables with triggers take additive changes only.** Do: add a table; add a nullable column or one with a default (a
   single-column `.references()` is fine); add an index or a unique index. Don't: add or change a `check()`, a default,
   `.notNull()`, a column type, a primary key or a multi-column `foreignKey()`; drop or rename a column or the table.
   drizzle-kit makes those changes by rebuilding the table, which drops its triggers. Many core tables have triggers:
   look in `src/app/db/migrations/0001_ledger_triggers.sql` before changing one.
3. **The build checks it.** `npm run build` replays the migrations and stops when a statement fails, a chunk holds more
   or less than one statement, or a trigger goes missing.
4. **AppBuilder agents can't write, edit or delete migration files.** If the check fails after `npm run db:generate`,
   revert the change in `schema.ts` and tell the user that the generated migration must be removed before the app is
   published.
5. **Custom migrations are for developers**, following the README: one statement per chunk, every statement safe to run
   again (`CREATE TRIGGER IF NOT EXISTS`, `INSERT OR IGNORE`, ...), triggers restored in their original order. Never edit
   one that has been published.
6. **Forward-compatible.** While a new version publishes, the version already serving shares the database, and nothing
   rolls a database back: every migration must work with both the previous and the new code. Expand first, contract in a
   later release.
7. **SQLite rules:** no `STRICT` tables; decimal columns are `TEXT` with the canonical-decimal `CHECK`; every business
   row carries `org_id`, and references use composite foreign keys on `(org_id, id)`.

## Exact decimals

- Never use a JavaScript `number` for shares, money, prices, ratios or percentages. They are canonical decimal strings in
  the API and in payloads, `Dec` or `Rational` in code (`engine/decimal.ts`, `engine/rational.ts`), and `TEXT` in SQL.
  Numbers are fine only for counts and safe integers.
- Round only at the display or export edge, with a named mode (`engine/format.ts`). Never round silently on input: refuse
  a value with more than 12 fractional digits.
- No SQL arithmetic, `SUM`, comparison or `ORDER BY` on decimal text.
- Dates are `YYYY-MM-DD` strings in the company's time zone; use `engine/dates.ts`, never `Date` arithmetic.

## Roles and access

| Console role | Access in the app |
|---|---|
| `OWNER`, `ADMIN` | `admin_rw`: read and write. There is no owner-only tier. |
| `EDITOR` | `admin_ro` with personal data: read only |
| `USER`, `VIEWER` | holder: their own holdings, matched by console e-mail (case-insensitively) against active stakeholder e-mails of kind `self` whose portal access isn't closed |

- **Enforce on the server**, per route and per command (`access` in `COMMANDS`). Hiding a button is not access control.
- **Holder responses use the allowlist schemas** in `src/app/shared/api/portal/`. Never add company-wide data, other
  holders, fully diluted percentages or anyone else's personal data to a holder response; the allowlist tests must keep
  passing.
- **Keep the self-dealing guard:** an owner or admin can't run a command touching a stakeholder linked to them.
- **Owners and admins without a console e-mail can't make changes**; the server refuses before any route runs.
- **No login of our own:** no sign-in screens, sessions, cookies or passwords. Use `getCurrentUser(request)` from
  `@fours/app/server`; never read the platform's identity headers directly. The fixed "Preview admin" exists only when
  `import.meta.env.DEV` is true.
- **One company per Insulin organization**, created by the first-run setup or by the import. `orgs.console_organization_id`
  is the opaque console organization id, and every pre-company record is scoped by it. A company is `active`, `importing`
  or `archived`; keep both the owner and `active` filters in every query that lists or resolves companies, so another
  console organization's company, a company being imported, or one an import replaced stays invisible.

## Public repository

This code is public. Use synthetic data only: example.com, example.org, example.net or `.test` addresses, and fictional
people and companies (the fixtures use Acme Robotics). Never add real names, e-mail addresses, company data, cloud account
or database ids, keys, or local paths. `node .github/scripts/check-public-content.mjs` (from the repository root) checks this, and
CI runs it.

## User-facing text

Plain language: no internal codes, table names or enum values in the UI. The product is called "Cap Table". Explain what
blocks an action and how to fix it. Describe what the app does now, never what a later version might do, never promise
an e-mail (the app sends none), and leave no unfinished-work markers. `test/web/publishable-source.test.ts` checks the
web sources for these, and for links or assets from other sites.

## Tests

- Add or update tests with every change: `test/shared` for the engine and contracts (property tests with fast-check for
  engine rules), `test/server` for routes and commands (through the harness in `test/support`), `test/db` for the schema,
  triggers and migrations, `test/import` for the import core (workbooks built in code, for both sources), `test/web` for
  the React app.
- Use the synthetic fixtures (`test/shared/engine/fixtures/`, `test/db/fixtures.ts`, `test/import/support/`); never real
  data.
- `npm test` and `npm run typecheck` must pass before you finish. CI also checks the migrations against the schema and
  builds for Cloudflare.

## Docs

The in-app Docs are required, as for every app in this repository: keep the **Docs** entry open to every role, before
setup too. When behaviour changes, update the guide that describes it: `README.md`, `docs/using-cap-table.md`, `docs/importing.md`,
`docs/architecture.md` or `src/app/db/README.md`, and the in-app Docs topic in `src/app/pages/docs/` that users read. The
in-app Docs describe only what the app does, in plain words, and their equity topics stay general information, not
advice.
