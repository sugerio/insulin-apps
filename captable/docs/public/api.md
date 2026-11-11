---
title: Cap Table API
description: Cap Table's HTTP API for AI agents and OAuth clients, every endpoint with the access it needs, and how changes are made safely.
order: 5
---

This page describes Cap Table's API: how to reach it, every endpoint grouped by area with the access it needs, how
changes are reviewed and retried safely, and what errors look like. It is for developers connecting another system with
an OAuth client, and for AI agents connected over MCP. The authoritative list for any caller is `GET /api/catalog`,
which returns only what that caller may use right now.

## Base URL and authentication

The base URL is `https://captable.insulinapps.com`, and every endpoint is under `/api/`. There are two ways in besides
the browser:

- **AI agents over MCP.** Connect an MCP client to `https://captable.insulinapps.com/mcp`. Cap Table's **Connect AI**
  page (`https://insulinapps.com/apps/captable/settings/connect-ai`, or **Connect AI** in the account bar) has the
  command for Claude Code, Codex, Gemini CLI and opencode, and the steps for Claude.ai and ChatGPT. The agent signs in as
  you and acts with your role. Its `endpoints` tool shows this app's catalog, `read` sends a GET, and `change` sends a
  POST, PUT, PATCH or DELETE with a JSON body. See [AI agents](/docs/platform/ai-agents).
- **OAuth clients.** An owner or admin of the organization creates an OAuth client, with a role, on Cap Table's **API
  access** tab (`https://insulinapps.com/apps/captable/settings/api`), which also shows the token URL and a curl
  example. Your program gets a token with the client-credentials grant and sends it as a Bearer token. **Rotate
  secret** keeps the previous secret working for 24 hours, so the program can switch over. See
  [API access with OAuth clients](/docs/platform/api-and-service-accounts).

```bash
# Get an access token (it lasts an hour), then ask what this OAuth client may call.
TOKEN=$(curl -s https://insulinapps.com/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d resource=https://captable.insulinapps.com | jq -r .access_token)

curl -s https://captable.insulinapps.com/api/catalog -H "Authorization: Bearer $TOKEN"
```

A person's MCP token works only on `/mcp`, and an OAuth client's token only on `/api/*`. Either way, Cap Table sees
the same identity and role checks as in the browser, and every change appears in the history under the person's or the
OAuth client's name.

## Finding your way

1. **Call `GET /api/me`.** It says who you are, your role and effective permissions, how you arrived (`browser`, `mcp`
   or `api`), your access level (`admin_rw`, `admin_ro`, `holder` or `none`), the company (or `null` before setup) and
   the stakeholders you hold equity as.
2. **Take the company id.** Most paths contain `{orgId}`: the Cap Table company's id, a UUID, from `company.id` in
   `GET /api/me` or from `GET /api/orgs`. It is not your Insulin Apps organization's id.
3. **Call `GET /api/catalog`** for the endpoints your access allows, with their query and body JSON Schemas.

Every id in a path is a UUID; anything else is a 404. Amounts and quantities travel as decimal strings (such as
`"48000"` or `"0.25"`), never as floating-point numbers, and dates as `YYYY-MM-DD` in the company's time zone.

## The catalog

`GET /api/catalog` returns `{ "endpoints": [...] }`. Each entry has the `method`, the `path` with `{param}`
placeholders, a `summary`, the `query` and `body` as JSON Schema (or `null`), and `idempotencyKey`: whether a change
needs an `Idempotency-Key` header. What it lists depends on your access:

| Your access | What the catalog lists |
|---|---|
| Record changes, before a company exists | `GET /api/me`, `GET /api/catalog`, `POST /api/orgs` (first-run setup) and the import endpoints |
| Record changes (`admin_rw`) | Everything for the company, except the first-run setup |
| View the cap table only (`admin_ro`) | The company's read endpoints, and the vesting preview |
| See own holdings, with a match (`holder`) | `GET /api/me`, `GET /api/catalog` and the holder endpoints |
| None of these | `GET /api/me` and `GET /api/catalog` |

An abridged example, for someone who records changes:

```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/api/me",
      "summary": "Console identity, company access and holder matches",
      "query": null,
      "body": null,
      "idempotencyKey": false
    },
    {
      "method": "GET",
      "path": "/api/orgs/{orgId}/cap-table",
      "summary": "The cap table as of a date and as known at a seq, by tab",
      "query": {
        "type": "object",
        "properties": {
          "asOf": { "type": "string" },
          "asKnownAt": { "type": "integer", "minimum": 0 },
          "tab": { "type": "string", "enum": ["ownership", "shares", "options", "safes", "warrants"], "default": "ownership" }
        }
      },
      "body": null,
      "idempotencyKey": false
    },
    {
      "method": "POST",
      "path": "/api/orgs/{orgId}/stakeholders",
      "summary": "Create a stakeholder with e-mail addresses",
      "query": null,
      "body": { "type": "object", "properties": { "kind": { "type": "string", "enum": ["individual", "institution"] } } },
      "idempotencyKey": true
    }
  ]
}
```

The real schemas are complete; the ones above are shortened.

## Endpoints

The **Access** column uses these names:

- **Anyone**: any signed-in caller of the app.
- **Read**: **View the cap table** or **Record changes** (Admins and Editors have both).
- **Record changes**: the **Record changes** permission (`captable.manage`).
- **Holder**: **See own holdings**, for a caller whose e-mail address matches a stakeholder. A caller without a match
  gets 404 on every holder endpoint.

### Identity and setup

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/me` | Identity, role, permissions, company access and holder matches | Anyone |
| GET | `/api/catalog` | The endpoints the caller may use, with their schemas | Anyone |
| GET | `/api/orgs` | The organization's active company, when one exists | Read |
| POST | `/api/orgs` | First-run company setup with an empty ledger | Record changes, before a company exists |
| GET | `/api/import/template` | Download the blank Cap Table spreadsheet template | Record changes |
| POST | `/api/import/preview` | Check Pulley reports or a filled spreadsheet (multipart form); no idempotency key | Record changes |
| POST | `/api/import/runs/{runId}/commit` | Import the files that produced a reviewed preview (multipart form) | Record changes |
| GET | `/api/import/runs/{runId}` | An import run's status and counts | Record changes |

### Company

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}` | Profile, settings and ledger head | Read |
| PATCH | `/api/orgs/{orgId}` | Change the profile and company settings | Record changes |
| GET | `/api/orgs/{orgId}/signatories` | The imported signatory records (view only) | Read |
| GET | `/api/orgs/{orgId}/admin-links` | Links between admins and stakeholders, which block self-dealing | Read |
| POST | `/api/orgs/{orgId}/admin-links` | Link an admin's address to a stakeholder | Record changes |
| POST | `/api/orgs/{orgId}/admin-links/{id}/remove` | Remove an admin link | Record changes |
| GET | `/api/orgs/{orgId}/payment-instructions` | Current payment instructions (masked for read-only access) | Read |
| POST | `/api/orgs/{orgId}/payment-instructions` | Set payment instructions | Record changes |

### Stakeholders

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}/stakeholders` | Every stakeholder, with totals, portal state and e-mail addresses | Read |
| POST | `/api/orgs/{orgId}/stakeholders` | Create a stakeholder with e-mail addresses | Record changes |
| GET | `/api/orgs/{orgId}/stakeholders/{id}` | Profile, e-mail addresses, holdings summary, termination, leave and exercises | Read |
| PATCH | `/api/orgs/{orgId}/stakeholders/{id}` | Edit profile fields | Record changes |
| POST | `/api/orgs/{orgId}/stakeholders/{id}/emails` | Add an e-mail address | Record changes |
| POST | `/api/orgs/{orgId}/stakeholders/{id}/emails/{emailId}/remove` | Remove an e-mail address | Record changes |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/holdings` | The stakeholder's securities, with numbers | Read |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/iso-split` | ISO/NSO lots by year (the $100,000 test) | Read |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/preview` | Preview as stakeholder: their portfolio | Read |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/preview/securities/{securityId}` | Preview as stakeholder: one holding | Read |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/preview/documents` | Preview as stakeholder: their documents | Read |
| GET | `/api/orgs/{orgId}/stakeholders/{id}/preview/how-to-exercise` | Preview as stakeholder: How to exercise | Read |

### Share classes, plans and vesting

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}/stock-classes` | Classes with authorized, issued and outstanding, reserved and available | Read |
| GET | `/api/orgs/{orgId}/stock-classes/{id}` | A class with the history of its terms and authorized shares | Read |
| GET | `/api/orgs/{orgId}/stock-plans` | Plans with size, available and outstanding | Read |
| GET | `/api/orgs/{orgId}/stock-plans/{id}` | Capacity, return-to-pool rules, exit-window defaults, amendments | Read |
| GET | `/api/orgs/{orgId}/vesting-terms` | Vesting definitions, with the grants using each | Read |
| POST | `/api/orgs/{orgId}/vesting-terms/preview` | Expand a definition for a quantity and start date; writes nothing, no idempotency key | Read |
| GET | `/api/orgs/{orgId}/vesting-terms/{id}` | One vesting definition | Read |
| POST | `/api/orgs/{orgId}/vesting-terms/{id}/confirm` | Record once that an imported template matches the plan's schedule | Record changes |

### Valuations

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}/valuations` | Valuations, newest first, with status and prices | Read |
| POST | `/api/orgs/{orgId}/valuations` | Record a 409A valuation with its report | Record changes |
| GET | `/api/orgs/{orgId}/valuations/fmv` | The fair market value in effect on a date, with its status | Read |
| POST | `/api/orgs/{orgId}/valuations/material-events` | Flag a material event (the valuation then needs review) | Record changes |
| GET | `/api/orgs/{orgId}/valuations/{id}` | Events, prices, documents and the grants priced with it | Read |
| POST | `/api/orgs/{orgId}/valuations/{id}/review-cleared` | Clear a review with written confirmation | Record changes |
| POST | `/api/orgs/{orgId}/valuations/{id}/events/{eventId}/reverse` | Reverse a material-event flag raised in error | Record changes |
| POST | `/api/orgs/{orgId}/valuations/{id}/void` | Void a valuation recorded in error | Record changes |

### Ledger commands

Every change to holdings is a command: `POST /api/orgs/{orgId}/commands/<name>`. All need **Record changes**, and none
may touch the caller's own holdings (403 `self_dealing`).

| Command | What it records |
|---|---|
| `grant-equity-compensation` | A signed option grant |
| `exercise-option` | An exercise the holder reported (vested options only) |
| `terminate-stakeholder` | A termination: unvested awards cancelled at the vesting stop, accelerations and extensions |
| `schedule-termination` | A future termination, applied when due items are processed on the date |
| `cancel-scheduled-termination` | Cancels a scheduled termination |
| `cancel-security` | Cancels an option or warrant (holder waiver, not executed, mutual agreement, forfeiture) |
| `mark-executed` | Marks a grant executed, with the agreement signed by both parties |
| `record-leave-of-absence` | A leave of absence (it can move the ISO deadline) |
| `extend-exercise-deadline` | Extends an exercise deadline, with a counsel-approved document |
| `set-plan-terms` | A plan's return-to-pool rules, exit-window defaults and status (no screen in the app) |
| `merge-stakeholders` | Merges a duplicate stakeholder into the surviving record |
| `reverse-command` | Reverses every transaction of one earlier command |

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}/commands/{id}` | A command, its transactions, dependencies, dependents and reversal | Read |
| GET | `/api/orgs/{orgId}/commands/{id}/reversal-preview` | What reversing a command would do, and what depends on it | Read |
| POST | `/api/orgs/{orgId}/process-due` | Process due scheduled terminations and expiries; safe to repeat, no idempotency key | Record changes |
| GET | `/api/orgs/{orgId}/expiry-runs` | Expiry runs waiting for confirmation | Read |
| GET | `/api/orgs/{orgId}/expiry-runs/{runId}` | One expiry run and the securities it proposes to expire | Read |
| POST | `/api/orgs/{orgId}/expiry-runs/{runId}/confirm` | Confirm an expiry run, and optionally switch expiry to automatic | Record changes |

### Cap table and holdings

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/orgs/{orgId}/dashboard` | Company metrics, needs attention, in progress and recent activity | Read |
| GET | `/api/orgs/{orgId}/cap-table` | The cap table as of a date (`asOf`), as known at a ledger position (`asKnownAt`), by `tab` | Read |
| GET | `/api/orgs/{orgId}/securities-status` | Execution pending, scheduled terminations, former holders' securities, expiring | Read |
| GET | `/api/orgs/{orgId}/securities` | Every security with its numbers | Read |
| GET | `/api/orgs/{orgId}/securities/{id}` | Terms, numbers, execution status, deadlines, lineage, certificate, documents | Read |
| GET | `/api/orgs/{orgId}/securities/{id}/vesting` | Vesting events with running totals, accelerations and the stop | Read |
| GET | `/api/orgs/{orgId}/securities/{id}/timeline` | Transactions on the lot and its lineage, oldest first | Read |
| GET | `/api/orgs/{orgId}/securities/{id}/termination-preview` | Vested, exercisable and deadlines on a termination date | Read |
| GET | `/api/orgs/{orgId}/transactions` | The ledger, newest first (paged) | Read |
| GET | `/api/orgs/{orgId}/transactions/{id}` | One transaction: payload, hashes, previous hash, command, reversal | Read |
| GET | `/api/orgs/{orgId}/exercises` | Every exercise, imported and recorded | Read |
| GET | `/api/orgs/{orgId}/exercise-requests` | Imported exercise requests, read only | Read |
| GET | `/api/orgs/{orgId}/exercise-requests/{id}` | One imported exercise request | Read |
| GET | `/api/orgs/{orgId}/signature-requests` | Pulley's signature state at the import | Read |
| GET | `/api/orgs/{orgId}/certificates` | Certificates, view only | Read |
| GET | `/api/orgs/{orgId}/legends` | Legends, view only | Read |
| GET | `/api/orgs/{orgId}/certificate-terms` | Certificate terms, view only | Read |
| GET | `/api/orgs/{orgId}/elections-83b` | Imported 83(b) records, view only | Read |
| GET | `/api/orgs/{orgId}/audit` | The audit log, newest first (paged) | Read |
| POST | `/api/admin/orgs/{orgId}/verify-ledger` | Verify the company's ledger now | Record changes |

### Documents

| Method | Path | Summary | Access |
|---|---|---|---|
| POST | `/api/orgs/{orgId}/documents` | Upload a document: the raw file, up to 10 MiB, with `X-Filename`, `X-Document-Kind` and `X-Content-SHA256` headers | Record changes |
| GET | `/api/orgs/{orgId}/documents` | Documents, newest first (paged) | Read |
| GET | `/api/orgs/{orgId}/documents/{id}` | Metadata, links and versions | Read |
| PATCH | `/api/orgs/{orgId}/documents/{id}` | Edit metadata, folder and archived state | Record changes |
| POST | `/api/orgs/{orgId}/documents/{id}/links` | Link a document to a record | Record changes |
| POST | `/api/orgs/{orgId}/documents/{id}/links/{linkId}/revoke` | Revoke a link | Record changes |
| POST | `/api/orgs/{orgId}/documents/{id}/holder-visibility` | Show or hide a document in the holder view | Record changes |
| POST | `/api/orgs/{orgId}/documents/{id}/versions` | Upload a new version; the old one stays | Record changes |
| GET | `/api/orgs/{orgId}/documents/{id}/download` | Download the file (recorded in the audit log) | Read |
| GET | `/api/orgs/{orgId}/collections` | Folders | Read |
| POST | `/api/orgs/{orgId}/collections` | Create a folder | Record changes |
| PATCH | `/api/orgs/{orgId}/collections/{id}` | Rename, move or archive a folder | Record changes |

### Reports

`GET /api/orgs/{orgId}/reports/{reportKey}` runs one report (**Read** access), recorded in the audit log before the
first byte. Query: `format`, `asOf`, `asKnownAt`, `from`, `to` and `includePii`.

| `reportKey` | Formats |
|---|---|
| `cap-table` | `xlsx`, `json` |
| `raw-cap-table` | `csv`, `xlsx`, `json` |
| `stakeholders` | `csv`, `xlsx`, `json` |
| `vesting-details` | `xlsx`, `json` |
| `exercise-history` | `xlsx`, `json` |
| `audit-log` | `csv` |

### Holder view

| Method | Path | Summary | Access |
|---|---|---|---|
| GET | `/api/portal/overview` | The caller's own holdings, with `asOf` | Holder |
| GET | `/api/portal/orgs/{orgId}/securities/{id}` | One of the caller's own securities | Holder |
| GET | `/api/portal/orgs/{orgId}/documents` | The caller's documents and the company resources | Holder |
| GET | `/api/portal/orgs/{orgId}/how-to-exercise` | How to exercise: text, notice form, payment instructions, company contact | Holder |
| GET | `/api/portal/documents/{id}/download` | Download a document the caller may see | Holder |

Holder responses contain only the caller's own records: no cap table, no other holders and no ownership percentages.

## Making changes safely

### Idempotency keys

Every change whose catalog entry says `"idempotencyKey": true` needs an `Idempotency-Key` header: a fresh random value,
such as a UUID, for each intended change. Retrying with the same key and the same body returns the stored answer, so a
retry after a lost connection never records anything twice. The same key with a different body is refused with 409
`idempotency_key_reused`. Over MCP, pass the key as the `change` tool's `idempotencyKey`.

### Review, then commit

Ledger commands follow the same review pattern as the app's screens:

1. **Dry run.** Send the command with `?dryRun=true`. It needs no idempotency key and writes nothing. The answer lists
   the transactions and changes it would make, any `violations` (which block) and `warnings`, the current `ledgerSeq`
   and a `diffSha256`.
2. **Commit.** Send the same body with `expectedLedgerSeq` set to that `ledgerSeq`, `expectedDiffSha256` set to that
   `diffSha256`, the codes of any warnings you accept in `acknowledge`, and an `Idempotency-Key`.
3. **If someone else changed the cap table in between,** the commit is refused with 409 `stale_ledger` or
   `state_changed`. Run the dry run again, review, and commit with the new values.

Commands that ask for confirmation in the app (cancellations, **Mark executed**, deadline extensions, merges and
reversals) also take a `confirmation` field: the display ID of the record, such as `OPT-33`.

Edits to versioned records (such as `PATCH` on the company or a folder) send back the `version` they read; if it moved,
the answer is 409 `stale_version`.

### What MCP can't send

The MCP `change` tool sends JSON bodies only. Uploading a document (a raw file body) and running an import (a multipart
form) need an OAuth client or the browser.

## Errors

Errors are JSON with one `error` object. For example, adding a stakeholder with an address another stakeholder already
has answers:

```json
{
  "error": {
    "code": "warnings_unacknowledged",
    "message": "Review the warning before continuing",
    "warnings": [
      { "code": "DUPLICATE_EMAIL", "message": "This e-mail is already used by another stakeholder" }
    ]
  }
}
```

A rule the change would break answers `invariant_violation` with a `violations` list instead, each with a `code` (such
as `EXCEEDS_VESTED_UNEXERCISED`) and a plain `message`.

| Code | Status | Meaning |
|---|---|---|
| `validation_failed` | 400 | The body, query or path is invalid; `issues` lists each problem |
| `unauthenticated` | 401 | No identity |
| `forbidden` | 403 | Your access doesn't allow this |
| `self_dealing` | 403 | A change to your own holdings |
| `not_found` | 404 | No such record, a record you can't see, or an id that isn't a UUID |
| `conflict` | 409 | `reason` says why: `stale_version`, `stale_ledger`, `idempotency_key_reused`, `state_changed`, `dependents_exist` (with `dependents`) or `migrated_history` |
| `payload_too_large` | 413 | The body is too large |
| `unsupported_media_type` | 415 | A file type that isn't allowed, or content that doesn't match its type |
| `digest_mismatch` | 422 | An upload's bytes don't match `X-Content-SHA256`; nothing was stored |
| `invariant_violation` | 422 | The change breaks a rule; `violations` lists them |
| `warnings_unacknowledged` | 422 | Warnings to accept; send their codes in `acknowledge` |
| `unavailable` | 503 | The database is briefly unavailable; nothing was written, try again |
| `internal` | 500 | An unexpected error |

## Examples over MCP

These are the arguments an agent passes to the MCP tools. The ids are synthetic.

### Read the cap table as of a date

```json
{
  "name": "read",
  "arguments": {
    "path": "/api/orgs/0b6f1d2e-4c1a-4b8e-9f3a-2d7c5e8a9b10/cap-table",
    "query": { "asOf": "2026-10-27", "tab": "ownership" }
  }
}
```

The answer echoes the `asOf` date, the ledger position it reflects, and the rows of the chosen tab.

### Add a stakeholder

```json
{
  "name": "change",
  "arguments": {
    "method": "POST",
    "path": "/api/orgs/0b6f1d2e-4c1a-4b8e-9f3a-2d7c5e8a9b10/stakeholders",
    "idempotencyKey": "6a1f3c52-8d7e-4b0a-9c2d-1e5f7a3b9d40",
    "body": {
      "kind": "individual",
      "displayName": "Riley Chen",
      "relationship": "advisor",
      "emails": [{ "email": "riley.chen@example.test", "kind": "self" }]
    }
  }
}
```

The answer is the new stakeholder. If the address is already on another stakeholder, the answer is 422
`warnings_unacknowledged`; send the warning's code in `acknowledge` to go ahead. Riley Chen can then see their own
holdings once they have an Insulin Apps account with that address and the Viewer role.

## Other endpoints

`GET /api/health` answers without any identity, for monitoring. The platform's own paths (`/api/__suger/*`) are never
reachable with a token.
