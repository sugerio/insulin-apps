# Worker mode

The original Worker (`src/worker.ts`) runs unchanged in three places, configured differently:

| Where | How | Config |
|---|---|---|
| In-process (tests, local harnesses) | `app.fetch(request, env)` with Miniflare bindings | the `env` object passed in |
| Locally on workerd | `npm run dev` (`wrangler dev --local`) | `wrangler.jsonc` top level + `.dev.vars` |
| Cloudflare, shared dev | `node scripts/deploy.ts --target dev` (CI on `main`) | generated from the environment + `wrangler secret` (see Deploy) |
| Cloudflare, prod | `node scripts/deploy.ts --target prod` | the same, for `esign-prod` |

The API, the editor page and the recipient page, and the way a host embeds them in an iframe,
are the same everywhere.

## dev and prod: one switch

`ESIGN_ENV` (`src/environment.ts`) is the one switch: `dev` locally (`wrangler.jsonc`) and on
`esign-dev`, `prod` on `esign-prod`. `scripts/deploy.ts` sets it from the target: `--target prod`
is prod, any other target is dev. Unset means dev. Everything else is a value for the
environment (addresses, origins, keys), never a second switch.

| | dev | prod |
|---|---|---|
| One-time codes and signed copies | to the sink mailbox (`MAIL_SINK`), naming the intended recipient; without a sink, codes only for `example.com` / `*.test` addresses and nothing is emailed | to their recipients |
| Test mailbox (`TEST_MAIL` bucket, `GET /v1/test-mail/:id`) | every code is kept there, for tests to read | not bound; never written or read |
| Seal | KMS + TSA when `KMS_KEY_ARN` is set (`esign-dev`), else the HMAC test seal (`TEST_SEAL_KEY`, local), whose certificate says `LOCAL TEST ONLY` | KMS + TSA only; no fallback |
| Pages that may call the signing API | the Worker's own `/sign`, plus `SIGNING_PAGE_ORIGINS` (local UI development) | the Worker's own `/sign` only |
| Origins that may embed `/sign` | https, or http on a loopback host | https only |
| Signing, `/demo` and the cron | on, once `OTP_KEY` is set and the test mailbox is bound | on, once fully configured; otherwise off, and the cron logs what is missing (`prodProblems`) |

On `esign-dev` the `send_email` binding is pinned to the sink with `destination_address`, so the
Worker cannot mail anyone else even by mistake. On `esign-prod` it is not pinned; confirm on the
first prod deployment that Cloudflare Email Sending delivers to any address from `MAIL_FROM`.

Secrets: `OTP_KEY` (the one-time codes' pepper, both environments), `TEST_SEAL_KEY` (the HMAC test
seal; local only, never needed where KMS is configured), and the AWS credentials of the managed
seal.

prod still needs, outside this switch: counsel's review of the consent wording
(`src/disclosure.ts`), a retention decision, Cloudflare rate limiting on `/v1/signing/otp*` and
`/v1/page-sessions/exchange`, a TSA whose terms allow production use with revocation checking,
and an independent security review (see the README).

## What the Worker does itself

Before, a local harness did these outside the Worker:

- **Serves the recipient signing page** at `GET /sign`. The host asks for a recipient-view code
  (for the Worker's own origin unless the request names another allowed one) and embeds
  `<worker origin>/sign#code=<code>`. Every tenant uses the same signing origin (for example
  `esign.suger.io`); `SIGNING_PAGE_ORIGINS` (space-separated) allows other origins to host the
  page, for local UI development only. The page's `frame-ancestors` lists the origins in
  `SIGNING_PAGE_FRAME_ANCESTORS` (space-separated; only https origins, or http on a loopback
  host, are kept). The page and its assets carry COEP `require-corp` and CORP `cross-origin`,
  so a cross-origin-isolated host can embed it and pdf.js can start its Web Worker. The Worker
  tells the page, with `<meta name="esign-api">`, that its own origin serves the API; a copy of
  the page on any other origin stays closed. Browsers send no `Origin` on the page's
  same-origin GETs, so the signing API then takes the origin from `Sec-Fetch-Site: same-origin`,
  which only the browser sets. Closed (404) unless local test signing is enabled.
- **Prepares envelopes when they are created.** `POST /v1/envelopes` copies the template's
  source to the envelope's initial document, activates the first signer and creates the envelope
  `IN_PROGRESS`, in the same request. The envelope id is derived from the tenant and the
  `Idempotency-Key`, so a retried creation reuses the document a failed attempt stored. The old
  `POST /v1/envelopes/:id/prepare` is deprecated and does nothing (204 for an envelope of the
  tenant, 404 otherwise).
- **Finishes envelopes.** A signature is saved first, as one row of the `signatures` table
  (`PENDING`; see "How a signature is stored" in [README.md](README.md)), and its PDF is
  rendered later from that row alone. With `COMPLETE_AFTER_SIGN=true`, each accepted signature is
  rendered in the background (`waitUntil`) and, after the last one, the envelope is sealed and
  becomes `COMPLETED`. A cron trigger (`*/5 * * * *`) retries any envelope this did not finish,
  and is the only way envelopes finish while `COMPLETE_AFTER_SIGN` is off; a signature that fails
  to render keeps a count of attempts and its last error. Each step commits with one conditional
  write and the updates after it are idempotent, so both also finish an envelope a lost write left
  half-advanced (a signed task still `ACTIVE`, a next task still `PENDING`, an envelope still
  `IN_PROGRESS` or, with its seal recorded, still `FINALIZING`); see "How writes commit" in
  [README.md](README.md). There is no endpoint to request either step.
- **Hands back test one-time codes.** `GET /v1/test-mail/:messageId`, with the tenant's
  management key, returns `{to, otp}` for a code sent to one of that tenant's recipients (404
  for any other tenant). The recipient page does not show the message ID; test scripts read it
  from the code form's `data-test-message-id` attribute.
- **Registers tenants.** `scripts/provision-tenant.ts` adds a tenant, a new management key (only
  its SHA-256 is stored; the key is written once to a 0600 file and never printed), and the host
  origins allowed to embed the editor. Repeating it with a new key
  file adds a second key (rotation); revoke old keys by setting `api_keys.revoked_at`.

## Managed seal (KMS + TSA)

With `KMS_KEY_ARN` set (both deployments; required in prod), an envelope is completed with a
managed seal instead of the local HMAC test seal (`src/managed-seal.ts`, `src/managed-evidence.ts`):

1. The evidence manifest is rebuilt from the stored signatures after checking the whole chain
   (source, every signature's event hash and its link to the one before, every rendered PDF
   rendered again byte for byte, every file hash), as for the local seal. It includes each
   signature's facts and what was drawn (`esign-evidence-manifest-v1`).
2. An AWS KMS key signs it (ECDSA P-256 over a SHA-256 digest of a domain-separated message);
   the signature must verify with the pinned public key `KMS_PUBLIC_KEY`.
3. DigiCert's public TSA timestamps that signature (RFC 3161, nonce bound); the response must
   verify against the root, signer and policy fixed in `src/tsa-trust.ts`.
4. The seal is stored once in R2 (`envelopes/<id>/managed-evidence.json`) and recorded in
   `seals` (`mode` `KMS_TSA`, with the key ARN and the time of the timestamp; the local test
   seal has `mode` `LOCAL_TEST`); the envelope becomes `COMPLETED`. A retry reuses a stored seal.
5. The certificate (`mode: KMS_TSA`) and the delivery PDF verify the seal again on every read,
   against the manifest rebuilt from the records.

The Worker reaches KMS with temporary credentials: it holds the key of an IAM user that may
only assume one role, and that role may only sign with this key (`scripts/aws-dev-signer.sh`).
Envelopes completed earlier with the local seal keep their local certificate.

Not done yet: certificate revocation of the TSA is not checked; DigiCert's terms for its free
TSA are not confirmed for production; the signed PDF has no embedded (PAdES) signature; key
rotation means adding the old key's SPKI SHA-256 to `KMS_TRUSTED_KEY_SHA256`.

## Audit trail, consent and signed copies (ESIGN / UETA)

* **Audit trail** (`src/audit.ts`, table `audit_events`, append-only by trigger): the signing
  link issued, the signing page opened, each code sent (to whom, how), the code verified, the
  document viewed, the signature, completion, and each signed copy sent, each with the time and,
  for the signer's own steps, the IP Cloudflare saw (`CF-Connecting-IP`) and the browser's user
  agent. The managed seal covers the trail up to sealing (`esign-sealed-evidence-v2`); events
  after it are listed as recorded after sealing. The certificate (JSON and page) and the
  delivery PDF show it.
* **Consent** (`src/disclosure.ts`): the signing page shows the server's consent to use
  electronic records and signatures; signing sends its version, a stale version is refused
  (409 `disclosure_changed`), and the signature's facts and audit event record the version and
  the SHA-256 of the text. **The wording is a draft for counsel to review.**
* **Signed copies** (`src/signed-copies.ts`): once completed, each signer is emailed the delivery
  PDF (the signed document followed by its certificate), once; failed sends are retried by the
  cron. On dev every copy goes to the sink mailbox, like the codes.

## Try it: /demo

`<worker origin>/demo` drives the whole flow from one page on the Worker's own origin: paste a
tenant management key (kept only in that tab's sessionStorage), upload a synthetic PDF, choose
a signature page added after the last page or signature fields placed in the editor, add one or
two signers with any addresses, then sign each signer's page embedded below. Codes go to the
sink mailbox. Once the Worker completes the envelope, view the signed PDF, the PDF with the
certificate, and the completion certificate. The tenant must list the Worker's own origin as a
console origin (for the editor): `--console-origin <worker origin>` when provisioning it.
Closed (404) unless local test signing is enabled; never framed by another site.

## Run it locally

```sh
npm ci
npx vite build                       # dist-ui: the recipient page, editor and assets
npm run db:migrate:local
cp -n .dev.vars.example .dev.vars    # synthetic test keys; never deploy them
node scripts/provision-tenant.ts --tenant <tenant id> \
  --console-origin http://localhost:3000 \
  --key-file <path outside the repo> --local
npm run dev -- --test-scheduled      # 127.0.0.1:8787; /__scheduled runs the cron once
```

A host product's console then uses `http://127.0.0.1:8787` as the E-sign base URL and
`http://127.0.0.1:8787/sign` as the signing page URL, with the key from the key file.
`SIGNING_PAGE_FRAME_ANCESTORS` in `wrangler.jsonc` must list the host's origin.

## Deploy

Deployments are not described in this repository. `scripts/deploy.ts` generates the Wrangler
configuration of `esign-<target>` for one run (into `.deploy/`, ignored) from the environment:
every resource is named after the target (`esign-dev`: Worker, D1 database, R2 buckets
`esign-dev-artifacts` and `esign-dev-test-mail`; `esign-prod` has no test mailbox bucket), the D1
id is looked up by name, and the settings below come from environment variables. The target
decides `ESIGN_ENV` (see "dev and prod: one switch"). It refuses to deploy while a required secret is
missing on the Worker, applies new migrations, then deploys.

| Setting | Environment variable (CI: repository or `production` environment variable) |
|---|---|
| Cloudflare account and token | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (CI: the same as the apps) |
| Sender of every message (a Cloudflare Email Sending domain) | `ESIGN_MAIL_FROM` (`ESIGN_DEV_MAIL_FROM`) |
| dev only: the one mailbox that receives every message (refused for prod) | `ESIGN_MAIL_SINK` (`ESIGN_DEV_MAIL_SINK`) |
| Origins allowed to embed `/sign` (space-separated; https only for prod) | `ESIGN_FRAME_ANCESTORS` (`ESIGN_DEV_FRAME_ANCESTORS`) |
| Managed seal: KMS key ARN, its public key (base64 SPKI), the signing role | `ESIGN_KMS_KEY_ARN`, `ESIGN_KMS_PUBLIC_KEY`, `ESIGN_AWS_ROLE_ARN` (`ESIGN_DEV_*`) |

Secrets stay on the Worker and never pass through the deploy: `OTP_KEY` (random, set once with
`wrangler secret put OTP_KEY --name esign-<target>`) and `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY` (set by `scripts/aws-dev-signer.sh` for dev). A deployed Worker seals with
KMS and TSA, so it needs no `TEST_SEAL_KEY`.

* **CI:** `.github/workflows/esign.yml` deploys `esign-dev` on a push to `main` (or a manual run on
  `main`) once the repository variable `ESIGN_DEV_DEPLOY` is `true`. The checks job builds the
  bundle and pages without any credential; the `deploy-dev` job, in the `production` environment,
  checks that archive, then runs `node scripts/deploy.ts --target dev --bundle ... --assets ...`.
* **By hand** (only with authorization for that account, and only with synthetic data): set the
  variables above, then `npm run build && node scripts/deploy.ts --target dev --bundle dist`
  (`--dry-run` shows the bindings without deploying).
* **First deployment of a target:** create its D1 database and R2 buckets once
  (`wrangler d1 create esign-<target>`, `wrangler r2 bucket create ...`), set the secrets, then deploy.
* **A host organization:** `node scripts/deploy.ts --target dev --config-only`, then
  `node scripts/provision-tenant.ts --tenant <org id> --console-origin <host console origin>
  --key-file <path> --remote --config .deploy/wrangler.dev.json`,
  and give the host the key, the Worker origin as base URL and `<Worker origin>/sign` as the
  signing page URL.
* **Never rotate the seal secret** while envelopes sealed with it should stay verifiable: the
  certificate check recomputes the seal with the current key.

Notes from the first deployment:

* `insulinapps.com` receives its own mail through the registrar's forwarding (apex MX). Do not
  enable Cloudflare Email *Routing* on the apex: it replaces those MX records. Email *Sending*
  only uses `cf-bounce.insulinapps.com` records and leaves the apex alone.
* A cron trigger can take up to 15 minutes to start after it is first deployed or changed;
  `wrangler tail esign-dev` shows each run (`"cron": "*/5 * * * *"`).
* `/__scheduled` exists only under `wrangler dev`; it is 404 on Cloudflare.
* Signing endpoints have no rate limiting of their own here; put Cloudflare rate limiting rules
  on `/v1/signing/otp*` and `/v1/page-sessions/exchange` before inviting anyone outside the team.
