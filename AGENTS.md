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
3. **Public repository.** Synthetic data only (example.com or `.test` addresses, fictional people and companies), in
   code, tests, fixtures and docs. No secrets, account ids or internal hostnames.

## A new app

- A top-level directory with `README.md`, `AGENTS.md` (including the Docs rule above), `NOTICE` when it bundles
  third-party material, and the in-app Docs.
- A row in the app table of the root `README.md`.
- CI runs its typecheck, tests, migration check and Cloudflare build: see `.github/workflows/ci.yml`.

## Before you finish

From the app's directory: `npm run typecheck`, `npm test` and `npm run build`. From the repository root:
`node .github/scripts/check-insulin-app.mjs <app>` and `node .github/scripts/check-public-content.mjs`.
