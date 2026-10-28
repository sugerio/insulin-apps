# Hosting the apps on insulinapps.com

Every app in this repository runs at its own address, `<app>.insulinapps.com`, and has an independent CI/CD pipeline.
People create an account and an organization, invite their teammates with a role, and use the apps for real work. Data
is kept; nothing is reset.

## Architecture

Cloudflare custom domains for the apex, `www` (redirected to the apex), `auth`, and every app hostname point to the
`insulin-apps-gateway` Worker. The gateway owns accounts, sign-in and organization membership in its D1 database, then
calls the private `insulin-apps-<app>` Workers through service bindings, with the identity headers the Insulin console
sends. Each app has its own D1 database. App Workers have neither a `workers.dev` address nor a public route. The
gateway deletes expired sessions, tokens and mail records after its writes and once a day on a cron trigger.

Each `.github/workflows/<app>.yml` file supplies its app name to the shared `.github/workflows/app.yml` pipeline. On a
pull request that touches that app, the pipeline installs it, checks its Insulin shape, typechecks, tests, verifies
migration drift, builds for Cloudflare, and checks the build output. Cap Table also runs the local workerd smoke test.
It does not receive deployment settings or deploy from a pull request.

On a push to `main` that touches an app, the same checks build it once in a job without secrets. The pipeline uploads
that output, then a separate `production` job treats the downloaded build as untrusted before applying that app's
migrations and deploying only its private Worker. The archive is listed before extraction, may contain only regular
files and directories under `<app>/.output`, and is extracted without its stored ownership or permissions. The deploy
then walks the output without following links, rejects special files and hard links outside the output, and requires
the Worker entry file and asset directory. A failure in one app's workflow does not block another app. After every
successful app deployment, the pipeline calls the gateway workflow so new hostnames and service bindings become live
automatically. Gateway deploys share the `gateway-deploy` concurrency queue and never cancel one another.

The app deploy builds a fresh Wrangler configuration instead of trusting generated deployment metadata. It accepts
only a valid `compatibility_date`, `nodejs_compat` as the only possible compatibility flag, validated module `rules`,
boolean `no_bundle`, and the primitive `assets` settings `binding`, `html_handling`, `not_found_handling`, and
`run_worker_first`. It logs and ignores every other generated key. The deploy itself always supplies the Worker name,
absolute entry and asset paths, D1 binding, console access mode, and disabled `workers.dev` and preview settings.

The gateway has its own path-filtered workflow. Pull requests that change the gateway or its deployment and discovery
scripts run gateway typechecks and tests. A matching push to `main`, or a manual dispatch on `main`, also migrates and
deploys the gateway with all discovered app bindings. Custom domains are managed by the Worker deployment; there is no
manual DNS provisioning. After deploying the gateway, the workflow lists its remote secrets and fails if `SITE_ENV`
is present, because a retained secret is not removed merely by omitting it from a new configuration.

After every app Worker deploy, the pipeline also uses the Cloudflare API to remove any custom domain or zone route
still attached to that Worker and disables its `workers.dev` and preview URLs. It re-lists all three kinds of public
access and fails the deployment unless none remain. Removed hostnames and route patterns are logged, but the API token
is sent only in the authorization header.

Path-filtered workflows do not report a check on pull requests that do not touch their paths. Branch protection should
therefore require an always-running check such as the repository-wide `Public content` job, not an app or gateway job
that may be absent.

## Owner setup

Workers Paid must be enabled for the Cloudflare account before the first deployment.

1. Create a GitHub environment named `production` that only `main` can deploy to. Add these environment secrets:

   - `CLOUDFLARE_API_TOKEN`
   - `GOOGLE_CLIENT_SECRET`
   - `TURNSTILE_SECRET_KEY`

   Add these environment variables:

   - `CLOUDFLARE_ACCOUNT_ID`
   - `GOOGLE_CLIENT_ID`
   - `TURNSTILE_SITE_KEY`
   - `EMAIL_FROM`
   - `SUPPORT_EMAIL`: the contact shown on the landing, privacy and terms pages (optional; without it those pages
     point to the repository's issues)
   - `SITE_DOMAIN` only when the domain is not `insulinapps.com`

2. Create an account-owned Cloudflare API token scoped to the account and the site's zone. Grant:

   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Email Sending · Edit
   - Account · Account Settings · Read
   - Zone · Workers Routes · Edit
   - Zone · Zone · Read

3. Create a Google OAuth web client. Register this exact redirect URI:

   `https://auth.insulinapps.com/auth/google/callback`

   On its Branding page, set the application home page to `https://insulinapps.com`, the privacy policy to
   `https://insulinapps.com/privacy` and the terms of service to `https://insulinapps.com/terms`, and list
   `insulinapps.com` as an authorized domain: Google refuses to publish the app without them. Then publish it from the
   Audience page so that any Google account can sign in. With a different `SITE_DOMAIN`, register the same paths on
   that domain instead. Put the client ID and secret in the matching GitHub environment settings. Google sign-in can be
   disabled by leaving both settings empty.

4. Create a managed Turnstile widget for the site's domain and add its site and secret keys to the environment.

5. Onboard the sending domain with Cloudflare Email Service. Set `EMAIL_FROM` to an approved sender, either as a bare
   address or `Display Name <address>`.

6. Before the first deployment, delete every A, AAAA and CNAME record on the apex, `www`, `auth` and app hostnames
   (a registrar's parking records, for example). Cloudflare refuses to attach a Worker custom domain to a hostname
   that has records it didn't create ("externally managed DNS records", code 100117). Keep MX and TXT records. The
   deploy then attaches every hostname to the gateway and creates its DNS records; don't add records for these
   hostnames by hand.

Manually run the `Gateway` workflow on `main` once setup is complete, then manually run each app workflow on `main`.
Step summaries link the affected public addresses.

## Operations

### Rotate secrets

Replace the relevant secret in the GitHub `production` environment. For a gateway setting, manually dispatch the
`Gateway` workflow on `main`; its secrets are uploaded with `wrangler deploy` (`--secrets-file`), so the new version
starts with the new values. After rotating the Cloudflare token, manually dispatch the affected app workflows on
`main` as well as `Gateway` to verify each independently. Never put a value in a workflow file, command argument,
issue, or log.

### Add an app

Add a top-level directory with a `package.json` and `src/api.ts`. Its directory name must follow the repository app-name
rule and must not be reserved. Every organization shares one deployment of the app, so the app must keep each
organization's data apart: scope everything by the console organization (`getCurrentUser().organizationId`), as Cap
Table does. Set `displayName` and `description` in `package.json`, include D1 migrations under
`src/app/db/migrations`, and make sure the normal checks pass. Copy `.github/workflows/captable.yml` to
`.github/workflows/<app>.yml`, then change the workflow name, the app path entries, and `with.app`. Repository-wide CI
enforces that every discovered app has this workflow and that no app workflow names a missing app.

On the first matching push to `main`, the app workflow creates its D1 database, deploys its private Worker, and queues a
gateway refresh for its hostname and service binding. If one pull request adds several new apps, an early app pipeline
can show one failed gateway refresh because another new app Worker does not exist yet. The app deployments are still
independent; after the last new app deploys, its later queued gateway refresh can bind all of them successfully.

### Roll back

Cloudflare keeps Worker versions. With the same account credentials used by the workflow, use the gateway package's
pinned CLI to inspect deployments and run `wrangler rollback --name insulin-apps-<app>` for only the affected app. Roll
back `insulin-apps-gateway` separately only when the gateway itself changed. When both need rollback, roll back the app
Worker before the gateway. D1 migrations are forward-only and are not rolled back; confirm that the older Worker
remains compatible with the migrated schema.

After a rollback, investigate the failed version before manually dispatching that app's workflow again. A later
matching push to `main` will otherwise deploy the current repository state.

## Troubleshooting

- **A workflow says the deploy is not configured:** add `CLOUDFLARE_API_TOKEN` to the `production` environment.
- **App preflight lists a missing setting:** add `CLOUDFLARE_ACCOUNT_ID`. Gateway preflight also requires its
  Turnstile and email settings; a Google client ID requires its client secret.
- **A custom domain fails with "externally managed DNS records" (code 100117):** delete the A, AAAA or CNAME records
  on that hostname, then run the `Gateway` workflow again. Otherwise check the token's permissions (Workers Scripts
  and, on the zone, Workers Routes and Zone read) and that the hostname is not attached to another Worker. Do not
  create manual replacement records.
- **The first gateway deploy says an app Worker was not found (code 10143):** the gateway raced a new app's first
  deploy. The app's own workflow refreshes the gateway once the app is deployed, or run `Gateway` again.
- **An app deploy cannot prove the Worker is private:** check the account and zone permissions, the `SITE_DOMAIN`
  value, and the reported Cloudflare API error. The deploy deliberately stops if any lookup, removal, or verification
  is incomplete.
- **A gateway deploy reports `SITE_ENV`:** remove the retained production secret with
  `wrangler secret delete SITE_ENV --config <gateway-config>`, then run the Gateway workflow again. Never configure
  `SITE_ENV` on the production Worker.
- **A migration fails:** stop. Fix it with a new forward migration; never edit or delete a migration that may already
  have been applied.
- **Email fails:** confirm Email Service onboarding, the approved sender, and that `EMAIL_FROM` contains that address.
- **Google redirects fail:** compare the registered redirect URI character-for-character with the `auth` URL.
- **Turnstile rejects every form:** verify that the widget permits the site's hostname and rotate both keys together
  when replacing the widget.
- **An app is missing:** run `node .github/scripts/list-apps.mjs` and fix the directory name or required files it
  reports, then run `node .github/scripts/check-app-workflows.mjs` to verify its workflow.
