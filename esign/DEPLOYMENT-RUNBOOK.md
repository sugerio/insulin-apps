# Isolated Cloudflare preparation (not deployment approval)

E-sign runs as one Worker, `src/worker.ts`. How it is configured, deployed (`scripts/deploy.ts`) and given tenants (`scripts/provision-tenant.ts`) is described in [WORKER-MODE.md](WORKER-MODE.md). The earlier candidate Worker, its three gateways, the consolidated Worker, the Access-protected internal demo and their deployment templates and worksheets were removed. Do not deploy, create or change cloud resources, migrate a database, send email, or call a TSA without separate explicit authorization. Use synthetic documents and identities only.

## Stop and rollback planning

Disable Worker ingress first, revoke affected credentials and stop issuing sessions under an approved incident process. Preserve D1 rows and R2 objects for investigation; disabling a route does not revoke already issued credentials or undo writes. Do not automatically delete orphaned objects, reservations or retained facts, and do not infer delivery or completion from a lost response. Establish separately authorized recovery, monitoring, audit and retention procedures before any cloud operation. No production readiness or finalization is implied.

## Schema inventory for a fresh isolated database

Review and apply **all** migrations in filename order starting at 0001. Before the first deployment, migrations that only created tables for removed code (the candidate topology, the internal demo, the isolated OTP sender, the synthetic TSA test, the legacy editor prototype, the candidate editor bindings and the recipient code and session revocations) were deleted rather than dropped by a new migration; the separate recipient codes, recipient page sessions and editor page tokens were replaced in place by the shared `access_codes` and `access_sessions` (0005), the editor page entries became `editor_sessions` (0015, editing state only), and the editor column additions (0018, 0019) and the unused code expiry indexes (0028) were folded in or removed; the recipient OTP challenges and verifications and their column additions (0009, 0025) were replaced in place by the single `otp_challenges` (0006), with the verification recorded on the recipient session (`access_sessions.otp_verified_at`); the eight earlier signing tables were replaced in place by the single `signatures` table (0007) and the local test and managed evidence tables by `seals` (0010); the three single-column batch guard tables, and the `assertions` table (an earlier 0005) that replaced them, were removed because every write now carries its own conditions (see "How writes commit" in [README.md](README.md)); the `idempotency_keys` table (0003) was removed because the envelope, whose id is derived from the tenant and the `Idempotency-Key`, keeps the creating request's hash (`envelopes.request_sha256`); the `editor_allowed_origins` table (0013) was removed because each tenant keeps its editor origins as a JSON array (`tenants.editor_origins_json`, 0001). The numbering therefore has gaps; Wrangler applies the remaining files in name order. Verify the migration ledger and schema privately; never apply this to an existing retained database as an assumed upgrade. The sequence currently ends at 0049 and creates 14 tables. Optional facts about envelopes and tasks live in their `details_json` columns (0003), not in tables of their own:

| Versions | Reviewed purpose |
| --- | --- |
| 0001 | Tenants, with the origins allowed to embed the editor (`tenants.editor_origins_json`), and management keys (`tenants`, `api_keys`) |
| 0002 | Templates (`templates`) |
| 0003 | Envelopes and tasks (`envelopes`, `tasks`); an envelope is created `IN_PROGRESS`, already prepared, and keeps the hash of the request that created it (`request_sha256`), which makes `POST /v1/envelopes` idempotent |
| 0004 | Artifacts: each envelope's initial document, D0 (`artifacts`) |
| 0005 | One-time access codes and the sessions they open, for the signing page (scope `recipient`) and the editor (scope `editor`) (`access_codes`, `access_sessions`); a recipient session records when it entered the emailed code (`otp_verified_at`) |
| 0006 | The emailed one-time code of each recipient task, with its send and entry budgets (`otp_challenges`) |
| 0007 | Signatures: one row per accepted signature (facts and rendering as JSON, hash-chained); triggers allow only the rendering state to change and refuse deletes |
| 0010 | Seals of completed envelopes (`seals`): `mode` `LOCAL_TEST` or `KMS_TSA`, the seal object and its hash, and for `KMS_TSA` the key ARN and the time of the timestamp |
| 0015, 0016 | Editor sessions: tenant, allowed parent, source template or staged source and result (`editor_sessions`); template fields |
| 0027 | Trigger: a task's recipient email is immutable |
| 0049 | Audit trail (`audit_events`) and signed copy deliveries (`copy_deliveries`) |

Inspect the SQL and dependencies, record the exact reviewed revision and migration ledger in the private change record, and stop on any mismatch. There is no authorized remote migration in this runbook; an authorized deployment applies pending migrations through `scripts/deploy.ts` ([WORKER-MODE.md](WORKER-MODE.md#deploy)). Never place account identifiers, resource identifiers, credentials or populated private configurations in this repository.

## Management credentials

Tenants and their management keys are added with `scripts/provision-tenant.ts`, locally
(`--local`, see "Run locally" in [README.md](README.md#run-locally)) or, with authorization for that
account, against a deployment's D1 database (`--remote --config ...`, see "A host organization" in
[WORKER-MODE.md](WORKER-MODE.md#deploy)). It writes the new key once to `--key-file` (mode 0600,
never overwritten, never printed) and registers only its SHA-256; `--dry-run` prints the SQL. A
management key grants tenant-wide management access; it is not a browser credential, and the host
backend must authorize each caller and tenant before using it. Revoke a key by setting
`api_keys.revoked_at`; no endpoint provisions, elevates or revokes keys. If the result of a remote
run is uncertain, stop, inspect `tenants` and `api_keys` without displaying hashes, and do not
repeat it blindly: each run registers a new key.
