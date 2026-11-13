# AGENTS.md

Guidance for AI coding agents (including the Insulin AppBuilder) and for contributors working on Esign. Read it before
changing code. [docs/architecture.md](docs/architecture.md) explains how the app works; this file says what to do and
what never to do.

## The app in brief

Esign is an electronic signature app on the Insulin app template: one npm package, Vite + React + Nitro, deployed as a
Cloudflare Worker with one D1 database. Members send PDFs for signature; recipients sign on a public page after an
emailed one-time code; each signature is hash-chained, and a finished envelope is sealed with Esign's seal key and an RFC 3161
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
| `src/app/member/` | The members' app: `MemberApp.ts` (routes), `Shell.ts` (the two-level navigation), `navigation.ts` (the manifest, role filtering, Settings links, the remembered collapse), `EnvelopesPage.ts`, `EnvelopePage.ts`, `NewEnvelopePage.ts`, `TemplatesPage.ts`, `ContactsPage.ts`, `ContactPage.ts`, `ContactField.ts` (a name or email field suggesting contacts as typed), `SharePanel.ts` (who sees a template or envelope, and sharing it), `TagsField.ts` (the member's own tags), `ListFilters.ts`, `OwnershipPage.ts` (API clients' shares, taking over), `api.ts`, `router.ts` (pushState, no router library) |
| `src/app/pages/docs/`, `src/app/components/Docs.ts` | The in-app Docs: one file per topic, `topics.ts` (reading order), `parts.ts`, and the Docs component |
| `src/app/ui/` | The public pages and their parts: `RecipientPage.ts`, `SigningHelp.ts` ("About signing"), `FieldEditor.ts`, `EditorPage.ts`, `CopyPage.ts`, `CompletionCertificate.ts`, `pdf.ts`, `esign-theme.css` (layout hooks) |
| `src/app/components/ui/`, `src/app/lib/utils.ts`, `src/app/styles.css` | shadcn/ui components (copied, as `.ts`; `sidebar.ts` is the sidebar's class names), `cn()`, and Tailwind with the shadcn neutral theme and sidebar colours, light and dark |
| `nitro.config.ts`, `src/app/server/page-headers.ts`, `page-policy.ts` | The pages' security headers (CSP, framing, referrer, caching), set by a Nitro middleware without touching the platform files |
| `src/app/server/router.ts` | `handleAppRequest(request)`: builds the bindings from `#platform` and hands every `/api/**` request to the Hono app |
| `src/app/server/esign/app.ts` | Management routes, the access middleware, `/api/me`, `/api/catalog`, `/api/process-due`, and the platform's tick `/api/scheduled` |
| `src/app/server/esign/identity.ts` | The platform identity, the two permissions and `can()` |
| `src/app/server/esign/ownership.ts`, `tags.ts`, `members.ts` | Who sees and changes each template and envelope (owners, shares, the one check `documentRole`/`requireRole`/`visibleIds`), each person's own tags, and the members and API clients seen (owners' names, taking over, API clients' shares) |
| `src/app/server/esign/signing-routes.ts`, `editor-routes.ts` | The public signing and editor APIs (`/api/public/*`); the page session travels in `x-esign-session` (`session-header.ts`) |
| `src/app/server/esign/blob-store.ts` | Objects (PDFs, images, seals) as chunked rows in D1 |
| `src/app/server/esign/mail.ts` | Codes and completion notices through the platform's mail relay |
| `src/app/server/gateway-fetch.ts` | The `SUGER_GATEWAY` service binding's fetch, which the relay is called over |
| `src/app/server/esign/seal/` | Evidence manifest, the HMAC test seal, the seal key + TSA seal, and `keys.ts`, the seal keys trusted |
| `src/app/db/` | `schema.ts`, `client.ts`, `migrations/` (generated, plus the custom `0001_triggers.sql` and the hand-written rebuild `0002_seal_key.sql`) |
| `scripts/` | The bitmap atlas generators (macOS, Swift), and `put-seal-key.mjs`, which puts a new seal key on the Worker |
| `test/`, `test/helpers/` | Tests (`node --test`); `helpers/platform.ts` plays the platform, `helpers/gateway.ts` the gateway and a host's service account, `helpers/member.ts` renders the members' app; `navigation.test.ts` and `shell.test.ts` cover the navigation |

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
   their triggers. Custom migrations are for developers: one statement per breakpoint, each safe to run again. The one
   exception, `0002_seal_key.sql`, rebuilds `seals` (no triggers, nothing references it) to change a CHECK constraint, which
   drizzle-kit can't: it is written by hand in drizzle-kit's table-rebuild form with its snapshot, and `npm run db:generate`
   still writes nothing.

## Secrets

`insulin.secrets` declares them (`ESIGN_` prefix, at most 30): the code pepper and the origins that may embed the
pages. What a seal is verified against (seal keys, the timestamp authority) is in the code, never a secret. The HMAC
test seal exists only in the local preview.

The managed seal's private key is not among them and never in GitHub: it is the Worker's `ESIGN_SEAL_KEY` binding,
a Cloudflare `secret_key` (`scripts/put-seal-key.mjs`). Never add it to `insulin.secrets`: the deploy would overwrite
it with a text secret, which can't seal. Which keys a seal may be verified with is `seal/keys.ts`, in the source and
reviewed, never configuration; never remove an entry from it, or the seals it made stop verifying.

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

## Navigation

Every Insulin app has the two-level, collapsible navigation of
[DESIGN.md §3.2](../.github/hosting/DESIGN.md): the organization switcher, its sections from `insulin.navigation` in
`package.json`, then Docs and Settings (People, Integrations, API access, Connect AI, which link to the gateway's pages),
and the person at the bottom; each level collapses to icons. In Esign:

- **The manifest is `package.json` `insulin.navigation`**, which the gateway renders Esign's settings pages from too:
  Envelopes (its level 2: All envelopes, New envelope for EDITOR and up, and a view per status, `/envelopes?status=…`)
  and Templates. Keep it to DESIGN.md's rules (`navigationProblems` in `src/app/member/navigation.ts`, which
  `test/navigation.test.ts` runs): a unique `key` of `[a-z0-9-]`, a `label` of 1 to 40 characters, an `icon` from the
  gateway's Lucide set (`ICON_NAMES`), a `path` the members' app routes and that isn't the gateway's (`/__insulin/*`,
  `/settings/*`, `/mcp`, `/.well-known/*`), optional `group` and `role` (the least app role that sees it), at most 12
  items and 12 children. A new section needs its route in `MemberApp.ts`. Docs and Settings aren't in the manifest.
- **`src/app/member/Shell.ts` draws it** around every member page, with the breadcrumb in the page header; signers'
  public pages (`/sign`, `/editor/page/:id`, `/copy`) have none. The root carries `data-insulin-shell`.
- **Settings stays on the apex**: People, Integrations, API access and Connect AI link to the pages `/__insulin/me`
  gives, else `https://<apex>/apps/esign/settings/{users,integrations,api,connect-ai}`; where the gateway doesn't
  answer, Settings lists them without links. Never build those pages, or a page at `/settings/*`, in the app.
- **The platform's controls** (switching organization, Account, Sign out) come from the gateway's `/__insulin/me`,
  `/__insulin/switch-org` and `/__insulin/logout`, and show only where the gateway answers; elsewhere (the local
  preview, the console) level 1 shows Esign's name and the person from `/api/me`.
- **Collapsing** is remembered per browser in localStorage `insulin-nav` (`{"l1":"collapsed"|"expanded","l2":…}`),
  written only when someone collapses or expands a level. Below 768px a menu button opens both levels in a drawer.
- **Accessibility**: `<nav aria-label="Primary">` and `<nav aria-label="Section">`, `aria-current` on the active item,
  toggles with `aria-expanded` and `aria-controls`, a collapsed item's label as its `title` and `aria-label`, a visible
  focus ring, and everything reachable from the keyboard.

## Public repository

This code is public. Use synthetic data only: example.com or `.test` addresses and fictional people and companies.
Never add real names, addresses, cloud account ids, keys or internal hostnames.

## User-facing text

Plain language: no internal codes, table names or status enums on the signing page. The product is called "Esign".
Explain what blocks an action and what to do next. Describe what the app does now.
