# E-sign

E-sign is an independent electronic signature service: one Cloudflare Worker with D1, R2 and
Email Sending. A host product (for example Suger's backend) creates templates and envelopes with a
tenant management key, embeds the template editor and the recipient signing page in its own pages,
and polls envelopes for their status. The Worker verifies each signer by an emailed one-time code,
records the signature, renders the signed PDF, seals the finished envelope and emails each signer a
copy.

**Status: experimental.** It is not yet an Insulin AppBuilder app (see the repository's
`AGENTS.md`). It runs locally and deploys as `esign-dev` and `esign-prod`
([WORKER-MODE.md](WORKER-MODE.md)), but the open items at the end of this page block real
documents. Use synthetic documents and identities only, and do not deploy or change cloud resources
without authorization.

Related documents: [WORKER-MODE.md](WORKER-MODE.md) (configuration, dev and prod, deployment),
[DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md) (migrations, management credentials, stop and rollback),
[CI.md](CI.md) (the workflow), [PROGRESS.md](PROGRESS.md) (history).

## Architecture

- **One Worker**, `src/worker.ts` (Hono). It serves the management API, the signing API, the editor
  API, the recipient signing page (`/sign`), the editor page (`/editor/page/:id`), a demo page
  (`/demo`) and the built page assets (`dist-ui`, through the `ASSETS` binding). Signing routes are
  in `src/signing-routes.ts`, editor routes in `src/editor-routes.ts`.
- **Storage**: D1 (`DB`) holds every record (14 tables, below); R2 (`ARTIFACTS`) holds PDFs,
  rendered field images, seals and delivery PDFs. Only dev binds a second bucket, the test mailbox
  (`TEST_MAIL`).
- **One switch**, `ESIGN_ENV` (`src/environment.ts`): `dev` locally and on `esign-dev`, `prod` on
  `esign-prod`. It decides where mail goes, whether codes are kept in the test mailbox, which seals
  are allowed and which origins may host or embed the signing page. The table is in
  [WORKER-MODE.md](WORKER-MODE.md#dev-and-prod-one-switch). Signing (the signing API and page,
  `/demo`, recipient views, certificates and the cron) is on only once the environment is fully
  configured (`signingEnabled`); otherwise those routes answer 404 and the cron does nothing.
- **Background work**: a signature is saved first and its PDF rendered afterwards. With
  `COMPLETE_AFTER_SIGN=true` (set locally and by the deploy) the Worker renders it in the
  background after the response (`waitUntil`) and seals the envelope after the last one. A cron
  trigger every five minutes expires envelopes past a deadline, finishes any envelope the
  background work did not (25 at random per run), and retries signed copies that were not sent.
  There is no endpoint to request any of these steps.
- **Pages** (`ui/`, built by Vite into `dist-ui`): the recipient page (`index.html`,
  `RecipientPage.ts`), the field editor (`editor.html`, `FieldEditor.ts`) and the demo
  (`demo.html`, `DemoPage.ts`). Both the recipient page and the editor draw PDFs with `ui/pdf.ts`.
- **Code layout** (`src/`): placed fields in `fields.ts` (validation, PDF checks, capture at
  signing) and `field-render.ts` (field images, geometry, preview receipts, the renderer table and
  the appended signature page), with the bitmap font atlases in `fonts/`; the seals in `seal/`
  (`evidence.ts`, `local.ts`, `managed.ts`, `kms.ts`, `tsa.ts`, `config.ts`; see "Evidence, hash
  chain and seals"); the emailed code in `otp.ts`.

## The signing lifecycle

1. **Template.** The host uploads a PDF (`POST /v1/templates`, multipart `file` and `roles`), or
   opens the embedded editor to place fields on one (see "Embedded editor"). A template without
   placed fields is signed on an appended signature page; one with placed fields is signed in those
   fields.
2. **Envelope.** `POST /v1/envelopes` with an `Idempotency-Key` header names the template and one
   recipient per role (name, email, optional deadline, title, company, who named them), plus an
   optional document name and sender. It prepares the envelope in the same request: the template's
   source is copied to the envelope's initial document (D0, `envelopes/<id>/d0.pdf`), the first
   recipient's task becomes `ACTIVE`, and the envelope is created `IN_PROGRESS`. Recipients sign in
   routing order.
3. **Recipient view.** For the active task the host calls
   `POST /v1/envelopes/:id/tasks/:taskId/recipient-view` and embeds
   `<worker origin>/sign#code=<code>`. The page exchanges the code for a page session.
4. **Review, confirm, sign.** The page has three steps: **Review** (the document, its fingerprint,
   page count and download, and the signer's title and authority when the host named a company),
   **Confirm it's you** (a six-digit code emailed for the task) and **Sign** (the fields, the
   consent disclosure and the intent statement). Reading the document needs only the page session;
   previews, declining and signing also need the code.
5. **Rendering.** The signature row is saved `PENDING`; rendering draws the input PDF with exactly
   what the row records, stores the output and marks the row `DONE`. The next recipient's task then
   becomes `ACTIVE`, so each signer signs the previous signer's rendered PDF.
6. **Sealing.** After the last signature is rendered the envelope becomes `FINALIZING`, is sealed
   and becomes `COMPLETED`; each signer is then emailed the delivery PDF (the signed PDF followed by
   its certificate of completion).

Envelope statuses: `IN_PROGRESS`, `FINALIZING`, `COMPLETED`, and the three ends before completion:
`VOIDED` (the host voided it), `DECLINED` (the active signer declined, with a reason) and `EXPIRED`
(a recipient's deadline passed before they signed; a recipient who has signed is past their
deadline's reach). Every signing path requires `IN_PROGRESS`. Task statuses: `PENDING`, `ACTIVE`,
`SIGNED`.

### Fields and rendering

Two ways to sign:

- **Without placed fields**: each signer gets a block (name and signing time) on a shared
  signature page appended to the document, eight blocks to a page, drawn in Helvetica. Recipient
  names that Helvetica cannot draw, or that are too wide at the fixed size, are refused when the
  envelope is created (`422 unsupported_recipient_name`) and checked again before each signature.
- **With placed fields**: Signature, Date signed and Title only, at most 20 fields per template,
  and every role needs a Signature field (the editor requires exactly one per role). Envelope
  creation refuses other field types and overlapping fields (`422
  positioned_fields_not_supported`). The PDF must have unrotated, uncropped pages with a zero
  media-box origin, default units, no annotations and no form; each field is at least 20 × 10
  points.

| Field | What is drawn |
| --- | --- |
| Signature | The typed text (Latin letters and single spaces, 1–64 characters) rendered on the server from a bundled Caveat bitmap atlas (`caveat-bitmap-v2`), 30 points high. It may extend to the right of its box but not off the page or over another field. Typed text is not the authenticated recipient name |
| Title | The title the signer gave on Review (printable ASCII, at most 128 characters), 27-point text that must fit its box |
| Date signed | The server's UTC date when the signature is accepted, 27-point text that must fit its box |

Every field is previewed through `POST /v1/signing/preview` with `{fieldId, text}` (no `text` for
Date signed). It returns the PNG that will be drawn, with its size relative to the box
(`X-Signature-Width`/`-Height` or `X-Text-Width`/`-Height`) and, for Signature and Title, a receipt
(`X-Signature-Preview`, `X-Text-Preview`) that binds the input, the template, the field, the text,
the image and its geometry. The sign request sends back the receipts and the dates the page showed
(`datePreviews`); a date that changed in between (after midnight UTC) is refused with
`409 date_changed` and the page shows the new date. A refused preview is `422`
(`signature_does_not_fit`, `title_does_not_fit` or `invalid_preview`). Clients never send images.
The receipts show what the server rendered, not that a person looked at it.

A signature records each field's renderer name and atlas hash (`src/field-render.ts`);
rendering and every later re-verification fail closed if the running renderer differs.

### Signing for a company, deadlines and certificates

- A recipient may carry `title` (at most 128 characters), `onBehalfOf` (the company, at most 200)
  and `namedBy` (at most 300, who named this signer); the envelope may carry `documentName` (at
  most 200) and `sender` (`{name, email?, organization?}`). With `onBehalfOf`, the page shows the
  intent statement ("I intend this to be my signature on <document> on behalf of <company>."),
  prefills the title, and the sign request needs a title and `authorityConfirmed: true`.
- A recipient may carry `expiresAt` (ISO 8601, in the future, within 400 days). Expiry is applied
  before any request touches the envelope and by the cron, with one `EXPIRED` audit event.
- A recipient-view request may carry `hostAuthentication` (`{method, provider?, domain?,
  signedInAt?}`, `method` an upper-case word such as `SSO`): how the host signed the recipient in.
  E-sign cannot check it; it is recorded and printed as the host's statement.
- Certificates are versioned per envelope (`certificateVersion` in `envelopes.details_json`, now 2;
  none means 1). A certificate is rebuilt on every read and must come out the same, so each
  envelope keeps the layout it was created with. Change the layout only by adding a version.

## Data model

Migrations are in `migrations/` (applied in name order; the numbering has gaps). A fresh database
has these 14 tables:

| Table | Migration | Holds |
| --- | --- | --- |
| `tenants` | 0001 | A tenant id, typically the host's organization id, and `editor_origins_json`: the host origins allowed to frame the editor |
| `api_keys` | 0001 | SHA-256 of each management key, its tenant and `revoked_at` |
| `templates` | 0002, 0016 | The source PDF's R2 key, `roles_json` and `fields_json` (placed fields; `[]` for none) |
| `envelopes` | 0003 | Tenant, template, status, creation time, `request_sha256`, `details_json` |
| `tasks` | 0003, 0027 | One per recipient: role, name, email (immutable by trigger), routing order, status, `expires_at`, `details_json` |
| `artifacts` | 0004 | Each envelope's initial document (D0): R2 key and SHA-256 |
| `access_codes` | 0005 | One-time page codes (hashed) with scope, tenant, subject, origin, expiry, `used_at` |
| `access_sessions` | 0005 | Page sessions (hashed tokens) with the same fields and `otp_verified_at` |
| `otp_challenges` | 0006 | One row per task: the hashed emailed code, its expiry and use, and the send and entry budget |
| `signatures` | 0007 | One row per accepted signature (below) |
| `seals` | 0010 | One per completed envelope: `mode` (`LOCAL_TEST` or `KMS_TSA`), the seal's R2 key and hash, and for `KMS_TSA` the key ARN and timestamp time |
| `editor_sessions` | 0015 | One editing session: tenant, parent origin, source template and its hash or staged PDF and its hash, preset roles, the saved template |
| `audit_events` | 0049 | Append-only (triggers refuse updates and deletes): type, time, task, IP, user agent, detail |
| `copy_deliveries` | 0049 | One per signer of a completed envelope: when its signed copy was reserved and sent |

JSON columns. A new optional fact about an envelope or task needs no new table or column: readers
of `details_json` keep only known keys of the expected types. A fact that queries filter on is a
real column (`tasks.expires_at`).

- `envelopes.details_json`: `documentName`, `sender`, `certificateVersion` (`src/details.ts`).
- `tasks.details_json`: `title`, `onBehalfOf`, `namedBy`.
- `signatures.facts_json` (`"version": 1`): who signed and how they were identified: the task,
  role, recipient name, the email the code was verified for (the task's), the page session hash,
  when the code was entered, when the signer consented, the input artifact, the consent
  disclosure's version and SHA-256, and the title, company and intent hash, if any.
- `signatures.render_json` (`"version": 1`): what is drawn and where. `"kind": "appended-page"`:
  the slot, input page count, name, printed time and renderer. `"kind": "fields"`: every placed
  field of the document at signing and, for each of the signer's fields, its value, renderer name
  and hash, image hash and geometry.
- `tenants.editor_origins_json`: a JSON array of the bare origins (https, or http on `localhost`
  or `127.0.0.1`) allowed to frame the editor, `[]` by default; a CHECK refuses anything but a
  JSON array. `scripts/provision-tenant.ts` validates each origin and appends it unless already
  listed. Every statement that relies on an origin checks it with `json_each` inside that
  statement (`editorOriginAllowed` in `src/access.ts`), matching only string elements exactly, so
  other entries are ignored and removing an origin takes effect at its next check.
- `templates.roles_json`, `templates.fields_json`, `editor_sessions.preset_roles_json`,
  `audit_events.detail_json`.

**Signatures.** A row holds as columns only what is filtered, joined, constrained or chained: the
envelope, task, sequence, status (`PENDING` or `DONE`), input artifact and hash, output artifact and
hash, previous and own event hash, `attempts` and `last_error`. `event_hash` is the SHA-256 of the
canonical JSON (`src/canonical-json.ts`: sorted keys, no whitespace) of `{previousHash, envelopeId,
sequence, inputSha256, facts, render}`, and `previous_hash` links each signature to the one before
it. Triggers allow only the rendering state to change after the insert (status, the output once,
`attempts`, `last_error`) and refuse deletes. `UNIQUE (task_id)` and `UNIQUE (envelope_id,
sequence)` back the commit point.

**Envelope ids and idempotency.** The envelope id is the first 16 bytes of the SHA-256 of
`["esign-envelope-id-v1", tenant id, Idempotency-Key]` (as JSON), shaped as a version 8 UUID
(`src/prepare.ts`). The envelope keeps `request_sha256`, the hash of the validated request. A
creation first looks the derived id up: the same request answers `201 {"id", "status":
"IN_PROGRESS"}` again, whatever the envelope's status is now; another request with the same key
answers `409 idempotency_conflict`. A retry after a failure reuses the D0 object the failed attempt
stored; a D0 object with other bytes is a conflict. Two concurrent creations cannot both insert, as
the id is the primary key; the loser re-reads and answers by the same rules.

## How writes commit

Each step a caller can observe commits at **one point**: a single conditional statement, a
compare-and-set (`UPDATE ... WHERE <conditions>` or `INSERT ... SELECT ... WHERE <conditions>`),
whose result the code checks for exactly one changed row (envelope creation instead writes one
all-or-nothing batch). Everything a step needs is written **before** that commit point,
where nothing references it; the steps **after** it are idempotent conditional updates that read
only the current state.

| Step | Written first | Commit point |
| --- | --- | --- |
| Envelope creation | D0 in R2 | One D1 batch: the envelope, its tasks and the D0 row, all or none |
| Code exchange (both pages) | The `access_sessions` row | Marking the code used (`used_at IS NULL`, scope and validity); the token is returned only then |
| Editor session start | The `editor_sessions` row | Inserting its `editor` code, which requires the session and an allowed parent |
| Editor save | The source object and the template row | Recording the template as the session's result, while unsaved and while this request's token is live |
| OTP send | — | One `INSERT ... ON CONFLICT DO UPDATE ... WHERE` holding the budget; the mail goes out only if it changed one row |
| OTP entry | — | One batch: count the entry and mark the code used; mark this session verified only if that just happened; clear the mark from the task's other sessions |
| Signing | Field images in R2 | One `INSERT INTO signatures ... SELECT ... WHERE` (below); then the task is marked `SIGNED` |
| Rendering | The output PDF in R2 | `PENDING` → `DONE` naming that output; then the envelope moves on |
| Sealing (both seals) | The seal object in R2 | A `seals` row only while `FINALIZING`, then `FINALIZING` → `COMPLETED` only with that seal |
| Void, decline, expiry | — | The status change from `IN_PROGRESS`, with its single audit event in the same batch |

The signing insert requires the page session to be live at its origin and verified, the task's
current email to be the one read, the envelope `IN_PROGRESS`, the task `ACTIVE` with the role, name
and template read, nobody to have signed in between and the input to be the current one (D0, or the
previous signature's rendered PDF); for a document without fields, the envelope's tasks and names
must be the ones checked to fit. A void or an expiry is therefore ordered entirely before or after
it.

**Repair.** After rendering, the envelope moves on through idempotent updates
(`advanceStatements` in `src/signature-processing.ts`): a task whose signature exists becomes
`SIGNED`; with no task active and every signature rendered, the next task becomes `ACTIVE`; with
every task signed and rendered, the envelope becomes `FINALIZING` (only while `IN_PROGRESS`).
Completion runs them first, and the cron also picks envelopes left half-advanced by a lost write: a
signature whose task is still `ACTIVE`, a rendered signature whose next task is still `PENDING`,
every task signed but the envelope still `IN_PROGRESS`, or a seal recorded while the envelope is
still `FINALIZING` (completed with that same seal, never a new one). For deadlines, a recipient
whose signature exists counts as signed even before the task is marked.

**Acceptable orphans.** A failure before a commit point can leave records nothing references and
nobody can reach: R2 field images, output PDFs, seal and delivery objects, staged editor sources, a
template's source and row from an editor save that lost, an `access_sessions` row whose exchange
lost (its token was never returned), an `editor_sessions` row whose code was not issued, and a
template source object whose D1 insert failed. Nothing deletes them; keep them, because a lost
response does not show whether a write committed.

A signature that keeps failing to render stays `PENDING`, with `attempts` and `last_error`, and the
cron keeps retrying it. There is no repair or termination endpoint. To list them locally:

```sh
npx wrangler d1 execute esign-local --local --command "SELECT envelope_id, id, sequence, attempts, last_error FROM signatures WHERE status='PENDING' AND attempts>0 ORDER BY envelope_id, sequence"
```

## Access codes, sessions and OTP

Both browser pages open the same way (`src/access.ts`, `migrations/0005_access.sql`): the host's
backend obtains a one-time **code** (64 hex characters, valid for two minutes, used once), and the
page exchanges it for a **session token** (64 hex characters, valid for fifteen minutes), its
bearer credential. Only SHA-256 hashes are stored. Each row has a scope and a subject:

| Scope | Subject | Origin | Issued by | Exchanged at | Accepted by |
| --- | --- | --- | --- | --- | --- |
| `recipient` | A task | The signing page origin; the request's must match at exchange and on every call | `POST /v1/envelopes/:id/tasks/:taskId/recipient-view` | `POST /v1/page-sessions/exchange` | `/v1/signing/*` |
| `editor` | An editor session | The parent origin allowed to frame the editor | `POST /v1/template-editing-sessions` | `POST /v1/editor/exchange` (with the page id) | `/v1/editor/*` |

Every statement names the scope, so a code or token of one scope is never accepted by the other.
Exchange and authorization also require the subject to be open: the task `ACTIVE` in an
`IN_PROGRESS` envelope of the tenant, or the editor session's parent still allowed for the tenant.
A recipient session therefore loses its authority once its task is no longer active or its envelope
leaves `IN_PROGRESS`, and an editor session once its parent origin is removed from the tenant's
`editor_origins_json`.

**Signing page origins.** The recipient-view code is for the Worker's own origin unless the request
names another allowed one; in dev, `SIGNING_PAGE_ORIGINS` adds origins for local UI development. The
page served at `/sign` carries `<meta name="esign-api">` with the Worker's origin, and calls the API
only when that matches its own origin; otherwise it talks only to the local Worker from
`http://127.0.0.1:5173` and on any other origin stops before sending the code anywhere. Browsers
send no `Origin` on same-origin GETs, so the signing API then takes the origin from
`Sec-Fetch-Site: same-origin`.

**Emailed code (OTP).** Six digits, valid for ten minutes, used once. Only an HMAC is stored, keyed
by `OTP_KEY` over the task, the task's email and the code, so it verifies only while the task has
the address it was sent to (a task's email cannot change, migration 0027). Per task, across all its
sessions: at most three sends and five entries per 15-minute window, and 60 seconds between sends;
a new page session does not reset the budget. Only the session the code was sent for can enter it,
and only the session that entered the task's latest code can sign (`access_sessions.otp_verified_at`).
A refused send is `429 otp_unavailable`. Where the code goes depends on `ESIGN_ENV`
([WORKER-MODE.md](WORKER-MODE.md#dev-and-prod-one-switch)).

## Evidence, hash chain and seals

Each signature's event hash binds the chain link, the input PDF hash, the signer facts and every
drawn value, renderer and image hash. The rendered PDF's hash is recorded on the row when it is
rendered. Rendering uses only the saved row and the saved images, verifying their hashes, the event
hash and the input PDF before drawing.

At sealing, `buildEvidenceManifest` (`src/seal/evidence.ts`) checks the whole chain: the D0
hash, every signature's sequence, link, input and event hash, every rendered PDF rendered again
byte for byte, and every stored file's hash. It then builds the manifest
(`esign-evidence-manifest-v1`) with each signature's facts and rendering. The same checks run
again on every certificate and delivery PDF read, so a changed record, image or PDF makes them fail.

| | Local test seal (`LOCAL_TEST`) | Managed seal (`KMS_TSA`) |
| --- | --- | --- |
| Used | dev without `KMS_KEY_ARN` (locally) | whenever `KMS_KEY_ARN` is set; prod allows nothing else |
| Covers | The manifest | The manifest and the audit trail up to sealing (`esign-sealed-evidence-v2`); later events are listed as recorded after sealing |
| How | Two HMACs with `TEST_SEAL_KEY`; the "timestamp" is the last signature's consent time | An AWS KMS ECDSA P-256 signature over a SHA-256 digest of a domain-separated message, verified against the pinned `KMS_PUBLIC_KEY`; then an RFC 3161 timestamp over that signature from DigiCert's public TSA, nonce-bound, verified against the root, signer and policy pinned in `src/seal/tsa.ts` and within five minutes of the Worker's clock |
| Stored | `envelopes/<id>/local-test-evidence.json` | `envelopes/<id>/managed-evidence.json`, made once; a retry reuses it |
| Verified | Recomputed with the current key on each read, so changing the key breaks old seals | Signature and timestamp checked on each read, as of the timestamp's time; earlier keys stay trusted through `KMS_TRUSTED_KEY_SHA256` |
| Certificate | `mode: LOCAL TEST ONLY` | `mode: KMS_TSA`; records a `COMPLETED` audit event |

The seals' code is in `src/seal/`: `evidence.ts` (the manifest and the seal commit), `local.ts`
(the local test seal), `managed.ts` (the managed seal and its envelope flow), `config.ts` (which seal
is configured), `kms.ts` (the signed message and local verification, the KMS `Sign` call and the
conversion of its DER signature, and the assumed-role credentials: the Worker holds an IAM user key
that may only assume one role, and that role may only sign with this key) and `tsa.ts` (the RFC 3161
query, the response check and the pinned DigiCert trust). Revocation of the TSA certificates is not
checked, and the certificate says so.

**Audit trail** (`src/audit.ts`): the signing link issued, the page opened, each code sent, the
code verified, the document fetched, pages viewed (the page posts `POST /v1/signing/page-views`
for pages at least half on screen for a second; each page is recorded once), the signature, a void,
decline or expiry, completion and each signed copy sent. Signer steps record the IP Cloudflare saw
(`CF-Connecting-IP`) and the user agent.

**Consent** (`src/disclosure.ts`): the page shows the server's consent text; signing sends its
version, an old version is refused (`409 disclosure_changed`), and the signature facts and audit
event record the version and its SHA-256.

**Delivery PDF.** `GET /v1/envelopes/:id/delivery-pdf` returns the final signed PDF, page for page,
with certificate pages appended. It is created on the first request (`envelopes/<id>/delivery-v1.pdf`
for the managed seal, `local-delivery-v3.pdf` for the local one) with a conditional create; later
requests rebuild it and check the stored bytes match. The seal covers the signed PDF, not the
delivery PDF. There is no endpoint for the signed PDF alone. After completion each signer is
emailed this PDF once (`src/signed-copies.ts`); a failed send is retried by the cron for envelopes
created in the last seven days.

## API

Management routes take `Authorization: Bearer <management key>` and see only their tenant's data
(another tenant's ids answer 404). Routes marked † are available only while signing is enabled.

**Management**

| Route | Purpose |
| --- | --- |
| `GET /v1/me` | The key's tenant id |
| `POST /v1/templates` | Multipart `file` (PDF, at most 5 MiB and 100 pages) and `roles` (JSON array, 1–20 unique names of `[A-Za-z0-9_-]`); returns `{id, roles}` |
| `GET /v1/templates/:id` | Roles, the placed fields (type, role, page, normalized box) and whether they can be signed (`positionedFieldsSupported`) |
| `POST /v1/envelopes` | Creates and prepares an envelope (lifecycle step 2); `Idempotency-Key` required |
| `GET /v1/envelopes/:id` | Status and tasks (role, name, email, order, status, `expiresAt`, `openedAt`) |
| `POST /v1/envelopes/:id/void` | Optional `{reason}` (at most 500 characters); a repeat is a no-op; any status other than `IN_PROGRESS` answers `409 envelope_not_voidable` |
| `GET /v1/envelopes/:id/audit` | Events with type, time, recipient, IP, user agent and an allow-listed detail; never codes or message ids |
| `POST /v1/envelopes/:id/tasks/:taskId/recipient-view` † | `{origin?, hostAuthentication?}`; returns `{code}` for the active task |
| `GET /v1/envelopes/:id/delivery-pdf` † | The signed PDF with its certificate, for a `COMPLETED` envelope |
| `GET /v1/envelopes/:id/certificate` † | The completion certificate as JSON (used by `/demo`), verified on every read |
| `GET /v1/test-mail/:messageId` † | dev only: `{to, otp}` of a code sent to one of the tenant's recipients |
| `POST /v1/envelopes/:id/prepare` | **Deprecated**: does nothing (204 for the tenant's envelope, else 404). Kept for callers that still call it after creating an envelope; remove once they stop |

**Signing page** (†, recipient session token, page origin checked)

`POST /v1/page-sessions/exchange` `{code}` → `{token}`; `GET /v1/signing/current` (the document,
fields, disclosure, intent, whether verified); `GET /v1/signing/pdf`; `POST /v1/signing/page-views`;
`POST /v1/signing/otp` → `202 {messageId, emailed?, testMailbox?}` (`testMailbox` only in dev, where the code is kept in the test mailbox; never the code itself); `POST /v1/signing/otp/verify` `{otp}`;
`POST /v1/signing/preview`; `POST /v1/signing/decline` `{reason}` (at most 1000 characters);
`POST /v1/signing/sign`. Reading (`current`, `pdf`, `page-views`) needs only the session; preview,
decline and sign also need the entered code. A sign request that lost its response can be repeated
by the same live session with the same input and values, and returns the same signature id.

**Embedded editor**

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /v1/template-editing-sessions` | Management | `{allowedParentOrigin, roles?, sourceTemplateId?}`; returns `{sessionId, url}`, the code in the URL fragment |
| `POST /v1/template-editing-sessions/:id/source` | Management | The PDF bytes (`Content-Type: application/pdf`, at most 5 MiB and 100 pages), once, before the page is opened |
| `GET /v1/template-editing-sessions/:id` | Management | `{templateId}` once saved, else null |
| `GET /editor/page/:id` | — | The editor page, framable only by the session's parent origin |
| `POST /v1/editor/exchange` | Same origin | `{pageId, code}` → `{token}` |
| `GET /v1/editor/current`, `GET /v1/editor/pdf`, `POST /v1/editor/save` | Editor token, same origin | The session, its source PDF, and one save |

**Pages and other routes**: `GET /sign` †, `GET /demo` †, `GET /editor/page/:id`, `GET /assets/*`,
`GET /health` (`{"status": "ok", "service": "esign", "environment": "dev"}`, or `"prod"`: the
`ESIGN_ENV` the Worker runs with).

## Embedded editor

The source is either an existing template of the tenant (`sourceTemplateId`; its SHA-256 is bound
when the session starts) or PDF bytes posted to `/source` (bound once, before the page is opened).
The Worker never downloads a document. Every preview and the save re-read the source and check
that hash; missing, changed or oversized bytes fail closed. The editor sends only fields and roles;
the server uses the bound bytes and refuses a replacement file. The embedded UI refuses a session
without a source.

The host's parent origin must be in the tenant's `editor_origins_json` (https, or http on
`localhost` or `127.0.0.1`). The page response sets `frame-ancestors` to that origin, `no-store` and
`Referrer-Policy: no-referrer`; the iframe removes the code from its URL before the exchange and
keeps its token in memory. It posts `esign.editor.ready`, and answers the parent's
`esign.editor.save` (with a request id) with `esign.editor.saved` or `esign.editor.save-error`, only
to the parent origin. A message is only a prompt: the host's backend reads the result with
`GET /v1/template-editing-sessions/:id`. One session saves once; another version needs a new
session.

Saved fields use coordinates normalized to the displayed page's top-left. A save allows at most 20
roles and 200 fields, refuses rotated pages and overlapping fields, and requires exactly one
Signature field per role and no field types other than Signature, Date signed and Title.

A code is a bearer credential and can be redeemed outside a browser; CSP constrains browsers only.
Never log codes or tokens or put them in query strings.

## Recipient page PDF display

The page renders every PDF page to canvas with PDF.js (pinned 5.4.624, `stopAtErrors: true`)
instead of the browser's PDF viewer, which can be blocked inside a sandboxed frame. Signing is
offered only after every page has rendered; a failure clears the document and offers **Retry
document**. Canvases are limited to 16,777,216 pixels per page, 50,331,648 in total and 8,192 per
side. Because this PDF.js version can report success after an operator-list error, the page also
requires the final operator-list chunk, through an internal hook; recheck this on any PDF.js
upgrade. The canvas has no selectable text and is not an accessible reader. None of this proves a
person read the document; the server checks the session, code, consent and current input, not the
display.

## Run locally

Node 24 and `jq`. These commands use only local Wrangler resources:

```sh
npm ci
npm run db:migrate:local
# One tenant, `local`, with a new management key in .local-key (ignored by git, never overwritten).
node scripts/provision-tenant.ts --tenant local --console-origin http://localhost:3000 --key-file .local-key --local
cp -n .dev.vars.example .dev.vars # synthetic OTP_KEY, TEST_SEAL_KEY and SIGNING_PAGE_ORIGINS
npx vite build                    # dist-ui, for /sign, /demo and the editor
npm run dev                       # terminal 1: Worker on 127.0.0.1:8787
npm run dev:ui                    # terminal 2 (optional): page development on 127.0.0.1:5173
```

`provision-tenant.ts` refuses to overwrite an existing `.local-key`; to start over, delete
`.wrangler/state` and `.local-key`. Use the key only locally. To try the whole flow in a browser,
open `http://127.0.0.1:8787/demo` and paste the key from `.local-key` (placing fields in the editor
also needs the Worker's origin in the tenant's `editor_origins_json`; see WORKER-MODE.md). With the
API:

```sh
node --input-type=module -e "import {PDFDocument} from 'pdf-lib';import{writeFile}from 'node:fs/promises';const p=await PDFDocument.create();p.addPage();await writeFile('/tmp/esign-sample.pdf',await p.save())"
KEY=$(cat .local-key)
API=http://127.0.0.1:8787
TPL=$(curl -fsS -H "Authorization: Bearer $KEY" -F file=@/tmp/esign-sample.pdf -F 'roles=["ana","marcus"]' "$API/v1/templates" | jq -r .id)
ENV=$(curl -fsS -X POST "$API/v1/envelopes" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: sample-1' -d "{\"templateId\":\"$TPL\",\"recipients\":[{\"role\":\"ana\",\"name\":\"Ana\",\"email\":\"ana@example.com\"},{\"role\":\"marcus\",\"name\":\"Marcus\",\"email\":\"marcus@example.com\"}]}" | jq -r .id)
TASK=$(curl -fsS -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV" | jq -r '.tasks[] | select(.status=="ACTIVE") | .id')
CODE=$(curl -fsS -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{}' "$API/v1/envelopes/$ENV/tasks/$TASK/recipient-view" | jq -r .code)
printf 'Open %s/sign#code=%s\n' "$API" "$CODE"
```

Locally, without a mail sink, codes go only to `example.com` or `.test` addresses and are kept in
the local test mailbox. The page does not show the message id; the code form carries it in
`data-test-message-id`. Read the code with the key:

```sh
curl -fsS -H "Authorization: Bearer $KEY" "$API/v1/test-mail/<message-id>" | jq -r .otp
```

After Ana signs, poll the envelope, issue Marcus's view and repeat. After Marcus the Worker seals the
envelope with the local test seal; `GET /v1/envelopes/$ENV/delivery-pdf` then returns the signed
PDF with its certificate. To run the cron once, start the Worker with `npm run dev -- --test-scheduled` and request
`/__scheduled`. To serve the page from the Vite server instead, pass
`{"origin":"http://127.0.0.1:5173"}` to recipient-view and open `http://127.0.0.1:5173/#code=<code>`.

The test mailbox holds plaintext codes and is never cleaned up; never use it with real data.

## Validation

From `esign/`: `npm run typecheck`, `npm test` (or serially, as CI does:
`node --test --test-concurrency=1 test/*.test.ts`) and `npm run build` (the Vite build and a
Wrangler **dry-run** bundle, not a deployment). Browser tests need Chrome (`ESIGN_TEST_CHROME`) and
skip when no Chrome is found; CI requires them to run ([CI.md](CI.md)). Tests use synthetic data,
Miniflare D1 and R2, and fakes for mail, KMS and the TSA (a recorded DigiCert response and locally generated
OpenSSL responses). From the repository root: `node .github/scripts/check-public-content.mjs`.

## Known limitations and open items

- **Mail per environment.** dev emails every code and signed copy to one sink mailbox (the binding
  is pinned to it on `esign-dev`). prod emails each recipient through an unpinned `send_email`
  binding; that Cloudflare Email Sending delivers to any address from `MAIL_FROM` is not yet
  confirmed. `/demo` is on in prod too, where its envelopes are real and mail their signers.
- **Legal review.** The consent text (`src/disclosure.ts`) is marked a draft for counsel; the
  evidence, certificate and intent wording also need legal review. Legal effect under ESIGN and
  UETA is not established.
- **TSA.** Revocation of DigiCert's TSA certificates is not checked; DigiCert's terms for its free
  TSA are not confirmed for production; the request goes over plain HTTP (the response is signed and
  verified). The signed PDF carries no embedded (PAdES) signature.
- **Rate limiting.** The Worker has none of its own beyond the OTP budget. Put Cloudflare rate
  limiting rules on `/v1/signing/otp*` and `/v1/page-sessions/exchange` before anyone outside the
  team signs.
- **Deprecated endpoint.** Delete `POST /v1/envelopes/:id/prepare` once Suger's backend is deployed
  without the call.
- **Retention and integrity.** No retention policy; R2 conditional writes are not WORM; privileged
  changes to D1, R2 or keys remain possible and are detected only where the checks above re-verify.
  Orphans are never cleaned up. A recorded signature cannot be rolled back if its input changes in
  storage before rendering; rendering then fails and the row stays `PENDING`.
- **Credentials.** Management keys are added with `scripts/provision-tenant.ts` and revoked by
  setting `api_keys.revoked_at`; there is no API for either. No user login, key rotation tooling or
  independent security review yet.
- **Blank editor sessions.** `POST /v1/editor/save` still accepts a file for a session without a
  bound source, for older clients; the embedded UI does not.
