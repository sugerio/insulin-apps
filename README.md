# Insulin Apps

Open-source apps for Insulin. Each app is one directory: a complete, ordinary npm project that you can start from in
the Insulin console, and that the Insulin AppBuilder can change, preview and publish to Cloudflare Workers with its own
D1 database.

| App | What it does |
|---|---|
| [`captable/`](captable/) | Cap table and equity management: stakeholders, share classes, equity plans, option grants, vesting, exercises, terminations, 409A valuations, documents and a holder view, set up by importing Pulley's reports or a spreadsheet template. |

## Use the apps online

Every app here also runs at its own address on insulinapps.com, for example [Cap Table](https://captable.insulinapps.com).
Sign up with an e-mail address or Google, create an organization and invite your team. Maintainers run it with the
[hosting runbook](.github/hosting/README.md).

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
- use synthetic data only, in code, tests and docs.

Add the app to the table above. Copy `.github/workflows/captable.yml` to `.github/workflows/<app>.yml` and change its
name, path filters and `app` input; CI checks this pairing. Read [`AGENTS.md`](AGENTS.md) for the full checklist.

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

## Contributing

Use synthetic data only (example.com or `.test` addresses, fictional people and companies), and read the repository's
[`AGENTS.md`](AGENTS.md) and the app's own `AGENTS.md` before changing anything.

## License

[MIT](LICENSE). Third-party material is listed in each app's `NOTICE` file.
