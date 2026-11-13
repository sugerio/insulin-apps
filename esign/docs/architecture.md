# How Esign works

Esign is an Insulin app: one npm package (Vite, React and Nitro, with Drizzle on D1) served behind
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
- **Ownership.** Every template and envelope has an owner (`owner_user_id`: the member or API client
  that created it) and is seen only by its owner and those it is shared with (`document_shares`, by
  email, as admin, editor or viewer), organization owners and admins included. `ownership.ts` is the
  one check (`documentRole`, `requireRole`, `visibleIds`): a role is capped at viewer for a caller
  without `esign.manage`, and a document the caller can't see answers 404. Tags (`tags.ts`) are each
  person's own. `members.ts` records each caller as seen (Esign has no directory), names owners, lets
  an organization owner take over what someone owns, and keeps, per API client, the person its new
  documents are shared with as admin (`api_clients`). None of it is evidence.
- **Public paths.** Recipients and embedded editors aren't members. `insulin.publicPaths` lists
  `/sign`, `/editor/`, `/copy`, `/assets/` and `/api/public/`; those requests carry a one-time code
  or token instead of an identity, and the management routes refuse anything the gateway marks public.
- **Storage.** D1 only. Documents, rendered field images, seals and delivery PDFs are objects in a
  small store over D1 (`blob-store.ts`): a key in a bucket points to one upload's 256 KiB chunks,
  with R2's create-only put (`onlyIf: { etagDoesNotMatch: '*' }`). The local preview's test mailbox
  is a second bucket, `test-mail`.
- **Work in requests, and the platform's tick.** The app has no cron. Once a signature is accepted
  it is rendered, and after the last one the envelope sealed (the seal key and the timestamp authority),
  through the request's `waitUntil` that Nitro puts on the request on Workers: the signer gets their
  response first and never waits for the seal. Without one (the tests) it runs in the request. Work
  cut short, by a CPU limit or an outage, leaves the signature `PENDING` or the envelope
  `FINALIZING`. Due work expires envelopes past a deadline, finishes any envelope a request did not,
  and retries completion notices. **The platform runs it every five minutes**: `package.json`
  declares `insulin.scheduled` (`/api/scheduled`), and the gateway POSTs there over its service
  binding with only `x-suger-app-id` and `x-suger-access-via: schedule`, no person, organization or
  role. `POST /api/scheduled` refuses (403) anything else, a member's or a service account's
  identity included, and works for every organization; a request marked `schedule` is nobody to
  every other route (`readCaller`). It is neither a public path nor in the catalog.
  `POST /api/process-due` (manage permission) does the same work at once, for the caller's
  organization only.
- **Mail.** There is no email binding: codes and completion notices go through the platform's mail
  relay (`mail.ts`), `POST $SUGER_MAIL_URL` with `SUGER_APP_TOKEN` and the organization, over the
  `SUGER_GATEWAY` service binding when the deploy gave one (`gateway-fetch.ts`). Only a 202
  counts as sent; a refusal (502 `send_failed`, 503, 429, anything else) is retried later and never
  marked sent. Notices carry a link, not an attachment: the signer's copy downloads once, within 30
  days, from the public `/copy` page (`signed-copies.ts`).

## dev and prod

`ESIGN_ENV` is set by the router, not configured: the local preview (`npm run dev`) is `dev`, a
published app is `prod` (`environment.ts`).

| | dev (local preview) | prod (published) |
| --- | --- | --- |
| Codes | kept in the test mailbox, read back with `GET /api/test-mail/:id`; emailed only if a relay is configured; without one only synthetic addresses (`example.com`, `.test`) get a code | emailed to the recipient through the relay, kept nowhere |
| Seal | the seal key + TSA when bound, else the HMAC test seal | the seal key + TSA only |
| Signing page hosts | the app, plus `SIGNING_PAGE_ORIGINS` | the app only |
| Origins that may embed | https, or http on a loopback host | https only |
| Identity | the platform's, or a preview Owner when there is none | the platform's |

prod signs nothing until it has `ESIGN_OTP_KEY` (at least 32 characters), the mail relay, the
`ESIGN_SEAL_KEY` binding and a current key in `seal/keys.ts` (`prodProblems`); until then the signing
routes answer 404 `signing_disabled`. Reading a completed envelope (its certificate, delivery PDF and
signers' copies) doesn't wait for that: it needs only the trust in the code.

## Configuration

Secrets are declared in `package.json` `insulin.secrets` and read with `readAppEnv`:

| Secret | What |
| --- | --- |
| `ESIGN_OTP_KEY` | The pepper of the emailed codes (at least 32 characters) |
| `ESIGN_FRAME_ANCESTORS` | Space-separated host origins that may embed the signing page and the editor (the app's own origin always may) |

The platform provides `SUGER_MAIL_URL`, `SUGER_APP_TOKEN` and the `SUGER_GATEWAY` service binding they are used over.

**The seal key** is not one of those secrets. `ESIGN_SEAL_KEY` is a Cloudflare `secret_key` binding on the Worker: the
private half of the managed seal's ECDSA P-256 key, which the Worker gets as a `CryptoKey` that can sign and can't be
exported (`src/app/server/seal-key-binding.ts`). `scripts/put-seal-key.mjs` makes a key and puts it there; the private
key is never printed, stored or held in GitHub, and Cloudflare can't give it back. `insulin.secrets` doesn't list it,
so the deploy never overwrites it, and `wrangler deploy` keeps a Worker's `secret_key` bindings. The public half of
every key that has sealed is in `src/app/server/esign/seal/keys.ts`, with the time it was in use: that list, reviewed
in the source, is what seals are verified against, never the deployment's configuration. Sealing refuses a binding
that isn't a non-extractable P-256 signing key, or one that isn't the pair of the current entry in `keys.ts`; a
finished envelope then waits, `FINALIZING`, until it is fixed.

## The members' app and the Docs

- **Pages.** `src/app/member/MemberApp.ts` reads `/api/me` and routes by path: `/` and `/envelopes`
  (envelopes, `?status=` filtering by status), `/envelopes/new`, `/envelopes/:id`, `/templates`,
  `/contacts`, `/contacts/:id`, `/ownership` (organization owners and admins) and `/docs/:topic?`. It moves with
  `history.pushState` (`router.ts`), the only navigation the console's sandboxed iframe allows. Every
  call is a same-origin request as the signed-in member; there is no key in the browser.
- **Navigation.** `src/app/member/Shell.ts` draws DESIGN.md §3.2's two levels around every member
  page: level 1 is the organization switcher (from the gateway's `/__insulin/me`, switching through
  `/__insulin/switch-org`, with All apps), the sections of `package.json` `insulin.navigation` that
  the member's role reaches, lowered by their permissions (`navigationRole`: without `esign.manage`
  a Viewer's, with neither permission none; `navigation.ts` reads and checks the manifest), Docs,
  Settings and the person (Account, Sign out through `/__insulin/logout`); level 2 is the open
  section's items (the Envelopes views, the Docs topics and a link to the public docs on the apex,
  or Settings' People, Integrations, API access and Connect AI, at the addresses `/__insulin/me`
  gives or else on the apex), and the page header carries the breadcrumb. Each level collapses to
  icons, remembered in localStorage `insulin-nav`; below 768px a menu button opens both levels in a
  drawer. The root carries `data-insulin-shell` so the gateway's account bar stays out of the way.
  Where `/__insulin/me` isn't answered (the local preview, the console), level 1 shows the app's
  name and the person from `/api/me`, and Settings lists its pages without links: Esign has no
  `/settings/*` of its own.
- **Roles.** What a role can't do is hidden (`canManage(me)`), and the server refuses it anyway.
  `/api/me` answering 401 shows a sign-in message; the Docs open without it.
- **Hosting the public pages.** The envelope page opens the active signer's `/sign` in a dialog
  with a recipient view for its own origin and follows its `esign.signing.*` messages; the Templates
  page opens the editor for its own origin and confirms the editor's save with
  `GET /api/template-editing-sessions/:id`. Both behave exactly as a host product would.
- **Sending.** A send carries an `Idempotency-Key` that a retry of the same form reuses. An
  optional sign-by day becomes every signer's `expiresAt` (the end of that day, the member's time).
- **Docs.** Static topics in `src/app/pages/docs/` (one file each; `topics.ts` sets the reading
  order) rendered by `src/app/components/Docs.ts`, with no request to the server; the topic list is
  the Docs' level 2 in the navigation (`docsNavigation()`). The background
  topic carries the general-information note. The signing page's "About signing" panel
  (`src/app/ui/SigningHelp.ts`) says the same as the signers topic in brief.
- **UI.** shadcn/ui components in `src/app/components/ui/`, `cn()` in `src/app/lib/utils.ts`,
  Tailwind v4 through `postcss.config.mjs` with the neutral theme in `src/app/styles.css`.
  `src/app/ui/esign-theme.css` keeps the public pages' layout hooks on the same tokens. All UI is
  `.ts` with `React.createElement`: the tests run on Node's type stripping, which doesn't transform
  JSX.

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
3. **Recipient view.** A task's `delivery` (in `details_json`) says how its signer reaches the page.
   The host's (the default): for the active task the host calls
   `POST /api/envelopes/:id/tasks/:taskId/recipient-view` with `signedInEmail`, the email of the
   account signed in to it, which must be the task's (a member in Esign's console, `accessVia`
   browser, needn't give one), and embeds `<worker origin>/sign#code=<code>`. `email`: when the task
   becomes active (at creation, after the previous signature in `completeEnvelope`, or by due work),
   Esign emails an invitation (`invitations.ts`) with `<worker origin>/sign#invite=<token>`; the page
   trades the token for a code (`POST /api/public/signing/invitation`) while the task is active, and
   the host can't ask for one. Either way the page exchanges the code for a page session, which
   keeps how the code was issued (`entry_json`: the host's statement and the checked account, or the
   invitation); confirming the emailed code records it in `OTP_VERIFIED`, and the certificate's
   "Identified by" reads it there. The sender's `message` (the envelope's, or the task's own) is in
   the invitation and on Review.
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
| Title | The title the signer gave on Review (printable ASCII, at most 128 characters), 18-point text that must fit its box |
| Date signed | The server's UTC date when the signature is accepted, 18-point text that must fit its box |

Title and Date signed text is drawn from a bundled, anti-aliased Liberation Sans atlas 96 pixels high,
each character at the font's own advance, 18 points high (its capitals 9 points, about half a
signature's), on the baseline earlier versions used: 7.3 points below the box's top
(`liberation-sans-aa-v4`); the preview says so in `X-Text-Top`. Signatures recorded with an earlier
renderer name it in `render_json` and are still verified and drawn with it: the same atlas 27 points
high from the box's top (`liberation-sans-aa-v3`), or a 1-bit, 32-pixel one 27 points high
(`liberation-sans-bitmap-v2`). New signatures always use v4.

Every field is previewed through `POST /api/public/signing/preview` with `{fieldId, text}` (no `text` for
Date signed). It returns the PNG that will be drawn, with its size relative to the box
(`X-Signature-Width`/`-Height`, or `X-Text-Width`/`-Height`/`-Top`) and, for Signature and Title, a receipt
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
  before any request touches the envelope and by due work (the five-minute tick, `POST /api/process-due`), with one
  `EXPIRED` audit event.
- A recipient-view request may carry `hostAuthentication` (`{method, provider?, domain?,
  signedInAt?}`, `method` an upper-case word such as `SSO`): how the host signed the recipient in.
  Esign cannot check it; it is recorded and printed as the host's statement.
- The delivery PDF's certificate pages are stored once and rebuilt on every read, which must come
  out byte for byte the same, so they show only what is fixed by completion: the sealed events (for
  the local seal, those up to the last signature) and facts set at creation. A layout change
  renames the stored file (`delivery-v2.pdf`, `local-delivery-v4.pdf`, see `delivery-pdf.ts`).

## Data model

`src/app/db/schema.ts` declares the tables; `src/app/db/migrations/` holds the generated
`0000_init.sql` and `0003_labels.sql` onward, the custom `0001_triggers.sql` (the triggers Drizzle can't declare), and
`0002_seal_key.sql`, a rebuild of `seals` written by hand in drizzle-kit's form (it changes a CHECK constraint). Every record
of an organization carries `tenant_id`, the Insulin organization id. A fresh database has these 17
tables:

| Table | Holds |
| --- | --- |
| `templates` | The source PDF's object key, `roles_json` and `fields_json` (placed fields; `[]` for none), the host's `name` and `metadata_json`, and `default_signers_json` (who usually signs as some roles, `default-signers.ts`; the one part of a template that can change, and never evidence) |
| `envelopes` | Tenant, template, status, creation time, `request_sha256`, `details_json` |
| `tasks` | One per recipient: role, name, email (immutable by trigger), routing order, status, `expires_at`, `details_json` |
| `artifacts` | Each envelope's initial document (D0): object key and SHA-256 |
| `access_codes` | One-time page codes (hashed) with scope, tenant, subject, origin, expiry, `used_at`, and how a recipient code was issued (`entry_json`) |
| `access_sessions` | Page sessions (hashed tokens) with the same fields and `otp_verified_at` |
| `invitations` | One per task Esign invites by email: the SHA-256 of its latest link's token, when it was reserved and sent |
| `otp_challenges` | One row per task: the hashed emailed code, its expiry and use, and the send and entry budget |
| `signatures` | One row per accepted signature (below) |
| `seals` | One per completed envelope: `mode` (`LOCAL_TEST` or `KEY_TSA`), the seal's object key and hash, and for `KEY_TSA` the key's fingerprint (`key_id`) and timestamp time |
| `editor_sessions` | One editing session: tenant, parent origin, source template and its hash or staged PDF and its hash, preset roles, the name and metadata for the template it saves, the saved template; who opened it (its owner) and the shares and tags it gets, since the save carries no identity |
| `audit_events` | Append-only (triggers refuse updates and deletes): type, time, task, IP, user agent, detail |
| `copy_deliveries` | One per signer of a completed envelope: when its completion notice was reserved and sent |
| `signed_copy_links` | The link in each completion notice: the SHA-256 of its token, its expiry and when it was used |
| `contacts` | The organization's address book (`contacts.ts`): one per email (`email_key`, trimmed and lower-cased), name, title, company, how many envelopes named them since and `last_used_at` (counted in each envelope's creating batch), and `recent_at` (last used or added, the list's order). A contact's page finds their envelopes through `tasks_by_recipient_email`, an index on `lower(recipient_email)`. Never evidence |
| `document_shares` | Who else sees a template or an envelope (`ownership.ts`): one row per person, by email (`grantee_email_key`), with their role; the owner (`owner_user_id` on the template or envelope) is never a row |
| `document_tags` | Each person's own tags on what they see (`tags.ts`), by `tag_key` (trimmed, lower-cased) |
| `members` | The members and API clients Esign has seen (`members.ts`): kind, email, name, organization role, when first and last seen |
| `api_clients` | Per API client, the person its new templates and envelopes are shared with as admin |
| `app_settings` | Deployment settings SQL reads: `editor_origins`, the app's own origin and those from `ESIGN_FRAME_ANCESTORS` |
| `blobs`, `blob_chunks` | The object store (below): a key in a bucket points to one upload's 256 KiB chunks |

JSON columns. A new optional fact about an envelope or task needs no new table or column: readers
of `details_json` keep only known keys of the expected types. A fact that queries filter on is a
real column (`tasks.expires_at`).

- `envelopes.details_json`: `documentName`, `documentVersion`, `sender`, `metadata` (`src/app/server/esign/details.ts`).
- `templates.name` and `templates.metadata_json`: the host's name and metadata for a template, which only label it
  (`src/app/server/esign/metadata.ts`). An editing session keeps those it was opened with
  (`editor_sessions.template_name`, `template_metadata_json`) for the template it saves; without them the saved template
  keeps its source template's.
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
  or `127.0.0.1`) allowed to start an editing session and frame the editor: the app's own origin,
  whose Templates page hosts the editor, and those in `ESIGN_FRAME_ANCESTORS`. The editor routes
  write it when it changes (`syncEditorOrigins`), keeping only valid origins. Every
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
| Envelope creation | D0 in the object store | One D1 batch: the envelope, its tasks, the D0 row and its signers' contacts, all or none |
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
Completion runs them first, and due work also picks envelopes left half-advanced by a lost write: a
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
due work keeps retrying it. There is no repair or termination endpoint. To list them
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

**The pages' headers.** Nitro serves the same `index.html` for every page path; a middleware it
reads from `nitro.config.ts` (`src/app/server/page-headers.ts`, policy in `page-policy.ts`) gives
each page its Content-Security-Policy: scripts, styles, workers and requests only from this origin,
no `eval`, `object-src 'none'`, `base-uri 'none'`. Behind insulinapps.com's gateway (the request
has `x-suger-access-via`) it adds who may frame the page: the signing page this origin and
`ESIGN_FRAME_ANCESTORS`, the editor this origin and its session's parent, the signed-copy page and
the members' pages nobody, so another page can't frame them and trick a signed-in member into
sending or voiding. The Insulin console frames its own preview, so there it leaves framing to the
console. The signing, editor and copy pages also get `Cache-Control: no-store` and
`Referrer-Policy: no-referrer`.

**Who may frame the pages, at the exchange too.** Each page also reports at its code exchange
whether it is framed and by whom: every ancestor in `location.ancestorOrigins` (Chromium, Safari),
else the referrer's origin. The exchange refuses a framed page with any ancestor that is neither the
app nor allowed: `ESIGN_FRAME_ANCESTORS` for the signing page, the session's parent origin for the
editor (`embedderAllowed` in `src/app/server/esign/signing-page.ts`). A frame that hides its origin
is refused.

**The page session's header.** A signing page or an editor sends its page session in
`x-esign-session` (`session-header.ts`), never in `Authorization`: the gateway forwards public paths
without that header, and strips every `x-suger-*` one.

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

| | Local test seal (`LOCAL_TEST`) | Managed seal (`KEY_TSA`) |
| --- | --- | --- |
| Used | dev (the local preview), which has no seal key | whenever the `ESIGN_SEAL_KEY` binding is there; prod allows nothing else |
| Covers | The manifest | The manifest and the audit trail up to sealing (`esign-sealed-evidence-v2`); later events are listed as recorded after sealing |
| How | Two HMACs with `TEST_SEAL_KEY`; the "timestamp" is the last signature's consent time | An ECDSA P-256 (SHA-256) signature with the seal key over a domain-separated message, checked against the current key's public half in `keys.ts` before anything is stored; then an RFC 3161 timestamp over that signature from DigiCert's public TSA, nonce-bound, verified against the root, the issuing CA and the policy pinned in `src/app/server/esign/seal/tsa.ts` and within five minutes of the app's clock |
| Stored | `envelopes/<id>/local-test-evidence.json` | `envelopes/<id>/managed-evidence.json` (`esign-managed-seal-v2`), made once and verified before it is stored; a retry reuses it |
| Verified | Recomputed with the current key on each read, so changing the key breaks old seals | Signature and timestamp checked on each read, as of the timestamp's time, with a key `keys.ts` lists as in use at that time; retired keys stay listed, with an end, so their seals keep verifying and they seal nothing new |
| Certificate | `mode: LOCAL TEST ONLY` | `mode: KEY_TSA`, with the key's fingerprint; records a `COMPLETED` audit event |

The seals' code is in `src/app/server/esign/seal/`: `evidence.ts` (the manifest and the seal commit), `local.ts`
(the local test seal), `managed.ts` (the managed seal and its envelope flow), `config.ts` (which seal
is configured, and the trust to verify with), `keys.ts` (the trusted seal keys and their time in use),
`signing.ts` (the signed message, which keys may sign, and signing checked against the named public key)
and `tsa.ts` (the RFC 3161
query, the response check and the pinned DigiCert trust). The pin is the CA that issues DigiCert's
timestamping certificates, not the certificate itself, so DigiCert replacing it doesn't stop sealing;
a new CA is a change to `tsa.ts`, and the deployment's configuration can't add one. Revocation of the
TSA certificates is not checked, and the certificate says so.

**Audit trail** (`src/app/server/esign/audit.ts`): the signing link issued, the page opened, each code sent, the
code verified, the document fetched, pages viewed (the page posts `POST /api/public/signing/page-views`
for pages at least half on screen for a second; each page is recorded once), the signature, a void,
decline or expiry, completion and each signed copy sent. Signer steps record the IP Cloudflare saw
(`CF-Connecting-IP`) and the user agent.

**Consent** (`src/app/server/esign/disclosure.ts`): the page shows the server's consent text; signing sends its
version, an old version is refused (`409 disclosure_changed`), and the signature facts and audit
event record the version and its SHA-256.

**Delivery PDF.** `GET /api/envelopes/:id/delivery-pdf` returns the final signed PDF, page for page,
with certificate pages appended: the document (pages, status, the seal's time, authority and key
fingerprint, the original and signed SHA-256), each signer (sealed email, title and company, who named
them, how they were identified, consent version, IP and device) and one table of events with who and
from which IP. Every fingerprint and the full audit trail stay on the certificate of completion. It
is created on the first request (`envelopes/<id>/delivery-v2.pdf` for the managed seal,
`local-delivery-v4.pdf` for the local one) with a conditional create; later
requests rebuild it and check the stored bytes match. The seal covers the signed PDF, not the
delivery PDF. There is no endpoint for the signed PDF alone. After completion each signer is
emailed a link to this PDF once (`src/app/server/esign/signed-copies.ts`), which the public `/copy`
page downloads once, within 30 days (`POST /api/public/copies/open`); a failed send is retried by
due work for envelopes created in the last seven days.

## API

Management routes take the Insulin platform identity (the console, insulinapps.com, an MCP client
or a service-account token, all through the gateway) and see only the caller's organization, and in
it only what the caller owns or is shared with (any other id answers 404). Reading needs `esign.view`,
anything else `esign.manage` (but setting one's own tags); a template or an envelope also needs the
caller's role in it (`ownership.ts`). A request
the gateway marks public or as its tick (`x-suger-access-via: public` or `schedule`) never reaches
them. `GET /api/catalog` lists
the routes the caller may use, with JSON Schemas. Routes marked † are available only while signing
is enabled.

**Management**

| Route | Purpose |
| --- | --- |
| `GET /api/me` | The caller: organization, user, role, permissions, how the request came, whether signing is enabled |
| `GET /api/catalog` | The management routes the caller may use |
| `GET /api/templates`, `GET /api/envelopes` | The templates and envelopes the caller sees, newest first (`limit`, `before`, `scope`, `tag`; envelopes also `status`), each with its owner, the caller's role and tags |
| `POST /api/process-due` † | Expires envelopes past a deadline, finishes envelopes the signing request did not, and retries completion notices, for the caller's organization, at once (the platform's tick does it for every organization every five minutes) |
| `POST /api/templates` | Multipart `file` (PDF, at most 5 MiB and 100 pages) and `roles` (JSON array, 1–20 unique names of `[A-Za-z0-9_-]`), optionally `name`, `metadata` and `defaultSigners`; returns `{id, roles, defaultSigners, ...}` |
| `POST /api/templates/:id/default-signers` | Replaces the template's default signers; a recipient of a new envelope that leaves out its name or email gets its role's |
| `GET /api/templates/:id` | Roles, the placed fields (type, role, page, normalized box) and whether they can be signed (`positionedFieldsSupported`) |
| `POST /api/envelopes` | Creates and prepares an envelope (lifecycle step 2); `Idempotency-Key` required |
| `GET /api/envelopes/:id` | Status and tasks (role, name, email, order, status, `expiresAt`, `openedAt`) |
| `POST /api/envelopes/:id/void` | Optional `{reason}` (at most 500 characters); a repeat is a no-op; any status other than `IN_PROGRESS` answers `409 envelope_not_voidable` |
| `GET /api/envelopes/:id/audit` | Events with type, time, recipient, IP, user agent and an allow-listed detail; never codes or message ids |
| `POST /api/envelopes/:id/tasks/:taskId/recipient-view` † | `{origin?, hostAuthentication?}`; returns `{code}` for the active task |
| `GET /api/envelopes/:id/delivery-pdf` | The signed PDF with its certificate, for a `COMPLETED` envelope |
| `GET /api/envelopes/:id/certificate` | The completion certificate as JSON (shown on the envelope page), verified on every read |
| `GET /api/contacts`, `GET /api/contacts/:id` | The address book, most recently used first (`q`, `limit`, `cursor`), and one contact with the envelopes that name them |
| `POST /api/contacts`, `POST /api/contacts/:id`, `POST /api/contacts/:id/delete` | Add a contact (or change the one with that email), change one, delete one |
| `GET`/`POST /api/{templates,envelopes}/:id/shares`, `POST .../shares/delete` | Who sees it; share it or change a role (admin); stop sharing (admin, or oneself) |
| `POST /api/{templates,envelopes}/:id/tags`, `GET /api/tags` | Replace one's own tags on it; one's tags, most used first |
| `GET /api/members` | Members Esign has seen, to share with |
| `GET /api/owners`, `POST /api/owners/:id/transfer` | Organization owners: everyone who owns something; take over all of it |
| `GET /api/api-clients`, `POST /api/api-clients/:id` | Organization owners and admins: the API clients seen, and whom each one's documents are shared with |
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

**The platform's tick**

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/scheduled` † | `x-suger-access-via: schedule` and no identity (403 otherwise) | Every organization's due work, every five minutes (`insulin.scheduled`); answers `{expired, completed, waiting, failed}`. Not public, not in the catalog |

**Pages** (the React app, `src/app/App.tsx`): `/sign` (the signing page), `/editor/page/:id` (the
editor), `/copy` (a signer's copy) and, at every other path, the members' app (see "The members'
app and the Docs"). **Public API** (declared in
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
- **Rate limiting.** The app has none of its own beyond the OTP budget (per task: three sends and
  five entries per 15 minutes) and its 256-bit page codes. Behind the gateway every request to a
  public path is limited per IP (`RL_APP`), and those that aren't GET or HEAD (the code exchanges,
  code sends and code checks among them) also per app and IP, more strictly (`RL_PUBLIC`).
- **Deprecated endpoint.** Delete `POST /api/envelopes/:id/prepare` once no host calls it.
- **Retention and integrity.** No retention policy; the object store's create-only writes are not
  WORM; privileged changes to D1 or keys remain possible and are detected only where the checks above
  re-verify. Orphans are never cleaned up. A recorded signature cannot be rolled back if its input
  changes in storage before rendering; rendering then fails and the row stays `PENDING`.
- **Due work.** Between the platform's five-minute ticks, deadlines, unfinished envelopes and unsent
  notices wait for the next signing request on the envelope or a `POST /api/process-due`. One run
  looks at up to 25 envelopes to finish and 25 owing signed copies; a backlog takes several ticks.
- **Blank editor sessions.** `POST /api/public/editor/save` still accepts a file for a session
  without a bound source, for older clients; the embedded UI does not.
