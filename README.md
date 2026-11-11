# Insulin Apps

Open-source apps for Insulin. Each app is one directory: a complete, ordinary npm project that you can start from in
the Insulin console, and that the Insulin AppBuilder can change, preview and publish to Cloudflare Workers with its own
D1 database.

| App | What it does |
|---|---|
| [`captable/`](captable/) | Cap table and equity management: stakeholders, share classes, equity plans, option grants, vesting, exercises, terminations, 409A valuations, documents and a holder view, set up by importing Pulley's reports or a spreadsheet template. |
| [`esign/`](esign/) | Electronic signatures: templates, envelopes signed in order on a public signing page after an emailed code, an embeddable template editor, hash-chained evidence, a KMS and timestamp seal, and certificates of completion. Experimental: synthetic documents only. |

## Use the apps online

Every app here also runs at its own address on insulinapps.com, for example [Cap Table](https://captable.insulinapps.com).
Sign up with an e-mail address, Google or your company's single sign-on, create an organization and invite your
team, with a role in every app or in the apps each person needs. Connect AI agents such as Claude or Codex to an app
over MCP, or call its API with a service account. **The documentation is at
[insulinapps.com/docs](https://insulinapps.com/docs/)**: getting started, organizations and roles, sign-in and security,
AI agents, the API and each app, for people and for AI agents (`/docs/llms.txt`). Its pages are Markdown in this
repository, next to what they describe: [`.github/hosting/docs/`](.github/hosting/docs/) for the platform and each
app's `docs/public/`. Maintainers run the site with the [hosting runbook](.github/hosting/README.md).

## Using an app

In the Insulin console, choose **New app**, then **Use template** on the app you want under **Or start from a
template**; change it with the AppBuilder, preview it and publish it. The console lists these apps once the platform's
template catalog includes this repository. Each app's README says what it does and how to set it up.

Every app follows the Insulin app layout (Vite, React and Nitro, with Drizzle on D1), so it runs the same way in the
console's preview, on your machine and once published:

```bash
cd captable
npm ci
npm run dev        # http://localhost:3000
npm test
npm run typecheck
```

## Adding an app

Each app is a top-level directory with its own `README.md` and `AGENTS.md`, and it must:

- follow the Insulin app layout and pass `node .github/scripts/check-insulin-app.mjs <app>`;
- ship **in-app Docs**, which are required by default: a **Docs** entry in the app's navigation that every role can
  open, before setup too. It explains in plain words how to use the app and gives the background a business user needs
  for its domain. Cap Table's `src/app/pages/docs/` shows the pattern: one static page per topic, describing only what
  the app does, updated in the same change as the behaviour it describes, and covered by tests;
- ship **public docs** in `docs/public/`, which become its section of
  [insulinapps.com/docs](https://insulinapps.com/docs/) (run `npm run build:docs` in `.github/hosting/gateway/`), updated
  in the same change as the behaviour they describe;
- leave sign-in, people and roles to the platform, and map the roles (and any custom-role permissions) to its own
  functions, as [`AGENTS.md`](AGENTS.md) describes under "Accounts, roles and access";
- use synthetic data only, in code, tests and docs.

Add the app to the table above. Copy `.github/workflows/captable.yml` to `.github/workflows/<app>.yml` and change its
name (to the app's directory name), path filters and `app` input, then add that name to the `workflows` list in
[`release.yml`](.github/workflows/release.yml); CI checks both. Read [`AGENTS.md`](AGENTS.md) for the full checklist.

## Checks

They live in `.github/scripts/`, next to the workflows that run them. Each app workflow runs that app's typecheck,
tests, migration check and Cloudflare build, while repository-wide CI runs the public-content and workflow checks.

- `node .github/scripts/check-insulin-app.mjs <app>` checks that an app keeps the shape the platform expects: file limits, one
  npm package with an exact lockfile, the platform entry points, no unsupported Cloudflare bindings.
- `.github/scripts/workerd-smoke/` runs Cap Table's production build the way Cloudflare does: it builds the app, applies its
  migrations to a local D1 database, starts it in workerd with `wrangler dev --local`, and checks the main paths with
  synthetic data. Run `npm ci` in `captable/` and in `.github/scripts/workerd-smoke/`, then `node smoke.mjs` there (`--skip-build`
  reuses the last build).
- `node .github/scripts/check-public-content.mjs` checks that nothing private is in this public repository: real e-mail
  addresses, local paths, cloud ids and private keys, also when split into string literals joined with `+` (its own
  tests: `node --test .github/scripts/check-public-content.test.mjs`). Names, domains and other terms specific to an
  organization go in a deny list that the maintainer keeps outside the repository and passes with `--deny-list <file>`.

## Releases

Every green merge to `main` is a release, and only releases are deployed. A merge is green when every workflow it
started passed: CI, the workflow of each app it touched, and Gateway when it touched the gateway. Those workflows only
check it. [`release.yml`](.github/workflows/release.yml) then tags the merge's commit with the next version, `v0.1.1`,
then `v0.1.2` and so on, one version for the whole repository, publishes a GitHub Release that lists the workflows that
passed and the pull requests merged since the previous version, and deploys that release with
[`deploy.yml`](.github/workflows/deploy.yml): each app that changed, built from the tag, then the gateway. Each Worker
version carries the release as its tag, so Cloudflare shows which release runs.

- Merges are numbered in the order they reached `main`, each once. One whose workflows are still running holds back
  those after it until it finishes.
- A merge with a failed or cancelled run (as when a newer merge replaces a run still waiting in its queue) gets no
  version; the next green one takes it, and its release lists the pull requests of both.
- A release deploys what changed since the previous one, merges without a version included, but only where the
  latest check passed: an app or the gateway whose latest run failed keeps the version it runs.
- A deploy that fails leaves its release in place: re-run the failed jobs, or run **Actions → Deploy → Run workflow**
  on `main` with the version. The same goes back to an earlier release, unless something it deploys has a migration
  since, which needs the database restored first.
- To start a new minor or major version, an org admin runs **Actions → Release → Run workflow** with it, such as
  `v0.2.0`: `main`'s latest release is released again as that version, and the next merges count on from it.
- Only `release.yml` creates `v*` tags. The "Release tags" ruleset lets nobody else create, move or delete one (org
  admins can bypass it in an emergency); the [hosting runbook](.github/hosting/README.md#owner-setup) sets it up.

`.github/scripts/plan-release.sh` decides what to release and deploy, and `plan-release.test.mjs` tests it against a
fake GitHub; `check-deploy.mjs` checks a deploy before anything is built.

## Contributing

Use synthetic data only (example.com or `.test` addresses, fictional people and companies), and read the repository's
[`AGENTS.md`](AGENTS.md) and the app's own `AGENTS.md` before changing anything.

## License

[MIT](LICENSE). Third-party material is listed in each app's `NOTICE` file.
