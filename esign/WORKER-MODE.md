# Worker mode

The original Worker (`src/worker.ts`) runs unchanged in three places, configured differently:

| Where | How | Config |
|---|---|---|
| In-process (tests, local harnesses) | `app.fetch(request, env)` with Miniflare bindings | the `env` object passed in |
| Locally on workerd | `npm run dev` (`wrangler dev --local`) | `wrangler.jsonc` top level + `.dev.vars` |
| Cloudflare, shared dev | `node scripts/deploy.ts --target dev` (CI on `main`) | generated from the environment + `wrangler secret` (see Deploy) |

The API, the editor page and the recipient page, and the way a host embeds them in an iframe,
are the same in all three.

**This is still LOCAL TEST MODE, wherever it runs.** Only synthetic documents; the seal is the
local HMAC test seal and the certificate says `LOCAL TEST ONLY`. It provides no production
evidence protection. One-time codes are stored in the `TEST_MAIL` bucket, and:

* without a sink (local default), only `example.com` / `*.test` addresses get a code, and
  nothing is emailed;
* with a sink (`OTP_MAIL_SINK`, the dev deployment), a code is accepted for **any** address and
  really emailed, but **only to the sink mailbox**, never to the recipient. The email names the
  intended recipient. The `send_email` binding is pinned to the sink with `destination_address`,
  so the Worker cannot mail anyone else even by mistake.

Email to real recipients, a KMS/TSA seal and a reviewed verified-user boundary are separate
work (see the README).

## What the Worker does itself

Before, a local harness did these outside the Worker:

- **Serves the recipient signing page** at `GET /sign`. The host asks for a recipient-view code
  with `origin` set to the Worker's own origin (registered in `tenant_page_origins`) and embeds
  `<worker origin>/sign#code=<code>`. The page's `frame-ancestors` lists the origins in
  `SIGNING_PAGE_FRAME_ANCESTORS` (space-separated; only https origins, or http on a loopback
  host, are kept). The page and its assets carry COEP `require-corp` and CORP `cross-origin`,
  so a cross-origin-isolated host can embed it and pdf.js can start its Web Worker. The Worker
  tells the page, with `<meta name="esign-api">`, that its own origin serves the API; a copy of
  the page on any other origin stays closed. Browsers send no `Origin` on the page's
  same-origin GETs, so the signing API then takes the origin from `Sec-Fetch-Site: same-origin`,
  which only the browser sets. Closed (404) unless local test signing is enabled.
- **Finishes envelopes.** With `COMPLETE_AFTER_SIGN=true`, each accepted signature is processed
  in the background (`waitUntil`) and, after the last one, the envelope is sealed and becomes
  `COMPLETED`. A cron trigger (`*/5 * * * *`) retries any envelope this did not finish. Both
  use the same code as `POST /v1/envelopes/:id/process` and `/finalize`, which still work.
- **Hands back test one-time codes.** `GET /v1/test-mail/:messageId`, with the tenant's
  management key, returns `{to, otp}` for a code sent to one of that tenant's recipients (404
  for any other tenant). The recipient page does not show the message ID; test scripts read it
  from the code form's `data-test-message-id` attribute.
- **Registers tenants.** `scripts/provision-tenant.ts` adds a tenant, a new management key (only
  its SHA-256 is stored; the key is written once to a 0600 file and never printed), the host
  origins allowed to embed the editor, and the signing page origin. Repeating it with a new key
  file adds a second key (rotation); revoke old keys by setting `api_keys.revoked_at`.

## Managed seal (KMS + TSA)

With `SEAL_MODE=KMS_TSA` (the dev deployment), an envelope is completed with a managed seal
instead of the local HMAC test seal (`src/managed-seal.ts`, `src/managed-evidence.ts`):

1. The evidence manifest is rebuilt from the stored records after checking the whole chain
   (source, every signing event, every output and file hash), as for the local seal.
2. An AWS KMS key signs it (ECDSA P-256 over a SHA-256 digest of a domain-separated message);
   the signature must verify with the pinned public key `KMS_PUBLIC_KEY`.
3. DigiCert's public TSA timestamps that signature (RFC 3161, nonce bound); the response must
   verify against the root, signer and policy fixed in `src/tsa-trust.ts`.
4. The seal is stored once in R2 (`envelopes/<id>/managed-evidence.json`) and recorded in
   `managed_evidence`; the envelope becomes `COMPLETED`. A retry reuses a stored seal.
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
  (409 `disclosure_changed`), and the signature's audit event records the version and the
  SHA-256 of the text. **The wording is a draft for counsel to review.**
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
  --console-origin http://localhost:3000 --page-origin http://127.0.0.1:8787 \
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
`esign-dev-artifacts` and `esign-dev-test-mail`), the D1 id is looked up by name, and the
settings below come from environment variables. It refuses to deploy while a required secret is
missing on the Worker, applies new migrations, then deploys.

| Setting | Environment variable (CI: repository or `production` environment variable) |
|---|---|
| Cloudflare account and token | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (CI: the same as the apps) |
| Sender of every message (a Cloudflare Email Sending domain) | `ESIGN_MAIL_FROM` (`ESIGN_DEV_MAIL_FROM`) |
| The one mailbox that receives every message | `ESIGN_MAIL_SINK` (`ESIGN_DEV_MAIL_SINK`) |
| Origins allowed to embed `/sign` (space-separated) | `ESIGN_FRAME_ANCESTORS` (`ESIGN_DEV_FRAME_ANCESTORS`) |
| Managed seal: KMS key ARN, its public key (base64 SPKI), the signing role | `ESIGN_KMS_KEY_ARN`, `ESIGN_KMS_PUBLIC_KEY`, `ESIGN_AWS_ROLE_ARN` (`ESIGN_DEV_*`) |

Secrets stay on the Worker and never pass through the deploy: `LOCAL_TEST_OTP_KEY` and
`LOCAL_TEST_SEAL_KEY` (random, set once with `wrangler secret put <name> --name esign-dev`), and
`AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (set by `scripts/aws-dev-signer.sh`).

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
  --page-origin <Worker origin> --key-file <path> --remote --config .deploy/wrangler.dev.json`,
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
