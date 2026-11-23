# AGENTS.md

This repository holds open-source Insulin apps, one per top-level directory (today: `captable/`, `esign/` and
`knowledge/`). These rules apply to every app. Each app also has its own `AGENTS.md` with app-specific rules; read
both before changing anything.

## Every app

1. **Insulin app layout.** One ordinary npm project (Vite, React and Nitro, with Drizzle on D1) that the Insulin
   AppBuilder can change, preview and publish. `node .github/scripts/check-insulin-app.mjs <app>` must pass, and with
   `--built` after `NITRO_PRESET=cloudflare_module npm run build`. An app's engine, if it has one, is a second package
   in its own directory, checked by rules of its own (below, "Beyond D1").
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

   **Public docs, too.** An app's public documentation at `https://insulin-apps.com/docs/<app>/` lives in
   `<app>/docs/public/`, one Markdown page per topic with front matter (`title`, `description`, `order`), written for
   people and AI agents: what the app does, setting it up, the main tasks, what each role sees, its API (as
   `GET /api/catalog` publishes it) and its domain background, labelled general information, not advice. It is updated
   in the same change as the behaviour it describes, like the in-app Docs, with synthetic data only. Then run
   `npm run build:docs` in `.github/hosting/gateway/` and commit the regenerated `src/assets/docs-content.ts`
   (`npm run check:docs` fails while it is stale), which also rebuilds the docs' search: the pages are open to search
   engines and AI crawlers (`robots.txt`, `sitemap.xml`, `llms.txt`), searchable at `/docs/search`, and readable by
   agents through the docs' MCP server at `https://insulin-apps.com/docs/mcp`, so headings that name the task help people
   and agents find it. The platform's own pages are in `.github/hosting/docs/`; the format is in the gateway's README
   under "The public docs".
3. **UI.** New UI uses [shadcn/ui](https://ui.shadcn.com) components and its default theme (the hosting gateway in
   `.github/hosting/gateway/` follows it). Apps that already have their own design keep it until they are restyled.
   **Navigation:** every app has the two-level, collapsible navigation of
   [DESIGN.md §3.2](.github/hosting/DESIGN.md): the organization switcher, its sections from `insulin.navigation` in
   `package.json`, then Docs and Settings (People, Integrations, API access, Connect AI, which link to the gateway's
   pages), and the person at the bottom; each level collapses to icons. Repeat this rule in the app's own `AGENTS.md`.
4. **Public repository.** Synthetic data only (example.com or `.test` addresses, fictional people and companies), in
   code, tests, fixtures and docs. No secrets, account ids or internal hostnames.
5. **Accounts, roles and access belong to the platform.** The rules below follow from the design in
   [`.github/hosting/DESIGN.md`](.github/hosting/DESIGN.md); repeat the ones that shape app code in the app's own
   `AGENTS.md`.

## Accounts, roles and access

**One place signs people in.** Sign-up, sign-in, MFA, Google and enterprise SSO (SAML, OIDC, SCIM), OAuth for AI agents
(MCP) and for API clients (service accounts) all live at `https://insulin-apps.com/`, in the gateway
(`.github/hosting/gateway/`). An app never adds sign-in screens, sessions, passwords, cookies or OAuth endpoints of its
own: it reads who is calling with `getCurrentUser(request)` from `@fours/app/server`.

**People and roles are managed in one place.** An organization's people, roles and custom roles are at
`insulin-apps.com/settings/users` and `/settings/roles`; each app's settings are under
`insulin-apps.com/apps/<app>/settings/`: `users` (people), `integrations` (stored credentials), `api` (API access: OAuth
clients) and `connect-ai` (Connect AI), which the same paths on `<app>.insulin-apps.com` (`/settings/users`,
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
and `x-suger-access-via`; a person's (browser and MCP) also `x-suger-org-role` (`OWNER`, `ADMIN`, `EDITOR`, `VIEWER`,
or `APPS` for specific apps), and a browser's `x-suger-member-lookup` (DESIGN.md §2.4).

- **Admin** can do everything in the app, except open records that have roles of their own (below). **Editor** can use
  every function except people, roles, permissions and integrations. **Viewer** is read only, and the app decides what
  reading shows (Cap Table shows a Viewer their own holdings).
- **Custom roles need a permission catalog.** An app that wants them declares `insulin.permissions` in its
  `package.json`: entries `{ key, label, description, role }`, where `role` is the least built-in role that has the
  permission. Each route and command then checks permissions, not role names.
- **Permissions only narrow.** Effective permissions are the role's permissions intersected with
  `x-suger-app-permissions`, and a missing header means the role's full set. Read both headers through one helper, as
  Cap Table does in `src/app/server/lib/identity.ts`.
- **The organization role can give powers**, so trust it only on purpose. `x-suger-org-role` (`OWNER`, `ADMIN`,
  `EDITOR`, `VIEWER`, or `APPS` for specific apps) counts only when `SUGER_TRUST_ORG_ROLE` is `true` (the deploy sets
  it) and only for people (API clients have none); a missing or unknown value is no organization role. Use it only for
  powers over the app's records that no app role gives, such as Knowledge's owners seeing every collection's basic
  information and deleting one, or Esign's owners taking over what someone owns. An app Admin by grant is `APPS` there,
  not an organization admin. Esign's `identity.ts` and Knowledge's are the reference.
- **Records with roles of their own** (DESIGN.md §2.5), such as Knowledge's collections, narrow Admin: an app role opens
  no record by itself, so an app Admin without a role on a record can't read it. Without the app permission to change,
  every resource role only reads. Sharing, unsharing and deleting such a record are browser-only (below). Say in the
  app's Docs what happens to someone's records and shares when they leave and when they return.
- **Enforce on the server.** Hiding a button isn't access control.

**AI agents and API clients.** Each app is its own MCP server at `https://<app>.insulin-apps.com/mcp`, with its own OAuth
client registration per agent, and API clients (OAuth clients, stored as service accounts) call
`https://<app>.insulin-apps.com/api/...` with a client-credentials token.

- **Connect AI.** Every app's Connect AI page (`insulin-apps.com/apps/<app>/settings/connect-ai`, open to everyone who
  can use the app) gives the MCP server and the setup for Claude Code, Codex, Gemini CLI, opencode, Claude.ai and
  ChatGPT, and lists the person's agents; the organization's owners and admins see and disconnect everyone's there.
- **API clients are the organization's.** Only the organization's Owners and Admins create, rename, change the role of,
  rotate and delete an app's OAuth clients, on its API access page (`/apps/<app>/settings/api`); an app's Admins by
  grant can't. Everyone who can use the app sees the list, never a secret. Rotating keeps the previous secret valid for
  24 hours. Stored credentials stay with the app's admins, on the integrations page.
- **The organization's OAuth clients.** Its Owners and Admins, and no one else, see every app's OAuth clients and
  everyone's AI agents at `insulin-apps.com/settings/oauth-clients`, with who created each, when and when it was last
  used. They revoke one there (its access ends at once and it stays listed, marked revoked) or delete it; nobody sees
  or rotates a secret there. A secret is shown once, when it is made or rotated on the app's API access page.
- **Same role as the person.** An agent acts with its person's current role; an API client has the role an owner or
  admin gave it. The app sees the same headers as for a browser, with `x-suger-access-via: mcp` or `api`, and a
  `User-Agent` naming the client (`Insulin Apps MCP: <client>` or `Insulin Apps API: <account>`) for its audit trail.
- **Every API serves agents and clients alike**, under the same rules as the browser. The exception: mutations of
  people, roles, billing and integrations. They stay browser-only and owner- or admin-only; if an app implements any of
  them, it refuses unless `x-suger-access-via` is `browser`. In an app with resource roles, sharing, unsharing and
  deleting a record are browser-only too, for whoever the app's own roles allow.
- **Publish your API** at `GET /api/catalog` (`{ endpoints: [{ method, path, summary, query, body, idempotencyKey }] }`,
  only what the caller may use) so the MCP `endpoints` tool can show it, and keep it in step with the routes.
- **Paths the gateway keeps on an app host.** Tokens reach only `/api/*`, never `/api/__suger/*`. Don't use these paths
  in an app: `/__insulin/*`, `/settings/users`, `/settings/integrations`, `/settings/api` and `/settings/connect-ai`
  (the gateway redirects them to the apex), `/mcp`, `/.well-known/oauth-*`.

**Outside services.** Credentials for outside APIs are stored by the platform on the app's integrations page. Call the
service with `integrationFetch(key)` from `@fours/app/server`, passing the request's `x-suger-organization-id`; never
keep such secrets in the app's database or source.

**Beyond D1** (`.github/hosting/DESIGN.md` §8). An app gets one D1 database and static assets, nothing else, unless it
owns an engine (below), which only it reaches. It asks the platform for the rest in `package.json` under `insulin`:

- **Public paths** (`insulin.publicPaths`) are only for people who have no account, such as an Esign recipient. The
  gateway forwards them with no identity (`x-suger-access-via: public`), so the app authenticates them with its own
  short-lived codes and lets them reach only what those codes are for. Never use one to skip sign-in for members.
- **Mail** goes through the gateway's relay: `POST` to `SUGER_MAIL_URL` with `SUGER_APP_TOKEN` and the request's
  `x-suger-organization-id`, one message at a time, sent over the `SUGER_GATEWAY` service binding the deploy adds (a
  Worker can't fetch another Worker of its zone through the public URL; Nitro puts the binding on
  `request.runtime.cloudflare.env`). There is no e-mail binding.
- **Runtime secrets** are names in `insulin.secrets`, each starting with the app's name in upper case (`ESIGN_…`). The
  deploy copies them from the GitHub environment, and the app reads them with `readAppEnv(name)`; never put a value in
  source.
- **Scheduled work** gets a five-minute tick instead of a cron: declare one path in `insulin.scheduled` (under `/api/`,
  never one of the public paths), and the gateway POSTs to it every five minutes with only `x-suger-app-id` and
  `x-suger-access-via: schedule`, an empty body and a 25-second timeout. Refuse the route unless `x-suger-access-via` is
  exactly `schedule` and no identity is present, treat a request marked `schedule` as nobody on every other route,
  keep it out of `/api/catalog`, and do every organization's due work there, idempotent and bounded per tick.
- **An engine** (`insulin.engine`, `insulin.engineApi`; DESIGN.md §8.7, §10.1), for compute D1 and a Worker can't
  give: a second Worker in the app's directory (Durable Objects, Containers, R2, Workers AI) with its own package and
  `wrangler.jsonc`, reached only by the app, over `SUGER_ENGINE`. The engine trusts its binding, so the app checks
  permissions, roles and limits before every call and names the organization in it. The engine lists the API versions
  it serves (`insulin.serves`) and the deploy refuses a pair that doesn't match, so a breaking change ships in steps.
  Never write an account, a bucket or an image reference in it. Ship a stub engine for `npm run dev`, the preview and
  the workerd smoke test. The Insulin console can't publish an app with an engine yet.
- **Limits** (`insulin.limits`, DESIGN.md §8.8): at most 20 `{ key, label, unit, default }`, set by Insulin Apps'
  operators. Pull them on the tick from `SUGER_LIMITS_URL` (save the cursor after each page; on anything but 200 keep
  what you stored), enforce them for every way in, report usage under the same keys, and answer past one with 429
  `{ "error": "quota_exceeded", "limit", "resets_at", "message" }`, the message naming Insulin Apps support from
  `SUGER_SUPPORT_EMAIL`, never an address in source. Knowledge (`src/app/server/limits.ts`, `limits-sync.ts`) is the
  reference.
- **Members** (DESIGN.md §8.9). An app has no directory of its own. The member lookup (`SUGER_MEMBERS_URL`, with the
  request's `x-suger-member-lookup`) fills a sharing dialog or checks the people someone typed, and nothing else;
  member status (`SUGER_MEMBER_STATUS_URL`) and member events (`SUGER_MEMBER_EVENTS_URL`: save the cursor after each
  page, resync after 410) keep the app's shares in step with who leaves, returns or changes role, and tell it whether
  someone it acts for later may still do so. All with `SUGER_APP_TOKEN` over `SUGER_GATEWAY`, and only for
  organizations where the app is used. Knowledge's `src/app/server/members.ts` and Esign's `directory.ts` are the
  reference.
- **Usage reports** are required of every app (DESIGN.md §8.6): Insulin Apps' operator console never reads an app's
  database, so each app declares `insulin.scheduled` and, on the first tick of each UTC hour, `POST`s its gauges to
  `SUGER_METRICS_URL` with `SUGER_APP_TOKEN` over the `SUGER_GATEWAY` binding: app-wide ones (`database_bytes`) and
  per organization (counts of its main records, `storage_bytes`), at most 500 organizations a request. Counts and
  sizes only, never a name, an address, an amount or content. Claim the hour in the app's own D1 with one conditional
  statement, mark it sent after every 202 and release it otherwise; skip silently without the URL or the token. Say
  in the app's Docs which numbers it sends. Cap Table (`src/app/server/lib/usage-metrics.ts`) and Esign
  (`src/app/server/esign/usage-metrics.ts`) are the reference.

**One deployment, many organizations.** Scope every query by `getCurrentUser().organizationId`, so one organization
never reads another's data.

## A new app

- A top-level directory with `README.md`, `AGENTS.md` (including the Docs rule and the access rules above), `NOTICE`
  when it bundles third-party material, the in-app Docs, and its public docs in `docs/public/` (the docs build fails
  for an app without them).
- Its roles mapped to the app's functions (what Admin, Editor and Viewer may do there), a permission catalog in
  `package.json` if it should support custom roles, `GET /api/catalog` for AI agents, and its hourly usage report
  (above).
- A row in the app table of the root `README.md`.
- A `.github/workflows/<app>.yml` file copied from `captable.yml`, with its name (the app's directory name), paths and
  `app` input changed, and that name added to the `workflows` list in `.github/workflows/release.yml`. The shared
  pipeline runs its typecheck, tests, migration check and Cloudflare build; releases deploy it (`deploy-release.yml`).

## Releases

`.github/workflows/release.yml` makes every green push to `main` a release: it tags the commit `v0.1.1`, `v0.1.2`, …,
publishes its GitHub Release (the root README's "Releases") and deploys it with `deploy-release.yml`. Only releases are
deployed: an app's or the gateway's workflow only checks a push, and no other workflow deploys. Never create, move or
delete a `v*` tag, or publish or edit one of those releases, by hand or from another workflow. Only CI, Gateway and
each app's own workflow, named after the app, run on a push to `main`, and each is in release.yml's `workflow_run`
list; `node .github/scripts/check-app-workflows.mjs` checks both. Pull requests are squash merged, and the squash
commit carries every commit message, so none of them, nor the title or body, may hold a line telling GitHub to skip
workflows: the merge would start no push workflow and be neither checked on `main` nor released. The
"Commit messages" workflow refuses one; it runs on `pull_request_target`, which such a line in a pull request's last
commit doesn't stop, and never runs the pull request's code (the repository needs an Actions event policy allowing
that event for this workflow alone: `.github/hosting/README.md`, "Owner setup").

## Agent tools

Every coding agent gets Playwright MCP from the repository, driving a Chrome on CDP port 9335 with a profile of its
own (`/e2e-test` starts it): `.mcp.json` (Claude Code, turned on by `.claude/settings.json`), `.codex/config.toml`,
`.gemini/settings.json`, `opencode.json`, `.cursor/mcp.json` and `.vscode/mcp.json`. Codex and Gemini CLI load it once
the folder is trusted. Change all six together, with the same pinned version.

## Before you finish

From the app's directory: `npm run typecheck`, `npm test` and `npm run build`, and for an app with an engine the
same `typecheck` and `test` in the engine's directory. From the repository root:
`node .github/scripts/check-insulin-app.mjs <app>` and `node .github/scripts/check-public-content.mjs`.

A pull request is ready to merge only once `/review-pr` (`.claude/commands/review-pr.md`) and then `/e2e-test`
(`.claude/commands/e2e-test.md`) have run on it, and each has recorded its section (`## Review`, `## E2E test`) in
the PR's description. A merge to `main` becomes a release, which deploys to production.
