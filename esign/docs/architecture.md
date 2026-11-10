# How E-sign works

E-sign is an Insulin app: one npm package (Vite, React and Nitro, with Drizzle on D1) served behind
the hosting gateway at `esign.<domain>`. Members of an organization send PDFs for signature from the
app or through its API; recipients sign on a public page that a host product can embed; the app
verifies each signer by an emailed one-time code, records the signature, renders the signed PDF,
seals the finished envelope and emails each signer a link to their copy.

## The app on the platform

- **Requests.** `src/api.ts` (platform file) hands every `/api/**` request to `handleAppRequest` in
  `src/app/server/router.ts`, which builds the bindings from `#platform` (`openAppD1`, `readAppEnv`)
  and calls the Hono app in `src/app/server/esign/app.ts`. Signing routes are in
  `signing-routes.ts`, editor routes in `editor-routes.ts`, next to it.
- **Identity and organizations.** The gateway (or the console) sends the platform identity;
  `getCurrentUser()` reads it (`identity.ts`). The organization is the tenant: `tenant_id` on every
  record is `organizationId`. There are no management keys and no tenants table.
- **Permissions.** `esign.manage` (Editors and above: send and manage envelopes) and `esign.view`
  (every role: see them), declared in `package.json` `insulin.permissions`. A custom role's
  `x-suger-app-permissions` header only narrows a role, never widens it. `can(caller, permission)`
  in `identity.ts` is the one check; `esign.manage` implies `esign.view`.
- **Public paths.** Recipients and embedded editors aren't members. `insulin.publicPaths` lists
  `/sign`, `/editor/`, `/copy`, `/assets/` and `/api/public/`; those requests carry a one-time code
  or token instead of an identity, and the management routes refuse anything the gateway marks public.
- **Storage.** D1 only. Documents, rendered field images, seals and delivery PDFs are objects in a
  small store over D1 (`blob-store.ts`): a key in a bucket points to one upload's 256 KiB chunks,
  with R2's create-only put (`onlyIf: { etagDoesNotMatch: '*' }`). The local preview's test mailbox
  is a second bucket, `test-mail`.
- **Work in requests.** There is no cron. A signature is rendered, and the envelope sealed, in the
  signing request after its response is ready; `POST /api/process-due` (manage permission) expires
  envelopes past a deadline, finishes any envelope a request did not, and retries completion
  notices. A host or a scheduled caller runs it.
- **Mail.** There is no email binding: codes and completion notices go through the platform's mail
  relay (`mail.ts`), `POST $SUGER_MAIL_URL` with `SUGER_APP_TOKEN` and the organization. Only a 202
  counts as sent; a refusal (502 `send_failed`, 503, 429, anything else) is retried later and never
  marked sent. Notices carry a link, not an attachment: the signer's copy downloads once, within 30
  days, from the public `/copy` page (`signed-copies.ts`).

## dev and prod

`ESIGN_ENV` is set by the router, not configured: the local preview (`npm run dev`) is `dev`, a
published app is `prod` (`environment.ts`).

| | dev (local preview) | prod (published) |
| --- | --- | --- |
| Codes | kept in the test mailbox, read back with `GET /api/test-mail/:id`; emailed only if a relay is configured; without one only synthetic addresses (`example.com`, `.test`) get a code | emailed to the recipient through the relay, kept nowhere |
| Seal | KMS + TSA when configured, else the HMAC test seal | KMS + TSA only |
| Signing page hosts | the app, plus `SIGNING_PAGE_ORIGINS` | the app only |
| Origins that may embed | https, or http on a loopback host | https only |
| Identity | the platform's, or a preview Owner when there is none | the platform's |

prod signs nothing until it has `ESIGN_OTP_KEY` (at least 32 characters), the mail relay and
`ESIGN_KMS_KEY_ARN` (`prodProblems`); until then the signing routes answer 404 `signing_disabled`.

## Configuration

Secrets are declared in `package.json` `insulin.secrets` and read with `readAppEnv`:

| Secret | What |
| --- | --- |
| `ESIGN_OTP_KEY` | The pepper of the emailed codes (at least 32 characters) |
| `ESIGN_FRAME_ANCESTORS` | Space-separated origins that may embed the signing page and the editor |
| `ESIGN_KMS_KEY_ARN`, `ESIGN_KMS_PUBLIC_KEY`, `ESIGN_KMS_TRUSTED_KEY_SHA256` | The managed seal's AWS KMS key, its public key (base64 SPKI) and the trusted key hashes |
| `ESIGN_AWS_ROLE_ARN`, `ESIGN_AWS_ACCESS_KEY_ID`, `ESIGN_AWS_SECRET_ACCESS_KEY` | The credentials that assume the role allowed to sign with the key |
| `ESIGN_TSA_SIGNER_SPKI_SHA256` | The pinned signer keys of the timestamp authority |

The platform provides `SUGER_MAIL_URL` and `SUGER_APP_TOKEN`.

## The signing lifecycle

1. **Template.** The host uploads a PDF (`POST /api/templates`, multipart `file` and `roles`), or
   opens the embedded editor to place fields on one (see "Embedded editor"). A template without
   placed fields is signed on an appended signature page; one with placed fields is signed in those
   fields.
2. **Envelope.** `POST /api/envelopes` with an `Idempotency-Key` header names the template and one
   recipient per role (name, email, optional deadline, title, company, who named them), plus an
   optional document name and sender. It prepares the envelope in the same request: the template's
   source is copied to the envelope's initial document (D0, `envelopes/<id>/d0.pdf`), the first
   recipient's task becomes `ACTIVE`, and the envelope is created `IN_PROGRESS`. Recipients sign in
   routing order.
3. **Recipient view.** For the active task the host calls
   `POST /api/envelopes/:id/tasks/:taskId/recipient-view` and embeds
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

Every field is previewed through `POST /api/public/signing/preview` with `{fieldId, text}` (no `text` for
Date signed). It returns the PNG that will be drawn, with its size relative to the box
(`X-Signature-Width`/`-Height` or `X-Text-Width`/`-Height`) and, for Signature and Title, a receipt
(`X-Signature-Preview`, `X-Text-Preview`) that binds the input, the template, the field, the text,
the image and its geometry. The sign request sends back the receipts and the dates the page showed
(`datePreviews`); a date that changed in between (after midnight UTC) is refused with
`409 date_changed` and the page shows the new date. A refused preview is `422`
(`signature_does_not_fit`, `title_does_not_fit` or `invalid_preview`). Clients never send images.
The receipts show what the server rendered, not that a person looked at it.

A signature records each field's renderer name and atlas hash (`src/app/server/esign/field-render.ts`);
rendering and every later re-verification fail closed if the running renderer differs.

### Signing for a company, deadlines and certificates

- A recipient may carry `title` (at most 128 characters), `onBehalfOf` (the company, at most 200)
  and `namedBy` (at most 300, who named this signer); the envelope may carry `documentName` (at
  most 200) and `sender` (`{name, email?, organization?}`). With `onBehalfOf`, the page shows the
  intent statement ("I intend this to be my signature on <document> on behalf of <company>."),
  prefills the title, and the sign request needs a title and `authorityConfirmed: true`.
- A recipient may carry `expiresAt` (ISO 8601, in the future, within 400 days). Expiry is applied
  before any request touches the envelope and by `POST /api/process-due`, with one `EXPIRED` audit event.
- A recipient-view request may carry `hostAuthentication` (`{method, provider?, domain?,
  signedInAt?}`, `method` an upper-case word such as `SSO`): how the host signed the recipient in.
  E-sign cannot check it; it is recorded and printed as the host's statement.
- Certificates are versioned per envelope (`certificateVersion` in `envelopes.details_json`, now 2;
  none means 1). A certificate is rebuilt on every read and must come out the same, so each
  envelope keeps the layout it was created with. Change the layout only by adding a version.

## Data model

`src/app/db/schema.ts` declares the tables; `src/app/db/migrations/` holds the generated
`0000_init.sql` and the custom `0001_triggers.sql` (the triggers Drizzle can't declare). Every record
of an organization carries `tenant_id`, the Insulin organization id. A fresh database has these 16
tables:

| Table | Holds |
| --- | --- |
| `templates` | The source PDF's object key, `roles_json` and `fields_json` (placed fields; `[]` for none) |
| `envelopes` | Tenant, template, status, creation time, `request_sha256`, `details_json` |
| `tasks` | One per recipient: role, name, email (immutable by trigger), routing order, status, `expires_at`, `details_json` |
| `artifacts` | Each envelope's initial document (D0): object key and SHA-256 |
| `access_codes` | One-time page codes (hashed) with scope, tenant, subject, origin, expiry, `used_at` |
| `access_sessions` | Page sessions (hashed tokens) with the same fields and `otp_verified_at` |
| `otp_challenges` | One row per task: the hashed emailed code, its expiry and use, and the send and entry budget |
| `signatures` | One row per accepted signature (below) |
| `seals` | One per completed envelope: `mode` (`LOCAL_TEST` or `KMS_TSA`), the seal's object key and hash, and for `KMS_TSA` the key ARN and timestamp time |
| `editor_sessions` | One editing session: tenant, parent origin, source template and its hash or staged PDF and its hash, preset roles, the saved template |
| `audit_events` | Append-only (triggers refuse updates and deletes): type, time, task, IP, user agent, detail |
| `copy_deliveries` | One per signer of a completed envelope: when its completion notice was reserved and sent |
| `signed_copy_links` | The link in each completion notice: the SHA-256 of its token, its expiry and when it was used |
| `app_settings` | Deployment settings SQL reads: `editor_origins`, the origins from `ESIGN_FRAME_ANCESTORS` |
| `blobs`, `blob_chunks` | The object store (below): a key in a bucket points to one upload's 256 KiB chunks |

JSON columns. A new optional fact about an envelope or task needs no new table or column: readers
of `details_json` keep only known keys of the expected types. A fact that queries filter on is a
real column (`tasks.expires_at`).

- `envelopes.details_json`: `documentName`, `sender`, `certificateVersion` (`src/app/server/esign/details.ts`).
- `tasks.details_json`: `title`, `onBehalfOf`, `namedBy`.
- `signatures.facts_json` (`"version": 1`): who signed and how they were identified: the task,
  role, recipient name, the email the code was verified for (the task's), the page session hash,
  when the code was entered, when the signer consented, the input artifact, the consent
  disclosure's version and SHA-256, and the title, company and intent hash, if any.
- `signatures.render_json` (`"version": 1`): what is drawn and where. `"kind": "appended-page"`:
  the slot, input page count, name, printed time and renderer. `"kind": "fields"`: every placed
  field of the document at signing and, for each of the signer's fields, its value, renderer name
  and hash, image hash and geometry.
- `app_settings.editor_origins`: a JSON array of the bare origins (https, or http on `localhost`
  or `127.0.0.1`) allowed to frame the editor and the signing page. The app writes it from
  `ESIGN_FRAME_ANCESTORS` when it changes (`syncEditorOrigins`), keeping only valid origins. Every
  statement that relies on an origin checks it with `json_each` inside that statement
  (`editorOriginAllowed` in `src/app/server/esign/access.ts`), matching only string elements exactly,
  so removing an origin takes effect at its next check.
- `templates.roles_json`, `templates.fields_json`, `editor_sessions.preset_roles_json`,
  `audit_events.detail_json`.

**Signatures.** A row holds as columns only what is filtered, joined, constrained or chained: the
envelope, task, sequence, status (`PENDING` or `DONE`), input artifact and hash, output artifact and
hash, previous and own event hash, `attempts` and `last_error`. `event_hash` is the SHA-256 of the
canonical JSON (`src/app/server/esign/canonical-json.ts`: sorted keys, no whitespace) of `{previousHash, envelopeId,
sequence, inputSha256, facts, render}`, and `previous_hash` links each signature to the one before
it. Triggers allow only the rendering state to change after the insert (status, the output once,
`attempts`, `last_error`) and refuse deletes. `UNIQUE (task_id)` and `UNIQUE (envelope_id,
sequence)` back the commit point.

**Envelope ids and idempotency.** The envelope id is the first 16 bytes of the SHA-256 of
`["esign-envelope-id-v1", tenant id, Idempotency-Key]` (as JSON), shaped as a version 8 UUID
(`src/app/server/esign/prepare.ts`). The envelope keeps `request_sha256`, the hash of the validated request. A
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
| Envelope creation | D0 in the object store | One D1 batch: the envelope, its tasks and the D0 row, all or none |
| Code exchange (both pages) | The `access_sessions` row | Marking the code used (`used_at IS NULL`, scope and validity); the token is returned only then |
| Editor session start | The `editor_sessions` row | Inserting its `editor` code, which requires the session and an allowed parent |
| Editor save | The source object and the template row | Recording the template as the session's result, while unsaved and while this request's token is live |
| OTP send | — | One `INSERT ... ON CONFLICT DO UPDATE ... WHERE` holding the budget; the mail goes out only if it changed one row |
| OTP entry | — | One batch: count the entry and mark the code used; mark this session verified only if that just happened; clear the mark from the task's other sessions |
| Signing | Field images in the object store | One `INSERT INTO signatures ... SELECT ... WHERE` (below); then the task is marked `SIGNED` |
| Rendering | The output PDF in the object store | `PENDING` → `DONE` naming that output; then the envelope moves on |
| Sealing (both seals) | The seal object in the object store | A `seals` row only while `FINALIZING`, then `FINALIZING` → `COMPLETED` only with that seal |
| Void, decline, expiry | — | The status change from `IN_PROGRESS`, with its single audit event in the same batch |

The signing insert requires the page session to be live at its origin and verified, the task's
current email to be the one read, the envelope `IN_PROGRESS`, the task `ACTIVE` with the role, name
and template read, nobody to have signed in between and the input to be the current one (D0, or the
previous signature's rendered PDF); for a document without fields, the envelope's tasks and names
must be the ones checked to fit. A void or an expiry is therefore ordered entirely before or after
it.

**Repair.** After rendering, the envelope moves on through idempotent updates
(`advanceStatements` in `src/app/server/esign/signature-processing.ts`): a task whose signature exists becomes
`SIGNED`; with no task active and every signature rendered, the next task becomes `ACTIVE`; with
every task signed and rendered, the envelope becomes `FINALIZING` (only while `IN_PROGRESS`).
Completion runs them first, and `POST /api/process-due` also picks envelopes left half-advanced by a lost write: a
signature whose task is still `ACTIVE`, a rendered signature whose next task is still `PENDING`,
every task signed but the envelope still `IN_PROGRESS`, or a seal recorded while the envelope is
still `FINALIZING` (completed with that same seal, never a new one). For deadlines, a recipient
whose signature exists counts as signed even before the task is marked.

**Acceptable orphans.** A failure before a commit point can leave records nothing references and
nobody can reach: stored field images, output PDFs, seal and delivery objects, staged editor sources, a
template's source and row from an editor save that lost, an `access_sessions` row whose exchange
lost (its token was never returned), an `editor_sessions` row whose code was not issued, and a
template source object whose D1 insert failed. Nothing deletes them; keep them, because a lost
response does not show whether a write committed.

A signature that keeps failing to render stays `PENDING`, with `attempts` and `last_error`, and
`POST /api/process-due` keeps retrying it. There is no repair or termination endpoint. To list them
(the local preview's database is in `.suger/data/`):

```sql
SELECT envelope_id, id, sequence, attempts, last_error FROM signatures
WHERE status='PENDING' AND attempts>0 ORDER BY envelope_id, sequence
```

## Access codes, sessions and OTP

Both browser pages open the same way (`src/app/server/esign/access.ts`, the `access_codes` and `access_sessions` tables): the host's
backend obtains a one-time **code** (64 hex characters, valid for two minutes, used once), and the
page exchanges it for a **session token** (64 hex characters, valid for fifteen minutes), its
bearer credential. Only SHA-256 hashes are stored. Each row has a scope and a subject:

| Scope | Subject | Origin | Issued by | Exchanged at | Accepted by |
| --- | --- | --- | --- | --- | --- |
| `recipient` | A task | The signing page origin; the request's must match at exchange and on every call | `POST /api/envelopes/:id/tasks/:taskId/recipient-view` | `POST /api/public/page-sessions/exchange` | `/api/public/signing/*` |
| `editor` | An editor session | The parent origin allowed to frame the editor | `POST /api/template-editing-sessions` | `POST /api/public/editor/exchange` (with the page id) | `/api/public/editor/*` |

Every statement names the scope, so a code or token of one scope is never accepted by the other.
Exchange and authorization also require the subject to be open: the task `ACTIVE` in an
`IN_PROGRESS` envelope of the tenant, or the editor session's parent still allowed.
A recipient session therefore loses its authority once its task is no longer active or its envelope
leaves `IN_PROGRESS`, and an editor session once its parent origin is removed from
`ESIGN_FRAME_ANCESTORS`.

**Signing page origins.** The recipient-view code is for the app's own origin (`/sign`) unless the
request names another allowed one; in the local preview only, `SIGNING_PAGE_ORIGINS` adds origins
for UI development. The page calls only its own origin's API. Browsers send no `Origin` on
same-origin GETs, so the signing API then takes the origin from `Sec-Fetch-Site: same-origin`.

**Who may frame the pages.** The pages are static (the platform serves `index.html` for every page
path), so they can't send a per-deployment `frame-ancestors` header. Instead each page reports at
its code exchange whether it is framed and by whom (`location.ancestorOrigins`, else the referrer's
origin), and the exchange refuses a framed page whose embedder is neither the app nor allowed:
`ESIGN_FRAME_ANCESTORS` for the signing page, the session's parent origin for the editor
(`embedderAllowed` in `src/app/server/esign/signing-page.ts`). A frame that hides its origin is
refused.

**Emailed code (OTP).** Six digits, valid for ten minutes, used once. Only an HMAC is stored, keyed
by `OTP_KEY` over the task, the task's email and the code, so it verifies only while the task has
the address it was sent to (a task's email cannot change, the trigger in `0001_triggers.sql`). Per task, across all its
sessions: at most three sends and five entries per 15-minute window, and 60 seconds between sends;
a new page session does not reset the budget. Only the session the code was sent for can enter it,
and only the session that entered the task's latest code can sign (`access_sessions.otp_verified_at`).
A refused send is `429 otp_unavailable`. Where the code goes depends on `ESIGN_ENV`
("dev and prod" below).

## Evidence, hash chain and seals

Each signature's event hash binds the chain link, the input PDF hash, the signer facts and every
drawn value, renderer and image hash. The rendered PDF's hash is recorded on the row when it is
rendered. Rendering uses only the saved row and the saved images, verifying their hashes, the event
hash and the input PDF before drawing.

At sealing, `buildEvidenceManifest` (`src/app/server/esign/seal/evidence.ts`) checks the whole chain: the D0
hash, every signature's sequence, link, input and event hash, every rendered PDF rendered again
byte for byte, and every stored file's hash. It then builds the manifest
(`esign-evidence-manifest-v1`) with each signature's facts and rendering. The same checks run
again on every certificate and delivery PDF read, so a changed record, image or PDF makes them fail.

| | Local test seal (`LOCAL_TEST`) | Managed seal (`KMS_TSA`) |
| --- | --- | --- |
| Used | dev without `KMS_KEY_ARN` (locally) | whenever `KMS_KEY_ARN` is set; prod allows nothing else |
| Covers | The manifest | The manifest and the audit trail up to sealing (`esign-sealed-evidence-v2`); later events are listed as recorded after sealing |
| How | Two HMACs with `TEST_SEAL_KEY`; the "timestamp" is the last signature's consent time | An AWS KMS ECDSA P-256 signature over a SHA-256 digest of a domain-separated message, verified against the pinned `KMS_PUBLIC_KEY`; then an RFC 3161 timestamp over that signature from DigiCert's public TSA, nonce-bound, verified against the root, signer and policy pinned in `src/app/server/esign/seal/tsa.ts` and within five minutes of the app's clock |
| Stored | `envelopes/<id>/local-test-evidence.json` | `envelopes/<id>/managed-evidence.json`, made once; a retry reuses it |
| Verified | Recomputed with the current key on each read, so changing the key breaks old seals | Signature and timestamp checked on each read, as of the timestamp's time; earlier keys stay trusted through `KMS_TRUSTED_KEY_SHA256` |
| Certificate | `mode: LOCAL TEST ONLY` | `mode: KMS_TSA`; records a `COMPLETED` audit event |

The seals' code is in `src/app/server/esign/seal/`: `evidence.ts` (the manifest and the seal commit), `local.ts`
(the local test seal), `managed.ts` (the managed seal and its envelope flow), `config.ts` (which seal
is configured), `kms.ts` (the signed message and local verification, the KMS `Sign` call and the
conversion of its DER signature, and the assumed-role credentials: the app holds an IAM user key
that may only assume one role, and that role may only sign with this key) and `tsa.ts` (the RFC 3161
query, the response check and the pinned DigiCert trust). Revocation of the TSA certificates is not
checked, and the certificate says so.

**Audit trail** (`src/app/server/esign/audit.ts`): the signing link issued, the page opened, each code sent, the
code verified, the document fetched, pages viewed (the page posts `POST /api/public/signing/page-views`
for pages at least half on screen for a second; each page is recorded once), the signature, a void,
decline or expiry, completion and each signed copy sent. Signer steps record the IP Cloudflare saw
(`CF-Connecting-IP`) and the user agent.

**Consent** (`src/app/server/esign/disclosure.ts`): the page shows the server's consent text; signing sends its
version, an old version is refused (`409 disclosure_changed`), and the signature facts and audit
event record the version and its SHA-256.

**Delivery PDF.** `GET /api/envelopes/:id/delivery-pdf` returns the final signed PDF, page for page,
with certificate pages appended. It is created on the first request (`envelopes/<id>/delivery-v1.pdf`
for the managed seal, `local-delivery-v3.pdf` for the local one) with a conditional create; later
requests rebuild it and check the stored bytes match. The seal covers the signed PDF, not the
delivery PDF. There is no endpoint for the signed PDF alone. After completion each signer is
emailed a link to this PDF once (`src/app/server/esign/signed-copies.ts`), which the public `/copy`
page downloads once, within 30 days (`POST /api/public/copies/open`); a failed send is retried by
`POST /api/process-due` for envelopes created in the last seven days.

## API

Management routes take the Insulin platform identity (the console, insulinapps.com, an MCP client
or a service-account token, all through the gateway) and see only the caller's organization (another
organization's ids answer 404). Reading needs `esign.view`, anything else `esign.manage`. A request
the gateway marks public (`x-suger-access-via: public`) never reaches them. `GET /api/catalog` lists
the routes the caller may use, with JSON Schemas. Routes marked † are available only while signing
is enabled.

**Management**

| Route | Purpose |
| --- | --- |
| `GET /api/me` | The caller: organization, user, role, permissions, how the request came, whether signing is enabled |
| `GET /api/catalog` | The management routes the caller may use |
| `GET /api/templates`, `GET /api/envelopes` | The organization's templates and envelopes, newest first (`limit`, `before`; envelopes also `status`) |
| `POST /api/process-due` | Expires envelopes past a deadline, finishes envelopes the signing request did not, and retries completion notices, for the caller's organization |
| `POST /api/templates` | Multipart `file` (PDF, at most 5 MiB and 100 pages) and `roles` (JSON array, 1–20 unique names of `[A-Za-z0-9_-]`); returns `{id, roles}` |
| `GET /api/templates/:id` | Roles, the placed fields (type, role, page, normalized box) and whether they can be signed (`positionedFieldsSupported`) |
| `POST /api/envelopes` | Creates and prepares an envelope (lifecycle step 2); `Idempotency-Key` required |
| `GET /api/envelopes/:id` | Status and tasks (role, name, email, order, status, `expiresAt`, `openedAt`) |
| `POST /api/envelopes/:id/void` | Optional `{reason}` (at most 500 characters); a repeat is a no-op; any status other than `IN_PROGRESS` answers `409 envelope_not_voidable` |
| `GET /api/envelopes/:id/audit` | Events with type, time, recipient, IP, user agent and an allow-listed detail; never codes or message ids |
| `POST /api/envelopes/:id/tasks/:taskId/recipient-view` † | `{origin?, hostAuthentication?}`; returns `{code}` for the active task |
| `GET /api/envelopes/:id/delivery-pdf` † | The signed PDF with its certificate, for a `COMPLETED` envelope |
| `GET /api/envelopes/:id/certificate` † | The completion certificate as JSON (used by the member page), verified on every read |
| `GET /api/test-mail/:messageId` † | dev only: `{to, otp}` of a code sent to one of the organization's recipients |
| `POST /api/envelopes/:id/prepare` | **Deprecated**: does nothing (204 for the organization's envelope, else 404). Kept for callers that still call it after creating an envelope; remove once they stop |

**Signing page** (†, recipient session token, page origin checked)

`POST /api/public/page-sessions/exchange` `{code}` → `{token}`; `GET /api/public/signing/current` (the document,
fields, disclosure, intent, whether verified); `GET /api/public/signing/pdf`; `POST /api/public/signing/page-views`;
`POST /api/public/signing/otp` → `202 {messageId, emailed?, testMailbox?}` (`testMailbox` only in dev, where the code is kept in the test mailbox; never the code itself); `POST /api/public/signing/otp/verify` `{otp}`;
`POST /api/public/signing/preview`; `POST /api/public/signing/decline` `{reason}` (at most 1000 characters);
`POST /api/public/signing/sign`. Reading (`current`, `pdf`, `page-views`) needs only the session; preview,
decline and sign also need the entered code. A sign request that lost its response can be repeated
by the same live session with the same input and values, and returns the same signature id.

**Embedded editor**

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/template-editing-sessions` | Management | `{allowedParentOrigin, roles?, sourceTemplateId?}`; returns `{sessionId, url}`, the code in the URL fragment |
| `POST /api/template-editing-sessions/:id/source` | Management | The PDF bytes (`Content-Type: application/pdf`, at most 5 MiB and 100 pages), once, before the page is opened |
| `GET /api/template-editing-sessions/:id` | Management | `{templateId}` once saved, else null |
| `GET /editor/page/:id` | — | The editor page, framable only by the session's parent origin |
| `POST /api/public/editor/exchange` | Same origin | `{pageId, code}` → `{token}` |
| `GET /api/public/editor/current`, `GET /api/public/editor/pdf`, `POST /api/public/editor/save` | Editor token, same origin | The session, its source PDF, and one save |

**Pages** (the React app, `src/app/App.tsx`): `/sign` (the signing page), `/editor/page/:id` (the
editor), `/copy` (a signer's copy) and `/`, the member page. **Public API** (declared in
`insulin.publicPaths`): `/api/public/*` and `GET /api/health` (`{"status": "ok", "service": "esign"}`).

## Embedded editor

The source is either an existing template of the organization (`sourceTemplateId`; its SHA-256 is bound
when the session starts) or PDF bytes posted to `/source` (bound once, before the page is opened).
The app never downloads a document. Every preview and the save re-read the source and check
that hash; missing, changed or oversized bytes fail closed. The editor sends only fields and roles;
the server uses the bound bytes and refuses a replacement file. The embedded UI refuses a session
without a source.

The host's parent origin must be in `ESIGN_FRAME_ANCESTORS` (https, or http on `localhost` or
`127.0.0.1`), and the exchange refuses a page framed by any other origin ("Who may frame the
pages" above); the iframe removes the code from its URL before the exchange and
keeps its token in memory. It posts `esign.editor.ready`, and answers the parent's
`esign.editor.save` (with a request id) with `esign.editor.saved` or `esign.editor.save-error`, only
to the parent origin. A message is only a prompt: the host's backend reads the result with
`GET /api/template-editing-sessions/:id`. One session saves once; another version needs a new
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

## Known limitations and open items

- **Legal review.** The consent text (`src/app/server/esign/disclosure.ts`) is marked a draft for
  counsel; the evidence, certificate and intent wording also need legal review. Legal effect under
  ESIGN and UETA is not established.
- **TSA.** Revocation of DigiCert's TSA certificates is not checked; DigiCert's terms for its free
  TSA are not confirmed for production; the request goes over plain HTTP (the response is signed and
  verified). The signed PDF carries no embedded (PAdES) signature.
- **Rate limiting.** The app has none of its own beyond the OTP budget. Put rate limits on
  `/api/public/signing/otp*` and `/api/public/page-sessions/exchange` before anyone outside the team
  signs.
- **Deprecated endpoint.** Delete `POST /api/envelopes/:id/prepare` once no host calls it.
- **Retention and integrity.** No retention policy; the object store's create-only writes are not
  WORM; privileged changes to D1 or keys remain possible and are detected only where the checks above
  re-verify. Orphans are never cleaned up. A recorded signature cannot be rolled back if its input
  changes in storage before rendering; rendering then fails and the row stays `PENDING`.
- **Due work.** Nothing runs on a schedule: deadlines, unfinished envelopes and unsent notices wait
  for the next signing request on the envelope or a `POST /api/process-due`.
- **Blank editor sessions.** `POST /api/public/editor/save` still accepts a file for a session
  without a bound source, for older clients; the embedded UI does not.
