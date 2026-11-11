# AGENTS.md

Guidance for AI coding agents (including the Insulin AppBuilder) and for contributors working on Esign. Read it before
changing code. [docs/architecture.md](docs/architecture.md) explains how the app works; this file says what to do and
what never to do.

## The app in brief

Esign is an electronic signature app on the Insulin app template: one npm package, Vite + React + Nitro, deployed as a
Cloudflare Worker with one D1 database. Members send PDFs for signature; recipients sign on a public page after an
emailed one-time code; each signature is hash-chained, and a finished envelope is sealed with AWS KMS and an RFC 3161
timestamp. Users, roles and permissions come from the Insulin platform; the organization is the tenant.

## Commands

Run from `esign/` unless noted.

| When | Run |
|---|---|
| After any TypeScript change | `npm run typecheck` (the source and the test helpers; tests run with Node's type stripping, which can't run JSX, so the UI is `.ts` with `React.createElement`; only `App.tsx` is TSX) |
| Before you finish, and after every behaviour change | `npm test` |
| After changing `src/app/db/schema.ts` | `npm run db:generate` |
| To check what publishing will build | `NITRO_PRESET=cloudflare_module npm run build` |
| To try it | `npm run dev` (port 3000; you are a preview Owner) |
| From the repository root, before you finish | `node .github/scripts/check-insulin-app.mjs esign` and `node .github/scripts/check-public-content.mjs` |

## Where things live

| Path | What |
|---|---|
| `src/app/App.tsx` | The pages: `/sign` (signing), `/editor/page/:id` (embedded editor), `/copy` (a signer's copy), and every other path the members' app |
| `src/app/member/` | The members' app: `MemberApp.ts` (header, navigation, routes), `EnvelopesPage.ts`, `EnvelopePage.ts`, `NewEnvelopePage.ts`, `TemplatesPage.ts`, `api.ts`, `router.ts` (pushState, no router library) |
| `src/app/pages/docs/`, `src/app/components/Docs.ts` | The in-app Docs: one file per topic, `topics.ts` (reading order), `parts.ts`, and the Docs component |
| `src/app/ui/` | The public pages and their parts: `RecipientPage.ts`, `SigningHelp.ts` ("About signing"), `FieldEditor.ts`, `EditorPage.ts`, `CopyPage.ts`, `CompletionCertificate.ts`, `pdf.ts`, `esign-theme.css` (layout hooks) |
| `src/app/components/ui/`, `src/app/lib/utils.ts`, `src/app/styles.css` | shadcn/ui components (copied, as `.ts`), `cn()`, and Tailwind with the shadcn neutral theme, light and dark |
| `nitro.config.ts`, `src/app/server/page-headers.ts`, `page-policy.ts` | The pages' security headers (CSP, framing, referrer, caching), set by a Nitro middleware without touching the platform files |
| `src/app/server/router.ts` | `handleAppRequest(request)`: builds the bindings from `#platform` and hands every `/api/**` request to the Hono app |
| `src/app/server/esign/app.ts` | Management routes, the access middleware, `/api/me`, `/api/catalog`, `/api/process-due`, and the platform's tick `/api/scheduled` |
| `src/app/server/esign/identity.ts` | The platform identity, the two permissions and `can()` |
| `src/app/server/esign/signing-routes.ts`, `editor-routes.ts` | The public signing and editor APIs (`/api/public/*`); the page session travels in `x-esign-session` (`session-header.ts`) |
| `src/app/server/esign/blob-store.ts` | Objects (PDFs, images, seals) as chunked rows in D1 |
| `src/app/server/esign/mail.ts` | Codes and completion notices through the platform's mail relay |
| `src/app/server/gateway-fetch.ts` | The `SUGER_GATEWAY` service binding's fetch, which the relay is called over |
| `src/app/server/esign/seal/` | Evidence manifest, the HMAC test seal, the KMS + TSA seal |
| `src/app/db/` | `schema.ts`, `client.ts`, `migrations/` (generated, plus the custom `0001_triggers.sql`) |
| `scripts/` | The bitmap atlas generators (macOS, Swift) |
| `test/`, `test/helpers/` | Tests (`node --test`); `helpers/platform.ts` plays the platform, `helpers/gateway.ts` the gateway and a host's service account, `helpers/member.ts` renders the members' app |

## Platform files: leave them alone

`index.html`, `src/main.tsx`, `src/api.ts`, `src/platform.local.ts`, `src/platform.worker.ts`, `src/local-d1.ts`,
`src/cloudflare-workers.d.ts`, `src/suger-app-builder-runtime.tsx`, `vite.config.ts` and `drizzle.config.ts` come from
the Insulin template and stay byte-identical to it (`test/framework-template.test.ts` pins the ones under `src/`). All
app code goes under `src/app/`; `nitro.config.ts` (the page-headers middleware) and `postcss.config.mjs` (Tailwind) are
the app's own. Keep the export of `handleAppRequest` in `src/app/server/router.ts`; import
`@fours/app/server` only from server code; read configuration with `readAppEnv(name)` from `#platform`. Never put a
secret in source.

## Platform limits

- **Runtime:** one D1 database, static assets, outbound `fetch` and environment values. No cron, R2, KV, Queues,
  Durable Objects or email binding: objects live in D1 (`blob-store.ts`), mail goes through the relay (`mail.ts`), and
  due work runs in requests, on the platform's five-minute tick (`insulin.scheduled`, `POST /api/scheduled`) and with
  `POST /api/process-due`.
- **The members' app runs in a sandboxed iframe in the console:** no `window.open`, `alert`, `confirm`, `prompt` or
  top-level navigation (it moves with `history.pushState`); downloads use `<a download>`; no fonts, scripts or images
  from CDNs.
- **Stored source:** at most 2,000 files, 1 MiB each and 10 MiB in total, UTF-8 text only. Binary fixtures are base64
  in JSON (`test/fixtures/digicert-tsa-2026-11-06/fixture.json`); build PDFs in code.
- **Dependencies:** exact versions from registry.npmjs.org, pure JavaScript, no install scripts.

## Access

- **Two permissions**, declared in `package.json` `insulin.permissions` and listed in `identity.ts`: `esign.manage`
  (Owner, Admin, Editor) and `esign.view` (every role). Reading needs `esign.view`, every change `esign.manage`.
  Decide by permission with `can()`, never by role name. `x-suger-app-permissions` narrows a role, never widens it.
- **The organization is the tenant.** Every query that reads or changes an organization's record names its
  `tenant_id`, from `getCurrentUser().organizationId`. Another organization's ids answer 404.
- **Public paths** (`insulin.publicPaths`): `/sign`, `/editor/`, `/copy`, `/assets/`, `/api/public/`. They carry a
  one-time code or token, never an identity; a request the gateway marks public never reaches a management route.
  At most 10, and never `/`, `/api`, `/settings*`, `/mcp*`, `/.well-known*` or `/__insulin*`.
- **Embedding:** the pages report every origin that frames them (`ancestorOrigins`) at their code exchange, and the
  exchange refuses any that is neither the app nor in `ESIGN_FRAME_ANCESTORS` (the session's parent for the editor).
  Behind the gateway, the pages' CSP `frame-ancestors` says the same; member pages can't be framed.
- **The tick** (`insulin.scheduled`: `/api/scheduled`): the gateway POSTs there every five minutes with only
  `x-suger-app-id` and `x-suger-access-via: schedule`. The route refuses (403) anything else, a member's or service
  account's identity included, and runs every organization's due work; `readCaller` treats a request marked
  `schedule` as nobody, so it never reaches a management route. Keep it off the public paths and out of the catalog.
- **Page sessions** travel in the `x-esign-session` header, never `Authorization` (the gateway drops it on public
  paths) and never an `x-suger-*` name (the gateway strips those). `helpers/gateway.ts` behaves the same way.
- **No login of our own.** The preview Owner exists only in the local preview.

## Evidence and storage

1. **Signatures and the audit trail are append-only.** Triggers refuse changes to a signature's facts, a rendered
   signature, a task's recipient email and any audit event. Never weaken them.
2. **Never change canonical JSON, the hash chain, the atlases or the seal formats** (`canonical-json.ts`,
   `signatures.ts`, `fonts/`, `seal/`): stored signatures and seals would stop verifying.
3. **Objects are written once.** Seals and initial documents use the create-only put; a retry reuses what is stored.
4. **One batch per write**, guarded by the statement itself (`INSERT ... SELECT ... WHERE`); see "How writes commit".
5. **Migrations are generated.** Edit `schema.ts` and run `npm run db:generate`; never edit a published migration.
   Tables with triggers (`signatures`, `tasks`, `audit_events`) take additive changes only: a table rebuild drops
   their triggers. Custom migrations are for developers: one statement per breakpoint, each safe to run again.

## Secrets

`insulin.secrets` declares them (`ESIGN_` prefix, at most 30): the code pepper, the origins that may embed the pages,
and the KMS, AWS and TSA settings of the managed seal. The HMAC test seal exists only in the local preview.

## Docs, required by default

Every Insulin app ships a **Docs** entry in its navigation:

- every role can open it, recipients and people who haven't finished setup included;
- it covers getting started, the main tasks, what each kind of user sees, and the background a business user needs for
  electronic signatures, plus a glossary;
- the pages are static content inside the app, in plain words, and describe only what the app actually does. Legal
  background is labelled general information, not advice;
- a change that alters behaviour updates the Docs topic that describes it in the same change;
- tests cover the Docs entry for each role and every topic rendering.

Esign's Docs are `src/app/pages/docs/` and `src/app/components/Docs.ts`, tested in `test/docs.test.ts`; the signing
page's "About signing" panel is `src/app/ui/SigningHelp.ts`. Cap Table is the reference: `captable/src/app/pages/docs/`
and `captable/src/app/components/Docs.tsx` (Esign's are `.ts` for the reason under Commands).

The public docs at `https://insulinapps.com/docs/esign/` are `docs/public/*.md` (front matter `title`, `description`,
`order`), for people and AI agents; update the page that describes a behaviour in the same change, then run
`npm run build:docs` in `.github/hosting/gateway/` and commit its `src/assets/docs-content.ts`.

## UI

New UI uses [shadcn/ui](https://ui.shadcn.com) components and its default neutral theme, light and dark: the components
in `src/app/components/ui/` (add one by copying it from shadcn/ui into `.ts`, and record it in `NOTICE`), `cn()` from
`src/app/lib/utils.ts`, icons from `lucide-react`. No CDNs.

## Public repository

This code is public. Use synthetic data only: example.com or `.test` addresses and fictional people and companies.
Never add real names, addresses, cloud account ids, keys or internal hostnames.

## User-facing text

Plain language: no internal codes, table names or status enums on the signing page. The product is called "Esign".
Explain what blocks an action and what to do next. Describe what the app does now.
