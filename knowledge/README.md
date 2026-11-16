# Knowledge

Insulin Knowledge keeps a team's files, web pages and notes in **collections** that people and their AI assistants
ask. Every answer cites the exact words it comes from, or says "I won't guess". A wrong answer is fixed once, as a note
every new question uses; every change makes a restore point that can be gone back to and undone; a collection is
private to its owner until shared, like a shared document.

It is an Insulin app: it runs at `knowledge.<domain>` behind the Insulin hosting gateway, which signs people in,
decides their role, serves Knowledge's MCP server for AI assistants and its API for API clients, relays mail and runs
a five-minute tick. Unlike the other apps, Knowledge owns an **engine** (`engine/`): a second Worker, reached only over
the `SUGER_ENGINE` service binding, with one Durable Object and container per collection
(`.github/hosting/DESIGN.md` §12.1). The product design is "Insulin Knowledge" (design sections cited below).

**Status: in development.** The API, the screens (Home, Collections, each collection's Overview, Ask, Sources, What it
knows, Sharing and History, Needs attention, Rules and data, Health) and the in-app Docs are built; the real engine
is described in `engine/`. Use synthetic data only.

## Who can do what

Three kinds of roles work together (design section 08):

- **The role in Knowledge** (Admin, Editor, Viewer, or a custom role built from the permissions below) comes from the
  platform. Admins and Editors start collections; Admins also see Rules and data and Health. Being an Admin gives no
  access to any collection's content.
- **The collection role** (Owner, Admin, Editor, Viewer) comes from owning it, its general access (everyone in the
  organization who can use Knowledge, up to Editor) and shares by name; the highest wins. API clients get one only
  from a share with them by name. Without `knowledge.collections.edit`, every collection role acts as Viewer.
- **Organization owners** see every collection's basic information (`GET /api/collections/others`) and can delete one
  at a time, after typing its name; nothing more without a collection role.

| In a collection | Owner | Admin | Editor | Viewer |
| --- | --- | --- | --- | --- |
| Ask, open sources, see facts and history, report an answer | ✓ | ✓ | ✓ | ✓ |
| Add files, web pages and notes, fix answers and facts, stop using a file, go back | ✓ | ✓ | ✓ | |
| Remove a file for good | ✓ | ✓ | | |
| Share; change settings; export (browser only) | ✓ | ✓ | | |
| Transfer ownership; delete (browser only) | ✓ | | | |

| Permission | Least role | Allows, where the collection role allows it too |
| --- | --- | --- |
| `knowledge.use` | Viewer | Ask and read the collections shared with them; report a wrong answer |
| `knowledge.collections.create` | Editor | Start collections |
| `knowledge.collections.edit` | Editor | Change content; without it every collection role acts as Viewer |
| `knowledge.collections.share` | Editor | Share, change settings, remove files for good, transfer |
| `knowledge.collections.export` | Editor | Export a collection |
| `knowledge.rules.manage` | Admin | Rules and data, usage, Health |

AI assistants act as their person, with `x-suger-access-via: mcp`; API clients are principals of their own
(`api`). One switch per collection turns both off. Sharing, settings, export, transfer and delete are browser-only.

## The API

Everything is under `/api`, JSON, and `GET /api/catalog` lists what the caller may use. Changes that create something
need an `Idempotency-Key` header. Errors are `{ error, message }` in plain words; over a limit, 429
`{ error: 'quota_exceeded', limit, resets_at, message }` naming Insulin Apps support (`SUGER_SUPPORT_EMAIL`).

| Route | Who |
| --- | --- |
| `GET /api/me`, `GET /api/catalog` | everyone |
| `GET /api/collections` (with your role), `POST /api/collections` | `knowledge.use`; creating needs `create`, people only |
| `GET /api/collections/others` | organization owners |
| `GET /api/collections/:id`; `PATCH` (settings), `DELETE`, `POST …/transfer` | Viewer; Admin, Owner (or an organization owner for delete and turning keep-ready off), Owner; browser only |
| `GET …/sharing`, `PUT …/sharing/general`, `PUT\|DELETE …/sharing/:type/:principalId`, `GET /api/members?q=` | Viewer to read, Admin to change; browser only |
| `POST …/preflight`, `PUT …/uploads/:fileId`, `POST …/imports`, `POST …/notes`, `POST …/web-pages`, `PATCH …/sources/:docId` | Editor |
| `GET …/imports/:importId`, `GET …/sources`, `GET …/sources/:docId`, `GET …/facts` (with who checked each), `GET …/history`, `GET …/history/:version/preview` | Viewer |
| `POST …/facts/:factId/check` ("Looks right") | Editor |
| `GET /api/attention` (`?collection=`): files that couldn't be read, values hidden before learning, open reports | `knowledge.collections.edit`; the collections where the caller is Editor or above |
| `DELETE …/sources/:docId` (remove for good) | Admin |
| `POST /api/ask` (site: a written answer with checked citations, or "I won't guess") | Viewer; browser only |
| `POST /api/search` (assistants and API clients: passages and `covered`; 1 to 5 collections) | Viewer |
| `POST …/corrections`, `POST …/history/:version/go-back`, `POST …/history/undo`, `PATCH …/reports/:reportId` | Editor |
| `POST\|GET …/reports` | Viewer |
| `POST …/exports`, `GET …/exports/:exportId` (`?download=1`) | Admin; browser only |
| `GET\|PUT /api/rules`, `POST /api/rules/hiding-preview`, `POST /api/rules/ask-for-more`, `GET /api/usage`, `GET /api/health` | `knowledge.rules.manage`; `PUT` browser only. `GET /api/health` without identity answers `{ status: 'ok' }` |
| `POST /api/scheduled` | the platform's tick only |

## The engine seam

The app checks permissions, collection roles and limits, then calls the engine over `SUGER_ENGINE`
(`src/app/server/engine/`), typed on `engine/src/contract.ts`, naming the organization in `x-knowledge-org`. Anything
that changes answers lives in the engine; D1 holds who may do what, lists and logs, kept in step by the tick from the
engine's outbox. Every change makes a restore point, and changes within 5 minutes of each other share one (undo takes
back both). Without the binding, a development build (`npm run dev`, the AppBuilder's preview) uses the in-memory
engine in `engine/src/stub/` (imported only inside `import.meta.env.DEV`; `scripts/check-no-stub.mjs` fails a build
that contains it), and a production build answers 503 `engine_unavailable`. The local stack and the workerd smoke run
the same stub as a Worker (`engine/src/stub/worker.ts`); its control interface (`/__control/…`) puts a collection
asleep, waking or learning, fails the next import, damages a restore point (`/__control/damage`), records usage or
moves its clock. Unlike the real engine, the in-memory one goes back to a restore point at once rather than about a
minute later.

## Limits and usage reports

The limits are `insulin.limits` in `package.json` (design section 12); operators change defaults and overrides in the
operator console, and the tick pulls them from `/__insulin/limits`. Use is reserved before work with one conditional
statement and settled after, so two requests never pass the same last unit; every way in counts. Keep-ready pauses at
90% of awake hours, Knowledge stops answering at 100% until the 1st, and admins get mail at 80%. Every hour the tick
reports, per organization, exactly these limit keys: `collections`, `documents`, `storage_bytes`, `learned_month`,
`questions_month`, `answers_month`, `awake_hours_month`, `ready_collections`, and `database_bytes` for the app. Counts
and sizes only.

## For developers

```sh
npm ci
npm run dev        # http://localhost:3000, as the preview's organization owner, with the in-memory engine
npm run typecheck
npm test           # vitest: server tests with the in-memory engine, and the screens under jsdom against the same API
NITRO_PRESET=cloudflare_module npm run build
```

From the repository root: `node .github/scripts/check-insulin-app.mjs knowledge` (and `--built` after the build) and
`node .github/scripts/check-public-content.mjs`. Tests need Node 22.22 or later (`node:sqlite`). After changing
`src/app/db/schema.ts`, run `npm run db:generate`.

## License

MIT, like the rest of this repository. Third-party material is listed in [NOTICE](NOTICE).
