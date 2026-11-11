# Hosting the apps on insulinapps.com

Every app in this repository runs at its own address, `<app>.insulinapps.com`, with its own checks; releases deploy it.
People create an account and an organization, invite their teammates with a role in every app or in specific apps,
connect AI agents, and use the apps for real work. Data is kept; nothing is reset. How accounts, roles and access work
is in [DESIGN.md](DESIGN.md).

## Architecture

Cloudflare custom domains for the apex, `www` (redirected to the apex), `auth` (redirected to the apex, where sign-in
moved), and every app hostname point to the `insulin-apps-gateway` Worker. The gateway owns accounts, sign-in,
organization membership and roles in its D1 database, then calls the private `insulin-apps-<app>` Workers through
service bindings, with the identity headers the Insulin console sends. Each app has its own D1 database. App Workers have neither a `workers.dev` address nor a public route. The
gateway deletes expired sessions, tokens and mail records after its writes and once a day on a cron trigger, and
every five minutes, on a second cron trigger, it calls the scheduled path of each app that declares one (DESIGN.md
§8.5). The deploy sets both triggers and the gateway's rate limits (`RL_AUTH`, `RL_APP`, `RL_PUBLIC`); none needs
setting up by hand.

Each `.github/workflows/<app>.yml` file, named after its app, supplies its app name to the shared
`.github/workflows/app.yml` pipeline. On a pull request or a push to `main` that touches that app, the pipeline
installs it, checks its Insulin shape, typechecks, tests, verifies migration drift, builds for Cloudflare, and checks
the build output. Cap Table also runs the local workerd smoke test. It never receives deployment settings and never
deploys.

Only releases are deployed. Once every workflow a push to `main` started has passed, `release.yml` tags it (below)
and calls `.github/workflows/deploy-release.yml` with the version. `.github/scripts/check-deploy.mjs` first checks
that the version is a release on `main` and that the apps exist in it, and which parts passed their latest check: the
newest push run on `main` of the app's workflow, or of Gateway, at or before the release's commit. A release deploys
every app that passed, so anything an earlier release couldn't deploy goes out with the next; an app that didn't
keeps the version it runs, and while the gateway's latest check fails, nothing deploys. Each app is built from the
release's commit in a job without secrets, and a separate `production` job treats the downloaded build as untrusted
before applying that app's migrations and deploying only its private Worker.
The archive is listed before extraction, may contain only regular files and directories under `<app>/.output`, and is
extracted without its stored ownership or permissions. The deploy then walks the output without following links,
rejects special files and hard links outside the output, and requires the Worker entry file and asset directory. A
failed app deploy doesn't stop the others. Once every app has deployed, the gateway follows, so new hostnames and
service bindings become live with them. Every Worker version is tagged with the release (`wrangler deploy --tag`).
Deploys never overlap: Release runs, which deploy their releases, and deploys by hand (`deploy.yml`) wait in one
queue, the `release` concurrency group, which keeps every waiting run.

To retry a failed deploy, run **Actions → Deploy → Run workflow** on `main` with the latest release, the apps (`all` or
their names) and whether to deploy the gateway; it checks the release again. Re-running a deploy's failed jobs is refused,
since it would reuse an earlier attempt's check. An app or the gateway named there whose latest check didn't pass is
refused, and `all` leaves such an app out. A check counts only if nothing its workflow watches changed between its
run and the release (a push with `[skip ci]` starts no run). Going back to an earlier release takes the same with
`rollback` set, and the gateway unticked unless it should go back as well (see Roll back); it's refused when anything
it would deploy has a migration since, because going back past a migration needs the database restored first.

The app deploy builds a fresh Wrangler configuration instead of trusting generated deployment metadata. It accepts
only a valid `compatibility_date`, `nodejs_compat` as the only possible compatibility flag, validated module `rules`,
boolean `no_bundle`, and the primitive `assets` settings `binding`, `html_handling`, `not_found_handling`, and
`run_worker_first`. It logs and ignores every other generated key. The deploy itself always supplies the Worker name,
absolute entry and asset paths, D1 binding, console access mode, and disabled `workers.dev` and preview settings.

The gateway has its own path-filtered workflow. Pull requests and pushes to `main` that change the gateway, its
deployment and discovery scripts, or the public docs (`.github/hosting/docs/` and every app's `docs/public/`) run
gateway typechecks and tests, which fail while the generated docs module is stale. A release deploy migrates and
deploys the gateway with all discovered app bindings. Custom domains are managed by the Worker deployment; there is no
manual DNS provisioning. After deploying the gateway, the deploy lists its remote secrets and fails if `SITE_ENV` is
present, because a retained secret is not removed merely by omitting it from a new configuration.

The gateway deploy also uploads the docs' images: `.github/hosting/docs/assets/` is the Worker's static-assets
directory (binding `DOCS_ASSETS`, `run_worker_first: true`), uploaded by `wrangler deploy` with the Worker, so the
same Workers Scripts permission covers it. Every request still reaches the gateway first; it serves the directory only
at `https://insulinapps.com/docs/assets/*`. The pages themselves are compiled into the Worker
(`src/assets/docs-content.ts`), so docs reach `https://insulinapps.com/docs/` with the next release that deploys the
gateway. Keep only
images in that directory: everything in it is uploaded.

After every app Worker deploy, the pipeline also uses the Cloudflare API to remove any custom domain or zone route
still attached to that Worker and disables its `workers.dev` and preview URLs. It re-lists all three kinds of public
access and fails the deployment unless none remain. Removed hostnames and route patterns are logged, but the API token
is sent only in the authorization header.

Path-filtered workflows do not report a check on pull requests that do not touch their paths. Branch protection should
therefore require an always-running check such as the repository-wide `Public content` job, not an app or gateway job
that may be absent.

Once every run a push to `main` started has passed, `.github/workflows/release.yml` tags that commit with the next
version, publishes a GitHub Release (the root README's "Releases") and deploys it as above; a push with a failed or
cancelled run gets no version. It tags with a deploy key that only its `release` environment holds, and the "Release
tags" ruleset lets nobody else, org admins aside, create, move or delete a `v*` tag.

## Owner setup

Workers Paid must be enabled for the Cloudflare account before the first deployment. The gateway runs with the
`nodejs_compat` flag (for SAML's XML signature library); the deploy sets it.

1. Create a GitHub environment named `production` that only `main` can deploy to. Add these environment secrets:

   - `CLOUDFLARE_API_TOKEN`
   - `GOOGLE_CLIENT_SECRET`
   - `TURNSTILE_SECRET_KEY`
   - `GATEWAY_SECRET_KEY`: 32 random bytes, base64 (`openssl rand -base64 32`). It seals what the gateway must read
     back (authenticator-app secrets, stored integration credentials, OIDC client secrets) and derives each app's
     `SUGER_APP_TOKEN`. Optional, but without it MFA, stored credentials and OIDC can't be set up. Keep a copy in the
     credential vault: replacing it makes everything sealed with the old key unreadable (people turn MFA on again and
     admins re-enter credentials), so don't rotate it casually. After replacing it, deploy the gateway and then every
     app, which gives each app its new `SUGER_APP_TOKEN`.

   Add these environment variables:

   - `CLOUDFLARE_ACCOUNT_ID`
   - `GOOGLE_CLIENT_ID`
   - `TURNSTILE_SITE_KEY`
   - `EMAIL_FROM`
   - `SUPPORT_EMAIL`: the contact shown on the landing, privacy and terms pages (optional; without it those pages
     point to the repository's issues)
   - `ORG_REQUEST_EMAIL`: Insulin Apps support's address, which receives requests for more organizations from people
     whose email domain has all it may have (DESIGN.md §3.1), with Reply-To set to the requester. Optional; without it
     the page at the limit points to `SUPPORT_EMAIL` or the issues instead. Set it here only, never in the repository
   - `SITE_DOMAIN` only when the domain is not `insulinapps.com`

   **App secrets.** An app that lists names under `insulin.secrets` in its `package.json` (DESIGN.md §8.3), such as
   `ESIGN_KMS_KEY_ARN`, gets each one that this environment holds, as a secret or else a variable of exactly that name,
   uploaded with its Worker; names that aren't set are skipped and named in the deploy log. Add them here, as secrets
   for anything confidential. They reach only that app's deploy step, never another app, the gateway or a build.

2. Create an account-owned Cloudflare API token scoped to the account and the site's zone. Grant:

   - Account · Workers Scripts · Edit
   - Account · D1 · Edit
   - Account · Email Sending · Edit
   - Account · Account Settings · Read
   - Zone · Workers Routes · Edit
   - Zone · Zone · Read

3. Create a Google OAuth web client. Register this exact redirect URI:

   `https://insulinapps.com/auth/google/callback`

   Sites set up before sign-in moved to the apex registered `https://auth.insulinapps.com/auth/google/callback`; add the
   apex URI (keep the old one until the deploy is out), because Google compares the exact redirect URI.

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

7. Lock release tags once. Signed in to the GitHub CLI as an org admin, with `ssh-keygen` installed, run from a clone of
   the repository:

   ```bash
   .github/scripts/configure-release-tags.sh
   ```

   It creates the `release` environment, which only `main` can use and which needs no approval; a write deploy key,
   whose private half goes straight into that environment's `RELEASE_DEPLOY_KEY` secret and is never printed; and the
   "Release tags" ruleset, which lets only that key and org admins create, move or delete a `v*` tag. Because the
   ruleset lets every deploy key through, it stops before changing anything if the repository has another write
   deploy key. It prints what it set when it's done. Until it has run, `release.yml` plans releases but can't tag
   them. It targets `sugerio/insulin-apps`; set `GH_REPO` for a fork.

8. Allow `pull_request_target` for one workflow: in the repository's (or the organization's) **Settings → Actions →
   Policies**, add an Actions event policy targeted at `.github/workflows/commit-messages.yml` alone that allows the
   `pull_request_target` event. An event policy is an allowlist: one that covers every workflow and lists only this
   event would stop the others (`push`, `pull_request`, `workflow_run`, `workflow_dispatch`, `schedule`), and with
   them CI, releases and deploys. The "Commit messages" workflow runs on this event, so that a line telling GitHub to
   skip workflows can't reach `main` in a squash merge, and GitHub blocks the event by default in public repositories
   without such a policy from December 2, 2026. The workflow runs the default branch's code, reads the pull request's
   commits as data, and has a read-only token.

Once setup is complete, run **Actions → Deploy → Run workflow** on `main` with the latest release, `all` apps and
the gateway (the next green merge to `main` releases and deploys too). Step summaries link the affected public
addresses. On a new Cloudflare account, leave `GATEWAY_SECRET_KEY` out of the environment for that first deploy, then
add it and run Deploy the same way again. With the key, each app is deployed with a service binding to the gateway
Worker (`SUGER_GATEWAY`, for the mail relay and the integration proxy), and Cloudflare refuses a binding to a Worker
that doesn't exist yet; the gateway, deployed after the apps, binds every app. Without the key, the apps go first
with no binding, and the gateway after them; the second deploy then binds each app to it.

## Operations

### Rotate secrets

Replace the relevant secret in the GitHub `production` environment, then run **Actions → Deploy → Run workflow** on
`main` with the latest release: for a gateway setting, with no apps; for an app's setting, with that app. Secrets are
uploaded with `wrangler deploy` (`--secrets-file`), so the new version starts with the new values. After rotating the
Cloudflare token, deploy the latest release with `all` apps and the gateway to verify each. Never put a value in a
workflow file, command argument, issue, or log.

To replace the release deploy key, run `.github/scripts/configure-release-tags.sh --rotate` as an org admin: it adds a
new key, stores it as `RELEASE_DEPLOY_KEY` and deletes the old one.

### Allow a domain more organizations

Each email domain may have two organizations at a time, and each address at a public mail provider two of its own
(DESIGN.md §3.1). The owner domain is the registrable domain of the address (`example.com` for an address at
`eu.example.com` or at `example.com`; `example.co.uk` under `.co.uk`), and its subdomains' organizations count with it.
A request for more reaches `ORG_REQUEST_EMAIL` with the owner domain to allow and the command to run; reply to the
requester (the message's Reply-To) and, if you agree, allow it from the repository root with the Cloudflare credentials
the workflow uses (`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment, or `wrangler login`):

```bash
npm ci --prefix .github/hosting/gateway
node .github/hosting/scripts/allow-orgs.mjs --domain 'example.com' --max 5 --note "Approved request" --remote
```

`--domain` is the owner domain exactly as the request names it: a registrable domain, or for someone at a public mail
provider their address (a Gmail address without dots, at gmail.com). The script refuses a subdomain, a provider's own
domain or an address that isn't at a provider, and says which owner domain counts instead. When the request shows
`DOMAIN` in place of the domain, its owner domain has characters the script refuses: check the address by hand before
deciding what to allow. `--max` is the total that domain may have, from 0 to 1000 (0 closes it); running the command
again replaces the number. Without `--remote` it changes the local development database instead. The script refuses
anything but a plain domain or address and a short plain note, and runs the gateway's wrangler with Node, without a
shell (`node node_modules/wrangler/bin/wrangler.js d1 execute insulin-apps-gateway`), so it works the same on Windows.
The person then creates the organization themselves at `/orgs/new`. To go back to the default, set `--max 2`.

### Add an app

Add a top-level directory with a `package.json` and `src/api.ts`. Its directory name must follow the repository app-name
rule and must not be reserved. Every organization shares one deployment of the app, so the app must keep each
organization's data apart: scope everything by the console organization (`getCurrentUser().organizationId`), as Cap
Table does. Set `displayName` and `description` in `package.json`, include D1 migrations under
`src/app/db/migrations`, and make sure the normal checks pass. An app that needs public paths, mail, runtime secrets or
scheduled work declares them under `insulin` in `package.json` (DESIGN.md §8); add its secrets to the `production`
environment before its first deploy. A new `insulin.scheduled` path is ticked once the gateway has been deployed with
it (a release deploys the gateway after its apps). Copy `.github/workflows/captable.yml` to
`.github/workflows/<app>.yml`, then change the workflow name to the app's directory name, the app path entries, and
`with.app`, and add the workflow name to the `workflows` list in `.github/workflows/release.yml`. Repository-wide CI
enforces that every discovered app has this workflow, named after it, that no app workflow names a missing app, that
only CI, Gateway and the apps' own workflows run on a push, and that `release.yml` starts after every one of them.

The release that first includes the app creates its D1 database, deploys its private Worker, and then deploys the
gateway with its hostname and service binding. When one release adds several new apps, the gateway deploys once, after
all of them.

### Roll back

To go back to an earlier release, run **Actions → Deploy → Run workflow** on `main` with its version, the apps to
deploy and `rollback` set, and untick **Deploy the gateway too** unless the gateway should go back as well (it's on by
default). It refuses when anything it would deploy has a migration since. Otherwise, Cloudflare
keeps Worker versions, each tagged with its release. With the same account credentials used by the workflow, use the
gateway package's pinned CLI to inspect deployments and run `wrangler rollback --name insulin-apps-<app>` for only the
affected app. Roll back `insulin-apps-gateway` separately only when the gateway itself changed. When both need
rollback, roll back the app Worker before the gateway. D1 migrations are forward-only and are not rolled back; confirm that the older Worker
remains compatible with the migrated schema.

After a rollback, revert or fix the change on `main` before anything else merges: every release deploys every app
whose latest check passed, so the next one, whatever it changes, would put the broken version back.

## Troubleshooting

- **A workflow says the deploy is not configured:** add `CLOUDFLARE_API_TOKEN` to the `production` environment.
- **App preflight lists a missing setting:** add `CLOUDFLARE_ACCOUNT_ID`. Gateway preflight also requires its
  Turnstile and email settings; a Google client ID requires its client secret.
- **A custom domain fails with "externally managed DNS records" (code 100117):** delete the A, AAAA or CNAME records
  on that hostname, then run **Deploy** with the latest release. Otherwise check the token's permissions (Workers Scripts
  and, on the zone, Workers Routes and Zone read) and that the hostname is not attached to another Worker. Do not
  create manual replacement records.
- **A gateway deploy says an app Worker was not found (code 10143):** a new app wasn't deployed (its latest check
  didn't pass, so the release held it back), and the gateway can't bind it yet. Fix the app, or re-run its failed
  check; the next release then deploys it and the gateway, or run **Deploy** with the latest release.
- **An app deploy says the gateway Worker was not found (code 10143):** the gateway doesn't exist yet, as on a first
  deploy with `GATEWAY_SECRET_KEY` set. Deploy once without the key, then add it and deploy again (first deploy,
  above).
- **An app deploy cannot prove the Worker is private:** check the account and zone permissions, the `SITE_DOMAIN`
  value, and the reported Cloudflare API error. The deploy deliberately stops if any lookup, removal, or verification
  is incomplete.
- **A gateway deploy reports `SITE_ENV`:** remove the retained production secret with
  `wrangler secret delete SITE_ENV --config <gateway-config>`, then run **Deploy** with the latest release. Never
  configure `SITE_ENV` on the production Worker.
- **A migration fails:** stop. Fix it with a new forward migration; never edit or delete a migration that may already
  have been applied.
- **Email fails:** confirm Email Service onboarding, the approved sender, and that `EMAIL_FROM` contains that address.
- **Google redirects fail:** compare the registered redirect URI character-for-character with
  `https://<SITE_DOMAIN>/auth/google/callback` (the apex, not `auth.`).
- **Turnstile rejects every form:** verify that the widget permits the site's hostname and rotate both keys together
  when replacing the widget.
- **An app is missing:** run `node .github/scripts/list-apps.mjs` and fix the directory name or required files it
  reports, then run `node .github/scripts/check-app-workflows.mjs` to verify its workflow.
- **Release can't tag a version** (`Couldn't tag … as v…`, a permission error, or a missing `RELEASE_DEPLOY_KEY`): run
  `.github/scripts/configure-release-tags.sh` again as an org admin; the next run of Release, at the latest hourly,
  tags every waiting version in order. If it says the runs of the latest release's push aren't among those GitHub
  lists, run **Actions → Release → Run workflow** on `main` with the next minor version, such as `v0.2.0`. Never
  create the tag by hand.
