# AGENTS.md

This repository holds open-source Insulin apps, one per top-level directory (today: `captable/`). These rules apply to
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
3. **UI.** New UI uses [shadcn/ui](https://ui.shadcn.com) components and its default theme (the hosting gateway in
   `.github/hosting/gateway/` follows it). Apps that already have their own design keep it until they are restyled.
4. **Public repository.** Synthetic data only (example.com or `.test` addresses, fictional people and companies), in
   code, tests, fixtures and docs. No secrets, account ids or internal hostnames.
5. **Accounts, roles and access belong to the platform.** The rules below follow from the design in
   [`.github/hosting/DESIGN.md`](.github/hosting/DESIGN.md); repeat the ones that shape app code in the app's own
   `AGENTS.md`.

## Accounts, roles and access

**One place signs people in.** Sign-up, sign-in, MFA, Google and enterprise SSO (SAML, OIDC, SCIM), OAuth for AI agents
(MCP) and for service accounts all live at `https://insulinapps.com/`, in the gateway (`.github/hosting/gateway/`). An
app never adds sign-in screens, sessions, passwords, cookies or OAuth endpoints of its own: it reads who is calling with
`getCurrentUser(request)` from `@fours/app/server`.

**People and roles are managed in one place.** An organization's people, roles and custom roles are at
`insulinapps.com/settings/users` and `/settings/roles`; each app's people and integrations are at
`<app>.insulinapps.com/settings/users` and `/settings/integrations`, pages the gateway serves on the app's host. Apps
don't build their own people, role or integration management.

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
client registration per agent, and service accounts call `https://<app>.insulinapps.com/api/...` with a
client-credentials token.

- **Same role as the person.** An agent acts with its person's current role; a service account has the role an app admin
  gave it. The app sees the same headers as for a browser, with `x-suger-access-via: mcp` or `api`.
- **Every API serves agents and clients alike**, under the same rules as the browser. The exception: mutations of
  people, roles, billing and integrations. They stay browser-only and owner- or admin-only; if an app implements any of
  them, it refuses unless `x-suger-access-via` is `browser`.
- **Publish your API** at `GET /api/catalog` (`{ endpoints: [{ method, path, summary, query, body, idempotencyKey }] }`,
  only what the caller may use) so the MCP `endpoints` tool can show it, and keep it in step with the routes.
- **Paths the gateway keeps on an app host.** Tokens reach only `/api/*`, never `/api/__suger/*`. Don't use these paths
  in an app: `/__insulin/*`, `/settings/users`, `/settings/integrations`, `/mcp`, `/.well-known/oauth-*`.

**Outside services.** Credentials for outside APIs are stored by the platform under `/settings/integrations`. Call the
service with `integrationFetch(key)` from `@fours/app/server`, passing the request's `x-suger-organization-id`; never
keep such secrets in the app's database or source.

**One deployment, many organizations.** Scope every query by `getCurrentUser().organizationId`, so one organization
never reads another's data.

## A new app

- A top-level directory with `README.md`, `AGENTS.md` (including the Docs rule and the access rules above), `NOTICE`
  when it bundles third-party material, and the in-app Docs.
- Its roles mapped to the app's functions (what Admin, Editor and Viewer may do there), a permission catalog in
  `package.json` if it should support custom roles, and `GET /api/catalog` for AI agents.
- A row in the app table of the root `README.md`.
- A `.github/workflows/<app>.yml` file copied from `captable.yml`, with its name, paths and `app` input changed. The
  shared pipeline runs its typecheck, tests, migration check and Cloudflare build.

## Before you finish

From the app's directory: `npm run typecheck`, `npm test` and `npm run build`. From the repository root:
`node .github/scripts/check-insulin-app.mjs <app>` and `node .github/scripts/check-public-content.mjs`.
