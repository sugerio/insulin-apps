# Cap Table

Cap Table is your company's equity record. It keeps track of who owns what (shares, stock options, warrants and
SAFEs), how each holding came about, and how it vests. Employees, advisors and investors can open it to see their own
holdings, and nobody else's.

It is an Insulin app: you start from it in the Insulin console, change it with the AppBuilder if you want to, preview it
and publish it. It brings its own database and needs no other service.

## What it does

- **The cap table, as of any date.** Issued and outstanding shares, fully diluted ownership, every share class and
  equity plan, and every holder's position, calculated from the full history for whichever date you pick.
- **Set up by import.** Import Pulley's standard reports, or fill in the Cap Table spreadsheet template; check a
  plain-language preview; import your cap table in one step.
- **Stakeholders.** Founders, employees, advisors, investors and institutions, with their details and e-mail addresses.
- **Option grants and vesting.** Record a signed ISO or NSO grant from a plan, with its vesting schedule and exercise
  price. Vesting, what can be exercised, and every deadline are worked out for you.
- **Exercises.** Record an exercise a holder reports, with the payment, the fair market value and the tax details. The
  app creates the resulting shares.
- **Terminations.** Stop vesting when someone leaves, today or on a future date. The app shows what is cancelled, what
  goes back to the pool, and how long the person has to exercise.
- **409A valuations.** Record each valuation. The app tracks when it expires or needs review, and won't price a new
  grant without a valid one (or counsel's memo).
- **Documents.** Keep agreements, board consents, certificates and valuation reports with the records they belong to,
  and choose which ones a holder can see.
- **Reports.** Download the cap table, the raw cap table, stakeholders, vesting details, exercise history and the audit
  log.
- **A permanent history.** Every change is recorded with who made it and when. A mistake is corrected by reversing the
  change, never by rewriting history.
- **Built-in Docs.** **Docs**, at the bottom of everyone's sidebar, explains how to use Cap Table and what holders see,
  and covers the basics of equity in plain words (share counts, common and preferred stock, stock options and vesting,
  ISOs and NSOs, 409A valuations, SAFEs, dilution), with a glossary.

## Who it's for

Private companies that keep their own equity records: founders, and the finance, legal or people team who look after
the cap table. It is a natural next step for companies leaving Pulley, and the spreadsheet template serves everyone
else. Everyone who holds equity (employees, former employees, advisors, investors) can be given a view of their own
holdings.

## Good to know

- **Classes, plans and holdings come in with the import.** Share classes, equity plans, issued shares, option grants,
  warrants and SAFEs are set up by importing Pulley's reports or the spreadsheet template into a new company. After
  that, the app records new option grants, exercises, terminations and cancellations; it has no forms to add share
  classes or plans, or to issue shares.
- **No e-mail.** The app doesn't send messages; tell people yourself when something changes for them.
- **No signatures or payments.** Agreements are signed elsewhere and uploaded; payments happen outside the app and are
  recorded in it.
- **No background jobs.** Scheduled terminations and option expiries take effect when an owner or admin opens the
  dashboard, or chooses **Process due items** there.
- **Not a valuation, tax or legal service.** It records 409A valuations but doesn't perform them, and it doesn't file tax
  forms or give advice.
- **One company per app.**
- **Not supported:** RSUs, SARs, phantom stock, convertible notes and profits interests.

## Getting started

1. **Start from Cap Table.** In the Insulin console, choose **New app**. Under **Or start from a template**, choose **Use
   template** on Cap Table, keep or change the app's name, and choose **Create app**. The AppBuilder opens the app ready to
   use, on a live preview; ask its chat for any changes. (The console lists templates once the platform's template
   catalog includes this repository.)
2. **Try it in the preview.** In the preview a "Preview mode" strip says you are a stand-in owner, so you can set up a
   practice company, run a practice import and try every screen. The preview keeps its own practice database in your
   browser: nothing you do there reaches the published app.
3. **Publish.** Choose **Publish**. The platform builds the app and gives it its own database. Keep the app's access
   setting on **Console**: Cap Table relies on the console to know who is using it, and opened any other way it only
   says "Open this app from the Insulin console".
4. **Give people access.** In the console, give each person a role on the app (see [Who can do what](#who-can-do-what)).
5. **Set up your company.** The first owner or admin to open the published app chooses how to start: **Start with an
   empty company**, **Import from Pulley**, or **Import from a spreadsheet** (with **Download the template**). An empty
   company asks for its name, legal name, state and date of incorporation, time zone (which decides when "today" starts
   for vesting and deadlines) and fiscal year end; you can still import into it later, as long as nothing has been added
   to it. Everyone else sees that Cap Table isn't set up yet. For anyone new to cap tables, the setup page links to the
   built-in docs (**Learn about cap tables**).
6. **Bring in your cap table.** Follow [Importing your cap table](docs/importing.md), then see
   [Using Cap Table](docs/using-cap-table.md) for everyday work.

## Who can do what

Cap Table uses the roles people have on the app in the Insulin console. There are no separate accounts or passwords.

| Console role | In Cap Table |
|---|---|
| Owner, Admin | Manage the cap table: the import, stakeholders, grants, exercises, terminations, valuations, documents, settings and reports. |
| Editor | See everything, including personal details, and download reports. Change nothing. |
| User, Viewer | The holder view: their own holdings only. |

- **Holders are matched by e-mail.** A User or Viewer sees the stakeholder records that carry the e-mail address of their
  console account as the person's own address (not as a contact for an institution); capitals don't matter. If someone
  sees no holdings, add their console e-mail address to their stakeholder record.
- **Owners and admins need an e-mail address on their console profile** to make changes.
- **Owners and admins who hold equity** can't record changes to their own stakeholder record or holdings: another
  owner or admin has to. They see their holdings in the cap table itself; the holder view is for Users and Viewers.
- **About the Editor role:** in the console, an editor can also publish the app from the AppBuilder, which is much more
  than viewing. Give it only to people you would trust with the whole cap table.

## The holder view

When a holder opens Cap Table they see:

- their shares, options, warrants and SAFEs (each SAFE with its status and, once converted, the shares it became), with
  vesting progress and upcoming vesting dates;
- for each option: how much has vested, what they can exercise now and until when, and the exercise price;
- **How to exercise**: your instructions, the form to use and how to pay;
- the documents you have made visible to them, and the company resources you share with all holders;
- **Docs**: what they see and how to read it, how exercising works, and the basics of equity.

They never see the cap table, other holders or ownership percentages. Owners, admins and editors can open any stakeholder
and choose **Preview as stakeholder** to see that person's holdings, exercise instructions and documents as they see
them; the holder's **Docs** entry isn't part of the preview.

## Guides

| Guide | For |
|---|---|
| **Docs**, in the app | Everyone: getting started, importing, everyday tasks, the holder view, equity basics and a glossary. |
| [Using Cap Table](docs/using-cap-table.md) | Owners and admins: everyday tasks. |
| [Importing your cap table](docs/importing.md) | Whoever sets up the company: from Pulley or the spreadsheet template, step by step in the browser. |
| [Architecture](docs/architecture.md) | Developers: how the app works. |
| [AGENTS.md](AGENTS.md) | AI coding agents (including the Insulin AppBuilder) and contributors: the rules of the codebase. |
| [src/app/db/README.md](src/app/db/README.md) | Anyone changing the database: migrations, triggers and the build check. |

## For developers

Cap Table is one npm package on the Insulin app template: Vite, React and Nitro, with Drizzle on Cloudflare D1. It needs
Node 22.

### Run it locally

```bash
npm ci
npm run dev        # http://localhost:3000
```

Locally, as in the AppBuilder preview, there is no console identity, so the app treats you as a stand-in owner (the
"Preview admin"). The data lives in `.suger/data/app.sqlite`, and pending migrations apply when the app opens it. Delete
the file to start over.

### Test, typecheck, build

```bash
npm test             # vitest: the "node" project (test/shared, server, db, import) and "web" (test/web, jsdom)
npm run typecheck
NODE_ENV=production NITRO_PRESET=cloudflare_module npm run build   # what publishing runs; writes .output/
```

`npm run build` first runs `scripts/check-ledger-triggers.mjs`, which replays the migrations on an empty database and
stops the build if a migration fails or a ledger trigger goes missing. From the repository root,
`node .github/scripts/check-insulin-app.mjs captable` checks that the app keeps the shape the platform expects (add `--built`
after a build), and `node .github/scripts/check-public-content.mjs` checks that nothing private has slipped into the repository.
CI runs all of them.

### Run it in workerd

`.github/scripts/workerd-smoke/` at the repository root runs the production build the way Cloudflare does. It builds the app,
applies its migrations to a local D1 database, starts it with `wrangler dev --local`, and drives the main paths with
synthetic data and console identities: health, identity and setup, an import from the spreadsheet template, the cap
table and dashboard, a holder's view, ledger verification and a chunked document upload and download. It always stops
the worker and removes its scratch files, and prints the worker's log if a check fails. CI runs it after the app's
checks.

```bash
npm ci                          # here, in captable/: the build uses the app's dependencies
cd ../.github/scripts/workerd-smoke
npm ci
node smoke.mjs                  # add --skip-build to reuse the last build
```

### Database changes

Edit `src/app/db/schema.ts`, run `npm run db:generate`, and commit what it writes under `src/app/db/migrations/`. Never
edit generated migrations by hand: publishing refuses an app whose migrations are out of step with its schema. Tables
with triggers take additive changes only; [src/app/db/README.md](src/app/db/README.md) explains why, what the build
check catches, how to write a custom migration, and how to recover from a publish that fails while migrating.

The AppBuilder provides drizzle-kit. Locally, install the versions the publish pipeline uses once, outside the project,
and put them on your `PATH`:

```bash
npm install --prefix "$HOME/.cache/drizzle-tools" --no-audit --no-fund drizzle-kit@0.31.11 drizzle-orm@0.45.3
PATH="$HOME/.cache/drizzle-tools/node_modules/.bin:$PATH" npm run db:generate
```

### How the app fits the Insulin layout

```
index.html, src/main.tsx           the page and its entry point
src/api.ts                         every /api/** request: the platform's own routes (withSuger), then the app's
src/platform.local.ts              the runtime: the local preview (process.env, a SQLite file) ...
src/platform.worker.ts             ... or the Cloudflare Worker (env, the D1 binding)
src/local-d1.ts                    the preview's D1-compatible database
src/suger-app-builder-runtime.tsx  the AppBuilder's preview bridge (inert once published)
vite.config.ts, drizzle.config.ts  build and migration settings
src/app/                           Cap Table itself
  App.tsx, router.tsx              React root and routes: the admin workspace, the holder view, first-run setup, the docs
  pages/, components/, lib/        the React app; api/ and auth/ hold its API client and the console identity
  pages/docs/                      the in-app Docs: one topic per file, as static TSX
  server/router.ts                 handleAppRequest(request): hands every app request to the Hono API in server/
  db/                              the Drizzle schema, migrations and README
  shared/                          contracts (zod) and the cap table engine, imported as #shared
  import/                          the import core: Pulley's reports and the spreadsheet template to a preview and a plan
scripts/check-ledger-triggers.mjs  the build's migration and trigger check
test/                              vitest suites by area
docs/                              the guides
```

In this list, everything outside `src/app/`, `scripts/`, `test/` and `docs/` comes from the platform template and stays
byte-identical to it: the platform upgrades those files and relies on how they behave.
`test/server/framework-template.test.ts` pins the contents of the platform's files under `src/`.
[Architecture](docs/architecture.md) covers the request path, the ledger and the database.

## License

MIT: see [LICENSE](../LICENSE). The vendored Open Cap Table Format schemas are © Open Cap Table Coalition under their own
license: see [NOTICE](NOTICE).
