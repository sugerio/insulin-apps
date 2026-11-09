# E-sign CI

`.github/workflows/esign.yml` runs on pull requests and `main` pushes that change E-sign, its workflow or the shared scripts, and manually. It has two jobs.

**`checks`** has read-only repository permission and no secrets. It installs from the lockfile with Node 24, checks types, runs the full suite serially (the default parallel suite has previously exhausted local loopback ports), and builds the single Worker (`src/worker.ts`) and its pages with Wrangler's **dry-run**. The Ubuntu runner must provide `/usr/bin/google-chrome`; CI fails if it is absent, and the TAP results must show each named browser case and the migration test passing rather than skipped. The job times out after 60 minutes; failures keep their actual output and must be investigated, not assumed to be port exhaustion. Tests use synthetic data and local fakes, not actual mail, KMS or a TSA. Only when the dev deployment is enabled (a `main` push or manual run on `main` with the repository variable `ESIGN_DEV_DEPLOY` set to `true`) does it pack `dist/worker.js` and `dist-ui` into the three-day `esign-dev-build` artifact, rejecting links and special files.

**`deploy-dev`** runs only in that case, after `checks`, in the `production` environment. It treats the archive as untrusted: it checks the member paths before unpacking, then runs `node scripts/deploy.ts --target dev` against the unpacked bundle without rebuilding. [WORKER-MODE.md](WORKER-MODE.md) describes the settings and secrets it needs.

The migration test uses a temporary local Wrangler state, checks a fresh ordered migration, a no-op rerun, and an invalid migration remaining failed on rerun. It does not establish upgrade safety for existing databases or prove every possible migration failure is atomic. Worker rollback does not undo D1/R2 changes, sent mail or signing facts; see the deployment runbook for stop and recovery prerequisites.

Do not add secrets, local state, `.dev.vars`, sessions or real data to builds or logs. A successful local run is not proof that GitHub CI ran.
