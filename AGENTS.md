# AGENTS.md

This repository holds open-source Insulin apps, one per top-level directory (today: `captable/` and `esign/`). These rules apply to
every app. Each app also has its own `AGENTS.md` with app-specific rules; read both before changing anything.

## Every app

1. **Insulin app layout.** One ordinary npm project (Vite, React and Nitro, with Drizzle on D1) that the Insulin
   AppBuilder can change, preview and publish. `node .github/scripts/check-insulin-app.mjs <app>` must pass, and with
   `--built` after `NITRO_PRESET=cloudflare_module npm run build`.
2. **In-app Docs, required by default.** Every app ships a **Docs** entry in its navigation:
   - every role can open it, people who only view their own data and people who haven't finished setup included;
   - it covers getting started, the main tasks, what each kind of user sees, and the background a business user needs
     for the app's domain (for Cap Table: equity and cap tables), plus a glossary where the domain has jargon;
   - the pages are static content inside the app (no fetching from elsewhere), in plain words, and describe only what
     the app actually does. Legal, tax or financial background is labelled general information, not advice;
   - a change that alters behaviour updates the Docs topic that describes it in the same change;
   - tests cover the Docs entry for each role and every topic rendering.

   Cap Table is the reference: `captable/src/app/pages/docs/` and `captable/src/app/components/Docs.tsx`. Repeat this
   rule in the app's own `AGENTS.md`, because the Insulin console copies only the app's directory into a new app.

   **Public docs, too.** An app's public documentation at `https://insulinapps.com/docs/<app>/` lives in
   `<app>/docs/public/`, one Markdown page per topic with front matter (`title`, `description`, `order`), written for
   people and AI agents: what the app does, setting it up, the main tasks, what each role sees, its API (as
   `GET /api/catalog` publishes it) and its domain background, labelled general information, not advice. It is updated
   in the same change as the behaviour it describes, like the in-app Docs, with synthetic data only. Then run
   `npm run build:docs` in `.github/hosting/gateway/` and commit the regenerated `src/assets/docs-content.ts`
   (`npm run check:docs` fails while it is stale). The platform's own pages are in `.github/hosting/docs/`; the format
   is in the gateway's README under "The public docs".
3. **UI.** New UI uses [shadcn/ui](https://ui.shadcn.com) components and its default theme (the hosting gateway in
   `.github/hosting/gateway/` follows it). Apps that already have their own design keep it until they are restyled.
4. **Public repository.** Synthetic data only (example.com or `.test` addresses, fictional people and companies), in
   code, tests, fixtures and docs. No secrets, account ids or internal hostnames.
5. **Accounts, roles and access belong to the platform.** The rules below follow from the design in
   [`.github/hosting/DESIGN.md`](.github/hosting/DESIGN.md); repeat the ones that shape app code in the app's own
   `AGENTS.md`.

## Accounts, roles and access

**One place signs people in.** Sign-up, sign-in, MFA, Google and enterprise SSO (SAML, OIDC, SCIM), OAuth for AI agents
(MCP) and for API clients (service accounts) all live at `https://insulinapps.com/`, in the gateway
(`.github/hosting/gateway/`). An app never adds sign-in screens, sessions, passwords, cookies or OAuth endpoints of its
own: it reads who is calling with `getCurrentUser(request)` from `@fours/app/server`.

**People and roles are managed in one place.** An organization's people, roles and custom roles are at
`insulinapps.com/settings/users` and `/settings/roles`; each app's settings are under
`insulinapps.com/apps/<app>/settings/`: `users` (people), `integrations` (stored credentials), `api` (API access: OAuth
clients) and `connect-ai` (Connect AI), which the same paths on `<app>.insulinapps.com` (`/settings/users`,
`/settings/integrations`, `/settings/api`, `/settings/connect-ai`) redirect to. They are on the apex so that code an
app serves can never read them or post their forms. Apps don't build their own people, role, integration, API client
or AI agent management.

**Roles.** Each member has one organization role or access to specific apps, never both:

| Organization role | Manages people and roles | In every app |
|---|---|---|
| Owner | everyone, owners too; custom roles; SSO and SCIM | Admin |
| Admin | everyone but owners; gives custom roles | Admin |
| Editor | nothing (can see the people and roles) | Editor |
| Viewer | nothing (can see the people and roles) | Viewer |
| Specific apps | in an app where they are Admin, that app's people | their role per app: Admin, Editor, Viewer or a custom role |

**What an app receives and must do.** Every request carries `x-suger-app-role` (`ADMIN`, `EDITOR` or `VIEWER`; the
Insulin console may still send `OWNER`, treated as `ADMIN`, and `USER`, treated as `VIEWER`), `x-suger-app-permissions`
and `x-suger-access-via`.

- **Admin** can do everything in the app. **Editor** can use every function except people, roles, permissions and
  integrations. **Viewer** is read only, and the app decides what reading shows (Cap Table shows a Viewer their own
  holdings).
- **Custom roles need a permission catalog.** An app that wants them declares `insulin.permissions` in its
  `package.json`: entries `{ key, label, description, role }`, where `role` is the least built-in role that has the
  permission. Each route and command then checks permissions, not role names.
- **Permissions only narrow.** Effective permissions are the role's permissions intersected with
  `x-suger-app-permissions`, and a missing header means the role's full set. Read both headers through one helper, as
  Cap Table does in `src/app/server/lib/identity.ts`.
- **Enforce on the server.** Hiding a button isn't access control.

**AI agents and API clients.** Each app is its own MCP server at `https://<app>.insulinapps.com/mcp`, with its own OAuth
client registration per agent, and API clients (OAuth clients, stored as service accounts) call
`https://<app>.insulinapps.com/api/...` with a client-credentials token.

- **Connect AI.** Every app's Connect AI page (`insulinapps.com/apps/<app>/settings/connect-ai`, open to everyone who
  can use the app) gives the MCP server and the setup for Claude Code, Codex, Gemini CLI, opencode, Claude.ai and
  ChatGPT, and lists the person's agents; the organization's owners and admins see and disconnect everyone's there.
- **API clients are the organization's.** Only the organization's Owners and Admins create, rename, change the role of,
  rotate and delete an app's OAuth clients, on its API access page (`/apps/<app>/settings/api`); an app's Admins by
  grant can't. Everyone who can use the app sees the list, never a secret. Rotating keeps the previous secret valid for
  24 hours. Stored credentials stay with the app's admins, on the integrations page.
- **Same role as the person.** An agent acts with its person's current role; an API client has the role an owner or
  admin gave it. The app sees the same headers as for a browser, with `x-suger-access-via: mcp` or `api`, and a
  `User-Agent` naming the client (`Insulin Apps MCP: <client>` or `Insulin Apps API: <account>`) for its audit trail.
- **Every API serves agents and clients alike**, under the same rules as the browser. The exception: mutations of
  people, roles, billing and integrations. They stay browser-only and owner- or admin-only; if an app implements any of
  them, it refuses unless `x-suger-access-via` is `browser`.
- **Publish your API** at `GET /api/catalog` (`{ endpoints: [{ method, path, summary, query, body, idempotencyKey }] }`,
  only what the caller may use) so the MCP `endpoints` tool can show it, and keep it in step with the routes.
- **Paths the gateway keeps on an app host.** Tokens reach only `/api/*`, never `/api/__suger/*`. Don't use these paths
  in an app: `/__insulin/*`, `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`
  (the gateway redirects them to the apex), `/mcp`, `/.well-known/oauth-*`.

**Outside services.** Credentials for outside APIs are stored by the platform on the app's integrations page. Call the
service with `integrationFetch(key)` from `@fours/app/server`, passing the request's `x-suger-organization-id`; never
keep such secrets in the app's database or source.

**Beyond D1** (`.github/hosting/DESIGN.md` §8). An app gets one D1 database and static assets, nothing else. It asks
the platform for the rest in `package.json` under `insulin`:

- **Public paths** (`insulin.publicPaths`) are only for people who have no account, such as an e-sign recipient. The
  gateway forwards them with no identity (`x-suger-access-via: public`), so the app authenticates them with its own
  short-lived codes and lets them reach only what those codes are for. Never use one to skip sign-in for members.
- **Mail** goes through the gateway's relay: `POST` to `SUGER_MAIL_URL` with `SUGER_APP_TOKEN` and the request's
  `x-suger-organization-id`, one message at a time. There is no e-mail binding.
- **Runtime secrets** are names in `insulin.secrets`, each starting with the app's name in upper case (`ESIGN_…`). The
  deploy copies them from the GitHub environment, and the app reads them with `readAppEnv(name)`; never put a value in
  source.
- **Scheduled work** gets a five-minute tick instead of a cron: declare one path in `insulin.scheduled` (under `/api/`,
  never one of the public paths), and the gateway POSTs to it every five minutes with only `x-suger-app-id` and
  `x-suger-access-via: schedule`, an empty body and a 25-second timeout. Refuse the route unless `x-suger-access-via` is
  exactly `schedule` and no identity is present, treat a request marked `schedule` as nobody on every other route,
  keep it out of `/api/catalog`, and do every organization's due work there, idempotent and bounded per tick.

**One deployment, many organizations.** Scope every query by `getCurrentUser().organizationId`, so one organization
never reads another's data.

## A new app

- A top-level directory with `README.md`, `AGENTS.md` (including the Docs rule and the access rules above), `NOTICE`
  when it bundles third-party material, the in-app Docs, and its public docs in `docs/public/` (the docs build fails
  for an app without them).
- Its roles mapped to the app's functions (what Admin, Editor and Viewer may do there), a permission catalog in
  `package.json` if it should support custom roles, and `GET /api/catalog` for AI agents.
- A row in the app table of the root `README.md`.
- A `.github/workflows/<app>.yml` file copied from `captable.yml`, with its name, paths and `app` input changed, and
  that name added to the `workflows` list in `.github/workflows/release.yml`. The shared pipeline runs its typecheck,
  tests, migration check and Cloudflare build.

## Releases

`.github/workflows/release.yml` makes every green push to `main` a release: it tags the commit `v0.1.1`, `v0.1.2`, …
and publishes its GitHub Release (the root README's "Releases"). Never create, move or delete a `v*` tag, or publish
or edit one of those releases, by hand or from another workflow. A workflow that runs on a push to `main` must be in
release.yml's `workflow_run` list; `node .github/scripts/check-app-workflows.mjs` checks it.

## Before you finish

From the app's directory: `npm run typecheck`, `npm test` and `npm run build`. From the repository root:
`node .github/scripts/check-insulin-app.mjs <app>` and `node .github/scripts/check-public-content.mjs`.
