---
title: E-sign API
description: E-sign's management API for host products, service accounts and AI agents, its public signer endpoints, and how to embed the signing page.
order: 7
---

E-sign's API is what its own pages use, and what host products, service accounts and AI agents call. This page lists the
endpoints from E-sign's catalog (`GET /api/catalog`), with the permission each needs, explains the public endpoints the
signing page and the editor use, and shows examples. It is for developers and AI agents.

## Base URL and authentication

The base URL is `https://esign.insulinapps.com`. Every endpoint is under `/api/`.

| Caller | How it authenticates | Notes |
| --- | --- | --- |
| A person in the browser | Their insulinapps.com session | What E-sign's own pages do. |
| A service account | `Authorization: Bearer` with a token from `https://insulinapps.com/oauth/token` | Created by an app admin on E-sign's integrations page, with a role of its own. See [API and service accounts](/docs/platform/api-and-service-accounts). |
| An AI agent | Through the MCP server at `https://esign.insulinapps.com/mcp` | Acts with the person's role. Its tools `read` and `change` call these endpoints. See [AI agents](/docs/platform/ai-agents). |
| A signer's page | A one-time code exchanged for a page session (`x-esign-session` header) | Only the public `/api/public/` endpoints. |

Every management call sees only the caller's organization. An id from another organization answers `404 not_found`, as
if it didn't exist.

## Conventions

- **JSON** in and out, except uploads (multipart or PDF bytes) and PDF downloads.
- **Permissions.** Reading (`GET`) needs **View envelopes** (`esign.view`); anything else needs **Send and manage
  envelopes** (`esign.manage`). `GET /api/me` and `GET /api/catalog` work for every role.
- **Errors** are `{"error": "<code>"}` with an HTTP status: `400` and `422` for a request E-sign doesn't accept, `401
  unauthorized` without an identity, `403 forbidden` when the role doesn't allow it, `404 not_found`, `409` when the state
  changed meanwhile (for example `envelope_not_voidable` or `idempotency_conflict`).
- **Signing must be set up.** Until it is, the endpoints marked † answer `404 signing_disabled`. `GET /api/me` says
  whether it is (`signingEnabled`).
- **Paging.** Lists are newest first: `limit` (1 to 100, default 50) and `before` (a time in epoch milliseconds: pass the
  last item's `createdAt` for the next page).
- **Ids** are opaque strings. Times in lists are epoch milliseconds (`createdAt`); deadlines and audit times are ISO 8601.

## Endpoints

### Who is calling

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /api/me` | Any role | The caller: organization, user, role, permissions, how the request came (`browser`, `mcp` or `api`) and whether signing is enabled. |
| `GET /api/catalog` | Any role | The endpoints the caller may use, each with its method, path, summary, query and body JSON Schema, and whether it needs an `Idempotency-Key`. |

### Templates

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /api/templates` | View | The organization's templates, newest first: `{templates: [{id, roles, fields, createdAt}]}`. |
| `POST /api/templates` | Manage | Upload a PDF (at most 5 MiB and 100 pages) as multipart form fields `file` and `roles` (a JSON array of 1 to 20 distinct role names, in signing order). Answers `201 {id, roles}`. Signed on an added signature page. |
| `GET /api/templates/{id}` | View | A template's roles and placed fields (type, role, page, box), and whether they can be signed. |
| `POST /api/template-editing-sessions` | Manage | Open the field editor for a host page to embed: `{allowedParentOrigin, roles?, sourceTemplateId?}`. Answers `{sessionId, url}`. |
| `POST /api/template-editing-sessions/{id}/source` | Manage | Stage the PDF the session starts from (body: the PDF, `application/pdf`), once, before the editor is opened. |
| `GET /api/template-editing-sessions/{id}` | View | `{templateId}` once the editor has saved, else `{templateId: null}`. |

### Envelopes

| Method and path | Permission | What it does |
| --- | --- | --- |
| `GET /api/envelopes` | View | The organization's envelopes, newest first: `{envelopes: [{id, templateId, status, createdAt, documentName?}]}`. Filter with `status`. |
| `POST /api/envelopes` | Manage | Send a template for signature, one recipient per role. Needs an `Idempotency-Key` header. Answers `201 {id, status: "IN_PROGRESS"}`; the first signer's turn starts at once. |
| `GET /api/envelopes/{id}` | View | Status and each signer's task, in order: `id`, `role`, `recipientName`, `recipientEmail`, `routingOrder`, `status`, `expiresAt`, `openedAt`. |
| `GET /api/envelopes/{id}/audit` | View | The audit trail, in order: `{events: [{type, at, recipient?, ip?, userAgent?, detail?}]}`. Never codes or message ids. |
| `POST /api/envelopes/{id}/void` | Manage | Withdraw an envelope that is out for signature, with an optional `{reason}` (up to 500 characters). Repeating it is harmless; any other status answers `409 envelope_not_voidable`. |
| `POST /api/envelopes/{id}/tasks/{taskId}/recipient-view` † | Manage | A one-time code for the active signer's signing page: `{code}`. Body: `{origin?, hostAuthentication?}`. |
| `GET /api/envelopes/{id}/delivery-pdf` † | View | A completed envelope's signed PDF followed by its certificate of completion. |
| `GET /api/envelopes/{id}/certificate` † | View | A completed envelope's certificate as JSON: the seal, checked against the stored files on every read. |
| `POST /api/process-due` † | Manage | Due work for the caller's organization, at once: answers `{expired, completed, waiting, failed}`. The platform runs it for every organization every five minutes anyway. |

`POST /api/envelopes/{id}/prepare` still exists for older callers and does nothing; don't use it.

Envelope statuses are `IN_PROGRESS`, `FINALIZING`, `COMPLETED`, `VOIDED`, `DECLINED` and `EXPIRED`; a signer's task is
`PENDING`, `ACTIVE` or `SIGNED`. See [Sending envelopes](/docs/esign/sending-envelopes#statuses).

## Send an envelope

`POST /api/envelopes` takes:

| Field | Required | What it is |
| --- | --- | --- |
| `templateId` | Yes | The template to send. |
| `recipients` | Yes | One per role of the template (1 to 20), each `{role, name, email}` and optionally `expiresAt` (ISO 8601, in the future, within 400 days), `title` (up to 128 characters), `onBehalfOf` (the company, up to 200), `namedBy` (who named this signer, up to 300) and `afterSigning` (up to 3 lines shown after signing). |
| `documentName` | No | Shown to signers and named in the statement they agree to (up to 200 characters). |
| `documentVersion` | No | `{label, publishedAt?}`, such as `{"label": "v3"}`. |
| `sender` | No | `{name, email?, organization?}`. |

The `Idempotency-Key` header is required: 1 to 128 letters, digits, `-` or `_`, a fresh random value for each new
envelope. The envelope's id is derived from your organization and the key, so:

- repeating the same request with the same key answers `201` with the same id, whatever the envelope's status is now;
- the same key with a different request answers `409 idempotency_conflict`.

Other refusals: `400 idempotency_key_required`, `422 invalid_envelope` or `invalid_recipient` (a field out of bounds),
`422 invalid_roles` (the recipients don't match the template's roles one to one), `422 unsupported_recipient_name` (a
name the signature page can't draw), `422 positioned_fields_not_supported` (the template's placed fields can't be signed),
`404 not_found` (no such template).

## Examples

These examples use synthetic values. Replace the client id and secret with your service account's.

### Get a token

```bash
TOKEN=$(curl -s https://insulinapps.com/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d resource=https://esign.insulinapps.com | jq -r .access_token)
```

Tokens last an hour. Ask for a new one when it expires.

### Upload a template

```bash
curl -s https://esign.insulinapps.com/api/templates \
  -H "Authorization: Bearer $TOKEN" \
  -F file=@./partnership-agreement.pdf \
  -F 'roles=["partner","seller"]'
```

```json
{ "id": "3f0c8a5e-0d7b-4b7e-9a51-2f6d0c1e7a90", "roles": ["partner", "seller"] }
```

### Send it

```bash
curl -s https://esign.insulinapps.com/api/envelopes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d @envelope.json
```

with `envelope.json`:

```json
{
  "templateId": "3f0c8a5e-0d7b-4b7e-9a51-2f6d0c1e7a90",
  "documentName": "Partnership agreement",
  "documentVersion": { "label": "v2" },
  "sender": { "name": "Jordan Lee", "organization": "Example Ventures LLC" },
  "recipients": [
    { "role": "partner", "name": "Avery Patel", "email": "avery.patel@example.com" },
    {
      "role": "seller",
      "name": "Sam Rivera",
      "email": "sam.rivera@example.com",
      "title": "Chief Executive Officer",
      "onBehalfOf": "Bluebird Parts Inc.",
      "afterSigning": ["Our team countersigns within two business days."]
    }
  ]
}
```

Keep the `Idempotency-Key` you used: if the response is lost, send the same request with the same key to get the same
envelope back.

### Follow it

```bash
curl -s https://esign.insulinapps.com/api/envelopes/$ENVELOPE_ID -H "Authorization: Bearer $TOKEN"
curl -s https://esign.insulinapps.com/api/envelopes/$ENVELOPE_ID/audit -H "Authorization: Bearer $TOKEN"
```

When the status is `COMPLETED`, download the signed PDF with its certificate:

```bash
curl -s -o signed-with-certificate.pdf \
  https://esign.insulinapps.com/api/envelopes/$ENVELOPE_ID/delivery-pdf -H "Authorization: Bearer $TOKEN"
```

### From an AI agent

An agent connected over MCP uses the platform's tools with the same endpoints: `whoami` to see its role, `endpoints` to
read the catalog, `read` for a `GET` and `change` for a `POST`, with an optional `idempotencyKey`. For example, to send an
envelope, the agent calls `change` with:

```json
{
  "method": "POST",
  "path": "/api/envelopes",
  "idempotencyKey": "send-partnership-agreement-v2-0001",
  "body": {
    "templateId": "3f0c8a5e-0d7b-4b7e-9a51-2f6d0c1e7a90",
    "recipients": [
      { "role": "partner", "name": "Avery Patel", "email": "avery.patel@example.com" },
      { "role": "seller", "name": "Sam Rivera", "email": "sam.rivera@example.com" }
    ]
  }
}
```

The MCP tools send JSON only, so an agent can't upload a PDF; it sends envelopes from templates people or service
accounts uploaded.

## Embed the signing page

A host product shows the signing page inside its own pages:

1. When it is a signer's turn (their task is `ACTIVE`), the host's backend calls
   `POST /api/envelopes/{id}/tasks/{taskId}/recipient-view` with `{}` and gets `{code}`.
2. The host frames `https://esign.insulinapps.com/sign#code=CODE&host=HOST_ORIGIN`, where `HOST_ORIGIN` is the host
   page's origin (for messages). Put the code in the fragment, never in a query string, and never log it.
3. The page exchanges the code for a 15-minute session, takes the signer through review, the emailed code and signing,
   and posts `esign.signing.finished` (`signed` or `declined`) or `esign.signing.cancel` to the host.
4. The host treats the message as a prompt and reads the envelope's status with `GET /api/envelopes/{id}`.

Rules:

- The code works once, within two minutes, only for that signer and while their task is active.
- The host's origin must be one of the origins the deployment allows to embed E-sign's pages. The page refuses to start
  in a frame from any other origin, or in one that hides its origin.
- `hostAuthentication` (`{method, provider?, domain?, signedInAt?}`, `method` an upper-case word such as `SSO`) tells
  E-sign how the host signed the signer in. E-sign can't check it; it shows it to the signer and records it as the
  host's statement.
- The code that confirms the signer always goes to their own email address.

To embed the field editor instead, see [Templates and fields](/docs/esign/templates#embed-the-editor-in-a-host-product).

## Public endpoints

The signing page, the copy page and the editor call these themselves. They take a one-time code or a page session, never
a platform identity, and the platform forwards them without one. They are listed so you know what exists; a host never
calls them directly.

| Endpoint | Used by | What it does |
| --- | --- | --- |
| `POST /api/public/page-sessions/exchange` | Signing page | Exchanges the one-time code for a page session. |
| `GET /api/public/signing/current` | Signing page | The document's details, fields, disclosure and intent statement, and whether the code is verified. |
| `GET /api/public/signing/pdf` | Signing page | The PDF to sign. |
| `POST /api/public/signing/page-views` | Signing page | Records the pages the signer viewed. |
| `POST /api/public/signing/otp` | Signing page | Sends the 6-digit code to the signer's email. |
| `POST /api/public/signing/otp/verify` | Signing page | Checks the code. |
| `POST /api/public/signing/preview` | Signing page | Renders a field's preview image on the server. |
| `POST /api/public/signing/decline` | Signing page | Declines, with a reason. |
| `POST /api/public/signing/sign` | Signing page | Records the signature. |
| `POST /api/public/copies/open` | Copy page | Downloads a signer's copy, once, within 30 days. |
| `POST /api/public/editor/exchange`, `GET /api/public/editor/current`, `GET /api/public/editor/pdf`, `POST /api/public/editor/save` | Field editor | The editor's session, its source PDF, and one save. |
| `GET /api/health` | Anyone | `{"status": "ok", "service": "esign"}`. |

The platform limits requests to these paths per IP address, and those that change something (code exchanges, sends and
checks) more strictly.
