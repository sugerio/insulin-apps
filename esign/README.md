# E-sign local experiment

This is an **experimental local-only service for synthetic data**, not a production e-sign service. The local Worker supports one-PDF templates, tenant API keys, envelopes, sequential recipient sessions with email OTP, explicit consent, and D0 → D1 → D2 signing. The React recipient page is separate from management API calls. Signing routes require `LOCAL_TEST_MODE`, a separate local test mailbox bucket, and test keys; they do not send real email. Only `example.com` or `.test` recipient addresses can receive test codes. Test mailbox contents are plaintext in local R2 storage and must never be used with real data.

**No automatic processing or recovery:** after each signature the caller must invoke the envelope `process` endpoint; after the final PDF it must invoke `finalize`. Retrying these requests is supported. The caller must poll the envelope for changes and is responsible for reminders. If an object write succeeds but the database fails, a retry checks the existing object; unreferenced objects can still remain and need manual investigation. Do not delete an object on an ambiguous database failure.

OTP challenges and verifications bind the exact task email stored when the code was issued; signing also records that address and rechecks it in its D1 transaction and on signer retry. The local path preserves address bytes exactly; the isolated Cloudflare candidate accepts only its explicitly configured lowercase ASCII addresses. Historical challenges, verifications and signature records with no address snapshot are not backfilled: they cannot authorize a new signature or signer replay. Existing facts and artifacts are not rewritten. Migrations `0025`–`0027` have been exercised only on isolated synthetic databases; do not apply them to retained or running user data without review and authorization. Migration `0027` rejects changes to an existing task's email, including case-only changes, so an ordinary UPDATE cannot change it away and back. It does not reconstruct earlier changes, prevent privileged schema changes, or make task deletion/replacement or role changes impossible; there is no immutable recipient revision or production identity boundary.

A standalone candidate Cloudflare Email Sending adapter exists in `src/cloudflare-otp-mail.ts`. It requires an explicit `enabled: 'true'`, a sender address and a `SendEmail` binding; the isolated candidate private recipient binding uses it for OTP when explicitly configured. The public Worker cannot send mail or enable signing. Its binding integration and delivery have not been tested on Cloudflare. Before any future integration, the deployment trust boundary, authorization, sender verification, delivery failures and production security must be independently resolved; do not deploy or send mail without authorization. The Worker never includes plaintext OTPs in its response, even when `LOCAL_TEST_MODE` is enabled; it writes them to the separate local test mailbox. The isolated Node loopback demo reads the freshly created mailbox message and adds the code to the recipient response for display. The generated/uploaded Node loopback experiments do likewise. These adapters must never be exposed publicly or mounted in a Worker. Loopback, Host and Origin checks are not user authentication: local processes, other users and browser extensions can access or impersonate the demo. Use only a trusted single-user machine with synthetic data. The separate candidate Worker does not include the Node adapter.

The `COMPLETED` state means **local test completion only**: finalization checks hashes and signing-event links and writes a local manifest with fake HMAC-based test KMS/TSA tags. They use a software test key; the synthetic timestamp is derived from the last signing time, not an independent clock. They are not a managed KMS or external timestamp authority and provide no independent time, retention or legal proof. Local R2 conditional writes are not WORM and privileged mutation remains possible. Real KMS/TSA, verified immutable storage, real email, safe wrong-recipient termination and independent security/legal review are unresolved production blockers. PDF handling is preliminary. Names unsupported by the local Helvetica font or too wide for the signature page at its fixed font size are rejected at envelope creation with `unsupported_recipient_name`. Width is calculated from unadjusted glyph advances, matching the PDF renderer rather than assuming kerning. Before signing, all recipient names are checked again, including on older envelopes. Previously recorded pending jobs with an unrenderable name fail safely instead of producing a clipped PDF; already generated outputs require manual review.

For fieldless templates, shared signature-page placement is tracked in server-side records linked to each output, not inferred from PDF metadata or content. Before recording a signature, the service reads and hash-checks the input PDF and verifies its page count against the predecessor layout; the signing database batch rechecks that the input object key and layout have not changed and stores a layout snapshot for processing. Processing uses that snapshot rather than a later predecessor layout. Each signing input is hash-checked and each output is a separate artifact. Previously generated outputs from the older per-signer-page implementation have no trusted layout record: a later signing attempt on such an envelope is rejected atomically before a signature fact, event or job is recorded. Any previously recorded non-first pending job without a signing-time layout snapshot fails processing and requires manual handling, even if its predecessor has a layout record; there is no automatic repair, migration or termination. A pending first signature can proceed if no incompatible orphan output exists; an old conflicting orphan fails closed. Completed older envelopes remain readable through the existing evidence paths. This is a local integrity boundary, not protection against privileged database or storage mutation. Storage can change after the pre-signature read: a later hash mismatch blocks processing but cannot roll back an already recorded signature. Local R2 is not WORM.


### Local typed positioned signatures: support matrix

Signature artwork now uses a fixed 30-point bitmap height, extends to the right when necessary, and is rejected before signing if it would cross the page or another role's field. Preview and PDF placement use the same image and geometry; a preview digest binds signature and Title inputs to the current artifact and template, while Date uses its server preview identity. These checks do not prove that a person actually saw the preview. Title and date use upright, compact text. Renderer and placement changes are not backwards compatible: previously recorded local signatures, jobs, PDFs, or evidence may fail verification or reprocessing. Existing artifacts and evidence are not migrated, overwritten, or deleted; use new synthetic envelopes for testing.


| Capability | Local support |
| --- | --- |
| Fieldless templates | Legacy `POST /v1/templates` compatibility API and existing templates use v1 append-only signature pages; historical v1 evidence remains unchanged |
| Positioned Signature fields | Editor saves require exactly one per role; older supported positioned templates may have multiple, with required fields enforced |
| Initials, dates, text, checkboxes and other positioned fields | Not supported; envelope creation fails closed |
| Signature input | Uppercase Latin letters and single spaces, 1–64 characters; server-rendered slanted single-stroke alphabet. Typed text is not the authenticated recipient name |
| PDF geometry | Unrotated, uncropped pages with zero media-box origin, default units, no annotations or PDF forms; minimum 20 × 10 points per signature field |
| Local mock evidence | v2 event binds the complete field definition, role, document input, typed text, fixed font identifier/hash and PNG hashes; each output PDF hash is recorded separately |
| Real KMS/TSA seal | v1 only. Positioned v2 is rejected before remote signing; it is **not** sealed by the independent real-seal verifier |

The recipient must verify the test OTP, review the document, type a signature for each required field, inspect the server-generated preview at its marked position and size on the PDF page, and consent. Markers and inputs show the role and signature with page-specific accessible labels (numbered when a role has multiple historical fields); the fixed-height image starts at the top left of each rectangle and may extend right, as in the final PDF. An optional empty field is omitted. Only the active recipient's own fields are exposed and accepted. The same text and font are rendered on the server; arbitrary client images are never accepted. A successful retry must contain the same input artifact and exact field values, and an expired session cannot replay. Concurrent attempts can leave unreferenced image objects; keep them for investigation. The signed event and its captured template/field snapshot are committed atomically in local D1; image objects are conditionally created before that batch. Processing uses the captured image bytes, not a later client rendering, and verifies their hashes, the captured event and input PDF hash before placing each image at its captured geometry. Output PDFs are separately created without overwriting inputs. Local completion verifies image, event and artifact hashes and seals a v2 local manifest with the existing **fake** HMAC test adapters. It is not WORM, independent time, legal proof or production protection. Storage mutation between acceptance and processing can still block processing after a signature fact has been recorded; preserve all objects and facts for investigation. Historical v1 manifests and outputs are not rewritten.

## Investigating a missing signing-time layout

The management `process` endpoint returns HTTP 409 with `signature_input_layout_missing` when a non-first pending job has no captured input layout. This can be a pre-0012 job or a missing/corrupted snapshot; the error alone does not establish which. The upgrade does **not** automatically recover these jobs. The older layout row can be changed or deleted and the signing event did not bind its slot or page count. Even when the current predecessor is DONE and its artifact ID, hash, PDF bytes and page count match, those checks cannot prove which slot existed at signature time. Reconstructing it from PDF contents would trust untrusted input. There is no trusted historical layout evidence in the existing local records, so automatic backfill would invent a signing-time fact. Solving this legacy recovery, as well as safe termination, remains a production blocker.

For local synthetic-data investigation, stop processing the affected envelope and preserve the D1 database, all related R2 objects, signature facts, events and jobs; do not insert a snapshot, alter statuses or delete evidence. From `esign/`, this **read-only local** query lists potentially affected envelope and job IDs (it does not diagnose why a snapshot is absent):

```sh
npx wrangler d1 execute esign-local --local --command "SELECT r.envelope_id, r.id AS signature_id, j.id AS job_id, r.sequence, r.input_artifact_id, r.input_sha256 FROM signature_jobs j JOIN signature_records r ON r.id=j.signature_id LEFT JOIN signature_input_layouts l ON l.signature_id=r.id WHERE j.status='PENDING' AND r.sequence>1 AND l.signature_id IS NULL ORDER BY r.envelope_id,r.sequence"
```

Retain the affected local state for manual review and record the envelope and job IDs outside the service. Do not mark the envelope terminated or completed: there is no termination or repair endpoint. For a separate synthetic test, create a new envelope and repeat the signing workflow; that does not replace or erase the old signing facts. There is no approved way to resume the affected job from current evidence. Investigating external historical evidence or designing a verified recovery/termination procedure requires independent review; do not treat this experiment as suitable for real users or deployment.

## Embedded template editor (local experiment)

The host at `http://127.0.0.1:5173/editor-host.html` opens the editor as an iframe on the separate Worker origin `http://127.0.0.1:8787`. Use **synthetic PDFs only**. Preset comma-separated roles and choose exactly one source in the host. Choose a synthetic PDF file in the host for the isolated local URL demo, or reopen an existing template within that demo. The host sends the file to its local BFF, which issues a short-lived, single-use virtual URL and passes it to the isolated E-sign downloader; E-sign stages the bytes before opening the iframe. The HTTPS URL field sends the URL to the management backend, but external URLs are disabled because no approved safe downloader is configured. The iframe reads the bound source from its authorized same-origin PDF URL; it has no upload or save button. Drag Signature, Date signed or Title onto a page, or use its keyboard-focusable Add button. Move fields by dragging or with arrow keys and Page Up/Down; select a field to delete it. New fields are required. Date signed and Title may be saved in templates. Signing with either remains blocked in the ordinary Worker and original demo; only the explicitly isolated local V3 demo described below enables them. Select the role for new fields from the list supplied by the host. Dragging also moves fields between pages. Fields on the same page cannot overlap; touching edges are allowed. Each role must have exactly one Signature field before saving; missing, duplicate and unsupported fields must be corrected, including when editing an older template. Save creates a new immutable ID; paste that ID as source to edit and save another version. The source PDF is not replaced in an editing session. Editing locks while saving and stays locked after success; open a new session to make further changes. Existing templates retain case-distinct role names exactly as stored; the editor does not add roles. The host's **Save template** sends a request-ID-bound save command to the editor iframe. The editor validates and returns the new template ID, but the host displays it only after its backend confirms the same ID for the editing session; **Check save** handles a lost or uncertain response. A validation error allows correction and retry; an uncertain save keeps Save template locked to avoid creating a duplicate. A null Check save result does not establish that a request cannot still commit: check the same session again later. If it remains unresolved, a new session can be opened only as a separate attempt; the earlier request may still produce a committed template version. Preserve and investigate both versions and any unreferenced objects; do not delete or rewrite them. The URL demo's editor and signing host share their local D1 and R2 state; this state is separate from any other local instance. Compare the confirmed saved template ID with the ID shown on the selected envelope: opening or editing a template without a confirmed save does not change it, and saving creates a new template ID without retargeting existing envelopes. After a restart, the host can restore the previously selected envelope; check its template ID before signing. A running demo may still be using an older build until its owner deliberately restarts it; do not assume that new code is active. The PDF pane in the editor scrolls independently of the field panel. Reopening the same one-use iframe link is not supported: open a new session.

Fields are normalized to the displayed page's top-left, independent of display scale. PDFs with rotated pages are rejected on save, rather than risking incorrectly positioned fields. Limit: 5 MiB, 100 pages, 20 unique roles, 200 fields, and valid in-page geometry. Each preview renders in a separate detached container and becomes visible and saveable only after every page finishes. The embedded editor fixes its source for the session. Rendering also has pixel budgets; an unrenderable PDF cannot be saved in the UI. These are local resource limits, not a hardened PDF sandbox. **Ordinary Worker positioned signing supports only Signature fields**, with at least one field for each role and at most 20 fields per template. Templates containing any other field type or overlapping fields are rejected when starting an ordinary envelope, rather than silently ignoring fields. The explicitly isolated V3 Node demo below also supports Date signed and Title. Existing overlapping template versions remain stored and readable but cannot start a new signing flow; already captured historical evidence is not rewritten. Rotated or cropped pages, nonzero media-box origins, custom page units, annotations, PDF forms and fields smaller than 20 × 10 PDF points are rejected for this flow. Existing fieldless templates and templates created by the legacy compatibility API retain the append-only signature page flow. Role-based display names are derived from existing role data and are not new evidence fields; v1 event encoding and historical evidence objects are unchanged; new positioned events also bind image geometry.

For an isolated demo without changing an existing instance, from the repository root run the following in one shell. It requires ports 5173, 8787 and 8788 to be free; do not stop another user's processes. It copies source into a fresh temporary directory and builds there. Miniflare persists its D1 and R2 state and local test keys under the private path in `ESIGN_EDITOR_DEMO_STATE`; retain that path to restore templates after restarting. Use only synthetic data, protect the directory and its keys, and never run two instances against the same state.

```sh
export ESIGN_DEMO_DIR="$(mktemp -d /tmp/esign-editor-url-XXXXXX)"
mkdir "$ESIGN_DEMO_DIR/app"
tar -C esign --exclude=node_modules --exclude=.wrangler --exclude=dist --exclude=dist-ui --exclude=.dev.vars -cf - . | tar -C "$ESIGN_DEMO_DIR/app" -xf -
ln -s "$PWD/esign/node_modules" "$ESIGN_DEMO_DIR/app/node_modules"
cd "$ESIGN_DEMO_DIR/app"
export WRANGLER_SEND_METRICS=false CI=1
export ESIGN_EDITOR_DEMO_STATE="$HOME/.local/share/esign-editor-demo"
npm run build
npm run dev:ui &
ESIGN_EDITOR_URL_DEMO=YES npm run dev:editor-url-demo
```

Stop only processes you started. The BFF and editor service listen on loopback without local-user authentication; a local process or browser extension can impersonate requests. Use only on a trusted single-user machine with synthetic files. They are not deployable. The management key and test-only keys are generated in the private local state directory and are not sent to browser code. The local URL is a virtual `https://editor-source.invalid/<random-token>` handle, not a network endpoint: an injected adapter resolves it only against the private in-memory registry, once, for at most 30 seconds. There is no DNS or HTTP request for this handle, and it is never printed or sent to the browser. The registry keeps at most 16 files of 5 MiB and removes entries after use, failure or expiry. This simulates the URL handoff and cannot validate a real S3 network connection. The ordinary Worker and BFF do not provide this demo adapter.

### Isolated Date/Title local V3 demo

This is a **synthetic-data-only, trusted single-user Node loopback experiment**, not production signing. It enables the independently reviewed V3 candidate only in the explicitly opted-in Node demo process. The ordinary Worker and the separate Cloudflare candidate remain closed to Date/Title signing; no Worker environment variable enables this feature. Use new dedicated ports **5197, 8797 and 8798** and a fresh private state directory. Check that these ports are free; never stop another process. The V3 demo refuses an unmarked nonempty state directory and rejects the original demo ports. Do not point it at existing or retained evidence, run multiple instances against one state, or expose it through a network proxy.

From the repository root, use a separate temporary copy and two shells. This installs no new dependencies and builds without deployment:

```sh
export ESIGN_V3_DIR="$(mktemp -d /tmp/esign-v3-demo-XXXXXX)"
mkdir "$ESIGN_V3_DIR/app"
tar -C esign --exclude=node_modules --exclude=.wrangler --exclude=dist --exclude=dist-ui --exclude=.dev.vars -cf - . | tar -C "$ESIGN_V3_DIR/app" -xf -
ln -s "$PWD/esign/node_modules" "$ESIGN_V3_DIR/app/node_modules"
export ESIGN_EDITOR_DEMO_STATE="$(mktemp -d /tmp/esign-v3-state-XXXXXX)"
cd "$ESIGN_V3_DIR/app"
export WRANGLER_SEND_METRICS=false CI=1 ESIGN_EDITOR_V3_DEMO=YES
npm run build
npm run dev:ui &
ESIGN_EDITOR_URL_DEMO=YES npm run dev:editor-url-demo
```

Open `http://127.0.0.1:5197/editor-host.html` to save a template and `http://127.0.0.1:5197/host.html` to start an envelope. Retain the same private `ESIGN_EDITOR_DEMO_STATE` path and restart the two commands with the same settings to reopen saved templates. Stop only your own processes. The test mailbox displays a six-digit synthetic OTP on each recipient page; no real email is sent. A recipient sees only fields assigned to that role. Type uppercase or lowercase Latin letters for Signature and printable ASCII, at most 128 characters, for Title; a title and the server date must fit the field at the fixed text size. Signature uses handwritten artwork; Date and Title use upright text. Date and Title have about 80% of the visible height of a reference signature capital H (and date digits), not every individual glyph; ascenders, descenders and lowercase letters naturally vary. New editor boxes are 150 × 34 PDF points, mapped from the page top-left. Dragging a toolbar field previews the box at the target page scale, centered on the pointer and constrained to the page. They show the starting area, not a maximum signature width: the arrow indicates a signature may extend to the right. Keep that area clear. The server rejects signatures that would cross the page or another field, and rejects dates or titles that do not fit their boxes. Date signed is a server-generated UTC date. Date previews from before text-geometry binding must be refreshed. Old pending V3 events without captured text geometry cannot be processed; retain them for investigation rather than rewriting evidence. A preview is valid for at most five minutes and no longer than its session; if it expires or the UTC date changes, refresh the date preview and review before signing. Process each signer sequentially. Exact retries of an already recorded signature recover the same local fact; changed values are rejected.

The local test seal is an HMAC and simulated timestamp, not a real KMS signature, trusted TSA or WORM retention. Test mailbox codes and local keys are readable in the private state. Loopback, origin headers and the state marker do **not** authenticate local users, processes, browser extensions or compromised content. A failed or ambiguous operation may leave orphan objects; do not delete or rewrite evidence automatically. D1 checks session/preview time and UTC date inside the transaction, but the physical COMMIT instant at a UTC boundary has not been independently frozen and verified; R2 and D1 are not atomic. The screenshot tests do not prove a person actually saw the preview or that extensions/overlays cannot hide it. Do not use this service for real contracts or deploy it.

### Staged editor source (local demo)

For a new document the management backend creates an editing session and posts PDF bytes, not a URL, to `POST /v1/template-editing-sessions/:sessionId/source` with `Content-Type: application/pdf`. The source is scoped to the management tenant and session, can be bound only once before exchange and before the two-minute page expiry, is capped at 5 MiB/100 pages and parsed as a PDF. It is stored under a unique conditional-create object key; its SHA-256 is bound in D1 and checked both when the iframe reads `/v1/editor/pdf` and when the server saves. An attempted file replacement in a staged or existing-template session is rejected. The editor sends only fields; the server uses the bound bytes. Staged objects are not templates and do not appear in the template list. Concurrent or failed uploads can leave unreferenced objects; there is no automatic cleanup or recovery. Preserve ambiguous objects for investigation. On upload failure or timeout, start a new session; do not assume the first upload did not commit. Existing blank-session API behavior is retained for old clients, but the embedded UI refuses an unbound source.

The management session API accepts `sourceUrl` in its authenticated JSON body, never in an E-sign request URL. The Worker has **no external downloader configured**: URL-backed creation fails closed. A host may enter a signed URL in the local demo, but it will fail; the isolated local file demo uses the in-memory URL adapter described above. The URL is not persisted in D1 or R2, and errors omit it. Treat it as a bearer secret: the input is cleared on opening, but the host backend, browser network tools, extensions and compromised host scripts can observe it. Do not log it.

The editor route has a code-level downloader injection seam for isolated tests only. A production adapter would need independent validation of the actual connected destination, DNS rebinding and private-address prevention, exact allowed HTTPS origins and ports, no redirects, bounded streaming, timeout and error handling. A hostname allowlist or ordinary Worker `fetch` is not sufficient. No production adapter or approved network boundary is provided; real URL support remains a deployment blocker. The in-memory local adapter is not a network security control. The route caps and parses the returned PDF before conditionally storing it under a fresh session key and binding its hash. The legacy direct-byte staging API remains for compatibility. Failed or ambiguous writes may leave unreferenced objects; do not delete them automatically. Staged objects are retained indefinitely in this local experiment.

Existing-template sessions bind a SHA-256 of the tenant-owned source bytes when the session is issued. Both preview and save re-read the source and verify that same hash; missing, changed, oversized or unreadable bytes fail closed. A source object changed after one successful read cannot cause a later read to accept different bytes. No original template or historical evidence is rewritten. Sessions issued by older versions without the hash cannot preview or save; open a new session instead. Privileged mutation of both storage and D1 remains outside this local integrity boundary.

### Editor integration and trust boundary

The tenant backend calls `POST /v1/template-editing-sessions` with its management bearer key and `{allowedParentOrigin, roles?, sourceTemplateId?, sourceUrl?}`. Origin must already be in that tenant's `editor_allowed_origins`. The response contains a random session/page ID and URL with a one-use, two-minute code in its **fragment**; never log, forward in a Referer, or persist it. The page ID alone is not an authorization credential. The dynamic page response looks up the tenant-bound parent and sets `Content-Security-Policy: frame-ancestors` to that exact origin, `no-store`, and `Referrer-Policy: no-referrer`. The iframe removes the fragment from browser history before exchanging it at `POST /v1/editor/exchange`. A 15-minute editor-only bearer token stays in iframe memory and authorizes only `/v1/editor/*`; the management key never enters the browser. The iframe's same-origin API requests have the **E-sign** origin, not their parent's origin. Do not infer a parent from that header or from a message. Revoking the allowlist entry invalidates the editor session.

The editor posts a ready notification, save notification, or request-ID-bound save result only to the bound parent origin. The host checks **both** the message origin and the current iframe window source; even a valid message is only a prompt. Its authenticated backend must call `GET /v1/template-editing-sessions/:sessionId` with the tenant management key and use the returned `templateId`, not a client-supplied ID. One session permits one committed save. A concurrent or lost-response save can leave an unreferenced object; do not delete it, because a database result may be ambiguous. A new session is required for another version.

CSP constrains compatible browsers, not arbitrary HTTP clients or user identity: **a stolen code is a bearer credential and can be redeemed outside a browser**. A malicious same-origin host script can also observe its own iframe URL. Protect the host, isolate untrusted scripts, use HTTPS in any non-loopback experiment, and never put codes or tokens in logs or query strings. This local implementation has no production rate limiting, user login, key rotation, CSP deployment review, PDF isolation or operational recovery and is not approved for deployment or real documents. Existing prototype `editor_codes`, `editor_sessions`, and `editor_templates` tables and their helpers are not used by this integration; versions saved through the old unmounted helper are not usable by the editor or signing flow.

## Run locally

The same Worker can also serve the recipient signing page itself, finish envelopes on its own and run on Cloudflare (still in local test mode): see [WORKER-MODE.md](WORKER-MODE.md).

Node 24 and `jq` are needed for the examples. These commands only use local Wrangler resources:

```sh
npm ci
npm run db:migrate:local
npm run db:seed:local             # adds one synthetic tenant, key and UI origin
cp -n .dev.vars.example .dev.vars # fixed synthetic test material; never deploy it
npm run dev                       # terminal 1: 127.0.0.1:8787
npm run dev:ui                    # terminal 2: 127.0.0.1:5173
```

## Interactive local test host

After the migration, seed and `.dev.vars` setup above, run the Worker and UI commands above and a third terminal:

```sh
ESIGN_LOCAL_HOST=true ESIGN_LOCAL_KEY=local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz npm run dev:host
```

Open `http://127.0.0.1:5173/host.html`. Select an existing template (or create one with a **synthetic** PDF), enter a name and test address for each template role, and start signing. For a fieldless template the first signature adds a shared signature page, subsequent signatures append there in signing order, and a continuation page is added when full. A template with supported positioned Signature fields instead places a server-rendered image in each filled field on its original page. Open the first signing view and click **Send test code**. In the isolated editor demo the six-digit code is displayed on the page. With the ordinary Wrangler Worker described above it is not displayed; retrieve its message using the ID shown and the `wrangler r2 object get` command below. Enter the code, review, consent and sign. Click **Process signature**, then open each remaining signer’s view and repeat with its own message ID and OTP. Process each signature, finalize, and select **View final PDF** to inspect or download it. Select **View completion certificate** to inspect a readable certificate and optionally download its JSON snapshot; it does not modify or replace the signed PDF. Select **View delivery PDF with certificate** for a separate PDF containing the final signed PDF followed by certificate pages. Refresh status as needed. Only `example.com` or `.test` addresses are accepted for test mail; no email is sent.

### Embedded PDF display and local security boundary

Chrome can block its built-in PDF viewer when the PDF is nested under the sandboxed recipient frame. The observed failure occurs after a successful authenticated PDF fetch; an iframe `load` event cannot establish that the viewer actually displayed the document. The recipient page instead renders every page to canvas with PDF.js, keeping the existing outer sandbox (`allow-scripts allow-same-origin allow-forms`) unchanged. Consent and signing are offered only after all pages render successfully; a fetch, parse or render error clears the partial document and offers **Retry document**. Each render uses a private container; a newer load or page exit cancels the PDF.js loading/render task and prevents an older result from replacing the preview. Page canvases keep the exact PDF viewport aspect ratio in CSS, including at responsive widths; only their bitmap dimensions are rounded, and the render transform fills that bitmap so positioned signature previews stay aligned. Canvas allocation is limited to 16,777,216 pixels per page, 50,331,648 pixels total, and 8,192 pixels per dimension; exceeding a limit fails the preview and blocks signing. These limits cover output canvases, not all PDF parser, decoded-image, network or input-buffer memory; reading an already-started Blob into memory cannot be cancelled. PDF.js is configured with `stopAtErrors: true`. In the pinned PDF.js 5.4.624, a render can nevertheless resolve after an operator-stream error, so the preview also requires an actual final operator-list chunk; if this internal completion hook is unavailable, preview fails closed. This is a version-specific workaround that must be revalidated on any PDF.js upgrade. Neither the option nor the workaround detects all damaged or incompletely rendered PDFs; a successful preview is not a guarantee of complete or accurate parsing. This is not proof that a person read or understood the pages, and a malicious or broken client can bypass UI checks. The server checks the verified session, consent assertion and current artifact, not visual display. Canvas display also lacks selectable text and is not an accessible PDF reader; do not use it for real signing.

The host and recipient frame share the seeded UI origin: the sandbox does **not** provide a strong identity or privilege boundary, especially with both `allow-scripts` and `allow-same-origin`. The one-use recipient code and OTP bind a local session to the recipient task; they do not isolate the page from a compromised same-origin host, local user or extension. The host CSP limits framing to self/blob and blocks objects, while Vite supplies `frame-ancestors 'self'`; these policies are local defense in depth, not a production deployment policy. PDF.js runs on untrusted PDF bytes in the browser (dynamic code evaluation disabled), but malicious or unusually large PDFs can still exploit parser bugs or exhaust resources. Use synthetic files only. No sandbox permissions were added; never treat this local setup as a production embedding design.

The host remembers only the last envelope ID in local browser storage. After refresh, use **Refresh status** and issue a new view for the active signer; codes are one-use and short-lived, and session/OTP limits still apply. If preparation failed, use **Retry prepare**. Processing and finalization are explicit and retryable; there is no background recovery. A failed or superseded launch can leave an unused envelope in local storage. The browser developer console warns with any IDs returned for superseded creates; copy those IDs for investigation. This console record is not durable, and a lost response may leave an unknown ID. In-flight preparation may already have completed. Nothing is automatically deleted; investigate local D1/R2 state without deleting objects on ambiguous failures. See the recovery caveats above.

The separate Node host BFF listens only on `127.0.0.1:8788`, starts only with the explicit flag and a key, checks the loopback Host, browser Origin and a custom request header, and proxies only fixed management paths to the local Worker. The Vite server proxies `/host/`; never expose either server on a network, use a real key, or run alongside untrusted local users or browser extensions. Browser JavaScript does not receive the management key. The recipient frame stays on the seeded UI origin, is framed under a same-origin CSP, and does not use cross-window messages. The BFF and browser are a convenience for a single trusted local tester, not a production isolation boundary. The final-PDF endpoint is management-authenticated, tenant-scoped, limited to completed local envelopes, and verifies the stored output hash; it never accepts an object key. Local mailbox records remain plaintext and are not automatically deleted.

The seed's **public synthetic local-only** management key is `local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz`. Never use it outside this experiment. It belongs in the calling backend, not in the recipient page. Replace the sample PDF with a synthetic PDF if desired:

```sh
node --input-type=module -e "import {PDFDocument} from 'pdf-lib';import{writeFile}from 'node:fs/promises';const p=await PDFDocument.create();p.addPage();await writeFile('/tmp/esign-sample.pdf',await p.save())"
KEY=local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz
API=http://127.0.0.1:8787
TPL=$(curl -fsS -H "Authorization: Bearer $KEY" -F file=@/tmp/esign-sample.pdf -F 'roles=["ana","marcus"]' "$API/v1/templates" | jq -r .id)
ENV=$(curl -fsS -X POST "$API/v1/envelopes" -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -H 'Idempotency-Key: sample-1' -d "{\"templateId\":\"$TPL\",\"recipients\":[{\"role\":\"ana\",\"name\":\"Ana\",\"email\":\"ana@example.com\"},{\"role\":\"marcus\",\"name\":\"Marcus\",\"email\":\"marcus@example.com\"}]}" | jq -r .id)
curl -fsS -X POST -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV/prepare"
curl -fsS -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV" | jq .
```

A recipient may carry a sign-by deadline: `"expiresAt": "<ISO 8601>"` on its entry in `recipients` (in the future, within 400 days). Once it passes while that recipient has not signed, the envelope becomes `EXPIRED` for everyone: before any request touches it and at the latest on the next cron sweep, with one `EXPIRED` audit event. A recipient who has signed is past their deadline's reach, so a countersigner without one never makes the envelope expire. `GET /v1/envelopes/:id` shows each task's `expiresAt`.

To withdraw an envelope nobody has finished signing, void it from the management side. Every signing path requires `IN_PROGRESS`, so a `VOIDED` envelope can no longer be opened, verified or signed; the audit trail records one `VOIDED` event with the optional reason (at most 500 characters). Repeating it is a no-op, and an envelope already `FINALIZING` or `COMPLETED` answers 409 `envelope_not_voidable`:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"reason":"Wrong version"}' "$API/v1/envelopes/$ENV/void"
```

A recipient who signs for a company may carry `"title"` (at most 128 characters) and `"onBehalfOf"` (the company, at most 200) on its entry in `recipients`, and the envelope may carry `"documentName"` (at most 200). The signing page then shows the intent statement ("I intend this to be my signature on <document> on behalf of <company>."), prefills the title for the signer to correct, and keeps **Sign document** disabled until the signer gives a title and confirms they are authorized to sign for that company. The `SIGNED` audit event records the title, the company, the confirmation and the SHA-256 of the intent statement shown, and the completion certificate prints them next to the signature.

A signer who has passed the code may decline instead of signing, with a reason (at most 1000 characters): `POST /v1/signing/decline {"reason":"..."}`. The envelope becomes `DECLINED` for everyone, with one `DECLINED` audit event carrying the reason, the signer's IP address and user agent; nothing about it can be signed or voided afterwards.

The management side reads an envelope's audit trail with `GET /v1/envelopes/:id/audit`: each event's type, time, recipient (role, name, email), IP address, user agent and a whitelisted detail (reason, title, company, authority confirmation, consent disclosure version, delivery). Codes and message ids are never returned. Another tenant's envelope answers 404.

To test each recipient in order, obtain the current task id from the envelope response, then issue its view from the management side:

```sh
TASK=<current-active-task-id>
CODE=$(curl -fsS -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"origin":"http://127.0.0.1:5173"}' "$API/v1/envelopes/$ENV/tasks/$TASK/recipient-view" | jq -r .code)
printf 'Open http://127.0.0.1:5173/#code=%s\n' "$CODE"
```

The code is one-use and short-lived. The page removes it from the address bar, requests a test OTP and loads the PDF only after verification. The Worker OTP-send API returns only a message ID, never the OTP. The isolated Node loopback demo separately displays the test code; with ordinary local Wrangler retrieve the **test-only** OTP from its local R2 bucket using the unique `messageId` shown on the page:

```sh
MESSAGE_ID=<message-id-shown-on-recipient-page>
npx wrangler r2 object get "esign-local-test-mail/test-mail/$MESSAGE_ID.json" --local --pipe
```

Messages are separate even when two envelopes target the same address. They contain plaintext test OTPs and are not automatically deleted. If document loading fails after verification, use **Retry document**; if the verification response was lost, retry the same OTP in the same still-valid session.
After signing, request processing, poll the envelope, then repeat view/OTP/sign for Marcus. Finally request local test finalization:

```sh
curl -fsS -X POST -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV/process"
curl -fsS -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV" | jq .
# Repeat process after Marcus signs, then:
curl -fsS -X POST -H "Authorization: Bearer $KEY" "$API/v1/envelopes/$ENV/finalize"
```

OTP sends are limited per task with a cooldown and five attempts per 15-minute window. Re-entering after session expiry requires a new view and OTP, without resetting that budget. The present single-template data model does not reuse verification across multiple tasks for the same recipient. A successful HTTP sign can be retried with the same session and document while the session is valid. There is no general queue scanner.

## Validation

`npm test`, `npm run typecheck`, and `npm run build` run local tests, type checking, the Vite build and a Wrangler **dry-run** bundle respectively. The HTTP integration test exercises synthetic Ana and Marcus through independent OTP and consent, verifies the PDF chain and fake seal, and tests tampering and retries. React interaction tests simulate verification-response loss and document-load failures. The host has automated React interaction tests and the BFF route gate is tested. A headless Chrome 156 local harness rendered a synthetic two-page PDF inside the same sandbox and confirmed malformed PDF rejection; it did not exercise the complete OTP/signing flow, and is not production infrastructure validation.

## Local completion certificate

The management-authenticated, tenant-scoped `GET /v1/envelopes/{id}/certificate` is available only for completed local envelopes. It reconstructs the existing manifest from stored signing records, checks its local HMAC and stored evidence hash by comparison, validates event links and checks source and every output file hash before returning the view. It reports stored consent and OTP verification times and event hashes, signing inputs and outputs, and the final hash. The server signing time is the recorded `consented_at` at signature acceptance; it is not an independent timestamp. Envelope metadata and current recipient task details are shown separately and are **not bound by the existing manifest**. The original template filename is not stored. No send, read, IP, identity, SSO or trust-link facts are asserted. The downloadable JSON is a snapshot, not separately sealed; validate afresh through the endpoint. LOCAL TEST ONLY: the HMAC uses a local software key, not real KMS or TSA, and is not a legal guarantee. Privileged database/key/storage modification remains outside this local integrity boundary.


## Local delivery PDF

After local completion, management-authenticated, tenant-scoped `GET /v1/envelopes/{id}/delivery-pdf` verifies the original local evidence and all signed artifacts and appends certificate pages to a **new** delivery PDF. D0, each intermediate PDF and the final signed PDF are not replaced; `final-pdf` and the separate `certificate` remain available. Only facts bound in the existing evidence are included. Certificate pages display the final signed PDF hash, not their own delivery hash. `GET /v1/envelopes/{id}/delivery-metadata` returns the separate delivery SHA-256 and final signed PDF SHA-256. The pre-existing local evidence manifest does not include or protect the delivery PDF or its metadata; these are local integrity checks, not production sealing or independent timestamps.

The current certificate layout uses `local-delivery-v3.pdf` and `local-delivery-v3.json` (metadata format `esign-local-delivery-v3`). Earlier unversioned and v2 delivery objects are left untouched; the endpoints return v3, not a reconstruction of those earlier objects. Each signer’s Events group stays together on one certificate page, including wrapped names. The final signed PDF (D2) is unchanged. The certificate lists only verified bound names, hashes and recorded UTC times; it does not assert unrecorded identity or delivery events. A synthetic multipage v3 PDF was rendered with macOS PDFKit and inspected as images; the v3 layout has not been checked in a real browser or interactive PDF viewer.

The first request creates the delivery PDF and metadata with conditional object creation; D3 does not add a D1 row or change completed signing facts. D1 is read to revalidate the original evidence on each request. The preceding finalization writes its evidence object before its D1 batch; retry finalization after a failed or ambiguous response before requesting delivery. Retries reproduce and check both objects; a conflicting or corrupted object fails closed. A failure between writes can leave an unreferenced PDF, which the next retry checks and reuses. No automatic deletion occurs: investigate ambiguous failures manually and do not delete objects that another request may be using. Requests recheck local evidence and hashes; privileged local storage or database mutation remains possible. These endpoints create local artifacts on GET and are intended only for this single-user experiment, not a production interface.

## Opt-in synthetic AWS KMS probe

`npm run test:kms:synthetic` is an optional local Node/AWS CLI test, separate from the Worker and its default mock finalization. It uses the locally configured AWS CLI profile named in `ESIGN_AWS_PROFILE`, region `us-west-2`, and `alias/esign-local-test-signing`. The script does not verify that the profile uses SSO or belongs to the intended AWS account: independently confirm the caller identity and key alias before running it. Establish the SSO session through the normal AWS CLI if applicable; do not put credentials in this repository. It sends only a fixed synthetic SHA-256 digest to KMS, retrieves its public key, checks the returned key identity and P-256 signing metadata, and verifies the signature locally. The temporary digest file is removed afterward. No signature or key identifier is persisted. The probe will fail if the key or its permitted algorithm changes, the session expires, or permissions/network are unavailable. It never accepts an envelope, document, or arbitrary digest. It does not alter the mock or seal an envelope, manifest, or D3 delivery PDF.

A synthetic RFC3161 query to DigiCert's public HTTP timestamp endpoint returned a granted response in this local experiment; OpenSSL `ts -verify -queryfile` verified the response against the request (including message imprint and nonce), token signature and certificate chain using the machine's `/etc/ssl/cert.pem` bundle. This was a point-in-time check with the local trust store, not revocation checking, an integrated TSA adapter, a durability guarantee, or a legal/commercial authorization. No account was registered; eligibility and licensing remain unconfirmed. The response was not retained and no envelope or D3 was timestamped. HTTP transport is not confidential; only synthetic data was sent.

## Opt-in fixed-fixture KMS + TSA seal

`npm run seal:synthetic` is a separate **synthetic-only local experiment**, not Worker finalization and not production sealing. It accepts no envelope, document, digest or endpoint. The only sealable fixture is a checked-in, hash-pinned bundle generated through the isolated Miniflare Worker signing and delivery flow, with fictional signers and frozen D0–D3. Existing envelopes have no trustworthy proof that their PDFs are synthetic; test-domain addresses and caller markers are insufficient. There is no command for existing envelopes. The Worker, its mock evidence, D3 objects and existing COMPLETED statuses are not changed.

Prerequisites: Node 24, AWS CLI, OpenSSL, `/etc/ssl/cert.pem`, an authorized active session for the profile in `ESIGN_AWS_PROFILE` and access to the dedicated P-256 alias in `us-west-2`. Independently confirm that the profile and alias are the intended authorized resources before running. The command fixes the profile, region, alias and DigiCert public HTTP endpoint; it does not create resources. HTTP sends the synthetic signature imprint and nonce without confidentiality. DigiCert commercial eligibility and licensing are unconfirmed; revocation is not checked. Never use this for real contracts, real users, production or shared resources, or to deploy.

```sh
# A new private temporary workspace is printed before KMS/TSA calls.
ESIGN_SYNTHETIC_SEAL=YES npm run seal:synthetic -- start
# If interrupted, use exactly the printed workspace; preserve conflicting files.
ESIGN_SYNTHETIC_SEAL=YES npm run seal:synthetic -- resume /path/printed/by/start
```

The workspace stores fixture D0–D3, canonical manifest, public key, KMS signature, nonce, RFC3161 request and verified response. It is local temporary storage, not WORM. Conditional hard-link publication and revalidation allow tested retries and concurrent winners without overwriting earlier bytes. A crash or ambiguous remote response may lead to multiple KMS signatures or TSA issuances; partial temporary files can remain. Once the target directory is synced and the published winner is re-read and validated, failure to unlink the temporary candidate does not undo that committed result. The host attempts to emit a warning without the private path (logging itself may be unavailable); keep the workspace private and preserve the leftover file for investigation. It may be a hard link to the winner or a different, valid losing concurrent candidate, and may contain test document or seal data. Such leftovers consume disk space and are not WORM; do not mutate, delete or repair them. Before commit, any primary publication or validation error remains a failure even if cleanup also fails. Do not delete or repair conflicting evidence. The tests cover selected process-kill and concurrency boundaries, not every crash, filesystem or power-loss case. Never commit generated workspaces, AWS identifiers or credentials.

For **separate offline verification**, independently retrieve the expected key fingerprint from the authorized alias, then pass it and a separately trusted CA bundle to the verifier. This example prints only the public-key fingerprint, not the AWS response. The caller is responsible for independently confirming the profile and alias and for choosing a trusted bundle:

```sh
FP=$(aws kms get-public-key --key-id alias/esign-local-test-signing --profile "$ESIGN_AWS_PROFILE" --region us-west-2 --output json --no-cli-pager | node -e "let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>console.log(require('crypto').createHash('sha256').update(Buffer.from(JSON.parse(s).PublicKey,'base64')).digest('hex')))")
ESIGN_SYNTHETIC_SEAL=YES npm run seal:synthetic -- verify /path/printed/by/start "$FP" /etc/ssl/cert.pem
```

The verifier checks the pinned fixture and D0–D3/manifest, key fingerprint, ECDSA signature, nonce, RFC3161 response status/imprint/signature and timestamp certificate chain against the supplied roots. It prints the trust-bundle hash, OpenSSL version and verification time; it does not check revocation or licensing. Its input is not trusted merely because it came from a workspace. Details of exact bytes, nonce derivation and limits are in [SYNTHETIC-SEAL-PROTOCOL.md](SYNTHETIC-SEAL-PROTOCOL.md).

A single fixed-fixture local run used the authorized KMS alias and DigiCert public HTTP TSA successfully. A separate verifier using a freshly retrieved KMS public-key fingerprint and the local CA bundle accepted the retained evidence; copies with altered D3 or timestamp response were rejected. Resuming reused the exact signature, request and response. This is a point-in-time synthetic test, not independent security or legal review, revocation checking, production readiness, or proof about any real envelope.

## Opt-in interactive generated-envelope KMS/TSA test

The separate [`synthetic.html`](http://127.0.0.1:5173/synthetic.html) page operates one **server-generated synthetic envelope** in an isolated local Miniflare Worker, D1 and R2. It creates a blank PDF and two fictional signers itself; the browser cannot supply a PDF, names or email addresses to that instance. The ordinary template-based host is separate and none of its envelopes can use this sealing route. A test address, a checkbox, a mock `COMPLETED` state or an arbitrary existing envelope does not prove content is synthetic. Do not submit real contracts or real people to either local flow.

Start the local UI and host as below. Node 24, AWS CLI, OpenSSL, `/etc/ssl/cert.pem` and an active authorized AWS session are required. Before starting, independently confirm the identity, profile (`ESIGN_AWS_PROFILE`), region `us-west-2` and P-256 key alias `esign-local-test-signing`; this code does not verify the account or that the configured session is SSO. The alias and public DigiCert HTTP endpoint are fixed. These commands do not create cloud resources or deploy anything.

```sh
npm run dev:ui
# In another terminal; only the local host retains this synthetic management key.
ESIGN_LOCAL_HOST=true ESIGN_LOCAL_KEY=local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz \
  ESIGN_SYNTHETIC_SEAL=YES npm run dev:host
```

Open `http://127.0.0.1:5173/synthetic.html`, select **Create synthetic envelope**, and for Ana and Marcus in turn open the signing view, send the local test code, enter the code displayed there, inspect, consent, sign, and select **Process signature**. After both sign, select **Finalize mock completion**, then explicitly select **Seal this synthetic envelope with KMS and TSA**. Mock completion by itself is never a real seal. The page displays the envelope ID and, after sealing, the workspace; the service prints the private instance and evidence workspace paths. The loopback HTTP service has no local-user authentication: another local process can call it with forged browser headers. An existing host, browser extension, local process, or local administrator is not a security boundary; run only on a trusted, single-user machine. Keep the instance and workspaces private; the instance contains local management and OTP keys. Do not commit them.

For an already-running local host/UI, an independent test pair can instead use `ESIGN_SYNTHETIC_ALTERNATE_PORTS=YES` on both commands: the UI is then `http://127.0.0.1:5174/synthetic.html` and the BFF listens only on `127.0.0.1:8789`. Otherwise defaults are 5173/8788. The original Worker on 8787 is not used by the isolated flow. Restart the same pair with the same port mode and set `ESIGN_SYNTHETIC_INSTANCE` to the printed private instance path to resume the same envelope. Select Create again to reconnect. An instance that did not finish creation has no resumable state; preserve it for investigation. Do not start multiple hosts on the same instance, alter/delete evidence or manually repair a conflicting workspace.

The canonical manifest binds that envelope's D0–D3 bytes/hashes and ordered signing-event evidence; D3 is frozen before the manifest and contains no reference to the later seal. KMS receives only the SHA-256 manifest digest. DigiCert receives only SHA-256 of the KMS signature and its derived nonce, over **unencrypted HTTP**. These are still external disclosures, and only server-generated synthetic material is eligible. The browser receives no AWS keys. The page result verifies with the key returned by KMS, but that alone does not independently establish key identity. Obtain the SPKI SHA-256 fingerprint independently from the authorized alias and run the offline verifier:

```sh
FP=$(aws kms get-public-key --key-id alias/esign-local-test-signing --profile "$ESIGN_AWS_PROFILE" --region us-west-2 --output json --no-cli-pager | node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>console.log(require('crypto').createHash('sha256').update(Buffer.from(JSON.parse(s).PublicKey,'base64')).digest('hex')))")
node scripts/synthetic-seal-dynamic-verify.ts /path/to/printed/evidence-workspace "$FP" /etc/ssl/cert.pem
```

Check that the verified envelope ID is the one shown on the page. The offline verifier checks canonical manifest, four artifact hashes, event links, ECDSA signature, nonce, imprint, token signature and trusted chain against the supplied roots. It does **not** establish synthetic provenance from arbitrary evidence, check certificate revocation, or establish DigiCert commercial eligibility/licensing. The local trust bundle is a point-in-time choice. The nonce is deterministically derived from the nondeterministic KMS signature as described in the protocol.

A private local file and conditional hard-link publication are not WORM. Local D1/R2 are not S3/R2 Object Lock, and no S3/R2 WORM guarantee has been tested. A privileged local user can change evidence; machine failure, filesystem behavior, concurrency, crash recovery, AWS/TSA availability and ambiguous remote responses remain risks. The system reuses validated published winners, but a failure before publication can produce extra KMS signatures or TSA issuances. Do not deploy or treat this as production/legal evidence without independent security, storage, trust, revocation and legal review.

A local Chrome 156 run used the generated envelope through both recipient views, then called the authorized KMS and DigiCert TSA from the local BFF. A separate verifier using a freshly fetched fingerprint and `/etc/ssl/cert.pem` accepted that envelope's retained evidence and rejected copies with modified D3 or TSA response. Restarting the isolated service with its instance path and sealing again retained the exact signature, query and response. This is a point-in-time synthetic test, not proof about uploaded envelopes or real documents.

## Opt-in uploaded PDF KMS/TSA local test

A separate [`upload.html`](http://127.0.0.1:5173/upload.html) page accepts a **synthetic test PDF** and creates a new isolated local instance with fictional Ana and Marcus. Neither an existing ordinary-host envelope nor a generated-synthetic instance can be sealed through this route. Each upload has its own D1/R2, management and OTP keys, and separately bound evidence workspace. This does **not** prove that the uploaded PDF is synthetic: the user must ensure it contains no real contracts or personal data. Do not use real users or production resources. The test page and loopback BFF are for one trusted local user, not a security boundary against local processes, administrators, extensions or compromised same-origin content.

Follow the Node/AWS/OpenSSL prerequisites and independently confirm the authorized profile in `ESIGN_AWS_PROFILE`, `us-west-2` region and dedicated `alias/esign-local-test-signing` described above. Start a separate UI and host (do not stop an existing user's services):

```sh
npm run dev:ui
# separate terminal
ESIGN_LOCAL_HOST=true ESIGN_LOCAL_KEY=local-test-key-0123456789-abcdefghijklmnopqrstuvwxyz \
  ESIGN_UPLOAD_SEAL=YES npm run dev:host
```

The alternate `ESIGN_SYNTHETIC_ALTERNATE_PORTS=YES` mode works for this page too. Select a synthetic PDF, upload, sign both fictional recipient views and explicitly process each signature. After reviewing the disclosure, check the authorization box and select **Complete local KMS/TSA test**. This one action checks that all signatures were processed, finalizes the existing mock evidence internally, freezes and validates D3 and its manifest, performs the KMS/TSA operations and verifies and persists the local test result. The internal mock COMPLETED is not the real seal and is never production completion. Without explicit authorization the completion request cannot call KMS or TSA. The older upload seal endpoint is disabled; the ordinary mock finalization path remains available. The browser never receives AWS credentials and cannot select a digest, KMS command, endpoint, or evidence object. The KMS request sends only the SHA-256 manifest digest; the DigiCert request sends the signature imprint and derived nonce over **unencrypted HTTP**. No PDF, names or email addresses are sent in plaintext, but digests are real disclosures and may be susceptible to guessing. DigiCert licensing/eligibility and certificate revocation are not verified.

Upload input is capped at 1 MiB and 100 pages, must have a PDF header and parse under `pdf-lib` strict-object parsing. Every D0–D3 evidence artifact is capped at 8 MiB before any remote call; larger generated output fails closed. These bounds are not comprehensive PDF parser, decompression, rendering or memory-safety guarantees. Malformed or malicious files can still exhaust resources or exploit parser bugs. Local PDF/recipient UI constraints and warnings above still apply.

The page reports NOT_SEALED, IN_PROGRESS, INVESTIGATE or SEALED_LOCAL_TEST separately from mock completion. Within the original running host, SEALED_LOCAL_TEST is revalidated against frozen evidence on refresh and is not production completion. After a host restart all resumed uploads, including successfully sealed or untouched ones, are INVESTIGATE and read-only. A NOT_READY response is given only before any signature record or event, after checking both source copies and hashes, the expected unsigned tasks and the absence of extra envelope objects. Do not click completion during partial signing: partially signed states fail closed and are locked for investigation rather than classified as retryable. Once all signing and processing are complete, existing finalization and evidence verification check the complete chain and freeze D3 before remote calls.

Each new upload has a versioned private protocol marker. Before a completion preflight or state/evidence inspection, the host publishes a unique start marker. The corresponding safe marker records that the check returned successfully; seeing the file after a restart is **not** proof that its publication completed durably or that no later failure occurred. A safe file can become visible after its hard link but before a directory-sync or winner-verification failure. If writing an investigation marker also fails, there is no way to reliably persist that failure while storage is unavailable. Control records accumulate and are not overwritten or removed.

To avoid treating those markers as recovery authorization, only an upload created by the current running host may be changed or sealed. Any resumed upload is INVESTIGATE and read-only, even if it was unsigned, was fully sealed, or all markers appear safe. The host makes no automatic recovery, unlock, re-signing or new KMS/TSA calls for it. Status and, if available, the existing final PDF and certificate remain readable; delivery-PDF GET is blocked because it can create objects. Previously sealed evidence can still be checked independently using the offline verifier below. A confirmed successful seal can be revalidated on repeat requests only while its original host is running. Within that host, a failed check or marker write blocks the instance; if persistence is unavailable, an in-memory latch blocks it for that host lifetime. The read-only restart rule does not claim that the failure itself was durably recorded. Preserve evidence and investigate; do not alter files or clear markers. KMS or TSA might have issued a response before an interruption; it is not safe to infer otherwise.

The browser persists an uncertainty guard before sending completion. A lost or malformed response, ID mismatch, or failed status verification keeps this browser blocked across refresh; storage failure also blocks completion. Do not clear browser storage to bypass the guard. Browser storage cannot coordinate other browsers or protect against local users or extensions, and a request lost before reaching the host cannot be recorded server-side. The host itself persists an attempt before making changes or remote calls. Local files and markers are not WORM, and filesystem or privileged mutation can defeat these checks.

The upload page can view or download an **existing test delivery PDF** even in INVESTIGATE. This separate read-only route does not generate D3, call KMS/TSA, change the investigation lock or prove a real seal. It verifies the local signing evidence, fixed R2 delivery metadata and bytes and, when present, the bound workspace snapshot and each published D0–D3 artifact. A missing delivery object or conflicting evidence is rejected; unpublished workspace artifacts remain permissible in a partial workspace but all four are required when the verified-complete marker exists. The local metadata and workspace are not independent protection against a privileged local attacker. A partial failure before both delivery objects exist cannot be viewed this way; preserve the instance for investigation. Concurrent completion blocks this read until it finishes.

The host prints the private instance path and, upon explicit completion, its private evidence workspace path. Keep both and the uploaded PDF private; they contain test documents, signing facts and local secrets. To inspect a retained instance after restart, set `ESIGN_UPLOAD_INSTANCE` to that exact printed instance path and select **Resume configured instance**; this reconnects in read-only INVESTIGATE mode, not for resuming signing or sealing. Do not run two hosts against one instance: request coordination is in-process only and does not isolate separate host processes. During completion or investigation, upload mutation routes, including recipient sessions, OTP, signing and processing, are blocked; the page also closes its signing frame. Read-only status remains available. Do not change or delete evidence or repair conflicts manually. Upload instances created in the same host are individually routed by envelope ID; recipient sessions cannot be used across instances.

Independently retrieve the SPKI fingerprint from the authorized alias as shown in the preceding section and use a separately trusted CA bundle:

```sh
node scripts/upload-seal-verify.ts /path/to/uploaded/evidence-workspace "$FP" /etc/ssl/cert.pem
```

Compare the returned envelope ID to the page. The verifier checks the canonical upload-mode manifest, D0–D3 hashes, ordered signing-event chain, KMS signature and RFC3161 nonce/imprint/signature/chain. It explicitly reports that synthetic provenance is not established; it does not check revocation, licensing or WORM. The local trust bundle is a point-in-time choice. An authorized local test uploaded a programmatically generated blank PDF through the service, explicitly sealed it, and verified the result using a freshly retrieved KMS fingerprint and the local CA bundle. That is not independent security or legal review, production readiness, or a claim about other documents.

The verifier requires the TSA response to be one complete definite-length DER sequence, with no trailing bytes, before invoking OpenSSL. This closes an observed OpenSSL acceptance of appended bytes; it is not a general-purpose ASN.1 validator.

For the uploaded host, browser GETs may omit `Origin`; if provided it must match the configured UI origin. POSTs require that exact Origin. Both still require the loopback Host and custom header, and reject cross-site Fetch Metadata. These checks do not authenticate local processes or extensions. The automated headless Chrome upload/signing test uses a generated PDF and test-owned ephemeral proxy/BFF ports; it stops before real sealing and skips if Chrome is unavailable.

## Worker KMS/TSA candidate boundary

`src/worker-kms-evidence.ts` is an unmounted Worker-compatible candidate, not a seal or completion path. It hashes `esign-worker-evidence-candidate-v1` followed by a NUL byte and the exact nonempty input bytes (maximum 1 MiB), asks an injected provider to sign that SHA-256 digest with P-256, and verifies the returned 64-byte P1363 signature locally against a caller-pinned SPKI. The unmounted AWS KMS provider candidate below strictly converts returned DER signatures; callers must separately invoke this local verification boundary. The input is not automatically a validated manifest. The caller must independently establish the authorized KMS identity and key pin; a key returned by the same provider is not independent identity proof. No provider, credentials or network policy is configured in the running service.

The TSA entry point always fails: RFC3161 parsing, request/nonce/imprint binding, token signature, certificate chain, trust anchors, time and revocation policy are not implemented or approved. No token or HTTP success can be accepted as timestamp evidence. R2 conditional creation is not verified immutable retention; retention policy, durable publication, retries and ambiguous remote outcomes remain unresolved. This candidate does not write evidence, call external services or alter local or production completion. These issues and independent security/legal review block production integration.

## R2 retention policy screening (offline only)

Cloudflare's [bucket lock documentation](https://developers.cloudflare.com/r2/buckets/bucket-locks/) (last updated 2026-10-28, reviewed locally) says rules can cover prefixes, apply to existing and new objects, and block overwrites and deletes while applicable; when rules overlap, the longest retention duration among all matching rules wins, not the most specific prefix. A sufficiently long parent rule therefore still covers a shorter child rule. It also describes removing rules through the dashboard or API. Therefore a snapshot of rules alone is not irreversible retention or proof that privileged operators cannot change policy. A lock rejection is not equivalent to a conditional-write rejection; multi-object delete can return HTTP 200 with per-key failures.

The unmounted `screenR2RetentionRules` only screens a supplied R2 rules object against a caller-specified nonempty evidence prefix and positive minimum age. It recognizes enabled Age and Indefinite rules, rejects unsupported Date rules and malformed input, and returns at most **unverified-candidate**, never protected. It does not authenticate, fetch or bind policy to an account, bucket, jurisdiction, Worker binding, object, observation time or future period. A caller-provided minimum is not an approved retention requirement. Rejected configurations may include valid Cloudflare configurations outside this deliberately narrow subset. Do not use the screen to authorize completion or assert WORM.

A reproducible Miniflare test exercises a write whose response is lost, rejects a conditional retry, reads the existing bytes for investigation, then demonstrates local deletion succeeds. It is not a real cloud retention test or a general recovery protocol. Existing local finalization separately rechecks a conflicting evidence object before its local D1 transition; this does not prove cloud policy. Production work needs an approved evidence prefix and retention duration, authenticated account/bucket/jurisdiction and binding identification, trusted policy retrieval and freshness, rules-change and privileged-administrator threat controls, ongoing monitoring, object/publication and ambiguous-operation recovery, and independent review. The documented ability to remove lock rules must be assessed against the required WORM guarantees. No cloud policy or bucket was queried or modified.

The separate, unmounted `src/p256-der-signature.ts` converts strictly encoded P-256 ECDSA DER signatures to the 64-byte P1363 representation expected by WebCrypto. It checks canonical DER and scalar range; conversion alone does not verify a signature or establish its curve or key identity. DER does not identify a curve, so a signature's origin cannot be inferred from fitting P-256 scalar bounds; callers must independently establish the key and verify the signature. The unmounted AWS KMS Sign provider candidate uses this converter; the separate local verification boundary must still be called to verify the signature.

### Unmounted AWS KMS Sign provider candidate

`src/aws-kms-sign-provider.ts` uses the AWS SDK for JavaScript v3 to send a SHA-256 digest with `MessageType=DIGEST` and `ECDSA_SHA_256`, and converts a strictly parsed DER signature to P1363 for the existing locally verifying candidate. It requires injected fetch, a commercial AWS-region key UUID ARN (not an alias or multi-region key), and caller-supplied session credentials with an `ASIA` access-key prefix, session token and expiration between one minute and twelve hours away. These are fail-closed input checks, **not proof** that credentials were issued by STS, that their expiration is genuine, or that the caller, account, key or independently pinned SPKI is authorized. AWS validates credentials only when an actual request is made; no real request has been made here. Independently establish credential provenance, authorized account/key/region, public-key pin and signing policy before any future integration.

The SDK signs a fixed HTTPS KMS endpoint. Injected fetch must itself be trusted; it receives the credential-bearing signed request and digest and must not log them, redirect, alter the destination, or expose them to untrusted code. Requests use manual redirects and reject non-200 responses, including redirects; responses are bounded to 4 KiB, base64/DER are checked and the returned key ARN and algorithm must match. One request attempt is made: a failed or lost response can nevertheless mean KMS signed, and no remote retry or recovery guarantee is claimed. The raw provider only converts a signature; callers must use the independently pinned local verification boundary, not treat the provider result as a seal. It is not mounted or connected to completion. No TSA validation, WORM, IAM/STS integration, credential refresh, network policy, real KMS identity verification or cloud deployment is supplied.

An isolated evaluation of `@aws-sdk/client-kms` 3.1161.0 installed 24 packages (about 15 MiB in node_modules); a browser-targeted probe bundle was about 387 KiB uncompressed and ran in local workerd with a stub request handler. The repository pins that SDK and directly declares esbuild for the local bundle test. The automated workerd test injects a response and makes no real network request. This is compatibility evidence for the tested build, not proof of an authorized cloud integration.

## Isolated Worker candidate (not deployed)

`src/candidate-worker.ts` is a separate, fail-closed entrypoint; it does not import or mount the local Worker, local OTP, mailbox, mock seal, editor or demo assets. Its public/default fetch exposes only `GET /health`, which reports code availability, **not signing readiness**. Every other public path returns 404, even with local-test environment bindings or a management bearer. A separately named `PrivateManagement` WorkerEntrypoint is intended for a specifically configured service binding: it exposes bearer-authenticated `GET /v1/me` and `POST /v1/envelopes/:envelopeId/tasks/:taskId/recipient-view`, using the existing tenant API-key hash and revocation model. Issuance accepts only an exact configured HTTPS origin, an active task in an in-progress envelope belonging to the key’s tenant, and returns a random two-minute code while storing only its hash. D1 statement time determines expiry and authorization is checked again in the insertion statement. The service-binding caller must separately establish its user’s authority; a tenant key alone does not establish recipient identity. A separate named `PrivateRecipient` binding exchanges a code and exact origin once for a 15-minute tenant/envelope/task/origin-scoped recipient session using D1 time and an atomic batch. It is an isolated intermediate boundary, not browser access or an end-to-end flow; no public exchange, page, OTP or signing route exists. The private binding also provides `POST /v1/otp/send` (token and origin) and `POST /v1/otp/verify` (token, origin and OTP), with one-use verification and statement-time checks. The private recipient binding also exposes document, fields, preview and experimental signing routes described below; it does not expose finalization. Missing/broken D1 fails with 503; no DB, R2, test mailbox, assets, routes, custom domain or service binding is configured by `wrangler.candidate.jsonc`. Worker dev and preview URLs are disabled there. The existing `wrangler.jsonc` and local experiment remain unchanged.

The named entrypoint must be bound only to an authorized backend Worker; do not configure a public proxy to it. The bearer is still required, but this prototype has no production identity lifecycle, rate limiting, management authorization review, tenant provisioning or production recovery. A binding does not authenticate end users. The checked-in config is a dry-run starting point, not permission or a complete configuration to deploy: adding assets or public routes, changing the entrypoint or wiring bindings can change the security boundary, and asset platform routing may bypass Worker code. Independently review the complete eventual deployment configuration, service caller and platform controls before any authorized deployment. In particular, never attach local demo assets or local-test secrets/mailbox. Real OTP, TSA trust, immutable retention, real completion, production signing and other management operations remain unavailable. The local KMS candidate is not connected. Do not use this candidate for real documents.

### Email integration remains blocked

The isolated candidate has no trusted production flow to create and prepare recipient tasks or authenticate the caller. The named private OTP routes are experimental and default-disabled: they require explicit isolated configuration, a persisted scoped session and the restricted send budgets. They do not establish user identity or production authorization. Do not expose the binding publicly or use a legacy sender against the same database: legacy sends bypass these budgets. Simulated mail tests do not establish real delivery.

A minimal future design needs independent approval before opening this boundary: restrict the named management service binding to an authenticated authorized backend, define tenant and sender authorization and origin policy, and establish trusted active tasks and approved credential policy. The experimental private code issuance and scoped one-use exchange exist, but production session and code revocation remain unimplemented; an Origin header alone is not identity and a stolen bearer remains usable outside a browser. Add production-grade per-task, recipient, tenant and network/abuse limits and operational monitoring in addition to persistent OTP attempt and send budgets, with a securely provisioned and rotatable non-test OTP secret. Do not expose OTPs, addresses or provider errors in responses or logs. Define whether an ambiguous or failed send can be retried without weakening budgets, how pending challenges and late delivery are reconciled, and how credential, policy and email-provider failures fail closed. Provider acceptance is not proof of delivery or recipient identity. The required trust model, externally reachable authorization, rate limits, secret lifecycle, verified sender, delivery policy and recovery procedure are not yet specified or reviewed. TSA verification, retention and real completion remain separate blockers; no mock completion may be used as a substitute.

Signature artwork uses a bundled Caveat bitmap atlas (renderer `caveat-bitmap-v2`);
no font is downloaded at runtime. The fixed atlas SHA-256 is recorded in
`src/typed-signature-image.ts`; `scripts/generate-signature-atlas.swift` builds
the atlas from `fonts/Caveat-wght.ttf` using macOS CoreText. This development change does not migrate or
modify existing evidence or generated objects. Signatures created with former renderers may no longer replay or verify; retain the old source
version if historical verification is needed. Date and Title use the existing
regular text renderer.

Existing stored artifacts are not rewritten. This local experiment does not guarantee replay of historical positioned renderings after the text sizing change; preserve old evidence and use fresh synthetic state for a new demo. Do not restart or replace a running demo without its owner’s approval.

### Unmounted synchronous local-test slice and synthetic TSA transport

`src/synchronous-local-signing.ts` is an unmounted fieldless-only local experiment, not an HTTP endpoint or deployment feature. It calls the existing local atomic signature record, synchronously processes its persisted job, verifies the output hash and, only when the envelope reaches finalizing, invokes the existing HMAC-based local-test finalizer. Its `COMPLETED_LOCAL_TEST` is explicitly **not** a KMS/TSA seal. Exact retries are scoped to the same still-valid session, origin and input artifact/hash; the existing signature/job rows are the durable recovery point. An error or timeout does not prove that a D1 or R2 operation failed: retry with the same inputs and investigate conflicting artifacts. The tests cover selected lost responses and concurrent recovery, not all races, disconnections or actual Cloudflare failure semantics. This candidate does not support positioned signatures, a separately persisted idempotency key, or production caller authentication; it relies on caller-supplied test time and has not established atomic template-field immutability. It must not be mounted as a real signing route.

`src/worker-tsa-synthetic-transport.ts` is separately unmounted and accepts only a fixed in-code synthetic fixture, never a caller-supplied document or digest. It constructs an RFC3161-shaped query with a fresh nonce and SHA-256 imprint, requires an explicitly allowed HTTPS URL and injected fetch, disallows redirects and caps response size and waiting time. Its result is always `UNVERIFIED_SYNTHETIC_RESPONSE`: no response, status code or content type is accepted as evidence. There is no RFC3161/CMS parser, signature or certificate chain verification, revocation/trusted time policy or production sealing integration. The URL list is caller-supplied and is not an SSRF/DNS or network-policy defense; the injected fetch must be trusted and restricted. Aborting after a timeout does not prove the remote service did not issue a timestamp, and a fetch implementation may ignore abort. Endpoint permission, conditions and disclosure must be explicitly approved before any real network request. No real request is made by the tests or configured by the Worker.

`src/synchronous-positioned-v3.ts` is another **unmounted local-test candidate**, now covering positioned Signature, Date signed and Title through the existing v3 record/replay/processor. It stores a tenant-scoped `local-v3-sign:` idempotency key and request hash in the existing D1 idempotency table in the *same batch* as the v3 signature, event and PENDING job. Exact replay also requires the same valid session, origin, artifact, values and preview inputs; a different key for an already signed task is not a new signature. The returned processing status may advance on retry. The last signer triggers only existing HMAC-based local mock completion; `COMPLETED_LOCAL_TEST` is not KMS/TSA or production evidence. The candidate takes a caller-supplied test clock and is not a production authentication boundary. Concurrent losing attempts may leave pre-commit image objects in R2. No automatic cleanup or background recovery is supplied.

A synthetic two-role D0→D1→D2 Miniflare test covers first-request concurrency and selected lost D1, PDF and evidence responses, concurrent recovery, changed requests and tenant-key collisions. It does not establish actual Worker disconnect behavior, all interleavings, immutable retention, real R2 or D1, production idempotency policy, or authorization. Keep the default and candidate Worker routes closed. Real TSA requests and trustworthy RFC3161/CMS verification are not implemented or enabled: request/nonce/imprint binding, strict ASN.1/CMS parsing, token signature and signer authorization, independently configured trust roots, certificate validity and revocation/long-term validation, time policy, bounded inputs and network/SSRF controls require implementation and review. The fixed-fixture synthetic transport above is not a substitute.

`src/worker-tsa-transport.ts` is a second, unmounted request adapter for an **independently authorized synthetic SHA-256 imprint** rather than the fixed fixture. It constructs an RFC3161 query with a random nonce and accepts only an explicitly allowlisted HTTPS endpoint, an injected authorization callback and injected fetch. The callback must independently establish synthetic provenance **and** prior endpoint terms and disclosure authorization; caller assertion or the callback's existence cannot prove either. The injected fetch must enforce its own network/DNS policy; an exact URL list alone does not prevent SSRF or rebinding. Nothing configures this adapter to make a real request. Tests use synthetic data and injected fetch only. It snapshots input, rejects shared memory, bounds response and timeout, and refuses redirects. A timed-out operation can still have reached the service and produced a timestamp; never infer non-issuance.

Its result is always `UNVERIFIED`. It does not parse or validate the response, check its nonce/imprint, verify CMS signature or signer certificate, apply roots, algorithm/time/revocation policy, or create evidence. Do not connect it to finalization or use it with real content. The separate Node/OpenSSL synthetic verifier and the old fixed-fixture transport are not Worker trust verification. No approved TSA roots or revocation policy is configured; the Worker evidence TSA function remains fail-closed.

### Unmounted RFC3161 test verifier candidate

`src/worker-rfc3161-verifier.ts` is an independently exercised Worker-compatible **test candidate**, not connected to a route, the TSA transport, finalization or the `createTsaEvidence` fail-closed entry point. It uses PKI.js/ASN1.js for CMS signature and certificate-chain validation and supports only a deliberately narrow profile: granted RFC3161 response, SHA-256 imprint, a 16-byte positive nonce in the format generated by the test transport, one RSA SHA-256 signer, RSA keys of at least 2048 bits, a pinned signer SPKI, critical exclusive timeStamping EKU, signing key usage, a non-CA signer, SHA-256 ESS certificate binding, explicit TSA policy OIDs and explicit trust roots. It bounds data, chain size and ASN.1 traversal; the DER screen is a deliberately restrictive rejection screen, **not a demonstrated complete DER validator**. It requires a timestamp accuracy and checks the entire asserted accuracy window against the configured test clock and certificate validity.

The verifier requires an injected revocation checker to return true for the validated chain and full timestamp window. That checker, roots, pins, clock and policy must come from trusted infrastructure, never a browser, request or end user. The test checker returns true for generated synthetic certificates; it performs **no real revocation check**. There is no configured production trust anchor, revocation mechanism, legal policy or production-authorized call path. The candidate result `VERIFIED_TEST_CANDIDATE` is test-only, not production evidence. PKI.js chain validation is explicitly enabled; it is invoked with `passedWhenNotRevValues` because the separate injected checker is mandatory. This is safe only if that checker is itself trustworthy and covers every non-root certificate and relevant time; neither property is established here.

Locally generated OpenSSL TSA responses were tested in Node and browser-bundled workerd against explicit synthetic roots, with selected bad nonce/imprint, signer pin, root, status, time, key usage, DER and signature cases. This does not establish comprehensive ASN.1/CMS correctness, full RFC3161 interoperability, independent PKI.js security, actual revocation or legal validity. The profile intentionally rejects other valid TSA configurations, including unsupported algorithms and unapproved optional forms. Obtain independent cryptographic review and adversarial interoperability tests before any binding to a real service. No real TSA call was made.

Independent-review regression fixes narrow this test profile further: every certificate in the selected validated path, including the signer, intermediates and trust anchor, must have no duplicate extensions and no critical extension outside the candidate's explicitly handled set. For a signer this set is key usage, basic constraints and extended key usage; for CA path certificates it is key usage and basic constraints. Other critical extensions fail closed, even where another verifier could support them. The signed `messageDigest` attribute must contain exactly one 32-byte OCTET STRING. The CMS signed-attributes value is separately screened as a DER SET for canonical ordering; unrelated context-specific tags are not treated as sets. These checks do not make the DER screen complete or authorize production use. The revocation callback remains an injected trusted dependency, and tests use a synthetic allow callback rather than real revocation evidence.

`src/worker-synthetic-tsa-candidate.ts` is an **unmounted synthetic-test composition** of the authorized-synthetic transport and the RFC3161 verifier candidate. It snapshots the synthetic input, transport configuration and explicit test trust policy before asynchronous work; rejects missing trust/revocation inputs before calling the transport; requests a timestamp of the input's SHA-256; and verifies the response against that input and the transport-generated nonce. Its result is `VERIFIED_SYNTHETIC_TEST_CANDIDATE`, not completed signing, durable evidence or a production seal. Synthetic provenance, endpoint authorization, trusted networking and a real revocation implementation cannot be established by caller assertions. Do not expose or mount this helper.

A local workerd test exercises this composition with a TSA responder generated inside the test from temporary synthetic keys and an explicit synthetic root. The responder signs the actual request nonce. The same test invokes the standalone mail adapter using an in-memory send function and conditional writes against Miniflare R2; it does **not** integrate these calls with the synchronous v3 signing transaction or contact Cloudflare Email/R2. The v3 local finalizer still records only HMAC/mock completion before any TSA operation. Connecting true signing completion to KMS/TSA verification and protected storage requires a separately reviewed state machine, authorization, recovery policy and approved trust and revocation configuration.

### Isolated v3 synchronous mock-KMS / synthetic-TSA test

`src/synchronous-positioned-v3-tsa-test.ts` is an **unmounted test-only factory**, not a deployed Worker route. An isolated in-process Hono test app uses it to process the existing v3 two-role Signature/Date/Title signing chain. The first signature generates its PDF synchronously; after the last signature the envelope remains `FINALIZING` while the v3 event chain and PDFs are revalidated, an explicitly local HMAC mock KMS value is generated and an injected synthetic TSA is called. The TSA request is a real RFC3161 DER request over the mock KMS value's SHA-256. Only after the test verifier accepts the response and local evidence is persisted does the test envelope enter `SYNTHETIC_TSA_TEST_COMPLETED`; it never enters ordinary `COMPLETED` through this path. This is not a managed KMS signature or production completion.

The separate test evidence object stores the local manifest, mock KMS value, request, nonce, response, synthetic roots/pins and test validation policy. Its revocation field explicitly says `TEST_ONLY_NOT_CHECKED`; the injected test callback is not real revocation evidence. After an ambiguous write, retry reads and re-verifies the stored object instead of issuing a new TSA request when a valid object exists; D1 uses atomic assertions over the captured v3 facts before the test status transition. A lost response *before* evidence publication may still mean the TSA issued a response, and concurrent requests may issue multiple responses. The test checks independently that OpenSSL verifies the persisted request and response against its temporary test root.

This is not an actual public or deployable app, production authorization, legal evidence, real email, real KMS, real Cloudflare R2, WORM or real TSA interoperability test. The tests use temporary synthetic certificates and an in-process OpenSSL responder without external networking. The test policy uses a caller-supplied fixed clock; long-term validation, revocation, trusted policy distribution, authenticated real recipients and source URLs, cross-store atomicity/retention, provider timeouts after issuance, and production recovery remain unresolved. Existing v1/v2 and earlier local HMAC evidence formats are not migrated. Renderer/geometry changes documented above can make earlier v3 snapshots non-replayable; no historical data was changed. Keep both ordinary and candidate Worker production entrypoints closed pending independent security and legal review.

#### Isolated synthetic recovery after the signer session expires

`createSyntheticTsaV3TestRecovery` is an unmounted local-test service interface, not an HTTP route. It accepts an envelope, tenant and bearer credential for an existing active tenant API key. It cannot record a signature, consent, OTP or session, and it does not accept a recipient signing token as authority—even if a test database contains an API-key hash collision for that session token. It only resumes an existing v3 PENDING PDF job or revalidates and finalizes already-signed facts. An unfinished unsigned task is never signed by recovery. The synthetic recovery guard checks key revocation, tenant/envelope binding and allowable status before and within processing or test completion batches, but the older synthetic path does not have the candidate recovery path’s complete post-write authorization assertions; `EXPIRED` is not recoverable. An already-published test TSA response is reused only if its bytes match the immutable D1 reservation and it verifies under both its issuance time and the current injected clock; unreserved or conflicting objects fail closed. Requests are still synchronous: no queue or scheduler is added.

The synthetic signer uses D1 statement time for its session authorization checks. The finalizer requires an injected trusted clock and captures it per invocation for timestamp verification; the separate candidate synthetic provenance check also uses Date.now(). Neither is a production trusted-clock guarantee. The management key is not a signing credential. These are local test boundaries, not approved production identity, provisioning, key rotation, task authorization or deployment. The test exercises expired sessions, revoked/cross-tenant credentials, pending processing, concurrent retry and expiration/revocation races. An already-issued or in-flight remote operation cannot be undone by revocation; R2 and D1 are not atomic, orphan objects and multiple synthetic TSA issuances remain possible. The injected test trust/revocation policy and clock are not production evidence, and normal Worker routes remain unchanged and closed.

For the unmounted synthetic TSA signer, a recipient-session hash must not also occur in `api_keys`, including a revoked key or a key owned by another tenant. The check occurs before signing and again in the atomic signature-fact batch; signer-authorized processing and finalization use the same guard. A collision present before the request causes no signature fact or artifact write. Because v3 currently writes image objects before the D1 signature batch, a key collision created while those writes are in flight can still leave unreferenced synthetic images even though the batch rejects; do not automatically delete them. This policy does not claim to protect other local/demo entrypoints or replace production identity separation.

`src/synthetic-cloudflare-otp-test.ts` is an unmounted fixture-specific adapter connecting the existing persisted recipient OTP helper to the Cloudflare Email adapter. It accepts only the fictional `ana@example.com` test recipient and fixed `sign@example.com` sender and does not establish that an arbitrary session or document is synthetic. A local workerd test supplies Miniflare's **simulated** Email Sending binding and local R2, exercises invalid origin/recipient, conditional object creation, provider failure/cooldown and a subsequent synthetic send. Miniflare writes the synthetic message body to its own temporary local email directory and prints sender, recipient, subject and that temporary path; it does not send an email. The fixture does not return the OTP. Do not attach this helper to a real binding or expose it as a route; real sender verification, recipient authorization, quotas, abuse protection, ambiguous-delivery policy and privacy review remain unresolved.

### Current candidate configuration and credential boundary

The checked-in `wrangler.candidate.jsonc` intentionally contains no D1, R2, Email, assets, routes, domains, secrets or runtime variables; a test protects that exact default. With its checked-in unbound configuration the candidate cannot sign, send OTP or seal; named private test entrypoints provide experimental signing and recovery when explicitly bound in local tests. Its private issuance and exchange are experimental and not approved for deployment. The named management operation `/v1/me` rejects a management API-key hash that also appears in the recipient or editor session/token or one-use code tables, including expired entries or another tenant's entries. A missing required credential table or unavailable D1 returns 503. This check only covers persisted rows; deleting a row removes this collision evidence, so key lifecycle and permanent separation remain unresolved. Apply the complete reviewed schema only in a fresh authorized test database before evaluating that operation; this is not a migration or deployment instruction for an existing database. The query is a single D1 read, not production key lifecycle, end-user authentication, or permission to proxy the service binding publicly.

Before changing the candidate configuration or opening any route, separately approve and review: (1) which backend may access the named service binding, how it authenticates its end users and tenant/task/recipient authority, and how short-lived one-use view codes, session origin, expiration, revocation and key separation are enforced; (2) the exact sender and recipient allowlists, sender-domain verification, per-recipient/tenant/network budgets, secret lifecycle, log redaction and ambiguous-send behavior—no other address is enabled by default; (3) operator-created isolated D1/R2 identifiers, access permissions, evidence retention and cross-store recovery; and (4) a TSA endpoint and its terms and synthetic-digest disclosure, independently configured roots, signer pins, trusted time and revocation policy. Supply actual account-specific configuration privately, not in this public repository. Bindings or `workers.dev` flags alone do not resolve any of these authorization or evidence boundaries.

An alternative while those decisions are pending is to keep the checked-in candidate unchanged and use only the isolated local synthetic tests. The existing fixed-fixture TSA transport and HMAC mock do not become a general TSA verifier or production seal merely by supplying bindings. No cloud configuration, real address, endpoint, recipient or secret is checked into this file, and no deployment or external call is authorized by it.

### Restricted Cloudflare OTP service boundary (private binding only)

`src/isolated-cloudflare-otp.ts` provides experimental service functions, not authorization to send. The named private candidate binding connects them to a persisted recipient session, D1 OTP challenge and Cloudflare Email Sending binding. It is disabled unless trusted runtime configuration explicitly supplies all of the following; no real address, endpoint or secret belongs in this repository:

| Runtime input | Required behavior |
|---|---|
| `ISOLATED_OTP_ENABLED` | Exactly `true`; missing or other values fail closed. |
| `ISOLATED_OTP_FROM` | One exact lowercase ASCII sender; independently verified and restricted by the Cloudflare binding. |
| `ISOLATED_OTP_RECIPIENTS` | JSON array of exactly two distinct lowercase ASCII full addresses, compared exactly with the persisted task recipient. No wildcard or implicit additional recipient. |
| `ISOLATED_OTP_PEPPER` | Independently generated 32–256 byte secret, provisioned privately; string length does not prove entropy. |
| `ISOLATED_OTP_WINDOW_MS`, `ISOLATED_OTP_TENANT_LIMIT`, `ISOLATED_OTP_ACCOUNT_LIMIT` | Explicit positive decimal budgets; no defaults. The implementation bounds the window to 1 minute–24 hours and counts to 1–1000, but these bounds are **not an approved production abuse policy**. |
| `DB`, `SEND_EMAIL` | Fresh authorized D1 with the reviewed migrations, and a separately configured Email Sending binding restricted to the same approved sender and exact recipients. |

The function derives tenant, task and recipient from the persisted session, checks allowed origin, active task/envelope, credential collision and a session expiry no more than 15 minutes away against D1 time. It preserves the existing task budget (60-second cooldown, at most three sends and five attempts per 15-minute window) and atomically reserves tenant and shared-database budgets together with the challenge. The scope named `account` is **only the single D1 database**, not a proven Cloudflare-account-wide limit across deployments. Policy window or count changes during an active window fail closed. It performs a ready read immediately before calling the mail binding, including session, recipient, challenge and attempt checks. This is not atomic with dispatch: state can change after the read and before provider acceptance, including challenge replacement, exhaustion, revocation or expiry. A message can therefore be sent for a challenge no longer valid. Errors are generic; a failed or ambiguous send consumes the reserved budgets and cooldown rather than silently retrying. The function neither returns the OTP nor logs it.

Migration 0024 adds a nullable challenge reservation column and the budget table scopes; it was applied to the separately authorized isolated test D1 described in PROGRESS.md, not to existing retained databases. Local tests use synthetic addresses and Miniflare's simulated Email Sending binding, which prints synthetic message metadata and a temporary message-file path; no real email was sent. Before any binding or routing change, approve the backend identity/service-binding boundary, trusted view-code/session issuance, sender/recipient configuration, abuse and recovery policy, secret provisioning and real-provider logging/disclosure. A persisted local session row or a two-address allowlist alone is not proof of user identity or authorization. The candidate's public OTP routes remain 404, and the TSA and production completion paths remain closed.

The user reports that an R2 account is now enabled; no account, bucket, lock rule or binding was inspected or created in this work. This does not by itself authorize deployment or establish evidence retention. The checked-in candidate still has no R2 binding. The OTP pre-send recheck also binds the reserved challenge hash and timestamps, so a challenge replaced before the ready read is rejected; replacement after that read can still lead to dispatch. This is not atomic with provider delivery. A session expiry no more than 15 minutes away is a runtime bound, not proof of issuance time: the current schema has no independently trusted issued-at field. Before exposing any OTP path, ensure **all** sends for that task flow through the same atomic budgets; a parallel legacy sender could bypass these counters.

Private issuance requires five explicit **test-only** runtime settings: `TEST_ISSUANCE_WINDOW_MS`, `TEST_ISSUANCE_TENANT_LIMIT`, `TEST_ISSUANCE_DATABASE_LIMIT`, `TEST_OUTSTANDING_TENANT_LIMIT` and `TEST_OUTSTANDING_DATABASE_LIMIT`. Missing or malformed settings fail closed; no production limits are approved. Migration 0028 provides fixed-window counters. One D1 batch reserves budgets, checks outstanding codes and issues the code. Candidate issuance never deletes code rows: used, revoked and unused expired rows retain their recorded timestamps and tenant/task association. It fails closed at 10,000 total code rows in this database, including legacy rows; this experimental ceiling is not an approved retention policy. Existing deleted rows cannot be reconstructed. Capacity cannot be restored by this service; any archival or deletion requires separately approved evidence policy and tooling. Other tables, including sessions and revocation tombstones, are not bounded by this ceiling, and legacy issuers can bypass it. Live-window policy changes fail closed. Lost responses consume capacity; retries are not idempotent. Limits cover only this database and candidate issuance, not task, recipient, network or other databases. An isolated database must be dedicated to the candidate: legacy signing and OTP paths do not enforce candidate session revocation or budgets. Independent review, trusted caller and recipient identity, credential lifecycle, storage retention and a browser/BFF path remain required before deployment.

The experimental named `PrivateRecipient` binding also accepts `POST /v1/document` with exactly `{token, origin}` after OTP verification. It returns only the recipient's initial prepared PDF when no signature record exists, checks its stored SHA-256, and rechecks session and document state before returning. It does not expose object keys, accept an artifact selector, return later signed outputs or sign. The separate private `/v1/preview` renders owned Signature, Title and Date signed fields; Date accepts no client text and atomically persists a statement-time UTC date, image hash, geometry and initial artifact/template binding for at most five minutes or the session expiry. Matching unexpired requests replay the same preview ID; changed or expired bindings receive a new ID. The public Worker remains closed. This read is not atomic with D1 or R2 changes and does not establish recipient identity; do not proxy the binding publicly or use it for real documents.

PrivateManagement exposes `POST /v1/envelopes/:envelopeId/tasks/:taskId/recipient-revoke` to revoke all existing recipient sessions and unused codes for the authorized tenant task in one D1 batch. It does not expose session credentials and does not prevent a later authorized issuance. Unused codes have separate revocation tombstones; revocation does not set their usage timestamp. Candidate and legacy code exchange reject tombstoned codes, and candidate outstanding counts exclude them. Previously recorded usage timestamps are retained as-is and cannot be classified retrospectively. Candidate exchange, OTP and document access fail closed for revoked sessions; the public Worker remains closed. D1 transactions serialize issuance, exchange and revocation: issuance committed after revocation creates new authority, while exchange committed before revocation has its resulting session revoked. Revocation cannot recall an email already dispatched, and state can change after the document final read. Revocation does not confer signing or consent authority. Legacy local signing and OTP paths are not this candidate boundary and must not be exposed as substitutes. Tombstones and used codes require an independently approved retention/cleanup policy.

### Private signing and unsealed recovery experiment

The named `PrivateRecipient` binding exposes document, field and preview reads and
`POST /v1/sign` for the current OTP-verified recipient. An initial or second V3
signing request supplies the token and origin, artifact ID/hash, consent,
idempotency key, field values and preview bindings. The request attempts processing synchronously after committing the signature fact.
A 202 `PROCESSED_UNSEALED` response means the PDF output was verified and the
job committed, not that the document was sealed. Processing errors currently
return 503 (outcome unknown), including integrity conflicts and ambiguous provider
failures. An exact authorized retry uses the same payload and idempotency key
without signing again; a 503 does not establish that processing failed. The experimental implementation still needs
independent review and comprehensive fault and concurrency testing.

The separate `PrivateManagement` binding permits an authorized tenant key to look
up a task job and recover it. Recovery verifies the persisted signature and,
for the second signer, the verified first output and predecessor facts, then
commits the PDF output and job state. Its `PROCESSED_UNSEALED` response is not a
seal, evidence package or completed signing service. Management authorization
is distinct from recipient replay authorization; neither permits signing an
unsigned task. The last processed job leaves the envelope `FINALIZING`.

This remains an isolated experiment requiring a dedicated candidate database
and independent security review. The public worker and default configuration
remain closed. Database assertions and object-store verification are not atomic;
privileged later object mutation and unreferenced images or outputs remain
possible. Do not deploy or use it for real signing.

### Experimental HTTPS management gateway

The consolidated router also has a default-off `MANAGEMENT_READINESS_ENABLED` mode. When enabled without normal management, it permits only an authenticated GET whose Worker-visible normalized pathname is `/v1/me` and whose `Request.url` contains no query delimiter, through the existing management gateway and its limiters. Other `/v1/` actions remain closed even if editor and recipient flags are enabled. A bare `?` is rejected when retained in `Request.url`. URL parsing may normalize dot segments or discard details before Worker code sees the request: for example, `/v1/x/../me` can become `/v1/me` and is then treated as that same read-only request, not as a distinct raw target. Normalized aliases of other paths do not become permitted actions. This is not raw request-target enforcement; if raw exact-path or no-query enforcement is required, a separately verified ingress boundary must enforce it before normalization. Local workerd tests do not establish the behavior of every Cloudflare ingress.

`wrangler.management-gateway.jsonc` is a **separate**, disabled-by-default Worker configuration; it does not change or expose the local demo or candidate public Worker. It forwards only `GET /v1/me`, `POST /v1/templates`, `POST /v1/envelopes`, `POST /v1/envelopes/:envelope/prepare`, `GET /v1/envelopes/:envelope/tasks`, `POST /v1/envelopes/:envelope/tasks/:task/recipient-view`, `POST .../recipient-revoke`, `GET .../job`, and `POST .../jobs/:job/recover` to the named `PrivateManagement` entrypoint. IDs are ASCII letters, digits, underscore or hyphen, at most 128 characters. Query strings, browser Origin requests, other methods and recipient signing routes are rejected.

Create requires `Content-Type: application/json`, an `Idempotency-Key` of 1–128 ASCII letters, digits, underscore or hyphen, and a JSON body up to 4096 bytes containing `templateId` and exactly two `recipients` with `role`, `name` and `email`. Provisioning requires the candidate's configured recipient allowlist and budget limits and an existing tenant template. It returns the existing `{id, status: "PROCESSING"}` response, including on an identical idempotent retry; conflicting reuse returns 409. Unsupported renderer names return 400. Prepare has an empty body and returns `IN_PROGRESS` on success. The task lookup returns at most two `{id, role, routingOrder}` entries in routing order for the authenticated tenant's envelope; it returns 404 for an inaccessible or empty envelope and fails closed if more than two tasks exist. Use the appropriate discovered task ID to request recipient-view. Recipient-view JSON bodies are also bounded to 4096 bytes; other non-template requests must have empty bodies. The gateway forwards only bearer authorization and the relevant content type and idempotency key. The candidate independently authenticates and enforces tenant-scoped checks. Responses are no-store. This is an experimental candidate, not production approval.

The gateway requires a Cloudflare Workers Rate Limiting binding named `RATE_LIMITER` before any private binding call. Missing binding, invalid or absent client IP, malformed limiter results and limiter errors return 503; a denied request returns 429. The key is only a normalized client IP, never a credential or forwarding header. The Worker reads `CF-Connecting-IP` as trusted **only when the request actually arrives through the Cloudflare edge**: a local test, direct invocation, or a service-binding caller can supply headers and is not a trusted edge. Any eventual deployment must independently ensure the gateway cannot be reached through an untrusted path and that Cloudflare sets this header. Cloudflare Workers Rate Limiting counters are local to a Cloudflare location, not durable or globally consistent; they are not a global quota or sufficient D1 abuse protection. Configure an approved limit and add independent global capacity, abuse controls and monitoring before exposure.

Template upload is an isolated test-only `POST /v1/templates` multipart request with exactly one `file` PDF (at most 5 MiB), one `roles` JSON array, and one `fields` JSON array, plus an `Idempotency-Key` using the same syntax above. No other parts or duplicate names are accepted; metadata and multipart overhead together are bounded to 65536 bytes. The gateway streams at most that total plus one sentinel byte and cancels the incoming stream; the named private binding authenticates and reserves fixed-window admission in D1 before reading or parsing. Every admitted upload, including invalid input and exact retries, spends admission quota. It separately reserves issuance and retained-attempt capacity before R2 writes; exact creation retries reuse the retained reservation. Explicit `CANDIDATE_TEMPLATE_ADMISSION_WINDOW_MS`, `CANDIDATE_TEMPLATE_ADMISSION_TENANT_LIMIT`, `CANDIDATE_TEMPLATE_ADMISSION_DATABASE_LIMIT`, `CANDIDATE_TEMPLATE_WINDOW_MS`, `CANDIDATE_TEMPLATE_TENANT_LIMIT`, `CANDIDATE_TEMPLATE_DATABASE_LIMIT`, `CANDIDATE_TEMPLATE_RETAINED_LIMIT`, and `CANDIDATE_TEMPLATE_TENANT_RETAINED_LIMIT` settings are mandatory, with no defaults; these limits are test policy only. Retained counts include reservations and older created candidate templates and are never automatically deleted. These controls cover only this D1 database and candidate path; fixed windows do not globally bound concurrent uploads, platform buffering, parser work, other storage writers or other databases. The checked-in gateway and candidate configurations require respectively `streams_enable_constructors` and `formdata_parser_supports_files` compatibility flags. D1/R2 are not atomic; orphan objects and later object replacement remain possible. Independent security review is required.

For a future separately authorized deployment, configure `PRIVATE_MANAGEMENT` as a service binding to the candidate Worker **named entrypoint `PrivateManagement`**, set `MANAGEMENT_GATEWAY_ENABLED` to the exact string `true`, and separately configure an HTTPS route and the candidate's required D1/R2 and issuance policy bindings. The committed configuration intentionally has none of these, no public route and no secrets. Apply and verify required migrations only under separate authorization. The backend must hold the tenant API key securely and send it in `Authorization: Bearer ...` over HTTPS; do not put the key or returned one-use recipient code in logs, URLs or browser storage. The gateway is not end-user authentication: the host must authenticate users and enforce tenant, envelope and task permissions before every call. API keys are tenant-wide, and the gateway cannot establish those end-user permissions. Additional rate limiting, credential lifecycle, infrastructure isolation, operational monitoring with sensitive data redaction, and independent security review remain required.

This proxy does not expose recipient exchange, OTP, document, signing or completion; envelope creation provisions its two tasks. A separately designed browser BFF and recipient trust boundary are still missing; do not use the local demo as that BFF. Recovery only returns `PROCESSED_UNSEALED`, not production completion or evidence. Existing candidate signing and production-readiness limitations still apply.

### Experimental recipient gateway candidate

`src/recipient-gateway.ts` is a separate, default-disabled API-only Worker candidate; its Wrangler file has no route or bindings. It requires `RECIPIENT_GATEWAY_ENABLED=true`, a comma-separated `TRUSTED_RECIPIENT_ORIGINS` list of exact canonical HTTPS browser origins (no spaces or trailing slash), a `RATE_LIMITER`, and a private service binding `PRIVATE_RECIPIENT` targeting the candidate Worker's named `PrivateRecipient` entrypoint. Configure none of these until separately authorized and independently reviewed. Do not expose the candidate Worker or its named service binding directly.

The browser must use HTTPS, send an exact trusted `Origin`, JSON with no credentials or Authorization header, and keep recipient tokens out of URLs and logs; place one-use codes only in the page fragment, never a query string or log. The gateway injects the verified browser origin into the JSON; a supplied conflicting origin is rejected. Only the seven POST recipient candidate endpoints and their narrowly scoped CORS preflights are accepted. Cookies and unrelated headers are not forwarded; response cookies and unrelated headers are stripped. Preview metadata headers are explicitly exposed. The candidate itself enforces per-tenant origin/session authorization, OTP and signing checks. Trusted origins must be controlled against script injection; CORS is not authentication and non-browser clients can forge Origin. The gateway relies on Cloudflare edge provenance for `CF-Connecting-IP`; direct or service-binding ingress must not be allowed. The limiter is location-local, not a global durable abuse quota; additional independently reviewed abuse and capacity controls are needed.

The separate `candidate.html` page is an experimental candidate gateway client; `RecipientPage` remains the unrelated local demo. Set the build-time `VITE_CANDIDATE_GATEWAY_ORIGIN` to the exact canonical HTTPS gateway origin (never a credential); absent or invalid configuration and non-HTTPS page origins fail closed. The gateway and tenant must separately allow the exact page origin. Provide the one-use recipient code only as `#code=<code>`; the page immediately removes the fragment and rejects query strings and extra fragment parameters. Its session token and signing retry payload live only in page memory, requests omit cookies and authorization, and it uses server PDF, metadata and preview receipts. The page accepts `PENDING` for compatibility, or `PROCESSED_UNSEALED` when the PDF was verified and processed; neither means a sealed document. An ambiguous signing response can be retried with the frozen payload while the page remains open. Reload loses the session and retry payload; obtain a new view and investigate rather than assuming failure.

This page is not deployed or approved for real documents. Protect the entire page origin from untrusted scripts, configure independently reviewed CSP, framing, referrer, cache, transport and hosting policies, and prevent access logging of credentials. Fragment removal cannot protect against prior browser history, extensions or compromised same-origin scripts; a code or token is still a bearer credential. No management key belongs in the browser. Local tests do not establish real-browser hosting or deployed edge behavior. Production identity, abuse controls, evidence protection, finalization and independent security review remain unresolved.

### Experimental private editor session protocol

The default-disabled editor gateway and named `PrivateEditor` binding expose JSON
`POST /v1/editor-sessions/exchange` (`pageId`, `code`) and
`POST /v1/editor-sessions/context` (`token`). The gateway requires an explicit exact
HTTPS origin allowlist and edge-IP admission binding, injects the browser Origin,
rejects Authorization, and forwards no cookies. The named `PrivateManagement` binding
and default-disabled management gateway issue codes at `POST /v1/editor-sessions` with
management bearer and JSON `origin` and two `roles`. The management gateway rejects
browser Origin headers; never place a management bearer in browser code. The host is
responsible for human authorization and secure fragment delivery/removal. Codes are
one-use; tokens and codes expire and are kept hashed at rest. Roles must be two distinct
case-insensitive names matching `[A-Za-z0-9_-]{1,64}`; previously issued incompatible
roles fail authorization and save without changing their stored history. Document roles
do not authenticate a person.

The standalone `candidate-editor.html` is an experimental local synthetic UI, separate
from the legacy editor. Build with `VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN` set to the
exact HTTPS editor gateway origin; serve the page from the exact HTTPS origin authorized
for the session and gateway. The authorized host delivers a URL with fragment
`#pageId=<pageId>&code=<code>`; the page removes it before exchanging and keeps the
token in memory. It uploads a local PDF and saves only through the candidate route.
The management key must never enter the browser. The page does not provide human
authentication or a parent messaging integration. Configure and independently review
hosting, CSP, origin separation and credential delivery before any exposure. The issuing
host retains the page ID and may call `GET /v1/editor-sessions/<pageId>/result` on the
management gateway with its management bearer. A committed result returns `templateId`;
a missing, uncommitted or other-tenant result returns 404 and does not establish that a
save will never commit. This lookup does not expose the editor code or token. After an
uncertain save the UI keeps editing locked and offers an exact snapshot/key retry; the
host can also check the result. Open a new session for further edits.

`POST /v1/editor-sessions/save` accepts multipart `file` and JSON `fields` parts,
with `x-editor-token` and `idempotency-key` headers. The gateway forwards its trusted
Origin, never a management key; roles come only from the authorized session. One session
is bound to one key and request; exact retries can recover the same template, but an
error or lost response does not prove that nothing committed. Upload admission is spent
before the private binding reads the bounded body, including invalid requests and retries.
The template admission and creation limits must be explicitly configured. Fixed windows
are not a global concurrency limit; platform buffering, PDF resource consumption, R2/D1
non-atomicity and orphaned objects remain unresolved. This protocol is experimental,
default-disabled and requires independent security review before exposure.

Issuance fails closed without explicit test-only `TEST_EDITOR_WINDOW_MS`,
`TEST_EDITOR_TENANT_ISSUANCE`, `TEST_EDITOR_DATABASE_ISSUANCE`,
`TEST_EDITOR_TENANT_OUTSTANDING`, `TEST_EDITOR_DATABASE_OUTSTANDING`,
`TEST_EDITOR_TENANT_RETAINED`, and `TEST_EDITOR_DATABASE_RETAINED` settings.
The retained limits count all candidate editor bindings for the lifetime of this D1
database, including expired and revoked sessions. They are not replenished by expiry,
revocation, or window rollover; reaching a retained limit blocks further issuance.
No automatic deletion or recovery policy is provided. These database-local limits and
gateway edge-IP limiter are not approved production capacity controls. Revocation and origin changes permanently invalidate bound sessions;
D1 statement time is authoritative. Gateway and binding isolation, trustworthy edge
IP provenance, human authorization, independent security review and production abuse
controls remain prerequisites; this experimental protocol is not deployment approval.

Deployment preparation references: see [DEPLOYMENT-RUNBOOK.md](DEPLOYMENT-RUNBOOK.md); all templates remain inert and are not deployment authorization.

All three gateways also require a separate `LOCATION_RATE_LIMITER` binding with a fixed key, including preflights, before private calls. Missing, malformed or failing decisions return 503; denial returns 429. This approximately bounds changing-IP bypass per Cloudflare location without assuming header provenance, but is not a strict ceiling, account-wide quota, identity or concurrency control. See the deployment runbook for six distinct namespaces and limits. All gateways remain disabled by default.

### Static synthetic candidate preview

For local review only, build a separate, new output directory from `esign/`:

```sh
ESIGN_CANDIDATE_SYNTHETIC_PREVIEW=YES \
VITE_CANDIDATE_GATEWAY_ORIGIN=https://recipient.example.test \
VITE_CANDIDATE_EDITOR_GATEWAY_ORIGIN=https://editor.example.test \
npm run build:candidate-assets -- /absolute/path/to/new-output
```

The parent directory must already exist and contain no symlink components; the output directory must not exist. Replace the example origins with the exact HTTPS origins paired to the intended host configuration. The resulting `client/` contains only two static notice pages, and `worker.mjs` embeds their manifest and those origins. To serve them through the candidate page host locally, use this paired worker and assets, with `HOST_ENABLED=true` and matching `RECIPIENT_GATEWAY_ORIGIN` and `EDITOR_GATEWAY_ORIGIN`; the host otherwise remains unavailable. This is not deployment authorization. The preview has no scripts, forms or service functionality. Unset the preview setting for the normal candidate build; other nonempty values are rejected. Do not substitute preview assets into a normal candidate host or treat the preview as a working signing service.

### Isolated synthetic OTP sink (test only)

This opt-in mode is solely for synthetic signers and synthetic documents. It is not identity verification and must never be used for real documents or real signers. The operator must privately obtain authorization for the exact mailbox and tell test participants that every code goes there, regardless of the synthetic signer label. Do not put the mailbox address, codes, provider responses or message metadata in repository files, logs, tickets or fixtures.

In a dedicated isolated candidate environment only, set `ISOLATED_OTP_SYNTHETIC_SINK_ENABLED` to exactly `true` and privately set `ISOLATED_OTP_SYNTHETIC_SINK` to the one authorized lowercase ASCII mailbox. Set the existing explicit OTP enable, sender, pepper and budgets as above. Missing or invalid sink configuration, or any simultaneous `ISOLATED_OTP_RECIPIENTS` setting, fails closed; there is no fallback to signer delivery. When sink mode is absent, the existing exact two-recipient allowlist behavior remains unchanged. The candidate accepts distinct valid ASCII synthetic email labels, which remain bound to their task, session and verification but do not determine the sink-mode delivery destination. A label may equal the sink; delivery still targets the configured sink. These labels must be fictional.

For any future separately authorized deployment, configure the private Wrangler configuration manually in a trusted owner-only location; do not put addresses or secrets in shell arguments, history, logs or repository files. No configuration helper is provided. Keep both OTP and synthetic-sink enable switches false during preparation. Configure the Cloudflare Email Sending binding's `allowed_destination_addresses` to **exactly one** entry, the same privately authorized sink; restrict the sender separately. Before use, independently review and pin the intended Worker bundle SHA-256 and its paired asset manifest and bytes, confirm the configuration selects those exact artifacts, and review the actual effective bindings and settings, including both restrictions and the absence of unintended legacy mail paths. A config alone cannot prove which code runs or that it honors its settings. Independently verify both restrictions in the actual deployed binding, not just application settings, and disable the mode if either cannot be verified. Never allow API input to select a destination. The database-wide lifetime ten reservations and three per task remain mandatory, including ambiguous provider failures; they do not cover other databases or legacy mail paths. Use a fresh dedicated database and no parallel sender. Provider acceptance can remain ambiguous; do not retry automatically. This documentation authorizes no deployment or real send.

### Local staged browser smoke

With a previously prepared staged directory and local Chrome, run
`node scripts/local-browser-smoke.mjs /path/to/staged-directory` (optionally set
`ESIGN_TEST_CHROME` to the Chrome executable). The helper verifies the staged
manifest, starts a disposable local Worker and loopback bridge, and checks the
recipient and editor no-session messages separately. It supplies no credentials
or mail binding; Worker outbound fetches use a network-disabled mock. The bridge
accepts only exact GET page and asset paths and returns 404 for the favicon.
Unexpected requests observed by page-target CDP interception fail the smoke.

This is local synthetic evidence only. Page-target interception does **not**
prove browser-wide egress isolation: background traffic, other targets, workers,
and WebSockets may not be observed. It does not test a deployed origin, real
email, TSA, authentication, or production readiness. Use only trusted, stable
staged files; manifest validation does not prevent concurrent file replacement.

### Recipient demo origin safety

The original recipient demo accepts its existing local UI origins
`http://127.0.0.1:5173`, `http://127.0.0.1:5174`, and
`http://127.0.0.1:5197` only. On other origins it removes the page fragment and
stops before exchanging the code; in particular, an HTTPS page will not send a
fragment code to a service on the user's loopback interface. This is a
fail-closed local-demo restriction, **not user authentication** and not cloud
support. The allowed loopback host, Worker and local mailbox are for a trusted
single-user local environment only; other local processes are not trusted by
this check. A cloud demo requires a separately reviewed verified-user boundary,
recipient authorization, OTP handling and asset/API hosting before this
restriction can be safely replaced. Do not expose the local-test Worker or OTP
mailbox remotely.

The one exception is the page the Worker serves itself at `/sign`
([WORKER-MODE.md](WORKER-MODE.md)): the Worker declares its own origin in a
`<meta name="esign-api">` tag, and only when that matches the page's origin does
the page exchange the code there. A copy of the page on another origin, with or
without the tag, still stops before sending the code anywhere.

### Access-protected internal editor experiment

`src/internal-demo-worker.ts` is a separate, default-disabled experimental
entrypoint, not a signing service or deployment configuration. Readiness allows
the original `GET /v1/me` with both a valid Cloudflare Access JWT and the
original management bearer. A separately enabled editor slice provides the
original editor iframe and management session protocol. A separately enabled
recipient slice supports identity-bound exchange and OTP; document, signing
and finalization routes remain closed, including when local-test bindings are
accidentally supplied. No Wrangler configuration selects this
entrypoint; the original Worker and its local signing behavior remain unchanged.

Enabling it requires trusted runtime values `INTERNAL_DEMO_READINESS_ENABLED=true`,
`ACCESS_ISSUER`, `ACCESS_AUDIENCE`, `ACCESS_JWKS`, `INTERNAL_DEMO_EMAIL_DOMAIN` (the internal
email domain: only an Access identity whose email is exactly at it is admitted; unset or invalid
admits nobody), and the separate
`PREAUTH_RATE_LIMITER` binding with a valid edge-supplied `CF-Connecting-IP`. The issuer is an exact
canonical HTTPS origin; the audience is an exact configured Access audience.
The trusted JWKS is a JSON object containing one to eight public RSA signing
keys with distinct `kid`, `alg: RS256` and `use: sig`. It must be provisioned
independently from a verified Access source and rotated deliberately; neither a
request, an assertion's key URL nor an untrusted identity header supplies trust.
The Worker performs no JWKS network fetch. It verifies the signature, issuer,
audience and time claims, and requires a nonempty subject and an exact lowercase
internal-domain email claim. It never forwards the Access assertion as a
management credential. Missing or malformed configuration returns 503; invalid
assertions return 401. The bearer remains tenant-wide and must stay in a trusted
backend, never in browser code.

This is local test evidence only, **not deployment authorization** or a complete
identity policy. Static key provisioning and rotation, Access account policy,
revocation timing, rate limits, route normalization and actual ingress behavior
need independent review. A valid internal identity and tenant bearer do not
establish task or recipient authority. No protected signing path, synthetic-
document provenance or simulated completion is implemented by this entrypoint. Never use the local-test OTP or HMAC routes as a
cloud substitute. The default original Worker must not be publicly exposed.


The editor slice also requires explicit `INTERNAL_DEMO_EDITOR_ENABLED=true`,
`INTERNAL_DEMO_ORIGIN` (the exact HTTPS page origin), `INTERNAL_DEMO_MANAGEMENT_KEY`
(the existing tenant key, provisioned privately), `INTERNAL_DEMO_MANAGER_SUBJECTS`
(a JSON array of one to 32 exact trusted Access subjects), `DB`, `ARTIFACTS`,
`ASSETS`, `PREAUTH_RATE_LIMITER`, and `EDITOR_RATE_LIMITER`. Missing settings fail closed. The demo
BFF uses the management key only for the original editor-session routes; it
never sends the key to browser code. It requires a verified manager subject,
the exact origin, and an explicit synthetic-data confirmation for writes. The
same local/cloud editor host asks for confirmation; this is only an attestation,
not proof a PDF is synthetic. The original server-to-server editor-session
issue, source upload and result routes continue to require their tenant bearer
and reject browser Origin requests, without requiring a user Access assertion.
The iframe exchange, current, PDF and save routes require a valid Access JWT
**and** the existing page code or editor token. These credentials retain their
original session and parent-origin semantics; the iframe Access subject need not
match the session issuer. File uploads are size bounded and validated by the
existing PDF handlers. Source-URL downloads remain disabled. No management key
is returned to the page.

The pre-auth limiter uses a validated, normalized `CF-Connecting-IP` key before
JWT verification or management-key lookup. This header is trusted only when
independently enforced Cloudflare-edge ingress sets it; direct requests and
service-binding callers can forge it. The address is an admission key, not
identity. Missing or malformed addresses or limiter bindings fail closed.
Unknown routes do not spend either budget; rejected credentials and invalid
editor session credentials do not spend the separate authenticated fixed-key
budget. Both limiters are Cloudflare-location-local, not durable global quotas
or concurrency caps. Shared NAT clients can affect each other, changing IPs can
evade pre-auth limits, and neither limit protects all parser or platform
buffering costs. The isolated test database must not be shared with
legacy issuers. The session-issue and staged-source writes are separate: an
error can leave an unused session or source object requiring investigation.
There is no cleanup or cross-store atomicity. Independent review must establish
Access email-verification guarantees and trusted key rotation, prevent direct
asset or original-Worker bypass, and assess PDF resource isolation, admission,
credential lifecycle and browser iframe/Access-cookie behavior. Neither the
attestation nor local tests establish synthetic provenance or authorize use of
real contracts. No deployment or real email is authorized.

If an editor save is abandoned while its outcome is uncertain, the host keeps
the earlier-save warning across later opens and status checks for the lifetime
of that page. Reload loses this in-memory warning; it does not establish whether
the earlier save committed. Investigate the original session independently.

### Internal recipient identity exchange (partial)

The internal test entrypoint can separately enable the **original**
`POST /v1/envelopes/:envelopeId/tasks/:taskId/recipient-view` and
`POST /v1/page-sessions/exchange` contracts with
`INTERNAL_DEMO_RECIPIENT_ENABLED=true`, the trusted Access settings, `DB`,
`INTERNAL_DEMO_ORIGIN`, `PREAUTH_RATE_LIMITER`, `RECIPIENT_RATE_LIMITER`, and
explicit `TEST_ISSUANCE_WINDOW_MS`, `TEST_ISSUANCE_TENANT_LIMIT`,
`TEST_ISSUANCE_DATABASE_LIMIT`, `TEST_OUTSTANDING_TENANT_LIMIT`, and
`TEST_OUTSTANDING_DATABASE_LIMIT` settings. These are experimental limits, not
approved production policy. Apply migrations 0046 and 0047 only to a fresh authorized
test database under separate approval; none was applied remotely here. Missing
configuration or schema fails closed. The current slice accepts the configured
same-origin page only; broader original cross-origin compatibility is not yet
implemented.

Management issuance retains tenant bearer authentication and does not require a
user Access JWT; it rejects browser Origin headers, checks tenant and active task
in D1, and uses database-local candidate issuance budgets and retained-code
ceiling. The recipient exchange requires a signed Access JWT and exact browser
origin. It atomically consumes the original one-use code, creates the original
session and records the Access subject and email only when the stored active
task recipient email matches exactly. Wrong-user, expired, revoked and replayed
codes are rejected. The optional OTP routes below consume this binding; document,
preview and signing routes remain closed. This is not an end-to-end recipient
flow; the original recipient page still refuses cloud use. Candidate and legacy senders must not share this test
database, since they do not enforce this binding.

Access email-verification guarantees and static key distribution/rotation still
require independent confirmation. Budgets cover only this database and this
issuance path; the recipient and pre-auth rate limiters are location-local, and
trusted edge-only ingress is essential for client-IP admission. Issuance is not
idempotent; lost responses can consume retained capacity. There is no automatic
cleanup. Do not deploy, send mail, enable the local plaintext mailbox, or use
real contracts on the strength of this partial slice.

The recipient issuance batch checks the binding table and required columns before
spending its D1 issuance budget or creating a code. This checks schema presence,
not full migration correctness. Exchange checks code expiration again at the
consuming UPDATE and rolls back if it is no longer valid. A local trigger test
simulates expiration between statements; it is not evidence of every deployed
D1 timing or failure behavior.


### Internal recipient OTP experiment

The original `POST /v1/signing/otp` and `/v1/signing/otp/verify` routes are
separately default-disabled. They require `INTERNAL_DEMO_OTP_ENABLED=true`, the
recipient exchange settings above, `SEND_EMAIL`, `INTERNAL_DEMO_OTP_FROM`,
`INTERNAL_DEMO_OTP_PEPPER` (32–256 bytes provisioned privately), and explicit
`INTERNAL_DEMO_OTP_WINDOW_MS`, `INTERNAL_DEMO_OTP_TENANT_LIMIT`, and
`INTERNAL_DEMO_OTP_DATABASE_LIMIT`, and an explicit
`INTERNAL_DEMO_OTP_DELIVERY_MODE`. Missing or unknown mode fails closed. In
STRICT mode, `INTERNAL_DEMO_STRICT_RECIPIENTS` is an explicit JSON array of
one to 20 distinct lowercase internal-domain addresses, and
`INTERNAL_DEMO_STRICT_BINDING_RESTRICTIONS_ATTESTED=true` is required; the
verified recipient must be in the list. The attestation does not prove the
provider binding restrictions. No values, binding or route are configured
here, and this is not authorization to deploy or send. Only a fresh dedicated
database with the reviewed migrations can be used for local testing.

Each request requires a newly verified Access assertion, the original session
bearer and exact origin. In explicit STRICT mode, persisted Access subject and
email must match the assertion and the active task recipient; the separate
SINK_TEST mode below intentionally differs. Session revocation, expiry, tenant
origin and credential collision are checked in both modes. The same binding is
asserted inside the D1 quota/challenge reservation and verification batches.
A final read rechecks it and the exact challenge immediately before dispatch.
The configured mail binding receives the code only for the verified matching
recipient in STRICT mode or the fixed sink in SINK_TEST mode; no caller can
choose another destination. The route returns a
message ID, not an OTP; the challenge stores an HMAC, not plaintext.

The task budget allows at most three reservations per 15 minutes with a
60-second cooldown and five verification attempts; a session may reserve only
once. Immutable reservations cap the lifetime to three per task and ten in this
database. Configured tenant and shared-database fixed windows are additional,
not account-wide or global limits; legacy or parallel senders can bypass them.
Failed and ambiguous delivery consumes the reservation and is not retried
automatically. Exact verification retries work only while the same challenge
and authorized session remain valid. No cleanup or budget-reset service exists.

D1 and the mail provider do not share a transaction. Revocation, identity or
challenge changes after the final read can occur before provider acceptance;
a failure or timeout can follow acceptance. A returned response does not prove
actual delivery. The workerd test uses only an in-memory injected fake and
synthetic data; it verifies selected reservation and verification rollback
races, not all failures or real-provider semantics. A separate pre-existing
mail simulator test wrote its synthetic message to a Miniflare temporary file
and printed synthetic metadata and its temporary path; no real email was sent.
Static JWKS rotation, Access email-verification guarantees, network limits,
credential lifecycle, provider policy, sender verification and independent
security review remain unresolved. Do not deploy, configure a real mail binding,
send, or use real documents without separate authorization.


### Internal fixed-sink TEST ONLY mode

This isolated synthetic test mode is impersonation, not independent signer
identity or evidence. The authenticated operator can act on arbitrary valid
synthetic task email labels; a label need not equal the mailbox. Preserve
fictional data and never use real documents or real people's details. The
operator's synthetic-data attestation cannot prove document provenance.

In a separately authorized, dedicated isolated test database, select
`INTERNAL_DEMO_OTP_DELIVERY_MODE=SINK_TEST` and require all of
`INTERNAL_DEMO_SINK_TEST_ENABLED=true`,
`INTERNAL_DEMO_SINK_TEST_ATTESTED=true`,
`INTERNAL_DEMO_SINK_TEST_ISOLATED=true`,
`INTERNAL_DEMO_SINK_TEST_BINDING_RESTRICTIONS_ATTESTED=true`,
`INTERNAL_DEMO_SINK_TEST_ADDRESS` and `INTERNAL_DEMO_SINK_TEST_SUBJECT` from
trusted runtime configuration. The address must exactly match the verified
internal-domain Access email; the subject must exactly match that assertion's
subject. Configure neither address nor subject in public files, logs, shell
arguments or test fixtures. Sink mode requires the explicit OTP settings above
and `INTERNAL_DEMO_OTP_WINDOW_MS=86400000`,
`INTERNAL_DEMO_OTP_TENANT_LIMIT=2` and `INTERNAL_DEMO_OTP_DATABASE_LIMIT=2`.
No setting, secret or binding is enabled by default; partial or mixed modes
fail closed. STRICT and SINK_TEST sessions are not interchangeable.

Migration 0047 adds the session mode and task-label snapshot; issuance fails
closed if its required columns are missing. The original task label remains
unchanged, and the session, active task, label snapshot, operator subject and
email are checked in the exchange and OTP batches. Every mail dispatch uses
the fixed configured sink, never the task label or request-selected address.
The checked 10-reservation lifetime ceiling and three per task apply only to
this D1 database; other databases, Workers or senders can bypass them. The two
per 24-hour windows apply to this database and tenant, not the Cloudflare
account as a whole. Failures or ambiguous sends consume reservations.

Before any separately authorized live use, independently inspect the actual
Cloudflare Email Sending binding and confirm its allowed sender and **exactly
one** allowed destination match the private configuration. Runtime flags are
operator attestations, not proof of effective provider restrictions or code
isolation. Verify a dedicated test database and absence of parallel legacy
senders, protect credentials and logs, and independently review the bundle,
Access verified-email guarantees, JWKS rotation and disclosure to participants.
D1 and provider dispatch are not atomic: state can change after the last read
and an error or timeout may follow provider acceptance. This documentation
authorizes no deployment, real email, resource modification or real contract.
