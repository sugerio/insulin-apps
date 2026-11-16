# AGENTS.md

Guidance for AI coding agents and contributors working on Knowledge. Read it, and the repository's root `AGENTS.md`,
before changing code. [README.md](README.md) explains what the app does and its API.

## The app in brief

Insulin Knowledge keeps a team's files, web pages and notes in collections that people and their AI assistants ask,
with answers that cite their sources or say "I won't guess". It is an Insulin app (one npm package, Vite + React +
Nitro + Hono, one D1 database) that owns an **engine**: a second Worker in `engine/`, reached only over the
`SUGER_ENGINE` service binding (`.github/hosting/DESIGN.md` §12.1). Users, roles and permissions come from the Insulin
platform; the organization is the tenant.

## Commands

Run from `knowledge/` unless noted.

| When | Run |
|---|---|
| After any TypeScript change | `npm run typecheck` |
| Before you finish, and after every behaviour change | `npm test` (Node 22.22 or later: the tests use `node:sqlite`) |
| After changing `src/app/db/schema.ts` | `npm run db:generate` (CI fails if `drizzle-kit generate` would write anything) |
| To check what publishing will build | `NITRO_PRESET=cloudflare_module npm run build` (it ends with `scripts/check-no-stub.mjs`) |
| To try it | `npm run dev` (port 3000; you are the preview organization's owner, with the in-memory engine). As someone else: `SUGER_ACCESS_MODE=console SUGER_TRUST_ORG_ROLE=1 npm run dev` and send the `x-suger-*` identity headers (test/support/harness.ts `headersOf`) |
| From the repository root, before you finish | `node .github/scripts/check-insulin-app.mjs knowledge` and `node .github/scripts/check-public-content.mjs` |

## Where things live

| Path | What |
|---|---|
| `src/app/App.tsx`, `src/app/navigation.ts`, `src/app/session.tsx` | The routes, the navigation manifest's items, who is signed in and their collections |
| `src/app/components/` | The shell (`Shell.tsx`: the two-level navigation), shared screen parts (answers, the source viewer, learning progress, sharing, the awake-hours pop-up) and shadcn/ui in `ui/` |
| `src/app/pages/` | The screens (`collection/` for a collection's tabs) and the in-app Docs (`DocsPage.tsx`, `docs/`) |
| `src/app/lib/` | The API client (`api.ts`), the response types, plain-word formatting, the platform account |
| `src/app/server/router.ts` | `handleAppRequest(request)`: the bindings from `#platform` and the request, then the Hono app |
| `src/app/server/app.ts` | Identity middleware, `/api/me`, `/api/catalog`, the tick `/api/scheduled`, the routes, errors in plain words |
| `src/app/server/identity.ts` | The platform identity, the permission catalog, `can()`, `isOrgOwner()`, `isScheduleTick()` |
| `src/app/server/access.ts` | Collection roles, the Viewer cap and `authorize(caller, id, action)`: the matrix of design section 08 |
| `src/app/server/routes/` | Collections, sharing, sources (preflight, uploads, imports, notes, web pages), asking, knowledge (facts, "Looks right", corrections, reports), history and export, rules, Needs attention |
| `src/app/server/ask.ts` | Asking: collections named (1 to 5), limits, the engine's search, writers, the citation check, gaps |
| `src/app/server/limits.ts`, `limits-sync.ts` | Limits, reservations and the pull from `/__insulin/limits` |
| `src/app/server/members.ts` | The members cache, the member lookup, member status, member events and the resync after 410 |
| `src/app/server/outbox.ts` | The engine's outbox applied to D1 once per event |
| `src/app/server/tick.ts`, `usage-metrics.ts` | The five-minute tick and the hourly usage report |
| `src/app/server/mail.ts`, `platform-api.ts`, `gateway-fetch.ts` | Mail through the relay, and the platform's endpoints over `SUGER_GATEWAY` |
| `src/app/server/hiding.ts` | The hiding detectors of the "Try it" box: byte-identical to `engine/src/stub/hiding.ts` (a test checks) |
| `src/app/server/engine/` | The engine client (`client.ts`, typed on `engine/src/contract.ts`) and `engineOf(request)` |
| `src/app/db/` | `schema.ts`, `client.ts`, `migrations/` (generated) |
| `engine/src/stub/` | The in-memory engine (`engine.ts`), its control interface (`control.ts`) and its Worker (`worker.ts`) |
| `engine/` (the rest) | The real engine: its own package, Wrangler config and container, described in its README |
| `test/` | `server/` (routes, the access matrix, limits, the tick), `engine/` (the stub against the contract), `db/`, `web/` (the screens against the real API: `web/support/live.tsx`); `support/harness.ts` plays the platform and the gateway |

## Platform files: leave them alone

`index.html`, `src/main.tsx`, `src/api.ts`, `src/platform.local.ts`, `src/platform.worker.ts`, `src/local-d1.ts`,
`src/cloudflare-workers.d.ts`, `src/suger-app-builder-runtime.tsx`, `vite.config.ts` and `drizzle.config.ts` come from
the Insulin template and stay byte-identical to it (`test/server/framework-template.test.ts` pins them). App code goes
under `src/app/`. Keep the export of `handleAppRequest`; import `@fours/app/server` only from server code; read
configuration with `readAppEnv(name)` from `#platform`. Never put a secret in source.

## Accounts, roles and access

These follow the root `AGENTS.md` and DESIGN.md §2, §4, §12.3 and §12.4.

- **One place signs people in.** Never add sign-in, sessions or OAuth. Read who calls with `readCaller` (identity.ts),
  the one place that reads `getCurrentUser` and the `x-suger-*` headers.
- **Permissions only narrow.** Effective permissions are the role's intersected with `x-suger-app-permissions`.
  Decide by permission with `can()`, never by role name.
- **The organization role** (`x-suger-org-role`) is honoured only when the deploy sets `SUGER_TRUST_ORG_ROLE`, and
  only for people. It gives organization owners two powers and nothing else: the basic information of every
  collection, and deleting one at a time.
- **Resource roles.** Every collection route calls `authorize(caller, id, action)` (access.ts): the collection role
  from owner, general access (up to Editor) and shares by name, highest wins; API clients only by name; then the
  Viewer cap (without `knowledge.collections.edit` every role acts as Viewer); then the action's own permission. An
  app role opens no collection by itself: an Admin in Knowledge without a collection role gets 403 on content.
- **Browser-only:** sharing, settings, export, transfer, delete and Rules and data changes refuse anything but
  `x-suger-access-via: browser` with 403 `browser_only`, and are never listed in the catalog for assistants or API
  clients. One switch per collection turns assistants and API clients off (403 `assistants_off`).
- **The organization is the tenant.** Every query names `org_id`. Another organization's ids answer 404, exactly as an
  unknown id; a collection of the caller's organization without a role answers 403.
- **Leaving and returning:** shares go on hold and come back; ownership moves to the longest-standing organization
  owner when an owner leaves or becomes a Viewer (members.ts). Say so in the Docs when it changes.
- **Every API serves assistants and clients alike**, under the same checks. Keep `GET /api/catalog` in step with the
  routes (`test/server/catalog.test.ts` fails otherwise). Searches name 1 to 5 collections (400 `collection_required`,
  `too_many_collections`).
- **The tick** (`POST /api/scheduled`) refuses anything but the platform's own (`isScheduleTick`); a request marked
  `schedule` is nobody everywhere else. Each step is bounded and safe to repeat.

## The engine seam

- The app checks permissions, roles and limits **before** calling the engine; the engine trusts its binding. Every
  call names the organization (`x-knowledge-org`), through `EngineClient` only.
- `engine/src/contract.ts` is fixed: change a shape only together with the real engine, the in-memory one and the
  client.
- Anything that changes answers (sources, corrections, outdated marks) lives in the engine; D1 holds who may do what,
  lists and logs. Going back never changes sharing.
- Every change makes a restore point; changes within 5 minutes of each other share one, and undo takes back both. A
  test that needs separate restore points moves the clock 6 minutes between changes.
- The in-memory engine goes back at once (the real one takes about a minute); its control interface (`control.ts`)
  also damages a restore point (`/__control/damage`), for "not restorable: damaged".
- The in-memory engine is for development and tests only: import it only inside `import.meta.env.DEV`
  (`engine/index.ts`) or from tests. `scripts/check-no-stub.mjs` fails a production build that contains it.
- Engine errors never reach a person raw: `app.ts` turns them into plain words; the raw text goes to the log.

## Limits

Limits are `insulin.limits` (a test keeps `LIMITS` in limits.ts equal to it). Reserve before work with `reserve()`
(one conditional statement per key), settle after, release on failure; every way in counts. Messages name Insulin
Apps support from `SUGER_SUPPORT_EMAIL`, never an address in the source. The usage report sends exactly the limit
keys that measure use plus `database_bytes`: a new gauge is a change to the Docs too.

## Docs, required by default

Every Insulin app ships a **Docs** entry in its navigation:

- every role can open it, people who haven't started a collection included;
- it covers getting started, the main tasks (collections, sources, asking, fixing, sharing, history), what each role
  sees, your data and the numbers Knowledge reports, plus a glossary of its words (collection, source, fact, restore
  point…);
- the pages are static content inside the app, in plain words, and describe only what the app actually does;
- a change that alters behaviour updates the Docs topic that describes it in the same change;
- tests cover the Docs entry for each role and every topic rendering.

Cap Table is the reference: `captable/src/app/pages/docs/` and `captable/src/app/components/Docs.tsx`. The public docs
at `https://insulinapps.com/docs/knowledge/` are `docs/public/*.md` (front matter `title`, `description`, `order`);
update the page that describes a behaviour in the same change, then run `npm run build:docs` in
`.github/hosting/gateway/` and commit its `src/assets/docs-content.ts`.

## UI and navigation

New UI uses [shadcn/ui](https://ui.shadcn.com) and its default neutral theme (`components.json`, `src/app/app.css`),
`cn()` from `src/app/lib/utils.ts`, icons from `lucide-react`; no CDNs. Record copied third-party material in `NOTICE`.

Every Insulin app has the two-level, collapsible navigation of [DESIGN.md §3.2](../.github/hosting/DESIGN.md): the
organization switcher, its sections from `insulin.navigation` in `package.json` (Home, Collections, Needs attention;
Rules and data and Health for admins), then Docs and Settings (People, Integrations, API access, Connect AI, which
link to the gateway's pages), and the person at the bottom; each level collapses to icons. Level 2 under Collections
lists the person's collections, drawn by the app. Never build pages at `/settings/*`, `/__insulin/*`, `/mcp` or
`/.well-known/*`.

## Public repository

This code is public. Use synthetic data only: example.com or `.test` addresses and fictional people and companies.
Never add real names, addresses, cloud account ids, keys, image digests or internal hostnames. Test secrets that look
real (API keys, card numbers) are assembled at run time so the public-content check never sees one whole.

## User-facing text

Plain words; the product is "Insulin Knowledge" and the unit is a "collection". Never say knowledge base, index,
chunk, vector, embedding, snapshot or container on a business screen. Every error says what happened and what to do.
