# Insulin Apps

Open-source apps for Insulin. Each app is one directory: a complete, ordinary npm project that you can start from in
the Insulin console, and that the Insulin AppBuilder can change, preview and publish to Cloudflare Workers with its own
D1 database.

| App | What it does |
|---|---|
| [`captable/`](captable/) | Cap table and equity management: stakeholders, share classes, equity plans, option grants, vesting, exercises, terminations, 409A valuations, documents and a holder view, set up by importing Pulley's reports or a spreadsheet template. |

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

## Checks

CI runs these with each app's typecheck, tests, migration check and Cloudflare build.

- `node scripts/check-insulin-app.mjs <app>` checks that an app keeps the shape the platform expects: file limits, one
  npm package with an exact lockfile, the platform entry points, no unsupported Cloudflare bindings.
- `tools/workerd-smoke/` runs Cap Table's production build the way Cloudflare does: it builds the app, applies its
  migrations to a local D1 database, starts it in workerd with `wrangler dev --local`, and checks the main paths with
  synthetic data. Run `npm ci` in `captable/` and in `tools/workerd-smoke/`, then `node smoke.mjs` there (`--skip-build`
  reuses the last build).
- `node scripts/check-public-content.mjs` checks that nothing private is in this public repository: real e-mail
  addresses, local paths, cloud ids and private keys, also when split into string literals joined with `+` (its own
  tests: `node --test scripts/check-public-content.test.mjs`). Names, domains and other terms specific to an
  organization go in a deny list that the maintainer keeps outside the repository and passes with `--deny-list <file>`.

## Contributing

Use synthetic data only (example.com or `.test` addresses, fictional people and companies), and read the app's
`AGENTS.md` before changing it.

## License

[MIT](LICENSE). Third-party material is listed in each app's `NOTICE` file.
